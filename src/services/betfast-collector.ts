import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { BetfastBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import type { Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { BetfastClient, type BetfastEvent, type BetfastOdd } from "../providers/betfast.js";
import { errorMessage } from "../utils/errors.js";
import { logCollectorMessage } from "./collector-log.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { getSavedBookmakerEventLinks, objectRaw, type SavedBookmakerEventLink } from "./saved-bookmaker-events.js";

type CanonicalFixture = {
  id: string;
  api_football_fixture_id: number;
  name: string;
  league:
    | {
        name: string;
        slug: string;
        api_football_league_id: number;
      }
    | Array<{
        name: string;
        slug: string;
        api_football_league_id: number;
      }>
    | null;
  home_team: string | null;
  away_team: string | null;
  normalized_home_team: string | null;
  normalized_away_team: string | null;
  starts_at: string;
};

function serializeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };

  try {
    return JSON.parse(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

async function log(bookmaker: BetfastBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  logCollectorMessage(bookmaker.slug, level, message, context);
}

async function ensureBaseRows(bookmaker: BetfastBookmakerConfig) {
  const { error } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;
}

async function getCanonicalFixtures() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);

  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,league:leagues(name,slug,api_football_league_id),home_team,away_team,normalized_home_team,normalized_away_team,starts_at")
    .gt("starts_at", now.toISOString())
    .lt("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as CanonicalFixture[];
}

function fixtureLeague(fixture: CanonicalFixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function isNearCanonicalFixtureWindow(event: BetfastEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.startsAt).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: BetfastEvent, fixtures: CanonicalFixture[]) {
  let best: (EventMatchResult & { fixture: CanonicalFixture }) | null = null;

  for (const fixture of fixtures) {
    const result = matchEvents(
      {
        id: fixture.id,
        startsAt: fixture.starts_at,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team,
        leagueName: fixtureLeague(fixture)?.name ?? null
      },
      {
        id: event.id,
        startsAt: event.startsAt,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        leagueName: event.leagueName
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function selectionFromOdd(odd: BetfastOdd): Selection | null {
  const position = Number(odd.pos);
  if (position === 1 || position === 133827) return "HOME";
  if (position === 2 || position === 133828) return "DRAW";
  if (position === 3 || position === 133829) return "AWAY";
  return null;
}

function numericId(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? Number(digits.slice(-15)) : 0;
}

function compactEventRaw(event: BetfastEvent) {
  const { ev, ...raw } = event;
  return {
    ...raw,
    moneylineOddIds: Object.keys(ev?.["448"] ?? {}),
    earlyPayoutOddIds: Object.entries(ev?.["27072"] ?? {})
      .filter(([, odd]) => Number(odd.p1) === 2)
      .map(([oddId]) => oddId)
  };
}

function eventFromSavedLink(link: SavedBookmakerEventLink): BetfastEvent | null {
  const raw = objectRaw(link.raw);
  const id = Number(raw.id ?? link.external_event_id);
  if (!Number.isFinite(id) || id <= 0) return null;

  return {
    ...(raw as BetfastEvent),
    id,
    homeTeam: typeof raw.homeTeam === "string" ? raw.homeTeam : null,
    awayTeam: typeof raw.awayTeam === "string" ? raw.awayTeam : null,
    startsAt: typeof raw.startsAt === "string" ? raw.startsAt : "",
    leagueName: typeof raw.leagueName === "string" ? raw.leagueName : null,
    regionName: typeof raw.regionName === "string" ? raw.regionName : null
  };
}

function buildBookmakerLink(bookmaker: BetfastBookmakerConfig, fixtureId: string, event: BetfastEvent, confidenceScore: number): BookmakerLinkRow {
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.id,
    fixture_id: fixtureId,
    bookmaker_event_name: [event.homeTeam, event.awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: event.homeTeam,
    bookmaker_away_team: event.awayTeam,
    normalized_bookmaker_home_team: normalizeName(event.homeTeam),
    normalized_bookmaker_away_team: normalizeName(event.awayTeam),
    starts_at: event.startsAt,
    match_confidence_score: confidenceScore,
    source_url: new URL(`sports/event/${event.id}`, bookmaker.baseUrl).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: BetfastBookmakerConfig, fixtureId: string, event: BetfastEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const markets = [
    {
      id: "448",
      rawMarketName: "Resultado da Partida",
      paCategory: "SEM_PA",
      confidenceScore: 1,
      classificationReason: "betfast-standard-1x2",
      includeOdd: () => true
    },
    {
      id: "27072",
      rawMarketName: "Vence ao Abrir 2 Gols",
      paCategory: "COM_PA",
      confidenceScore: 1,
      classificationReason: "betfast-vence-ao-abrir-2-gols",
      includeOdd: (odd: BetfastOdd) => Number(odd.p1) === 2
    }
  ] as const;
  const rows: OddRow[] = [];

  for (const market of markets) {
    for (const [oddId, odd] of Object.entries(event.ev?.[market.id] ?? {})) {
      if (!market.includeOdd(odd)) continue;

      const price = Number(odd.coef);
      if (!Number.isFinite(price) || price <= 0 || odd.lock === true) continue;

      const selection = selectionFromOdd(odd);
      if (!selection) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price,
        pa_category: market.paCategory,
        confidence_score: market.confidenceScore,
        raw_market_name: market.rawMarketName,
        raw_label: String(odd.pos ?? ""),
        raw_odd_type: String(odd.pos ?? ""),
        source_odd_id: numericId(oddId),
        raw: { event: compactEventRaw(event), odd, marketId: market.id, classificationReason: market.classificationReason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createBetfastCollector(bookmaker: BetfastBookmakerConfig) {
  return async function collectBetfast(options: BookmakerCollectOptions = {}) {
    const client = new BetfastClient(bookmaker);
    const summary = {
      eventsSeen: 0,
      eventsInWindow: 0,
      eventsCollected: 0,
      eventsMatched: 0,
      eventsUnmatched: 0,
      oddsUpserted: 0,
      eventsCollectedDirect: 0,
      eventsCollectedByDiscovery: 0,
      directEventsFailed: 0,
      errors: 0,
      lastError: null as string | null
    };

    await ensureBaseRows(bookmaker);
    let fixtures = await getCanonicalFixtures();
    if (!fixtures.length) {
      await log(bookmaker, "warn", "no canonical fixtures; run api-football sync first");
      return summary;
    }

    const refreshPlan = await filterFixturesDueForOddsRefresh(fixtures);
    applyFixtureRefreshPlan(summary, refreshPlan);
    fixtures = refreshPlan.fixtures;
    if (!fixtures.length) {
      await log(bookmaker, "info", "no prematch fixtures for odds refresh", {
        fixturesAvailable: refreshPlan.fixturesAvailable,
        skippedStarted: refreshPlan.skippedStarted
      });
      return summary;
    }

    try {
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];
      const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
      const savedLinks = await getSavedBookmakerEventLinks(bookmaker.slug, fixtures.map((fixture) => fixture.id));
      const collectedFixtureIds = new Set<string>();

      await pMap(
        [...savedLinks.values()],
        async (link) => {
          const fixture = fixturesById.get(link.fixture_id);
          const savedEvent = eventFromSavedLink(link);
          if (!fixture || !savedEvent) return;

          try {
            const detailEvent = await client.getEventDetails(savedEvent);
            const matched = findBestMatch(detailEvent, [fixture]);
            if (!matched) throw new Error(`saved event no longer matches fixture ${fixture.name}`);

            const odds = buildMoneylineOdds(bookmaker, matched.fixture.id, detailEvent, matched.orientation);
            if (!odds.length) throw new Error(`saved event has no 1X2 odds: ${detailEvent.id}`);

            linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, detailEvent, matched.score));
            oddsToSave.push(...odds);
            collectedFixtureIds.add(matched.fixture.id);
            summary.eventsCollected += 1;
            summary.eventsMatched += 1;
            summary.eventsCollectedDirect += 1;
          } catch (error) {
            summary.directEventsFailed += 1;
            await log(bookmaker, "warn", "betfast saved event direct refresh failed; falling back to discovery", {
              fixtureId: fixture.id,
              eventId: savedEvent.id,
              error: serializeError(error)
            });
          }
        },
        { concurrency: 4 }
      );

      const discoveryFixtures = fixtures.filter((fixture) => !collectedFixtureIds.has(fixture.id));
      if (!discoveryFixtures.length) {
        summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
          cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
        });
        await log(bookmaker, "info", "betfast collection finished", summary);
        return summary;
      }

      const events = await client.getFootballEvents();
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, discoveryFixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: BetfastEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

      for (const event of targetEvents) {
        const matched = findBestMatch(event, discoveryFixtures);
        if (!matched) {
          summary.eventsUnmatched += 1;
          continue;
        }

        const previous = bestMatchByFixtureId.get(matched.fixture.id);
        if (!previous || matched.score > previous.matched.score) {
          bestMatchByFixtureId.set(matched.fixture.id, { event, matched });
        }
      }

      const matchedEvents = Array.from(bestMatchByFixtureId.values());
      const detailsByEventId = new Map(
        await pMap(
          matchedEvents,
          async ({ event }) => {
            try {
              return [event.id, await client.getEventDetails(event)] as const;
            } catch (error) {
              summary.errors += 1;
              summary.lastError = errorMessage(error);
              await log(bookmaker, "warn", "betfast event detail failed", { eventId: event.id, error: serializeError(error) });
              return [event.id, event] as const;
            }
          },
          { concurrency: 4 }
        )
      );

      for (const { event, matched } of matchedEvents) {
        const detailedEvent = detailsByEventId.get(event.id) ?? event;
        linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, detailedEvent, matched.score));
        oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, detailedEvent, matched.orientation));
        summary.eventsCollected += 1;
        summary.eventsMatched += 1;
        summary.eventsCollectedByDiscovery += 1;
      }

      summary.eventsUnmatched += discoveryFixtures.length - bestMatchByFixtureId.size;
      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
        cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "betfast collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "betfast collection finished", summary);
    return summary;
  };
}

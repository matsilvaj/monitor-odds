import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { BetesporteBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { BetesporteClient, type BetesporteEvent, type BetesporteMarket, type BetesporteOption } from "../providers/betesporte.js";
import { errorMessage } from "../utils/errors.js";
import { getSavedBookmakerEventLinks, objectRaw, type SavedBookmakerEventLink } from "./saved-bookmaker-events.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };

  try {
    return JSON.parse(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

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

async function log(bookmaker: BetesporteBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: BetesporteBookmakerConfig) {
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

function dayWindowsForFixtures(fixtures: CanonicalFixture[]) {
  const keys = new Set<string>();
  for (const fixture of fixtures) {
    const date = new Date(fixture.starts_at);
    keys.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
  }

  return [...keys].map((key) => {
    const [year, month, day] = key.split("-").map(Number);
    const start = new Date(year, month, day, 0, 0, 0, 0);
    const end = new Date(year, month, day + 1, 0, 0, 0, 0);
    return { start, end };
  });
}

function isNearCanonicalFixtureWindow(event: BetesporteEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.date ?? "").getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: BetesporteEvent, fixtures: CanonicalFixture[]) {
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
        startsAt: event.date ?? "",
        homeTeam: event.homeTeamName ?? null,
        awayTeam: event.awayTeamName ?? null,
        leagueName: event.tournamentName ?? null
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function uniqueEvents(events: BetesporteEvent[]) {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function uniqueMarkets(markets: BetesporteMarket[]) {
  return [...new Map(markets.map((market) => [market.id, market])).values()];
}

function isMoneylineMarket(market: BetesporteMarket) {
  const options = market.options ?? [];
  const externalIds = new Set(options.map((option) => option.externalId));
  const optionNames = new Set(options.map((option) => option.name));
  const hasSelections = (externalIds.has("1") && externalIds.has("2") && externalIds.has("3")) || (optionNames.has("Casa") && optionNames.has("Empate") && optionNames.has("Fora"));
  const marketName = String(market.name ?? "");
  const isExactMoneyline = /^1x2(?:\s*\(pagamento\s+antecipado\))?$/i.test(marketName);

  return hasSelections && isExactMoneyline && (market.type === 1 || market.type === 1601);
}

function paForMarket(market: BetesporteMarket): { category: PaCategory; confidence: number; reason: string } {
  const name = String(market.name ?? "");
  if (market.type === 1601 || /pagamento\s+antecipado|early\s+payout/i.test(name)) {
    return { category: "COM_PA", confidence: 0.98, reason: "betesporte-1x2-pagamento-antecipado" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "betesporte-standard-1x2" };
}

function selectionFromOption(option: BetesporteOption): Selection | null {
  if (option.externalId === "1" || option.name === "Casa") return "HOME";
  if (option.externalId === "2" || option.name === "Empate") return "DRAW";
  if (option.externalId === "3" || option.name === "Fora") return "AWAY";
  return null;
}

function compactEventRaw(event: BetesporteEvent) {
  return {
    id: event.id,
    betRadarId: event.betRadarId,
    homeTeamName: event.homeTeamName,
    awayTeamName: event.awayTeamName,
    homeTeamId: event.homeTeamId,
    awayTeamId: event.awayTeamId,
    date: event.date,
    tournamentId: event.tournamentId,
    tournamentName: event.tournamentName,
    countryId: event.countryId,
    countryName: event.countryName
  };
}

function betesporteEventDetailUrl(bookmaker: BetesporteBookmakerConfig, event: BetesporteEvent) {
  return new URL(
    `api/PreMatch/GetEventDetail?eventId=${event.id}&sportId=1&tournamentId=${event.tournamentId ?? ""}&countryId=${event.countryId ?? ""}`,
    bookmaker.baseUrl
  ).href;
}

function eventFromSavedLink(link: SavedBookmakerEventLink): BetesporteEvent | null {
  const raw = objectRaw(link.raw);
  const id = Number(raw.id ?? link.external_event_id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { ...(raw as BetesporteEvent), id };
}

function buildBookmakerLink(bookmaker: BetesporteBookmakerConfig, fixtureId: string, event: BetesporteEvent, confidenceScore: number): BookmakerLinkRow {
  const collectionUrl = betesporteEventDetailUrl(bookmaker, event);

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.id,
    fixture_id: fixtureId,
    bookmaker_event_name: [event.homeTeamName, event.awayTeamName].filter(Boolean).join(" x "),
    bookmaker_home_team: event.homeTeamName ?? null,
    bookmaker_away_team: event.awayTeamName ?? null,
    normalized_bookmaker_home_team: normalizeName(event.homeTeamName),
    normalized_bookmaker_away_team: normalizeName(event.awayTeamName),
    starts_at: new Date(event.date ?? "").toISOString(),
    match_confidence_score: confidenceScore,
    source_url: null,
    raw: { ...compactEventRaw(event), collectionUrl },
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: BetesporteBookmakerConfig, fixtureId: string, event: BetesporteEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];

  for (const market of uniqueMarkets(event.markets ?? []).filter(isMoneylineMarket)) {
    if (market.locked) continue;

    const pa = paForMarket(market);
    for (const option of market.options ?? []) {
      const selection = selectionFromOption(option);
      const price = Number(option.odd);

      if (!selection || !Number.isFinite(price) || price <= 0 || option.locked || option.blocked || option.hide) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price,
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.name ?? null,
        raw_label: option.name ?? null,
        raw_odd_type: option.externalId ?? String(market.type ?? ""),
        source_odd_id: option.id,
        raw: { event: compactEventRaw(event), market, option, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createBetesporteCollector(bookmaker: BetesporteBookmakerConfig) {
  return async function collectBetesporte(options: BookmakerCollectOptions = {}) {
    const client = new BetesporteClient(bookmaker);
    const summary = {
      daysFetched: 0,
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

    const refreshPlan = await filterFixturesDueForOddsRefresh(bookmaker.slug, fixtures, options);
    applyFixtureRefreshPlan(summary, refreshPlan);
    fixtures = refreshPlan.fixtures;
    if (!fixtures.length) {
      await log(bookmaker, "info", "no fixtures due for odds refresh", {
        fixturesAvailable: refreshPlan.fixturesAvailable,
        skippedFresh: refreshPlan.skippedFresh,
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
            await sleep(100 + Math.floor(Math.random() * 300));
            const detailEvent = await client.getEventDetail(savedEvent);
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
            await log(bookmaker, "warn", "betesporte saved event direct refresh failed; falling back to discovery", {
              fixtureId: fixture.id,
              eventId: savedEvent.id,
              error: serializeError(error)
            });
          }
        },
        { concurrency: 3 }
      );

      const discoveryFixtures = fixtures.filter((fixture) => !collectedFixtureIds.has(fixture.id));
      if (!discoveryFixtures.length) {
        summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
          cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
        });
        await log(bookmaker, "info", "betesporte collection finished", summary);
        return summary;
      }

      const dayWindows = dayWindowsForFixtures(discoveryFixtures);
      const dayEvents = await pMap(
        dayWindows,
        async ({ start, end }) => {
          const events = await client.getEventsByDate(start, end);
          summary.daysFetched += 1;
          return events;
        },
        { concurrency: 2 }
      );

      const events = uniqueEvents(dayEvents.flat());
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, discoveryFixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: BetesporteEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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

      await pMap(
        [...bestMatchByFixtureId.values()],
        async ({ event, matched }) => {
          try {
            await sleep(300 + Math.floor(Math.random() * 700));
            const detailEvent = await client.getEventDetail(event);
            linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, detailEvent, matched.score));
            oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, detailEvent, matched.orientation));
            summary.eventsCollected += 1;
            summary.eventsMatched += 1;
            summary.eventsCollectedByDiscovery += 1;
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "betesporte event detail collection failed", { eventId: event.id, error: serializeError(error) });
          }
        },
        { concurrency: 1 }
      );

      summary.eventsUnmatched += discoveryFixtures.length - bestMatchByFixtureId.size;
      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
        cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "betesporte collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "betesporte collection finished", summary);
    return summary;
  };
}

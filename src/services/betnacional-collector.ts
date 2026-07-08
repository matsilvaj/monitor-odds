import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { BetnacionalBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { findBestCanonicalEventMatch, matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import type { Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { BetnacionalClient, type BetnacionalOdd, type BetnacionalSearchEvent } from "../providers/betnacional.js";
import { errorMessage } from "../utils/errors.js";
import { logCollectorMessage } from "./collector-log.js";
import { getSavedBookmakerEventLinks, objectRaw } from "./saved-bookmaker-events.js";

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

type BetnacionalEvent = {
  eventId: number;
  home: string | null;
  away: string | null;
  startsAt: string;
  tournamentId: number | null;
  tournamentName: string | null;
  categoryName: string | null;
  odds: BetnacionalOdd[];
};

async function log(bookmaker: BetnacionalBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  logCollectorMessage(bookmaker.slug, level, message, context);
}

async function ensureBaseRows(bookmaker: BetnacionalBookmakerConfig) {
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

function parseLocalDateTime(value: string | undefined) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return new Date(value ?? "");

  const [, year, month, day, hour, minute, second] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, second, 0));
}

function parseSearchDateTime(value: string | undefined) {
  return parseLocalDateTime(String(value ?? "").replace(/Z$/, ""));
}

function groupEvents(odds: BetnacionalOdd[]) {
  const byEventId = new Map<number, BetnacionalEvent>();

  for (const odd of odds) {
    if (!odd.event_id) continue;
    const current = byEventId.get(odd.event_id);
    if (current) {
      current.odds.push(odd);
      continue;
    }

    byEventId.set(odd.event_id, {
      eventId: odd.event_id,
      home: odd.home ?? null,
      away: odd.away ?? null,
      startsAt: parseLocalDateTime(odd.date_start).toISOString(),
      tournamentId: odd.tournament_id ?? odd.season_id ?? null,
      tournamentName: odd.tournament_name ?? null,
      categoryName: odd.category_name ?? null,
      odds: [odd]
    });
  }

  return [...byEventId.values()];
}

function eventFromSearchResult(searchEvent: BetnacionalSearchEvent, odds: BetnacionalOdd[]): BetnacionalEvent | null {
  if (!searchEvent.event_id) return null;

  return {
    eventId: searchEvent.event_id,
    home: searchEvent.home ?? null,
    away: searchEvent.away ?? null,
    startsAt: parseSearchDateTime(searchEvent.date_start).toISOString(),
    tournamentId: searchEvent.tournament_id ?? searchEvent.season_id ?? null,
    tournamentName: searchEvent.tournament_name ?? null,
    categoryName: searchEvent.category_name ?? null,
    odds: odds.map((odd) => ({
      ...odd,
      event_id: searchEvent.event_id ?? odd.event_id,
      home: searchEvent.home ?? odd.home,
      away: searchEvent.away ?? odd.away,
      date_start: searchEvent.date_start ?? odd.date_start,
      tournament_name: searchEvent.tournament_name ?? odd.tournament_name,
      tournament_id: searchEvent.tournament_id ?? searchEvent.season_id ?? odd.tournament_id,
      category_name: searchEvent.category_name ?? odd.category_name
    }))
  };
}

function eventFromSavedDetail(raw: Record<string, unknown>, eventId: number, detail: Awaited<ReturnType<BetnacionalClient["getEventMoneylineOdds"]>>): BetnacionalEvent | null {
  const detailEvent = (detail.events ?? []).find((event) => Number(event.id ?? event.event_id) === eventId);
  const home = typeof detailEvent?.home === "string" ? detailEvent.home : typeof raw.home === "string" ? raw.home : null;
  const away = typeof detailEvent?.away === "string" ? detailEvent.away : typeof raw.away === "string" ? raw.away : null;
  const startsAt =
    typeof detailEvent?.date_start === "string"
      ? parseSearchDateTime(detailEvent.date_start).toISOString()
      : typeof raw.startsAt === "string"
        ? new Date(raw.startsAt).toISOString()
        : "";

  if (!home || !away || !startsAt) return null;

  return {
    eventId,
    home,
    away,
    startsAt,
    tournamentId:
      typeof detailEvent?.tournament_id === "number"
        ? detailEvent.tournament_id
        : typeof raw.tournamentId === "number"
          ? raw.tournamentId
          : null,
    tournamentName: typeof detailEvent?.tournament_name === "string" ? detailEvent.tournament_name : typeof raw.tournamentName === "string" ? raw.tournamentName : null,
    categoryName: typeof detailEvent?.category_name === "string" ? detailEvent.category_name : typeof raw.categoryName === "string" ? raw.categoryName : null,
    odds: (detail.odds ?? []).map((odd) => ({
      ...odd,
      event_id: eventId,
      home: home ?? odd.home,
      away: away ?? odd.away,
      date_start: startsAt,
      tournament_id: typeof detailEvent?.tournament_id === "number" ? detailEvent.tournament_id : odd.tournament_id,
      tournament_name: (typeof detailEvent?.tournament_name === "string" ? detailEvent.tournament_name : raw.tournamentName) as string | undefined,
      category_name: (typeof detailEvent?.category_name === "string" ? detailEvent.category_name : raw.categoryName) as string | undefined
    }))
  };
}

function isNearCanonicalFixtureWindow(event: BetnacionalEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.startsAt).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: BetnacionalEvent, fixtures: CanonicalFixture[]): (EventMatchResult & { fixture: CanonicalFixture }) | null {
  return findBestCanonicalEventMatch(
    fixtures.map((fixture) => ({ ...fixture, leagueName: fixtureLeague(fixture)?.name ?? null })),
    {
      id: event.eventId,
      startsAt: event.startsAt,
      homeTeam: event.home,
      awayTeam: event.away,
      leagueName: event.tournamentName
    },
    { context: "league-scoped" }
  );
}

function compactSearchName(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/^\d{2,4}\s+/, "")
    .replace(/^(?:vfb|vfl|fc|sc|ec|ac|cf)\s+/i, "")
    .trim();
}

function searchKeywords(fixture: CanonicalFixture) {
  const names = [
    fixture.home_team,
    compactSearchName(fixture.home_team),
    fixture.away_team,
    compactSearchName(fixture.away_team),
    fixture.name
  ];

  return [...new Set(names.map((name) => String(name ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(" ")).filter(Boolean))];
}

function selectionFromOdd(odd: BetnacionalOdd, event: BetnacionalEvent): Selection | null {
  if (odd.outcome_id === "1" || odd.outcome_code === "{$competitor1}") return "HOME";
  if (odd.outcome_id === "2" || odd.outcome_code === "draw") return "DRAW";
  if (odd.outcome_id === "3" || odd.outcome_code === "{$competitor2}") return "AWAY";

  const outcomeName = normalizeName(odd.outcome_name ?? odd.outcome_code);
  if (!outcomeName) return null;

  if (outcomeName === "empate" || outcomeName === "draw") return "DRAW";

  const home = normalizeName(event.home);
  const away = normalizeName(event.away);
  if (home && outcomeName === home) return "HOME";
  if (away && outcomeName === away) return "AWAY";

  return null;
}

type MarketClassification = {
  category: "COM_PA" | "SEM_PA";
  confidence: number;
  reason: string;
  priority: number;
};

function classifyMoneylineOdd(odd: BetnacionalOdd): MarketClassification | null {
  if (odd.is_live === 1) return null;
  if (odd.market_status_id === 0) return null;

  const marketName = normalizeName(odd.market_name);
  const marketCode = normalizeName(odd.market_code);
  const combined = `${marketName} ${marketCode}`.trim();

  const isEarlyPayout =
    odd.market_id === 99979617 ||
    /pag antecipado/.test(combined) ||
    /pagamento antecipado/.test(combined) ||
    /full time result 2 up/.test(combined) ||
    /2 up/.test(combined);

  if (isEarlyPayout) {
    return {
      category: "COM_PA",
      confidence: 1,
      reason: "betnacional-resultado-final-pagamento-antecipado-2-plus",
      priority: 100
    };
  }

  const isStandardMoneyline =
    odd.market_id === 999133 ||
    marketCode === "win draw win" ||
    marketName === "resultado da partida" ||
    marketName === "resultado partida" ||
    marketName === "resultado final" ||
    (odd.market_id === 1 && odd.market_code === "1x2");

  if (!isStandardMoneyline) return null;

  return {
    category: "SEM_PA",
    confidence: 1,
    reason: "betnacional-resultado-da-partida",
    priority: odd.market_id === 999133 || marketCode === "win draw win" ? 90 : 80
  };
}

function compactEventRaw(event: BetnacionalEvent) {
  return {
    eventId: event.eventId,
    home: event.home,
    away: event.away,
    startsAt: event.startsAt,
    tournamentId: event.tournamentId,
    tournamentName: event.tournamentName,
    categoryName: event.categoryName
  };
}

function sourceOddId(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits ? digits.slice(-18) : "0";
}

function buildBookmakerLink(bookmaker: BetnacionalBookmakerConfig, fixtureId: string, event: BetnacionalEvent, confidenceScore: number): BookmakerLinkRow {
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.eventId,
    fixture_id: fixtureId,
    bookmaker_event_name: [event.home, event.away].filter(Boolean).join(" x "),
    bookmaker_home_team: event.home,
    bookmaker_away_team: event.away,
    normalized_bookmaker_home_team: normalizeName(event.home),
    normalized_bookmaker_away_team: normalizeName(event.away),
    starts_at: event.startsAt,
    match_confidence_score: confidenceScore,
    source_url: new URL(`event/1/1/${event.eventId}`, bookmaker.baseUrl).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: BetnacionalBookmakerConfig, fixtureId: string, event: BetnacionalEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const groupedRows = new Map<string, { classification: MarketClassification; rows: OddRow[] }>();

  for (const odd of event.odds) {
    const classification = classifyMoneylineOdd(odd);
    if (!classification) continue;

    const selection = selectionFromOdd(odd, event);
    const price = Number(odd.odd);

    if (!selection || !Number.isFinite(price) || price <= 0) continue;

    const row: OddRow = {
      fixture_id: fixtureId,
      bookmaker_slug: bookmaker.slug,
      market_code: "1X2",
      market_name: "MoneyLine",
      selection: selectionForCanonicalOrientation(selection, orientation),
      price,
      pa_category: classification.category,
      confidence_score: classification.confidence,
      raw_market_name: odd.market_name ?? null,
      raw_label: odd.outcome_name ?? null,
      raw_odd_type: odd.outcome_id ?? odd.outcome_code ?? null,
      source_odd_id: sourceOddId(odd.id),
      raw: { event: compactEventRaw(event), odd, classificationReason: classification.reason },
      updated_at: new Date().toISOString()
    };

    const groupKey = [classification.category, odd.market_id ?? "", odd.market_name ?? "", odd.market_code ?? "", odd.selection_market_id ?? ""].join(":");
    const group = groupedRows.get(groupKey) ?? { classification, rows: [] };
    group.rows.push(row);
    groupedRows.set(groupKey, group);
  }

  const selectedRows: OddRow[] = [];
  const bestGroupByCategory = new Map<string, { priority: number; rows: OddRow[] }>();

  for (const { classification, rows } of groupedRows.values()) {
    const bySelection = new Map<string, OddRow>();
    for (const row of rows) {
      if (!bySelection.has(row.selection)) bySelection.set(row.selection, row);
    }

    const completeRows = ["HOME", "DRAW", "AWAY"].map((selection) => bySelection.get(selection));
    if (!completeRows.every((row): row is OddRow => Boolean(row))) continue;

    const current = bestGroupByCategory.get(classification.category);
    if (!current || classification.priority > current.priority) {
      bestGroupByCategory.set(classification.category, { priority: classification.priority, rows: completeRows });
    }
  }

  for (const group of bestGroupByCategory.values()) {
    selectedRows.push(...group.rows);
  }

  return selectedRows;
}

export function createBetnacionalCollector(bookmaker: BetnacionalBookmakerConfig) {
  return async function collectBetnacional(options: BookmakerCollectOptions = {}) {
    const client = new BetnacionalClient(bookmaker);
    const summary = {
      eventsSeen: 0,
      eventsInWindow: 0,
      searches: 0,
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
          const eventId = Number(link.external_event_id);
          if (!fixture || !Number.isFinite(eventId) || eventId <= 0) return;

          try {
            const detail = await client.getEventMoneylineOdds(eventId);
            const event = eventFromSavedDetail(objectRaw(link.raw), eventId, detail);
            if (!event) throw new Error(`saved event detail missing for ${eventId}`);

            const matched = findBestMatch(event, [fixture]);
            if (!matched) throw new Error(`saved event no longer matches fixture ${fixture.name}`);

            const odds = buildMoneylineOdds(bookmaker, matched.fixture.id, event, matched.orientation);
            if (!odds.length) throw new Error(`saved event has no 1X2 odds: ${eventId}`);

            linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, event, matched.score));
            oddsToSave.push(...odds);
            collectedFixtureIds.add(matched.fixture.id);
            summary.eventsCollected += 1;
            summary.eventsMatched += 1;
            summary.eventsCollectedDirect += 1;
          } catch (error) {
            summary.directEventsFailed += 1;
            await log(bookmaker, "warn", "betnacional saved event direct refresh failed; falling back to discovery", {
              fixtureId: fixture.id,
              eventId,
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
        await log(bookmaker, "info", "betnacional collection finished", summary);
        return summary;
      }

      const odds = await client.getMoneylineOdds();
      const events = groupEvents(odds);
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, discoveryFixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: BetnacionalEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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

      const missingFixtures = discoveryFixtures.filter((fixture) => !bestMatchByFixtureId.has(fixture.id));
      for (const fixture of missingFixtures) {
        const seenEventIds = new Set<number>();

        for (const keyword of searchKeywords(fixture)) {
          let searchResults;
          try {
            searchResults = await client.searchEvents(keyword);
            summary.searches += 1;
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "betnacional event search failed", {
              fixtureId: fixture.id,
              keyword,
              error: serializeError(error)
            });
            continue;
          }

          for (const searchResult of searchResults) {
            if (!searchResult.event_id || seenEventIds.has(searchResult.event_id)) continue;
            seenEventIds.add(searchResult.event_id);

            const result = matchEvents(
              {
                id: fixture.id,
                startsAt: fixture.starts_at,
                homeTeam: fixture.home_team,
                awayTeam: fixture.away_team,
                leagueName: fixtureLeague(fixture)?.name ?? null
              },
              {
                id: searchResult.event_id,
                startsAt: parseSearchDateTime(searchResult.date_start),
                homeTeam: searchResult.home ?? null,
                awayTeam: searchResult.away ?? null,
                leagueName: searchResult.tournament_name ?? null
              }
            );

            if (!result.matched) continue;

            let detail;
            try {
              detail = await client.getEventMoneylineOdds(searchResult.event_id);
            } catch (error) {
              summary.errors += 1;
              summary.lastError = errorMessage(error);
              await log(bookmaker, "error", "betnacional event detail collection failed", {
                fixtureId: fixture.id,
                eventId: searchResult.event_id,
                keyword,
                error: serializeError(error)
              });
              continue;
            }

            const fallbackEvent = eventFromSearchResult(searchResult, detail.odds ?? []);
            const hydratedEvent =
              eventFromSavedDetail(
                {
                  home: searchResult.home,
                  away: searchResult.away,
                  startsAt: parseSearchDateTime(searchResult.date_start).toISOString(),
                  tournamentId: searchResult.tournament_id ?? searchResult.season_id,
                  tournamentName: searchResult.tournament_name,
                  categoryName: searchResult.category_name
                },
                searchResult.event_id,
                detail
              ) ?? fallbackEvent;
            if (!hydratedEvent) continue;

            const previous = bestMatchByFixtureId.get(fixture.id);
            if (!previous || result.score > previous.matched.score) {
              bestMatchByFixtureId.set(fixture.id, { event: hydratedEvent, matched: { ...result, fixture } });
            }
          }

          if (bestMatchByFixtureId.has(fixture.id)) break;
        }
      }

      for (const { event, matched } of bestMatchByFixtureId.values()) {
        let finalEvent = event;
        try {
          const detail = await client.getEventMoneylineOdds(event.eventId);
          finalEvent = eventFromSavedDetail(compactEventRaw(event), event.eventId, detail) ?? event;
        } catch (error) {
          summary.errors += 1;
          summary.lastError = errorMessage(error);
          await log(bookmaker, "warn", "betnacional event detail hydration failed; using discovery odds", {
            fixtureId: matched.fixture.id,
            eventId: event.eventId,
            error: serializeError(error)
          });
        }

        const eventOdds = buildMoneylineOdds(bookmaker, matched.fixture.id, finalEvent, matched.orientation);
        if (!eventOdds.length) {
          summary.errors += 1;
          summary.lastError = `betnacional event has no 1X2 odds: ${finalEvent.eventId}`;
          await log(bookmaker, "warn", "betnacional event has no 1X2 odds", {
            fixtureId: matched.fixture.id,
            eventId: finalEvent.eventId,
            event: compactEventRaw(finalEvent)
          });
          continue;
        }

        linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, finalEvent, matched.score));
        oddsToSave.push(...eventOdds);
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
      await log(bookmaker, "error", "betnacional collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "betnacional collection finished", summary);
    return summary;
  };
}

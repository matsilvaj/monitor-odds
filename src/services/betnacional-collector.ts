import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { BetnacionalBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import type { Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { BetnacionalClient, type BetnacionalOdd, type BetnacionalSearchEvent } from "../providers/betnacional.js";
import { errorMessage } from "../utils/errors.js";

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
  tournamentName: string | null;
  categoryName: string | null;
  odds: BetnacionalOdd[];
};

async function log(bookmaker: BetnacionalBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
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
    tournamentName: searchEvent.tournament_name ?? null,
    categoryName: searchEvent.category_name ?? null,
    odds: odds.map((odd) => ({
      ...odd,
      event_id: searchEvent.event_id ?? odd.event_id,
      home: searchEvent.home ?? odd.home,
      away: searchEvent.away ?? odd.away,
      date_start: searchEvent.date_start ?? odd.date_start,
      tournament_name: searchEvent.tournament_name ?? odd.tournament_name,
      category_name: searchEvent.category_name ?? odd.category_name
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

function findBestMatch(event: BetnacionalEvent, fixtures: CanonicalFixture[]) {
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
        id: event.eventId,
        startsAt: event.startsAt,
        homeTeam: event.home,
        awayTeam: event.away,
        leagueName: event.tournamentName
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
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

function selectionFromOdd(odd: BetnacionalOdd): Selection | null {
  if (odd.outcome_id === "1" || odd.outcome_code === "{$competitor1}") return "HOME";
  if (odd.outcome_id === "2" || odd.outcome_code === "draw") return "DRAW";
  if (odd.outcome_id === "3" || odd.outcome_code === "{$competitor2}") return "AWAY";
  return null;
}

function isMoneylineOdd(odd: BetnacionalOdd) {
  return odd.market_id === 1 && odd.market_code === "1x2" && odd.market_name === "Resultado Final" && !odd.specifier && odd.is_live !== 1;
}

function compactEventRaw(event: BetnacionalEvent) {
  return {
    eventId: event.eventId,
    home: event.home,
    away: event.away,
    startsAt: event.startsAt,
    tournamentName: event.tournamentName,
    categoryName: event.categoryName
  };
}

function sourceOddId(value: string) {
  const [eventId, marketId, outcomeId] = value.split("_");
  return Number(`${eventId}${String(marketId ?? "").padStart(4, "0")}${String(outcomeId ?? "").padStart(4, "0")}`.slice(0, 18));
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
    source_url: new URL(`event/1/0/${event.eventId}`, bookmaker.baseUrl).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: BetnacionalBookmakerConfig, fixtureId: string, event: BetnacionalEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];

  for (const odd of event.odds.filter(isMoneylineOdd)) {
    const selection = selectionFromOdd(odd);
    const price = Number(odd.odd);

    if (!selection || !Number.isFinite(price) || price <= 0) continue;

    rows.push({
      fixture_id: fixtureId,
      bookmaker_slug: bookmaker.slug,
      market_code: "1X2",
      market_name: "MoneyLine",
      selection: selectionForCanonicalOrientation(selection, orientation),
      price,
      pa_category: "SEM_PA",
      confidence_score: 1,
      raw_market_name: odd.market_name ?? null,
      raw_label: odd.outcome_name ?? null,
      raw_odd_type: odd.outcome_id ?? odd.outcome_code ?? null,
      source_odd_id: sourceOddId(odd.id),
      raw: { event: compactEventRaw(event), odd, classificationReason: "betnacional-standard-resultado-final" },
      updated_at: new Date().toISOString()
    });
  }

  return rows;
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
      const odds = await client.getMoneylineOdds();
      const events = groupEvents(odds);
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: BetnacionalEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

      for (const event of targetEvents) {
        const matched = findBestMatch(event, fixtures);
        if (!matched) {
          summary.eventsUnmatched += 1;
          continue;
        }

        const previous = bestMatchByFixtureId.get(matched.fixture.id);
        if (!previous || matched.score > previous.matched.score) {
          bestMatchByFixtureId.set(matched.fixture.id, { event, matched });
        }
      }

      const missingFixtures = fixtures.filter((fixture) => !bestMatchByFixtureId.has(fixture.id));
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
            if (!fallbackEvent) continue;

            const previous = bestMatchByFixtureId.get(fixture.id);
            if (!previous || result.score > previous.matched.score) {
              bestMatchByFixtureId.set(fixture.id, { event: fallbackEvent, matched: { ...result, fixture } });
            }
          }

          if (bestMatchByFixtureId.has(fixture.id)) break;
        }
      }

      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      for (const { event, matched } of bestMatchByFixtureId.values()) {
        linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, event, matched.score));
        oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, event, matched.orientation));
        summary.eventsCollected += 1;
        summary.eventsMatched += 1;
      }

      summary.eventsUnmatched += fixtures.length - bestMatchByFixtureId.size;
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

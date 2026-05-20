import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { VersusbetBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeForMatching, teamNameSimilarity } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { VersusbetClient, type VersusbetEvent, type VersusbetMarket, type VersusbetResult } from "../providers/versusbet.js";
import { errorMessage } from "../utils/errors.js";
import { logCollectorMessage } from "./collector-log.js";

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

async function log(bookmaker: VersusbetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  logCollectorMessage(bookmaker.slug, level, message, context);
}

async function ensureBaseRows(bookmaker: VersusbetBookmakerConfig) {
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

function isNearCanonicalFixtureWindow(event: VersusbetEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.startsAt).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: VersusbetEvent, fixtures: CanonicalFixture[]) {
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

function isMoneylineMarket(market: VersusbetMarket) {
  const name = normalizeForMatching(market.name);
  const hasThreeResults = market.results.length === 3;

  return (
    hasThreeResults &&
    (name === "resultado da partida" ||
      name === "resultado final" ||
      name === "resultado da partida odds melhoradas" ||
      name === "resultado final odds melhoradas")
  );
}

function paForMarket(market: VersusbetMarket): { category: PaCategory; confidence: number; reason: string } {
  const text = normalizeForMatching([market.name, ...market.additionalValues.flatMap((value) => [value.key, value.value])].join(" "));

  if (/early payout|earlypayout|pagamento antecipado|2 gols de vantagem|2up|2 up/.test(text)) {
    return { category: "COM_PA", confidence: 0.99, reason: "versusbet-market-early-payout" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "versusbet-standard-or-boosted-1x2" };
}

function selectionFromResult(result: VersusbetResult, event: VersusbetEvent): Selection | null {
  const name = normalizeForMatching(result.name);
  const rawName = result.name;

  if (/\|\|x\|/i.test(rawName) || name === "empate" || name.startsWith("empate ")) return "DRAW";
  if (/\|\|1\|/.test(rawName) || name === "0" || name.startsWith("0 ")) return "HOME";
  if (/\|\|2\|/.test(rawName) || name === "1" || name.startsWith("1 ")) return "AWAY";

  const homeScore = event.homeTeam ? teamNameSimilarity(result.name, event.homeTeam) : 0;
  const awayScore = event.awayTeam ? teamNameSimilarity(result.name, event.awayTeam) : 0;
  if (Math.max(homeScore, awayScore) < 0.75) return null;

  return homeScore >= awayScore ? "HOME" : "AWAY";
}

function compactEventRaw(event: VersusbetEvent) {
  return {
    id: event.id,
    startsAt: event.startsAt,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    leagueName: event.leagueName
  };
}

function buildBookmakerLink(bookmaker: VersusbetBookmakerConfig, fixtureId: string, event: VersusbetEvent, confidenceScore: number): BookmakerLinkRow {
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
    source_url: new URL(`esportes/sports/soccer/events/${event.id}`, bookmaker.baseUrl).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(
  bookmaker: VersusbetBookmakerConfig,
  fixtureId: string,
  event: VersusbetEvent,
  markets: VersusbetMarket[],
  orientation: EventMatchResult["orientation"]
): OddRow[] {
  const rows: OddRow[] = [];

  for (const market of markets.filter(isMoneylineMarket)) {
    const pa = paForMarket(market);

    for (const result of market.results) {
      if (!Number.isFinite(Number(result.price)) || Number(result.price) <= 0) continue;

      const selection = selectionFromResult(result, event);
      if (!selection) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price: Number(result.price),
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.name,
        raw_label: result.name,
        raw_odd_type: String(market.marketTypeId),
        source_odd_id: result.nodeId,
        raw: {
          event: compactEventRaw(event),
          market,
          result,
          classificationReason: pa.reason
        },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createVersusbetCollector(bookmaker: VersusbetBookmakerConfig) {
  return async function collectVersusbet(options: BookmakerCollectOptions = {}) {
    const client = new VersusbetClient(bookmaker);
    const summary = {
      eventsSeen: 0,
      eventsInWindow: 0,
      eventDetailsFetched: 0,
      eventDetailsFailed: 0,
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
      const feed = await client.getFeed();
      summary.eventsSeen = feed.events.length;

      const targetEvents = feed.events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: VersusbetEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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

      const matchedItems = Array.from(bestMatchByFixtureId.values());
      const detailEntries = await pMap(
        matchedItems,
        async ({ event }): Promise<readonly [number, VersusbetMarket[]]> => {
          try {
            return [event.id, await client.getEventMarkets(feed, event.id)] as const;
          } catch (error) {
            summary.eventDetailsFailed += 1;
            await log(bookmaker, "warn", "versusbet event detail failed", {
              eventId: event.id,
              eventName: `${event.homeTeam} vs ${event.awayTeam}`,
              error: errorMessage(error)
            });
            return [event.id, []] as const;
          }
        },
        { concurrency: 3 }
      );
      const marketsByEventId = new Map(detailEntries);
      summary.eventDetailsFetched = detailEntries.length;

      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      for (const { event, matched } of matchedItems) {
        const markets = marketsByEventId.get(event.id) ?? [];
        linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, event, matched.score));
        oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, event, markets, matched.orientation));
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
      await log(bookmaker, "error", "versusbet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "versusbet collection finished", summary);
    return summary;
  };
}

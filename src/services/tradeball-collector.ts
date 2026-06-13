import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { TradeballBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeForMatching } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { TradeballClient, type TradeballEvent, type TradeballMarket, type TradeballRunner } from "../providers/tradeball.js";
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

async function log(bookmaker: TradeballBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  logCollectorMessage(bookmaker.slug, level, message, context);
}

async function ensureBaseRows(bookmaker: TradeballBookmakerConfig) {
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

function collectionWindow(fixtures: CanonicalFixture[]) {
  const times = fixtures.map((fixture) => new Date(fixture.starts_at).getTime()).filter(Number.isFinite);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);

  const start = new Date(minTime - 60 * 60 * 1000);
  const end = new Date(maxTime + 60 * 60 * 1000);
  return { start, end };
}

function eventParticipants(event: TradeballEvent) {
  const home = event["event-participants"]?.find((participant) => participant.number === "1");
  const away = event["event-participants"]?.find((participant) => participant.number === "2");

  if (home?.["participant-name"] || away?.["participant-name"]) {
    return {
      homeTeam: home?.["participant-name"] ?? null,
      awayTeam: away?.["participant-name"] ?? null
    };
  }

  const [homeName, awayName] = event.name.split(/\s+(?:vs\.?|x)\s+/i);
  return {
    homeTeam: homeName?.trim() || null,
    awayTeam: awayName?.trim() || null
  };
}

function eventLeagueName(event: TradeballEvent) {
  return event["meta-tags"]?.find((tag) => tag.type === "COMPETITION")?.name ?? null;
}

function isNearCanonicalFixtureWindow(event: TradeballEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.start).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: TradeballEvent, fixtures: CanonicalFixture[]) {
  const { homeTeam, awayTeam } = eventParticipants(event);
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
        startsAt: event.start,
        homeTeam,
        awayTeam,
        leagueName: eventLeagueName(event)
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function isMoneylineMarket(market: TradeballMarket) {
  const name = normalizeForMatching(`${market.name ?? ""} ${market["name-original"] ?? ""}`);
  return (
    market.status === "open" &&
    market.live !== true &&
    market["market-type"] === "one_x_two" &&
    (name.includes("match odds") || name.includes("resultado da partida") || name.includes("moneyline") || name.includes("winner") || name.includes("1x2"))
  );
}

function paForMarket(market: TradeballMarket): { category: PaCategory; confidence: number; reason: string } {
  const text = normalizeForMatching(`${market.name ?? ""} ${market["name-original"] ?? ""}`);
  if (text.includes("pagamento antecipado") || text.includes("early payout") || text.includes("2up") || text.includes("2 up")) {
    return { category: "COM_PA", confidence: 1, reason: "tradeball-explicit-early-payout" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "tradeball-dball-standard-1x2" };
}

function selectionFromRunner(runner: TradeballRunner, event: TradeballEvent): Selection | null {
  const name = normalizeForMatching(runner.name);
  const { homeTeam, awayTeam } = eventParticipants(event);

  if (name === "draw" || name === "empate") return "DRAW";
  if (normalizeForMatching(homeTeam) === name) return "HOME";
  if (normalizeForMatching(awayTeam) === name) return "AWAY";

  return null;
}

function backPrice(runner: TradeballRunner) {
  const price = runner.prices?.find((item) => item.side === "back") ?? runner.prices?.[0];
  return Number(price?.["decimal-odds"] ?? price?.odds);
}

function compactEventRaw(event: TradeballEvent) {
  return {
    id: event.id,
    name: event.name,
    start: event.start,
    status: event.status,
    inRunningFlag: event["in-running-flag"],
    sportId: event["sport-id"],
    participants: event["event-participants"],
    metaTags: event["meta-tags"]
  };
}

function safeBigintId(value: string | number | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "");
  const safeDigits = digits.slice(-15);
  const id = Number(safeDigits);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function buildBookmakerLink(bookmaker: TradeballBookmakerConfig, fixtureId: string, event: TradeballEvent, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = eventParticipants(event);
  const marketId = event.markets?.find(isMoneylineMarket)?.id ?? "";

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: safeBigintId(event.id),
    fixture_id: fixtureId,
    bookmaker_event_name: event.name,
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: new Date(event.start).toISOString(),
    match_confidence_score: confidenceScore,
    source_url: new URL(`dballTradingFeed#event=${event.id}&market=${marketId}`, bookmaker.dballBaseUrl).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: TradeballBookmakerConfig, fixtureId: string, event: TradeballEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];
  const eventRaw = compactEventRaw(event);

  for (const market of event.markets?.filter(isMoneylineMarket) ?? []) {
    const pa = paForMarket(market);

    for (const runner of market.runners ?? []) {
      const selection = selectionFromRunner(runner, event);
      const price = backPrice(runner);

      if (!selection || !Number.isFinite(price) || price <= 0 || runner.status !== "open" || runner.withdrawn) continue;

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
        raw_label: runner.name ?? null,
        raw_odd_type: "tradeball-dball",
        source_odd_id: safeBigintId(runner.id),
        raw: { event: eventRaw, market, runner, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createTradeballCollector(bookmaker: TradeballBookmakerConfig) {
  return async function collectTradeball(options: BookmakerCollectOptions = {}) {
    const client = new TradeballClient(bookmaker);
    const summary = {
      eventsSeen: 0,
      eventsInWindow: 0,
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
      const { start, end } = collectionWindow(fixtures);
      const events = await client.getSoccerMoneylineEvents(start, end);
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => event.status === "open" && event["in-running-flag"] !== true && isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: TradeballEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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
      await log(bookmaker, "error", "tradeball collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "tradeball collection finished", summary);
    return summary;
  };
}

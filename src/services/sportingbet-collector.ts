import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { SportingbetBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { teamNameSimilarity } from "../domain/matching/text-similarity.js";
import { normalizeName } from "../domain/text.js";
import { SportingbetClient, type SportingbetFixture, type SportingbetMarket, type SportingbetOption } from "../providers/sportingbet.js";
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
  home_team: string | null;
  away_team: string | null;
  normalized_home_team: string | null;
  normalized_away_team: string | null;
  starts_at: string;
};

async function log(bookmaker: SportingbetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: SportingbetBookmakerConfig) {
  const { error } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;
}

async function getCanonicalFixtures() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);

  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,home_team,away_team,normalized_home_team,normalized_away_team,starts_at")
    .gt("starts_at", now.toISOString())
    .lt("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CanonicalFixture[];
}

function teamNames(fixture: SportingbetFixture) {
  const home = fixture.participants?.find((participant) => participant.properties?.type === "HomeTeam")?.name?.value ?? null;
  const away = fixture.participants?.find((participant) => participant.properties?.type === "AwayTeam")?.name?.value ?? null;

  if (home || away) return { homeTeam: home, awayTeam: away };

  const parts = String(fixture.name?.value ?? "").split(/\s+-\s+|\s+vs\.?\s+|\s+x\s+/i);
  return { homeTeam: parts[0]?.trim() || null, awayTeam: parts[1]?.trim() || null };
}

function matchFixture(event: SportingbetFixture, fixtures: CanonicalFixture[]) {
  const { homeTeam, awayTeam } = teamNames(event);
  let best: (EventMatchResult & { fixture: CanonicalFixture }) | null = null;
  for (const fixture of fixtures) {
    const result = matchEvents(
      {
        id: fixture.id,
        startsAt: fixture.starts_at,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team
      },
      {
        id: event.id,
        startsAt: event.startDate,
        homeTeam,
        awayTeam
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  if (!best) return null;
  return { ...best, homeTeam, awayTeam };
}

function isNearCanonicalFixtureWindow(event: SportingbetFixture, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.startDate).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function marketParam(market: SportingbetMarket, key: string) {
  return market.parameters?.find((item) => item.key === key)?.value ?? null;
}

function isMoneylineMarket(market: SportingbetMarket) {
  return market.status === "Visible" && marketParam(market, "MarketType") === "3way" && marketParam(market, "Period") === "RegularTime";
}

function paForMarket(market: SportingbetMarket): { category: PaCategory; confidence: number; reason: string } {
  if (marketParam(market, "MarketSubType") === "2Up" || /VP\s*\(\+2\)/i.test(market.name?.value ?? "")) {
    return { category: "COM_PA", confidence: 0.95, reason: "sportingbet-2up-vp-market" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "no-sportingbet-pa-marker" };
}

function selectionFromOption(option: SportingbetOption, homeTeam: string | null, awayTeam: string | null): Selection | null {
  const name = option.name?.value ?? "";
  if (/^x$/i.test(name) || /empate/i.test(name)) return "DRAW";

  const homeScore = homeTeam ? teamNameSimilarity(name, homeTeam) : 0;
  const awayScore = awayTeam ? teamNameSimilarity(name, awayTeam) : 0;
  if (Math.max(homeScore, awayScore) < 0.72) return null;

  return homeScore > awayScore ? "HOME" : "AWAY";
}

function compactEventRaw(event: SportingbetFixture) {
  const { homeTeam, awayTeam } = teamNames(event);

  return {
    id: event.id,
    sourceId: event.sourceId,
    name: event.name,
    stage: event.stage,
    startDate: event.startDate,
    homeTeam,
    awayTeam,
    participants: event.participants?.map((participant) => ({
      id: participant.id,
      name: participant.name,
      properties: participant.properties
    }))
  };
}

function compactMarketRaw(market: SportingbetMarket) {
  return {
    id: market.id,
    name: market.name,
    status: market.status,
    isMain: market.isMain,
    parameters: market.parameters
  };
}

function compactOptionRaw(option: SportingbetOption) {
  return {
    id: option.id,
    name: option.name,
    status: option.status,
    price: option.price,
    parameters: option.parameters
  };
}

function buildBookmakerLink(bookmaker: SportingbetBookmakerConfig, fixtureId: string, event: SportingbetFixture, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = teamNames(event);
  const sourceUrl = `${bookmaker.baseUrl.replace(/\/$/, "")}/pt-br/sports/eventos/${String(event.name?.value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${event.id}`;

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: Number(String(event.id).split(":").pop()),
    fixture_id: fixtureId,
    bookmaker_event_name: event.name?.value ?? [homeTeam, awayTeam].filter(Boolean).join(" - "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: event.startDate,
    match_confidence_score: confidenceScore,
    source_url: sourceUrl,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: SportingbetBookmakerConfig, fixtureId: string, event: SportingbetFixture, orientation: EventMatchResult["orientation"]): OddRow[] {
  const { homeTeam, awayTeam } = teamNames(event);
  const rows: OddRow[] = [];

  for (const market of (event.optionMarkets ?? []).filter(isMoneylineMarket)) {
    const pa = paForMarket(market);

    for (const option of market.options ?? []) {
      if (option.status !== "Visible" || Number(option.price?.odds) <= 0) continue;

      const selection = selectionFromOption(option, homeTeam, awayTeam);
      if (!selection) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price: Number(option.price?.odds),
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.name?.value ?? null,
        raw_label: option.name?.value ?? null,
        raw_odd_type: option.parameters?.optionTypes?.join(",") ?? null,
        source_odd_id: option.id,
        raw: {
          event: compactEventRaw(event),
          market: compactMarketRaw(market),
          option: compactOptionRaw(option),
          classificationReason: pa.reason
        },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createSportingbetCollector(bookmaker: SportingbetBookmakerConfig) {
  return async function collectSportingbet(options: BookmakerCollectOptions = {}) {
    const client = new SportingbetClient(bookmaker);
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
      const events = await client.getFixtures();
      summary.eventsSeen = events.length;
      const targetEvents = events.filter((event) => event.stage === "PreMatch" && isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;
      const bestMatchByFixtureId = new Map<string, { event: SportingbetFixture; matched: NonNullable<ReturnType<typeof matchFixture>> }>();
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      for (const event of targetEvents) {
        try {
          const matched = matchFixture(event, fixtures);

          if (!matched) {
            summary.eventsUnmatched += 1;
            continue;
          }

          const previous = bestMatchByFixtureId.get(matched.fixture.id);
          if (!previous || matched.score > previous.matched.score) {
            bestMatchByFixtureId.set(matched.fixture.id, { event, matched });
          }
        } catch (error) {
          summary.errors += 1;
          summary.lastError = errorMessage(error);
          await log(bookmaker, "error", "sportingbet event collection failed", { eventId: event.id, error: serializeError(error) });
        }
      }

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
      await log(bookmaker, "error", "sportingbet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "sportingbet collection finished", summary);
    return summary;
  };
}

import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { AltenarBookmakerConfig } from "../config/bookmakers.js";
import { env } from "../config/env.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { classifyPa, isMoneylineMarket, selectionFromOddType } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { AltenarClient, type AltenarEventDetails, type AltenarMarket, type AltenarOdd } from "../providers/altenar.js";
import { errorMessage } from "../utils/errors.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }

  try {
    return JSON.parse(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

function flatOddIds(market: AltenarMarket) {
  return (market.desktopOddIds ?? market.mobileOddIds ?? []).flat().filter((id): id is number => Number.isFinite(Number(id)));
}

function findOdd(odds: AltenarOdd[], oddId: number) {
  return odds.find((odd) => Number(odd.id) === Number(oddId));
}

function splitTeams(details: AltenarEventDetails) {
  const competitors = details.competitors ?? [];
  const [home, away] = competitors;
  if (home?.name || away?.name) {
    return { homeTeam: home?.name ?? null, awayTeam: away?.name ?? null };
  }

  const parts = details.name.split(/\s+vs\.?\s+|\s+x\s+/i);
  return { homeTeam: parts[0]?.trim() || null, awayTeam: parts[1]?.trim() || null };
}

async function log(bookmaker: AltenarBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: AltenarBookmakerConfig) {
  const { error: bookmakerError } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (bookmakerError) throw bookmakerError;
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
  return (data ?? []) as unknown as CanonicalFixture[];
}

function matchFixture(details: AltenarEventDetails, fixtures: CanonicalFixture[]) {
  const { homeTeam, awayTeam } = splitTeams(details);
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
        id: details.id,
        startsAt: details.startDate,
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

function isNearCanonicalFixtureWindow(startDate: string, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(startDate).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function buildBookmakerLink(bookmaker: AltenarBookmakerConfig, fixtureId: string, details: AltenarEventDetails, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = splitTeams(details);
  const sourceUrl = `${bookmaker.referer.replace(/\/$/, "")}/sports/futebol/evento/ev-${details.id}`;

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: details.id,
    fixture_id: fixtureId,
    bookmaker_event_name: details.name,
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: details.startDate,
    match_confidence_score: confidenceScore,
    source_url: sourceUrl,
    raw: {
      id: details.id,
      name: details.name,
      startDate: details.startDate,
      competitors: details.competitors
    },
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: AltenarBookmakerConfig, fixtureId: string, details: AltenarEventDetails, orientation: EventMatchResult["orientation"]): OddRow[] {
  const markets = [...(details.markets ?? []), ...(details.childMarkets ?? [])].filter((market) =>
    isMoneylineMarket(market.name ?? market.shortName)
  );

  const odds = details.odds ?? [];
  const rows: OddRow[] = [];

  for (const market of markets) {
    for (const oddId of flatOddIds(market)) {
      const odd = findOdd(odds, oddId);
      if (!odd || Number(odd.price) <= 0 || Number(odd.oddStatus ?? 0) !== 0) continue;

      const selection = selectionFromOddType(odd.typeId);
      if (!selection) continue;

      const pa = classifyPa(market.name, market.shortName, odd.name, JSON.stringify(market.offers ?? ""), JSON.stringify(odd.offers ?? ""));
      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price: Number(odd.price),
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.name ?? market.shortName ?? null,
        raw_label: odd.name ?? null,
        raw_odd_type: odd.typeId != null ? String(odd.typeId) : null,
        source_odd_id: odd.id,
        raw: { market, odd, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createAltenarCollector(bookmaker: AltenarBookmakerConfig) {
  return async function collectAltenarBookmaker(options: BookmakerCollectOptions = {}) {
    const client = new AltenarClient(bookmaker);
    const summary = {
      leagues: 0,
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
    const linksToSave: BookmakerLinkRow[] = [];
    const oddsToSave: OddRow[] = [];
    let canonicalFixtures = await getCanonicalFixtures();

    if (!canonicalFixtures.length) {
      await log(bookmaker, "warn", "no canonical fixtures; run api-football sync first");
      return summary;
    }

    const refreshPlan = await filterFixturesDueForOddsRefresh(bookmaker.slug, canonicalFixtures, options);
    applyFixtureRefreshPlan(summary, refreshPlan);
    canonicalFixtures = refreshPlan.fixtures;
    if (!canonicalFixtures.length) {
      await log(bookmaker, "info", "no fixtures due for odds refresh", {
        fixturesAvailable: refreshPlan.fixturesAvailable,
        skippedFresh: refreshPlan.skippedFresh,
        skippedStarted: refreshPlan.skippedStarted
      });
      return summary;
    }

    try {
      const events = await client.getFootballEvents();
      summary.eventsSeen = events.length;
      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event.startDate, canonicalFixtures));
      summary.eventsInWindow = targetEvents.length;
      summary.leagues = new Set(targetEvents.map((event) => event.champId).filter(Boolean)).size;

      await pMap(
        targetEvents,
        async (event) => {
          try {
            await sleep(env.COLLECT_DELAY_MS + Math.floor(Math.random() * 500));
            const details = await client.getEventDetails(event.id);

            const matched = matchFixture(details, canonicalFixtures);
            if (!matched) {
              summary.eventsUnmatched += 1;
              await log(bookmaker, "warn", "bookmaker event did not match canonical fixture", {
                eventId: event.id,
                eventName: event.name,
                champId: event.champId
              });
              return;
            }

            linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, details, matched.score));
            oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, details, matched.orientation));

            summary.eventsMatched += 1;
            summary.eventsCollected += 1;
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "event collection failed", {
              eventId: event.id,
              champId: event.champId,
              error: serializeError(error)
            });
          }
        },
        { concurrency: 4 }
      );
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "football collection failed", { error: serializeError(error) });
    }

    try {
      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
        cleanupFixtureIds: cleanupFixtureIdsForRun(canonicalFixtures, linksToSave, summary.errors)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "altenar bulk save failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", `${bookmaker.slug} collection finished`, summary);
    return summary;
  };
}

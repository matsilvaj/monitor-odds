import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { LottuBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { findBestCanonicalEventMatch, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeName } from "../domain/text.js";
import { LottuClient, type LottuEvent } from "../providers/lottu.js";
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
    | { name: string; slug: string; country: string | null; api_football_league_id: number }
    | Array<{ name: string; slug: string; country: string | null; api_football_league_id: number }>
    | null;
  home_team: string | null;
  away_team: string | null;
  normalized_home_team: string | null;
  normalized_away_team: string | null;
  starts_at: string;
};

async function log(bookmaker: LottuBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  logCollectorMessage(bookmaker.slug, level, message, context);
}

async function ensureBaseRows(bookmaker: LottuBookmakerConfig) {
  const { error } = await supabase.from("casas_apostas").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;
}

async function getCanonicalFixtures() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);

  const { data, error } = await supabase
    .from("jogos")
    .select("id,api_football_fixture_id,name,league:campeonatos(name,slug,country,api_football_league_id),home_team,away_team,normalized_home_team,normalized_away_team,starts_at")
    .gt("starts_at", now.toISOString())
    .lt("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as CanonicalFixture[];
}

function fixtureLeague(fixture: CanonicalFixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function eventLeagueName(event: LottuEvent) {
  return [event.country, event.championship].filter(Boolean).join(" ") || null;
}

function matchFixture(event: LottuEvent, fixtures: CanonicalFixture[]) {
  return findBestCanonicalEventMatch(
    fixtures.map((fixture) => ({ ...fixture, leagueName: fixtureLeague(fixture)?.name ?? null })),
    {
      id: event.id,
      startsAt: event.startsAt,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      leagueName: eventLeagueName(event)
    },
    { context: "league-scoped" }
  );
}

function isNearCanonicalFixtureWindow(event: LottuEvent, fixtures: CanonicalFixture[]) {
  const eventStart = Date.parse(event.startsAt);
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => Math.abs(new Date(fixture.starts_at).getTime() - eventStart) <= 20 * 60 * 1000);
}

const SIDE_INDEX: Record<string, number> = { HOME: 1, DRAW: 2, AWAY: 3 };

// O id da Lottu e um ObjectId hex e as colunas do banco sao bigint. Os ultimos 12
// digitos hex (contador + aleatorio do ObjectId) cabem em 48 bits e seguem unicos.
function numericEventId(event: LottuEvent) {
  return Number.parseInt(event.id.slice(-12), 16) || 0;
}

function sourceOddId(event: LottuEvent, odd: LottuEvent["odds"][number]) {
  return numericEventId(event) * 10 + SIDE_INDEX[odd.selection];
}

function compactEventRaw(event: LottuEvent) {
  return {
    id: event.id,
    startsAt: event.startsAt,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    championship: event.championship,
    country: event.country
  };
}

function buildBookmakerLink(bookmaker: LottuBookmakerConfig, fixtureId: string, event: LottuEvent, confidenceScore: number): BookmakerLinkRow {
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: numericEventId(event),
    fixture_id: fixtureId,
    bookmaker_event_name: [event.homeTeam, event.awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: event.homeTeam,
    bookmaker_away_team: event.awayTeam,
    normalized_bookmaker_home_team: normalizeName(event.homeTeam),
    normalized_bookmaker_away_team: normalizeName(event.awayTeam),
    starts_at: event.startsAt,
    match_confidence_score: confidenceScore,
    source_url: new URL(`esportes/evento/${event.id}`, bookmaker.referer).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: LottuBookmakerConfig, fixtureId: string, event: LottuEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const eventRaw = compactEventRaw(event);

  return event.odds.map((odd) => ({
    fixture_id: fixtureId,
    bookmaker_slug: bookmaker.slug,
    market_code: "1X2",
    market_name: "MoneyLine",
    selection: selectionForCanonicalOrientation(odd.selection, orientation),
    price: odd.price,
    pa_category: "SEM_PA",
    confidence_score: 1,
    raw_market_name: "Resultado Final",
    raw_label: odd.selection,
    raw_odd_type: "full_time",
    source_odd_id: sourceOddId(event, odd),
    raw: { event: eventRaw, odd, classificationReason: "lottu-standard-1x2" },
    updated_at: new Date().toISOString()
  }));
}

export function createLottuCollector(bookmaker: LottuBookmakerConfig) {
  return async function collectLottu(options: BookmakerCollectOptions = {}) {
    const client = new LottuClient(bookmaker);
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
      const events = await client.getPrematchFootballEvents();
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: LottuEvent; matched: NonNullable<ReturnType<typeof matchFixture>> }>();

      for (const event of targetEvents) {
        const matched = matchFixture(event, fixtures);
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

      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
        cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "lottu collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "lottu collection finished", summary);
    return summary;
  };
}

import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { SportybetBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { findBestCanonicalEventMatchOnline } from "./event-identity-resolver.js";
import { restrictFixturesToRequested } from "./collector-fixture-scope.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeForMatching, teamNameSimilarity, tokenSetSimilarity } from "../domain/matching/text-similarity.js";
import { normalizeName } from "../domain/text.js";
import { SportybetClient, type SportybetEvent, type SportybetMarket, type SportybetOutcome } from "../providers/sportybet.js";
import { errorMessage } from "../utils/errors.js";
import { logCollectorMessage } from "./collector-log.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pageDelayMs() {
  return 250 + Math.floor(Math.random() * 751);
}

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

async function log(bookmaker: SportybetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  logCollectorMessage(bookmaker.slug, level, message, context);
}

async function ensureBaseRows(bookmaker: SportybetBookmakerConfig) {
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

function compact(value: unknown) {
  return normalizeForMatching(value).replace(/\s+/g, "");
}

function leagueLooksLike(left: string | null | undefined, right: string | null | undefined) {
  const leftCompact = compact(left);
  const rightCompact = compact(right);
  if (!leftCompact || !rightCompact) return false;
  if (leftCompact === rightCompact || leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact)) return true;
  return tokenSetSimilarity(left, right) >= 0.82;
}

function eventTournamentId(event: SportybetEvent) {
  return event.sport?.category?.tournament?.id ?? null;
}

function eventLeagueName(event: SportybetEvent) {
  return event.sport?.category?.tournament?.name ?? null;
}

async function matchFixture(event: SportybetEvent, fixtures: CanonicalFixture[], bookmakerSlug: string) {
  const homeTeam = event.homeTeamName ?? null;
  const awayTeam = event.awayTeamName ?? null;
  const best = await findBestCanonicalEventMatchOnline(
    fixtures.map((fixture) => ({ ...fixture, leagueName: fixtureLeague(fixture)?.name ?? null })),
    {
      id: event.eventId,
      startsAt: event.estimateStartTime,
      homeTeam,
      awayTeam,
      leagueName: eventLeagueName(event)
    },
    { context: "league-scoped", bookmakerSlug }
  );
  if (!best) return null;
  return { ...best, homeTeam, awayTeam };
}

function isNearCanonicalFixtureWindow(event: SportybetEvent, fixtures: CanonicalFixture[]) {
  const eventStart = Number(event.estimateStartTime);
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function isMoneylineMarket(market: SportybetMarket) {
  return market.status === 0 && (market.id === "1" || market.id === "60100");
}

function paForMarket(market: SportybetMarket): { category: PaCategory; confidence: number; reason: string } {
  if (market.id === "60100" || /2UP/i.test(market.name ?? "") || /vantagem de dois gols/i.test(market.marketGuide ?? "")) {
    return { category: "COM_PA", confidence: 0.97, reason: "sportybet-2up-market" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "sportybet-standard-1x2" };
}

function selectionFromOutcome(outcome: SportybetOutcome, homeTeam: string | null, awayTeam: string | null): Selection | null {
  if (outcome.id === "1") return "HOME";
  if (outcome.id === "2") return "DRAW";
  if (outcome.id === "3") return "AWAY";

  const desc = outcome.desc ?? "";
  if (/empate/i.test(desc)) return "DRAW";

  const homeScore = homeTeam ? teamNameSimilarity(desc, homeTeam) : 0;
  const awayScore = awayTeam ? teamNameSimilarity(desc, awayTeam) : 0;
  if (Math.max(homeScore, awayScore) < 0.72) return null;

  return homeScore > awayScore ? "HOME" : "AWAY";
}

function externalEventId(eventId: string) {
  const numeric = eventId.split(":").pop();
  return Number(numeric);
}

function buildBookmakerLink(bookmaker: SportybetBookmakerConfig, fixtureId: string, event: SportybetEvent, confidenceScore: number): BookmakerLinkRow {
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: externalEventId(event.eventId),
    fixture_id: fixtureId,
    bookmaker_event_name: [event.homeTeamName, event.awayTeamName].filter(Boolean).join(" vs "),
    bookmaker_home_team: event.homeTeamName ?? null,
    bookmaker_away_team: event.awayTeamName ?? null,
    normalized_bookmaker_home_team: normalizeName(event.homeTeamName),
    normalized_bookmaker_away_team: normalizeName(event.awayTeamName),
    starts_at: new Date(event.estimateStartTime).toISOString(),
    match_confidence_score: confidenceScore,
    source_url: null,
    raw: { ...event, collectionUrl: bookmaker.referer },
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: SportybetBookmakerConfig, fixtureId: string, event: SportybetEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];

  for (const market of (event.markets ?? []).filter(isMoneylineMarket)) {
    const pa = paForMarket(market);

    for (const outcome of market.outcomes ?? []) {
      if (outcome.isActive !== 1 || Number(outcome.odds) <= 0) continue;

      const selection = selectionFromOutcome(outcome, event.homeTeamName ?? null, event.awayTeamName ?? null);
      if (!selection) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price: Number(outcome.odds),
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.desc ?? market.name ?? null,
        raw_label: outcome.desc ?? null,
        raw_odd_type: outcome.id,
        source_odd_id: Number(`${externalEventId(event.eventId)}${market.id}${outcome.id}`.replace(/\D/g, "").slice(0, 15)),
        raw: { event, market, outcome, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createSportybetCollector(bookmaker: SportybetBookmakerConfig) {
  return async function collectSportybet(options: BookmakerCollectOptions = {}) {
    const client = new SportybetClient(bookmaker);
    const summary = {
      pagesFetched: 0,
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
    let fixtures = restrictFixturesToRequested(await getCanonicalFixtures(), options.fixtureIds);
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
      const eventsById = new Map<string, SportybetEvent>();
      const targetEventsById = new Map<string, SportybetEvent>();
      const matchedFixtureIds = new Set<string>();

      for (let pageNum = 1; pageNum <= bookmaker.maxPages; pageNum += 1) {
        const page = await client.getUpcomingEventsPage(pageNum);
        summary.pagesFetched += 1;

        if (!page.events.length) break;

        for (const event of page.events) {
          eventsById.set(event.eventId, event);

          if (event.status !== 0 || !isNearCanonicalFixtureWindow(event, fixtures)) continue;

          targetEventsById.set(event.eventId, event);
          const matched = await matchFixture(event, fixtures, bookmaker.slug);
          if (matched) matchedFixtureIds.add(matched.fixture.id);
        }

        if (matchedFixtureIds.size >= fixtures.length) break;

        await sleep(pageDelayMs());
      }

      const targetEvents = [...targetEventsById.values()];
      summary.eventsSeen = eventsById.size;
      summary.eventsInWindow = targetEvents.length;
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      const missingFixturesAfterPages = fixtures.filter((fixture) => !matchedFixtureIds.has(fixture.id));
      const fallbackTournamentIds = [
        ...new Set(
          [...eventsById.values()]
            .filter((event) => {
              const tournamentId = eventTournamentId(event);
              const tournamentName = eventLeagueName(event);
              return Boolean(tournamentId) && missingFixturesAfterPages.some((fixture) => leagueLooksLike(fixtureLeague(fixture)?.name, tournamentName));
            })
            .map((event) => eventTournamentId(event))
            .filter((tournamentId): tournamentId is string => Boolean(tournamentId))
        )
      ];

      const fallbackPages = await Promise.all(fallbackTournamentIds.map((tournamentId) => client.getTournamentEvents(tournamentId)));
      for (const event of fallbackPages.flat()) {
        eventsById.set(event.eventId, event);

        if (event.status !== 0 || !isNearCanonicalFixtureWindow(event, fixtures)) continue;
        targetEventsById.set(event.eventId, event);
      }

      const bestMatchByFixtureId = new Map<string, { event: SportybetEvent; matched: NonNullable<Awaited<ReturnType<typeof matchFixture>>> }>();

      for (const event of targetEventsById.values()) {
        try {
          const matched = await matchFixture(event, fixtures, bookmaker.slug);

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
          await log(bookmaker, "error", "sportybet event collection failed", { eventId: event.eventId, error: serializeError(error) });
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
      await log(bookmaker, "error", "sportybet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "sportybet collection finished", summary);
    return summary;
  };
}

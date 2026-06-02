import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { VaidebetBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { teamNameSimilarity } from "../domain/matching/text-similarity.js";
import { normalizeName } from "../domain/text.js";
import { VaidebetClient, type VaidebetFixture, type VaidebetMarket, type VaidebetOdd } from "../providers/vaidebet.js";
import { errorMessage } from "../utils/errors.js";
import { logCollectorMessage } from "./collector-log.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STRICT_TIME_WINDOW_MINUTES = 20;
const RELAXED_DELTA_TIME_WINDOW_MINUTES = 120;
const RELAXED_DELTA_MIN_TEAM_SCORE = 0.94;

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

async function log(bookmaker: VaidebetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  logCollectorMessage(bookmaker.slug, level, message, context);
}

async function ensureBaseRows(bookmaker: VaidebetBookmakerConfig) {
  const { error } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;
}

async function getCachedExternalEventIds(bookmakerSlug: string, fixtureIds: string[]) {
  const externalIdByFixtureId = new Map<string, number>();
  if (!fixtureIds.length) return externalIdByFixtureId;

  const { data, error } = await supabase
    .from("bookmaker_event_links")
    .select("fixture_id,external_event_id")
    .eq("bookmaker_slug", bookmakerSlug)
    .in("fixture_id", fixtureIds);

  if (error) throw error;

  for (const row of data ?? []) {
    const externalEventId = Number(row.external_event_id);
    if (Number.isFinite(externalEventId)) externalIdByFixtureId.set(row.fixture_id, externalEventId);
  }

  return externalIdByFixtureId;
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

function findBestMatch(event: VaidebetFixture, fixtures: CanonicalFixture[]) {
  let best: (EventMatchResult & { fixture: CanonicalFixture }) | null = null;
  const leagueName = event.sourceLeagueName ?? event.sourceSeasonName ?? null;

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
        id: event.fId,
        startsAt: event.fsd,
        homeTeam: event.hcN ?? null,
        awayTeam: event.acN ?? null,
        leagueName
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  if (!best) {
    for (const fixture of fixtures) {
      const fixtureStart = new Date(fixture.starts_at).getTime();
      const eventStart = Number(event.fsd);
      const diffMs = Math.abs(fixtureStart - eventStart);
      if (!Number.isFinite(fixtureStart) || !Number.isFinite(eventStart) || diffMs > RELAXED_DELTA_TIME_WINDOW_MINUTES * 60 * 1000) continue;

      const normalHomeScore = teamNameSimilarity(fixture.home_team, event.hcN);
      const normalAwayScore = teamNameSimilarity(fixture.away_team, event.acN);
      const invertedHomeScore = teamNameSimilarity(fixture.home_team, event.acN);
      const invertedAwayScore = teamNameSimilarity(fixture.away_team, event.hcN);
      const normalScore = (normalHomeScore + normalAwayScore) / 2;
      const invertedScore = (invertedHomeScore + invertedAwayScore) / 2;
      const orientation = normalScore >= invertedScore ? "NORMAL" : "INVERTED";
      const teamScore = Math.max(normalScore, invertedScore);
      const sideScores = orientation === "NORMAL" ? [normalHomeScore, normalAwayScore] : [invertedHomeScore, invertedAwayScore];
      if (teamScore < RELAXED_DELTA_MIN_TEAM_SCORE || Math.min(...sideScores) < 0.88) continue;

      const timeScore = Math.max(0, 1 - diffMs / (RELAXED_DELTA_TIME_WINDOW_MINUTES * 60 * 1000));
      const score = teamScore * 0.9 + timeScore * 0.1;
      if (!best || score > best.score) {
        best = {
          matched: true,
          score,
          timeScore,
          teamScore,
          orientation,
          reason: "vaidebet-relaxed-time",
          fixture
        };
      }
    }
  }

  if (!best) return null;
  return { ...best, homeTeam: event.hcN ?? null, awayTeam: event.acN ?? null };
}

function isNearCanonicalFixtureWindow(event: VaidebetFixture, fixtures: CanonicalFixture[], maxDiffMinutes = STRICT_TIME_WINDOW_MINUTES) {
  const eventStart = Number(event.fsd);
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= maxDiffMinutes * 60 * 1000;
  });
}

function collectionWindow(fixtures: CanonicalFixture[]) {
  const times = fixtures.map((fixture) => new Date(fixture.starts_at).getTime()).filter(Number.isFinite);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);

  return {
    start: new Date(minTime - 60 * 60 * 1000),
    end: new Date(maxTime + 60 * 60 * 1000)
  };
}

function isMoneylineMarket(market: VaidebetMarket) {
  const text = `${market.btgN ?? ""} ${market.btgNO ?? ""} ${market.btgMN ?? ""} ${market.mbtgMN ?? ""} ${market.mrkp ?? ""}`;
  return (
    market.btgId === 7988 ||
    market.btgId === 115382 ||
    (/resultado/i.test(text) && /partida|h\/d\/a|1x2/i.test(text)) ||
    /1x2\s*\(\s*2up\s*\)|xup=2/i.test(text)
  );
}

function paForMarket(market: VaidebetMarket): { category: PaCategory; confidence: number; reason: string } {
  const text = `${market.btgN ?? ""} ${market.btgNO ?? ""} ${market.btgMN ?? ""} ${market.mbtgMN ?? ""} ${market.mrkp ?? ""}`;
  if (/1x2\s*\(\s*2up\s*\)|xup=2/i.test(text)) {
    return { category: "COM_PA", confidence: 0.95, reason: "vaidebet-2up-market" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "vaidebet-standard-result-market" };
}

function selectionFromOdd(odd: VaidebetOdd, homeTeam: string | null, awayTeam: string | null): Selection | null {
  const sideLabel = `${odd.pSh ?? ""} ${odd.btN ?? ""}`;
  if (/empate|draw/i.test(sideLabel)) return "DRAW";
  if (/home|casa/i.test(sideLabel)) return "HOME";
  if (/away|fora/i.test(sideLabel)) return "AWAY";

  const label = `${odd.hSh ?? ""} ${odd.oc ?? ""}`;
  if (/empate|draw/i.test(label)) return "DRAW";

  const homeScore = Math.max(homeTeam ? teamNameSimilarity(odd.hSh, homeTeam) : 0, homeTeam ? teamNameSimilarity(odd.oc, homeTeam) : 0);
  const awayScore = Math.max(awayTeam ? teamNameSimilarity(odd.hSh, awayTeam) : 0, awayTeam ? teamNameSimilarity(odd.oc, awayTeam) : 0);
  if (Math.max(homeScore, awayScore) < 0.72) return null;

  return homeScore > awayScore ? "HOME" : "AWAY";
}

function sourceUrl(bookmaker: VaidebetBookmakerConfig, event: VaidebetFixture) {
  const name = `${event.hcN ?? ""}-${event.acN ?? ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${bookmaker.baseUrl.replace(/\/$/, "")}/esportes/futebol/evento/${name}-${event.fId}`;
}

function buildBookmakerLink(bookmaker: VaidebetBookmakerConfig, fixtureId: string, event: VaidebetFixture, confidenceScore: number): BookmakerLinkRow {
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.fId,
    fixture_id: fixtureId,
    bookmaker_event_name: [event.hcN, event.acN].filter(Boolean).join(" vs "),
    bookmaker_home_team: event.hcN ?? null,
    bookmaker_away_team: event.acN ?? null,
    normalized_bookmaker_home_team: normalizeName(event.hcN),
    normalized_bookmaker_away_team: normalizeName(event.acN),
    starts_at: new Date(event.fsd).toISOString(),
    match_confidence_score: confidenceScore,
    source_url: sourceUrl(bookmaker, event),
    raw: event,
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: VaidebetBookmakerConfig, fixtureId: string, event: VaidebetFixture, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];

  for (const market of (event.btgs ?? []).filter(isMoneylineMarket)) {
    const pa = paForMarket(market);

    for (const odd of market.fos ?? []) {
      const isValid = odd.valid !== false || odd.tvalid === true;
      if (!isValid || odd.freeze || Number(odd.hO) <= 0) continue;

      const selection = selectionFromOdd(odd, event.hcN ?? null, event.acN ?? null);
      if (!selection) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price: Number(odd.hO),
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.mbtgMN ?? market.btgNO ?? market.btgN ?? null,
        raw_label: odd.hSh ?? odd.oc ?? odd.pSh ?? null,
        raw_odd_type: odd.btN ?? String(market.btgId),
        source_odd_id: odd.foId,
        raw: { event, market, odd, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createVaidebetCollector(bookmaker: VaidebetBookmakerConfig) {
  return async function collectVaidebet(options: BookmakerCollectOptions = {}) {
    const client = new VaidebetClient(bookmaker);
    const summary = {
      seasonsSeen: 0,
      seasonsSelected: 0,
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
      if (bookmaker.deltaApiBaseUrl) {
        const { start, end } = collectionWindow(fixtures);
        const events = await client.getDeltaSoccerEvents(start, end);
        summary.eventsSeen = events.length;

        const targetEvents = events.filter((event) => event.vld !== false && event.frz !== true && isNearCanonicalFixtureWindow(event, fixtures, RELAXED_DELTA_TIME_WINDOW_MINUTES));
        summary.eventsInWindow = targetEvents.length;

        const bestMatchByFixtureId = new Map<string, { event: VaidebetFixture; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();
        const linksToSave: BookmakerLinkRow[] = [];
        const oddsToSave: OddRow[] = [];

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
        await log(bookmaker, "info", "vaidebet collection finished", summary);
        return summary;
      }

      const seasons = await client.getFootballSeasons();
      const selectedSeasonIds = [...new Set(seasons.map((season) => season.sId))];
      summary.seasonsSeen = seasons.length;
      summary.seasonsSelected = selectedSeasonIds.length;

      const chunks: number[][] = [];
      for (let index = 0; index < selectedSeasonIds.length; index += 20) {
        chunks.push(selectedSeasonIds.slice(index, index + 20));
      }

      const events: VaidebetFixture[] = [];
      await pMap(
        chunks,
        async (chunk) => {
          await sleep(Math.floor(Math.random() * 500));
          const chunkEvents = await client.getLeagueCard(chunk);
          events.push(...chunkEvents);
        },
        { concurrency: 3 }
      );
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => event.vld !== false && event.frz !== true && isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: VaidebetFixture; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

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
      const cachedExternalEventIds = await getCachedExternalEventIds(
        bookmaker.slug,
        missingFixtures.map((fixture) => fixture.id)
      );
      const cachedEventIdChunks: number[][] = [];
      const cachedEventIds = [...new Set(cachedExternalEventIds.values())];
      for (let index = 0; index < cachedEventIds.length; index += 20) {
        cachedEventIdChunks.push(cachedEventIds.slice(index, index + 20));
      }

      const cachedEventPages = await pMap(cachedEventIdChunks, (chunk) => client.getEventCard(chunk), { concurrency: 3 });
      const cachedEvents = [...new Map(cachedEventPages.flat().map((event) => [event.fId, event])).values()];
      summary.eventsSeen += cachedEvents.length;

      for (const event of cachedEvents.filter((event) => event.vld !== false && event.frz !== true && isNearCanonicalFixtureWindow(event, fixtures))) {
        const matched = findBestMatch(event, fixtures);
        if (!matched) continue;

        const previous = bestMatchByFixtureId.get(matched.fixture.id);
        if (!previous || matched.score > previous.matched.score) {
          bestMatchByFixtureId.set(matched.fixture.id, { event, matched });
        }
      }

      for (const { event, matched } of bestMatchByFixtureId.values()) {
        try {
          linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, event, matched.score));
          oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, event, matched.orientation));
          summary.eventsCollected += 1;
          summary.eventsMatched += 1;
        } catch (error) {
          summary.errors += 1;
          summary.lastError = errorMessage(error);
          await log(bookmaker, "error", "vaidebet event collection failed", { eventId: event.fId, error: serializeError(error) });
        }
      }

      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
        cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "vaidebet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "vaidebet collection finished", summary);
    return summary;
  };
}

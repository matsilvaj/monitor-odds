import type { SportybetBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents } from "../domain/matching/event-matcher.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { nameSimilarity, normalizeName } from "../domain/text.js";
import { SportybetClient, type SportybetEvent, type SportybetMarket, type SportybetOutcome } from "../providers/sportybet.js";
import { errorMessage } from "../utils/errors.js";

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
  home_team: string | null;
  away_team: string | null;
  normalized_home_team: string | null;
  normalized_away_team: string | null;
  starts_at: string;
};

async function log(bookmaker: SportybetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
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
    .select("id,api_football_fixture_id,name,home_team,away_team,normalized_home_team,normalized_away_team,starts_at")
    .gt("starts_at", now.toISOString())
    .lt("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CanonicalFixture[];
}

function matchFixture(event: SportybetEvent, fixtures: CanonicalFixture[]) {
  const homeTeam = event.homeTeamName ?? null;
  const awayTeam = event.awayTeamName ?? null;
  let best: { fixture: CanonicalFixture; score: number } | null = null;
  for (const fixture of fixtures) {
    const result = matchEvents(
      {
        id: fixture.id,
        startsAt: fixture.starts_at,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team
      },
      {
        id: event.eventId,
        startsAt: event.estimateStartTime,
        homeTeam,
        awayTeam
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { fixture, score: result.score };
  }

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
  const desc = outcome.desc ?? "";
  if (/empate/i.test(desc)) return "DRAW";
  if (nameSimilarity(desc, homeTeam) >= 0.5) return "HOME";
  if (nameSimilarity(desc, awayTeam) >= 0.5) return "AWAY";
  return null;
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
    source_url: bookmaker.referer,
    raw: event,
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: SportybetBookmakerConfig, fixtureId: string, event: SportybetEvent): OddRow[] {
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
        selection,
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
  return async function collectSportybet() {
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
    const fixtures = await getCanonicalFixtures();
    if (!fixtures.length) {
      await log(bookmaker, "warn", "no canonical fixtures; run api-football sync first");
      return summary;
    }

    try {
      const eventsById = new Map<string, SportybetEvent>();
      const targetEventsById = new Map<string, SportybetEvent>();
      const matchedFixtureIds = new Set<string>();
      let totalNum = 0;

      for (let pageNum = 1; pageNum <= bookmaker.maxPages; pageNum += 1) {
        const page = await client.getUpcomingEventsPage(pageNum);
        summary.pagesFetched += 1;
        totalNum = page.totalNum;

        if (!page.events.length) break;

        for (const event of page.events) {
          eventsById.set(event.eventId, event);

          if (event.status !== 0 || !isNearCanonicalFixtureWindow(event, fixtures)) continue;

          targetEventsById.set(event.eventId, event);
          const matched = matchFixture(event, fixtures);
          if (matched) matchedFixtureIds.add(matched.fixture.id);
        }

        if (matchedFixtureIds.size >= fixtures.length) break;
        if (eventsById.size >= totalNum) break;

        await sleep(pageDelayMs());
      }

      const targetEvents = [...targetEventsById.values()];
      summary.eventsSeen = eventsById.size;
      summary.eventsInWindow = targetEvents.length;
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      for (const event of targetEvents) {
        try {
          const matched = matchFixture(event, fixtures);

          if (!matched) {
            summary.eventsUnmatched += 1;
            continue;
          }

          linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, event, matched.score));
          oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, event));
          summary.eventsCollected += 1;
          summary.eventsMatched += 1;
        } catch (error) {
          summary.errors += 1;
          summary.lastError = errorMessage(error);
          await log(bookmaker, "error", "sportybet event collection failed", { eventId: event.eventId, error: serializeError(error) });
        }
      }

      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave);
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "sportybet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "sportybet collection finished", summary);
    return summary;
  };
}

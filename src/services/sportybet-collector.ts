import type { SportybetBookmakerConfig } from "../config/bookmakers.js";
import { supabase } from "../db/supabase.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { nameSimilarity, normalizeName } from "../domain/text.js";
import { SportybetClient, type SportybetEvent, type SportybetMarket, type SportybetOutcome } from "../providers/sportybet.js";

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
  const eventStart = Number(event.estimateStartTime);

  let best: { fixture: CanonicalFixture; score: number } | null = null;
  for (const fixture of fixtures) {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    const hoursApart = Math.abs(fixtureStart - eventStart) / 36e5;
    if (!Number.isFinite(hoursApart) || hoursApart > 12) continue;

    const homeScore = Math.max(
      nameSimilarity(homeTeam, fixture.normalized_home_team ?? fixture.home_team),
      nameSimilarity(homeTeam, fixture.away_team)
    );
    const awayScore = Math.max(
      nameSimilarity(awayTeam, fixture.normalized_away_team ?? fixture.away_team),
      nameSimilarity(awayTeam, fixture.home_team)
    );
    const score = (homeScore + awayScore) / 2 - hoursApart * 0.02;

    if (!best || score > best.score) best = { fixture, score };
  }

  if (!best || best.score < 0.55) return null;
  return { ...best, homeTeam, awayTeam };
}

function isNearCanonicalFixtureWindow(event: SportybetEvent, fixtures: CanonicalFixture[]) {
  const eventStart = Number(event.estimateStartTime);
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) / 36e5 <= 12;
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

async function upsertBookmakerLink(bookmaker: SportybetBookmakerConfig, fixtureId: string, event: SportybetEvent, confidenceScore: number) {
  const { error } = await supabase.from("bookmaker_event_links").upsert(
    {
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
    },
    { onConflict: "bookmaker_slug,external_event_id" }
  );

  if (error) throw error;
}

async function replaceMoneylineOdds(bookmaker: SportybetBookmakerConfig, fixtureId: string, event: SportybetEvent) {
  const rows = [];

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

  const uniqueRows = [...new Map(rows.map((row) => [`${row.fixture_id}:${row.bookmaker_slug}:${row.market_code}:${row.selection}:${row.pa_category}:${row.source_odd_id}`, row])).values()];

  await supabase.from("odds").delete().eq("fixture_id", fixtureId).eq("bookmaker_slug", bookmaker.slug).eq("market_code", "1X2");

  if (!uniqueRows.length) return 0;

  const { error } = await supabase.from("odds").upsert(uniqueRows, {
    onConflict: "fixture_id,bookmaker_slug,market_code,selection,pa_category,source_odd_id"
  });
  if (error) throw error;

  return uniqueRows.length;
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
      errors: 0
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

      for (const event of targetEvents) {
        try {
          const matched = matchFixture(event, fixtures);

          if (!matched) {
            summary.eventsUnmatched += 1;
            continue;
          }

          await upsertBookmakerLink(bookmaker, matched.fixture.id, event, matched.score);
          summary.oddsUpserted += await replaceMoneylineOdds(bookmaker, matched.fixture.id, event);
          summary.eventsCollected += 1;
          summary.eventsMatched += 1;
        } catch (error) {
          summary.errors += 1;
          await log(bookmaker, "error", "sportybet event collection failed", { eventId: event.eventId, error: serializeError(error) });
        }
      }
    } catch (error) {
      summary.errors += 1;
      await log(bookmaker, "error", "sportybet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "sportybet collection finished", summary);
    return summary;
  };
}

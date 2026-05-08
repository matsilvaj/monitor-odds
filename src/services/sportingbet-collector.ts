import type { SportingbetBookmakerConfig } from "../config/bookmakers.js";
import { env } from "../config/env.js";
import { supabase } from "../db/supabase.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { nameSimilarity, normalizeName } from "../domain/text.js";
import { SportingbetClient, type SportingbetFixture, type SportingbetMarket, type SportingbetOption } from "../providers/sportingbet.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function collectDelayMs() {
  return env.COLLECT_DELAY_MS + Math.floor(Math.random() * (env.COLLECT_JITTER_MS + 1));
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
  const eventStart = new Date(event.startDate).getTime();

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

function isNearCanonicalFixtureWindow(event: SportingbetFixture, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.startDate).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) / 36e5 <= 12;
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
  if (nameSimilarity(name, homeTeam) >= 0.5) return "HOME";
  if (nameSimilarity(name, awayTeam) >= 0.5) return "AWAY";
  return null;
}

async function upsertBookmakerLink(bookmaker: SportingbetBookmakerConfig, fixtureId: string, event: SportingbetFixture, confidenceScore: number) {
  const { homeTeam, awayTeam } = teamNames(event);
  const sourceUrl = `${bookmaker.baseUrl.replace(/\/$/, "")}/pt-br/sports/eventos/${String(event.name?.value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${event.id}`;

  const { error } = await supabase.from("bookmaker_event_links").upsert(
    {
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
      raw: event,
      updated_at: new Date().toISOString()
    },
    { onConflict: "bookmaker_slug,external_event_id" }
  );

  if (error) throw error;
}

async function replaceMoneylineOdds(bookmaker: SportingbetBookmakerConfig, fixtureId: string, event: SportingbetFixture) {
  const { homeTeam, awayTeam } = teamNames(event);
  const rows = [];

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
        selection,
        price: option.price?.odds,
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.name?.value ?? null,
        raw_label: option.name?.value ?? null,
        raw_odd_type: option.parameters?.optionTypes?.join(",") ?? null,
        source_odd_id: option.id,
        raw: { event, market, option, classificationReason: pa.reason },
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

export function createSportingbetCollector(bookmaker: SportingbetBookmakerConfig) {
  return async function collectSportingbet() {
    const client = new SportingbetClient(bookmaker);
    const summary = {
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
      const events = await client.getFixtures();
      summary.eventsSeen = events.length;
      const targetEvents = events.filter((event) => event.stage === "PreMatch" && isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      for (const event of targetEvents) {
        try {
          const matched = matchFixture(event, fixtures);

          if (!matched) {
            summary.eventsUnmatched += 1;
            continue;
          }

          await sleep(collectDelayMs());
          await upsertBookmakerLink(bookmaker, matched.fixture.id, event, matched.score);
          summary.oddsUpserted += await replaceMoneylineOdds(bookmaker, matched.fixture.id, event);
          summary.eventsCollected += 1;
          summary.eventsMatched += 1;
        } catch (error) {
          summary.errors += 1;
          await log(bookmaker, "error", "sportingbet event collection failed", { eventId: event.id, error: serializeError(error) });
        }
      }
    } catch (error) {
      summary.errors += 1;
      await log(bookmaker, "error", "sportingbet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "sportingbet collection finished", summary);
    return summary;
  };
}

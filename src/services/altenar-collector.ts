import type { AltenarBookmakerConfig } from "../config/bookmakers.js";
import { MVP_LEAGUES } from "../config/leagues.js";
import { env } from "../config/env.js";
import { supabase } from "../db/supabase.js";
import { classifyPa, isMoneylineMarket, selectionFromOddType } from "../domain/normalize.js";
import { nameSimilarity, normalizeName } from "../domain/text.js";
import { AltenarClient, type AltenarEventDetails, type AltenarMarket, type AltenarOdd } from "../providers/altenar.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function collectDelayMs() {
  return env.COLLECT_DELAY_MS + Math.floor(Math.random() * (env.COLLECT_JITTER_MS + 1));
}

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

async function getCanonicalFixtures(apiFootballLeagueId: number) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);

  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,home_team,away_team,normalized_home_team,normalized_away_team,starts_at,leagues!inner(api_football_league_id)")
    .eq("leagues.api_football_league_id", apiFootballLeagueId)
    .gt("starts_at", now.toISOString())
    .lt("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as CanonicalFixture[];
}

function matchFixture(details: AltenarEventDetails, fixtures: CanonicalFixture[]) {
  const { homeTeam, awayTeam } = splitTeams(details);
  const eventStart = new Date(details.startDate).getTime();

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

    if (!best || score > best.score) {
      best = { fixture, score };
    }
  }

  if (!best || best.score < 0.55) return null;
  return { ...best, homeTeam, awayTeam };
}

function isNearCanonicalFixtureWindow(startDate: string, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(startDate).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) / 36e5 <= 12;
  });
}

async function upsertBookmakerLink(bookmaker: AltenarBookmakerConfig, fixtureId: string, details: AltenarEventDetails, confidenceScore: number) {
  const { homeTeam, awayTeam } = splitTeams(details);
  const sourceUrl = `${bookmaker.referer.replace(/\/$/, "")}/sports/futebol/evento/ev-${details.id}`;

  const { error } = await supabase
    .from("bookmaker_event_links")
    .upsert(
      {
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
        raw: details,
        updated_at: new Date().toISOString()
      },
      { onConflict: "bookmaker_slug,external_event_id" }
    );

  if (error) throw error;
}

async function replaceMoneylineOdds(bookmaker: AltenarBookmakerConfig, fixtureId: string, details: AltenarEventDetails) {
  const markets = [...(details.markets ?? []), ...(details.childMarkets ?? [])].filter((market) =>
    isMoneylineMarket(market.name ?? market.shortName, market.typeId)
  );

  const odds = details.odds ?? [];
  const rows = [];

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
        selection,
        price: odd.price,
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

  const uniqueRows = [...new Map(rows.map((row) => [`${row.fixture_id}:${row.bookmaker_slug}:${row.market_code}:${row.selection}:${row.pa_category}:${row.source_odd_id}`, row])).values()];

  await supabase.from("odds").delete().eq("fixture_id", fixtureId).eq("bookmaker_slug", bookmaker.slug).eq("market_code", "1X2");

  if (!uniqueRows.length) return 0;

  const { error } = await supabase.from("odds").upsert(uniqueRows, {
    onConflict: "fixture_id,bookmaker_slug,market_code,selection,pa_category,source_odd_id"
  });
  if (error) throw error;

  return uniqueRows.length;
}

export function createAltenarCollector(bookmaker: AltenarBookmakerConfig) {
  return async function collectAltenarBookmaker() {
    const client = new AltenarClient(bookmaker);
    const summary = {
      leagues: 0,
      eventsSeen: 0,
      eventsInWindow: 0,
      eventsCollected: 0,
      eventsMatched: 0,
      eventsUnmatched: 0,
      oddsUpserted: 0,
      errors: 0
    };

    await ensureBaseRows(bookmaker);

    for (const league of MVP_LEAGUES) {
      summary.leagues += 1;
      const canonicalFixtures = await getCanonicalFixtures(league.apiFootballLeagueId);
      if (!canonicalFixtures.length) {
        await log(bookmaker, "warn", "no canonical fixtures for league; run api-football sync first", { league: league.slug });
        continue;
      }

      try {
        const events = await client.getEvents(league.altenarChampId);
        summary.eventsSeen += events.length;
        const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event.startDate, canonicalFixtures));
        summary.eventsInWindow += targetEvents.length;

        for (const event of targetEvents) {
          try {
            await sleep(collectDelayMs());
            const details = await client.getEventDetails(event.id);

            const matched = matchFixture(details, canonicalFixtures);
            if (!matched) {
              summary.eventsUnmatched += 1;
              await log(bookmaker, "warn", "bookmaker event did not match canonical fixture", {
                league: league.slug,
                eventId: event.id,
                eventName: event.name
              });
              continue;
            }

            await upsertBookmakerLink(bookmaker, matched.fixture.id, details, matched.score);
            const oddsCount = await replaceMoneylineOdds(bookmaker, matched.fixture.id, details);
            summary.eventsMatched += 1;
            summary.eventsCollected += 1;
            summary.oddsUpserted += oddsCount;
          } catch (error) {
            summary.errors += 1;
            await log(bookmaker, "error", "event collection failed", {
              league: league.slug,
              eventId: event.id,
              error: serializeError(error)
            });
          }
        }
      } catch (error) {
        summary.errors += 1;
        await log(bookmaker, "error", "league collection failed", {
          league: league.slug,
          error: serializeError(error)
        });
      }
    }

    await log(bookmaker, "info", `${bookmaker.slug} collection finished`, summary);
    return summary;
  };
}

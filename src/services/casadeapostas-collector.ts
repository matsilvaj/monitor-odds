import type { CasaDeApostasBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeForMatching, teamNameSimilarity } from "../domain/matching/text-similarity.js";
import type { Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { CasaDeApostasClient, type CasaDeApostasGame, type CasaDeApostasMarket, type CasaDeApostasOdd } from "../providers/casadeapostas.js";
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

async function log(bookmaker: CasaDeApostasBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: CasaDeApostasBookmakerConfig) {
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

function parseCasaDate(value: string | undefined) {
  const text = String(value ?? "");
  if (!text) return new Date("");
  return new Date(text.endsWith("Z") ? text : `${text}Z`);
}

function eventTeams(event: CasaDeApostasGame) {
  const [home, away] = event.competitors ?? [];
  if (home?.name || away?.name) {
    return {
      homeTeam: home?.name ?? home?.competitor?.name ?? null,
      awayTeam: away?.name ?? away?.competitor?.name ?? null
    };
  }

  const [homeTeam, awayTeam] = String(event.name ?? "").split(/\s+-\s+|\s+vs\.?\s+/i);
  return { homeTeam: homeTeam?.trim() || null, awayTeam: awayTeam?.trim() || null };
}

function isNearCanonicalFixtureWindow(event: CasaDeApostasGame, fixtures: CanonicalFixture[]) {
  const eventStart = parseCasaDate(event.startDate).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: CasaDeApostasGame, fixtures: CanonicalFixture[]) {
  const { homeTeam, awayTeam } = eventTeams(event);
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
        startsAt: parseCasaDate(event.startDate),
        homeTeam,
        awayTeam,
        leagueName: event.leagueName ?? null
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function isMoneylineMarket(market: CasaDeApostasMarket) {
  const name = normalizeForMatching(market.name);
  return (market.marketTypeId === 1 || market.marketTypeId === 1252) && name.startsWith("1x2") && market.published !== false && market.state !== 0;
}

function paForMarket(market: CasaDeApostasMarket) {
  if (market.marketTypeId === 1252 || /pagamento\s+antecipado|early\s+payout/i.test(String(market.name ?? ""))) {
    return { category: "COM_PA" as const, confidence: 0.99, reason: "casadeapostas-1x2-pagamento-antecipado" };
  }

  return { category: "SEM_PA" as const, confidence: 1, reason: "casadeapostas-standard-1x2" };
}

function selectionFromOdd(odd: CasaDeApostasOdd, homeTeam: string | null, awayTeam: string | null): Selection | null {
  if (odd.externalId === "1") return "HOME";
  if (odd.externalId === "2" || normalizeForMatching(odd.name) === "empate") return "DRAW";
  if (odd.externalId === "3") return "AWAY";

  const homeScore = homeTeam ? teamNameSimilarity(odd.name, homeTeam) : 0;
  const awayScore = awayTeam ? teamNameSimilarity(odd.name, awayTeam) : 0;
  if (Math.max(homeScore, awayScore) < 0.75) return null;

  return homeScore >= awayScore ? "HOME" : "AWAY";
}

function buildBookmakerLink(bookmaker: CasaDeApostasBookmakerConfig, fixtureId: string, event: CasaDeApostasGame, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = eventTeams(event);

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.id,
    fixture_id: fixtureId,
    bookmaker_event_name: event.name ?? [homeTeam, awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: parseCasaDate(event.startDate).toISOString(),
    match_confidence_score: confidenceScore,
    source_url: new URL(`br/sports/event/${event.id}`, bookmaker.baseUrl).href,
    raw: event,
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: CasaDeApostasBookmakerConfig, fixtureId: string, event: CasaDeApostasGame, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];
  const { homeTeam, awayTeam } = eventTeams(event);

  for (const market of (event.markets ?? []).filter(isMoneylineMarket)) {
    const pa = paForMarket(market);

    for (const odd of market.odds ?? []) {
      const price = Number(odd.value);
      if (!Number.isFinite(price) || price <= 0 || odd.state !== 1 || odd.published === false) continue;

      const selection = selectionFromOdd(odd, homeTeam, awayTeam);
      if (!selection) continue;

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
        raw_label: odd.name ?? null,
        raw_odd_type: odd.externalId ?? String(market.marketTypeId ?? ""),
        source_odd_id: odd.id,
        raw: { event, market, odd, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createCasaDeApostasCollector(bookmaker: CasaDeApostasBookmakerConfig) {
  return async function collectCasaDeApostas() {
    const client = new CasaDeApostasClient(bookmaker);
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
    const fixtures = await getCanonicalFixtures();
    if (!fixtures.length) {
      await log(bookmaker, "warn", "no canonical fixtures; run api-football sync first");
      return summary;
    }

    try {
      const startsAt = fixtures.map((fixture) => new Date(fixture.starts_at).getTime()).filter(Number.isFinite);
      const startDate = new Date(Math.max(Date.now(), Math.min(...startsAt) - 30 * 60 * 1000));
      const endDate = new Date(Math.max(...startsAt) + 30 * 60 * 1000);
      const events = await client.getGames(startDate, endDate);
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: CasaDeApostasGame; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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
      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave);
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "casadeapostas collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "casadeapostas collection finished", summary);
    return summary;
  };
}

import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { BetboomBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeForMatching, tokenSetSimilarity } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { BetboomClient, type BetboomEvent, type BetboomOdd, type BetboomTournament } from "../providers/betboom.js";
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
    | {
        name: string;
        slug: string;
        country: string | null;
        api_football_league_id: number;
      }
    | Array<{
        name: string;
        slug: string;
        country: string | null;
        api_football_league_id: number;
      }>
    | null;
  home_team: string | null;
  away_team: string | null;
  normalized_home_team: string | null;
  normalized_away_team: string | null;
  starts_at: string;
};

const COUNTRY_HINTS: Record<string, string[]> = {
  argentina: ["argentina"],
  belgium: ["belgica", "belgium"],
  brazil: ["brasil"],
  brasil: ["brasil"],
  england: ["inglaterra"],
  france: ["franca", "frança", "france"],
  germany: ["alemanha"],
  italy: ["italia", "itália", "italy"],
  netherlands: ["holanda", "paises baixos", "países baixos", "netherlands"],
  portugal: ["portugal"],
  scotland: ["escocia", "escócia", "scotland"],
  spain: ["espanha"],
  turkey: ["turquia", "turkey"],
  usa: ["eua", "usa", "estados unidos"],
  world: ["copa", "uefa", "conmebol"],
  europe: ["uefa", "europa"]
};

async function log(bookmaker: BetboomBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  logCollectorMessage(bookmaker.slug, level, message, context);
}

async function ensureBaseRows(bookmaker: BetboomBookmakerConfig) {
  const { error } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;
}

async function getCanonicalFixtures() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);

  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,league:leagues(name,slug,country,api_football_league_id),home_team,away_team,normalized_home_team,normalized_away_team,starts_at")
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

function countryMatches(country: string | null | undefined, tournamentText: string) {
  const normalizedCountry = normalizeForMatching(country);
  if (!normalizedCountry) return true;

  const hints = COUNTRY_HINTS[normalizedCountry] ?? [normalizedCountry];
  return hints.some((hint) => tournamentText.includes(hint));
}

function tournamentMatchesLeague(tournament: BetboomTournament, league: ReturnType<typeof fixtureLeague>, categoryText = "") {
  if (!league) return false;

  const leagueName = normalizeForMatching(league.name);
  const leagueCompact = compact(league.name);
  const tournamentText = normalizeForMatching(`${tournament.name} ${tournament.alias ?? ""} ${categoryText}`);
  const tournamentCompact = compact(`${tournament.name} ${tournament.alias ?? ""} ${categoryText}`);
  const hasCountry = countryMatches(league.country, tournamentText);
  const nameScore = Math.max(tokenSetSimilarity(league.name, tournament.name), tokenSetSimilarity(league.name, `${tournament.name} ${tournament.alias ?? ""}`));

  if (leagueCompact && tournamentCompact.includes(leagueCompact) && hasCountry) return true;
  if (leagueName.includes("la liga") && tournamentCompact.includes("laliga") && hasCountry) return true;
  if (hasCountry && nameScore >= 0.62) return true;
  if (leagueName.includes("libertadores") && tournamentText.includes("libertadores")) return true;
  if (leagueName.includes("europa league") && tournamentText.includes("europa league")) return true;
  if (leagueName.includes("conference league") && tournamentText.includes("conference league")) return true;
  if (leagueName.includes("champions league") && tournamentText.includes("champions league")) return true;

  return false;
}

function selectTournamentsForFixtures(tournaments: BetboomTournament[], fixtures: CanonicalFixture[]) {
  const selected = new Map<number, BetboomTournament>();
  const categoryTextById = new Map<number, string>();

  for (const tournament of tournaments) {
    if (tournament.categoryId == null) continue;
    categoryTextById.set(tournament.categoryId, `${categoryTextById.get(tournament.categoryId) ?? ""} ${tournament.name} ${tournament.alias ?? ""}`);
  }

  for (const fixture of fixtures) {
    const league = fixtureLeague(fixture);
    for (const tournament of tournaments) {
      const categoryText = tournament.categoryId == null ? "" : categoryTextById.get(tournament.categoryId) ?? "";
      if (tournamentMatchesLeague(tournament, league, categoryText)) selected.set(tournament.tournamentId, tournament);
    }
  }

  return [...selected.values()];
}

function eventTeams(event: BetboomEvent) {
  return {
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam
  };
}

function findBestMatch(event: BetboomEvent, fixtures: CanonicalFixture[]) {
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
        startsAt: event.startsAt,
        homeTeam,
        awayTeam,
        leagueName: event.tournamentName ?? null
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function isNearCanonicalFixtureWindow(event: BetboomEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.startsAt).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function isMoneylineOdd(odd: BetboomOdd) {
  const market = normalizeForMatching(odd.marketName);
  const group = normalizeForMatching(odd.groupName);
  const shortName = normalizeForMatching(odd.shortName);

  return market === "vencedor" && group === "resultado" && ["1", "x", "2"].includes(shortName);
}

function paForOdd(odd: BetboomOdd): { category: PaCategory; confidence: number; reason: string } {
  const text = normalizeForMatching(`${odd.marketName ?? ""} ${odd.groupName ?? ""} ${odd.name ?? ""}`);
  if (text.includes("pagamento antecipado") || text.includes("early payout") || text.includes("2up") || text.includes("2 up")) {
    return { category: "COM_PA", confidence: 1, reason: "betboom-explicit-early-payout" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "betboom-standard-1x2" };
}

function selectionFromOdd(odd: BetboomOdd): Selection | null {
  const shortName = normalizeForMatching(odd.shortName);
  if (shortName === "1" || odd.side === 1) return "HOME";
  if (shortName === "x" || odd.side === 2) return "DRAW";
  if (shortName === "2" || odd.side === 3) return "AWAY";
  return null;
}

function buildBookmakerLink(bookmaker: BetboomBookmakerConfig, fixtureId: string, event: BetboomEvent, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = eventTeams(event);

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.id,
    fixture_id: fixtureId,
    bookmaker_event_name: [homeTeam, awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: new Date(event.startsAt).toISOString(),
    match_confidence_score: confidenceScore,
    source_url: new URL(`sport/football/${event.categoryId ?? ""}/${event.tournamentId ?? ""}/${event.id}/`, bookmaker.baseUrl).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function compactEventRaw(event: BetboomEvent) {
  return {
    id: event.id,
    startsAt: event.startsAt,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    tournamentId: event.tournamentId,
    categoryId: event.categoryId,
    tournamentName: event.tournamentName
  };
}

function buildMoneylineOdds(bookmaker: BetboomBookmakerConfig, fixtureId: string, event: BetboomEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];
  const eventRaw = compactEventRaw(event);

  for (const odd of event.odds.filter(isMoneylineOdd)) {
    const selection = selectionFromOdd(odd);
    if (!selection || !Number.isFinite(odd.price) || odd.price <= 0) continue;

    const pa = paForOdd(odd);

    rows.push({
      fixture_id: fixtureId,
      bookmaker_slug: bookmaker.slug,
      market_code: "1X2",
      market_name: "MoneyLine",
      selection: selectionForCanonicalOrientation(selection, orientation),
      price: odd.price,
      pa_category: pa.category,
      confidence_score: pa.confidence,
      raw_market_name: odd.groupName ?? odd.marketName,
      raw_label: odd.name ?? odd.shortName,
      raw_odd_type: odd.marketName,
      source_odd_id: Number(odd.id),
      raw: { event: eventRaw, odd, classificationReason: pa.reason },
      updated_at: new Date().toISOString()
    });
  }

  return rows;
}

export function createBetboomCollector(bookmaker: BetboomBookmakerConfig) {
  return async function collectBetboom(options: BookmakerCollectOptions = {}) {
    const client = new BetboomClient(bookmaker);
    const summary = {
      tournamentsSeen: 0,
      tournamentsSelected: 0,
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
      const tournaments = await client.getFootballTournaments();
      summary.tournamentsSeen = tournaments.length;

      const selectedTournaments = selectTournamentsForFixtures(tournaments, fixtures);
      summary.tournamentsSelected = selectedTournaments.length;

      if (!selectedTournaments.length) {
        await log(bookmaker, "warn", "no BetBoom tournaments selected for canonical fixtures", {
          leagues: fixtures.map((fixture) => fixtureLeague(fixture)).filter(Boolean),
          tournamentsSeen: tournaments.length
        });
      }

      const tournamentById = new Map(selectedTournaments.map((tournament) => [tournament.tournamentId, tournament]));
      const events = (await client.getTournamentEvents(selectedTournaments.map((tournament) => tournament.tournamentId))).map((event) => ({
        ...event,
        tournamentName: tournamentById.get(event.tournamentId ?? 0)?.name ?? event.tournamentName
      }));
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: BetboomEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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
      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
        cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "betboom collection failed", { error: serializeError(error) });
    } finally {
      client.close();
    }

    await log(bookmaker, "info", "betboom collection finished", summary);
    return summary;
  };
}

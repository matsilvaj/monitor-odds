import pMap from "p-map";
import type { SegurobetBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { cleanupFixtureIdsForRun } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeForMatching } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { SegurobetClient, type SegurobetEvent, type SegurobetGame, type SegurobetMarket } from "../providers/segurobet.js";
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

async function log(bookmaker: SegurobetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: SegurobetBookmakerConfig) {
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

function eventStartsAt(event: SegurobetGame) {
  const timestamp = Number(event.start_ts);
  return Number.isFinite(timestamp) ? new Date(timestamp * 1000) : new Date("");
}

function eventTeams(event: SegurobetGame) {
  return {
    homeTeam: event.team1_name ?? null,
    awayTeam: event.team2_name ?? null
  };
}

function findBestMatch(event: SegurobetGame, fixtures: CanonicalFixture[]) {
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
        startsAt: eventStartsAt(event),
        homeTeam,
        awayTeam,
        leagueName: event.competitionName ?? null
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function compactSearchTerm(value: string | null | undefined) {
  return normalizeForMatching(value)
    .split(/\s+/)
    .filter((token) => token.length > 2 && !["fc", "cf", "ec", "sc", "ac", "club", "clube", "de", "da", "do"].includes(token))
    .slice(0, 2)
    .join(" ");
}

function searchTermsForFixture(fixture: CanonicalFixture) {
  return [
    compactSearchTerm(fixture.home_team),
    compactSearchTerm(fixture.away_team),
    normalizeForMatching(fixture.home_team),
    normalizeForMatching(fixture.away_team)
  ].filter((term, index, all): term is string => Boolean(term) && all.indexOf(term) === index);
}

function isNearCanonicalFixtureWindow(event: SegurobetGame, fixtures: CanonicalFixture[]) {
  const eventStart = eventStartsAt(event).getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function isMoneylineMarket(market: SegurobetMarket) {
  const text = `${market.name ?? ""} ${market.type ?? ""} ${market.market_type ?? ""}`;
  return market.type === "P1XP2" || market.type === "MatchResultEP" || /resultado\s+final.*pagamento\s+antecipado/i.test(text);
}

function paForMarket(market: SegurobetMarket): { category: PaCategory; confidence: number; reason: string } {
  const text = `${market.name ?? ""} ${market.type ?? ""} ${market.market_type ?? ""}`;

  if (market.has_early_payout === true || market.type === "MatchResultEP" || /pagamento\s+antecipado|early\s+payout/i.test(text)) {
    return { category: "COM_PA", confidence: 0.99, reason: "segurobet-match-result-early-payout" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "segurobet-standard-p1xp2" };
}

function selectionFromEvent(event: SegurobetEvent): Selection | null {
  const type = String(event.type_1 ?? "");
  const name = normalizeForMatching(event.name);

  if (type === "W1") return "HOME";
  if (type === "W2") return "AWAY";
  if (type === "X" || name === "x" || name === "empate") return "DRAW";

  return null;
}

function buildBookmakerLink(bookmaker: SegurobetBookmakerConfig, fixtureId: string, event: SegurobetGame, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = eventTeams(event);
  const regionAlias = event.regionAlias ?? event.region_alias ?? "";
  const competitionId = event.competitionId ?? "";

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.id,
    fixture_id: fixtureId,
    bookmaker_event_name: [homeTeam, awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: eventStartsAt(event).toISOString(),
    match_confidence_score: confidenceScore,
    source_url: new URL(`esportes/match/Soccer/${regionAlias}/${competitionId}/${event.id}`, bookmaker.baseUrl).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function compactEventRaw(event: SegurobetGame) {
  return {
    id: event.id,
    type: event.type,
    team1_name: event.team1_name,
    team2_name: event.team2_name,
    start_ts: event.start_ts,
    region_alias: event.region_alias,
    regionName: event.regionName,
    regionAlias: event.regionAlias,
    competitionName: event.competitionName,
    competitionId: event.competitionId,
    markets_count: event.markets_count,
    is_started: event.is_started,
    is_blocked: event.is_blocked
  };
}

function buildMoneylineOdds(bookmaker: SegurobetBookmakerConfig, fixtureId: string, event: SegurobetGame, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];
  const eventRaw = compactEventRaw(event);

  for (const market of Object.values(event.market ?? {}).filter(isMoneylineMarket)) {
    const pa = paForMarket(market);

    for (const selectionEvent of Object.values(market.event ?? {})) {
      const price = Number(selectionEvent.price);
      if (!Number.isFinite(price) || price <= 0) continue;

      const selection = selectionFromEvent(selectionEvent);
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
        raw_label: selectionEvent.name ?? null,
        raw_odd_type: market.type ?? null,
        source_odd_id: selectionEvent.id,
        raw: { event: eventRaw, market, selectionEvent, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createSegurobetCollector(bookmaker: SegurobetBookmakerConfig) {
  return async function collectSegurobet() {
    const client = new SegurobetClient(bookmaker);
    const summary = {
      searchTerms: 0,
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
      await client.connect();
      const terms = [...new Set(fixtures.flatMap(searchTermsForFixture))];
      summary.searchTerms = terms.length;

      const searchResults = await pMap(
        terms,
        async (term) => {
          try {
            return await client.searchGames(term);
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "segurobet search failed", { term, error: serializeError(error) });
            return [];
          }
        },
        { concurrency: 2 }
      );
      const events = [...new Map(searchResults.flat().map((event) => [event.id, event])).values()];
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: SegurobetGame; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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
      await log(bookmaker, "error", "segurobet collection failed", { error: serializeError(error) });
    } finally {
      client.close();
    }

    await log(bookmaker, "info", "segurobet collection finished", summary);
    return summary;
  };
}

import pMap from "p-map";
import type { BetanoBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { matchingTokens, normalizeForMatching } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { BetanoClient, type BetanoEvent, type BetanoLeague, type BetanoMarket, type BetanoOffer, type BetanoSelection } from "../providers/betano.js";
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

async function log(bookmaker: BetanoBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: BetanoBookmakerConfig) {
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

function leagueName(league: BetanoLeague) {
  return league.name ?? league.text ?? league.nameLatin ?? league.textLatin ?? "";
}

function leagueScore(canonicalName: string, betanoLeague: BetanoLeague) {
  const canonicalCompact = compact(canonicalName);
  const candidateName = leagueName(betanoLeague);
  const candidateCompact = compact(candidateName);

  if (!canonicalCompact || !candidateCompact) return 0;
  if (candidateCompact === canonicalCompact) return 1;
  if (candidateCompact.includes(canonicalCompact) || canonicalCompact.includes(candidateCompact)) {
    const extraLength = Math.abs(candidateCompact.length - canonicalCompact.length);
    return Math.max(0.75, 0.95 - extraLength / 100);
  }

  const canonicalTokens = new Set(matchingTokens(canonicalName).filter((token) => token.length > 3));
  const candidateTokens = new Set(matchingTokens(candidateName).filter((token) => token.length > 3));
  if (!canonicalTokens.size || !candidateTokens.size) return 0;

  let shared = 0;
  for (const token of canonicalTokens) {
    if (candidateTokens.has(token)) shared += 1;
  }

  const overlap = shared / canonicalTokens.size;
  if (overlap === 0) return 0;

  const candidateExtraTokens = Math.max(0, candidateTokens.size - shared);
  return overlap * 0.85 - candidateExtraTokens * 0.04;
}

function flattenLeagues(leagues: BetanoLeague[]) {
  const byUrl = new Map<string, BetanoLeague>();
  for (const league of leagues) {
    if (league.url) byUrl.set(league.url, league);
  }
  return [...byUrl.values()];
}

function selectLeagueUrls(fixtures: CanonicalFixture[], leagues: BetanoLeague[]) {
  const canonicalLeagueNames = [...new Set(fixtures.map((fixture) => fixtureLeague(fixture)?.name).filter(Boolean) as string[])];
  const selected = new Map<string, { league: BetanoLeague; score: number; canonicalName: string }>();

  for (const canonicalName of canonicalLeagueNames) {
    const scored = leagues
      .map((league) => ({ league, score: leagueScore(canonicalName, league), canonicalName }))
      .sort((left, right) => right.score - left.score);

    const strongMatches = scored.filter((item) => item.score >= 0.8);
    for (const item of strongMatches) {
      selected.set(item.league.url, item);
    }

    if (!strongMatches.length && scored[0]?.score >= 0.62) {
      selected.set(scored[0].league.url, scored[0]);
    }
  }

  return [...selected.values()];
}

function eventTeams(event: BetanoEvent) {
  const participants = event.participants ?? [];
  if (participants.length >= 2) {
    return {
      homeTeam: participants[0]?.name ?? null,
      awayTeam: participants[1]?.name ?? null
    };
  }

  const [homeTeam, awayTeam] = String(event.shortName ?? event.name ?? "").split(/\s+-\s+|\s+vs\.?\s+/i);
  return { homeTeam: homeTeam?.trim() || null, awayTeam: awayTeam?.trim() || null };
}

function isNearCanonicalFixtureWindow(event: BetanoEvent, fixtures: CanonicalFixture[]) {
  const eventStart = Number(event.startTime);
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: BetanoEvent, fixtures: CanonicalFixture[]) {
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
        startsAt: Number(event.startTime),
        homeTeam,
        awayTeam,
        leagueName: event.leagueName ?? event.leagueDescription ?? null
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function uniqueMarkets(markets: BetanoMarket[]) {
  return [...new Map(markets.filter((market) => market.id || market.uniqueId).map((market) => [market.id ?? market.uniqueId, market])).values()];
}

function isMoneylineMarket(market: BetanoMarket) {
  const items = market.selections ?? [];
  const codes = new Set(items.map((item) => item.name));
  const has1x2Selections = codes.has("1") && codes.has("X") && codes.has("2");
  const type = String(market.type ?? "");
  const name = String(market.name ?? "");

  return has1x2Selections && (type === "MRES" || type === "MR12" || /resultado\s+final/i.test(name));
}

function offersForMarket(market: BetanoMarket, marketOffers: Record<string, BetanoOffer[]>) {
  const ids = [market.id, market.uniqueId].filter(Boolean) as string[];
  return ids.flatMap((id) => marketOffers[id] ?? []);
}

function paForMarket(market: BetanoMarket, marketOffers: Record<string, BetanoOffer[]>): { category: PaCategory; confidence: number; reason: string } {
  const offers = offersForMarket(market, marketOffers);

  if (offers.some((offer) => offer.offerTypeId === 2 || /2\s*gols\s+de\s+vantagem|pagamento\s+antecipado|early\s+payout/i.test(`${offer.text ?? ""} ${offer.description ?? ""}`))) {
    return { category: "COM_PA", confidence: 0.98, reason: "betano-market-offer-2-goals-advantage" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "betano-standard-or-superodds-without-pa" };
}

function selectionFromBetanoSelection(selection: BetanoSelection): Selection | null {
  if (selection.name === "1") return "HOME";
  if (selection.name === "X") return "DRAW";
  if (selection.name === "2") return "AWAY";
  return null;
}

function buildBookmakerLink(bookmaker: BetanoBookmakerConfig, fixtureId: string, event: BetanoEvent, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = eventTeams(event);

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.id,
    fixture_id: fixtureId,
    bookmaker_event_name: event.name ?? event.shortName ?? [homeTeam, awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: new Date(Number(event.startTime)).toISOString(),
    match_confidence_score: confidenceScore,
    source_url: new URL(event.url ?? `/odds/event/${event.id}/`, bookmaker.baseUrl).href,
    raw: event,
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(
  bookmaker: BetanoBookmakerConfig,
  fixtureId: string,
  event: BetanoEvent,
  markets: BetanoMarket[],
  marketOffers: Record<string, BetanoOffer[]>,
  orientation: EventMatchResult["orientation"]
): OddRow[] {
  const rows: OddRow[] = [];

  for (const market of uniqueMarkets(markets).filter(isMoneylineMarket)) {
    const pa = paForMarket(market, marketOffers);

    for (const selection of market.selections ?? []) {
      if (Number(selection.price) <= 0) continue;

      const normalizedSelection = selectionFromBetanoSelection(selection);
      if (!normalizedSelection) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(normalizedSelection, orientation),
        price: Number(selection.price),
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.name ?? null,
        raw_label: selection.fullName ?? selection.name ?? null,
        raw_odd_type: selection.name ?? String(market.type ?? ""),
        source_odd_id: selection.id,
        raw: { event, market, selection, offers: offersForMarket(market, marketOffers), classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createBetanoCollector(bookmaker: BetanoBookmakerConfig) {
  return async function collectBetano() {
    const client = new BetanoClient(bookmaker);
    const summary = {
      leaguesSeen: 0,
      leaguesSelected: 0,
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
      const footballPage = await client.getFootballPage();
      const leagues = flattenLeagues([
        ...(footballPage.data?.topLeagues ?? []),
        ...(footballPage.data?.dropdownList ?? []).flatMap((region) => region.leagues ?? [])
      ]);
      const selectedLeagues = selectLeagueUrls(fixtures, leagues);
      summary.leaguesSeen = leagues.length;
      summary.leaguesSelected = selectedLeagues.length;

      const leaguePages = await pMap(
        selectedLeagues,
        async ({ league }) => client.getLeaguePage(league.url),
        { concurrency: 2 }
      );

      const events = leaguePages.flatMap((page) => page.data?.blocks?.flatMap((block) => block.events ?? []) ?? []);
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: BetanoEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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

      await pMap(
        [...bestMatchByFixtureId.values()],
        async ({ event, matched }) => {
          try {
            const details = await client.getEventDetails(event);
            const detailEvent = details.data?.event ?? event;
            const markets = [...(details.data?.markets ?? []), ...(detailEvent.markets ?? [])];
            const marketOffers = details.data?.marketOffersData?.marketOffers ?? {};

            linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, detailEvent, matched.score));
            oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, detailEvent, markets, marketOffers, matched.orientation));
            summary.eventsCollected += 1;
            summary.eventsMatched += 1;
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "betano event collection failed", { eventId: event.id, error: serializeError(error) });
          }
        },
        { concurrency: 2 }
      );

      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave);
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "betano collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "betano collection finished", summary);
    return summary;
  };
}

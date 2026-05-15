import pMap from "p-map";
import type { BetmgmBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeForMatching, teamNameSimilarity } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { BetmgmClient, type BetmgmEvent, type BetmgmGroup, type BetmgmMarket, type BetmgmOutcome } from "../providers/betmgm.js";
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
        country: string | null;
      }
    | Array<{
        name: string;
        slug: string;
        api_football_league_id: number;
        country: string | null;
      }>
    | null;
  home_team: string | null;
  away_team: string | null;
  normalized_home_team: string | null;
  normalized_away_team: string | null;
  starts_at: string;
};

type FlatGroup = BetmgmGroup & {
  path: string[];
};

async function log(bookmaker: BetmgmBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: BetmgmBookmakerConfig) {
  const { error } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;
}

async function getCanonicalFixtures() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);

  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,league:leagues(name,slug,api_football_league_id,country),home_team,away_team,normalized_home_team,normalized_away_team,starts_at")
    .gt("starts_at", now.toISOString())
    .lt("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as CanonicalFixture[];
}

function fixtureLeague(fixture: CanonicalFixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function flattenGroups(group: BetmgmGroup, path: string[] = []): FlatGroup[] {
  const currentPath = [...path, group.name];
  return [{ ...group, path: currentPath }, ...(group.groups ?? []).flatMap((child) => flattenGroups(child, currentPath))];
}

function selectFootballGroupIds(groups: BetmgmGroup[]) {
  const football = groups.find((group) => normalizeForMatching(group.name) === "futebol");
  if (!football) return [];

  return flattenGroups(football)
    .filter((group) => !(group.groups ?? []).length && Number(group.eventCount ?? 0) > 0)
    .map((group) => group.id);
}

function chunks<T>(items: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function eventTeams(event: BetmgmEvent) {
  const home = event.participants?.find((participant) => participant.position === "HOME")?.name ?? null;
  const away = event.participants?.find((participant) => participant.position === "AWAY")?.name ?? null;
  if (home || away) return { homeTeam: home, awayTeam: away };

  const [homeTeam, awayTeam] = String(event.name ?? "").split(/\s+-\s+|\s+vs\.?\s+/i);
  return { homeTeam: homeTeam?.trim() || null, awayTeam: awayTeam?.trim() || null };
}

function isNearCanonicalFixtureWindow(event: BetmgmEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.startTime ?? "").getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: BetmgmEvent, fixtures: CanonicalFixture[]) {
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
        startsAt: event.startTime ?? "",
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

function isMoneylineMarket(market: BetmgmMarket) {
  const type = String(market.type ?? "");
  const name = String(market.name ?? "");
  return (type === "standard-3-way" || type === "standard-3-way-early-payout") && /resultado\s+final/i.test(name) && market.betMarketStatus === "OPEN";
}

function metadataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (key in value) return (value as Record<string, unknown>)[key];
  const metadata = "metadata" in value ? (value as Record<string, unknown>).metadata : undefined;
  if (metadata && typeof metadata === "object" && key in metadata) return (metadata as Record<string, unknown>)[key];
  return undefined;
}

function paForMarket(market: BetmgmMarket): { category: PaCategory; confidence: number; reason: string } {
  const earlyPayout = metadataValue(market.metadata, "earlyPayout");
  const marketText = `${market.type ?? ""} ${market.name ?? ""}`;

  if (market.type === "standard-3-way-early-payout" || earlyPayout === true || earlyPayout === "true" || /pagamento\s+antecipado|early\s+payout/i.test(marketText)) {
    return { category: "COM_PA", confidence: 0.99, reason: "betmgm-standard-3-way-early-payout" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "betmgm-standard-3-way" };
}

function selectionFromOutcome(outcome: BetmgmOutcome, homeTeam: string | null, awayTeam: string | null): Selection | null {
  const name = normalizeForMatching(outcome.name);
  if (name === "x" || name === "empate" || name === "draw") return "DRAW";

  const homeScore = homeTeam ? teamNameSimilarity(outcome.name, homeTeam) : 0;
  const awayScore = awayTeam ? teamNameSimilarity(outcome.name, awayTeam) : 0;
  if (Math.max(homeScore, awayScore) < 0.75) return null;

  return homeScore >= awayScore ? "HOME" : "AWAY";
}

function sourceOddId(event: BetmgmEvent, market: BetmgmMarket, outcome: BetmgmOutcome) {
  const digits = String(outcome.id ?? market.id ?? "").replace(/\D/g, "");
  if (digits.length) return Number(digits.slice(0, 15));
  return Number(`${event.id}${Math.abs(String(outcome.name ?? "").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0))}`.slice(0, 15));
}

function buildBookmakerLink(bookmaker: BetmgmBookmakerConfig, fixtureId: string, event: BetmgmEvent, confidenceScore: number): BookmakerLinkRow {
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
    starts_at: new Date(event.startTime ?? "").toISOString(),
    match_confidence_score: confidenceScore,
    source_url: new URL(`aposta-esportiva#/event/${event.id}`, bookmaker.baseUrl).href,
    raw: event,
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: BetmgmBookmakerConfig, fixtureId: string, event: BetmgmEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];
  const { homeTeam, awayTeam } = eventTeams(event);

  for (const market of (event.markets ?? []).filter(isMoneylineMarket)) {
    const pa = paForMarket(market);

    for (const outcome of market.outcomes ?? []) {
      const price = Number(outcome.formatDecimal ?? outcome.odds);
      if (!Number.isFinite(price) || price <= 0) continue;

      const selection = selectionFromOutcome(outcome, homeTeam, awayTeam);
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
        raw_label: outcome.name ?? null,
        raw_odd_type: market.type ?? null,
        source_odd_id: sourceOddId(event, market, outcome),
        raw: { event, market, outcome, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createBetmgmCollector(bookmaker: BetmgmBookmakerConfig) {
  return async function collectBetmgm() {
    const client = new BetmgmClient(bookmaker);
    const summary = {
      groupsSeen: 0,
      groupsSelected: 0,
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
      const groups = await client.getGroups();
      const selectedGroupIds = selectFootballGroupIds(groups);
      summary.groupsSeen = groups.length;
      summary.groupsSelected = selectedGroupIds.length;

      const eventPages = await pMap(
        chunks(selectedGroupIds, 50),
        async (groupIds) => client.getEventsByGroupIds(groupIds),
        { concurrency: 3 }
      );

      const events = [...new Map(eventPages.flat().filter((event) => event.sportType === "FOOTBALL").map((event) => [event.id, event])).values()];
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: BetmgmEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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
        cleanupFixtureIds: fixtures.map((fixture) => fixture.id)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "betmgm collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "betmgm collection finished", summary);
    return summary;
  };
}

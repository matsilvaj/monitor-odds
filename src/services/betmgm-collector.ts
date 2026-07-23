import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { BetmgmBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { findBestCanonicalEventMatchOnline } from "./event-identity-resolver.js";
import { restrictFixturesToRequested } from "./collector-fixture-scope.js";
import { normalizeForMatching, teamNameSimilarity, tokenSetSimilarity } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { BetmgmClient, type BetmgmEvent, type BetmgmGroup, type BetmgmMarket, type BetmgmOutcome } from "../providers/betmgm.js";
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
  logCollectorMessage(bookmaker.slug, level, message, context);
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

function leagueAliases(leagueName: string) {
  const normalized = normalizeForMatching(leagueName);
  const aliases = new Set([normalized]);

  if (/world\s+cup|copa\s+do\s+mundo|mundial/.test(normalized)) {
    aliases.add("mundial");
    aliases.add("copa do mundo");
    aliases.add("world cup");
  }

  if (/brasileir[aã]o?\s+serie\s+b|brasileiro\s+serie\s+b|serie\s+b/.test(normalized)) {
    aliases.add("brasileiro serie b");
    aliases.add("brasileirao serie b");
  }

  if (/la\s+liga\s+2|segunda\s+divis[aã]o|segunda\s+division|hypermotion/.test(normalized)) {
    aliases.add("la liga 2");
    aliases.add("segunda divisao");
    aliases.add("segunda division");
    aliases.add("hypermotion");
  }

  return [...aliases].filter(Boolean);
}

function groupMatchesFixtureLeague(group: FlatGroup, fixture: CanonicalFixture) {
  const league = fixtureLeague(fixture);
  if (!league) return false;

  const groupText = normalizeForMatching(group.path.join(" "));
  return leagueAliases(league.name).some((alias) => {
    const aliasText = normalizeForMatching(alias);
    return Boolean(aliasText) && (groupText.includes(aliasText) || tokenSetSimilarity(aliasText, groupText) >= 0.68);
  });
}

function selectFootballGroupIds(groups: BetmgmGroup[], fixtures: CanonicalFixture[]) {
  const football = groups.find((group) => normalizeForMatching(group.name) === "futebol");
  if (!football) return [];

  const footballGroups = flattenGroups(football).filter((group) => Number(group.eventCount ?? 0) > 0);
  const selected = footballGroups.filter((group) => fixtures.some((fixture) => groupMatchesFixtureLeague(group, fixture))).map((group) => group.id);

  if (selected.length === footballGroups.length) return selected;
  return footballGroups.map((group) => group.id);
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

  const [homeTeam, awayTeam] = String(event.eventName ?? event.name ?? "").split(/\s+-\s+|\s+vs\.?\s+/i);
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

async function findBestMatch(event: BetmgmEvent, fixtures: CanonicalFixture[], bookmakerSlug: string) {
  const { homeTeam, awayTeam } = eventTeams(event);
  return findBestCanonicalEventMatchOnline(
    fixtures.map((fixture) => ({ ...fixture, leagueName: fixtureLeague(fixture)?.name ?? null })),
    {
      id: event.id,
      startsAt: event.startTime ?? "",
      homeTeam,
      awayTeam,
      leagueName: event.leagueName ?? null
    },
    { context: "league-scoped", bookmakerSlug }
  );
}

function isMoneylineMarket(market: BetmgmMarket) {
  const type = String(market.type ?? "");
  const name = normalizeForMatching(market.name);
  const outcomes = market.outcomes ?? [];
  const isThreeWayType = ["standard-3-way", "standard-3-way-early-payout", "overtime-3-way", "match-odds"].includes(type);
  const isMoneylineName = /resultado\s+(final|da partida)|1x2|vencedor|match\s+odds/i.test(name);

  return isThreeWayType && outcomes.length >= 3 && (isMoneylineName || type === "standard-3-way" || type === "standard-3-way-early-payout") && market.betMarketStatus === "OPEN";
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
  if (name === "1" || name === "casa" || name === "home") return "HOME";
  if (name === "2" || name === "fora" || name === "away") return "AWAY";
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
    bookmaker_event_name: event.eventName ?? event.name ?? [homeTeam, awayTeam].filter(Boolean).join(" vs "),
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
  return async function collectBetmgm(options: BookmakerCollectOptions = {}) {
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
    let fixtures = restrictFixturesToRequested(await getCanonicalFixtures(), options.fixtureIds);
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
      const groups = await client.getGroups();
      const selectedGroupIds = selectFootballGroupIds(groups, fixtures);
      summary.groupsSeen = groups.length;
      summary.groupsSelected = selectedGroupIds.length;

      const eventPages = await pMap(
        chunks(selectedGroupIds, 1),
        async (groupIds) => {
          try {
            return await client.getEventsByGroupIds(groupIds);
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "warn", "betmgm group collection failed", { groupIds, error: serializeError(error) });
            return [];
          }
        },
        { concurrency: 4 }
      );

      const events = [...new Map(eventPages.flat().filter((event) => event.sportType === "FOOTBALL").map((event) => [event.id, event])).values()];
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: BetmgmEvent; matched: NonNullable<Awaited<ReturnType<typeof findBestMatch>>> }>();

      for (const event of targetEvents) {
        const matched = await findBestMatch(event, fixtures, bookmaker.slug);
        if (!matched) {
          summary.eventsUnmatched += 1;
          continue;
        }

        const previous = bestMatchByFixtureId.get(matched.fixture.id);
        if (!previous || matched.score > previous.matched.score) {
          bestMatchByFixtureId.set(matched.fixture.id, { event, matched });
        }
      }

      const details = await pMap(
        chunks([...bestMatchByFixtureId.values()].map(({ event }) => event.id), 20),
        async (eventIds) => client.getEventsByIds(eventIds),
        { concurrency: 2 }
      );
      const detailById = new Map(details.flat().map((event) => [event.id, event]));
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      for (const { event, matched } of bestMatchByFixtureId.values()) {
        const detailEvent = detailById.get(event.id) ?? event;
        const detailMatch = await findBestMatch(detailEvent, [matched.fixture], bookmaker.slug);
        const finalMatch = detailMatch ?? matched;

        linksToSave.push(buildBookmakerLink(bookmaker, finalMatch.fixture.id, detailEvent, finalMatch.score));
        oddsToSave.push(...buildMoneylineOdds(bookmaker, finalMatch.fixture.id, detailEvent, finalMatch.orientation));
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
      await log(bookmaker, "error", "betmgm collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "betmgm collection finished", summary);
    return summary;
  };
}

import pMap from "p-map";
import type { BetfairBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { BetfairClient, type BetfairMarket, type BetfairMarketWithContext, type BetfairRunner, type BetfairSearchResult } from "../providers/betfair.js";
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
  home_team: string | null;
  away_team: string | null;
  normalized_home_team: string | null;
  normalized_away_team: string | null;
  starts_at: string;
};

async function log(bookmaker: BetfairBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: BetfairBookmakerConfig) {
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

function eventIdFromUrn(urn: string | undefined) {
  const match = String(urn ?? "").match(/event:(\d+)/);
  return match ? Number(match[1]) : null;
}

function compactSearchName(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/^\d{2,4}\s+/, "")
    .replace(/^(?:vfb|vfl|fc|sc|ec|ac|cf)\s+/i, "")
    .trim();
}

function searchKeywords(fixture: CanonicalFixture) {
  const names = [
    fixture.home_team,
    compactSearchName(fixture.home_team),
    fixture.away_team,
    compactSearchName(fixture.away_team),
    fixture.name
  ];

  return [...new Set(names.map((name) => String(name ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(" ")).filter(Boolean))];
}

function eventTeams(event: BetfairSearchResult) {
  const [homeTeam, awayTeam] = String(event.sportevent?.name ?? "").split(/\s+x\s+/i);
  return { homeTeam: homeTeam?.trim() || null, awayTeam: awayTeam?.trim() || null };
}

function matchSearchResult(fixture: CanonicalFixture, event: BetfairSearchResult) {
  const { homeTeam, awayTeam } = eventTeams(event);
  return matchEvents(
    {
      id: fixture.id,
      startsAt: fixture.starts_at,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team
    },
    {
      id: event.urn,
      startsAt: event.sportevent?.openDate ?? "",
      homeTeam,
      awayTeam,
      leagueName: event.sportevent?.competition?.name ?? null
    }
  );
}

function paForMarket(market: BetfairMarketWithContext): { category: PaCategory; confidence: number; reason: string } {
  const text = `${market.groupTitle ?? ""} ${market.market.name ?? ""}`;
  if (/2\s*gols\s+de\s+vantagem|pagamento\s+antecipado|early\s+payout/i.test(text)) {
    return { category: "COM_PA", confidence: 0.96, reason: "betfair-group-title-2-goals-advantage" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "betfair-standard-match-odds" };
}

function selectionFromRunner(runner: BetfairRunner): Selection | null {
  if (runner.resultType === "HOME") return "HOME";
  if (runner.resultType === "DRAW") return "DRAW";
  if (runner.resultType === "AWAY") return "AWAY";
  return null;
}

function marketId(market: BetfairMarket) {
  return String(market.urn ?? "").replace(/^ppb:sbkMarket:/, "");
}

function sourceOddId(market: BetfairMarket, selectionId: number | undefined) {
  const marketDigits = marketId(market).replace(/\D/g, "");
  const selectionDigits = String(selectionId ?? "").replace(/\D/g, "").padStart(6, "0").slice(-6);
  return Number(`${marketDigits}${selectionDigits}`.slice(0, 18));
}

function buildBookmakerLink(bookmaker: BetfairBookmakerConfig, fixtureId: string, event: BetfairSearchResult, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = eventTeams(event);
  const eventId = eventIdFromUrn(event.urn) ?? event.urn ?? event.sportevent?.name ?? fixtureId;

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: eventId,
    fixture_id: fixtureId,
    bookmaker_event_name: event.sportevent?.name ?? [homeTeam, awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: event.sportevent?.openDate ?? new Date().toISOString(),
    match_confidence_score: confidenceScore,
    source_url: new URL(`apostas/${event.url ?? ""}`, bookmaker.baseUrl).href,
    raw: event,
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(
  bookmaker: BetfairBookmakerConfig,
  fixtureId: string,
  event: BetfairSearchResult,
  markets: BetfairMarketWithContext[],
  orientation: EventMatchResult["orientation"]
): OddRow[] {
  const rows: OddRow[] = [];

  for (const marketWithContext of markets) {
    const market = marketWithContext.market;
    if (market.liveData?.sportsbookMarketStatus !== "OPEN") continue;

    const pa = paForMarket(marketWithContext);
    const liveBySelection = new Map((market.liveData?.runners ?? []).map((runner) => [runner.selectionId, runner]));

    for (const runner of market.runners ?? []) {
      const selection = selectionFromRunner(runner);
      const live = liveBySelection.get(runner.selectionId);
      const price = Number(live?.displayOdds?.decimal ?? live?.odds?.decimal);

      if (!selection || !Number.isFinite(price) || price <= 0 || live?.runnerStatus !== "ACTIVE") continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price,
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: marketWithContext.groupTitle ?? market.name ?? null,
        raw_label: runner.name ?? null,
        raw_odd_type: runner.resultType ?? market.marketType ?? null,
        source_odd_id: sourceOddId(market, runner.selectionId),
        raw: { event, market, runner, live, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createBetfairCollector(bookmaker: BetfairBookmakerConfig) {
  return async function collectBetfair() {
    const client = new BetfairClient(bookmaker);
    const summary = {
      searches: 0,
      eventsSeen: 0,
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
      const bestByFixtureId = new Map<string, { fixture: CanonicalFixture; event: BetfairSearchResult; score: number; orientation: EventMatchResult["orientation"] }>();

      await pMap(
        fixtures,
        async (fixture) => {
          try {
            const results: BetfairSearchResult[] = [];
            for (const keyword of searchKeywords(fixture)) {
              const searchResults = await client.search(keyword);
              summary.searches += 1;
              summary.eventsSeen += searchResults.length;
              results.push(...searchResults);
            }

            for (const event of results) {
              const result = matchSearchResult(fixture, event);
              if (!result.matched) continue;

              const previous = bestByFixtureId.get(fixture.id);
              if (!previous || result.score > previous.score) {
                bestByFixtureId.set(fixture.id, { fixture, event, score: result.score, orientation: result.orientation });
              }
            }
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "betfair search failed", { fixtureId: fixture.id, fixtureName: fixture.name, error: serializeError(error) });
          }
        },
        { concurrency: 2 }
      );

      summary.eventsUnmatched = fixtures.length - bestByFixtureId.size;

      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      await pMap(
        [...bestByFixtureId.values()],
        async ({ fixture, event, score, orientation }) => {
          try {
            const eventId = eventIdFromUrn(event.urn);
            if (!eventId || !event.url) throw new Error(`Invalid Betfair event reference: ${event.urn ?? event.sportevent?.name}`);

            const markets = await client.getMatchOdds(eventId, event.url);
            linksToSave.push(buildBookmakerLink(bookmaker, fixture.id, event, score));
            oddsToSave.push(...buildMoneylineOdds(bookmaker, fixture.id, event, markets, orientation));
            summary.eventsCollected += 1;
            summary.eventsMatched += 1;
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "betfair event collection failed", { eventId: event.urn, error: serializeError(error) });
          }
        },
        { concurrency: 2 }
      );

      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave);
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "betfair collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "betfair collection finished", summary);
    return summary;
  };
}

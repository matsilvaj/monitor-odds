import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { NovibetBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { NovibetClient, type NovibetBetItem, type NovibetEventDetails, type NovibetMarket, type NovibetSearchDocument } from "../providers/novibet.js";
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

async function log(bookmaker: NovibetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: NovibetBookmakerConfig) {
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

function documentTeams(document: NovibetSearchDocument) {
  return {
    homeTeam: document.competitors?.homeTeam?.teamCaption ?? document.additionalCaptions?.competitor1 ?? null,
    awayTeam: document.competitors?.awayTeam?.teamCaption ?? document.additionalCaptions?.competitor2 ?? null
  };
}

function eventTeams(event: NovibetEventDetails) {
  return {
    homeTeam: event.competitors?.homeTeam?.teamCaption ?? event.additionalCaptions?.competitor1 ?? null,
    awayTeam: event.competitors?.awayTeam?.teamCaption ?? event.additionalCaptions?.competitor2 ?? null
  };
}

function matchDocument(fixture: CanonicalFixture, document: NovibetSearchDocument) {
  const { homeTeam, awayTeam } = documentTeams(document);
  return matchEvents(
    {
      id: fixture.id,
      startsAt: fixture.starts_at,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team
    },
    {
      id: document.betContextId,
      startsAt: document.startTimeUTC ?? "",
      homeTeam,
      awayTeam,
      leagueName: document.pathLocations?.map((item) => item.caption).join(" ") ?? null
    }
  );
}

function flattenMarkets(value: unknown): NovibetMarket[] {
  const markets: NovibetMarket[] = [];

  function visit(item: unknown) {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }

    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (typeof record.marketSysname === "string" && Array.isArray(record.betItems)) {
      markets.push(record as NovibetMarket);
    }

    for (const child of Object.values(record)) visit(child);
  }

  visit(value);
  return markets;
}

function isMoneylineMarket(market: NovibetMarket) {
  const items = (market.betItems ?? []).filter(Boolean);
  const codes = new Set(items.map((item) => item?.code));
  const has1x2Selections = codes.has("1") && codes.has("X") && codes.has("2");
  const sysname = market.marketSysname ?? "";

  return has1x2Selections && (
    sysname === "SOCCER_MATCH_RESULT_PRELIVE" ||
    /^SOCCER_MATCH_RESULT(?:_PRELIVE)?(?:_\d+)?_ODDS_KEY$/i.test(sysname)
  );
}

function paForMarket(market: NovibetMarket, paMarketIds: Set<number>): { category: PaCategory; confidence: number; reason: string } {
  if (market.marketId != null && paMarketIds.has(Number(market.marketId))) {
    return { category: "COM_PA", confidence: 0.99, reason: "novibet-market-tag-2-goals-ahead-early-payout" };
  }

  const text = `${market.marketSysname ?? ""} ${market.caption ?? ""} ${market.displayCaption ?? ""}`;

  if (/pagamento\s*antecipado|pague\s*antecipado|early\s*payout/i.test(text)) {
    return { category: "COM_PA", confidence: 0.95, reason: "novibet-explicit-pa-marker" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "novibet-standard-or-enhanced-without-pa" };
}

function selectionFromBetItem(item: NovibetBetItem): Selection | null {
  if (item.code === "1") return "HOME";
  if (item.code === "X") return "DRAW";
  if (item.code === "2") return "AWAY";
  return null;
}

function buildBookmakerLink(bookmaker: NovibetBookmakerConfig, fixtureId: string, event: NovibetEventDetails, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = eventTeams(event);
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.betContextId,
    fixture_id: fixtureId,
    bookmaker_event_name: event.caption ?? [homeTeam, awayTeam].filter(Boolean).join(" - "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: event.startTimeUTC ?? new Date().toISOString(),
    match_confidence_score: confidenceScore,
    source_url: `${bookmaker.baseUrl.replace(/\/$/, "")}/apostas-esportivas/${event.path ?? `matches/event/e${event.betContextId}`}/e${event.betContextId}`,
    raw: {
      betContextId: event.betContextId,
      caption: event.caption,
      path: event.path,
      startTimeUTC: event.startTimeUTC,
      eventSysname: event.eventSysname,
      additionalCaptions: event.additionalCaptions,
      pathLocations: event.pathLocations
    },
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: NovibetBookmakerConfig, fixtureId: string, event: NovibetEventDetails, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];
  const markets = flattenMarkets(event.marketCategories).filter(isMoneylineMarket);
  const paMarketIds = new Set(
    (event.marketTags ?? [])
      .filter((item) => /SOCCER_2_GOALS_AHEAD_EARLY_PAYOUT|EARLY_PAYOUT|PAGAMENTO/i.test(item.tag ?? ""))
      .map((item) => Number(item.marketId))
      .filter(Number.isFinite)
  );

  for (const market of markets) {
    const pa = paForMarket(market, paMarketIds);

    for (const item of market.betItems ?? []) {
      if (!item?.isAvailable || Number(item.price) <= 0) continue;

      const selection = selectionFromBetItem(item);
      if (!selection) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price: Number(item.price),
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.displayCaption ?? market.caption ?? null,
        raw_label: item.caption ?? item.code ?? null,
        raw_odd_type: item.code ?? String(market.marketSysname ?? ""),
        source_odd_id: Number(item.id),
        raw: { market, item, marketTags: event.marketTags ?? [], classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
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

export function createNovibetCollector(bookmaker: NovibetBookmakerConfig) {
  return async function collectNovibet(options: BookmakerCollectOptions = {}) {
    const client = new NovibetClient(bookmaker);
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
    let fixtures = await getCanonicalFixtures();
    if (!fixtures.length) {
      await log(bookmaker, "warn", "no canonical fixtures; run api-football sync first");
      return summary;
    }

    const refreshPlan = await filterFixturesDueForOddsRefresh(bookmaker.slug, fixtures, options);
    applyFixtureRefreshPlan(summary, refreshPlan);
    fixtures = refreshPlan.fixtures;
    if (!fixtures.length) {
      await log(bookmaker, "info", "no fixtures due for odds refresh", {
        fixturesAvailable: refreshPlan.fixturesAvailable,
        skippedFresh: refreshPlan.skippedFresh,
        skippedStarted: refreshPlan.skippedStarted
      });
      return summary;
    }

    try {
      const bestByFixtureId = new Map<string, { fixture: CanonicalFixture; document: NovibetSearchDocument; score: number; orientation: EventMatchResult["orientation"] }>();

      await pMap(
        fixtures,
        async (fixture) => {
          try {
            for (const keyword of searchKeywords(fixture)) {
              const documents = await client.searchDocuments(keyword);
              summary.searches += 1;
              summary.eventsSeen += documents.length;

              for (const document of documents.filter((item) => !item.isLive)) {
                const result = matchDocument(fixture, document);
                if (!result.matched) continue;

                const previous = bestByFixtureId.get(fixture.id);
                if (!previous || result.score > previous.score) {
                  bestByFixtureId.set(fixture.id, { fixture, document, score: result.score, orientation: result.orientation });
                }
              }

              if (bestByFixtureId.has(fixture.id)) break;
            }
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "novibet search failed", { fixtureId: fixture.id, fixtureName: fixture.name, error: serializeError(error) });
          }
        },
        { concurrency: 2 }
      );

      summary.eventsUnmatched = fixtures.length - bestByFixtureId.size;

      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      await pMap(
        [...bestByFixtureId.values()],
        async ({ fixture, document, score, orientation }) => {
          try {
            const event = await client.getEventDetails(document.betContextId, document.path);
            linksToSave.push(buildBookmakerLink(bookmaker, fixture.id, event, score));
            oddsToSave.push(...buildMoneylineOdds(bookmaker, fixture.id, event, orientation));
            summary.eventsCollected += 1;
            summary.eventsMatched += 1;
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "novibet event collection failed", { eventId: document.betContextId, error: serializeError(error) });
          }
        },
        { concurrency: 2 }
      );

      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
        cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "novibet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "novibet collection finished", summary);
    return summary;
  };
}

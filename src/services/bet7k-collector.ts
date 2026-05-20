import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { Bet7kBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeForMatching, teamNameSimilarity } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { Bet7kClient, type Bet7kEvent, type Bet7kMarket, type Bet7kSelection } from "../providers/bet7k.js";
import { errorMessage } from "../utils/errors.js";
import { logCollectorMessage } from "./collector-log.js";
import { getSavedBookmakerEventLinks, objectRaw, type SavedBookmakerEventLink } from "./saved-bookmaker-events.js";

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

async function log(bookmaker: Bet7kBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  logCollectorMessage(bookmaker.slug, level, message, context);
}

async function ensureBaseRows(bookmaker: Bet7kBookmakerConfig) {
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

function eventTeams(event: Bet7kEvent) {
  const home = event.Participants?.find((participant) => participant.VenueRole === "Home")?.Name ?? null;
  const away = event.Participants?.find((participant) => participant.VenueRole === "Away")?.Name ?? null;
  if (home || away) return { homeTeam: home, awayTeam: away };

  const [homeTeam, awayTeam] = String(event.EventName ?? event.BetslipLine ?? "").split(/\s+-\s+|\s+vs\.?\s+/i);
  return { homeTeam: homeTeam?.trim() || null, awayTeam: awayTeam?.trim() || null };
}

function isNearCanonicalFixtureWindow(event: Bet7kEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.StartEventDate ?? "").getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: Bet7kEvent, fixtures: CanonicalFixture[]) {
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
        id: event._id,
        startsAt: event.StartEventDate ?? "",
        homeTeam,
        awayTeam,
        leagueName: event.LeagueName ?? null
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function isMoneylineMarket(market: Bet7kMarket) {
  const type = market.MarketType?._id;
  const typeName = normalizeForMatching(market.MarketType?.LineTypeName);
  const name = normalizeForMatching(market.Name ?? market.MarketType?.Name);

  const isStandardMoneyline = type === "ML0" && typeName === "1x2" && name.includes("resultado final");
  const isSuperOddsMoneyline = type === "ML5000" && (typeName.includes("super odds") || name.includes("super odds"));

  return (isStandardMoneyline || isSuperOddsMoneyline) && market.IsLive !== true && market.IsRemoved !== true && market.IsSuspended !== true;
}

function paForMarket(market: Bet7kMarket): { category: PaCategory; confidence: number; reason: string } {
  const type = market.MarketType?._id;
  const text = normalizeForMatching([market.Name, market.MarketType?.Name, market.MarketType?.LineTypeName].filter(Boolean).join(" "));
  const raw = Array.isArray(market.raw) ? market.raw : [];
  const earlyPayoutMarker = Number(raw[29]);

  if (type === "ML5000" || text.includes("super odds")) {
    return { category: "SEM_PA", confidence: 1, reason: "bet7k-super-odds" };
  }

  if (text.includes("pagamento antecipado") || text.includes("early payout") || text.includes("2up") || text.includes("2 up")) {
    return { category: "COM_PA", confidence: 1, reason: "bet7k-explicit-early-payout-market" };
  }

  if (type === "ML0" && Number.isFinite(earlyPayoutMarker) && earlyPayoutMarker > 0) {
    return { category: "COM_PA", confidence: 0.95, reason: "bet7k-market-early-payout-marker" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "bet7k-standard-1x2" };
}

function selectionFromSelection(selection: Bet7kSelection, homeTeam: string | null, awayTeam: string | null): Selection | null {
  if (selection.Side === 1 || normalizeForMatching(selection.OutcomeType) === "casa") return "HOME";
  if (selection.Side === 2 || normalizeForMatching(selection.OutcomeType) === "empate") return "DRAW";
  if (selection.Side === 3 || normalizeForMatching(selection.OutcomeType) === "fora") return "AWAY";

  const name = normalizeForMatching(selection.Name);
  if (name === "x" || name === "empate" || name === "draw") return "DRAW";

  const homeScore = homeTeam ? teamNameSimilarity(selection.Name, homeTeam) : 0;
  const awayScore = awayTeam ? teamNameSimilarity(selection.Name, awayTeam) : 0;
  if (Math.max(homeScore, awayScore) < 0.75) return null;

  return homeScore >= awayScore ? "HOME" : "AWAY";
}

function numericId(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return Number(digits.slice(-15));
}

function compactEventRaw(event: Bet7kEvent) {
  const { Participants, Settings, ...raw } = event;
  return { ...raw, Participants, Settings };
}

function buildBookmakerLink(bookmaker: Bet7kBookmakerConfig, fixtureId: string, event: Bet7kEvent, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = eventTeams(event);
  const collectionUrl = new URL(`esportes/evento/${event.UrlEventName ?? event._id}`, bookmaker.baseUrl).href;

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: numericId(event._id),
    fixture_id: fixtureId,
    bookmaker_event_name: event.EventName ?? event.BetslipLine ?? [homeTeam, awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: new Date(event.StartEventDate ?? "").toISOString(),
    match_confidence_score: confidenceScore,
    source_url: null,
    raw: { ...compactEventRaw(event), collectionUrl, publicUrl: null },
    updated_at: new Date().toISOString()
  };
}

function eventFromSavedLink(link: SavedBookmakerEventLink): Bet7kEvent | null {
  const raw = objectRaw(link.raw);
  const eventId = raw._id ?? raw.id;
  if (eventId == null) return null;

  return {
    ...(raw as Bet7kEvent),
    _id: String(eventId)
  };
}

function buildMoneylineOdds(
  bookmaker: Bet7kBookmakerConfig,
  fixtureId: string,
  event: Bet7kEvent,
  markets: Bet7kMarket[],
  orientation: EventMatchResult["orientation"]
): OddRow[] {
  const rows: OddRow[] = [];
  const { homeTeam, awayTeam } = eventTeams(event);

  for (const market of markets.filter(isMoneylineMarket)) {
    const pa = paForMarket(market);

    for (const selectionItem of market.Selections ?? []) {
      const price = Number(selectionItem.DisplayOdds?.Decimal);
      if (!Number.isFinite(price) || price <= 0 || selectionItem.IsDisabled === true) continue;

      const selection = selectionFromSelection(selectionItem, homeTeam, awayTeam);
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
        raw_market_name: market.Name ?? market.MarketType?.Name ?? null,
        raw_label: selectionItem.Name ?? null,
        raw_odd_type: selectionItem.OutcomeType ?? String(selectionItem.Side ?? ""),
        source_odd_id: numericId(selectionItem._id),
        raw: { event: compactEventRaw(event), market, selection: selectionItem, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createBet7kCollector(bookmaker: Bet7kBookmakerConfig) {
  return async function collectBet7k(options: BookmakerCollectOptions = {}) {
    const client = new Bet7kClient(bookmaker);
    const summary = {
      eventsSeen: 0,
      eventsInWindow: 0,
      eventsCollected: 0,
      eventsMatched: 0,
      eventsUnmatched: 0,
      eventDetailsFetched: 0,
      eventDetailsFailed: 0,
      eventsCollectedDirect: 0,
      eventsCollectedByDiscovery: 0,
      directEventsFailed: 0,
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
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];
      const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
      const savedLinks = await getSavedBookmakerEventLinks(
        bookmaker.slug,
        fixtures.map((fixture) => fixture.id)
      );
      const collectedFixtureIds = new Set<string>();

      await pMap(
        [...savedLinks.values()],
        async (link) => {
          const fixture = fixturesById.get(link.fixture_id);
          const savedEvent = eventFromSavedLink(link);
          if (!fixture || !savedEvent) return;

          try {
            const matched = findBestMatch(savedEvent, [fixture]);
            if (!matched) {
              summary.directEventsFailed += 1;
              await log(bookmaker, "warn", "saved event link did not match canonical fixture; falling back to discovery", {
                fixtureId: fixture.id,
                eventId: savedEvent._id
              });
              return;
            }

            const markets = await client.getEventPageMarkets(savedEvent);
            const odds = buildMoneylineOdds(bookmaker, matched.fixture.id, savedEvent, markets, matched.orientation);
            if (!odds.length) throw new Error(`saved event has no 1X2 odds: ${savedEvent._id}`);

            linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, savedEvent, matched.score));
            oddsToSave.push(...odds);
            collectedFixtureIds.add(fixture.id);
            summary.eventsCollected += 1;
            summary.eventsMatched += 1;
            summary.eventsCollectedDirect += 1;
          } catch (error) {
            summary.directEventsFailed += 1;
            await log(bookmaker, "warn", "saved event direct collection failed; falling back to discovery", {
              fixtureId: fixture.id,
              eventId: savedEvent._id,
              error: serializeError(error)
            });
          }
        },
        { concurrency: 3 }
      );

      const discoveryFixtures = fixtures.filter((fixture) => !collectedFixtureIds.has(fixture.id));
      if (!discoveryFixtures.length) {
        summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
          cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
        });
        await log(bookmaker, "info", "bet7k collection finished", summary);
        return summary;
      }

      const events = await client.getPrematchEvents();
      const footballEvents = events.filter((event) => event.SportId === "1" && event.IsLive !== true);
      summary.eventsSeen = footballEvents.length;

      const targetEvents = footballEvents.filter((event) => isNearCanonicalFixtureWindow(event, discoveryFixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: Bet7kEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

      for (const event of targetEvents) {
        const matched = findBestMatch(event, discoveryFixtures);
        if (!matched) {
          summary.eventsUnmatched += 1;
          continue;
        }

        const previous = bestMatchByFixtureId.get(matched.fixture.id);
        if (!previous || matched.score > previous.matched.score) {
          bestMatchByFixtureId.set(matched.fixture.id, { event, matched });
        }
      }

      const matchedItems = Array.from(bestMatchByFixtureId.values());
      const detailEntries = await pMap(
        matchedItems,
        async ({ event }): Promise<readonly [string, Bet7kMarket[]]> => {
          try {
            return [event._id, await client.getEventPageMarkets(event)] as const;
          } catch (error) {
            summary.eventDetailsFailed += 1;
            await log(bookmaker, "warn", "bet7k event page failed; using featured markets fallback", {
              eventId: event._id,
              eventName: event.EventName,
              error: errorMessage(error)
            });
            return [event._id, [] as Bet7kMarket[]] as const;
          }
        },
        { concurrency: 3 }
      );
      const detailMarketsByEventId = new Map(detailEntries);
      summary.eventDetailsFetched = detailEntries.length;

      for (const { event, matched } of matchedItems) {
        const detailMarkets = detailMarketsByEventId.get(event._id) ?? [];

        linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, event, matched.score));
        oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, event, detailMarkets, matched.orientation));
        summary.eventsCollected += 1;
        summary.eventsMatched += 1;
        summary.eventsCollectedByDiscovery += 1;
      }

      summary.eventsUnmatched += discoveryFixtures.length - bestMatchByFixtureId.size;
      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
        cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "bet7k collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "bet7k collection finished", summary);
    return summary;
  };
}

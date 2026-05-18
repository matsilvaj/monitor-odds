import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { KtoBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeForMatching, teamNameSimilarity } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { KtoClient, type KtoBetOffer, type KtoEvent, type KtoListEvent, type KtoOutcome } from "../providers/kto.js";
import { errorMessage } from "../utils/errors.js";
import { getSavedBookmakerEventLinks, objectRaw } from "./saved-bookmaker-events.js";

const STANDARD_RESULT_CRITERION_ID = 1001159858;
const EARLY_PAYOUT_RESULT_CRITERION_ID = 2100089307;

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

async function log(bookmaker: KtoBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: KtoBookmakerConfig) {
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

function collectionWindow(fixtures: CanonicalFixture[]) {
  const times = fixtures.map((fixture) => new Date(fixture.starts_at).getTime()).filter(Number.isFinite);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const now = Date.now();

  return {
    start: new Date(Math.min(now, minTime - 60 * 60 * 1000)),
    end: new Date(maxTime + 60 * 60 * 1000)
  };
}

function eventFromListItem(item: KtoListEvent) {
  return item.event ?? null;
}

function isNearCanonicalFixtureWindow(event: KtoEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.start ?? "").getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: KtoEvent, fixtures: CanonicalFixture[]) {
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
        startsAt: event.start ?? "",
        homeTeam: event.homeName ?? null,
        awayTeam: event.awayName ?? null,
        leagueName: event.group ?? null
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function isMoneylineOffer(offer: KtoBetOffer) {
  const criterionId = offer.criterion?.id;
  const text = normalizeForMatching(`${offer.criterion?.label ?? ""} ${offer.criterion?.englishLabel ?? ""}`);

  return (
    offer.betOfferType?.id === 2 &&
    (criterionId === STANDARD_RESULT_CRITERION_ID ||
      criterionId === EARLY_PAYOUT_RESULT_CRITERION_ID ||
      text === "resultado final full time" ||
      /resultado final com ganho antecipado|full time 2up/.test(text)) &&
    offer.outcomes?.length === 3
  );
}

function paForOffer(offer: KtoBetOffer): { category: PaCategory; confidence: number; reason: string } {
  const text = `${offer.criterion?.label ?? ""} ${offer.criterion?.englishLabel ?? ""}`;
  if (offer.criterion?.id === EARLY_PAYOUT_RESULT_CRITERION_ID || /ganho\s+antecipado|full\s*time\s*-\s*2up|2up/i.test(text)) {
    return { category: "COM_PA", confidence: 0.99, reason: "kto-full-time-2up" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "kto-standard-full-time" };
}

function selectionFromOutcome(outcome: KtoOutcome, event: KtoEvent): Selection | null {
  if (outcome.type === "OT_ONE" || outcome.label === "1") return "HOME";
  if (outcome.type === "OT_CROSS" || outcome.label === "X") return "DRAW";
  if (outcome.type === "OT_TWO" || outcome.label === "2") return "AWAY";

  const name = normalizeForMatching(outcome.participant ?? outcome.label);
  if (name === "x" || name === "empate" || name === "draw") return "DRAW";

  const homeScore = event.homeName ? teamNameSimilarity(outcome.participant ?? outcome.label, event.homeName) : 0;
  const awayScore = event.awayName ? teamNameSimilarity(outcome.participant ?? outcome.label, event.awayName) : 0;
  if (Math.max(homeScore, awayScore) < 0.75) return null;

  return homeScore >= awayScore ? "HOME" : "AWAY";
}

function priceFromKambiOdds(value: number | undefined) {
  if (!Number.isFinite(Number(value))) return NaN;
  return Number(value) / 1000;
}

function compactEventRaw(event: KtoEvent) {
  return {
    id: event.id,
    name: event.name,
    englishName: event.englishName,
    homeName: event.homeName,
    awayName: event.awayName,
    start: event.start,
    group: event.group,
    groupId: event.groupId,
    path: event.path,
    sport: event.sport,
    state: event.state,
    tags: event.tags
  };
}

function eventFromSavedLink(raw: Record<string, unknown>, externalEventId: string | number): KtoEvent | null {
  const id = Number(raw.id ?? externalEventId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { ...(raw as KtoEvent), id };
}

function buildBookmakerLink(bookmaker: KtoBookmakerConfig, fixtureId: string, event: KtoEvent, confidenceScore: number): BookmakerLinkRow {
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.id,
    fixture_id: fixtureId,
    bookmaker_event_name: event.name ?? [event.homeName, event.awayName].filter(Boolean).join(" - "),
    bookmaker_home_team: event.homeName ?? null,
    bookmaker_away_team: event.awayName ?? null,
    normalized_bookmaker_home_team: normalizeName(event.homeName),
    normalized_bookmaker_away_team: normalizeName(event.awayName),
    starts_at: new Date(event.start ?? "").toISOString(),
    match_confidence_score: confidenceScore,
    source_url: new URL(`esportes/futebol/${event.groupId ?? "evento"}/${event.id}`, bookmaker.baseUrl).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: KtoBookmakerConfig, fixtureId: string, event: KtoEvent, offers: KtoBetOffer[], orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];

  for (const offer of offers.filter(isMoneylineOffer)) {
    const pa = paForOffer(offer);

    for (const outcome of offer.outcomes ?? []) {
      const price = priceFromKambiOdds(outcome.odds);
      if (!Number.isFinite(price) || price <= 0 || outcome.status !== "OPEN") continue;

      const selection = selectionFromOutcome(outcome, event);
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
        raw_market_name: offer.criterion?.label ?? null,
        raw_label: outcome.participant ?? outcome.label ?? null,
        raw_odd_type: outcome.type ?? outcome.label ?? null,
        source_odd_id: outcome.id,
        raw: { event: compactEventRaw(event), offer, outcome, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createKtoCollector(bookmaker: KtoBookmakerConfig) {
  return async function collectKto(options: BookmakerCollectOptions = {}) {
    const client = new KtoClient(bookmaker);
    const summary = {
      eventsSeen: 0,
      eventsInWindow: 0,
      eventDetailsFetched: 0,
      eventsCollected: 0,
      eventsMatched: 0,
      eventsUnmatched: 0,
      oddsUpserted: 0,
      eventsCollectedDirect: 0,
      eventsCollectedByDiscovery: 0,
      directEventsFailed: 0,
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
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];
      const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
      const savedLinks = await getSavedBookmakerEventLinks(bookmaker.slug, fixtures.map((fixture) => fixture.id));
      const collectedFixtureIds = new Set<string>();

      await pMap(
        [...savedLinks.values()],
        async (link) => {
          const fixture = fixturesById.get(link.fixture_id);
          const savedEvent = eventFromSavedLink(objectRaw(link.raw), link.external_event_id);
          if (!fixture || !savedEvent) return;

          try {
            const detailPage = await client.getEventBetOffers([savedEvent.id]);
            const detailEvent = detailPage.events.find((event) => event.id === savedEvent.id) ?? savedEvent;
            const matched = findBestMatch(detailEvent, [fixture]);
            if (!matched) throw new Error(`saved event no longer matches fixture ${fixture.name}`);

            const offers = detailPage.betOffers.filter((offer) => offer.eventId === savedEvent.id);
            const odds = buildMoneylineOdds(bookmaker, matched.fixture.id, detailEvent, offers, matched.orientation);
            if (!odds.length) throw new Error(`saved event has no 1X2 odds: ${savedEvent.id}`);

            linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, detailEvent, matched.score));
            oddsToSave.push(...odds);
            collectedFixtureIds.add(matched.fixture.id);
            summary.eventsCollected += 1;
            summary.eventsMatched += 1;
            summary.eventsCollectedDirect += 1;
            summary.eventDetailsFetched += 1;
          } catch (error) {
            summary.directEventsFailed += 1;
            await log(bookmaker, "warn", "kto saved event direct refresh failed; falling back to discovery", {
              fixtureId: fixture.id,
              eventId: savedEvent.id,
              error: serializeError(error)
            });
          }
        },
        { concurrency: 4 }
      );

      const discoveryFixtures = fixtures.filter((fixture) => !collectedFixtureIds.has(fixture.id));
      if (!discoveryFixtures.length) {
        summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
          cleanupFixtureIds: cleanupFixtureIdsForRun(fixtures, linksToSave, summary.errors)
        });
        await log(bookmaker, "info", "kto collection finished", summary);
        return summary;
      }

      const { start, end } = collectionWindow(discoveryFixtures);
      const listItems = await client.getFootballStartingWithin(start, end);
      const events = [
        ...new Map(
          listItems
            .map(eventFromListItem)
            .filter((event): event is KtoEvent => Boolean(event?.id))
            .filter((event) => event.sport === "FOOTBALL")
            .map((event) => [event.id, event])
        ).values()
      ];
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => event.state === "NOT_STARTED" && isNearCanonicalFixtureWindow(event, discoveryFixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: KtoEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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

      const eventIds = [...bestMatchByFixtureId.values()].map(({ event }) => event.id);
      const detailBatchSize = 4;
      const detailPages = await pMap(
        Array.from({ length: Math.ceil(eventIds.length / detailBatchSize) }, (_, index) =>
          eventIds.slice(index * detailBatchSize, index * detailBatchSize + detailBatchSize)
        ),
        (chunk) => client.getEventBetOffers(chunk),
        { concurrency: 2 }
      );
      summary.eventDetailsFetched += eventIds.length;

      const detailEvents = new Map(detailPages.flatMap((page) => page.events).map((event) => [event.id, event]));
      const offersByEventId = new Map<number, KtoBetOffer[]>();
      for (const offer of detailPages.flatMap((page) => page.betOffers)) {
        if (!offer.eventId) continue;
        offersByEventId.set(offer.eventId, [...(offersByEventId.get(offer.eventId) ?? []), offer]);
      }

      for (const { event, matched } of bestMatchByFixtureId.values()) {
        const detailEvent = detailEvents.get(event.id) ?? event;
        linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, detailEvent, matched.score));
        oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, detailEvent, offersByEventId.get(event.id) ?? [], matched.orientation));
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
      await log(bookmaker, "error", "kto collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "kto collection finished", summary);
    return summary;
  };
}

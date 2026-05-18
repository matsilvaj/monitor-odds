import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import pMap from "p-map";
import type { ApostabetBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { applyFixtureRefreshPlan, cleanupFixtureIdsForRun, filterFixturesDueForOddsRefresh } from "./collector-resilience.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeForMatching, teamNameSimilarity, tokenSetSimilarity } from "../domain/matching/text-similarity.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { ApostabetClient, type ApostabetCategory, type ApostabetEvent, type ApostabetMarket, type ApostabetOutcome, type ApostabetTournament } from "../providers/apostabet.js";
import { errorMessage } from "../utils/errors.js";
import { getSavedBookmakerEventLinks, objectRaw } from "./saved-bookmaker-events.js";

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

type FlatTournament = Omit<ApostabetTournament, "categoryName" | "countryCode"> & {
  tournamentId: string;
  categoryName: string | null;
  countryCode: string | null;
  path: string[];
};

async function log(bookmaker: ApostabetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: ApostabetBookmakerConfig) {
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

function flattenTournaments(categories: ApostabetCategory[]) {
  return categories.flatMap((category): FlatTournament[] =>
    (category.tournaments ?? []).map((tournament) => ({
      ...tournament,
      categoryName: category.categoryName ?? tournament.categoryName ?? null,
      countryCode: category.countryCode ?? tournament.countryCode ?? null,
      path: [category.categoryName, tournament.tournamentName, tournament.seasonName].filter(Boolean).map(String)
    }))
  );
}

function compact(value: unknown) {
  return normalizeForMatching(value).replace(/\s+/g, "");
}

function translatedCountryTokens(country: string | null | undefined) {
  const normalized = normalizeForMatching(country);
  const aliases: Record<string, string[]> = {
    brazil: ["brasil", "bra"],
    germany: ["alemanha", "deu", "ger"],
    spain: ["espanha", "esp"],
    england: ["inglaterra", "eng"],
    italy: ["italia", "ita"],
    france: ["franca", "fra"],
    usa: ["estados unidos", "eua", "usa", "united states"],
    "united states": ["estados unidos", "eua", "usa", "united states"],
    world: ["clubes internacionais", "internacionais", "internacional"]
  };

  return aliases[normalized] ?? [normalized];
}

function searchKeywords(fixture: CanonicalFixture) {
  return [...new Set([fixture.home_team, fixture.away_team, fixture.normalized_home_team, fixture.normalized_away_team].filter(Boolean).map(String))];
}

function countryScore(country: string | null | undefined, tournament: FlatTournament) {
  const aliases = translatedCountryTokens(country);
  if (!aliases.length || !aliases[0]) return 0.5;

  const path = normalizeForMatching([tournament.countryCode, tournament.categoryName, ...tournament.path].join(" "));
  if (aliases.some((alias) => path.includes(normalizeForMatching(alias)))) return 1;
  if (normalizeForMatching(country) === "world" && path.includes("clubes internacionais")) return 1;

  return Math.max(...aliases.map((alias) => tokenSetSimilarity(alias, path)));
}

function leagueScore(leagueName: string, tournament: FlatTournament) {
  const candidates = [tournament.tournamentName, tournament.seasonName, tournament.path.join(" ")].filter(Boolean).map(String);
  const leagueCompact = compact(leagueName);
  const exactScore = candidates.some((candidate) => {
    const candidateCompact = compact(candidate);
    return candidateCompact && leagueCompact && (candidateCompact === leagueCompact || candidateCompact.includes(leagueCompact) || leagueCompact.includes(candidateCompact));
  });

  if (exactScore) return 1;
  return Math.max(...candidates.map((candidate) => tokenSetSimilarity(leagueName, candidate)), 0);
}

function selectTournaments(fixtures: CanonicalFixture[], categories: ApostabetCategory[]) {
  const tournaments = flattenTournaments(categories).filter((tournament) => tournament.tournamentId);
  const leagues = [
    ...new Map(
      fixtures
        .map((fixture) => fixtureLeague(fixture))
        .filter((league): league is NonNullable<ReturnType<typeof fixtureLeague>> => Boolean(league))
        .map((league) => [league.api_football_league_id, league])
    ).values()
  ];

  const selected = new Map<string, { tournament: FlatTournament; score: number; leagueName: string }>();

  for (const league of leagues) {
    const scored = tournaments
      .map((tournament) => {
        const country = countryScore(league.country, tournament);
        const leagueNameScore = leagueScore(league.name, tournament);
        return { tournament, score: leagueNameScore * 0.78 + country * 0.22, leagueName: league.name, leagueNameScore, country };
      })
      .filter((item) => item.leagueNameScore >= 0.72 && item.country >= 0.65)
      .sort((left, right) => right.score - left.score);

    for (const item of scored.slice(0, 3)) {
      selected.set(item.tournament.tournamentId, item);
    }
  }

  return [...selected.values()];
}

function eventTeams(event: ApostabetEvent) {
  if (event.homeCompetitorName || event.awayCompetitorName) {
    return { homeTeam: event.homeCompetitorName ?? null, awayTeam: event.awayCompetitorName ?? null };
  }

  const [homeTeam, awayTeam] = String(event.name ?? "").split(/\s+vs\.?\s+|\s+x\s+/i);
  return { homeTeam: homeTeam?.trim() || null, awayTeam: awayTeam?.trim() || null };
}

function isNearCanonicalFixtureWindow(event: ApostabetEvent, fixtures: CanonicalFixture[]) {
  const eventStart = new Date(event.scheduleTime ?? "").getTime();
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) <= 20 * 60 * 1000;
  });
}

function findBestMatch(event: ApostabetEvent, fixtures: CanonicalFixture[]) {
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
        startsAt: event.scheduleTime ?? "",
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

function isMoneylineMarket(market: ApostabetMarket) {
  return market.smarketId === 1 && market.status === 1 && !market.isMarketCancel && !market.inPlay;
}

function paForEvent(event: ApostabetEvent, earlyPayoutTournamentIds: Set<string>): { category: PaCategory; confidence: number; reason: string } {
  if (event.isEarlyPayout === true) {
    return { category: "COM_PA", confidence: 0.96, reason: "apostabet-event-early-payout" };
  }

  if (event.tournamentId && earlyPayoutTournamentIds.has(event.tournamentId)) {
    return { category: "COM_PA", confidence: 0.96, reason: "apostabet-early-payout-tournament" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "apostabet-standard-1x2" };
}

function selectionFromOutcome(outcome: ApostabetOutcome, homeTeam: string | null, awayTeam: string | null): Selection | null {
  if (outcome.outcomeId === "1") return "HOME";
  if (outcome.outcomeId === "2") return "DRAW";
  if (outcome.outcomeId === "3") return "AWAY";

  const name = normalizeForMatching(outcome.name);
  if (name === "x" || name === "empate" || name === "draw") return "DRAW";

  const homeScore = homeTeam ? teamNameSimilarity(outcome.name, homeTeam) : 0;
  const awayScore = awayTeam ? teamNameSimilarity(outcome.name, awayTeam) : 0;
  if (Math.max(homeScore, awayScore) < 0.75) return null;

  return homeScore >= awayScore ? "HOME" : "AWAY";
}

function compactEventRaw(event: ApostabetEvent) {
  const { sportMarketDetails: _sportMarketDetails, ...raw } = event;
  return raw;
}

function numericId(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return Number(digits.slice(0, 15));
}

async function searchMissingEvents(
  client: ApostabetClient,
  fixtures: CanonicalFixture[],
  alreadyMatchedFixtureIds: Set<string>,
  onError: (message: string, context: Record<string, unknown>) => Promise<void>
) {
  const eventsById = new Map<string, ApostabetEvent>();
  const missingFixtures = fixtures.filter((fixture) => !alreadyMatchedFixtureIds.has(fixture.id));

  await pMap(
    missingFixtures,
    async (fixture) => {
      const seenSearchEventIds = new Set<string>();

      for (const keyword of searchKeywords(fixture)) {
        let searchResults;
        try {
          searchResults = await client.searchEvents(keyword);
        } catch (error) {
          await onError("apostabet event search failed", {
            fixtureId: fixture.id,
            keyword,
            error: serializeError(error)
          });
          continue;
        }

        for (const searchEvent of searchResults) {
          if (!searchEvent.matchId || seenSearchEventIds.has(searchEvent.matchId) || searchEvent.status !== 0) continue;
          seenSearchEventIds.add(searchEvent.matchId);

          const candidate: ApostabetEvent = {
            id: searchEvent.matchId,
            tournamentId: searchEvent.tournamentId,
            tournamentName: searchEvent.tournamentName,
            seasonName: searchEvent.seasonName ?? null,
            sportId: searchEvent.sportId,
            producerId: searchEvent.producerId,
            name: searchEvent.matchName,
            scheduleTime: searchEvent.scheduleTime,
            status: searchEvent.status
          };

          const matched = findBestMatch(candidate, [fixture]);
          if (!matched) continue;

          let detailEvent;
          try {
            detailEvent = await client.getEventWithPrincipalMarkets(searchEvent.matchId);
          } catch (error) {
            await onError("apostabet event detail collection failed", {
              fixtureId: fixture.id,
              eventId: searchEvent.matchId,
              keyword,
              error: serializeError(error)
            });
            continue;
          }

          eventsById.set(detailEvent.id, detailEvent);
          return;
        }
      }
    },
    { concurrency: 3 }
  );

  return [...eventsById.values()];
}

function buildBookmakerLink(bookmaker: ApostabetBookmakerConfig, fixtureId: string, event: ApostabetEvent, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = eventTeams(event);

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: numericId(event.id),
    fixture_id: fixtureId,
    bookmaker_event_name: event.name ?? [homeTeam, awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: new Date(event.scheduleTime ?? "").toISOString(),
    match_confidence_score: confidenceScore,
    source_url: new URL(`esportes/evento/${event.id}`, bookmaker.baseUrl).href,
    raw: compactEventRaw(event),
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(
  bookmaker: ApostabetBookmakerConfig,
  fixtureId: string,
  event: ApostabetEvent,
  orientation: EventMatchResult["orientation"],
  earlyPayoutTournamentIds: Set<string>
): OddRow[] {
  const rows: OddRow[] = [];
  const { homeTeam, awayTeam } = eventTeams(event);
  const pa = paForEvent(event, earlyPayoutTournamentIds);

  for (const market of (event.sportMarketDetails ?? []).filter(isMoneylineMarket)) {
    for (const outcome of market.sportOutcomeDetails ?? []) {
      const selection = selectionFromOutcome(outcome, homeTeam, awayTeam);
      const price = Number(outcome.odds);

      if (!selection || outcome.active !== true || !Number.isFinite(price) || price <= 0) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selectionForCanonicalOrientation(selection, orientation),
        price,
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.nameTranslated ?? market.nameDefault ?? null,
        raw_label: outcome.name ?? null,
        raw_odd_type: String(outcome.outcomeId ?? market.smarketId ?? ""),
        source_odd_id: numericId(outcome.id),
        raw: { event: compactEventRaw(event), market, outcome, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
  }

  return rows;
}

export function createApostabetCollector(bookmaker: ApostabetBookmakerConfig) {
  return async function collectApostabet(options: BookmakerCollectOptions = {}) {
    const client = new ApostabetClient(bookmaker);
    const summary = {
      tournamentsSeen: 0,
      tournamentsSelected: 0,
      eventsSeen: 0,
      eventsInWindow: 0,
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
      const earlyPayoutTournaments = await client.getEarlyPayoutTournaments();
      const earlyPayoutTournamentIds = new Set(earlyPayoutTournaments.filter((item) => item.enabled !== false).map((item) => item.tournamentId));
      const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
      const savedLinks = await getSavedBookmakerEventLinks(bookmaker.slug, fixtures.map((fixture) => fixture.id));
      const collectedFixtureIds = new Set<string>();

      await pMap(
        [...savedLinks.values()],
        async (link) => {
          const fixture = fixturesById.get(link.fixture_id);
          const raw = objectRaw(link.raw);
          const eventId = String(raw.id ?? link.external_event_id ?? "");
          if (!fixture || !eventId) return;

          try {
            const event = await client.getEventWithPrincipalMarkets(eventId);
            const matched = findBestMatch(event, [fixture]);
            if (!matched) throw new Error(`saved event no longer matches fixture ${fixture.name}`);

            const odds = buildMoneylineOdds(bookmaker, matched.fixture.id, event, matched.orientation, earlyPayoutTournamentIds);
            if (!odds.length) throw new Error(`saved event has no 1X2 odds: ${event.id}`);

            linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, event, matched.score));
            oddsToSave.push(...odds);
            collectedFixtureIds.add(matched.fixture.id);
            summary.eventsCollected += 1;
            summary.eventsMatched += 1;
            summary.eventsCollectedDirect += 1;
          } catch (error) {
            summary.directEventsFailed += 1;
            await log(bookmaker, "warn", "apostabet saved event direct refresh failed; falling back to discovery", {
              fixtureId: fixture.id,
              eventId,
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
        await log(bookmaker, "info", "apostabet collection finished", summary);
        return summary;
      }

      const categories = await client.getFootballSidebar();
      const selectedTournaments = selectTournaments(discoveryFixtures, categories);

      summary.tournamentsSeen = flattenTournaments(categories).length;
      summary.tournamentsSelected = selectedTournaments.length;

      const [eventPages, principalEvents] = await Promise.all([
        pMap(
          selectedTournaments,
          async ({ tournament }) => client.getEventsByTournament(tournament.tournamentId),
          { concurrency: 3 }
        ),
        client.getPrincipalTournamentEvents()
      ]);

      const events = [
        ...new Map(
          [...eventPages.flat(), ...principalEvents]
            .filter((event) => event.sportId === "sr:sport:1" && event.status === 0)
            .map((event) => [event.id, event])
        ).values()
      ];
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, discoveryFixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: ApostabetEvent; matched: NonNullable<ReturnType<typeof findBestMatch>> }>();

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

      const fallbackEvents = await searchMissingEvents(client, discoveryFixtures, new Set(bestMatchByFixtureId.keys()), async (message, context) => {
        summary.errors += 1;
        summary.lastError = errorMessage(context.error);
        await log(bookmaker, "error", message, context);
      });
      for (const event of fallbackEvents) {
        const matched = findBestMatch(event, discoveryFixtures);
        if (!matched) continue;

        const previous = bestMatchByFixtureId.get(matched.fixture.id);
        if (!previous || matched.score > previous.matched.score) {
          bestMatchByFixtureId.set(matched.fixture.id, { event, matched });
        }
      }

      for (const { event, matched } of bestMatchByFixtureId.values()) {
        linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, event, matched.score));
        oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, event, matched.orientation, earlyPayoutTournamentIds));
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
      await log(bookmaker, "error", "apostabet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "apostabet collection finished", summary);
    return summary;
  };
}

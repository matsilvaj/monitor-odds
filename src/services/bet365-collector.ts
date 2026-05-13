import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import { MVP_LEAGUES } from "../config/leagues.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, type EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeName } from "../domain/text.js";
import {
  Bet365BrowserClient,
  type Bet365CollectedEvent,
  type Bet365FixtureTarget,
  type Bet365LeagueEventCandidate
} from "../providers/bet365.js";
import { errorMessage } from "../utils/errors.js";
import { syncApiFootballFixtures } from "./api-football-sync.js";

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
        enabled: boolean;
      }
    | Array<{
        name: string;
        slug: string;
        country: string | null;
        api_football_league_id: number;
        enabled: boolean;
      }>
    | null;
  home_team: string | null;
  away_team: string | null;
  normalized_home_team: string | null;
  normalized_away_team: string | null;
  starts_at: string;
  date_key: string;
};

type ActiveLeague = {
  name: string;
  slug: string;
  country: string | null;
  api_football_league_id: number;
};

type DbLeagueRow = ActiveLeague & {
  enabled: boolean;
};

type Bet365RawEvent = {
  league: ActiveLeague;
  candidate: Bet365LeagueEventCandidate;
  event: Bet365CollectedEvent;
};

type Bet365Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function targetDateKeys(date: BookmakerCollectOptions["date"]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  if (!date) return [dateKey(today), dateKey(tomorrow)];

  if (date === "today") return [dateKey(today)];
  if (date === "tomorrow") return [dateKey(tomorrow)];
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return [date];

  throw new Error(`Data invalida para coleta: ${date}. Use today, tomorrow ou YYYY-MM-DD.`);
}

async function persistLog(bookmaker: Bet365BookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

function createLogger(bookmaker: Bet365BookmakerConfig, logToConsole: boolean): Bet365Logger {
  return async (level, message, context = {}) => {
    if (logToConsole) {
      const contextText = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
      const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      method(`[${new Date().toISOString()}] [bet365] ${message}${contextText}`);
    }

    await persistLog(bookmaker, level, message, context);
  };
}

async function ensureBaseRows(bookmaker: Bet365BookmakerConfig) {
  const { error } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;
}

async function getActiveLeagues() {
  const configuredIds = new Set(MVP_LEAGUES.map((league) => league.apiFootballLeagueId));
  const configuredOrder = new Map(MVP_LEAGUES.map((league, index) => [league.apiFootballLeagueId, index]));
  const { data, error } = await supabase
    .from("leagues")
    .select("name,slug,country,api_football_league_id,enabled")
    .order("name", { ascending: true });

  if (error) throw error;

  const byApiId = new Map<number, DbLeagueRow>();
  for (const row of (data ?? []) as unknown as DbLeagueRow[]) {
    byApiId.set(Number(row.api_football_league_id), { ...row, api_football_league_id: Number(row.api_football_league_id) });
  }

  const activeByApiId = new Map<number, ActiveLeague>();

  for (const row of byApiId.values()) {
    if (row.enabled) {
      activeByApiId.set(row.api_football_league_id, {
        name: row.name,
        slug: row.slug,
        country: row.country,
        api_football_league_id: row.api_football_league_id
      });
    }
  }

  for (const configured of MVP_LEAGUES) {
    const dbLeague = byApiId.get(configured.apiFootballLeagueId);
    if (dbLeague && !dbLeague.enabled) continue;
    if (activeByApiId.has(configured.apiFootballLeagueId)) continue;

    activeByApiId.set(configured.apiFootballLeagueId, {
      name: configured.name,
      slug: configured.slug,
      country: null,
      api_football_league_id: configured.apiFootballLeagueId
    });
  }

  return [...activeByApiId.values()].sort((left, right) => {
    const leftOrder = configuredOrder.get(left.api_football_league_id) ?? (configuredIds.has(left.api_football_league_id) ? 0 : 999);
    const rightOrder = configuredOrder.get(right.api_football_league_id) ?? (configuredIds.has(right.api_football_league_id) ? 0 : 999);
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
}

async function getCanonicalFixtures(dateKeys: string[]) {
  const { data, error } = await supabase
    .from("fixtures")
    .select(
      "id,api_football_fixture_id,name,league:leagues!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,normalized_home_team,normalized_away_team,starts_at,date_key"
    )
    .in("date_key", dateKeys)
    .eq("leagues.enabled", true)
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as CanonicalFixture[];
}

function fixtureLeague(fixture: CanonicalFixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function fixtureTargetFromCandidate(league: ActiveLeague, candidate: Bet365LeagueEventCandidate): Bet365FixtureTarget {
  return {
    id: String(candidate.externalEventId),
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    leagueName: league.name,
    leagueCountry: league.country,
    startsAt: candidate.startsAt
  };
}

async function saveRawEvents(bookmaker: Bet365BookmakerConfig, events: Bet365RawEvent[]) {
  if (!events.length) return 0;

  const uniqueEvents = [...new Map(events.map((event) => [event.event.externalEventId, event])).values()];
  const updatedAt = new Date().toISOString();
  const rows = uniqueEvents.map(({ league, candidate, event }) => ({
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.externalEventId,
    league_api_football_id: league.api_football_league_id,
    league_name: league.name,
    league_country: league.country,
    event_name: event.eventName || `${candidate.homeTeam} x ${candidate.awayTeam}`,
    home_team: candidate.homeTeam,
    away_team: candidate.awayTeam,
    normalized_home_team: normalizeName(candidate.homeTeam),
    normalized_away_team: normalizeName(candidate.awayTeam),
    starts_at: candidate.startsAt,
    date_key: candidate.dateKey,
    source_url: event.sourceUrl,
    markets: event.markets,
    raw_text: event.rawText,
    raw: {
      league,
      candidate,
      sourceUrl: event.sourceUrl,
      rawText: event.rawText,
      markets: event.markets
    },
    updated_at: updatedAt
  }));

  const { error } = await supabase.from("bookmaker_event_snapshots").upsert(rows, {
    onConflict: "bookmaker_slug,external_event_id"
  });

  if (error) throw error;
  return rows.length;
}

function findBestMatch(rawEvent: Bet365RawEvent, fixtures: CanonicalFixture[]) {
  const event = {
    startsAt: rawEvent.candidate.startsAt,
    homeTeam: rawEvent.candidate.homeTeam,
    awayTeam: rawEvent.candidate.awayTeam,
    leagueName: rawEvent.league.name
  };
  let best: (EventMatchResult & { fixture: CanonicalFixture }) | null = null;

  const leagueFixtures = fixtures.filter((fixture) => {
    const league = fixtureLeague(fixture);
    return league?.api_football_league_id === rawEvent.league.api_football_league_id && fixture.date_key === rawEvent.candidate.dateKey;
  });
  const candidates = leagueFixtures.length ? leagueFixtures : fixtures.filter((fixture) => fixture.date_key === rawEvent.candidate.dateKey);

  for (const fixture of candidates) {
    const league = fixtureLeague(fixture);
    const result = matchEvents(
      {
        startsAt: fixture.starts_at,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team,
        leagueName: league?.name ?? null
      },
      event
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function buildBookmakerLink(bookmaker: Bet365BookmakerConfig, rawEvent: Bet365RawEvent, fixture: CanonicalFixture, match: EventMatchResult): BookmakerLinkRow {
  const { candidate, event } = rawEvent;

  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.externalEventId,
    fixture_id: fixture.id,
    bookmaker_event_name: event.eventName || `${candidate.homeTeam} x ${candidate.awayTeam}`,
    bookmaker_home_team: candidate.homeTeam,
    bookmaker_away_team: candidate.awayTeam,
    normalized_bookmaker_home_team: normalizeName(candidate.homeTeam),
    normalized_bookmaker_away_team: normalizeName(candidate.awayTeam),
    starts_at: candidate.startsAt,
    match_confidence_score: Number(match.score.toFixed(3)),
    source_url: event.sourceUrl,
    raw: {
      league: rawEvent.league,
      candidate,
      sourceUrl: event.sourceUrl,
      rawText: event.rawText,
      markets: event.markets,
      match
    },
    updated_at: new Date().toISOString()
  };
}

function canonicalSelection(selection: string, orientation: EventMatchResult["orientation"]) {
  if (orientation !== "INVERTED") return selection;
  if (selection === "HOME") return "AWAY";
  if (selection === "AWAY") return "HOME";
  return selection;
}

function buildMoneylineOdds(bookmaker: Bet365BookmakerConfig, rawEvent: Bet365RawEvent, fixture: CanonicalFixture, match: EventMatchResult): OddRow[] {
  const rows: OddRow[] = [];

  for (const market of rawEvent.event.markets) {
    for (const selection of market.selections) {
      rows.push({
        fixture_id: fixture.id,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: canonicalSelection(selection.selection, match.orientation),
        price: selection.price,
        pa_category: market.paCategory,
        confidence_score: Math.min(1, Number((market.confidence * match.score).toFixed(3))),
        raw_market_name: market.marketName,
        raw_label: selection.label,
        raw_odd_type: selection.selection,
        source_odd_id: rawEvent.event.externalEventId * 1000 + market.index * 10 + selection.index,
        raw: {
          sourceUrl: rawEvent.event.sourceUrl,
          candidate: rawEvent.candidate,
          market,
          selection,
          match,
          classificationReason: market.classificationReason
        },
        updated_at: new Date().toISOString()
      });
    }
  }

  return [...new Map(rows.map((row) => [`${row.fixture_id}:${row.selection}:${row.pa_category}`, row])).values()];
}

export function createBet365Collector(bookmaker: Bet365BookmakerConfig) {
  return async function collectBet365(options: BookmakerCollectOptions = {}) {
    const logger = createLogger(bookmaker, options.logToConsole ?? true);
    const dateKeys = targetDateKeys(options.date);
    const manualFallback = options.manualFallback ?? bookmaker.manualFallback;
    const client = new Bet365BrowserClient({ ...bookmaker, manualFallback }, logger);
    const summary = {
      targetDateKeys: dateKeys,
      fixtureSyncAttempted: false,
      fixtureSyncSummary: null as unknown,
      activeLeagues: 0,
      leaguesSeen: 0,
      leaguesTargeted: 0,
      leaguesOpened: 0,
      leaguesSkipped: 0,
      rawEventsFound: 0,
      rawEventsSaved: 0,
      eventsOpened: 0,
      eventsCollected: 0,
      eventsWithoutOdds: 0,
      fixturesAvailable: 0,
      eventsMatched: 0,
      eventsUnmatched: 0,
      oddsFound: 0,
      oddsUpserted: 0,
      errors: 0,
      lastError: null as string | null
    };

    await ensureBaseRows(bookmaker);
    const activeLeagues = await getActiveLeagues();
    summary.activeLeagues = activeLeagues.length;
    summary.leaguesTargeted = activeLeagues.length;

    if (!activeLeagues.length) {
      await logger("warn", "nenhuma liga ativa encontrada para navegar na bet365");
      return summary;
    }

    await logger("info", "ligas ativas carregadas para a bet365", {
      total: activeLeagues.length,
      leagues: activeLeagues.map((league) => ({
        id: league.api_football_league_id,
        name: league.name,
        country: league.country
      }))
    });

    const rawEvents: Bet365RawEvent[] = [];

    try {
      await client.start();
      await client.openHome();
      await client.openFootball();
      await client.openCompetitions();

      const leagueCandidates = await client.collectLeagueCandidates();
      summary.leaguesSeen = leagueCandidates.length;
      await logger("info", "ligas visiveis capturadas na bet365", {
        count: leagueCandidates.length,
        sample: leagueCandidates.slice(0, 12)
      });

      for (const league of activeLeagues) {
        try {
          await client.openHome();
          await client.openFootball();
          await client.openCompetitions();
          const openedLeague = await client.openLeague(league.name, league.country);

          if (!openedLeague) {
            summary.leaguesSkipped += 1;
            await logger("warn", "liga ignorada porque nao foi aberta", {
              leagueName: league.name,
              country: league.country,
              apiFootballLeagueId: league.api_football_league_id
            });
            continue;
          }

          summary.leaguesOpened += 1;
          const leagueUrl = client.currentUrl();
          const leagueEvents = await client.collectLeagueEvents(dateKeys);
          summary.rawEventsFound += leagueEvents.length;

          await logger("info", "eventos brutos encontrados na liga", {
            leagueName: league.name,
            apiFootballLeagueId: league.api_football_league_id,
            events: leagueEvents.length
          });

          for (const candidate of leagueEvents) {
            const target = fixtureTargetFromCandidate(league, candidate);
            let openedEvent = await client.openFixture(target);

            if (!openedEvent) {
              openedEvent = await client.waitForManualEvent(target);
            }

            if (!openedEvent) {
              summary.eventsUnmatched += 1;
              await logger("warn", "evento bruto encontrado, mas nao consegui abrir a pagina do jogo", {
                leagueName: league.name,
                homeTeam: candidate.homeTeam,
                awayTeam: candidate.awayTeam,
                startsAt: candidate.startsAt
              });
              await client.goToUrl(leagueUrl, "voltando para a liga apos falha ao abrir jogo");
              continue;
            }

            summary.eventsOpened += 1;
            const event = await client.collectCurrentEvent(target);
            rawEvents.push({ league, candidate, event });
            summary.eventsCollected += 1;

            if (!event.markets.length) {
              summary.eventsWithoutOdds += 1;
              await logger("warn", "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado", {
                leagueName: league.name,
                homeTeam: candidate.homeTeam,
                awayTeam: candidate.awayTeam,
                sourceUrl: event.sourceUrl,
                textSample: event.rawText.slice(0, 700)
              });
            }

            await client.goToUrl(leagueUrl, "voltando para a liga apos coletar jogo");
          }
        } catch (error) {
          summary.errors += 1;
          summary.lastError = errorMessage(error);
          await logger("error", "falha ao coletar liga da bet365", {
            leagueName: league.name,
            country: league.country,
            apiFootballLeagueId: league.api_football_league_id,
            error: serializeError(error)
          });
        }
      }
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await logger("error", "coleta da bet365 falhou", { error: serializeError(error) });
    } finally {
      await client.stop().catch(async (error) => {
        summary.errors += 1;
        summary.lastError = errorMessage(error);
        await logger("error", "falha ao fechar Chrome da bet365", { error: serializeError(error) });
      });
    }

    summary.rawEventsSaved = await saveRawEvents(bookmaker, rawEvents);
    await logger("info", "snapshots brutos da bet365 salvos", {
      rawEventsFound: summary.rawEventsFound,
      rawEventsCollected: rawEvents.length,
      rawEventsSaved: summary.rawEventsSaved
    });

    let fixtures = await getCanonicalFixtures(dateKeys);
    const missingDateKeys = dateKeys.filter((key) => !fixtures.some((fixture) => fixture.date_key === key));

    if (!fixtures.length || missingDateKeys.length) {
      summary.fixtureSyncAttempted = true;
      await logger("warn", "fixtures locais incompletos para matching; sincronizando API-Football fora do navegador", {
        dateKeys,
        fixturesFound: fixtures.length,
        missingDateKeys
      });
      summary.fixtureSyncSummary = await syncApiFootballFixtures();
      fixtures = await getCanonicalFixtures(dateKeys);
    }

    summary.fixturesAvailable = fixtures.length;

    if (!fixtures.length) {
      await logger("warn", "nenhum fixture canonico encontrado para matching da bet365", { dateKeys });
      await logger("info", "coleta da bet365 finalizada", summary);
      return summary;
    }

    const bestMatchByFixtureId = new Map<string, { rawEvent: Bet365RawEvent; fixture: CanonicalFixture; match: EventMatchResult }>();
    let rawMatched = 0;

    for (const rawEvent of rawEvents) {
      const match = findBestMatch(rawEvent, fixtures);
      if (!match) continue;

      rawMatched += 1;
      const previous = bestMatchByFixtureId.get(match.fixture.id);
      const rank = match.score + (rawEvent.event.markets.length ? 0.01 : 0);
      const previousRank = previous ? previous.match.score + (previous.rawEvent.event.markets.length ? 0.01 : 0) : -1;

      if (!previous || rank > previousRank) {
        bestMatchByFixtureId.set(match.fixture.id, { rawEvent, fixture: match.fixture, match });
      }
    }

    summary.eventsMatched = bestMatchByFixtureId.size;
    summary.eventsUnmatched += Math.max(0, rawEvents.length - rawMatched);

    const linksToSave: BookmakerLinkRow[] = [];
    const oddsToSave: OddRow[] = [];

    for (const { rawEvent, fixture, match } of bestMatchByFixtureId.values()) {
      if (!rawEvent.event.markets.length) continue;
      linksToSave.push(buildBookmakerLink(bookmaker, rawEvent, fixture, match));
      oddsToSave.push(...buildMoneylineOdds(bookmaker, rawEvent, fixture, match));
    }

    summary.oddsFound = oddsToSave.length;
    summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave);

    await logger("info", "matching da bet365 finalizado", {
      rawEvents: rawEvents.length,
      rawMatched,
      uniqueFixturesMatched: summary.eventsMatched,
      oddsFound: summary.oddsFound,
      oddsUpserted: summary.oddsUpserted
    });
    await logger("info", "coleta da bet365 finalizada", summary);
    return summary;
  };
}

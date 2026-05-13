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

type CollectionState = {
  status: string;
  next_run_at: string | null;
  lease_until: string | null;
  last_finished_at: string | null;
};

type Bet365Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

const MINUTE_MS = 60 * 1000;
const BET365_LOCK_LEASE_MS = 45 * MINUTE_MS;
const STARTED_GRACE_MS = 60 * 1000;

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timestamp(value: string | number | Date) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function minutesUntil(value: string | number | Date, now = new Date()) {
  return (timestamp(value) - now.getTime()) / MINUTE_MS;
}

function formatDuration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  return `${minutes}m`;
}

function refreshIntervalMsForStart(startsAt: string | number | Date, now = new Date()) {
  const minutes = minutesUntil(startsAt, now);
  if (minutes <= 120) return 10 * MINUTE_MS;
  if (minutes <= 360) return 30 * MINUTE_MS;
  if (minutes <= 24 * 60) return 60 * MINUTE_MS;
  return 4 * 60 * MINUTE_MS;
}

function collectionIntervalMs(fixtures: CanonicalFixture[], now = new Date()) {
  const futureFixtures = fixtures
    .map((fixture) => timestamp(fixture.starts_at))
    .filter((value) => Number.isFinite(value) && value > now.getTime())
    .sort((left, right) => left - right);

  if (!futureFixtures.length) return 60 * MINUTE_MS;
  return refreshIntervalMsForStart(futureFixtures[0], now);
}

function isPrematch(startsAt: string | number | Date, now = new Date()) {
  return timestamp(startsAt) > now.getTime() + STARTED_GRACE_MS;
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

function contextValue(context: Record<string, unknown>, key: string) {
  const value = context[key];
  return value == null ? "" : String(value);
}

function fixtureName(context: Record<string, unknown>) {
  const eventName = contextValue(context, "eventName");
  if (eventName) return eventName;

  const homeTeam = contextValue(context, "homeTeam");
  const awayTeam = contextValue(context, "awayTeam");
  return [homeTeam, awayTeam].filter(Boolean).join(" x ");
}

function formatBet365ConsoleLine(level: "info" | "warn" | "error", message: string, context: Record<string, unknown>) {
  const debugEnabled = process.env.BET365_DEBUG === "true" || process.env.BET365_DEBUG === "1" || process.env.COLLECT_DEBUG === "true";
  if (debugEnabled) {
    const contextText = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
    return `[bet365] ${message}${contextText}`;
  }

  if (message === "iniciando Chrome real via CDP para bet365") return "[bet365] Abrindo Chrome real...";
  if (message === "perfil principal da bet365 nao abriu CDP; tentando perfil temporario") return "[bet365] Perfil principal indisponível; usando perfil temporário.";
  if (message === "fechando Chrome da bet365") return "[bet365] Fechando Chrome.";
  if (message === "banner de cookies aceito") return "[bet365] Cookies aceitos.";
  if (message === "fixtures locais incompletos para a bet365; sincronizando API-Football antes de abrir o navegador") {
    return "[bet365] Sincronizando jogos da API-Football antes de abrir o Chrome.";
  }
  if (message === "bet365 pulada pelo sync:watch porque ainda nao chegou a proxima janela") {
    return `[bet365] Coleta pulada: aguardando próxima janela${context.nextRunAt ? ` (${contextValue(context, "nextRunAt")})` : ""}.`;
  }
  if (message === "bet365 pulada porque outra coleta ainda esta rodando") return "[bet365] Coleta pulada: outra execução ainda está em andamento.";
  if (message === "ligas selecionadas para navegacao na bet365") {
    return `[bet365] Jogos alvo: ${contextValue(context, "fixturesTargeted")} | Ligas alvo: ${contextValue(context, "targetLeagues")}.`;
  }
  if (message === "liga aberta na bet365") return `[bet365] Liga aberta: ${contextValue(context, "leagueName")}.`;
  if (message === "eventos brutos encontrados na liga") {
    return `[bet365] ${contextValue(context, "leagueName")}: ${contextValue(context, "events")} jogos encontrados.`;
  }
  if (message === "jogo da bet365 salvo no banco") {
    return `[bet365] Odds salvas: ${fixtureName(context)} | ${contextValue(context, "oddsUpserted")} odds.`;
  }
  if (message === "jogo pulado porque as odds da bet365 ainda estao recentes") {
    return `[bet365] Pulando ${fixtureName(context)}: odds recentes.`;
  }
  if (message === "jogo ignorado porque ja comecou ou esta perto demais do inicio") {
    return `[bet365] Pulando ${fixtureName(context)}: jogo já iniciado ou muito perto do início.`;
  }
  if (message === "liga ignorada porque nao foi aberta") return `[bet365] Liga não aberta: ${contextValue(context, "leagueName")}.`;
  if (message === "evento bruto encontrado, mas nao consegui abrir a pagina do jogo") return `[bet365] Jogo não aberto: ${fixtureName(context)}.`;
  if (message === "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado") return `[bet365] Jogo sem mercado 1X2: ${fixtureName(context)}.`;
  if (message === "snapshot bruto salvo sem match canonico") return `[bet365] Snapshot salvo sem matching: ${fixtureName(context)}.`;
  if (message === "snapshot bruto salvo e matcheado, mas sem odds finais") return `[bet365] Snapshot salvo sem odds finais: ${fixtureName(context)}.`;
  if (message === "coleta da bet365 finalizada") {
    return `[bet365] Coleta finalizada: ${contextValue(context, "eventsCollected")} jogos coletados | ${contextValue(context, "oddsUpserted")} odds salvas | ${contextValue(context, "errors")} erros.`;
  }

  if (level === "error") {
    const error = context.error && typeof context.error === "object" && "message" in context.error ? String((context.error as { message?: unknown }).message) : "";
    return `[bet365] Erro: ${message}${error ? ` | ${error}` : ""}.`;
  }

  return null;
}

function createLogger(bookmaker: Bet365BookmakerConfig, logToConsole: boolean): Bet365Logger {
  return async (level, message, context = {}) => {
    if (logToConsole) {
      const line = formatBet365ConsoleLine(level, message, context);
      if (line) {
        const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        method(line);
      }
    }

    await persistLog(bookmaker, level, message, context);
  };
}

async function ensureBaseRows(bookmaker: Bet365BookmakerConfig) {
  const { error } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;

  const { error: stateError } = await supabase.from("bookmaker_collection_state").upsert(
    {
      bookmaker_slug: bookmaker.slug,
      status: "idle",
      updated_at: new Date().toISOString()
    },
    { onConflict: "bookmaker_slug", ignoreDuplicates: true }
  );
  if (stateError) throw stateError;
}

async function getCollectionState(bookmaker: Bet365BookmakerConfig) {
  const { data, error } = await supabase
    .from("bookmaker_collection_state")
    .select("status,next_run_at,lease_until,last_finished_at")
    .eq("bookmaker_slug", bookmaker.slug)
    .maybeSingle();

  if (error) throw error;
  return data as CollectionState | null;
}

async function acquireCollectionLock(bookmaker: Bet365BookmakerConfig) {
  const leaseUntil = new Date(Date.now() + BET365_LOCK_LEASE_MS).toISOString();
  const { data, error } = await supabase.rpc("try_acquire_bookmaker_collection_lock", {
    p_bookmaker_slug: bookmaker.slug,
    p_lease_until: leaseUntil
  });

  if (error) throw error;
  return Boolean(data);
}

async function releaseCollectionLock(bookmaker: Bet365BookmakerConfig, summary: unknown, nextRunAt: string | null, status: "idle" | "error", lastError: string | null) {
  const { error } = await supabase
    .from("bookmaker_collection_state")
    .update({
      status,
      last_finished_at: new Date().toISOString(),
      next_run_at: nextRunAt,
      lease_until: null,
      last_error: lastError,
      summary,
      updated_at: new Date().toISOString()
    })
    .eq("bookmaker_slug", bookmaker.slug);

  if (error) throw error;
}

async function updateCollectionState(bookmaker: Bet365BookmakerConfig, values: Record<string, unknown>) {
  const { error } = await supabase
    .from("bookmaker_collection_state")
    .update({
      ...values,
      updated_at: new Date().toISOString()
    })
    .eq("bookmaker_slug", bookmaker.slug);

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

async function getCanonicalFixtures(dateKeys: string[], options: { futureOnly?: boolean } = {}) {
  let builder = supabase
    .from("fixtures")
    .select(
      "id,api_football_fixture_id,name,league:leagues!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,normalized_home_team,normalized_away_team,starts_at,date_key"
    )
    .in("date_key", dateKeys)
    .eq("leagues.enabled", true);

  if (options.futureOnly) {
    builder = builder.gt("starts_at", new Date().toISOString());
  }

  const { data, error } = await builder.order("starts_at", { ascending: true });

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

async function saveRawEvent(bookmaker: Bet365BookmakerConfig, event: Bet365RawEvent) {
  return saveRawEvents(bookmaker, [event]);
}

async function getLastOddsUpdatedByFixture(bookmakerSlug: string, fixtureIds: string[]) {
  const updatedByFixtureId = new Map<string, string>();
  if (!fixtureIds.length) return updatedByFixtureId;

  const { data, error } = await supabase
    .from("odds")
    .select("fixture_id,updated_at")
    .eq("bookmaker_slug", bookmakerSlug)
    .eq("market_code", "1X2")
    .in("fixture_id", fixtureIds);

  if (error) throw error;

  for (const row of (data ?? []) as Array<{ fixture_id: string; updated_at: string | null }>) {
    if (!row.updated_at) continue;
    const current = updatedByFixtureId.get(row.fixture_id);
    if (!current || new Date(row.updated_at) > new Date(current)) {
      updatedByFixtureId.set(row.fixture_id, row.updated_at);
    }
  }

  return updatedByFixtureId;
}

async function getCachedEventUrls(bookmakerSlug: string, fixtureIds: string[]) {
  const urlByFixtureId = new Map<string, string>();
  if (!fixtureIds.length) return urlByFixtureId;

  const { data, error } = await supabase
    .from("bookmaker_event_links")
    .select("fixture_id,source_url,updated_at")
    .eq("bookmaker_slug", bookmakerSlug)
    .in("fixture_id", fixtureIds)
    .not("source_url", "is", null)
    .order("updated_at", { ascending: false });

  if (error) throw error;

  for (const row of (data ?? []) as Array<{ fixture_id: string; source_url: string | null }>) {
    if (row.source_url && !urlByFixtureId.has(row.fixture_id)) {
      urlByFixtureId.set(row.fixture_id, row.source_url);
    }
  }

  return urlByFixtureId;
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

function rawEventPlaceholder(league: ActiveLeague, candidate: Bet365LeagueEventCandidate): Bet365RawEvent {
  return {
    league,
    candidate,
    event: {
      externalEventId: candidate.externalEventId,
      sourceUrl: candidate.sourceUrl ?? "",
      eventName: `${candidate.homeTeam} x ${candidate.awayTeam}`,
      markets: [],
      rawText: candidate.sourceText
    }
  };
}

function shouldSkipFreshFixture(fixture: CanonicalFixture, lastUpdatedAt: string | undefined, now = new Date()) {
  if (!lastUpdatedAt) return { skip: false, refreshMs: refreshIntervalMsForStart(fixture.starts_at, now), ageMs: null as number | null };

  const refreshMs = refreshIntervalMsForStart(fixture.starts_at, now);
  const ageMs = now.getTime() - new Date(lastUpdatedAt).getTime();
  return { skip: Number.isFinite(ageMs) && ageMs >= 0 && ageMs < refreshMs, refreshMs, ageMs };
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

async function persistCollectedEvent(bookmaker: Bet365BookmakerConfig, rawEvent: Bet365RawEvent, fixtures: CanonicalFixture[], logger: Bet365Logger) {
  const rawEventsSaved = await saveRawEvent(bookmaker, rawEvent);
  const match = findBestMatch(rawEvent, fixtures);

  if (!match) {
    await logger("warn", "snapshot bruto salvo sem match canonico", {
      leagueName: rawEvent.league.name,
      homeTeam: rawEvent.candidate.homeTeam,
      awayTeam: rawEvent.candidate.awayTeam,
      startsAt: rawEvent.candidate.startsAt,
      externalEventId: rawEvent.event.externalEventId
    });
    return { rawEventsSaved, matched: false, oddsFound: 0, oddsUpserted: 0, fixtureId: null as string | null };
  }

  if (!rawEvent.event.markets.length) {
    await logger("warn", "snapshot bruto salvo e matcheado, mas sem odds finais", {
      fixtureId: match.fixture.id,
      eventName: rawEvent.event.eventName,
      sourceUrl: rawEvent.event.sourceUrl
    });
    return { rawEventsSaved, matched: true, oddsFound: 0, oddsUpserted: 0, fixtureId: match.fixture.id };
  }

  const link = buildBookmakerLink(bookmaker, rawEvent, match.fixture, match);
  const odds = buildMoneylineOdds(bookmaker, rawEvent, match.fixture, match);
  const oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, [link], odds);

  await logger("info", "jogo da bet365 salvo no banco", {
    fixtureId: match.fixture.id,
    eventName: rawEvent.event.eventName,
    sourceUrl: rawEvent.event.sourceUrl,
    matchScore: Number(match.score.toFixed(3)),
    oddsFound: odds.length,
    oddsUpserted
  });

  return { rawEventsSaved, matched: true, oddsFound: odds.length, oddsUpserted, fixtureId: match.fixture.id };
}

export function createBet365Collector(bookmaker: Bet365BookmakerConfig) {
  return async function collectBet365(options: BookmakerCollectOptions = {}) {
    const logger = createLogger(bookmaker, options.logToConsole ?? true);
    const dateKeys = targetDateKeys(options.date);
    const manualFallback = options.manualFallback ?? bookmaker.manualFallback;
    const trigger = options.trigger ?? "manual";
    const force = Boolean(options.force);
    const summary = {
      trigger,
      force,
      targetDateKeys: dateKeys,
      skipped: false,
      skipReason: null as string | null,
      nextRunAt: null as string | null,
      collectionInterval: null as string | null,
      fixtureSyncAttempted: false,
      fixtureSyncSummary: null as unknown,
      activeLeagues: 0,
      leaguesSeen: 0,
      leaguesTargeted: 0,
      leaguesOpened: 0,
      leaguesSkipped: 0,
      leaguesSkippedNoFixtures: 0,
      rawEventsFound: 0,
      rawEventsSaved: 0,
      eventsOpened: 0,
      eventsOpenedFromCache: 0,
      eventsCollected: 0,
      eventsWithoutOdds: 0,
      eventsSkippedStarted: 0,
      eventsSkippedFresh: 0,
      fixturesAvailable: 0,
      fixturesTargeted: 0,
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

    if (!activeLeagues.length) {
      summary.skipped = true;
      summary.skipReason = "no-active-leagues";
      summary.nextRunAt = new Date(Date.now() + 60 * MINUTE_MS).toISOString();
      await logger("warn", "nenhuma liga ativa encontrada para navegar na bet365");
      await updateCollectionState(bookmaker, { next_run_at: summary.nextRunAt, last_error: null, summary });
      await logger("info", "coleta da bet365 finalizada", summary);
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

    let fixtures = await getCanonicalFixtures(dateKeys, { futureOnly: true });
    let fixturesIncludingStarted = fixtures;
    const hasEveryDateKey = () => dateKeys.every((key) => fixturesIncludingStarted.some((fixture) => fixture.date_key === key));

    if (!fixtures.length || !hasEveryDateKey()) {
      fixturesIncludingStarted = await getCanonicalFixtures(dateKeys);
    }

    const missingDateKeys = dateKeys.filter((key) => !fixturesIncludingStarted.some((fixture) => fixture.date_key === key));

    if ((!fixtures.length && !fixturesIncludingStarted.length) || missingDateKeys.length) {
      summary.fixtureSyncAttempted = true;
      await logger("warn", "fixtures locais incompletos para a bet365; sincronizando API-Football antes de abrir o navegador", {
        dateKeys,
        futureFixturesFound: fixtures.length,
        fixturesFound: fixturesIncludingStarted.length,
        missingDateKeys
      });
      summary.fixtureSyncSummary = await syncApiFootballFixtures();
      fixtures = await getCanonicalFixtures(dateKeys, { futureOnly: true });
      fixturesIncludingStarted = await getCanonicalFixtures(dateKeys);
    }

    summary.fixturesAvailable = fixtures.length;

    if (!fixtures.length) {
      summary.skipped = true;
      summary.skipReason = "no-future-fixtures";
      summary.nextRunAt = new Date(Date.now() + 60 * MINUTE_MS).toISOString();
      await logger("warn", "nenhum fixture futuro encontrado para a bet365", {
        dateKeys,
        fixturesIncludingStarted: fixturesIncludingStarted.length
      });
      await updateCollectionState(bookmaker, { next_run_at: summary.nextRunAt, last_error: null, summary });
      await logger("info", "coleta da bet365 finalizada", summary);
      return summary;
    }

    const fixtureLeagueIds = new Set<number>();
    for (const fixture of fixtures) {
      const league = fixtureLeague(fixture);
      if (league) fixtureLeagueIds.add(Number(league.api_football_league_id));
    }

    const targetLeagues = activeLeagues.filter((league) => fixtureLeagueIds.has(league.api_football_league_id));
    summary.leaguesTargeted = targetLeagues.length;
    summary.leaguesSkippedNoFixtures = Math.max(0, activeLeagues.length - targetLeagues.length);
    summary.fixturesTargeted = fixtures.filter((fixture) => {
      const league = fixtureLeague(fixture);
      return league ? fixtureLeagueIds.has(Number(league.api_football_league_id)) : false;
    }).length;

    if (!targetLeagues.length) {
      summary.skipped = true;
      summary.skipReason = "no-target-leagues-with-fixtures";
      summary.nextRunAt = new Date(Date.now() + 60 * MINUTE_MS).toISOString();
      await logger("warn", "nenhuma liga ativa possui jogos futuros nas datas alvo da bet365", {
        dateKeys,
        fixturesAvailable: fixtures.length,
        activeLeagues: activeLeagues.length
      });
      await updateCollectionState(bookmaker, { next_run_at: summary.nextRunAt, last_error: null, summary });
      await logger("info", "coleta da bet365 finalizada", summary);
      return summary;
    }

    const intervalMs = collectionIntervalMs(fixtures);
    summary.collectionInterval = formatDuration(intervalMs);

    const state = await getCollectionState(bookmaker);
    const nextRunMs = state?.next_run_at ? new Date(state.next_run_at).getTime() : NaN;
    if (trigger === "watch" && !force && Number.isFinite(nextRunMs) && nextRunMs > Date.now()) {
      summary.skipped = true;
      summary.skipReason = "cadence-not-due";
      summary.nextRunAt = state?.next_run_at ?? null;
      await logger("info", "bet365 pulada pelo sync:watch porque ainda nao chegou a proxima janela", {
        nextRunAt: summary.nextRunAt,
        collectionInterval: summary.collectionInterval,
        fixturesTargeted: summary.fixturesTargeted
      });
      return summary;
    }

    const lockAcquired = await acquireCollectionLock(bookmaker);
    if (!lockAcquired) {
      summary.skipped = true;
      summary.skipReason = "already-running";
      await logger("warn", "bet365 pulada porque outra coleta ainda esta rodando", {
        leaseUntil: state?.lease_until ?? null,
        status: state?.status ?? null
      });
      return summary;
    }

    const fixtureIds = fixtures.map((fixture) => fixture.id);
    const [lastOddsByFixtureId, cachedUrlByFixtureId] = await Promise.all([
      getLastOddsUpdatedByFixture(bookmaker.slug, fixtureIds),
      getCachedEventUrls(bookmaker.slug, fixtureIds)
    ]);
    const client = new Bet365BrowserClient({ ...bookmaker, manualFallback }, logger);

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

      await logger("info", "ligas selecionadas para navegacao na bet365", {
        targetLeagues: targetLeagues.length,
        skippedWithoutFixtures: summary.leaguesSkippedNoFixtures,
        fixturesTargeted: summary.fixturesTargeted,
        leagues: targetLeagues.map((league) => ({
          id: league.api_football_league_id,
          name: league.name,
          country: league.country
        }))
      });

      for (const league of targetLeagues) {
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
            events: leagueEvents.length,
            futureFixturesInLeague: fixtures.filter((fixture) => fixtureLeague(fixture)?.api_football_league_id === league.api_football_league_id).length
          });

          for (const candidate of leagueEvents) {
            try {
              if (!isPrematch(candidate.startsAt)) {
                summary.eventsSkippedStarted += 1;
                await logger("info", "jogo ignorado porque ja comecou ou esta perto demais do inicio", {
                  leagueName: league.name,
                  homeTeam: candidate.homeTeam,
                  awayTeam: candidate.awayTeam,
                  startsAt: candidate.startsAt
                });
                continue;
              }

              const previewMatch = findBestMatch(rawEventPlaceholder(league, candidate), fixtures);
              if (previewMatch) {
                const freshness = shouldSkipFreshFixture(previewMatch.fixture, lastOddsByFixtureId.get(previewMatch.fixture.id));
                if (freshness.skip) {
                  summary.eventsSkippedFresh += 1;
                  await logger("info", "jogo pulado porque as odds da bet365 ainda estao recentes", {
                    fixtureId: previewMatch.fixture.id,
                    homeTeam: candidate.homeTeam,
                    awayTeam: candidate.awayTeam,
                    startsAt: candidate.startsAt,
                    refreshEvery: formatDuration(freshness.refreshMs),
                    age: freshness.ageMs === null ? null : formatDuration(freshness.ageMs),
                    lastUpdatedAt: lastOddsByFixtureId.get(previewMatch.fixture.id)
                  });
                  continue;
                }
              }

              const target = fixtureTargetFromCandidate(league, candidate);
              const cachedUrl = previewMatch ? cachedUrlByFixtureId.get(previewMatch.fixture.id) : null;
              let openedEvent = false;

              if (cachedUrl) {
                await client.goToUrl(cachedUrl, "abrindo jogo da bet365 por URL em cache");
                openedEvent = await client.verifyCurrentEvent(target);

                if (openedEvent) {
                  summary.eventsOpenedFromCache += 1;
                } else {
                  await logger("warn", "URL em cache da bet365 nao abriu o jogo esperado; voltando para a liga", {
                    fixtureId: previewMatch?.fixture.id,
                    cachedUrl,
                    homeTeam: candidate.homeTeam,
                    awayTeam: candidate.awayTeam
                  });
                  await client.goToUrl(leagueUrl, "voltando para a liga apos cache invalido");
                }
              }

              if (!openedEvent) {
                openedEvent = await client.openFixture(target);
              }

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
              const rawEvent = { league, candidate, event };
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

              const persisted = await persistCollectedEvent(bookmaker, rawEvent, fixtures, logger);
              summary.rawEventsSaved += persisted.rawEventsSaved;
              if (persisted.matched) summary.eventsMatched += 1;
              else summary.eventsUnmatched += 1;
              summary.oddsFound += persisted.oddsFound;
              summary.oddsUpserted += persisted.oddsUpserted;

              if (persisted.fixtureId && persisted.oddsUpserted > 0) {
                const savedAt = new Date().toISOString();
                lastOddsByFixtureId.set(persisted.fixtureId, savedAt);
                if (event.sourceUrl) cachedUrlByFixtureId.set(persisted.fixtureId, event.sourceUrl);
              }

              await client.goToUrl(leagueUrl, "voltando para a liga apos coletar jogo");
            } catch (error) {
              summary.errors += 1;
              summary.lastError = errorMessage(error);
              await logger("error", "falha ao coletar jogo da bet365", {
                leagueName: league.name,
                homeTeam: candidate.homeTeam,
                awayTeam: candidate.awayTeam,
                startsAt: candidate.startsAt,
                error: serializeError(error)
              });
              await client.goToUrl(leagueUrl, "voltando para a liga apos erro no jogo").catch(() => undefined);
            }
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
      const retryMs = summary.errors ? 10 * MINUTE_MS : intervalMs;
      summary.nextRunAt = new Date(Date.now() + retryMs).toISOString();
      await releaseCollectionLock(bookmaker, summary, summary.nextRunAt, summary.errors ? "error" : "idle", summary.lastError).catch(async (error) => {
        summary.errors += 1;
        summary.lastError = errorMessage(error);
        await logger("error", "falha ao atualizar estado da coleta da bet365", { error: serializeError(error) });
      });
    }

    await logger("info", "coleta da bet365 finalizada", summary);
    return summary;
  };
}

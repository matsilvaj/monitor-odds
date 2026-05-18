import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { MeridianbetBookmakerConfig } from "../config/bookmakers.js";
import { MVP_LEAGUES } from "../config/leagues.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import type { EventMatchResult } from "../domain/matching/event-matcher.js";
import { normalizeName } from "../domain/text.js";
import {
  MeridianbetBrowserClient,
  type MeridianCollectedEvent,
  type MeridianFixtureTarget
} from "../providers/meridianbet.js";
import { errorMessage } from "../utils/errors.js";
import { syncApiFootballFixtures } from "./api-football-sync.js";

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

type CollectionState = {
  status: string;
  lease_until: string | null;
};

type MeridianLeagueLinkRow = {
  api_football_league_id: number;
  source_url: string;
  bookmaker_league_name: string | null;
  source: string | null;
};

type MeridianLogger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

const MINUTE_MS = 60 * 1000;
const MERIDIAN_LOCK_LEASE_MS = 45 * MINUTE_MS;
const STARTED_GRACE_MS = 60 * 1000;

const MERIDIAN_SEEDED_LEAGUE_URLS: Record<number, Array<{ label: string; sourceUrl: string }>> = {
  1: [{ label: "Copa do Mundo 2026", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/mundo/copa-do-mundo-2026?leagueIds=176327" }],
  2: [{ label: "Liga dos Campeoes", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/europa/liga-dos-campe%C3%B5es?leagueIds=84" }],
  3: [{ label: "Liga Europa", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/europa/liga-europa?leagueIds=86" }],
  39: [{ label: "Premier League", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/inglaterra/premier-league?leagueIds=80" }],
  40: [{ label: "Campeonato", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/inglaterra/campeonato?leagueIds=122" }],
  61: [{ label: "Ligue 1", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/fran%C3%A7a/ligue-1?leagueIds=87" }],
  66: [{ label: "Copa da Franca", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/fran%C3%A7a/copa-da-fran%C3%A7a?leagueIds=221" }],
  71: [{ label: "Serie A", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/brasil/s%C3%A9rie-a?leagueIds=89" }],
  72: [{ label: "Serie B", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/brasil/s%C3%A9rie-b?leagueIds=90" }],
  73: [{ label: "Copa do Brasil", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/brasil/copa-do-brasil?leagueIds=217" }],
  78: [{ label: "Bundesliga", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/alemanha/bundesliga?leagueIds=107" }],
  79: [{ label: "2. Bundesliga", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/alemanha/2.-bundesliga?leagueIds=108" }],
  81: [{ label: "DFB Pokal", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/alemanha/dfb-pokal?leagueIds=235" }],
  88: [{ label: "Eredivisie", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/holanda/eredivisie?leagueIds=125" }],
  94: [{ label: "Portugal", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/portugu%C3%AAs/" }],
  119: [{ label: "Superliga", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/dinamarca/superliga?leagueIds=133" }],
  128: [{ label: "Liga Profissional", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/argentina/liga-profissional?leagueIds=174077" }],
  179: [{ label: "Premiership", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/esc%C3%B3cia/premiership?leagueIds=145" }],
  181: [{ label: "Cup", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/esc%C3%B3cia/cup?leagueIds=244" }],
  253: [{ label: "Major League Soccer", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/estados-unidos/major-league-soccer?leagueIds=284" }],
  848: [{ label: "Conferencia Liga Europa", sourceUrl: "https://meridianbet.bet.br/ca/esportes/futebol/europa/confer%C3%AAncia-liga-europa?leagueIds=173762" }]
};

function serializeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  try {
    return JSON.parse(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timestamp(value: string | number | Date) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function isPrematch(startsAt: string | number | Date, now = new Date()) {
  return timestamp(startsAt) > now.getTime() + STARTED_GRACE_MS;
}

function refreshIntervalMsForStart(startsAt: string | number | Date, now = new Date()) {
  const minutes = (timestamp(startsAt) - now.getTime()) / MINUTE_MS;
  if (minutes <= 120) return 10 * MINUTE_MS;
  if (minutes <= 360) return 30 * MINUTE_MS;
  if (minutes <= 24 * 60) return 60 * MINUTE_MS;
  return 4 * 60 * MINUTE_MS;
}

function formatDuration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  return `${minutes}m`;
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

function contextValue(context: Record<string, unknown>, key: string) {
  const value = context[key];
  return value == null ? "" : String(value);
}

function fixtureName(context: Record<string, unknown>) {
  const eventName = contextValue(context, "eventName");
  if (eventName) return eventName;
  return [contextValue(context, "homeTeam"), contextValue(context, "awayTeam")].filter(Boolean).join(" x ");
}

function formatMeridianConsoleLine(level: "info" | "warn" | "error", message: string, context: Record<string, unknown>) {
  const debugEnabled = process.env.MERIDIANBET_DEBUG === "true" || process.env.COLLECT_DEBUG === "true";
  if (debugEnabled) {
    const contextText = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
    return `[meridianbet] ${message}${contextText}`;
  }

  if (message === "iniciando Chrome real via CDP para meridianbet") return "[meridianbet] Abrindo Chrome real...";
  if (message === "perfil principal da meridianbet nao abriu CDP; tentando perfil temporario") return "[meridianbet] Perfil principal indisponivel; usando perfil temporario.";
  if (message === "fechando Chrome da meridianbet") return "[meridianbet] Fechando Chrome.";
  if (message === "links de ligas da meridianbet carregados") return `[meridianbet] Atalhos de liga: ${contextValue(context, "savedLinks")} salvos | ${contextValue(context, "seedLinks")} conhecidos.`;
  if (message === "abrindo liga da meridianbet por URL") return `[meridianbet] Abrindo liga por URL: ${contextValue(context, "label") || contextValue(context, "leagueName")}.`;
  if (message === "jogo aberto por URL cacheada da meridianbet") return `[meridianbet] URL salva abriu: ${fixtureName(context)}.`;
  if (message === "jogo pulado porque as odds da meridianbet ainda estao recentes") return `[meridianbet] Pulando ${fixtureName(context)}: odds recentes.`;
  if (message === "jogo da meridianbet salvo no banco") return `[meridianbet] Odds salvas: ${fixtureName(context)} | ${contextValue(context, "oddsUpserted")} odds.`;
  if (message === "jogo da meridianbet nao abriu") return `[meridianbet] Jogo nao aberto: ${fixtureName(context)}.`;
  if (message === "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado na meridianbet") return `[meridianbet] Jogo sem mercado 1X2: ${fixtureName(context)}.`;
  if (message === "liga da meridianbet sem link e sem jogos visiveis") return `[meridianbet] Liga sem link/jogos visiveis: ${contextValue(context, "leagueName")}.`;
  if (message === "meridianbet pulada porque outra coleta ainda esta rodando") return "[meridianbet] Coleta pulada: outra execucao ainda esta em andamento.";
  if (message === "coleta da meridianbet finalizada") return `[meridianbet] Coleta finalizada: ${contextValue(context, "eventsCollected")} jogos coletados | ${contextValue(context, "oddsUpserted")} odds salvas | ${contextValue(context, "errors")} erros.`;

  if (level === "error") return `[meridianbet] Erro: ${message}.`;
  return null;
}

function createLogger(bookmaker: MeridianbetBookmakerConfig, logToConsole: boolean): MeridianLogger {
  return async (level, message, context = {}) => {
    if (logToConsole) {
      const line = formatMeridianConsoleLine(level, message, context);
      if (line) {
        const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        method(line);
      }
    }

    await supabase.from("collection_logs").insert({
      bookmaker_slug: bookmaker.slug,
      level,
      message,
      context
    });
  };
}

async function ensureBaseRows(bookmaker: MeridianbetBookmakerConfig) {
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

async function getCollectionState(bookmaker: MeridianbetBookmakerConfig) {
  const { data, error } = await supabase
    .from("bookmaker_collection_state")
    .select("status,lease_until")
    .eq("bookmaker_slug", bookmaker.slug)
    .maybeSingle();

  if (error) throw error;
  return data as CollectionState | null;
}

async function acquireCollectionLock(bookmaker: MeridianbetBookmakerConfig) {
  const leaseUntil = new Date(Date.now() + MERIDIAN_LOCK_LEASE_MS).toISOString();
  const { data, error } = await supabase.rpc("try_acquire_bookmaker_collection_lock", {
    p_bookmaker_slug: bookmaker.slug,
    p_lease_until: leaseUntil
  });

  if (error) throw error;
  return Boolean(data);
}

async function releaseCollectionLock(bookmaker: MeridianbetBookmakerConfig, summary: unknown, status: "idle" | "error", lastError: string | null) {
  const { error } = await supabase
    .from("bookmaker_collection_state")
    .update({
      status,
      last_finished_at: new Date().toISOString(),
      lease_until: null,
      last_error: lastError,
      summary,
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
    if (row.enabled) activeByApiId.set(row.api_football_league_id, row);
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
    .select("id,api_football_fixture_id,name,league:leagues!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,starts_at,date_key")
    .in("date_key", dateKeys)
    .eq("leagues.enabled", true);

  if (options.futureOnly) builder = builder.gt("starts_at", new Date().toISOString());

  const { data, error } = await builder.order("starts_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as CanonicalFixture[];
}

function fixtureLeague(fixture: CanonicalFixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function fixtureTargetFromCanonical(fixture: CanonicalFixture): MeridianFixtureTarget {
  const league = fixtureLeague(fixture);
  return {
    id: fixture.id,
    homeTeam: fixture.home_team,
    awayTeam: fixture.away_team,
    leagueName: league?.name ?? null,
    leagueCountry: league?.country ?? null,
    startsAt: fixture.starts_at
  };
}

function shouldSkipFreshFixture(fixture: CanonicalFixture, lastUpdatedAt: string | undefined, now = new Date()) {
  if (!lastUpdatedAt) return { skip: false, refreshMs: refreshIntervalMsForStart(fixture.starts_at, now), ageMs: null as number | null };
  const refreshMs = refreshIntervalMsForStart(fixture.starts_at, now);
  const ageMs = now.getTime() - new Date(lastUpdatedAt).getTime();
  return { skip: Number.isFinite(ageMs) && ageMs >= 0 && ageMs < refreshMs, refreshMs, ageMs };
}

async function getLastOddsUpdatedByFixture(bookmakerSlug: string, fixtureIds: string[]) {
  const updatedByFixtureId = new Map<string, string>();
  if (!fixtureIds.length) return updatedByFixtureId;

  const { data, error } = await supabase
    .from("odds")
    .select("fixture_id,updated_at")
    .eq("bookmaker_slug", bookmakerSlug)
    .in("fixture_id", fixtureIds)
    .order("updated_at", { ascending: false });

  if (error) throw error;
  for (const row of (data ?? []) as Array<{ fixture_id: string; updated_at: string }>) {
    if (!updatedByFixtureId.has(row.fixture_id)) updatedByFixtureId.set(row.fixture_id, row.updated_at);
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
    if (row.source_url && !urlByFixtureId.has(row.fixture_id)) urlByFixtureId.set(row.fixture_id, row.source_url);
  }
  return urlByFixtureId;
}

async function getCachedLeagueLinks(bookmakerSlug: string, leagueIds: number[]) {
  const linksByLeagueId = new Map<number, MeridianLeagueLinkRow>();
  if (!leagueIds.length) return linksByLeagueId;

  const { data, error } = await supabase
    .from("bookmaker_league_links")
    .select("api_football_league_id,source_url,bookmaker_league_name,source")
    .eq("bookmaker_slug", bookmakerSlug)
    .in("api_football_league_id", leagueIds);

  if (error) throw error;
  for (const row of (data ?? []) as unknown as MeridianLeagueLinkRow[]) {
    if (row.source_url) linksByLeagueId.set(Number(row.api_football_league_id), { ...row, api_football_league_id: Number(row.api_football_league_id) });
  }
  return linksByLeagueId;
}

function leagueUrlCandidates(bookmaker: MeridianbetBookmakerConfig, league: ActiveLeague, savedLinks: Map<number, MeridianLeagueLinkRow>) {
  const candidates: Array<{ source: "saved" | "seed" | "fallback"; label: string; sourceUrl: string }> = [];
  const saved = savedLinks.get(league.api_football_league_id);
  if (saved?.source_url) candidates.push({ source: "saved", label: saved.bookmaker_league_name ?? league.name, sourceUrl: saved.source_url });
  for (const seed of MERIDIAN_SEEDED_LEAGUE_URLS[league.api_football_league_id] ?? []) candidates.push({ ...seed, source: "seed" });
  const countryUrl = meridianCountryUrl(bookmaker, league);
  if (countryUrl) candidates.push({ source: "fallback", label: league.country ?? league.name, sourceUrl: countryUrl });
  candidates.push({ source: "fallback", label: "Futebol", sourceUrl: new URL("/ca/esportes/futebol", bookmaker.baseUrl).toString() });

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.sourceUrl)) return false;
    seen.add(candidate.sourceUrl);
    return true;
  });
}

function meridianCountryUrl(bookmaker: MeridianbetBookmakerConfig, league: ActiveLeague) {
  const pathByCountry = new Map<string, string>([
    ["argentina", "/ca/esportes/futebol/argentina"],
    ["belgium", "/ca/esportes/futebol/b%C3%A9lgica"],
    ["brazil", "/ca/esportes/futebol/brasil"],
    ["denmark", "/ca/esportes/futebol/dinamarca"],
    ["england", "/ca/esportes/futebol/inglaterra"],
    ["france", "/ca/esportes/futebol/fran%C3%A7a"],
    ["germany", "/ca/esportes/futebol/alemanha"],
    ["italy", "/ca/esportes/futebol/it%C3%A1lia"],
    ["netherlands", "/ca/esportes/futebol/holanda"],
    ["portugal", "/ca/esportes/futebol/portugu%C3%AAs/"],
    ["scotland", "/ca/esportes/futebol/esc%C3%B3cia"],
    ["spain", "/ca/esportes/futebol/espanha"],
    ["turkey", "/ca/esportes/futebol/turquia"],
    ["usa", "/ca/esportes/futebol/estados-unidos"]
  ]);
  const countryKey = normalizeName(league.country);
  const worldPathByLeagueId = new Map<number, string>([
    [1, "/ca/esportes/futebol/mundo"],
    [2, "/ca/esportes/futebol/europa"],
    [3, "/ca/esportes/futebol/europa"],
    [11, "/ca/esportes/futebol/am%C3%A9rica-do-sul"],
    [13, "/ca/esportes/futebol/am%C3%A9rica-do-sul"],
    [848, "/ca/esportes/futebol/europa"]
  ]);
  const path = pathByCountry.get(countryKey) ?? worldPathByLeagueId.get(league.api_football_league_id);
  return path ? new URL(path, bookmaker.baseUrl).toString() : null;
}

async function saveLeagueLink(bookmaker: MeridianbetBookmakerConfig, league: ActiveLeague, sourceUrl: string, label: string, source: string) {
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("bookmaker_league_links").upsert(
    {
      bookmaker_slug: bookmaker.slug,
      api_football_league_id: league.api_football_league_id,
      league_name: league.name,
      league_country: league.country,
      source_url: sourceUrl,
      bookmaker_league_name: label,
      source,
      raw: { source, label },
      last_verified_at: updatedAt,
      updated_at: updatedAt
    },
    { onConflict: "bookmaker_slug,api_football_league_id" }
  );
  if (error) throw error;
}

function buildBookmakerLink(bookmaker: MeridianbetBookmakerConfig, fixture: CanonicalFixture, event: MeridianCollectedEvent): BookmakerLinkRow {
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.externalEventId,
    fixture_id: fixture.id,
    bookmaker_event_name: event.eventName || `${fixture.home_team} x ${fixture.away_team}`,
    bookmaker_home_team: fixture.home_team,
    bookmaker_away_team: fixture.away_team,
    normalized_bookmaker_home_team: normalizeName(fixture.home_team),
    normalized_bookmaker_away_team: normalizeName(fixture.away_team),
    starts_at: fixture.starts_at,
    match_confidence_score: 1,
    source_url: event.sourceUrl,
    raw: { sourceUrl: event.sourceUrl, rawText: event.rawText, markets: event.markets },
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: MeridianbetBookmakerConfig, fixture: CanonicalFixture, event: MeridianCollectedEvent): OddRow[] {
  const rows: OddRow[] = [];
  for (const market of event.markets) {
    for (const selection of market.selections) {
      rows.push({
        fixture_id: fixture.id,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection: selection.selection,
        price: selection.price,
        pa_category: market.paCategory,
        confidence_score: market.confidence,
        raw_market_name: market.marketName,
        raw_label: selection.label,
        raw_odd_type: selection.selection,
        source_odd_id: event.externalEventId * 1000 + market.index * 10 + selection.index,
        raw: { sourceUrl: event.sourceUrl, market, selection },
        updated_at: new Date().toISOString()
      });
    }
  }

  return [...new Map(rows.map((row) => [`${row.fixture_id}:${row.selection}:${row.pa_category}`, row])).values()];
}

async function persistCollectedEvent(bookmaker: MeridianbetBookmakerConfig, fixture: CanonicalFixture, event: MeridianCollectedEvent, logger: MeridianLogger) {
  if (!event.markets.length) {
    await logger("warn", "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado na meridianbet", {
      fixtureId: fixture.id,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team,
      sourceUrl: event.sourceUrl,
      textSample: event.rawText.slice(0, 700)
    });
    return { oddsFound: 0, oddsUpserted: 0 };
  }

  const link = buildBookmakerLink(bookmaker, fixture, event);
  const odds = buildMoneylineOdds(bookmaker, fixture, event);
  const oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, [link], odds);

  await logger("info", "jogo da meridianbet salvo no banco", {
    fixtureId: fixture.id,
    eventName: event.eventName,
    sourceUrl: event.sourceUrl,
    oddsFound: odds.length,
    oddsUpserted
  });

  return { oddsFound: odds.length, oddsUpserted };
}

export function createMeridianbetCollector(bookmaker: MeridianbetBookmakerConfig) {
  return async function collectMeridianbet(options: BookmakerCollectOptions = {}) {
    const logger = createLogger(bookmaker, options.logToConsole ?? true);
    const dateKeys = targetDateKeys(options.date);
    const summary = {
      trigger: options.trigger ?? "manual",
      force: Boolean(options.force),
      targetDateKeys: dateKeys,
      skipped: false,
      skipReason: null as string | null,
      activeLeagues: 0,
      leaguesTargeted: 0,
      leaguesOpened: 0,
      leaguesSkipped: 0,
      fixturesAvailable: 0,
      fixturesTargeted: 0,
      eventsOpened: 0,
      eventsOpenedFromCache: 0,
      eventsCollected: 0,
      eventsWithoutOdds: 0,
      eventsSkippedFresh: 0,
      eventsSkippedStarted: 0,
      eventsUnmatched: 0,
      oddsFound: 0,
      oddsUpserted: 0,
      errors: 0,
      lastError: null as string | null
    };

    await ensureBaseRows(bookmaker);
    const activeLeagues = await getActiveLeagues();
    summary.activeLeagues = activeLeagues.length;

    let fixtures = await getCanonicalFixtures(dateKeys, { futureOnly: true });
    if (!fixtures.length) {
      await logger("warn", "fixtures locais incompletos para a meridianbet; sincronizando API-Football antes de abrir o navegador", { dateKeys });
      await syncApiFootballFixtures();
      fixtures = await getCanonicalFixtures(dateKeys, { futureOnly: true });
    }

    summary.fixturesAvailable = fixtures.length;
    if (!fixtures.length) {
      summary.skipped = true;
      summary.skipReason = "no-future-fixtures";
      await logger("info", "coleta da meridianbet finalizada", summary);
      return summary;
    }

    const fixtureLeagueIds = new Set<number>();
    for (const fixture of fixtures) {
      const league = fixtureLeague(fixture);
      if (league) fixtureLeagueIds.add(Number(league.api_football_league_id));
    }

    const activeLeagueByApiId = new Map(activeLeagues.map((league) => [league.api_football_league_id, league]));
    const targetLeagues = activeLeagues.filter((league) => fixtureLeagueIds.has(league.api_football_league_id));
    summary.leaguesTargeted = targetLeagues.length;
    summary.fixturesTargeted = fixtures.length;

    if (!targetLeagues.length) {
      summary.skipped = true;
      summary.skipReason = "no-target-leagues-with-fixtures";
      await logger("info", "coleta da meridianbet finalizada", summary);
      return summary;
    }

    const state = await getCollectionState(bookmaker);
    const lockAcquired = await acquireCollectionLock(bookmaker);
    if (!lockAcquired) {
      summary.skipped = true;
      summary.skipReason = "already-running";
      await logger("warn", "meridianbet pulada porque outra coleta ainda esta rodando", {
        leaseUntil: state?.lease_until ?? null,
        status: state?.status ?? null
      });
      return summary;
    }

    const fixtureIds = fixtures.map((fixture) => fixture.id);
    const [lastOddsByFixtureId, cachedUrlByFixtureId, cachedLeagueLinkByApiId] = await Promise.all([
      getLastOddsUpdatedByFixture(bookmaker.slug, fixtureIds),
      getCachedEventUrls(bookmaker.slug, fixtureIds),
      getCachedLeagueLinks(bookmaker.slug, targetLeagues.map((league) => league.api_football_league_id))
    ]);

    await logger("info", "links de ligas da meridianbet carregados", {
      savedLinks: cachedLeagueLinkByApiId.size,
      seedLinks: targetLeagues.reduce((total, league) => total + (MERIDIAN_SEEDED_LEAGUE_URLS[league.api_football_league_id]?.length ?? 0), 0)
    });

    const client = new MeridianbetBrowserClient(bookmaker, logger);
    const processedFixtureIds = new Set<string>();

    try {
      await client.start();

      for (const fixture of fixtures) {
        const league = fixtureLeague(fixture);
        const activeLeague = league ? activeLeagueByApiId.get(Number(league.api_football_league_id)) : null;
        if (!activeLeague) continue;

        if (!isPrematch(fixture.starts_at)) {
          summary.eventsSkippedStarted += 1;
          processedFixtureIds.add(fixture.id);
          continue;
        }

        const freshness = shouldSkipFreshFixture(fixture, lastOddsByFixtureId.get(fixture.id));
        if (!summary.force && freshness.skip) {
          processedFixtureIds.add(fixture.id);
          summary.eventsSkippedFresh += 1;
          await logger("info", "jogo pulado porque as odds da meridianbet ainda estao recentes", {
            fixtureId: fixture.id,
            homeTeam: fixture.home_team,
            awayTeam: fixture.away_team,
            startsAt: fixture.starts_at,
            refreshEvery: formatDuration(freshness.refreshMs)
          });
          continue;
        }

        const cachedUrl = cachedUrlByFixtureId.get(fixture.id);
        if (!cachedUrl) continue;

        const target = fixtureTargetFromCanonical(fixture);
        try {
          await client.goToUrl(cachedUrl, "abrindo jogo da meridianbet por URL em cache");
          if (!(await client.verifyCurrentEvent(target))) continue;
          summary.eventsOpened += 1;
          summary.eventsOpenedFromCache += 1;
          await logger("info", "jogo aberto por URL cacheada da meridianbet", {
            fixtureId: fixture.id,
            homeTeam: fixture.home_team,
            awayTeam: fixture.away_team
          });

          const event = await client.collectCurrentEvent(target);
          summary.eventsCollected += 1;
          if (!event.markets.length) summary.eventsWithoutOdds += 1;
          const persisted = await persistCollectedEvent(bookmaker, fixture, event, logger);
          summary.oddsFound += persisted.oddsFound;
          summary.oddsUpserted += persisted.oddsUpserted;
          processedFixtureIds.add(fixture.id);
          if (persisted.oddsUpserted > 0) lastOddsByFixtureId.set(fixture.id, new Date().toISOString());
        } catch (error) {
          summary.errors += 1;
          summary.lastError = errorMessage(error);
          await logger("error", "falha ao coletar jogo da meridianbet por URL cacheada", { fixtureId: fixture.id, error: serializeError(error) });
        }
      }

      for (const league of targetLeagues) {
        const leagueFixtures = fixtures.filter(
          (fixture) => !processedFixtureIds.has(fixture.id) && fixtureLeague(fixture)?.api_football_league_id === league.api_football_league_id
        );
        if (!leagueFixtures.length) continue;

        let leagueOpened = false;
        for (const candidate of leagueUrlCandidates(bookmaker, league, cachedLeagueLinkByApiId)) {
          await logger("info", "abrindo liga da meridianbet por URL", {
            leagueName: league.name,
            apiFootballLeagueId: league.api_football_league_id,
            label: candidate.label,
            source: candidate.source,
            sourceUrl: candidate.sourceUrl
          });
          await client.goToUrl(candidate.sourceUrl, "navegando para URL de liga da meridianbet");
          await client.selectAllPeriod();

          const hasFixture = await client.pageHasFixturePair(leagueFixtures.map((fixture) => fixtureTargetFromCanonical(fixture)));
          if (!hasFixture && candidate.source === "fallback") {
            summary.leaguesSkipped += 1;
            await logger("warn", "liga da meridianbet sem link e sem jogos visiveis", {
              leagueName: league.name,
              fixtures: leagueFixtures.length
            });
            continue;
          }

          leagueOpened = true;
          summary.leaguesOpened += 1;
          await saveLeagueLink(bookmaker, league, client.currentUrl(), candidate.label, candidate.source);

          for (const fixture of leagueFixtures) {
            try {
              const target = fixtureTargetFromCanonical(fixture);
              const opened = await client.openFixture(target);
              if (!opened) {
                summary.eventsUnmatched += 1;
                await logger("warn", "jogo da meridianbet nao abriu", {
                  fixtureId: fixture.id,
                  homeTeam: fixture.home_team,
                  awayTeam: fixture.away_team
                });
                await client.goToUrl(client.currentUrl(), "voltando para a liga da meridianbet apos falha").catch(() => undefined);
                continue;
              }

              summary.eventsOpened += 1;
              const event = await client.collectCurrentEvent(target);
              summary.eventsCollected += 1;
              if (!event.markets.length) summary.eventsWithoutOdds += 1;
              const persisted = await persistCollectedEvent(bookmaker, fixture, event, logger);
              summary.oddsFound += persisted.oddsFound;
              summary.oddsUpserted += persisted.oddsUpserted;
              processedFixtureIds.add(fixture.id);
              if (event.sourceUrl) cachedUrlByFixtureId.set(fixture.id, event.sourceUrl);
              if (persisted.oddsUpserted > 0) lastOddsByFixtureId.set(fixture.id, new Date().toISOString());

              await client.goToUrl(candidate.sourceUrl, "voltando para a liga da meridianbet apos coletar jogo");
              await client.selectAllPeriod();
            } catch (error) {
              summary.errors += 1;
              summary.lastError = errorMessage(error);
              await logger("error", "falha ao coletar jogo da meridianbet", {
                leagueName: league.name,
                fixtureId: fixture.id,
                homeTeam: fixture.home_team,
                awayTeam: fixture.away_team,
                error: serializeError(error)
              });
              await client.goToUrl(candidate.sourceUrl, "voltando para a liga da meridianbet apos erro").catch(() => undefined);
            }
          }
          break;
        }

        if (!leagueOpened) summary.leaguesSkipped += 1;
      }
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await logger("error", "coleta da meridianbet falhou", { error: serializeError(error) });
    } finally {
      await client.stop().catch(async (error) => {
        summary.errors += 1;
        summary.lastError = errorMessage(error);
        await logger("error", "falha ao fechar Chrome da meridianbet", { error: serializeError(error) });
      });
      await releaseCollectionLock(bookmaker, summary, summary.errors ? "error" : "idle", summary.lastError).catch(async (error) => {
        summary.errors += 1;
        summary.lastError = errorMessage(error);
        await logger("error", "falha ao atualizar estado da coleta da meridianbet", { error: serializeError(error) });
      });
    }

    await logger("info", "coleta da meridianbet finalizada", summary);
    return summary;
  };
}

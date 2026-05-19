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
import { requestBookmakerLeagueUrl, resolveBookmakerLeagueUrlRequest } from "./bookmaker-league-url-requests.js";
import {
  isFixturePrematchForOddsRefresh as isPrematch,
  refreshIntervalMsForStart,
  shouldUseFixtureRefreshCadence
} from "./collector-resilience.js";

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

type Bet365LeagueLinkRow = {
  api_football_league_id: number;
  source_url: string;
  bookmaker_league_name: string | null;
  source: string | null;
  raw?: unknown;
  updated_at?: string | null;
};

type Bet365LeagueUrlSeed = {
  label: string;
  sourceUrl: string;
};

type Bet365LeagueUrlCandidate = Bet365LeagueUrlSeed & {
  source: "saved" | "seed";
};

type Bet365Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

const MINUTE_MS = 60 * 1000;

const BET365_SEEDED_LEAGUE_URLS: Record<number, Bet365LeagueUrlSeed[]> = {
  1: [{ label: "Copa do Mundo", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E131901075/G40/" }],
  2: [{ label: "Champions League", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E94400598/G40/" }],
  3: [{ label: "Europa League", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E123393868/G40/" }],
  11: [{ label: "Copa Sul-Americana", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E101830177/G40/" }],
  13: [{ label: "Libertadores", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E131418680/G40/" }],
  39: [{ label: "Premier League", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E91422157/G40/H%5E1/" }],
  40: [{ label: "Championship", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E91717201/G40/" }],
  45: [{ label: "FA Cup", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E124926235/G40/H%5E1/" }],
  61: [
    { label: "Ligue 1", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E120498572/G40/" },
    { label: "Ligue 1 Play-Offs", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E133565227/G40/" }
  ],
  66: [{ label: "Coupe de France", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E130578596/G40/" }],
  71: [{ label: "Brasileirao Serie A", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E88369731/G40/" }],
  72: [{ label: "Brasileirao Serie B", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E102584281/G40/" }],
  78: [{ label: "Bundesliga", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E120439499/G40/H%5E1/" }],
  79: [{ label: "2. Bundesliga", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E120439701/G40/" }],
  81: [{ label: "DFB Pokal", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E132422263/G40/" }],
  88: [{ label: "Eredivisie", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E92212336/G40/" }],
  94: [{ label: "Portugal Primeira Liga", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E121080183/G40/" }],
  119: [{ label: "Danish Superliga", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E130985935/G40/" }],
  128: [{ label: "Argentina Liga Profesional", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E98752003/G40/" }],
  135: [{ label: "Serie A", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E92269709/G40/H%5E1/" }],
  140: [{ label: "La Liga", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E120757998/G40/" }],
  141: [{ label: "La Liga 2", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E120794896/G40/" }],
  144: [{ label: "Belgium First Division A", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E131845194/G40/" }],
  179: [
    { label: "Scottish Premiership", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E120060777/G40/H%5E1/" },
    { label: "Scottish Premiership Play-Offs", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E133206267/G40/" }
  ],
  181: [{ label: "Scottish FA Cup", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E132330941/G40/" }],
  203: [{ label: "Turkiye Super Lig", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E131844873/G40/" }],
  253: [{ label: "USA MLS", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E128717444/G40/" }],
  848: [{ label: "Conference League", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E128898427/G40/" }]
};

let leagueLinkTableMissingWarned = false;

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  if (message === "ligas selecionadas para navegacao na bet365") {
    return `[bet365] Jogos alvo: ${contextValue(context, "fixturesTargeted")} | Ligas alvo: ${contextValue(context, "targetLeagues")}.`;
  }
  if (message === "checando URLs cacheadas da bet365") {
    return `[bet365] Conferindo URLs salvas: ${contextValue(context, "cachedUrls")} jogos com atalho.`;
  }
  if (message === "links de ligas da bet365 carregados") {
    return `[bet365] Atalhos de liga: ${contextValue(context, "savedLinks")} salvos | ${contextValue(context, "seedLinks")} conhecidos.`;
  }
  if (message === "cache de links de liga da bet365 indisponivel; rode db:setup para habilitar") {
    return "[bet365] Cache de liga indisponivel; rode npm run db:setup para salvar atalhos novos.";
  }
  if (message === "abrindo liga da bet365 por URL") {
    return `[bet365] Abrindo liga por URL (${contextValue(context, "source")}): ${contextValue(context, "label") || contextValue(context, "leagueName")}.`;
  }
  if (message === "URL de liga da bet365 sem jogos alvo") {
    return `[bet365] URL da liga sem jogos alvo: ${contextValue(context, "leagueName")} (${contextValue(context, "label")}).`;
  }
  if (message === "link de liga salvo para a bet365") {
    return `[bet365] Link da liga salvo: ${contextValue(context, "leagueName")} -> ${contextValue(context, "label")}.`;
  }
  if (message === "pendencia de URL de liga criada") {
    return `[bet365] URL da liga precisa de ajuste: ${contextValue(context, "leagueName")}.`;
  }
  if (message === "pendencias de URL de liga indisponiveis; rode db:setup para habilitar") {
    return "[bet365] Pendencias de URL indisponiveis; rode npm run db:setup para habilitar.";
  }
  if (message === "jogo aberto por URL cacheada da bet365") {
    return `[bet365] URL salva abriu: ${fixtureName(context)}.`;
  }
  if (message === "procurando liga nas competicoes da bet365") return `[bet365] Procurando liga em Competições: ${contextValue(context, "leagueName")}.`;
  if (message === "clicando liga nas competicoes da bet365") return `[bet365] Abrindo liga em Competições: ${contextValue(context, "selectedLabel")}.`;
  if (message === "nao consegui abrir a liga nas competicoes da bet365") return `[bet365] Liga não aberta em Competições: ${contextValue(context, "leagueName")}.`;
  if (message === "tentando abrir jogos restantes pela pagina da liga") {
    return `[bet365] Tentando abrir jogos restantes pela liga ${contextValue(context, "leagueName")}: ${contextValue(context, "fixtures")} jogos.`;
  }
  if (message === "reabrindo jogo pela liga da bet365") {
    return `[bet365] Reabrindo jogo pela liga (${contextValue(context, "attempt")}/${contextValue(context, "attempts")}): ${fixtureName(context)}.`;
  }
  if (message === "pagina do evento abriu, mas nao confirmou os times na bet365") return `[bet365] Evento abriu sem confirmar times: ${fixtureName(context)}.`;
  if (message === "jogo sem mercado 1X2; reabrindo pela liga") {
    return `[bet365] Sem mercado 1X2; reabrindo pela liga (${contextValue(context, "attempt")}/${contextValue(context, "attempts")}): ${fixtureName(context)}.`;
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

async function updateCollectionState(bookmaker: Bet365BookmakerConfig, values: Record<string, unknown>) {
  const { error } = await supabase
    .from("bookmaker_collection_state")
    .update({
      status: "idle",
      lease_until: null,
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

function timeFromIso(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function fixtureTargetFromCanonical(fixture: CanonicalFixture): Bet365FixtureTarget {
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

function leagueForFixture(fixture: CanonicalFixture, activeLeagueByApiId: Map<number, ActiveLeague>) {
  const league = fixtureLeague(fixture);
  if (!league) return null;
  return activeLeagueByApiId.get(Number(league.api_football_league_id)) ?? null;
}

function rawEventFromFixture(league: ActiveLeague, fixture: CanonicalFixture, event: Bet365CollectedEvent): Bet365RawEvent {
  return {
    league,
    candidate: {
      externalEventId: event.externalEventId,
      homeTeam: fixture.home_team ?? event.eventName.split(" x ")[0] ?? "",
      awayTeam: fixture.away_team ?? event.eventName.split(" x ")[1] ?? "",
      startsAt: fixture.starts_at,
      dateKey: fixture.date_key,
      startTime: timeFromIso(fixture.starts_at),
      sourceText: event.eventName,
      sourceUrl: event.sourceUrl
    },
    event
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

function isMissingLeagueLinksTable(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = errorMessage(error);
  return code === "42P01" || /bookmaker_league_links|relation .* does not exist/i.test(message);
}

function leagueUrlCandidates(league: ActiveLeague, savedLinks: Map<number, Bet365LeagueLinkRow>) {
  const candidates: Bet365LeagueUrlCandidate[] = [];
  const saved = savedLinks.get(league.api_football_league_id);

  if (saved?.source_url) {
    candidates.push({
      source: "saved",
      label: saved.bookmaker_league_name ?? league.name,
      sourceUrl: saved.source_url
    });
  }

  for (const seed of BET365_SEEDED_LEAGUE_URLS[league.api_football_league_id] ?? []) {
    candidates.push({ ...seed, source: "seed" });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.sourceUrl.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getCachedLeagueLinks(bookmakerSlug: string, leagueIds: number[], logger: Bet365Logger) {
  const linksByLeagueId = new Map<number, Bet365LeagueLinkRow>();
  if (!leagueIds.length) return linksByLeagueId;

  const { data, error } = await supabase
    .from("bookmaker_league_links")
    .select("api_football_league_id,source_url,bookmaker_league_name,source,raw,updated_at")
    .eq("bookmaker_slug", bookmakerSlug)
    .in("api_football_league_id", leagueIds);

  if (error) {
    if (isMissingLeagueLinksTable(error)) {
      if (!leagueLinkTableMissingWarned) {
        leagueLinkTableMissingWarned = true;
        await logger("warn", "cache de links de liga da bet365 indisponivel; rode db:setup para habilitar", { error: serializeError(error) });
      }
      return linksByLeagueId;
    }

    throw error;
  }

  for (const row of (data ?? []) as unknown as Bet365LeagueLinkRow[]) {
    if (!row.source_url) continue;
    linksByLeagueId.set(Number(row.api_football_league_id), {
      ...row,
      api_football_league_id: Number(row.api_football_league_id)
    });
  }

  return linksByLeagueId;
}

async function saveLeagueLink(
  bookmaker: Bet365BookmakerConfig,
  league: ActiveLeague,
  sourceUrl: string,
  label: string | null,
  source: "seed" | "discovered" | "saved",
  logger: Bet365Logger
) {
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
      raw: {
        league,
        label,
        source
      },
      last_verified_at: updatedAt,
      updated_at: updatedAt
    },
    { onConflict: "bookmaker_slug,api_football_league_id" }
  );

  if (error) {
    if (isMissingLeagueLinksTable(error)) {
      if (!leagueLinkTableMissingWarned) {
        leagueLinkTableMissingWarned = true;
        await logger("warn", "cache de links de liga da bet365 indisponivel; rode db:setup para habilitar", { error: serializeError(error) });
      }
      return false;
    }

    throw error;
  }

  await logger("info", "link de liga salvo para a bet365", {
    leagueName: league.name,
    apiFootballLeagueId: league.api_football_league_id,
    label: label ?? league.name,
    source,
    sourceUrl
  });
  await resolveBookmakerLeagueUrlRequest(bookmaker.slug, league, sourceUrl, logger);
  return true;
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

async function collectCurrentEventWithMarketRetries(
  client: Bet365BrowserClient,
  target: Bet365FixtureTarget,
  leagueUrl: string,
  logger: Bet365Logger,
  context: { leagueName: string; homeTeam: string | null; awayTeam: string | null }
) {
  let event = await client.collectCurrentEvent(target);

  for (let attempt = 2; !event.markets.length && attempt <= 3; attempt += 1) {
    await logger("warn", "jogo sem mercado 1X2; reabrindo pela liga", {
      ...context,
      fixtureId: target.id,
      sourceUrl: event.sourceUrl,
      attempt,
      attempts: 3
    });

    await client.goToUrl(leagueUrl, "voltando para a liga antes de reabrir jogo sem mercado");
    const reopened = await client.openFixtureWithRetries(target, leagueUrl, 1);
    if (!reopened) break;
    event = await client.collectCurrentEvent(target);
  }

  return event;
}

export function createBet365Collector(bookmaker: Bet365BookmakerConfig) {
  return async function collectBet365(options: BookmakerCollectOptions = {}) {
    const logger = createLogger(bookmaker, options.logToConsole ?? true);
    const dateKeys = targetDateKeys(options.date);
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
      summary.nextRunAt = null;
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
      summary.nextRunAt = null;
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

    const activeLeagueByApiId = new Map(activeLeagues.map((league) => [league.api_football_league_id, league]));
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
      summary.nextRunAt = null;
      await logger("warn", "nenhuma liga ativa possui jogos futuros nas datas alvo da bet365", {
        dateKeys,
        fixturesAvailable: fixtures.length,
        activeLeagues: activeLeagues.length
      });
      await updateCollectionState(bookmaker, { next_run_at: summary.nextRunAt, last_error: null, summary });
      await logger("info", "coleta da bet365 finalizada", summary);
      return summary;
    }

    summary.collectionInterval = "por jogo";

    const fixtureIds = fixtures.map((fixture) => fixture.id);
    const targetLeagueIds = targetLeagues.map((league) => league.api_football_league_id);
    const [lastOddsByFixtureId, cachedUrlByFixtureId, cachedLeagueLinkByApiId] = await Promise.all([
      getLastOddsUpdatedByFixture(bookmaker.slug, fixtureIds),
      getCachedEventUrls(bookmaker.slug, fixtureIds),
      getCachedLeagueLinks(bookmaker.slug, targetLeagueIds, logger)
    ]);
    await logger("info", "links de ligas da bet365 carregados", {
      savedLinks: cachedLeagueLinkByApiId.size,
      seedLinks: targetLeagueIds.reduce((total, leagueId) => total + (BET365_SEEDED_LEAGUE_URLS[leagueId]?.length ?? 0), 0)
    });
    const client = new Bet365BrowserClient({ ...bookmaker, manualFallback: false }, logger);
    const processedFixtureIds = new Set<string>();

    try {
      await client.start();
      await client.openHome();

      await logger("info", "checando URLs cacheadas da bet365", {
        fixturesTargeted: fixtures.length,
        cachedUrls: cachedUrlByFixtureId.size
      });

      for (const fixture of fixtures) {
        const league = leagueForFixture(fixture, activeLeagueByApiId);
        if (!league) continue;

        if (!isPrematch(fixture.starts_at)) {
          processedFixtureIds.add(fixture.id);
          summary.eventsSkippedStarted += 1;
          await logger("info", "jogo ignorado porque ja comecou ou esta perto demais do inicio", {
            fixtureId: fixture.id,
            homeTeam: fixture.home_team,
            awayTeam: fixture.away_team,
            startsAt: fixture.starts_at
          });
          continue;
        }

        const freshness = shouldSkipFreshFixture(fixture, lastOddsByFixtureId.get(fixture.id));
        if (shouldUseFixtureRefreshCadence({ trigger, force }) && freshness.skip) {
          processedFixtureIds.add(fixture.id);
          summary.eventsSkippedFresh += 1;
          await logger("info", "jogo pulado porque as odds da bet365 ainda estao recentes", {
            fixtureId: fixture.id,
            homeTeam: fixture.home_team,
            awayTeam: fixture.away_team,
            startsAt: fixture.starts_at,
            refreshEvery: formatDuration(freshness.refreshMs),
            age: freshness.ageMs === null ? null : formatDuration(freshness.ageMs),
            lastUpdatedAt: lastOddsByFixtureId.get(fixture.id)
          });
          continue;
        }

        const cachedUrl = cachedUrlByFixtureId.get(fixture.id);
        if (!cachedUrl) continue;

        const target = fixtureTargetFromCanonical(fixture);
        try {
          await client.goToUrl(cachedUrl, "abrindo jogo da bet365 por URL em cache");
          const openedEvent = await client.verifyCurrentEvent(target);
          if (!openedEvent) {
            await logger("warn", "URL em cache da bet365 nao abriu o jogo esperado", {
              fixtureId: fixture.id,
              cachedUrl,
              homeTeam: fixture.home_team,
              awayTeam: fixture.away_team
            });
            continue;
          }

          summary.eventsOpened += 1;
          summary.eventsOpenedFromCache += 1;
          await logger("info", "jogo aberto por URL cacheada da bet365", {
            fixtureId: fixture.id,
            homeTeam: fixture.home_team,
            awayTeam: fixture.away_team,
            startsAt: fixture.starts_at
          });

          const event = await client.collectCurrentEvent(target);
          const rawEvent = rawEventFromFixture(league, fixture, event);
          summary.eventsCollected += 1;

          if (!event.markets.length) {
            summary.eventsWithoutOdds += 1;
            await logger("warn", "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado", {
              leagueName: league.name,
              homeTeam: fixture.home_team,
              awayTeam: fixture.away_team,
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
          processedFixtureIds.add(fixture.id);

          if (persisted.fixtureId && persisted.oddsUpserted > 0) {
            const savedAt = new Date().toISOString();
            lastOddsByFixtureId.set(persisted.fixtureId, savedAt);
            if (event.sourceUrl) cachedUrlByFixtureId.set(persisted.fixtureId, event.sourceUrl);
          }
        } catch (error) {
          summary.errors += 1;
          summary.lastError = errorMessage(error);
          await logger("error", "falha ao coletar jogo da bet365 por URL cacheada", {
            fixtureId: fixture.id,
            homeTeam: fixture.home_team,
            awayTeam: fixture.away_team,
            cachedUrl,
            error: serializeError(error)
          });
        }
      }

      const remainingFixturesForNavigation = fixtures.filter((fixture) => !processedFixtureIds.has(fixture.id));
      const remainingLeagueIds = new Set(
        remainingFixturesForNavigation
          .map((fixture) => fixtureLeague(fixture)?.api_football_league_id)
          .filter((id): id is number => typeof id === "number")
      );
      const navigationTargetLeagues = targetLeagues.filter((league) => remainingLeagueIds.has(league.api_football_league_id));

      await logger("info", "ligas selecionadas para navegacao na bet365", {
        targetLeagues: navigationTargetLeagues.length,
        skippedWithoutFixtures: summary.leaguesSkippedNoFixtures,
        fixturesTargeted: remainingFixturesForNavigation.length,
        leagues: navigationTargetLeagues.map((league) => ({
          id: league.api_football_league_id,
          name: league.name,
          country: league.country
        }))
      });

      for (const league of navigationTargetLeagues) {
        try {
          const leagueFixtures = fixtures.filter(
            (fixture) => !processedFixtureIds.has(fixture.id) && fixtureLeague(fixture)?.api_football_league_id === league.api_football_league_id
          );
          if (!leagueFixtures.length) continue;

          const expectedTeamNames = leagueFixtures.flatMap((fixture) => [fixture.home_team, fixture.away_team]).filter((name): name is string => Boolean(name));

          let openedLeague = false;
          let leagueUrl = "";
          let openedLeagueLabel: string | null = null;
          let leagueEvents: Bet365LeagueEventCandidate[] | null = null;

          for (const candidate of leagueUrlCandidates(league, cachedLeagueLinkByApiId)) {
            await logger("info", "abrindo liga da bet365 por URL", {
              leagueName: league.name,
              apiFootballLeagueId: league.api_football_league_id,
              label: candidate.label,
              source: candidate.source,
              sourceUrl: candidate.sourceUrl
            });

            await client.goToUrl(candidate.sourceUrl, "navegando para URL de liga da bet365");
            const collectedEvents = await client.collectLeagueEvents(dateKeys);
            const matchedEventsCount = collectedEvents.filter((eventCandidate) =>
              Boolean(findBestMatch(rawEventPlaceholder(league, eventCandidate), fixtures))
            ).length;
            const pageHasTargetFixture = await client.pageHasFixturePair(leagueFixtures.map((fixture) => fixtureTargetFromCanonical(fixture)));

            if (matchedEventsCount > 0 || pageHasTargetFixture) {
              openedLeague = true;
              leagueUrl = client.currentUrl();
              openedLeagueLabel = candidate.label;
              leagueEvents = collectedEvents;
              await saveLeagueLink(bookmaker, league, leagueUrl, candidate.label, candidate.source, logger);
              cachedLeagueLinkByApiId.set(league.api_football_league_id, {
                api_football_league_id: league.api_football_league_id,
                source_url: leagueUrl,
                bookmaker_league_name: candidate.label,
                source: candidate.source
              });
              break;
            }

            await logger("warn", "URL de liga da bet365 sem jogos alvo", {
              leagueName: league.name,
              apiFootballLeagueId: league.api_football_league_id,
              label: candidate.label,
              source: candidate.source,
              sourceUrl: candidate.sourceUrl,
              rawEventsRead: collectedEvents.length,
              futureFixturesInLeague: leagueFixtures.length
            });
          }

          if (!openedLeague) {
            await client.openHome();
            await client.openFootball();
            await client.openCompetitions();
            openedLeague = await client.openLeague(league.name, league.country, expectedTeamNames);

            if (openedLeague) {
              leagueUrl = client.currentUrl();
              openedLeagueLabel = client.currentLeagueLabel() ?? league.name;
              await saveLeagueLink(bookmaker, league, leagueUrl, openedLeagueLabel, "discovered", logger);
              cachedLeagueLinkByApiId.set(league.api_football_league_id, {
                api_football_league_id: league.api_football_league_id,
                source_url: leagueUrl,
                bookmaker_league_name: openedLeagueLabel,
                source: "discovered"
              });
            }
          }

          if (!openedLeague) {
            summary.leaguesSkipped += 1;
            const savedLeagueLink = cachedLeagueLinkByApiId.get(league.api_football_league_id);
            await requestBookmakerLeagueUrl(
              {
                bookmakerSlug: bookmaker.slug,
                league,
                reason: savedLeagueLink?.source_url ? "saved-url-failed" : "league-not-found",
                previousUrl: savedLeagueLink?.source_url ?? null,
                raw: {
                  expectedTeamNames,
                  futureFixturesInLeague: leagueFixtures.length
                }
              },
              logger
            );
            await logger("warn", "liga ignorada porque nao foi aberta", {
              leagueName: league.name,
              country: league.country,
              apiFootballLeagueId: league.api_football_league_id
            });
            continue;
          }

          summary.leaguesOpened += 1;
          if (!leagueUrl) leagueUrl = client.currentUrl();
          if (!leagueEvents) leagueEvents = await client.collectLeagueEvents(dateKeys);
          const matchedLeagueEvents = leagueEvents
            .map((candidate) => ({
              candidate,
              previewMatch: findBestMatch(rawEventPlaceholder(league, candidate), fixtures)
            }))
            .filter(
              (item): item is { candidate: Bet365LeagueEventCandidate; previewMatch: EventMatchResult & { fixture: CanonicalFixture } } =>
                Boolean(item.previewMatch)
            );
          summary.rawEventsFound += matchedLeagueEvents.length;

          await logger("info", "eventos brutos encontrados na liga", {
            leagueName: league.name,
            apiFootballLeagueId: league.api_football_league_id,
            openedLeagueLabel,
            events: matchedLeagueEvents.length,
            rawEventsRead: leagueEvents.length,
            futureFixturesInLeague: leagueFixtures.length
          });

          for (const { candidate, previewMatch } of matchedLeagueEvents) {
            try {
              if (processedFixtureIds.has(previewMatch.fixture.id)) {
                continue;
              }

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

              const freshness = shouldSkipFreshFixture(previewMatch.fixture, lastOddsByFixtureId.get(previewMatch.fixture.id));
              if (shouldUseFixtureRefreshCadence({ trigger, force }) && freshness.skip) {
                processedFixtureIds.add(previewMatch.fixture.id);
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

              const target = fixtureTargetFromCandidate(league, candidate);
              const cachedUrl = cachedUrlByFixtureId.get(previewMatch.fixture.id);
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
                openedEvent = await client.openFixtureWithRetries(target, leagueUrl, 3);
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
              const event = await collectCurrentEventWithMarketRetries(client, target, leagueUrl, logger, {
                leagueName: league.name,
                homeTeam: candidate.homeTeam,
                awayTeam: candidate.awayTeam
              });
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

              if (persisted.fixtureId) {
                processedFixtureIds.add(persisted.fixtureId);
              }

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

          const missingLeagueFixtures = fixtures.filter(
            (fixture) => !processedFixtureIds.has(fixture.id) && fixtureLeague(fixture)?.api_football_league_id === league.api_football_league_id
          );

          if (missingLeagueFixtures.length) {
            await logger("info", "tentando abrir jogos restantes pela pagina da liga", {
              leagueName: league.name,
              fixtures: missingLeagueFixtures.length
            });

            for (const fixture of missingLeagueFixtures) {
              try {
                if (!isPrematch(fixture.starts_at)) {
                  summary.eventsSkippedStarted += 1;
                  processedFixtureIds.add(fixture.id);
                  await logger("info", "jogo ignorado porque ja comecou ou esta perto demais do inicio", {
                    leagueName: league.name,
                    fixtureId: fixture.id,
                    homeTeam: fixture.home_team,
                    awayTeam: fixture.away_team,
                    startsAt: fixture.starts_at
                  });
                  continue;
                }

                const target = fixtureTargetFromCanonical(fixture);
                await client.goToUrl(leagueUrl, "voltando para a liga antes de abrir jogo restante");
                const openedEvent = await client.openFixtureWithRetries(target, leagueUrl, 3);

                if (!openedEvent) {
                  summary.eventsUnmatched += 1;
                  await logger("warn", "evento bruto encontrado, mas nao consegui abrir a pagina do jogo", {
                    leagueName: league.name,
                    homeTeam: fixture.home_team,
                    awayTeam: fixture.away_team,
                    startsAt: fixture.starts_at
                  });
                  continue;
                }

                summary.eventsOpened += 1;
                const event = await collectCurrentEventWithMarketRetries(client, target, leagueUrl, logger, {
                  leagueName: league.name,
                  homeTeam: fixture.home_team,
                  awayTeam: fixture.away_team
                });
                const rawEvent = rawEventFromFixture(league, fixture, event);
                summary.eventsCollected += 1;

                if (!event.markets.length) {
                  summary.eventsWithoutOdds += 1;
                  await logger("warn", "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado", {
                    leagueName: league.name,
                    homeTeam: fixture.home_team,
                    awayTeam: fixture.away_team,
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
                processedFixtureIds.add(fixture.id);

                if (persisted.fixtureId && persisted.oddsUpserted > 0) {
                  const savedAt = new Date().toISOString();
                  lastOddsByFixtureId.set(persisted.fixtureId, savedAt);
                  if (event.sourceUrl) cachedUrlByFixtureId.set(persisted.fixtureId, event.sourceUrl);
                }
              } catch (error) {
                summary.errors += 1;
                summary.lastError = errorMessage(error);
                await logger("error", "falha ao coletar jogo restante da bet365 pela pagina da liga", {
                  leagueName: league.name,
                  fixtureId: fixture.id,
                  homeTeam: fixture.home_team,
                  awayTeam: fixture.away_team,
                  error: serializeError(error)
                });
              }
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
      summary.nextRunAt = null;
      await updateCollectionState(bookmaker, {
        status: summary.errors ? "error" : "idle",
        last_finished_at: new Date().toISOString(),
        next_run_at: summary.nextRunAt,
        last_error: summary.lastError,
        summary
      }).catch(async (error) => {
        summary.errors += 1;
        summary.lastError = errorMessage(error);
        await logger("error", "falha ao atualizar estado da coleta da bet365", { error: serializeError(error) });
      });
    }

    await logger("info", "coleta da bet365 finalizada", summary);
    return summary;
  };
}

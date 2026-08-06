import pMap from "p-map";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { MeridianbetBookmakerConfig } from "../config/bookmakers.js";
import { MERIDIAN_LEAGUES } from "../config/meridian-leagues.js";
import { supabase } from "../db/supabase.js";
import { normalizeName } from "../domain/text.js";
import { isFixturePrematchForOddsRefresh as isPrematch } from "./collector-resilience.js";
import { errorMessage } from "../utils/errors.js";
import { requestBookmakerLeagueUrl, resolveBookmakerLeagueUrlRequest } from "./bookmaker-league-url-requests.js";
import {
  isMeridianEventPageUrl,
  MeridianbetBrowserClient,
  type MeridianCollectedEvent,
  type MeridianFixtureTarget,
  type MeridianLeagueEvent
} from "../providers/meridianbet.js";
import { matchMeridianbetSnapshots } from "./meridianbet-snapshot-matcher.js";
import { linkOrientation } from "./bookmaker-match-memory.js";

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

type LeagueLinkRow = {
  api_football_league_id: number;
  source_url: string;
  bookmaker_league_name: string | null;
  source: string | null;
};

type CachedEventLink = {
  url: string;
  externalEventId: number;
  homeTeam: string;
  awayTeam: string;
  orientation: "NORMAL" | "INVERTED" | null;
};

type Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

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

function targetDateKeys(date: BookmakerCollectOptions["date"]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (!date) return [dateKey(today), dateKey(tomorrow)];
  if (date === "today") return [dateKey(today)];
  if (date === "tomorrow") return [dateKey(tomorrow)];
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return [date];
  throw new Error(`Data inválida para coleta: ${date}. Use today, tomorrow ou YYYY-MM-DD.`);
}

function meridianEventTiming(event: MeridianLeagueEvent, allowedDateKeys: string[]) {
  const now = new Date();
  const label = String(event.dateLabel ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  let eventDateKey: string | null = null;
  if (label === "hoje") eventDateKey = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  else if (label === "amanha") eventDateKey = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  else {
    const match = label.match(/^(\d{1,2})[./-](\d{1,2})$/);
    if (match) {
      const dayMonth = `${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
      eventDateKey = allowedDateKeys.find((key) => key.slice(5) === dayMonth) ?? null;
    }
  }
  if (!eventDateKey || !allowedDateKeys.includes(eventDateKey)) return null;
  const time = String(event.timeLabel ?? "").match(/^(\d{1,2}):(\d{2})$/);
  const startsAt = time ? new Date(`${eventDateKey}T${String(Number(time[1])).padStart(2, "0")}:${time[2]}:00-03:00`).toISOString() : null;
  return { dateKey: eventDateKey, startsAt };
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

function formatConsoleLine(level: "info" | "warn" | "error", message: string, context: Record<string, unknown>) {
  const debugEnabled = process.env.MERIDIANBET_DEBUG === "true" || process.env.COLLECT_DEBUG === "true";
  if (debugEnabled) {
    const contextText = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
    return `[meridianbet] ${message}${contextText}`;
  }

  if (message === "iniciando Chrome real via CDP para meridianbet") return "[meridianbet] Abrindo Chrome real...";
  if (message === "fechando Chrome da meridianbet") return "[meridianbet] Fechando Chrome.";
  if (message === "links de ligas da meridianbet carregados") return `[meridianbet] Atalhos de liga: ${contextValue(context, "savedLinks")} salvos | ${contextValue(context, "hardcodedLinks")} fixos.`;
  if (message === "iniciando carrossel de abas da meridianbet") return `[meridianbet] Monitorando URLs salvas em ${contextValue(context, "tabs")} abas: ${contextValue(context, "events")} jogos.`;
  if (message === "abrindo liga da meridianbet por URL") return `[meridianbet] Abrindo liga por URL: ${contextValue(context, "leagueName")}.`;
  if (message === "verificacao da meridianbet detectada; aguardando liberar pagina") return "[meridianbet] Verificacao detectada; aguardando liberar pagina.";
  if (message === "verificacao da meridianbet concluida") return "[meridianbet] Verificacao concluida.";
  if (message === "verificacao da meridianbet nao liberou dentro do tempo esperado") return "[meridianbet] Verificacao nao liberou dentro do tempo esperado.";
  if (message === "falha ao coletar jogo da meridianbet por URL cacheada; tentando pela liga") return "[meridianbet] URL cacheada falhou; tentando pela liga.";
  if (message === "evento da liga meridianbet ja atualizado pelo cache") return `[meridianbet] Evento da liga já atualizado pelo cache: ${fixtureName(context)}.`;
  if (message === "liga da meridianbet dispensada; todos os eventos atualizados pelo cache") return `[meridianbet] Liga dispensada: ${contextValue(context, "leagueName")} | ${contextValue(context, "fixtures")} jogos atualizados pelo cache.`;
  if (message === "associacao meridianbet reutilizada") return `[meridianbet] Cache atualizado sem novo matching: ${fixtureName(context)} | ${contextValue(context, "oddsSaved")} odds.`;
  if (message === "alias de time aprendido") return `[meridianbet] Alias aprendido: ${contextValue(context, "alias")} -> ${contextValue(context, "canonicalName")}.`;
  if (message === "alias de time ambiguo nao foi aprendido") return `[meridianbet] Alias ambíguo ignorado: ${contextValue(context, "alias")}.`;
  if (message === "filtro TUDO da meridianbet clicado") return `[meridianbet] Filtro TUDO clicado.`;
  if (message === "eventos alvo da meridianbet ja visiveis; filtro TUDO dispensado") return "[meridianbet] Jogos alvo já visíveis; filtro TUDO dispensado.";
  if (message === "filtro TUDO da meridianbet ja estava selecionado") return "[meridianbet] Filtro TUDO já estava selecionado.";
  if (message === "filtro TUDO da meridianbet ausente; eventos visiveis encontrados") return "[meridianbet] Filtro TUDO ausente; jogos visíveis encontrados.";
  if (message === "filtro TUDO da meridianbet ausente e nenhum evento visivel encontrado") return "[meridianbet] Aviso: filtro TUDO ausente e nenhum jogo visível encontrado.";
  if (message === "jogo alvo da meridianbet encontrado na liga, mas nao foi possivel abrir") return `[meridianbet] Aviso: não foi possível abrir ${fixtureName(context)}.`;
  if (message === "filtro TUDO da meridianbet não encontrado na barra de tempo") return "[meridianbet] Filtro TUDO não encontrado.";
  if (message === "jogo da meridianbet salvo no banco") return `[meridianbet] Odds salvas: ${fixtureName(context)} | ${contextValue(context, "oddsUpserted")} odds.`;
  if (message === "snapshot bruto da meridianbet salvo") return `[meridianbet] Evento salvo no cache: ${fixtureName(context)} | ${contextValue(context, "oddsFound")} odds | ${contextValue(context, "sourceUrl")}.`;
  if (message === "evento meridianbet confirmado no matching") return `[meridianbet] Matching confirmado: ${fixtureName(context)} | ${contextValue(context, "orientation")} | ${contextValue(context, "oddsSaved")} odds.`;
  if (message === "evento meridianbet pendente no matching") return `[meridianbet] Matching pendente: ${fixtureName(context)}.`;
  if (message === "matching externo da meridianbet finalizado") return `[meridianbet] Pós-coleta: ${contextValue(context, "reused")} vínculos reutilizados | ${contextValue(context, "newMatches")} novos matchings | ${contextValue(context, "unmatched")} pendentes | ${contextValue(context, "oddsProcessed")} odds processadas | ${contextValue(context, "oddsUpserted")} alteradas.`;
  if (message === "eventos brutos encontrados na liga da meridianbet") return `[meridianbet] Liga ${contextValue(context, "leagueName")}: ${contextValue(context, "eventsFound")} eventos D0/D1 encontrados | ${contextValue(context, "visibleEvents")} visiveis.`;
  if (message === "evento bruto da meridianbet não pôde ser aberto") return `[meridianbet] Evento não abriu: ${fixtureName(context)} | liga ${contextValue(context, "leagueName")}.`;
  if (message === "coleta bruta da liga da meridianbet finalizada") return `[meridianbet] Liga ${contextValue(context, "leagueName")} finalizada: ${contextValue(context, "eventsFound")} D0/D1 | ${contextValue(context, "snapshotsSaved")} salvos | ${contextValue(context, "errors")} erros.`;
  if (message === "liga da meridianbet sem eventos D0/D1") return `[meridianbet] Liga sem jogos D0/D1: ${contextValue(context, "leagueName")} | ${contextValue(context, "visibleEvents")} eventos visiveis fora do periodo.`;
  if (message === "liga da meridianbet abriu, mas nenhum evento foi encontrado") return `[meridianbet] Liga sem jogos visíveis: ${contextValue(context, "leagueName")} | ${contextValue(context, "sourceUrl")}.`;
  if (message === "liga da meridianbet precisa atualizar link") return `[meridianbet] Erro: ${contextValue(context, "errorMessage")}`;
  if (message === "coleta da meridianbet finalizada") return `[meridianbet] Coleta finalizada: ${contextValue(context, "eventsCollected")} jogos coletados | ${contextValue(context, "oddsFound")} odds lidas | ${contextValue(context, "oddsUpserted")} alteradas | ${contextValue(context, "errors")} erros.`;
  if (level === "error") return `[meridianbet] Erro: ${message}.`;
  return null;
}

function createLogger(logToConsole: boolean): Logger {
  return async (level, message, context = {}) => {
    if (!logToConsole) return;
    const line = formatConsoleLine(level, message, context);
    if (!line) return;
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    method(line);
  };
}

async function ensureBaseRows(bookmaker: MeridianbetBookmakerConfig) {
  const { error } = await supabase.from("casas_apostas").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;

  const { error: stateError } = await supabase.from("estado_coletas").upsert(
    {
      bookmaker_slug: bookmaker.slug,
      status: "idle",
      updated_at: new Date().toISOString()
    },
    { onConflict: "bookmaker_slug", ignoreDuplicates: true }
  );
  if (stateError) throw stateError;
}

async function updateCollectionState(bookmaker: MeridianbetBookmakerConfig, values: Record<string, unknown>) {
  const { error } = await supabase
    .from("estado_coletas")
    .update({
      status: "idle",
      lease_until: null,
      ...values,
      updated_at: new Date().toISOString()
    })
    .eq("bookmaker_slug", bookmaker.slug);
  if (error) throw error;
}

async function getCanonicalFixtures(dateKeys: string[]) {
  const { data, error } = await supabase
    .from("jogos")
    .select("id,api_football_fixture_id,name,league:campeonatos!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,starts_at,date_key")
    .in("date_key", dateKeys)
    .eq("leagues.enabled", true)
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as CanonicalFixture[];
}

function fixtureLeague(fixture: CanonicalFixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

async function getCachedEventLinks(bookmakerSlug: string, fixtureIds: string[], dateKeys: string[]) {
  const linkByFixtureId = new Map<string, CachedEventLink>();
  if (!fixtureIds.length) return linkByFixtureId;

  const { data, error } = await supabase
    .from("links_eventos")
    .select("fixture_id,external_event_id,bookmaker_home_team,bookmaker_away_team,source_url,raw,updated_at")
    .eq("bookmaker_slug", bookmakerSlug)
    .in("fixture_id", fixtureIds)
    .order("updated_at", { ascending: false });
  if (error) throw error;

  for (const row of (data ?? []) as Array<{ fixture_id: string; external_event_id: number; bookmaker_home_team: string | null; bookmaker_away_team: string | null; source_url: string | null; raw: unknown }>) {
    const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? (row.raw as Record<string, unknown>) : {};
    const collectionUrl = typeof raw.collectionUrl === "string" ? raw.collectionUrl : row.source_url;
    if (!collectionUrl || !isMeridianEventPageUrl(collectionUrl) || !row.bookmaker_home_team || !row.bookmaker_away_team || linkByFixtureId.has(row.fixture_id)) continue;
    linkByFixtureId.set(row.fixture_id, {
      url: collectionUrl,
      externalEventId: Number(row.external_event_id),
      homeTeam: row.bookmaker_home_team,
      awayTeam: row.bookmaker_away_team,
      orientation: linkOrientation(raw)
    });
  }

  if (linkByFixtureId.size < fixtureIds.length) {
    const fixtureIdSet = new Set(fixtureIds);
    const { data: snapshots, error: snapshotError } = await supabase
      .from("capturas_eventos")
      .select("external_event_id,home_team,away_team,source_url,raw,updated_at")
      .eq("bookmaker_slug", bookmakerSlug)
      .in("date_key", dateKeys)
      .order("updated_at", { ascending: false });
    if (snapshotError) throw snapshotError;

    for (const snapshot of (snapshots ?? []) as Array<{
      external_event_id: number;
      home_team: string | null;
      away_team: string | null;
      source_url: string | null;
      raw: unknown;
    }>) {
      const raw = snapshot.raw && typeof snapshot.raw === "object" && !Array.isArray(snapshot.raw)
        ? snapshot.raw as Record<string, unknown>
        : {};
      const fixtureId = typeof raw.fixtureId === "string" ? raw.fixtureId : null;
      if (
        !fixtureId ||
        !fixtureIdSet.has(fixtureId) ||
        linkByFixtureId.has(fixtureId) ||
        !snapshot.source_url ||
        !isMeridianEventPageUrl(snapshot.source_url) ||
        !snapshot.home_team ||
        !snapshot.away_team
      ) continue;
      linkByFixtureId.set(fixtureId, {
        url: snapshot.source_url,
        externalEventId: Number(snapshot.external_event_id),
        homeTeam: snapshot.home_team,
        awayTeam: snapshot.away_team,
        orientation: linkOrientation(raw)
      });
    }
  }
  return linkByFixtureId;
}
async function getCachedLeagueLinks(bookmakerSlug: string, leagueIds: number[]) {
  const linksByLeagueId = new Map<number, LeagueLinkRow>();
  if (!leagueIds.length) return linksByLeagueId;

  const { data, error } = await supabase
    .from("links_campeonatos")
    .select("api_football_league_id,source_url,bookmaker_league_name,source")
    .eq("bookmaker_slug", bookmakerSlug)
    .in("api_football_league_id", leagueIds);
  if (error) throw error;

  for (const row of (data ?? []) as unknown as LeagueLinkRow[]) {
    if (row.source_url) linksByLeagueId.set(Number(row.api_football_league_id), { ...row, api_football_league_id: Number(row.api_football_league_id) });
  }
  return linksByLeagueId;
}

async function saveLeagueLink(bookmaker: MeridianbetBookmakerConfig, league: ActiveLeague, sourceUrl: string, label: string, source: string) {
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("links_campeonatos").upsert(
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
  await resolveBookmakerLeagueUrlRequest(bookmaker.slug, league, sourceUrl);
}

async function persistEventSnapshot(
  bookmaker: MeridianbetBookmakerConfig,
  event: MeridianCollectedEvent,
  league: ActiveLeague,
  timing: { startsAt: string | null; dateKey: string | null },
  logger: Logger,
  association?: { fixtureId: string; orientation: "NORMAL" | "INVERTED" | null }
) {
  const { error } = await supabase.from("capturas_eventos").upsert({
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.externalEventId,
    league_api_football_id: league.api_football_league_id,
    league_name: league.name,
    league_country: league.country,
    event_name: event.eventName,
    home_team: event.bookmakerHomeTeam,
    away_team: event.bookmakerAwayTeam,
    normalized_home_team: normalizeName(event.bookmakerHomeTeam ?? ""),
    normalized_away_team: normalizeName(event.bookmakerAwayTeam ?? ""),
    starts_at: timing.startsAt,
    date_key: timing.dateKey,
    source_url: event.sourceUrl,
    markets: event.markets,
    raw_text: event.rawText,
    raw: {
      stage: association?.orientation ? "associated-update" : "unmatched",
      fixtureId: association?.orientation ? association.fixtureId : undefined,
      orientation: association?.orientation ?? undefined,
      associationReused: Boolean(association?.orientation),
      collectionUrl: event.sourceUrl,
      displayOrder: true
    },
    updated_at: new Date().toISOString()
  }, { onConflict: "bookmaker_slug,external_event_id" });
  if (error) throw error;
  const oddsFound = event.markets.reduce((total, market) => total + market.selections.length, 0);
  await logger("info", "snapshot bruto da meridianbet salvo", { eventName: event.eventName, externalEventId: event.externalEventId, sourceUrl: event.sourceUrl, oddsFound });
  return oddsFound;
}

function chunk<T>(items: T[], count: number) {
  const size = Math.ceil(items.length / count) || 1;
  return Array.from({ length: count }, (_, index) => items.slice(index * size, index * size + size));
}

export function createMeridianbetCollector(bookmaker: MeridianbetBookmakerConfig) {
  return async function collectMeridianbet(options: BookmakerCollectOptions = {}) {
    const logger = createLogger(options.logToConsole ?? true);
    const dateKeys = targetDateKeys(options.date);
    const summary = {
      trigger: options.trigger ?? "manual",
      targetDateKeys: dateKeys,
      skipped: false,
      skipReason: null as string | null,
      activeLeagues: 0,
      leaguesTargeted: 0,
      leaguesOpened: 0,
      leaguesOpenedWithoutTarget: 0,
      leaguesSkipped: 0,
      fixturesAvailable: 0,
      fixturesTargeted: 0,
      eventsOpened: 0,
      eventsOpenedFromCache: 0,
      eventsCollected: 0,
      eventsWithoutOdds: 0,
      eventsSkippedStarted: 0,
      eventsUnmatched: 0,
      snapshotsSaved: 0,
      oddsFound: 0,
      oddsUpserted: 0,
      errors: 0,
      lastError: null as string | null
    };

    await ensureBaseRows(bookmaker);
    const allFixtures = await getCanonicalFixtures(dateKeys);
    summary.fixturesAvailable = allFixtures.length;
    const fixtures = allFixtures.filter((fixture) => {
      if (isPrematch(fixture.starts_at)) return true;
      summary.eventsSkippedStarted += 1;
      return false;
    });
    summary.fixturesTargeted = fixtures.length;

    if (!fixtures.length) {
      summary.skipped = true;
      summary.skipReason = "no-future-fixtures";
      await updateCollectionState(bookmaker, { last_finished_at: new Date().toISOString(), last_error: null, summary });
      await logger("info", "coleta da meridianbet finalizada", summary);
      return summary;
    }

    const activeLeagues = [
      ...new Map(
        fixtures
          .map((fixture) => fixtureLeague(fixture))
          .filter((league): league is NonNullable<ReturnType<typeof fixtureLeague>> => Boolean(league))
          .map((league) => [
            Number(league.api_football_league_id),
            {
              name: league.name,
              slug: league.slug,
              country: league.country,
              api_football_league_id: Number(league.api_football_league_id)
            }
          ])
      ).values()
    ];
    summary.activeLeagues = activeLeagues.length;
    summary.leaguesTargeted = activeLeagues.length;

    const fixtureIds = fixtures.map((fixture) => fixture.id);
    const [cachedUrlByFixtureId, cachedLeagueLinkByApiId] = await Promise.all([
      getCachedEventLinks(bookmaker.slug, fixtureIds, dateKeys),
      getCachedLeagueLinks(bookmaker.slug, activeLeagues.map((league) => league.api_football_league_id))
    ]);

    await logger("info", "links de ligas da meridianbet carregados", {
      savedLinks: cachedLeagueLinkByApiId.size,
      hardcodedLinks: activeLeagues.filter((league) => MERIDIAN_LEAGUES[league.api_football_league_id]?.url).length
    });

    const client = new MeridianbetBrowserClient(bookmaker, logger);

    try {
      await client.start();

      const cacheSuccessFixtureIds = new Set<string>();
      const cacheSuccessEventIds = new Set<number>();
      const cacheSuccessTeamPairs = new Set<string>();
      const cachedWork = fixtures
        .map((fixture) => ({ fixture, cached: cachedUrlByFixtureId.get(fixture.id) }))
        .filter((item): item is { fixture: CanonicalFixture; cached: CachedEventLink } => Boolean(item.cached));

      if (cachedWork.length) {
        const tabs = Math.min(bookmaker.monitorTabs, cachedWork.length);
        await logger("info", "iniciando carrossel de abas da meridianbet", { tabs, events: cachedWork.length });
        await pMap(
          chunk(cachedWork, tabs),
          async (items) => {
            if (!items.length) return;
            const page = await client.newPage();
            try {
              for (const item of items) {
                try {
                  await client.goToUrl(page, item.cached.url, "abrindo jogo da meridianbet por URL em cache");
                  summary.eventsOpened += 1;
                  summary.eventsOpenedFromCache += 1;
                  const fixtureLeagueRow = fixtureLeague(item.fixture);
                  if (!fixtureLeagueRow) continue;
                  const event = await client.collectCurrentEvent(page, {
                    id: `meridian-cache:${item.cached.externalEventId}`,
                    homeTeam: item.cached.homeTeam,
                    awayTeam: item.cached.awayTeam,
                    leagueName: fixtureLeagueRow.name,
                    leagueCountry: fixtureLeagueRow.country,
                    startsAt: item.fixture.starts_at
                  });
                  summary.eventsCollected += 1;
                  if (!event.markets.length) summary.eventsWithoutOdds += 1;

                  const oddsFound = await persistEventSnapshot(bookmaker, event, {
                    name: fixtureLeagueRow.name,
                    slug: fixtureLeagueRow.slug,
                    country: fixtureLeagueRow.country,
                    api_football_league_id: Number(fixtureLeagueRow.api_football_league_id)
                  }, { startsAt: item.fixture.starts_at, dateKey: item.fixture.date_key }, logger, {
                    fixtureId: item.fixture.id,
                    orientation: item.cached.orientation
                  });
                  summary.snapshotsSaved += 1;
                  summary.oddsFound += oddsFound;
                  if (oddsFound > 0) {
                    cacheSuccessFixtureIds.add(item.fixture.id);
                    cacheSuccessEventIds.add(item.cached.externalEventId);
                    const normalPair = `${normalizeName(item.cached.homeTeam)}:${normalizeName(item.cached.awayTeam)}`;
                    const invertedPair = `${normalizeName(item.cached.awayTeam)}:${normalizeName(item.cached.homeTeam)}`;
                    cacheSuccessTeamPairs.add(normalPair);
                    cacheSuccessTeamPairs.add(invertedPair);
                  }
                } catch (error) {
                  await logger("warn", "falha ao coletar jogo da meridianbet por URL cacheada; tentando pela liga", {
                    fixtureId: item.fixture.id,
                    cachedUrl: item.cached.url,
                    error: serializeError(error)
                  });
                }
              }
            } finally {
              await page.close({ runBeforeUnload: false }).catch(() => undefined);
            }
          },
          { concurrency: tabs }
        );
      }

      const discoveryPage = await client.newPage();
      try {
        for (const league of activeLeagues) {
          const leagueFixtures = fixtures.filter(
            (fixture) => fixtureLeague(fixture)?.api_football_league_id === league.api_football_league_id
          );

          const fixturesNeedingLeague = leagueFixtures.filter((fixture) => !cacheSuccessFixtureIds.has(fixture.id));
          if (!fixturesNeedingLeague.length) {
            summary.leaguesSkipped += 1;
            await logger("info", "liga da meridianbet dispensada; todos os eventos atualizados pelo cache", {
              leagueName: league.name,
              apiFootballLeagueId: league.api_football_league_id,
              fixtures: leagueFixtures.length
            });
            continue;
          }

          const savedUrl = cachedLeagueLinkByApiId.get(league.api_football_league_id)?.source_url;
          const hardcoded = MERIDIAN_LEAGUES[league.api_football_league_id];
          const leagueUrl = hardcoded?.url ?? savedUrl ?? null;
          if (!leagueUrl) {
            await emitLeagueUrlError(bookmaker, league, null, "league-not-found", logger);
            summary.leaguesSkipped += 1;
            continue;
          }

          await logger("info", "abrindo liga da meridianbet por URL", {
            leagueName: league.name,
            apiFootballLeagueId: league.api_football_league_id,
            sourceUrl: leagueUrl
          });

          await client.goToUrl(discoveryPage, leagueUrl, "navegando para URL de liga da meridianbet");
          await client.selectAllPeriod(discoveryPage);
          if (!(await client.pageLooksLikeLeague(discoveryPage))) {
            await emitLeagueUrlError(bookmaker, league, savedUrl ?? leagueUrl, savedUrl ? "saved-url-failed" : "league-not-found", logger);
            summary.leaguesSkipped += 1;
            continue;
          }
          summary.leaguesOpened += 1;
          await saveLeagueLink(bookmaker, league, discoveryPage.url(), hardcoded?.name ?? league.name, hardcoded?.url ? "hardcoded" : "saved");
          const visiblePageEvents = await client.listLeagueEvents(discoveryPage);
          const pageEvents = visiblePageEvents.map((pageEvent) => ({ pageEvent, timing: meridianEventTiming(pageEvent, dateKeys) })).filter((item): item is { pageEvent: MeridianLeagueEvent; timing: { dateKey: string; startsAt: string | null } } => Boolean(item.timing));
          let leagueSnapshotsSaved = 0;
          let leagueErrors = 0;
          await logger("info", "eventos brutos encontrados na liga da meridianbet", { leagueName: league.name, eventsFound: pageEvents.length, visibleEvents: visiblePageEvents.length, sourceUrl: discoveryPage.url() });
          if (!pageEvents.length) {
            summary.leaguesOpenedWithoutTarget += 1;
            await logger("warn", visiblePageEvents.length ? "liga da meridianbet sem eventos D0/D1" : "liga da meridianbet abriu, mas nenhum evento foi encontrado", {
              leagueName: league.name,
              apiFootballLeagueId: league.api_football_league_id,
              sourceUrl: discoveryPage.url(),
              visibleEvents: visiblePageEvents.length
            });
          }
          for (const { pageEvent, timing } of pageEvents) {
            const pageEventPair = `${normalizeName(pageEvent.homeTeam ?? "")}:${normalizeName(pageEvent.awayTeam ?? "")}`;
            if (cacheSuccessEventIds.has(pageEvent.externalEventId) || cacheSuccessTeamPairs.has(pageEventPair)) {
              await logger("info", "evento da liga meridianbet ja atualizado pelo cache", {
                eventName: pageEvent.eventName,
                externalEventId: pageEvent.externalEventId,
                leagueName: league.name
              });
              continue;
            }
            try {
              const opened = await client.openLeagueEvent(discoveryPage, pageEvent);
              if (!opened) {
                await logger("warn", "evento bruto da meridianbet não pôde ser aberto", { eventName: pageEvent.eventName, leagueName: league.name });
                continue;
              }
              summary.eventsOpened += 1;
              const event = await client.collectCurrentEvent(discoveryPage, {
                id: `meridian-raw:${pageEvent.externalEventId}`,
                homeTeam: pageEvent.homeTeam,
                awayTeam: pageEvent.awayTeam,
                leagueName: league.name,
                leagueCountry: league.country,
                startsAt: ""
              });
              summary.eventsCollected += 1;
              if (!event.markets.length) summary.eventsWithoutOdds += 1;
              const oddsFound = await persistEventSnapshot(bookmaker, event, league, { startsAt: timing.startsAt, dateKey: timing.dateKey }, logger);
              summary.snapshotsSaved += 1;
              leagueSnapshotsSaved += 1;
              summary.oddsFound += oddsFound;
              await client.goToUrl(discoveryPage, leagueUrl, "voltando para a liga da meridianbet após coletar evento bruto");
              await client.selectAllPeriod(discoveryPage);
            } catch (error) {
              summary.errors += 1;
              leagueErrors += 1;
              summary.lastError = errorMessage(error);
              await logger("error", "falha ao coletar evento bruto da meridianbet", { leagueName: league.name, externalEventId: pageEvent.externalEventId, error: serializeError(error) });
              await client.goToUrl(discoveryPage, leagueUrl, "voltando para a liga da meridianbet após erro").catch(() => undefined);
              await client.selectAllPeriod(discoveryPage).catch(() => undefined);
            }
          }
          await logger("info", "coleta bruta da liga da meridianbet finalizada", { leagueName: league.name, eventsFound: pageEvents.length, visibleEvents: visiblePageEvents.length, snapshotsSaved: leagueSnapshotsSaved, errors: leagueErrors });

        }
      } finally {
        await discoveryPage.close({ runBeforeUnload: false }).catch(() => undefined);
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
      await updateCollectionState(bookmaker, {
        status: summary.errors ? "error" : "idle",
        last_finished_at: new Date().toISOString(),
        last_error: summary.lastError,
        summary
      }).catch(async (error) => {
        summary.errors += 1;
        summary.lastError = errorMessage(error);
        await logger("error", "falha ao atualizar estado da coleta da meridianbet", { error: serializeError(error) });
      });
    }

    try {
      const matching = await matchMeridianbetSnapshots({ date: options.date, logger });
      summary.eventsUnmatched = matching.unmatched;
      summary.oddsUpserted = matching.oddsUpserted;
      await updateCollectionState(bookmaker, {
        status: summary.errors ? "error" : "idle",
        last_finished_at: new Date().toISOString(),
        last_error: summary.lastError,
        summary: { ...summary, matching }
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await logger("error", "matching externo da meridianbet falhou", { error: serializeError(error) });
    }

    await logger("info", "coleta da meridianbet finalizada", summary);
    return summary;
  };
}

async function emitLeagueUrlError(
  bookmaker: MeridianbetBookmakerConfig,
  league: ActiveLeague,
  previousUrl: string | null,
  reason: "league-not-found" | "saved-url-failed",
  logger: Logger
) {
  const errorMessageText = `MeridianBet - '${league.name}' não foi encontrada - atualizar link`;
  await requestBookmakerLeagueUrl(
    {
      bookmakerSlug: bookmaker.slug,
      league,
      reason,
      previousUrl,
      raw: {
        message: errorMessageText
      }
    },
    logger
  );
  await logger("error", "liga da meridianbet precisa atualizar link", {
    leagueName: league.name,
    apiFootballLeagueId: league.api_football_league_id,
    previousUrl,
    errorMessage: errorMessageText
  });
}

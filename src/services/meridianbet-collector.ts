import pMap from "p-map";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { MeridianbetBookmakerConfig } from "../config/bookmakers.js";
import { MERIDIAN_LEAGUES } from "../config/meridian-leagues.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { normalizeName } from "../domain/text.js";
import { isFixturePrematchForOddsRefresh as isPrematch } from "./collector-resilience.js";
import { errorMessage } from "../utils/errors.js";
import { requestBookmakerLeagueUrl, resolveBookmakerLeagueUrlRequest } from "./bookmaker-league-url-requests.js";
import {
  isMeridianEventPageUrl,
  MeridianbetBrowserClient,
  type MeridianCollectedEvent,
  type MeridianFixtureTarget
} from "../providers/meridianbet.js";

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
  if (message === "filtro TUDO da meridianbet clicado") return `[meridianbet] Filtro TUDO clicado.`;
  if (message === "eventos alvo da meridianbet ja visiveis; filtro TUDO dispensado") return "[meridianbet] Jogos alvo já visíveis; filtro TUDO dispensado.";
  if (message === "filtro TUDO da meridianbet ja estava selecionado") return "[meridianbet] Filtro TUDO já estava selecionado.";
  if (message === "filtro TUDO da meridianbet ausente; eventos visiveis encontrados") return "[meridianbet] Filtro TUDO ausente; jogos visíveis encontrados.";
  if (message === "filtro TUDO da meridianbet ausente e nenhum evento visivel encontrado") return "[meridianbet] Aviso: filtro TUDO ausente e nenhum jogo visível encontrado.";
  if (message === "jogo alvo da meridianbet encontrado na liga, mas nao foi possivel abrir") return `[meridianbet] Aviso: não foi possível abrir ${fixtureName(context)}.`;
  if (message === "filtro TUDO da meridianbet não encontrado na barra de tempo") return "[meridianbet] Filtro TUDO não encontrado.";
  if (message === "jogo da meridianbet salvo no banco") return `[meridianbet] Odds salvas: ${fixtureName(context)} | ${contextValue(context, "oddsUpserted")} odds.`;
  if (message === "liga da meridianbet precisa atualizar link") return `[meridianbet] Erro: ${contextValue(context, "errorMessage")}`;
  if (message === "coleta da meridianbet finalizada") return `[meridianbet] Coleta finalizada: ${contextValue(context, "eventsCollected")} jogos coletados | ${contextValue(context, "oddsUpserted")} odds salvas | ${contextValue(context, "errors")} erros.`;
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

async function updateCollectionState(bookmaker: MeridianbetBookmakerConfig, values: Record<string, unknown>) {
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

async function getCanonicalFixtures(dateKeys: string[]) {
  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,league:leagues!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,starts_at,date_key")
    .in("date_key", dateKeys)
    .eq("leagues.enabled", true)
    .order("starts_at", { ascending: true });

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

async function getCachedEventUrls(bookmakerSlug: string, fixtureIds: string[]) {
  const urlByFixtureId = new Map<string, string>();
  if (!fixtureIds.length) return urlByFixtureId;

  const { data, error } = await supabase
    .from("bookmaker_event_links")
    .select("fixture_id,source_url,raw,updated_at")
    .eq("bookmaker_slug", bookmakerSlug)
    .in("fixture_id", fixtureIds)
    .order("updated_at", { ascending: false });
  if (error) throw error;

  for (const row of (data ?? []) as Array<{ fixture_id: string; source_url: string | null; raw: unknown }>) {
    const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? (row.raw as Record<string, unknown>) : {};
    const collectionUrl = typeof raw.collectionUrl === "string" ? raw.collectionUrl : row.source_url;
    if (collectionUrl && isMeridianEventPageUrl(collectionUrl) && !urlByFixtureId.has(row.fixture_id)) urlByFixtureId.set(row.fixture_id, collectionUrl);
  }
  return urlByFixtureId;
}

async function getCachedLeagueLinks(bookmakerSlug: string, leagueIds: number[]) {
  const linksByLeagueId = new Map<number, LeagueLinkRow>();
  if (!leagueIds.length) return linksByLeagueId;

  const { data, error } = await supabase
    .from("bookmaker_league_links")
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
  await resolveBookmakerLeagueUrlRequest(bookmaker.slug, league, sourceUrl);
}

function buildBookmakerLink(bookmaker: MeridianbetBookmakerConfig, fixture: CanonicalFixture, event: MeridianCollectedEvent): BookmakerLinkRow {
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.externalEventId,
    fixture_id: fixture.id,
    bookmaker_event_name: event.eventName || `${fixture.home_team} x ${fixture.away_team}`,
    bookmaker_home_team: event.bookmakerHomeTeam ?? fixture.home_team,
    bookmaker_away_team: event.bookmakerAwayTeam ?? fixture.away_team,
    normalized_bookmaker_home_team: normalizeName(event.bookmakerHomeTeam ?? fixture.home_team),
    normalized_bookmaker_away_team: normalizeName(event.bookmakerAwayTeam ?? fixture.away_team),
    starts_at: fixture.starts_at,
    match_confidence_score: 1,
    source_url: event.sourceUrl,
    raw: {
      sourceUrl: event.sourceUrl,
      collectionUrl: event.sourceUrl,
      rawText: event.rawText.slice(0, 2500),
      markets: event.markets,
      orientation: event.orientation,
      bookmakerHomeTeam: event.bookmakerHomeTeam,
      bookmakerAwayTeam: event.bookmakerAwayTeam
    },
    updated_at: new Date().toISOString()
  };
}

function sourceOddSelectionIndex(selection: string) {
  if (selection === "HOME") return 0;
  if (selection === "DRAW") return 1;
  if (selection === "AWAY") return 2;
  return 9;
}

function buildMoneylineOdds(bookmaker: MeridianbetBookmakerConfig, fixture: CanonicalFixture, event: MeridianCollectedEvent): OddRow[] {
  const rows: OddRow[] = [];
  for (const market of event.markets) {
    for (const selection of market.selections) {
      const sourceSelectionIndex = sourceOddSelectionIndex(selection.selection);
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
        raw_odd_type: selection.index === 0 ? "1" : selection.index === 1 ? "X" : "2",
        source_odd_id: event.externalEventId * 1000 + market.index * 10 + sourceSelectionIndex,
        raw: { sourceUrl: event.sourceUrl, orientation: event.orientation, market, selection },
        updated_at: new Date().toISOString()
      });
    }
  }
  return [...new Map(rows.map((row) => [`${row.fixture_id}:${row.selection}:${row.pa_category}`, row])).values()];
}

async function persistCollectedEvent(bookmaker: MeridianbetBookmakerConfig, fixture: CanonicalFixture, event: MeridianCollectedEvent, logger: Logger) {
  if (!event.markets.length) {
    await logger("warn", "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado na meridianbet", {
      fixtureId: fixture.id,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team,
      sourceUrl: event.sourceUrl
    });
    return { oddsFound: 0, oddsUpserted: 0 };
  }

  const link = buildBookmakerLink(bookmaker, fixture, event);
  const odds = buildMoneylineOdds(bookmaker, fixture, event);
  const oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, [link], odds, { replaceExistingOdds: true });

  await logger("info", "jogo da meridianbet salvo no banco", {
    fixtureId: fixture.id,
    eventName: event.eventName,
    sourceUrl: event.sourceUrl,
    orientation: event.orientation,
    oddsFound: odds.length,
    oddsUpserted
  });
  return { oddsFound: odds.length, oddsUpserted };
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
      getCachedEventUrls(bookmaker.slug, fixtureIds),
      getCachedLeagueLinks(bookmaker.slug, activeLeagues.map((league) => league.api_football_league_id))
    ]);

    await logger("info", "links de ligas da meridianbet carregados", {
      savedLinks: cachedLeagueLinkByApiId.size,
      hardcodedLinks: activeLeagues.filter((league) => MERIDIAN_LEAGUES[league.api_football_league_id]?.url).length
    });

    const client = new MeridianbetBrowserClient(bookmaker, logger);
    const processedFixtureIds = new Set<string>();

    try {
      await client.start();

      const cachedWork = fixtures
        .map((fixture) => ({ fixture, url: cachedUrlByFixtureId.get(fixture.id) }))
        .filter((item): item is { fixture: CanonicalFixture; url: string } => Boolean(item.url));

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
                  await client.goToUrl(page, item.url, "abrindo jogo da meridianbet por URL em cache");
                  if (!(await client.verifyCurrentEvent(page, fixtureTargetFromCanonical(item.fixture)))) {
                    summary.eventsUnmatched += 1;
                    continue;
                  }
                  summary.eventsOpened += 1;
                  summary.eventsOpenedFromCache += 1;
                  const event = await client.collectCurrentEvent(page, fixtureTargetFromCanonical(item.fixture));
                  summary.eventsCollected += 1;
                  if (!event.markets.length) summary.eventsWithoutOdds += 1;
                  const persisted = await persistCollectedEvent(bookmaker, item.fixture, event, logger);
                  summary.oddsFound += persisted.oddsFound;
                  summary.oddsUpserted += persisted.oddsUpserted;
                  processedFixtureIds.add(item.fixture.id);
                } catch (error) {
                  await logger("warn", "falha ao coletar jogo da meridianbet por URL cacheada; tentando pela liga", {
                    fixtureId: item.fixture.id,
                    cachedUrl: item.url,
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
            (fixture) => !processedFixtureIds.has(fixture.id) && fixtureLeague(fixture)?.api_football_league_id === league.api_football_league_id
          );
          if (!leagueFixtures.length) continue;

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
          const leagueTargets = leagueFixtures.map((fixture) => fixtureTargetFromCanonical(fixture));
          await client.selectAllPeriod(discoveryPage, leagueTargets);
          if (!(await client.pageHasAnyFixture(discoveryPage, leagueTargets))) {
            if (!(await client.pageLooksLikeLeague(discoveryPage))) {
              await emitLeagueUrlError(bookmaker, league, savedUrl ?? leagueUrl, savedUrl ? "saved-url-failed" : "league-not-found", logger);
              summary.leaguesSkipped += 1;
              continue;
            }

            summary.leaguesOpened += 1;
            summary.leaguesOpenedWithoutTarget += 1;
            summary.eventsUnmatched += leagueFixtures.length;
            await logger("warn", "liga da meridianbet abriu, mas nenhum evento alvo foi encontrado", {
              leagueName: league.name,
              apiFootballLeagueId: league.api_football_league_id,
              sourceUrl: discoveryPage.url(),
              fixtures: leagueFixtures.length
            });
            continue;
          }

          summary.leaguesOpened += 1;
          await saveLeagueLink(bookmaker, league, discoveryPage.url(), hardcoded?.name ?? league.name, hardcoded?.url ? "hardcoded" : "saved");

          for (const fixture of leagueFixtures) {
            try {
              const target = fixtureTargetFromCanonical(fixture);
              const opened = await client.openFixture(discoveryPage, target);
              if (!opened) {
                summary.eventsUnmatched += 1;
                await logger("warn", "jogo alvo da meridianbet encontrado na liga, mas nao foi possivel abrir", {
                  fixtureId: fixture.id,
                  homeTeam: fixture.home_team,
                  awayTeam: fixture.away_team,
                  leagueName: league.name,
                  sourceUrl: discoveryPage.url()
                });
                await client.goToUrl(discoveryPage, leagueUrl, "voltando para a liga da meridianbet após falha").catch(() => undefined);
                await client.selectAllPeriod(discoveryPage, leagueTargets).catch(() => undefined);
                continue;
              }

              summary.eventsOpened += 1;
              const event = await client.collectCurrentEvent(discoveryPage, target);
              summary.eventsCollected += 1;
              if (!event.markets.length) summary.eventsWithoutOdds += 1;
              const persisted = await persistCollectedEvent(bookmaker, fixture, event, logger);
              summary.oddsFound += persisted.oddsFound;
              summary.oddsUpserted += persisted.oddsUpserted;
              processedFixtureIds.add(fixture.id);
              await client.goToUrl(discoveryPage, leagueUrl, "voltando para a liga da meridianbet após coletar jogo");
              await client.selectAllPeriod(discoveryPage, leagueTargets);
            } catch (error) {
              summary.errors += 1;
              summary.lastError = errorMessage(error);
              await logger("error", "falha ao coletar jogo da meridianbet", {
                leagueName: league.name,
                fixtureId: fixture.id,
                error: serializeError(error)
              });
              await client.goToUrl(discoveryPage, leagueUrl, "voltando para a liga da meridianbet após erro").catch(() => undefined);
              await client.selectAllPeriod(discoveryPage, leagueTargets).catch(() => undefined);
            }
          }
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

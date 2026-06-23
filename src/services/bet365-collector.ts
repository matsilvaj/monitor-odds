import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { normalizeName } from "../domain/text.js";
import { isFixturePrematchForOddsRefresh as isPrematch } from "./collector-resilience.js";
import { getSavedBookmakerEventLinks } from "./saved-bookmaker-events.js";
import { errorMessage } from "../utils/errors.js";
import { Bet365LocalAutomationClient, buildBet365CollectedEvent, type Bet365CollectedEvent, type Bet365FixtureTarget } from "../providers/bet365.js";

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

type Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

type LeagueLinkRow = {
  api_football_league_id: number;
  source_url: string;
  bookmaker_league_name: string | null;
  source: string | null;
};

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

function fixtureLeague(fixture: CanonicalFixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function fixtureTargetFromCanonical(fixture: CanonicalFixture): Bet365FixtureTarget {
  return {
    id: fixture.id,
    homeTeam: fixture.home_team,
    awayTeam: fixture.away_team,
    startsAt: fixture.starts_at
  };
}

function createLogger(logToConsole: boolean): Logger {
  return async (level, message, context = {}) => {
    if (!logToConsole) return;
    const contextText = process.env.BET365_DEBUG === "true" || process.env.COLLECT_DEBUG === "true" ? ` ${JSON.stringify(context)}` : "";
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (message === "abrindo Chrome normal para bet365") {
      method(`[bet365] Abrindo Chrome normal com perfil dedicado.${contextText}`);
      return;
    }
    if (message === "texto do evento bet365 lido de arquivo") {
      method(`[bet365] Texto do evento lido de arquivo.${contextText}`);
      return;
    }
    if (message === "jogo da bet365 salvo no banco") {
      method(`[bet365] Odds salvas: ${String(context.eventName ?? "")} | ${String(context.oddsUpserted ?? 0)} odds.`);
      return;
    }
    if (message === "coleta da bet365 finalizada") {
      method(
        `[bet365] Coleta finalizada: ${String(context.eventsCollected ?? 0)} jogos coletados | ${String(context.oddsUpserted ?? 0)} odds salvas | ${String(context.errors ?? 0)} erros.`
      );
      return;
    }
    if (level === "error") {
      method(`[bet365] Erro: ${message}.${contextText}`);
      return;
    }
    method(`[bet365] ${message}.${contextText}`);
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

async function getCanonicalFixtures(dateKeys: string[], leagueSlug: string, limit: number) {
  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,league:leagues!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,starts_at,date_key")
    .in("date_key", dateKeys)
    .eq("leagues.enabled", true)
    .eq("leagues.slug", leagueSlug)
    .order("starts_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as unknown as CanonicalFixture[];
}

async function getSavedLeagueLink(bookmakerSlug: string, apiFootballLeagueId: number) {
  const { data, error } = await supabase
    .from("bookmaker_league_links")
    .select("api_football_league_id,source_url,bookmaker_league_name,source")
    .eq("bookmaker_slug", bookmakerSlug)
    .eq("api_football_league_id", apiFootballLeagueId)
    .maybeSingle();

  if (error) throw error;
  return data as LeagueLinkRow | null;
}

function buildBookmakerLink(bookmaker: Bet365BookmakerConfig, fixture: CanonicalFixture, event: Bet365CollectedEvent): BookmakerLinkRow {
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
      rawText: event.rawText.slice(0, 2500),
      markets: event.markets
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

function buildMoneylineOdds(bookmaker: Bet365BookmakerConfig, fixture: CanonicalFixture, event: Bet365CollectedEvent): OddRow[] {
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
        raw_market_name: market.paCategory === "COM_PA" ? "Full Time Result - Early Payout" : market.rawText.split(/\n+/)[0] ?? "Full Time Result",
        raw_label: selection.label,
        raw_odd_type: selection.index === 0 ? "1" : selection.index === 1 ? "X" : "2",
        source_odd_id: event.externalEventId * 1000 + market.index * 10 + sourceSelectionIndex,
        raw: { sourceUrl: event.sourceUrl, market, selection },
        updated_at: new Date().toISOString()
      });
    }
  }
  return [...new Map(rows.map((row) => [`${row.fixture_id}:${row.selection}:${row.pa_category}`, row])).values()];
}

async function persistCollectedEvent(bookmaker: Bet365BookmakerConfig, fixture: CanonicalFixture, event: Bet365CollectedEvent, logger: Logger) {
  if (!event.markets.length) {
    await logger("warn", "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado na bet365", {
      fixtureId: fixture.id,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team
    });
    return { oddsFound: 0, oddsUpserted: 0 };
  }

  const link = buildBookmakerLink(bookmaker, fixture, event);
  const odds = buildMoneylineOdds(bookmaker, fixture, event);
  const oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, [link], odds, { replaceExistingOdds: true });
  await logger("info", "jogo da bet365 salvo no banco", {
    fixtureId: fixture.id,
    eventName: event.eventName,
    oddsFound: odds.length,
    oddsUpserted
  });
  return { oddsFound: odds.length, oddsUpserted };
}

export function createBet365Collector(bookmaker: Bet365BookmakerConfig) {
  return async function collectBet365(options: BookmakerCollectOptions = {}) {
    const logger = createLogger(options.logToConsole ?? true);
    const dateKeys = targetDateKeys(options.date);
    const summary = {
      trigger: options.trigger ?? "manual",
      targetDateKeys: dateKeys,
      targetLeagueSlug: bookmaker.targetLeagueSlug,
      skipped: false,
      skipReason: null as string | null,
      fixturesAvailable: 0,
      fixturesTargeted: 0,
      eventsCollected: 0,
      eventsWithoutOdds: 0,
      eventsSkippedStarted: 0,
      oddsFound: 0,
      oddsUpserted: 0,
      errors: 0,
      lastError: null as string | null
    };

    await ensureBaseRows(bookmaker);

    if ((options.trigger ?? "manual") !== "manual") {
      summary.skipped = true;
      summary.skipReason = "manual-only";
      await updateCollectionState(bookmaker, { last_finished_at: new Date().toISOString(), last_error: null, summary });
      await logger("warn", "bet365 ignorada fora do modo manual", { trigger: options.trigger });
      return summary;
    }

    const allFixtures = await getCanonicalFixtures(dateKeys, bookmaker.targetLeagueSlug, bookmaker.fixtureLimit);
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
      await logger("info", "coleta da bet365 finalizada", summary);
      return summary;
    }

    const firstLeague = fixtureLeague(fixtures[0]);
    if (!firstLeague) {
      summary.skipped = true;
      summary.skipReason = "missing-fixture-league";
      await updateCollectionState(bookmaker, { status: "error", last_finished_at: new Date().toISOString(), last_error: "Fixture sem liga canônica", summary });
      throw new Error("Fixture alvo da Bet365 esta sem liga canonica.");
    }

    const savedLeagueLink = await getSavedLeagueLink(bookmaker.slug, Number(firstLeague.api_football_league_id));
    const competitionUrl = savedLeagueLink?.source_url ?? bookmaker.competitionUrl;
    if (!competitionUrl) {
      summary.skipped = true;
      summary.skipReason = "missing-competition-url";
      await updateCollectionState(bookmaker, {
        status: "error",
        last_finished_at: new Date().toISOString(),
        last_error: "Cadastre a URL da liga em bookmaker_league_links ou configure BET365_COMPETITION_URL",
        summary
      });
      throw new Error(
        `Cadastre a URL da liga ${firstLeague.name} (${firstLeague.api_football_league_id}) em bookmaker_league_links para bet365 ou configure BET365_COMPETITION_URL.`
      );
    }

    const client = new Bet365LocalAutomationClient(bookmaker, logger);
    try {
      await client.openCompetition(competitionUrl);
      const savedEventLinks = await getSavedBookmakerEventLinks(bookmaker.slug, fixtures.map((fixture) => fixture.id));
      for (const fixture of fixtures) {
        const league = fixtureLeague(fixture);
        const fixtureTarget = fixtureTargetFromCanonical(fixture);
        const savedEventUrl = savedEventLinks.get(fixture.id)?.source_url;
        await logger("info", "coletando jogo bet365 com automacao local", {
          fixtureId: fixture.id,
          eventName: fixture.name,
          leagueName: league?.name ?? null,
          hasSavedEventUrl: Boolean(savedEventUrl)
        });
        let page;
        if (savedEventUrl) {
          try {
            page = await client.collectEventTextFromUrl(savedEventUrl, fixtureTarget);
          } catch (error) {
            await logger("warn", "URL salva da bet365 falhou; voltando para busca visual", {
              fixtureId: fixture.id,
              sourceUrl: savedEventUrl,
              error: errorMessage(error)
            });
            await client.resetCompetition(competitionUrl);
          }
        }

        page ??= await client.collectEventText(fixtureTarget);
        await new Promise((resolve) => setTimeout(resolve, bookmaker.eventWaitMs));
        const event = buildBet365CollectedEvent(fixtureTarget, page.sourceUrl, page.rawText);
        summary.eventsCollected += 1;
        if (!event.markets.length) summary.eventsWithoutOdds += 1;
        const persisted = await persistCollectedEvent(bookmaker, fixture, event, logger);
        summary.oddsFound += persisted.oddsFound;
        summary.oddsUpserted += persisted.oddsUpserted;
        if (fixture !== fixtures.at(-1)) {
          await client.resetCompetition(competitionUrl);
        }
      }
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await logger("error", "coleta da bet365 falhou", { error: summary.lastError });
    } finally {
      await client.stop().catch(() => undefined);
      await updateCollectionState(bookmaker, {
        status: summary.errors ? "error" : "idle",
        last_finished_at: new Date().toISOString(),
        last_error: summary.lastError,
        summary
      });
    }

    await logger("info", "coleta da bet365 finalizada", summary);
    return summary;
  };
}

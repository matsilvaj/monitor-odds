import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { normalizeName } from "../domain/text.js";
import { buildBet365Event, buildBet365EventFromDomMarkets, summarizeBet365Payloads } from "../providers/bet365/parser.js";
import type { Bet365Event, Bet365FixtureTarget, Logger } from "../providers/bet365/types.js";
import { ChromeClient } from "../providers/bet365/chrome-client.js";
import { isFixturePrematchForOddsRefresh as isPrematch } from "./collector-resilience.js";
import { Bet365CollectionStateRepository } from "./bet365-collection-state.js";
import { getSavedBookmakerEventLinks } from "./saved-bookmaker-events.js";
import { errorMessage } from "../utils/errors.js";

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

type LeagueLinkRow = {
  api_football_league_id: number;
  source_url: string;
  bookmaker_league_name: string | null;
  source: string | null;
};

type Bet365Summary = {
  trigger: string;
  targetDateKeys: string[];
  targetLeagueSlugs: string[];
  skipped: boolean;
  skipReason: string | null;
  fixturesAvailable: number;
  fixturesTargeted: number;
  eventsCollected: number;
  eventsWithoutOdds: number;
  eventsSkippedStarted: number;
  oddsFound: number;
  oddsUpserted: number;
  errors: number;
  lastError: string | null;
  leagues: Record<string, unknown>;
};

type Bet365CollectResult =
  | { ok: true; event: Bet365Event }
  | { ok: false; reason: "nav-error" | "parse-error" | "timeout" };

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
    if (message === "payload bet365 lido de arquivo") {
      method(`[bet365] Payload do evento lido de arquivo.${contextText}`);
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

async function getCanonicalFixtures(dateKeys: string[], leagueSlug: string, limit: number) {
  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,league:leagues!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,starts_at,date_key")
    .in("date_key", dateKeys)
    .eq("leagues.enabled", true)
    .eq("leagues.slug", leagueSlug)
    .order("starts_at", { ascending: true })
    .limit(Math.max(limit * 3, limit + 10));

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

function buildBookmakerLink(bookmaker: Bet365BookmakerConfig, fixture: CanonicalFixture, event: Bet365Event): BookmakerLinkRow {
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

function buildMoneylineOdds(bookmaker: Bet365BookmakerConfig, fixture: CanonicalFixture, event: Bet365Event): OddRow[] {
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

async function maybeDumpBet365Payloads(fixture: Bet365FixtureTarget, sourceUrl: string, payloads: string[]) {
  if (process.env.BET365_DEBUG !== "true" && process.env.COLLECT_DEBUG !== "true") return null;

  const dir = path.resolve("logs", "bet365-payloads");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${fixture.id}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        fixture,
        sourceUrl,
        summary: summarizeBet365Payloads(payloads),
        payloads
      },
      null,
      2
    ),
    "utf8"
  );
  return file;
}

export class Bet365Collector {
  constructor(
    private readonly config: Bet365BookmakerConfig,
    private readonly chrome: ChromeClient,
    private readonly stateRepo: Bet365CollectionStateRepository,
    private readonly logger: Logger
  ) {}

  async collectAll(options: BookmakerCollectOptions = {}) {
    const dateKeys = targetDateKeys(options.date);
    const summary: Bet365Summary = {
      trigger: options.trigger ?? "manual",
      targetDateKeys: dateKeys,
      targetLeagueSlugs: this.config.targetLeagueSlugs,
      skipped: false,
      skipReason: null,
      fixturesAvailable: 0,
      fixturesTargeted: 0,
      eventsCollected: 0,
      eventsWithoutOdds: 0,
      eventsSkippedStarted: 0,
      oddsFound: 0,
      oddsUpserted: 0,
      errors: 0,
      lastError: null,
      leagues: {}
    };

    await this.stateRepo.ensureBaseRows(this.config);

    if ((options.trigger ?? "manual") !== "manual") {
      summary.skipped = true;
      summary.skipReason = "manual-only";
      await this.stateRepo.markDone(this.config.slug, summary);
      await this.logger("warn", "bet365 ignorada fora do modo manual", { trigger: options.trigger });
      return summary;
    }

    await this.stateRepo.markRunning(this.config.slug);

    try {
      for (const leagueSlug of this.config.targetLeagueSlugs) {
        const leagueSummary = await this.collectLeague(leagueSlug, dateKeys);
        summary.leagues[leagueSlug] = leagueSummary;
        summary.fixturesAvailable += Number(leagueSummary.fixturesAvailable ?? 0);
        summary.fixturesTargeted += Number(leagueSummary.fixturesTargeted ?? 0);
        summary.eventsCollected += Number(leagueSummary.eventsCollected ?? 0);
        summary.eventsWithoutOdds += Number(leagueSummary.eventsWithoutOdds ?? 0);
        summary.eventsSkippedStarted += Number(leagueSummary.eventsSkippedStarted ?? 0);
        summary.oddsFound += Number(leagueSummary.oddsFound ?? 0);
        summary.oddsUpserted += Number(leagueSummary.oddsUpserted ?? 0);
        summary.errors += Number(leagueSummary.errors ?? 0);
        if (leagueSummary.lastError) summary.lastError = String(leagueSummary.lastError);
      }

      if (summary.fixturesTargeted === 0) {
        summary.skipped = true;
        summary.skipReason = "no-future-fixtures";
      }
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await this.logger("error", "coleta da bet365 falhou", { error: summary.lastError });
    } finally {
      await this.chrome.stop().catch(() => undefined);
      if (summary.errors) {
        await this.stateRepo.markError(this.config.slug, summary.lastError, summary);
      } else {
        await this.stateRepo.markDone(this.config.slug, summary);
      }
    }

    await this.logger("info", "coleta da bet365 finalizada", summary);
    return summary;
  }

  private async collectLeague(leagueSlug: string, dateKeys: string[]) {
    const leagueSummary = {
      leagueSlug,
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

    const allFixtures = await getCanonicalFixtures(dateKeys, leagueSlug, this.config.fixtureLimitPerLeague);
    leagueSummary.fixturesAvailable = allFixtures.length;
    const fixtures = allFixtures.filter((fixture) => {
      if (isPrematch(fixture.starts_at)) return true;
      leagueSummary.eventsSkippedStarted += 1;
      return false;
    }).slice(0, this.config.fixtureLimitPerLeague);
    leagueSummary.fixturesTargeted = fixtures.length;

    if (!fixtures.length) {
      leagueSummary.skipped = true;
      leagueSummary.skipReason = "no-future-fixtures";
      return leagueSummary;
    }

    const firstLeague = fixtureLeague(fixtures[0]);
    if (!firstLeague) {
      leagueSummary.skipped = true;
      leagueSummary.skipReason = "missing-fixture-league";
      leagueSummary.errors += 1;
      leagueSummary.lastError = "Fixture alvo da Bet365 esta sem liga canonica.";
      return leagueSummary;
    }

    const savedLeagueLink = await getSavedLeagueLink(this.config.slug, Number(firstLeague.api_football_league_id));
    const competitionUrl = savedLeagueLink?.source_url ?? this.config.competitionUrl;
    if (!competitionUrl) {
      leagueSummary.skipped = true;
      leagueSummary.skipReason = "missing-competition-url";
      leagueSummary.errors += 1;
      leagueSummary.lastError = `Cadastre a URL da liga ${firstLeague.name} (${firstLeague.api_football_league_id}) em bookmaker_league_links para bet365 ou configure BET365_COMPETITION_URL.`;
      return leagueSummary;
    }

    await this.chrome.ensureOpen(competitionUrl);
    const savedEventLinks = await getSavedBookmakerEventLinks(this.config.slug, fixtures.map((fixture) => fixture.id));

    for (const fixture of fixtures) {
      const result = await this.collectFixture(fixture, competitionUrl, savedEventLinks.get(fixture.id)?.source_url ?? null);
      leagueSummary.eventsCollected += result.eventsCollected;
      leagueSummary.eventsWithoutOdds += result.eventsWithoutOdds;
      leagueSummary.oddsFound += result.oddsFound;
      leagueSummary.oddsUpserted += result.oddsUpserted;
      leagueSummary.errors += result.errors;
      if (result.lastError) leagueSummary.lastError = result.lastError;
      if (fixture !== fixtures.at(-1)) {
        await this.chrome.reset(competitionUrl);
      }
    }

    return leagueSummary;
  }

  private async collectFixture(fixture: CanonicalFixture, competitionUrl: string, savedEventUrl: string | null) {
    const fixtureTarget = fixtureTargetFromCanonical(fixture);
    const league = fixtureLeague(fixture);
    const result = {
      eventsCollected: 0,
      eventsWithoutOdds: 0,
      oddsFound: 0,
      oddsUpserted: 0,
      errors: 0,
      lastError: null as string | null
    };

    await this.logger("info", "coletando jogo bet365 com automacao local", {
      fixtureId: fixture.id,
      eventName: fixture.name,
      leagueName: league?.name ?? null,
      hasSavedEventUrl: Boolean(savedEventUrl)
    });

    let event: Bet365Event | null = null;
    if (this.config.eventTextFile) {
      const rawText = await readFile(this.config.eventTextFile, "utf8");
      await this.logger("info", "payload bet365 lido de arquivo", { file: this.config.eventTextFile, fixtureId: fixture.id });
      event = buildBet365Event(fixtureTarget, this.config.competitionUrl ?? this.config.baseUrl, rawText.split(/\n+/).filter(Boolean));
    } else {
      const sourceUrl = savedEventUrl ?? competitionUrl;
      const collectResult = await this.collectFromNetworkUrl(fixtureTarget, sourceUrl, !savedEventUrl);
      if (collectResult.ok) event = collectResult.event;
      if (!collectResult.ok && savedEventUrl) {
        await this.logger("warn", "URL salva da bet365 falhou; tentando payload da liga", {
          fixtureId: fixture.id,
          sourceUrl: savedEventUrl,
          reason: collectResult.reason
        });
        const fallback = await this.collectFromNetworkUrl(fixtureTarget, competitionUrl, true);
        if (fallback.ok) event = fallback.event;
      }
    }

    if (!event) {
      result.errors += 1;
      result.lastError = `Bet365 nao retornou odds para ${fixture.home_team ?? "HOME"} x ${fixture.away_team ?? "AWAY"}.`;
      await this.logger("warn", result.lastError, { fixtureId: fixture.id });
      return result;
    }

    result.eventsCollected += 1;
    if (!event.markets.length) result.eventsWithoutOdds += 1;
    const persisted = await this.persistEvent(fixture, event);
    result.oddsFound += persisted.oddsFound;
    result.oddsUpserted += persisted.oddsUpserted;
    return result;
  }

  private async collectFromNetworkUrl(fixture: Bet365FixtureTarget, sourceUrl: string, clickEvent: boolean): Promise<Bet365CollectResult> {
    await this.logger("info", "escutando WebSocket da bet365", { fixtureId: fixture.id, sourceUrl, clickEvent });
    try {
      const capture = await this.chrome.collectEventOdds(sourceUrl, clickEvent ? fixture : null);
      const rawText = capture.payloads.join("\n");
      let event = buildBet365Event(fixture, capture.sourceUrl, capture.payloads);
      if (!event.markets.length && capture.domMarkets.length) {
        event = buildBet365EventFromDomMarkets(fixture, capture.sourceUrl, capture.domMarkets);
      }
      if (!event.markets.length) {
        const dumpFile = await maybeDumpBet365Payloads(fixture, capture.sourceUrl, capture.payloads);
        const payloadSummary = summarizeBet365Payloads(capture.payloads);
        await this.logger("warn", "payloads da bet365 capturados, mas decoder nao encontrou mercado 1X2", {
          fixtureId: fixture.id,
          sourceUrl: capture.sourceUrl,
          clickedTeam: capture.clickedTeam,
          payloads: capture.payloads.length,
          domMarkets: capture.domMarkets.length,
          dumpFile,
          payloadSummary,
          preview: rawText.slice(0, 300)
        });
        return { ok: false, reason: "parse-error" };
      }
      await this.logger("info", "odds da bet365 capturadas via WebSocket", {
        fixtureId: fixture.id,
        sourceUrl: capture.sourceUrl,
        clickedTeam: capture.clickedTeam,
        payloads: capture.payloads.length,
        domMarkets: capture.domMarkets.length,
        markets: event.markets.length
      });
      return { ok: true, event };
    } catch (error) {
      await this.logger("warn", "captura WebSocket da bet365 falhou", {
        fixtureId: fixture.id,
        sourceUrl,
        error: errorMessage(error)
      });
      return { ok: false, reason: "nav-error" };
    }
  }

  private async persistEvent(fixture: CanonicalFixture, event: Bet365Event) {
    if (!event.markets.length) {
      await this.logger("warn", "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado na bet365", {
        fixtureId: fixture.id,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team
      });
      return { oddsFound: 0, oddsUpserted: 0 };
    }

    const link = buildBookmakerLink(this.config, fixture, event);
    const odds = buildMoneylineOdds(this.config, fixture, event);
    const oddsUpserted = await OddsRepository.saveAll(this.config.slug, [link], odds, { replaceExistingOdds: true });
    await this.logger("info", "jogo da bet365 salvo no banco", {
      fixtureId: fixture.id,
      eventName: event.eventName,
      oddsFound: odds.length,
      oddsUpserted
    });
    return { oddsFound: odds.length, oddsUpserted };
  }
}

export function createBet365Collector(bookmaker: Bet365BookmakerConfig) {
  return async function collectBet365(options: BookmakerCollectOptions = {}) {
    const logger = createLogger(options.logToConsole ?? true);
    const stateRepo = new Bet365CollectionStateRepository();
    const chrome = new ChromeClient(bookmaker, logger);
    return new Bet365Collector(bookmaker, chrome, stateRepo, logger).collectAll(options);
  };
}

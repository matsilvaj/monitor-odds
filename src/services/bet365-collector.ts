import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents } from "../domain/matching/event-matcher.js";
import { normalizeName } from "../domain/text.js";
import { buildBet365Event, buildBet365EventFromDomMarkets, summarizeBet365Payloads } from "../providers/bet365/parser.js";
import type { Bet365Event, Bet365FixtureTarget, Logger } from "../providers/bet365/types.js";
import { ChromeClient } from "../providers/bet365/chrome-client.js";
import { isFixturePrematchForOddsRefresh as isPrematch } from "./collector-resilience.js";
import { Bet365CollectionStateRepository } from "./bet365-collection-state.js";
import { requestBookmakerLeagueUrl, resolveBookmakerLeagueUrlRequest } from "./bookmaker-league-url-requests.js";
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

type CanonicalLeague = {
  name: string;
  slug: string;
  country: string | null;
  api_football_league_id: number;
  enabled: boolean;
};

type LeagueLinkRow = {
  api_football_league_id: number;
  source_url: string;
  bookmaker_league_name: string | null;
  source: string | null;
};

type Bet365LeagueUrlSeed = {
  label: string;
  sourceUrl: string;
};

type Bet365LeagueUrlCandidate = Bet365LeagueUrlSeed & {
  source: "saved" | "seed" | "config";
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
  | { ok: false; reason: "nav-error" | "parse-error" | "match-error" | "timeout" };

const BET365_SEEDED_LEAGUE_URLS: Record<number, Bet365LeagueUrlSeed[]> = {
  1: [{ label: "Copa do Mundo", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E131901075/G40/I%5E88/" }],
  71: [{ label: "Brasileirao Serie A", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E88369731/G40/" }],
  72: [{ label: "Brasileirao Serie B", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E102584281/G40/H%5E1/" }]
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

function isBet365EventUrl(url: string | null | undefined) {
  return /\/E\d+\/F/i.test(String(url ?? ""));
}

function looksLikeTeamLine(line: string) {
  const clean = line.trim();
  if (clean.length < 2 || clean.length > 80) return false;
  if (!/[A-Za-z\u00C0-\u024F]/.test(clean)) return false;
  if (/\b(?:[1-9]\d{0,2}|0)[.,]\d{2,3}\b/.test(clean)) return false;
  if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(clean)) return false;
  if (/^(?:v|vs|x|-|draw|empate|full time result|resultado final|popular|matches|jogos)$/i.test(normalizeName(clean))) return false;
  return true;
}

function candidateTeamsMatchFixture(fixture: Bet365FixtureTarget, homeTeam: string | null, awayTeam: string | null) {
  if (!homeTeam || !awayTeam) return false;
  return matchEvents(
    {
      id: fixture.id,
      startsAt: fixture.startsAt,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam
    },
    {
      startsAt: fixture.startsAt,
      homeTeam,
      awayTeam
    }
  ).matched;
}

function isDrawMarketLabel(label: string) {
  const normalized = normalizeName(label);
  return normalized === "draw" || normalized === "empate" || normalized === "x";
}

function marketTeamsFromSelections(event: Bet365Event, fixture: Bet365FixtureTarget) {
  let sawTeamPair = false;

  for (const market of event.markets) {
    const teamLabels = market.selections
      .map((selection) => selection.label.trim())
      .filter((label) => label && !isDrawMarketLabel(label) && looksLikeTeamLine(label));

    if (teamLabels.length < 2) continue;
    sawTeamPair = true;
    const homeTeam = teamLabels[0];
    const awayTeam = teamLabels[teamLabels.length - 1];

    if (candidateTeamsMatchFixture(fixture, homeTeam, awayTeam)) {
      return { matched: true as const, homeTeam, awayTeam };
    }
  }

  return sawTeamPair ? { matched: false as const, homeTeam: null, awayTeam: null } : null;
}

function visibleEventTeams(rawText: string, fixture: Bet365FixtureTarget) {
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 140);

  for (const line of lines) {
    const parts = line.split(/\s+(?:v|vs|x)\s+/i).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 2 && looksLikeTeamLine(parts[0]) && looksLikeTeamLine(parts[1])) {
      if (candidateTeamsMatchFixture(fixture, parts[0], parts[1])) {
        return { homeTeam: parts[0], awayTeam: parts[1] };
      }
    }
  }

  for (let index = 1; index < lines.length - 1; index += 1) {
    if (!/^(?:v|vs|x|-)$/.test(lines[index].trim().toLowerCase())) continue;
    let homeTeam: string | null = null;
    let awayTeam: string | null = null;

    for (let cursor = index - 1; cursor >= Math.max(0, index - 8); cursor -= 1) {
      if (looksLikeTeamLine(lines[cursor])) {
        homeTeam = lines[cursor];
        break;
      }
    }

    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 8); cursor += 1) {
      if (looksLikeTeamLine(lines[cursor])) {
        awayTeam = lines[cursor];
        break;
      }
    }

    if (homeTeam && awayTeam && candidateTeamsMatchFixture(fixture, homeTeam, awayTeam)) return { homeTeam, awayTeam };
  }

  return null;
}

function applyVisibleEventIdentity(event: Bet365Event, fixture: Bet365FixtureTarget, rawText: string) {
  const marketTeams = marketTeamsFromSelections(event, fixture);
  if (marketTeams?.matched) {
    return {
      ...event,
      eventName: [marketTeams.homeTeam, marketTeams.awayTeam].filter(Boolean).join(" x ") || event.eventName,
      bookmakerHomeTeam: marketTeams.homeTeam,
      bookmakerAwayTeam: marketTeams.awayTeam,
      rawText: event.rawText || rawText
    };
  }

  const teams = visibleEventTeams(rawText, fixture);
  if (!teams) return event;

  return {
    ...event,
    eventName: [teams.homeTeam, teams.awayTeam].filter(Boolean).join(" x ") || event.eventName,
    bookmakerHomeTeam: teams.homeTeam ?? event.bookmakerHomeTeam,
    bookmakerAwayTeam: teams.awayTeam ?? event.bookmakerAwayTeam,
    rawText: event.rawText || rawText
  };
}

function validateCollectedEvent(fixture: CanonicalFixture, event: Bet365Event) {
  if (!isBet365EventUrl(event.sourceUrl)) {
    return { ok: false as const, reason: "not-event-url", score: 0 };
  }

  const marketTeams = marketTeamsFromSelections(event, fixtureTargetFromCanonical(fixture));
  if (marketTeams?.matched === false) {
    return { ok: false as const, reason: "market-team-rejected", score: 0 };
  }

  const match = matchEvents(
    {
      id: fixture.id,
      startsAt: fixture.starts_at,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team,
      leagueName: fixtureLeague(fixture)?.name ?? null
    },
    {
      id: event.externalEventId,
      startsAt: fixture.starts_at,
      homeTeam: event.bookmakerHomeTeam,
      awayTeam: event.bookmakerAwayTeam,
      leagueName: fixtureLeague(fixture)?.name ?? null
    }
  );

  return match.matched ? { ok: true as const, match } : { ok: false as const, reason: match.reason, score: match.score };
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

async function getSavedBet365LeagueIds(bookmakerSlug: string) {
  const { data, error } = await supabase
    .from("bookmaker_league_links")
    .select("api_football_league_id,source_url")
    .eq("bookmaker_slug", bookmakerSlug);

  if (error) throw error;

  return new Set(
    (data ?? [])
      .filter((row) => Boolean(row.source_url))
      .map((row) => Number(row.api_football_league_id))
      .filter(Number.isFinite)
  );
}

async function discoverBet365TargetLeagueSlugs(bookmaker: Bet365BookmakerConfig, dateKeys: string[], logger: Logger) {
  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,league:leagues!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,starts_at,date_key")
    .in("date_key", dateKeys)
    .eq("leagues.enabled", true)
    .order("starts_at", { ascending: true })
    .limit(500);

  if (error) throw error;

  const savedLeagueIds = await getSavedBet365LeagueIds(bookmaker.slug);
  const leagues = new Map<number, CanonicalLeague>();

  for (const row of (data ?? []) as unknown as CanonicalFixture[]) {
    if (!isPrematch(row.starts_at)) continue;
    const league = fixtureLeague(row);
    if (!league) continue;
    leagues.set(Number(league.api_football_league_id), league);
  }

  const targetLeagueSlugs = [...leagues.values()]
    .filter((league) => {
      const apiFootballLeagueId = Number(league.api_football_league_id);
      return Boolean(BET365_SEEDED_LEAGUE_URLS[apiFootballLeagueId]?.length || savedLeagueIds.has(apiFootballLeagueId) || bookmaker.competitionUrl);
    })
    .map((league) => league.slug);

  await logger("info", "ligas da bet365 descobertas no banco", {
    dateKeys,
    targetLeagueSlugs,
    fixtureLeagues: [...leagues.values()].map((league) => ({
      slug: league.slug,
      name: league.name,
      apiFootballLeagueId: league.api_football_league_id
    }))
  });

  return targetLeagueSlugs;
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

function leagueUrlCandidates(league: CanonicalLeague, savedLink: LeagueLinkRow | null, configUrl?: string) {
  const candidates: Bet365LeagueUrlCandidate[] = [];
  const seededLinks = BET365_SEEDED_LEAGUE_URLS[Number(league.api_football_league_id)] ?? [];

  for (const seed of seededLinks) {
    candidates.push({ ...seed, source: "seed" });
  }

  if (savedLink?.source_url) {
    candidates.push({
      source: "saved",
      label: savedLink.bookmaker_league_name ?? league.name,
      sourceUrl: savedLink.source_url
    });
  }

  if (configUrl) {
    candidates.push({
      source: "config",
      label: "BET365_COMPETITION_URL",
      sourceUrl: configUrl
    });
  }

  return [...new Map(candidates.map((candidate) => [candidate.sourceUrl, candidate])).values()];
}

async function saveLeagueLink(bookmaker: Bet365BookmakerConfig, league: CanonicalLeague, candidate: Bet365LeagueUrlCandidate, logger: Logger) {
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("bookmaker_league_links").upsert(
    {
      bookmaker_slug: bookmaker.slug,
      api_football_league_id: Number(league.api_football_league_id),
      league_name: league.name,
      league_country: league.country,
      source_url: candidate.sourceUrl,
      bookmaker_league_name: candidate.label,
      source: candidate.source,
      raw: { source: candidate.source, label: candidate.label },
      last_verified_at: updatedAt,
      updated_at: updatedAt
    },
    { onConflict: "bookmaker_slug,api_football_league_id" }
  );

  if (error) throw error;
  await resolveBookmakerLeagueUrlRequest(bookmaker.slug, league, candidate.sourceUrl, logger);
}

async function requestLeagueUrlUpdate(bookmaker: Bet365BookmakerConfig, league: CanonicalLeague, previousUrl: string | null, attemptedUrls: Bet365LeagueUrlCandidate[], logger: Logger) {
  await requestBookmakerLeagueUrl(
    {
      bookmakerSlug: bookmaker.slug,
      league,
      reason: previousUrl ? "saved-url-failed" : "league-not-found",
      previousUrl,
      raw: {
        attemptedUrls: attemptedUrls.map((candidate) => ({
          source: candidate.source,
          label: candidate.label,
          sourceUrl: candidate.sourceUrl
        }))
      }
    },
    logger
  );
}

async function clearCachedFixtureEvent(bookmakerSlug: string, fixtureId: string) {
  await Promise.all([
    supabase.from("bookmaker_event_links").delete().eq("bookmaker_slug", bookmakerSlug).eq("fixture_id", fixtureId),
    supabase.from("odds").delete().eq("bookmaker_slug", bookmakerSlug).eq("fixture_id", fixtureId).eq("market_code", "1X2")
  ]);
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

    await this.stateRepo.markRunning(this.config.slug);

    try {
      const targetLeagueSlugs = this.config.targetLeagueSlugs.length
        ? this.config.targetLeagueSlugs
        : await discoverBet365TargetLeagueSlugs(this.config, dateKeys, this.logger);

      summary.targetLeagueSlugs = targetLeagueSlugs;

      if (!targetLeagueSlugs.length) {
        summary.skipped = true;
        summary.skipReason = "no-supported-leagues";
      } else {
        await this.chrome.navigateTo(this.config.baseUrl);

        for (const leagueSlug of targetLeagueSlugs) {
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
    const leagueUrlOptions = leagueUrlCandidates(firstLeague, savedLeagueLink, this.config.competitionUrl);
    if (!leagueUrlOptions.length) {
      leagueSummary.skipped = true;
      leagueSummary.skipReason = "missing-competition-url";
      leagueSummary.errors += 1;
      leagueSummary.lastError = `Cadastre a URL da liga ${firstLeague.name} (${firstLeague.api_football_league_id}) em bookmaker_league_links para bet365 ou configure BET365_COMPETITION_URL.`;
      await requestLeagueUrlUpdate(this.config, firstLeague, null, [], this.logger);
      return leagueSummary;
    }

    const savedEventLinks = await getSavedBookmakerEventLinks(this.config.slug, fixtures.map((fixture) => fixture.id));
    const processedFixtureIds = new Set<string>();
    const attemptedLeagueUrls: Bet365LeagueUrlCandidate[] = [];

    for (const candidate of leagueUrlOptions) {
      const remainingFixtures = fixtures.filter((fixture) => !processedFixtureIds.has(fixture.id));
      if (!remainingFixtures.length) break;

      attemptedLeagueUrls.push(candidate);
      let candidateCollectedAnyFixture = false;
      await this.logger("info", "abrindo liga da bet365 por URL", {
        leagueName: firstLeague.name,
        apiFootballLeagueId: firstLeague.api_football_league_id,
        source: candidate.source,
        label: candidate.label,
        sourceUrl: candidate.sourceUrl
      });

      try {
        await this.chrome.navigateTo(candidate.sourceUrl);
      } catch (error) {
        leagueSummary.errors += 1;
        leagueSummary.lastError = errorMessage(error);
        await this.logger("warn", "URL de liga da bet365 falhou", {
          leagueName: firstLeague.name,
          source: candidate.source,
          sourceUrl: candidate.sourceUrl,
          error: errorMessage(error)
        });
        continue;
      }

      for (const fixture of remainingFixtures) {
        const result = await this.collectFixture(fixture, candidate.sourceUrl, savedEventLinks.get(fixture.id)?.source_url ?? null);
        leagueSummary.eventsCollected += result.eventsCollected;
        leagueSummary.eventsWithoutOdds += result.eventsWithoutOdds;
        leagueSummary.oddsFound += result.oddsFound;
        leagueSummary.oddsUpserted += result.oddsUpserted;
        leagueSummary.errors += result.errors;
        if (result.lastError) leagueSummary.lastError = result.lastError;
        if (result.success) {
          processedFixtureIds.add(fixture.id);
          candidateCollectedAnyFixture = true;
        }
        if (fixture !== remainingFixtures.at(-1)) {
          await this.chrome.reset(candidate.sourceUrl);
        }
      }

      if (candidateCollectedAnyFixture) {
        await saveLeagueLink(this.config, firstLeague, candidate, this.logger).catch(async (error) => {
          await this.logger("warn", "nao consegui salvar link da liga bet365", {
            leagueName: firstLeague.name,
            sourceUrl: candidate.sourceUrl,
            error: errorMessage(error)
          });
        });
        if (processedFixtureIds.size === fixtures.length) break;
      }
    }

    if (!processedFixtureIds.size) {
      await requestLeagueUrlUpdate(this.config, firstLeague, savedLeagueLink?.source_url ?? null, attemptedLeagueUrls, this.logger);
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
      success: false,
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
      const attempts = [
        savedEventUrl ? { sourceUrl: savedEventUrl, clickEvent: false, label: "URL salva do evento" } : null,
        { sourceUrl: competitionUrl, clickEvent: true, label: "URL da liga" }
      ].filter((attempt): attempt is { sourceUrl: string; clickEvent: boolean; label: string } => Boolean(attempt));

      for (const attempt of attempts) {
        const collectResult = await this.collectFromNetworkUrl(fixture, fixtureTarget, attempt.sourceUrl, attempt.clickEvent);
        if (collectResult.ok) {
          event = collectResult.event;
          break;
        }

        if (savedEventUrl && attempt.sourceUrl === savedEventUrl && collectResult.reason === "match-error") {
          await clearCachedFixtureEvent(this.config.slug, fixture.id).catch(async (error) => {
            await this.logger("warn", "nao consegui limpar cache invalido da bet365", {
              fixtureId: fixture.id,
              sourceUrl: savedEventUrl,
              error: errorMessage(error)
            });
          });
        }

        await this.logger("warn", "camada de coleta da bet365 falhou; tentando proxima", {
          fixtureId: fixture.id,
          sourceUrl: attempt.sourceUrl,
          layer: attempt.label,
          reason: collectResult.reason
        });
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
    result.success = persisted.oddsFound > 0;
    return result;
  }

  private async collectFromNetworkUrl(canonicalFixture: CanonicalFixture, fixture: Bet365FixtureTarget, sourceUrl: string, clickEvent: boolean): Promise<Bet365CollectResult> {
    let lastReason: "nav-error" | "parse-error" | "match-error" | "timeout" = "timeout";
    const attempts = 3;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.logger("info", "escutando WebSocket da bet365", { fixtureId: fixture.id, sourceUrl, clickEvent, attempt, attempts });
      try {
        const capture = await this.chrome.collectEventOdds(sourceUrl, clickEvent ? fixture : null);
      const rawText = capture.payloads.join("\n");
        let event = applyVisibleEventIdentity(buildBet365Event(fixture, capture.sourceUrl, capture.payloads), fixture, capture.pageText);
        if (!event.markets.length && capture.domMarkets.length) {
          event = applyVisibleEventIdentity(buildBet365EventFromDomMarkets(fixture, capture.sourceUrl, capture.domMarkets), fixture, capture.pageText);
        }
        if (!event.markets.length) {
          lastReason = "parse-error";
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
          continue;
        }

        const validation = validateCollectedEvent(canonicalFixture, event);
        if (!validation.ok) {
          lastReason = "match-error";
          await this.logger("warn", "evento da bet365 rejeitado no matching", {
            fixtureId: fixture.id,
            sourceUrl: capture.sourceUrl,
            homeTeam: fixture.homeTeam,
            awayTeam: fixture.awayTeam,
            bookmakerHomeTeam: event.bookmakerHomeTeam,
            bookmakerAwayTeam: event.bookmakerAwayTeam,
            reason: validation.reason,
            score: validation.score
          });
          continue;
        }

        await this.logger("info", "odds da bet365 capturadas via WebSocket", {
          fixtureId: fixture.id,
          sourceUrl: capture.sourceUrl,
          clickedTeam: capture.clickedTeam,
          payloads: capture.payloads.length,
          domMarkets: capture.domMarkets.length,
          markets: event.markets.length,
          matchScore: validation.match.score
        });

        return { ok: true, event };
      } catch (error) {
        lastReason = "nav-error";
        await this.logger("warn", "captura WebSocket da bet365 falhou", {
          fixtureId: fixture.id,
          sourceUrl,
          attempt,
          attempts,
          error: errorMessage(error)
        });
      }
    }

    return { ok: false, reason: lastReason };
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

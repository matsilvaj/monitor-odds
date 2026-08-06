import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { normalizeName } from "../domain/text.js";
import {
  buildBet365Event,
  buildBet365EventFromDomMarkets,
  summarizeBet365Payloads
} from "../providers/bet365/parser.js";
import type { Bet365Event, Bet365FixtureTarget, Bet365Market, Logger } from "../providers/bet365/types.js";
import { ChromeClient, type Bet365ChromeTabSession } from "../providers/bet365/chrome-client.js";
import { isFixturePrematchForOddsRefresh as isPrematch } from "./collector-resilience.js";
import { Bet365CollectionStateRepository } from "./bet365-collection-state.js";
import { requestBookmakerLeagueUrl, resolveBookmakerLeagueUrlRequest } from "./bookmaker-league-url-requests.js";
import { getSavedBookmakerEventLinks, objectRaw, type SavedBookmakerEventLink } from "./saved-bookmaker-events.js";
import {
  canonicalNameFromAlias,
  linkOrientation,
  loadBookmakerAliasIndex
} from "./bookmaker-match-memory.js";
import { errorMessage } from "../utils/errors.js";
import { matchBet365Snapshots } from "./bet365-snapshot-matcher.js";

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
  home_team_id: string | null;
  away_team_id: string | null;
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
  oddsRemoved: number;
  fixturesPreservedAfterFailure: number;
  errors: number;
  lastError: string | null;
  leagues: Record<string, unknown>;
};

type Bet365CollectFailReason = "nav-error" | "parse-error" | "match-error" | "market-timeout" | "timeout";

type Bet365CollectResult =
  | { ok: true; event: Bet365Event }
  | { ok: false; reason: Bet365CollectFailReason; sourceUrl: string | null };

type Bet365CollectLayer = "direct" | "discovery" | "file";

type Bet365PersistContext = {
  layer: Bet365CollectLayer;
  collectionUrl: string;
  rawSourceUrl: string;
  discoveredFromLeagueUrl?: string | null;
  previousRaw?: unknown;
};

type Bet365FixtureCollectResult = {
  eventsCollected: number;
  eventsWithoutOdds: number;
  oddsFound: number;
  oddsUpserted: number;
  success: boolean;
  reason: Bet365CollectFailReason | null;
  lastError: string | null;
  sourceUrl: string | null;
};

type Bet365CachedDirectItem = {
  fixture: CanonicalFixture;
  link: SavedBookmakerEventLink;
  leagueSlug: string;
};

type Bet365DirectRefreshResult = {
  fixtureId: string;
  result: Bet365FixtureCollectResult;
};

const BET365_SEEDED_LEAGUE_URLS: Record<number, Bet365LeagueUrlSeed[]> = {
  1: [{ label: "Copa do Mundo", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E131901075/G40/I%5E88/" }],
  3: [{ label: "Europa League - Classificatórias", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E135566042/G40/" }],
  71: [{ label: "Brasileirao Serie A", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E88369731/G40/" }],
  72: [{ label: "Brasileirao Serie B", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E102584281/G40/H%5E1/" }],
  185: [{ label: "Scottish League Cup", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E135851259/G40/" }]
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

export type Bet365LeaguePageEvent = {
  homeTeam: string;
  awayTeam: string;
  startsAt: string;
  dateKey: string;
};

const BET365_MONTHS: Record<string, number> = {
  jan: 1, fev: 2, feb: 2, mar: 3, abr: 4, apr: 4, mai: 5, may: 5, jun: 6,
  jul: 7, ago: 8, aug: 8, set: 9, sep: 9, out: 10, oct: 10, nov: 11, dez: 12, dec: 12
};

function dateKeyFromLeagueHeader(label: string, allowedDateKeys: string[]) {
  const normalized = normalizeName(label);
  const match = normalized.match(/\b(\d{1,2})\s+(jan|fev|feb|mar|abr|apr|mai|may|jun|jul|ago|aug|set|sep|out|oct|nov|dez|dec)\b/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = BET365_MONTHS[match[2]];
  return allowedDateKeys.find((key) => {
    const [, candidateMonth, candidateDay] = key.split("-").map(Number);
    return candidateMonth === month && candidateDay === day;
  }) ?? null;
}

export function parseBet365LeaguePageEvents(rawText: string, allowedDateKeys: string[]): Bet365LeaguePageEvent[] {
  const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const dateHeader = /\b(?:dom|seg|ter|qua|qui|sex|s[aá]b|sun|mon|tue|wed|thu|fri|sat)\b.*\b\d{1,2}\s+(?:jan|fev|feb|mar|abr|apr|mai|may|jun|jul|ago|aug|set|sep|out|oct|nov|dez|dec)\b/i;
  const timePattern = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
  const pricePattern = /^(?:[1-9]\d{0,2})[.,]\d{2,3}$/;
  const events: Bet365LeaguePageEvent[] = [];
  let currentDateKey: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (dateHeader.test(line)) {
      currentDateKey = dateKeyFromLeagueHeader(line, allowedDateKeys);
      continue;
    }
    if (!currentDateKey || !timePattern.test(line)) continue;
    const homeTeam = lines[index + 1] ?? "";
    const awayTeam = lines[index + 2] ?? "";
    if (!/[A-Za-z\u00C0-\u024F]/.test(homeTeam) || !/[A-Za-z\u00C0-\u024F]/.test(awayTeam)) continue;
    if (timePattern.test(homeTeam) || timePattern.test(awayTeam) || pricePattern.test(homeTeam) || pricePattern.test(awayTeam)) continue;

    const [hour, minute] = line.split(":").map(Number);
    const startsAt = new Date(`${currentDateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-03:00`).toISOString();
    events.push({ homeTeam, awayTeam, startsAt, dateKey: currentDateKey });
  }

  return [...new Map(events.map((event) => [`${event.dateKey}:${event.startsAt}:${normalizeName(event.homeTeam)}:${normalizeName(event.awayTeam)}`, event])).values()];
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

function bet365EventIdFromUrl(url: string | null | undefined) {
  const value = url?.match(/\/D8\/E(\d+)\//i)?.[1];
  return value ? Number(value) : null;
}

function isBet365EventUrl(url: string | null | undefined) {
  return /\/E\d+\/F/i.test(String(url ?? ""));
}

function contextValue(context: Record<string, unknown>, key: string) {
  const value = context[key];
  return value === undefined || value === null || value === "" ? "-" : String(value);
}

function formatConsoleLine(level: "info" | "warn" | "error", message: string, context: Record<string, unknown>) {
  const debugEnabled = process.env.BET365_DEBUG === "true" || process.env.COLLECT_DEBUG === "true";
  if (debugEnabled) {
    const contextText = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
    return `[bet365] ${message}${contextText}`;
  }

  if (message === "abrindo Chrome normal para bet365") return "[bet365] Abrindo Chrome real...";
  if (message === "encerrando tentativa bet365") return "[bet365] Fechando Chrome.";
  if (message === "payload bet365 lido de arquivo") return "[bet365] Payload do evento lido de arquivo.";
  if (message === "cache de eventos da bet365 analisado") {
    return `[bet365] URLs salvas: ${contextValue(context, "savedLinks")} salvas | ${contextValue(context, "validUrls")} validas.`;
  }
  if (message === "ligas da bet365 descobertas no banco") {
    const unsupported = contextValue(context, "unsupportedLeagueNames");
    const suffix = unsupported === "-" ? "" : ` | sem link: ${unsupported}`;
    return `[bet365] Escopo com link de liga: ${contextValue(context, "targetFixtures")} jogos em ${contextValue(context, "targetLeagues")} ligas | ${contextValue(context, "unsupportedFixtures")} jogos fora do escopo${suffix}.`;
  }
  if (message === "liga da bet365 sem link") {
    return `[bet365] Liga sem link: ${contextValue(context, "leagueName")} (ID ${contextValue(context, "apiFootballLeagueId")}) | ${contextValue(context, "fixtures")} jogos D0/D1 ignorados.`;
  }
  if (message === "pagina da liga bet365 sem eventos D0/D1") {
    return `[bet365] Liga com link, mas sem jogos D0/D1: ${contextValue(context, "leagueName")} | ${contextValue(context, "sourceUrl")}.`;
  }

  if (message === "evento da liga bet365 ja atualizado pelo cache") {
    return `[bet365] Evento da liga já atualizado pelo cache: ${contextValue(context, "eventName")}.`;
  }
  if (message === "liga da bet365 dispensada; todos os eventos atualizados pelo cache") {
    return `[bet365] Liga dispensada: ${contextValue(context, "leagueName")} | ${contextValue(context, "fixtures")} jogos atualizados pelo cache.`;
  }
  if (message === "associacao bet365 reutilizada") {
    return `[bet365] Cache atualizado sem novo matching: ${contextValue(context, "eventName")} | ${contextValue(context, "oddsSaved")} odds.`;
  }
  if (message === "alias de time aprendido") {
    return `[bet365] Alias aprendido: ${contextValue(context, "alias")} -> ${contextValue(context, "canonicalName")}.`;
  }
  if (message === "alias de time ambiguo nao foi aprendido") {
    return `[bet365] Alias ambíguo ignorado: ${contextValue(context, "alias")}.`;
  }
  if (message === "iniciando refresh direto global da bet365 por URLs cacheadas") {
    return `[bet365] Monitorando URLs salvas em ${contextValue(context, "tabs")} abas: ${contextValue(context, "fixtures")} jogos.`;
  }
  if (message === "iniciando refresh direto da bet365 por URLs cacheadas") {
    return `[bet365] Monitorando URLs salvas em ${contextValue(context, "tabs")} abas: ${contextValue(context, "fixtures")} jogos.`;
  }
  if (message === "abrindo liga da bet365 por URL") return `[bet365] Abrindo liga por URL: ${contextValue(context, "leagueName")}.`;
  if (message === "snapshot bruto da bet365 salvo") {
    const layer = contextValue(context, "layer");
    const source = layer === "direct" ? "cache" : layer === "discovery" ? "liga" : layer;
    return `[bet365] Evento coletado via ${source}: ${contextValue(context, "eventName")} | snapshot ${contextValue(context, "externalEventId")} | ${contextValue(context, "oddsFound")} selecoes.`;
  }
  if (message === "evento bet365 confirmado no matching") {
    return `[bet365] Evento confirmado: ${contextValue(context, "eventName")} | link salvo no cache | ${contextValue(context, "oddsSaved")} odds.`;
  }
  if (message === "matching externo da bet365 finalizado") {
    return `[bet365] Pós-coleta: ${contextValue(context, "reused")} vínculos reutilizados | ${contextValue(context, "newMatches")} novos matchings | ${contextValue(context, "unmatched")} pendentes | ${contextValue(context, "oddsProcessed")} odds processadas | ${contextValue(context, "oddsUpserted")} alteradas.`;
  }
  if (message === "evento bet365 abriu sem odds completas") {
    return `[bet365] Sem odds dentro do evento: ${contextValue(context, "eventName")} | liga ${contextValue(context, "leagueName")} | ${contextValue(context, "reason")}.`;
  }
  if (message === "evento bet365 pendente no matching") {
    return `[bet365] Matching pendente: ${contextValue(context, "eventName")} | snapshot ${contextValue(context, "externalEventId")}.`;
  }
  if (message === "jogo da bet365 salvo no banco") return `[bet365] Odds salvas: ${contextValue(context, "eventName")} | ${contextValue(context, "oddsUpserted")} odds.`;
  if (message === "limpeza do ciclo da bet365 finalizada") {
    return `[bet365] Limpeza do ciclo: ${contextValue(context, "oddsRemoved")} odds antigas removidas | ${contextValue(context, "fixturesPreservedAfterFailure")} jogos preservados por falha de coleta.`;
  }
  if (message === "coleta da bet365 finalizada") {
    return `[bet365] Coleta finalizada: ${contextValue(context, "eventsCollected")} jogos coletados | ${contextValue(context, "oddsFound")} odds lidas | ${contextValue(context, "oddsUpserted")} alteradas | ${contextValue(context, "oddsRemoved")} removidas | ${contextValue(context, "errors")} erros.`;
  }
  if (message.startsWith("Bet365 nao retornou odds para ")) return `[bet365] Sem odds: ${message.replace(/^Bet365 nao retornou odds para\s*/i, "").replace(/\.+$/, "")}.`;
  if (level === "error") return `[bet365] Erro: ${message}.`;
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

async function getCanonicalFixtures(dateKeys: string[], leagueSlug: string, limit: number) {
  const { data, error } = await supabase
    .from("jogos")
    .select("id,api_football_fixture_id,name,league:campeonatos!inner(name,slug,country,api_football_league_id,enabled),home_team_id,away_team_id,home_team,away_team,starts_at,date_key")
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
    .from("links_campeonatos")
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
    .from("jogos")
    .select("id,api_football_fixture_id,name,league:campeonatos!inner(name,slug,country,api_football_league_id,enabled),home_team_id,away_team_id,home_team,away_team,starts_at,date_key")
    .in("date_key", dateKeys)
    .eq("leagues.enabled", true)
    .order("starts_at", { ascending: true })
    .limit(500);

  if (error) throw error;

  const savedLeagueIds = await getSavedBet365LeagueIds(bookmaker.slug);
  const leagues = new Map<number, CanonicalLeague>();

  const fixtureCounts = new Map<number, number>();
  for (const row of (data ?? []) as unknown as CanonicalFixture[]) {
    if (!isPrematch(row.starts_at)) continue;
    const league = fixtureLeague(row);
    if (!league) continue;
    const leagueId = Number(league.api_football_league_id);
    leagues.set(leagueId, league);
    fixtureCounts.set(leagueId, (fixtureCounts.get(leagueId) ?? 0) + 1);
  }

  const targetLeagues = [...leagues.values()]
    .filter((league) => {
      const apiFootballLeagueId = Number(league.api_football_league_id);
      return Boolean(BET365_SEEDED_LEAGUE_URLS[apiFootballLeagueId]?.length || savedLeagueIds.has(apiFootballLeagueId) || bookmaker.competitionUrl);
    });
  const targetLeagueIds = new Set(targetLeagues.map((league) => Number(league.api_football_league_id)));
  const unsupportedLeagues = [...leagues.values()].filter((league) => !targetLeagueIds.has(Number(league.api_football_league_id)));
  const targetLeagueSlugs = targetLeagues.map((league) => league.slug);

  await logger("info", "ligas da bet365 descobertas no banco", {
    dateKeys,
    targetLeagueSlugs,
    targetLeagues: targetLeagues.length,
    targetFixtures: [...targetLeagueIds].reduce((total, leagueId) => total + (fixtureCounts.get(leagueId) ?? 0), 0),
    unsupportedFixtures: unsupportedLeagues.reduce((total, league) => total + (fixtureCounts.get(Number(league.api_football_league_id)) ?? 0), 0),
    unsupportedLeagueNames: unsupportedLeagues.map((league) => `${league.name} (${fixtureCounts.get(Number(league.api_football_league_id)) ?? 0})`).join(", ") || null,
    fixtureLeagues: [...leagues.values()].map((league) => ({
      slug: league.slug,
      name: league.name,
      apiFootballLeagueId: league.api_football_league_id
    }))
  });

  for (const league of unsupportedLeagues) {
    const leagueId = Number(league.api_football_league_id);
    await logger("warn", "liga da bet365 sem link", {
      leagueName: league.name,
      apiFootballLeagueId: leagueId,
      fixtures: fixtureCounts.get(leagueId) ?? 0
    });
  }

  return targetLeagueSlugs;
}

async function getSavedLeagueLink(bookmakerSlug: string, apiFootballLeagueId: number) {
  const { data, error } = await supabase
    .from("links_campeonatos")
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
  const { error } = await supabase.from("links_campeonatos").upsert(
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

function numericRawValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function marketsSeen(event: Bet365Event) {
  return [...new Set(event.markets.map((market) => market.paCategory))];
}

function missingBet365MarketCategories(event: Bet365Event) {
  const seen = new Set(marketsSeen(event));
  return (["COM_PA", "SEM_PA"] as const).filter((category) => !seen.has(category));
}

function hasCollectableBet365Market(event: Bet365Event) {
  return event.markets.some((market) => {
    const selections = new Set(market.selections.map((selection) => selection.selection));
    return selections.has("HOME") && selections.has("DRAW") && selections.has("AWAY");
  });
}

function marketCompletenessScore(market: Bet365Market) {
  const selections = new Set(market.selections.map((selection) => selection.selection));
  let score = 0;
  if (selections.has("HOME")) score += 1;
  if (selections.has("DRAW")) score += 1;
  if (selections.has("AWAY")) score += 1;
  if (/full time result|resultado final/i.test(market.rawText)) score += 1;
  if (/enhanced prices|precos ajustados|precos ajustados|pagamento antecipado|early payout/i.test(market.rawText)) score += 1;
  return score;
}

function mergeBet365EventMarkets(payloadEvent: Bet365Event, domEvent: Bet365Event | null) {
  if (!domEvent?.markets.length) return payloadEvent;

  const selectedByCategory = new Map<string, Bet365Market>();
  for (const market of domEvent.markets) {
    const existing = selectedByCategory.get(market.paCategory);
    if (!existing || marketCompletenessScore(market) >= marketCompletenessScore(existing)) {
      selectedByCategory.set(market.paCategory, market);
    }
  }

  for (const market of payloadEvent.markets) {
    const existing = selectedByCategory.get(market.paCategory);
    if (!existing || marketCompletenessScore(market) > marketCompletenessScore(existing)) {
      selectedByCategory.set(market.paCategory, market);
    }
  }

  const markets = [...selectedByCategory.values()].map((market, index) => ({ ...market, index }));
  return {
    ...payloadEvent,
    eventName: domEvent.eventName || payloadEvent.eventName,
    bookmakerHomeTeam: domEvent.bookmakerHomeTeam ?? payloadEvent.bookmakerHomeTeam,
    bookmakerAwayTeam: domEvent.bookmakerAwayTeam ?? payloadEvent.bookmakerAwayTeam,
    markets,
    rawText: [payloadEvent.rawText, domEvent.rawText].filter(Boolean).join("\n")
  };
}

function savedEventCollectionUrl(link: SavedBookmakerEventLink | null | undefined) {
  if (!link) return null;
  const raw = objectRaw(link.raw);
  const candidates = [
    typeof raw.collectionUrl === "string" ? raw.collectionUrl : null,
    typeof link.source_url === "string" ? link.source_url : null,
    typeof raw.rawSourceUrl === "string" ? raw.rawSourceUrl : null,
    typeof raw.sourceUrl === "string" ? raw.sourceUrl : null
  ].filter((value): value is string => Boolean(value));

  return candidates.find(isBet365EventUrl) ?? null;
}

function rawEventCollectionUrl(raw: Record<string, unknown>, fallbackUrl?: string | null) {
  const candidates = [
    typeof raw.collectionUrl === "string" ? raw.collectionUrl : null,
    fallbackUrl,
    typeof raw.rawSourceUrl === "string" ? raw.rawSourceUrl : null,
    typeof raw.sourceUrl === "string" ? raw.sourceUrl : null
  ].filter((value): value is string => Boolean(value));

  return candidates.find(isBet365EventUrl) ?? null;
}

function savedEventFailCount(link: SavedBookmakerEventLink | null | undefined) {
  return numericRawValue(objectRaw(link?.raw).failCount);
}

async function markCachedEventDirectFailure(bookmakerSlug: string, link: SavedBookmakerEventLink, reason: Bet365CollectFailReason, logger: Logger) {
  const now = new Date().toISOString();
  const raw = objectRaw(link.raw);
  const failCount = numericRawValue(raw.failCount) + 1;
  const nextRaw = {
    ...raw,
    collectionUrl: typeof raw.collectionUrl === "string" ? raw.collectionUrl : link.source_url,
    rawSourceUrl: typeof raw.rawSourceUrl === "string" ? raw.rawSourceUrl : link.source_url,
    lastDirectFailAt: now,
    failCount,
    lastFailReason: reason
  };

  const { error } = await supabase
    .from("links_eventos")
    .update({ raw: nextRaw, updated_at: now })
    .eq("bookmaker_slug", bookmakerSlug)
    .eq("fixture_id", link.fixture_id)
    .eq("external_event_id", link.external_event_id);

  if (error) {
    await logger("warn", "nao consegui atualizar falha do cache bet365", {
      fixtureId: link.fixture_id,
      sourceUrl: link.source_url,
      reason,
      error: errorMessage(error)
    });
  }
}

function buildBookmakerLink(bookmaker: Bet365BookmakerConfig, fixture: CanonicalFixture, event: Bet365Event, context: Bet365PersistContext): BookmakerLinkRow {
  const now = new Date().toISOString();
  const previousRaw = objectRaw(context.previousRaw);
  const discoveredAt = context.layer === "discovery" ? previousRaw.discoveredAt ?? now : previousRaw.discoveredAt;
  const previousCollectionUrl = rawEventCollectionUrl(previousRaw);
  const nextCollectionUrl = isBet365EventUrl(context.collectionUrl) ? context.collectionUrl : previousCollectionUrl ?? context.collectionUrl;
  const nextRawSourceUrl = isBet365EventUrl(context.rawSourceUrl) ? context.rawSourceUrl : previousCollectionUrl ?? context.rawSourceUrl;
  const sourceUrl = isBet365EventUrl(event.sourceUrl) ? event.sourceUrl : nextCollectionUrl;
  const raw = {
    stage: typeof previousRaw.stage === "string" ? previousRaw.stage : "confirmed-cache",
    sourceUrl: event.sourceUrl,
    collectionUrl: nextCollectionUrl,
    rawSourceUrl: nextRawSourceUrl,
    discoveredFromLeagueUrl: context.discoveredFromLeagueUrl ?? previousRaw.discoveredFromLeagueUrl ?? null,
    discoveredAt,
    lastDirectOkAt: context.layer === "direct" ? now : previousRaw.lastDirectOkAt,
    lastDirectFailAt: previousRaw.lastDirectFailAt,
    failCount: 0,
    lastFailReason: null,
    marketsSeen: marketsSeen(event),
    missingMarkets: missingBet365MarketCategories(event),
    orientation: previousRaw.orientation,
    associationConfirmed: previousRaw.associationConfirmed === true,
    snapshotId: previousRaw.snapshotId
  };

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
    source_url: sourceUrl,
    raw,
    updated_at: now
  };
}

function sourceOddSelectionIndex(selection: string) {
  if (selection === "HOME") return 0;
  if (selection === "DRAW") return 1;
  if (selection === "AWAY") return 2;
  return 9;
}

function bet365SourceOddId(event: Bet365Event, marketIndex: number, selection: string) {
  return event.externalEventId * 1000 + marketIndex * 10 + sourceOddSelectionIndex(selection);
}

function buildMoneylineOdds(bookmaker: Bet365BookmakerConfig, fixture: CanonicalFixture, event: Bet365Event): OddRow[] {
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
        raw_market_name: market.paCategory === "COM_PA" ? "Full Time Result - Early Payout" : market.rawText.split(/\n+/)[0] ?? "Full Time Result",
        raw_label: selection.label,
        raw_odd_type: selection.index === 0 ? "1" : selection.index === 1 ? "X" : "2",
        source_odd_id: bet365SourceOddId(event, market.index, selection.selection),
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
  const safeFixtureId = String(fixture.id).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const file = path.join(dir, `${stamp}-${safeFixtureId}.json`);
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

function emptyFixtureCollectResult(): Bet365FixtureCollectResult {
  return {
    eventsCollected: 0,
    eventsWithoutOdds: 0,
    oddsFound: 0,
    oddsUpserted: 0,
    success: false,
    reason: null,
    lastError: null,
    sourceUrl: null
  };
}

function partitionIntoTabGroups<T>(items: T[], tabs: number) {
  const count = Math.min(Math.max(tabs, 1), Math.max(items.length, 1));
  const baseSize = Math.floor(items.length / count);
  const remainder = items.length % count;
  let cursor = 0;

  return Array.from({ length: count }, (_, index) => {
    const size = baseSize + (index < remainder ? 1 : 0);
    const group = items.slice(cursor, cursor + size);
    cursor += size;
    return group;
  }).filter((group) => group.length);
}

export class Bet365Collector {
  private readonly directRefreshResults = new Map<string, Bet365FixtureCollectResult>();
  private readonly fixturesCollectedReliably = new Set<string>();
  private readonly fixturesTargetedThisCycle = new Set<string>();
  private directRefreshCompleted = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Bet365BookmakerConfig,
    private readonly chrome: ChromeClient,
    private readonly stateRepo: Bet365CollectionStateRepository,
    private readonly logger: Logger
  ) {}

  async collectAll(options: BookmakerCollectOptions = {}) {
    const cycleStartedAt = new Date().toISOString();
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
      oddsRemoved: 0,
      fixturesPreservedAfterFailure: 0,
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
        this.directRefreshResults.clear();
        this.fixturesCollectedReliably.clear();
        this.fixturesTargetedThisCycle.clear();
        this.directRefreshCompleted = false;
        await this.collectCachedDirectForTargetLeagues(targetLeagueSlugs, dateKeys);

        for (const leagueSlug of targetLeagueSlugs) {
          const leagueSummary = await this.collectLeaguePageEvents(leagueSlug, dateKeys);
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

        summary.fixturesPreservedAfterFailure = [...this.fixturesTargetedThisCycle].filter(
          (fixtureId) => !this.fixturesCollectedReliably.has(fixtureId)
        ).length;
        summary.oddsRemoved = await OddsRepository.deleteStaleSeenBefore(
          this.config.slug,
          [...this.fixturesCollectedReliably],
          cycleStartedAt,
          { marketCodes: ["1X2"] }
        );
        await this.logger("info", "limpeza do ciclo da bet365 finalizada", {
          oddsRemoved: summary.oddsRemoved,
          fixturesCleaned: this.fixturesCollectedReliably.size,
          fixturesPreservedAfterFailure: summary.fixturesPreservedAfterFailure,
          cycleStartedAt
        });

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

  private async collectCachedDirectForTargetLeagues(leagueSlugs: string[], dateKeys: string[]) {
    if (this.config.eventTextFile) {
      this.directRefreshCompleted = true;
      return;
    }

    const queue: Bet365CachedDirectItem[] = [];
    let fixturesChecked = 0;
    let savedLinksFound = 0;

    for (const leagueSlug of leagueSlugs) {
      const allFixtures = await getCanonicalFixtures(dateKeys, leagueSlug, this.config.fixtureLimitPerLeague);
      const fixtures = allFixtures.filter((fixture) => isPrematch(fixture.starts_at)).slice(0, this.config.fixtureLimitPerLeague);
      if (!fixtures.length) continue;
      fixturesChecked += fixtures.length;

      const savedEventLinks = await getSavedBookmakerEventLinks(this.config.slug, fixtures.map((fixture) => fixture.id));
      for (const fixture of fixtures) {
        const link = savedEventLinks.get(fixture.id) ?? null;
        if (link) savedLinksFound += 1;
        if (link && savedEventCollectionUrl(link)) queue.push({ fixture, link, leagueSlug });
      }
    }

    this.directRefreshCompleted = true;
    await this.logger("info", "cache de eventos da bet365 analisado", {
      fixtures: fixturesChecked,
      savedLinks: savedLinksFound,
      validUrls: queue.length,
      leagues: leagueSlugs.length
    });
    if (!queue.length) return;

    const directTabs = Math.min(Math.max(this.config.monitorTabs || 1, 1), 5, queue.length);
    await this.logger("info", "iniciando refresh direto global da bet365 por URLs cacheadas", {
      fixtures: queue.length,
      tabs: directTabs,
      leagues: new Set(queue.map((item) => item.leagueSlug)).size
    });

    const directResults = await this.collectCachedDirectCarousel(queue, directTabs);

    for (const { fixtureId, result } of directResults) {
      this.directRefreshResults.set(fixtureId, result);
    }
  }

  private async collectCachedDirectCarousel(queue: Bet365CachedDirectItem[], tabs: number): Promise<Bet365DirectRefreshResult[]> {
    const groups = partitionIntoTabGroups(queue, tabs);
    const groupedResults = await Promise.all(
      groups.map((items, tabIndex) =>
        this.chrome.withNewTab(async (tab) => {
          const results: Bet365DirectRefreshResult[] = [];
          if (process.env.BET365_DEBUG === "true" || process.env.COLLECT_DEBUG === "true") {
            await this.logger("info", "aba direta da bet365 iniciada", {
              tabIndex: tabIndex + 1,
              tabs: groups.length,
              fixtures: items.length
            });
          }

          for (const { fixture, link } of items) {
            try {
              results.push({
                fixtureId: fixture.id,
                result: await this.collectFixtureDirect(fixture, link, tab)
              });
            } catch (error) {
              const result = emptyFixtureCollectResult();
              result.reason = "nav-error";
              result.lastError = `Refresh direto da Bet365 falhou para ${fixture.home_team ?? "HOME"} x ${fixture.away_team ?? "AWAY"}.`;
              await this.logger("warn", "refresh direto paralelo da bet365 falhou; fixture vai para discovery", {
                fixtureId: fixture.id,
                eventName: fixture.name,
                error: errorMessage(error),
                tabIndex: tabIndex + 1
              });
              results.push({ fixtureId: fixture.id, result });
            }
          }

          return results;
        })
      )
    );

    return groupedResults.flat();
  }

  private async collectLeaguePageEvents(leagueSlug: string, dateKeys: string[]) {
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
    const canonicalFixtures = await getCanonicalFixtures(dateKeys, leagueSlug, Math.max(this.config.fixtureLimitPerLeague, 1));
    const firstFixture = canonicalFixtures[0];
    const league = firstFixture ? fixtureLeague(firstFixture) : null;
    if (!league) {
      leagueSummary.skipped = true;
      leagueSummary.skipReason = "missing-fixture-league";
      leagueSummary.errors += 1;
      leagueSummary.lastError = `Liga ${leagueSlug} sem fixture D0/D1 para obter metadados.`;
      return leagueSummary;
    }

    const activeCanonicalFixtures = canonicalFixtures.filter((fixture) => isPrematch(fixture.starts_at));
    const savedEventLinks = await getSavedBookmakerEventLinks(this.config.slug, activeCanonicalFixtures.map((fixture) => fixture.id));
    const aliasIndex = await loadBookmakerAliasIndex(activeCanonicalFixtures
      .filter((fixture) => fixture.home_team_id && fixture.away_team_id && fixture.home_team && fixture.away_team)
      .map((fixture) => ({
        home_team_id: fixture.home_team_id as string,
        away_team_id: fixture.away_team_id as string,
        home_team: fixture.home_team as string,
        away_team: fixture.away_team as string
      })));
    const eventKey = (date: string, home: string | null, away: string | null) =>
      `${date}:${normalizeName(canonicalNameFromAlias(aliasIndex, home) ?? "")}:${normalizeName(canonicalNameFromAlias(aliasIndex, away) ?? "")}`;
    const cacheSuccessEventKeys = new Set<string>();
    for (const fixture of activeCanonicalFixtures) {
      if (!this.directRefreshResults.get(fixture.id)?.success) continue;
      const link = savedEventLinks.get(fixture.id);
      const orientation = linkOrientation(link?.raw);
      const expectedHome = orientation === "INVERTED" ? fixture.away_team : fixture.home_team;
      const expectedAway = orientation === "INVERTED" ? fixture.home_team : fixture.away_team;
      cacheSuccessEventKeys.add(eventKey(fixture.date_key, expectedHome, expectedAway));
      if (link) cacheSuccessEventKeys.add(eventKey(fixture.date_key, link.bookmaker_home_team, link.bookmaker_away_team));
    }
    for (const fixture of activeCanonicalFixtures) {
      const direct = this.directRefreshResults.get(fixture.id);
      if (!direct?.success) continue;
      leagueSummary.eventsCollected += direct.eventsCollected;
      leagueSummary.eventsWithoutOdds += direct.eventsWithoutOdds;
      leagueSummary.oddsFound += direct.oddsFound;
      leagueSummary.oddsUpserted += direct.oddsUpserted;
    }
    if (
      this.directRefreshCompleted &&
      activeCanonicalFixtures.length > 0 &&
      activeCanonicalFixtures.every((fixture) => this.directRefreshResults.get(fixture.id)?.success)
    ) {
      leagueSummary.skipped = true;
      leagueSummary.skipReason = "all-events-updated-from-cache";
      leagueSummary.fixturesAvailable = activeCanonicalFixtures.length;
      leagueSummary.fixturesTargeted = activeCanonicalFixtures.length;

      await this.logger("info", "liga da bet365 dispensada; todos os eventos atualizados pelo cache", {
        leagueName: league.name,
        apiFootballLeagueId: league.api_football_league_id,
        fixtures: activeCanonicalFixtures.length
      });
      return leagueSummary;
    }

    const savedLeagueLink = await getSavedLeagueLink(this.config.slug, Number(league.api_football_league_id));
    const candidates = leagueUrlCandidates(league, savedLeagueLink, this.config.competitionUrl);
    const attempted: Bet365LeagueUrlCandidate[] = [];
    if (!candidates.length) {
      leagueSummary.skipped = true;
      leagueSummary.skipReason = "missing-competition-url";
      leagueSummary.errors += 1;
      leagueSummary.lastError = `Cadastre a URL da liga ${league.name} (${league.api_football_league_id}) para bet365.`;
      await this.logger("warn", "liga da bet365 sem link", {
        leagueName: league.name,
        apiFootballLeagueId: league.api_football_league_id,
        fixtures: canonicalFixtures.length
      });
      await requestLeagueUrlUpdate(this.config, league, null, [], this.logger);
      return leagueSummary;
    }

    for (const candidate of candidates) {
      attempted.push(candidate);
      await this.logger("info", "abrindo liga da bet365 por URL", {
        leagueName: league.name,
        apiFootballLeagueId: league.api_football_league_id,
        source: candidate.source,
        label: candidate.label,
        sourceUrl: candidate.sourceUrl
      });
      try {
        const listing = await this.chrome.collectEventOdds(candidate.sourceUrl, null, false, true);
        const pageEvents = parseBet365LeaguePageEvents(listing.pageText, dateKeys);
        leagueSummary.fixturesAvailable = pageEvents.length;
        leagueSummary.fixturesTargeted = pageEvents.length;
        if (!pageEvents.length) {
          leagueSummary.lastError = `Nenhum evento D0/D1 encontrado na pagina da liga ${league.name}.`;
          await this.logger("warn", "pagina da liga bet365 sem eventos D0/D1", {
            leagueName: league.name,
            sourceUrl: candidate.sourceUrl,
            pagePreview: listing.pageText.slice(0, 300)
          });
          continue;
        }

        let collectedAny = false;
        for (let index = 0; index < pageEvents.length; index += 1) {
          const pageEvent = pageEvents[index];
          const alreadyUpdatedFromCache = cacheSuccessEventKeys.has(eventKey(pageEvent.dateKey, pageEvent.homeTeam, pageEvent.awayTeam));

          if (alreadyUpdatedFromCache) {
            collectedAny = true;
            await this.logger("info", "evento da liga bet365 ja atualizado pelo cache", {
              eventName: `${pageEvent.homeTeam} x ${pageEvent.awayTeam}`,
              leagueName: league.name
            });
            continue;
          }
          const syntheticFixture: CanonicalFixture = {
            id: `bet365-raw:${league.api_football_league_id}:${pageEvent.dateKey}:${normalizeName(pageEvent.homeTeam)}:${normalizeName(pageEvent.awayTeam)}`,
            api_football_fixture_id: 0,
            home_team_id: null,
            away_team_id: null,
            name: `${pageEvent.homeTeam} x ${pageEvent.awayTeam}`,
            league,
            home_team: pageEvent.homeTeam,
            away_team: pageEvent.awayTeam,
            starts_at: pageEvent.startsAt,
            date_key: pageEvent.dateKey
          };
          const result = await this.collectFixtureFromLeague(syntheticFixture, candidate.sourceUrl, null);
          leagueSummary.eventsCollected += result.eventsCollected;
          leagueSummary.eventsWithoutOdds += result.eventsWithoutOdds;
          leagueSummary.oddsFound += result.oddsFound;
          leagueSummary.oddsUpserted += result.oddsUpserted;
          if (result.success) collectedAny = true;
          else {
            leagueSummary.errors += 1;
            if (result.lastError) leagueSummary.lastError = result.lastError;
            await this.logger("warn", "evento bet365 abriu sem odds completas", {
              eventName: syntheticFixture.name,
              leagueName: league.name,
              sourceUrl: result.sourceUrl ?? candidate.sourceUrl,
              reason: result.reason
            });
          }
          if (index < pageEvents.length - 1) await this.chrome.reset(candidate.sourceUrl);
        }

        if (collectedAny) {
          await saveLeagueLink(this.config, league, candidate, this.logger).catch(async (error) => {
            await this.logger("warn", "nao consegui salvar link da liga bet365", {
              leagueName: league.name,
              sourceUrl: candidate.sourceUrl,
              error: errorMessage(error)
            });
          });
          return leagueSummary;
        }
      } catch (error) {
        leagueSummary.errors += 1;
        leagueSummary.lastError = errorMessage(error);
        await this.logger("warn", "URL de liga da bet365 falhou", {
          leagueName: league.name,
          sourceUrl: candidate.sourceUrl,
          error: leagueSummary.lastError
        });
      }
    }

    if (!leagueSummary.eventsCollected) {
      await requestLeagueUrlUpdate(this.config, league, savedLeagueLink?.source_url ?? null, attempted, this.logger);
    }
    return leagueSummary;
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
    for (const fixture of fixtures) this.fixturesTargetedThisCycle.add(fixture.id);

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
    const savedEventLinks = await getSavedBookmakerEventLinks(this.config.slug, fixtures.map((fixture) => fixture.id));
    const processedFixtureIds = new Set<string>();
    const attemptedLeagueUrls: Bet365LeagueUrlCandidate[] = [];
    const applyFixtureResult = (result: Bet365FixtureCollectResult) => {
      leagueSummary.eventsCollected += result.eventsCollected;
      leagueSummary.eventsWithoutOdds += result.eventsWithoutOdds;
      leagueSummary.oddsFound += result.oddsFound;
      leagueSummary.oddsUpserted += result.oddsUpserted;
      if (result.lastError) leagueSummary.lastError = result.lastError;
    };

    if (this.directRefreshCompleted) {
      for (const fixture of fixtures) {
        const result = this.directRefreshResults.get(fixture.id);
        if (!result) continue;
        applyFixtureResult(result);
        if (result.success) {
          processedFixtureIds.add(fixture.id);
        }
      }
    } else {
      const cachedDirectQueue = fixtures
        .map((fixture) => ({ fixture, link: savedEventLinks.get(fixture.id) ?? null }))
        .filter((item): item is { fixture: CanonicalFixture; link: SavedBookmakerEventLink } => Boolean(savedEventCollectionUrl(item.link)));

      if (cachedDirectQueue.length) {
        const directTabs = Math.min(Math.max(this.config.monitorTabs || 1, 1), 5, cachedDirectQueue.length);
        await this.logger("info", "iniciando refresh direto da bet365 por URLs cacheadas", {
          leagueName: firstLeague.name,
          fixtures: cachedDirectQueue.length,
          tabs: directTabs
        });

        const directResults = await this.collectCachedDirectCarousel(
          cachedDirectQueue.map((item) => ({ ...item, leagueSlug })),
          directTabs
        );

        for (const { fixtureId, result } of directResults) {
          applyFixtureResult(result);
          if (result.success) {
            processedFixtureIds.add(fixtureId);
          }
        }
      }
    }

    if (!leagueUrlOptions.length && processedFixtureIds.size < fixtures.length) {
      leagueSummary.skipped = processedFixtureIds.size === 0;
      leagueSummary.skipReason = "missing-competition-url";
      leagueSummary.errors += fixtures.length - processedFixtureIds.size;
      leagueSummary.lastError = `Cadastre a URL da liga ${firstLeague.name} (${firstLeague.api_football_league_id}) em bookmaker_league_links para bet365 ou configure BET365_COMPETITION_URL.`;
      await requestLeagueUrlUpdate(this.config, firstLeague, null, [], this.logger);
      return leagueSummary;
    }

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
        const result = await this.collectFixtureFromLeague(fixture, candidate.sourceUrl, savedEventLinks.get(fixture.id) ?? null);
        applyFixtureResult(result);
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

    const unresolvedFixtures = fixtures.filter((fixture) => !processedFixtureIds.has(fixture.id));
    for (const fixture of unresolvedFixtures) {
      leagueSummary.errors += 1;
      leagueSummary.lastError = `Bet365 nao retornou odds para ${fixture.home_team ?? "HOME"} x ${fixture.away_team ?? "AWAY"}.`;
      await this.logger("warn", leagueSummary.lastError, { fixtureId: fixture.id });
    }

    if (!processedFixtureIds.size) {
      await requestLeagueUrlUpdate(this.config, firstLeague, savedLeagueLink?.source_url ?? null, attemptedLeagueUrls, this.logger);
    }

    return leagueSummary;
  }

  private async collectFixtureFromTextFile(fixture: CanonicalFixture): Promise<Bet365FixtureCollectResult> {
    const fixtureTarget = fixtureTargetFromCanonical(fixture);
    const result = emptyFixtureCollectResult();
    const rawText = await readFile(this.config.eventTextFile ?? "", "utf8");
    await this.logger("info", "payload bet365 lido de arquivo", { file: this.config.eventTextFile, fixtureId: fixture.id });
    const event = buildBet365Event(fixtureTarget, this.config.competitionUrl ?? this.config.baseUrl, rawText.split(/\n+/).filter(Boolean));

    result.eventsCollected += 1;
    if (!event.markets.length) result.eventsWithoutOdds += 1;
    const persisted = await this.persistEvent(fixture, event, {
      layer: "file",
      collectionUrl: this.config.competitionUrl ?? this.config.baseUrl,
      rawSourceUrl: event.sourceUrl
    });
    result.oddsFound += persisted.oddsFound;
    result.oddsUpserted += persisted.oddsUpserted;
    result.success = persisted.oddsFound > 0;
    return result;
  }

  private async collectFixtureDirect(fixture: CanonicalFixture, link: SavedBookmakerEventLink, tab?: Bet365ChromeTabSession): Promise<Bet365FixtureCollectResult> {
    const fixtureTarget = fixtureTargetFromCanonical(fixture);
    const league = fixtureLeague(fixture);
    const result = emptyFixtureCollectResult();
    const collectionUrl = savedEventCollectionUrl(link);

    if (!collectionUrl) {
      result.reason = "match-error";
      result.lastError = "URL cacheada da Bet365 nao e uma URL de evento valida.";
      return result;
    }

    await this.logger("info", "abrindo jogo da bet365 por URL cacheada", {
      fixtureId: fixture.id,
      eventName: fixture.name,
      leagueName: league?.name ?? null,
      sourceUrl: collectionUrl,
      failCount: savedEventFailCount(link)
    });

    const collectResult = await this.collectFromNetworkUrl(fixture, fixtureTarget, collectionUrl, false, tab);
    if (!collectResult.ok) {
      result.reason = collectResult.reason;
      result.lastError = `URL cacheada da Bet365 falhou para ${fixture.home_team ?? "HOME"} x ${fixture.away_team ?? "AWAY"}.`;
      await markCachedEventDirectFailure(this.config.slug, link, collectResult.reason, this.logger);
      await this.logger("warn", "refresh direto da bet365 falhou; fixture vai para discovery", {
        fixtureId: fixture.id,
        sourceUrl: collectionUrl,
        reason: collectResult.reason,
        failCount: savedEventFailCount(link) + 1
      });
      return result;
    }

    const event = collectResult.event;
    result.eventsCollected += 1;
    if (!event.markets.length) result.eventsWithoutOdds += 1;
    const persisted = await this.persistEvent(fixture, event, {
      layer: "direct",
      collectionUrl,
      rawSourceUrl: event.sourceUrl,
      previousRaw: link.raw
    });
    result.oddsFound += persisted.oddsFound;
    result.oddsUpserted += persisted.oddsUpserted;
    result.success = persisted.oddsFound > 0;
    return result;
  }

  private async collectFixtureFromLeague(fixture: CanonicalFixture, competitionUrl: string, savedLink: SavedBookmakerEventLink | null): Promise<Bet365FixtureCollectResult> {
    const fixtureTarget = fixtureTargetFromCanonical(fixture);
    const league = fixtureLeague(fixture);
    const result = emptyFixtureCollectResult();

    if (this.config.eventTextFile) return this.collectFixtureFromTextFile(fixture);

    await this.logger("info", "coletando jogo bet365 com automacao local", {
      fixtureId: fixture.id,
      eventName: fixture.name,
      leagueName: league?.name ?? null,
      hasSavedEventUrl: Boolean(savedEventCollectionUrl(savedLink))
    });

    const collectResult = await this.collectFromNetworkUrl(fixture, fixtureTarget, competitionUrl, true);
    if (!collectResult.ok) {
      result.reason = collectResult.reason;
      result.sourceUrl = collectResult.sourceUrl;
      result.lastError = `Bet365 nao retornou odds para ${fixture.home_team ?? "HOME"} x ${fixture.away_team ?? "AWAY"}.`;
      await this.logger("warn", "camada de discovery da bet365 falhou", {
        fixtureId: fixture.id,
        sourceUrl: competitionUrl,
        reason: collectResult.reason
      });
      return result;
    }

    const event = collectResult.event;
    result.eventsCollected += 1;
    if (!event.markets.length) result.eventsWithoutOdds += 1;
    const persisted = await this.persistEvent(fixture, event, {
      layer: "discovery",
      collectionUrl: event.sourceUrl,
      rawSourceUrl: event.sourceUrl,
      discoveredFromLeagueUrl: competitionUrl,
      previousRaw: savedLink?.raw
    });
    result.oddsFound += persisted.oddsFound;
    result.oddsUpserted += persisted.oddsUpserted;
    result.success = persisted.oddsFound > 0;
    return result;
  }

  private async collectFromNetworkUrl(
    canonicalFixture: CanonicalFixture,
    fixture: Bet365FixtureTarget,
    sourceUrl: string,
    clickEvent: boolean,
    tab?: Bet365ChromeTabSession
  ): Promise<Bet365CollectResult> {
    let lastReason: Bet365CollectFailReason = "timeout";
    let lastSourceUrl: string | null = null;
    const attempts = clickEvent ? 2 : 1;
    const debugAttempts = process.env.BET365_DEBUG === "true" || process.env.COLLECT_DEBUG === "true";

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.logger("info", "escutando WebSocket da bet365", { fixtureId: fixture.id, sourceUrl, clickEvent, attempt, attempts });
      try {
        const forceNavigate = attempt > 1;
        const capture = tab
          ? await tab.collectEventOdds(sourceUrl, fixture, clickEvent, forceNavigate)
          : await this.chrome.collectEventOdds(sourceUrl, fixture, clickEvent, forceNavigate);
        lastSourceUrl = capture.sourceUrl;
        const eventWasOpened = capture.pageState === "EVENT_READY" || capture.pageState === "EVENT_LOADING";
        if (!eventWasOpened) {
          lastReason = "match-error";
          if (attempt === attempts || debugAttempts) {
            const dumpFile = await maybeDumpBet365Payloads(fixture, capture.sourceUrl, capture.payloads);
            await this.logger("warn", "evento da bet365 nao foi aberto; payloads residuais foram descartados", {
              fixtureId: fixture.id,
              sourceUrl: capture.sourceUrl,
              pageState: capture.pageState,
              clickedTeam: capture.clickedTeam,
              payloads: capture.payloads.length,
              domMarkets: capture.domMarkets.length,
              dumpFile,
              pagePreview: capture.pageText.slice(0, 300),
              attempt,
              attempts
            });
          }
          continue;
        }

        const rawText = capture.payloads.join("\n");
        const payloadEvent = buildBet365Event(fixture, capture.sourceUrl, []);
        const domEvent = capture.domMarkets.length
          ? buildBet365EventFromDomMarkets(fixture, capture.sourceUrl, capture.domMarkets)
          : null;
        const event = mergeBet365EventMarkets(payloadEvent, domEvent);
        if (!event.markets.length) {
          lastReason = "parse-error";
          if (attempt === attempts || debugAttempts) {
            const dumpFile = await maybeDumpBet365Payloads(fixture, capture.sourceUrl, capture.payloads);
            const payloadSummary = summarizeBet365Payloads(capture.payloads);
            await this.logger(
              "warn",
              "evento da bet365 aberto, mas nenhum mercado 1X2 foi lido",
              {
                fixtureId: fixture.id,
                sourceUrl: capture.sourceUrl,
                pageState: capture.pageState,
                clickedTeam: capture.clickedTeam,
                payloads: capture.payloads.length,
                domMarkets: capture.domMarkets.length,
                domMarketsExpanded: capture.domMarketsExpanded,
                dumpFile,
                payloadSummary,
                preview: rawText.slice(0, 300),
                pagePreview: capture.pageText.slice(0, 300),
                attempt,
                attempts
              }
            );
          }
          continue;
        }
        if (!hasCollectableBet365Market(event)) {
          lastReason = "market-timeout";
          if (attempt === attempts || debugAttempts) {
            await this.logger("warn", "nenhum mercado 1X2 completo da bet365 foi encontrado", {
              fixtureId: fixture.id,
              sourceUrl: capture.sourceUrl,
              pageState: capture.pageState,
              clickedTeam: capture.clickedTeam,
              payloads: capture.payloads.length,
              domMarkets: capture.domMarkets.length,
              domMarketsExpanded: capture.domMarketsExpanded,
              markets: event.markets.map((market) => market.paCategory),
              attempt,
              attempts
            });
          }
          continue;
        }

        await this.logger("info", "odds da bet365 capturadas no evento", {
          fixtureId: fixture.id,
          sourceUrl: capture.sourceUrl,
          pageState: capture.pageState,
          clickedTeam: capture.clickedTeam,
          payloads: capture.payloads.length,
          domMarkets: capture.domMarkets.length,
          domMarketsExpanded: capture.domMarketsExpanded,
          markets: event.markets.length,
          categories: marketsSeen(event),
          missingCategories: missingBet365MarketCategories(event)
        });

        return { ok: true, event };
      } catch (error) {
        lastReason = "nav-error";
        if (attempt === attempts || debugAttempts) {
          await this.logger("warn", "captura WebSocket da bet365 falhou", {
            fixtureId: fixture.id,
            sourceUrl,
            attempt,
            attempts,
            error: errorMessage(error)
          });
        }
      }
    }

    return { ok: false, reason: lastReason, sourceUrl: lastSourceUrl };
  }

  private async runSerializedPersist<T>(task: () => Promise<T>): Promise<T> {
    const run = this.persistQueue.then(task, task);
    this.persistQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async persistEvent(fixture: CanonicalFixture, event: Bet365Event, context: Bet365PersistContext) {
    return this.runSerializedPersist(async () => {
      if (!event.markets.length) {
        await this.logger("warn", "snapshot bruto sem mercado 1X2 ignorado na bet365", {
          fixtureId: fixture.id,
          homeTeam: fixture.home_team,
          awayTeam: fixture.away_team
        });
        return { oddsFound: 0, oddsUpserted: 0 };
      }

      const league = fixtureLeague(fixture);
      const updatedAt = new Date().toISOString();
      const externalEventId = bet365EventIdFromUrl(event.sourceUrl) ?? event.externalEventId;
      const previousRaw = objectRaw(context.previousRaw);
      const rememberedOrientation = previousRaw.orientation === "NORMAL" || previousRaw.orientation === "INVERTED"
        ? previousRaw.orientation
        : null;
      const associationPreserved = Boolean(rememberedOrientation);
      const markets = event.markets.map((market) => ({
        marketName: market.marketName,
        paCategory: market.paCategory,
        confidence: market.confidence,
        rawText: market.rawText,
        index: market.index,
        selections: market.selections
      }));
      const { error } = await supabase.from("capturas_eventos").upsert(
        {
          bookmaker_slug: this.config.slug,
          external_event_id: externalEventId,
          league_api_football_id: league?.api_football_league_id ?? null,
          league_name: league?.name ?? null,
          league_country: league?.country ?? null,
          event_name: event.eventName,
          home_team: event.bookmakerHomeTeam,
          away_team: event.bookmakerAwayTeam,
          normalized_home_team: normalizeName(event.bookmakerHomeTeam ?? ""),
          normalized_away_team: normalizeName(event.bookmakerAwayTeam ?? ""),
          starts_at: fixture.starts_at,
          date_key: fixture.date_key,
          source_url: event.sourceUrl,
          markets,
          raw_text: event.rawText,
          raw: {
            stage: associationPreserved ? "associated-update" : "unmatched",
            fixtureId: associationPreserved ? fixture.id : undefined,
            candidateFixtureId: fixture.id,
            orientation: rememberedOrientation ?? undefined,
            associationReused: associationPreserved,
            layer: context.layer,
            collectionUrl: context.collectionUrl,
            rawSourceUrl: context.rawSourceUrl,
            discoveredFromLeagueUrl: context.discoveredFromLeagueUrl ?? null,
            previousAssociationConfirmed: associationPreserved
          },
          updated_at: updatedAt
        },
        { onConflict: "bookmaker_slug,external_event_id" }
      );
      if (error) throw error;
      const oddsFound = event.markets.reduce((total, market) => total + market.selections.length, 0);
      await this.logger("info", "snapshot bruto da bet365 salvo", {
        eventName: event.eventName,
        externalEventId,
        layer: context.layer,
        oddsFound
      });
      return { oddsFound, oddsUpserted: 0 };
    });
  }
}

export function createBet365Collector(bookmaker: Bet365BookmakerConfig) {
  return async function collectBet365(options: BookmakerCollectOptions = {}) {
    const logger = createLogger(options.logToConsole ?? true);
    const stateRepo = new Bet365CollectionStateRepository();
    const chrome = new ChromeClient(bookmaker, logger);
    const collection = await new Bet365Collector(bookmaker, chrome, stateRepo, logger).collectAll(options);
    const matching = await matchBet365Snapshots({ date: options.date, logger });
    return { ...collection, oddsUpserted: matching.oddsUpserted, matching };
  };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { normalizeName } from "../domain/text.js";
import { teamNameSimilarity } from "../domain/matching/text-similarity.js";
import {
  buildBet365UnmatchedEvent,
  buildBet365UnmatchedEventFromDomMarkets,
  summarizeBet365Payloads
} from "../providers/bet365/parser.js";
import type { Bet365Event, Bet365Market, Logger } from "../providers/bet365/types.js";
import { ChromeClient, type Bet365ChromeTabSession } from "../providers/bet365/chrome-client.js";
import { isFixturePrematchForOddsRefresh as isPrematch } from "./collector-resilience.js";
import { Bet365CollectionStateRepository } from "./bet365-collection-state.js";
import { getSavedBookmakerEventLinks, objectRaw, type SavedBookmakerEventLink } from "./saved-bookmaker-events.js";
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
  | { ok: false; reason: Bet365CollectFailReason };

type Bet365CollectLayer = "direct" | "discovery" | "file";

type Bet365PersistContext = {
  layer: Bet365CollectLayer;
  collectionUrl: string;
  rawSourceUrl: string;
  discoveredFromLeagueUrl?: string | null;
  confirmedFixtureId?: string | null;
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
  137: [{ label: "Coppa Italia", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E137112511/G40/" }],
  182: [{ label: "Scottish Challenge Cup", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E137205045/G40/" }],
  185: [{ label: "Scottish League Cup", sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E135851259/G40/" }]
};

function dateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bahia" }).format(date);
}

function targetDateKeys(date: BookmakerCollectOptions["date"]) {
  const now = new Date();
  const todayKey = dateKey(now);
  const tomorrowKey = dateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  if (!date) return [todayKey, tomorrowKey];
  if (date === "today") return [todayKey];
  if (date === "tomorrow") return [tomorrowKey];
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
  const allowed = allowedDateKeys.find((key) => {
    const [, candidateMonth, candidateDay] = key.split("-").map(Number);
    return candidateMonth === month && candidateDay === day;
  });
  if (allowed) return allowed;
  const year = new Date().getFullYear();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
      const extractedDateKey = dateKeyFromLeagueHeader(line, allowedDateKeys);
      if (extractedDateKey) {
        currentDateKey = extractedDateKey;
      } else {
        currentDateKey = null;
      }
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

export function bet365ListingEventKey(dateKey: string, homeTeam: string | null | undefined, awayTeam: string | null | undefined) {
  const home = normalizeName(homeTeam ?? "");
  const away = normalizeName(awayTeam ?? "");
  return home && away ? `${dateKey}:${home}:${away}` : null;
}

function savedBet365EventName(fixture: CanonicalFixture, link: SavedBookmakerEventLink) {
  const home = link.bookmaker_home_team?.trim() || fixture.home_team;
  const away = link.bookmaker_away_team?.trim() || fixture.away_team;
  return [home, away].filter(Boolean).join(" x ") || fixture.name;
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
  if (message === "liga da bet365 dispensada; todos os eventos atualizados pelo cache") {
    return `[bet365] Liga dispensada: ${contextValue(context, "leagueName")} | ${contextValue(context, "fixtures")} eventos atualizados pelo cache.`;
  }
  if (message === "evento da liga bet365 ja atualizado pelo cache") {
    return `[bet365] Evento da liga já atualizado pelo cache: ${contextValue(context, "eventName")}.`;
  }
  if (message === "clique de linha da bet365 rejeitado") {
    return `[bet365] Clique rejeitado: ${contextValue(context, "eventName")} | a página aberta não era o evento esperado.`;
  }
  if (message === "nao encontrei linha segura do jogo na bet365") {
    const target = context.target && typeof context.target === "object" ? context.target as Record<string, unknown> : {};
    return `[bet365] Linha do evento não encontrada com segurança: ${contextValue(target, "homeTeam")} x ${contextValue(target, "awayTeam")}.`;
  }
  if (message === "pagina aberta pela bet365 nao corresponde ao evento") {
    return `[bet365] Página incorreta descartada: ${contextValue(context, "eventName")} | estado ${contextValue(context, "pageState")}.`;
  }
  if (message === "odds capturadas nao correspondem ao evento da bet365") {
    return `[bet365] Odds de outro evento descartadas: esperado ${contextValue(context, "expectedEventName")} | recebido ${contextValue(context, "capturedEventName")}.`;
  }
  if (message === "iniciando refresh direto global da bet365 por URLs cacheadas") {
    return `[bet365] Monitorando URLs salvas em ${contextValue(context, "tabs")} abas: ${contextValue(context, "fixtures")} jogos.`;
  }
  if (message === "iniciando refresh direto da bet365 por URLs cacheadas") {
    return `[bet365] Monitorando URLs salvas em ${contextValue(context, "tabs")} abas: ${contextValue(context, "fixtures")} jogos.`;
  }
  if (message === "abrindo liga da bet365 por URL") return `[bet365] Abrindo liga por URL: ${contextValue(context, "leagueName")}.`;
  if (message === "tentando abrir evento da bet365") {
    const home = contextValue(context, "homeTeam");
    const away = contextValue(context, "awayTeam");
    const name = home !== "-" && away !== "-" ? `${home} x ${away}` : `índice ${contextValue(context, "eventIndex")}`;
    return `[bet365] Abrindo evento: ${name}.`;
  }
  if (message === "snapshot bruto da bet365 salvo") {
    const layer = contextValue(context, "layer");
    const source = layer === "direct" ? "cache" : layer === "discovery" ? "liga" : layer;
    return `[bet365] Evento coletado via ${source}: ${contextValue(context, "eventName")} | snapshot ${contextValue(context, "externalEventId")} | ${contextValue(context, "oddsFound")} selecoes.`;
  }
  if (message === "evento bet365 confirmado no matching") {
    return `[bet365] Evento confirmado: ${contextValue(context, "eventName")} | link salvo no cache | ${contextValue(context, "oddsSaved")} odds.`;
  }
  if (message === "matching externo da bet365 finalizado") {
    return `[bet365] Matching finalizado: ${contextValue(context, "reused")} vínculos reutilizados | ${contextValue(context, "newMatches")} novos | ${contextValue(context, "unmatched")} pendentes | ${contextValue(context, "invalid")} inválidos | ${contextValue(context, "oddsUpserted")} odds alteradas.`;
  }
  if (message === "evento bet365 pendente no matching") {
    return `[bet365] Matching pendente: ${contextValue(context, "eventName")} | snapshot ${contextValue(context, "externalEventId")}.`;
  }
  if (message === "jogo da bet365 salvo no banco") return `[bet365] Odds salvas: ${contextValue(context, "eventName")} | ${contextValue(context, "oddsUpserted")} odds.`;
  if (message === "limpeza do ciclo da bet365 finalizada") {
    return `[bet365] Limpeza do ciclo: ${contextValue(context, "oddsRemoved")} odds antigas removidas | ${contextValue(context, "fixturesPreservedAfterFailure")} jogos preservados por falha de coleta.`;
  }
  if (message === "coleta da bet365 finalizada") {
    return `[bet365] Coleta finalizada: ${contextValue(context, "eventsCollected")} jogos coletados | ${contextValue(context, "oddsUpserted")} odds salvas | ${contextValue(context, "oddsRemoved")} odds removidas | ${contextValue(context, "errors")} erros.`;
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

async function getCanonicalFixtures(dateKeys: string[], leagueSlug: string) {
  const { data, error } = await supabase
    .from("jogos")
    .select("id,api_football_fixture_id,name,league:campeonatos!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,starts_at,date_key")
    .in("date_key", dateKeys)
    .eq("campeonatos.enabled", true)
    .eq("campeonatos.slug", leagueSlug)
    .order("starts_at", { ascending: true });

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
    .select("id,api_football_fixture_id,name,league:campeonatos!inner(name,slug,country,api_football_league_id,enabled),home_team,away_team,starts_at,date_key")
    .in("date_key", dateKeys)
    .eq("campeonatos.enabled", true)
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
    ...previousRaw,
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
    rawText: event.rawText.slice(0, 2500),
    markets: event.markets
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

async function maybeDumpBet365Payloads(fixture: CanonicalFixture, sourceUrl: string, payloads: string[]) {
  if (process.env.BET365_DEBUG !== "true" && process.env.COLLECT_DEBUG !== "true") return null;

  const dir = path.resolve("logs", "bet365-payloads");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${fixture.id}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        fixtureId: fixture.id,
        fixtureName: fixture.name,
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
    lastError: null
  };
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
    let skippedHighFailCount = 0;

    for (const leagueSlug of leagueSlugs) {
      const allFixtures = await getCanonicalFixtures(dateKeys, leagueSlug);
      const fixtures = allFixtures.filter((fixture) => isPrematch(fixture.starts_at));
      if (!fixtures.length) continue;
      fixturesChecked += fixtures.length;

      const savedEventLinks = await getSavedBookmakerEventLinks(this.config.slug, fixtures.map((fixture) => fixture.id));
      for (const fixture of fixtures) {
        const link = savedEventLinks.get(fixture.id) ?? null;
        if (link) savedLinksFound += 1;
        if (!link || !savedEventCollectionUrl(link)) continue;

        const failCount = savedEventFailCount(link);
        if (failCount >= 3) {
          skippedHighFailCount += 1;
          await this.logger("info", "evento cacheado pulado por excesso de falhas", {
            fixtureId: fixture.id,
            eventName: savedBet365EventName(fixture, link),
            failCount,
            lastFailReason: objectRaw(link.raw).lastFailReason ?? "unknown"
          });
          continue;
        }

        queue.push({ fixture, link, leagueSlug });
      }
    }

    this.directRefreshCompleted = true;
    await this.logger("info", "cache de eventos da bet365 analisado", {
      fixtures: fixturesChecked,
      savedLinks: savedLinksFound,
      validUrls: queue.length,
      skippedHighFailCount,
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
    const tabCount = Math.min(Math.max(tabs, 1), Math.max(queue.length, 1));
    let cursor = 0;
    const nextItem = () => {
      const item = queue[cursor];
      cursor += 1;
      return item;
    };

    const groupedResults = await Promise.all(
      Array.from({ length: tabCount }, (_, tabIndex) =>
        this.chrome.withNewTab(async (tab) => {
          const results: Bet365DirectRefreshResult[] = [];
          let processed = 0;
          if (process.env.BET365_DEBUG === "true" || process.env.COLLECT_DEBUG === "true") {
            await this.logger("info", "aba direta da bet365 iniciada", {
              tabIndex: tabIndex + 1,
              tabs: tabCount,
              queue: queue.length
            });
          }

          while (true) {
            const item = nextItem();
            if (!item) break;
            const { fixture, link } = item;
            processed += 1;
            try {
              results.push({
                fixtureId: fixture.id,
                result: await this.collectFixtureDirect(fixture, link, tab)
              });
            } catch (error) {
              const result = emptyFixtureCollectResult();
              result.reason = "nav-error";
              result.lastError = `Refresh direto da Bet365 falhou para ${savedBet365EventName(fixture, link)}.`;
              await this.logger("warn", "refresh direto paralelo da bet365 falhou; fixture vai para discovery", {
                fixtureId: fixture.id,
                eventName: savedBet365EventName(fixture, link),
                canonicalEventName: fixture.name,
                error: errorMessage(error),
                tabIndex: tabIndex + 1
              });
              results.push({ fixtureId: fixture.id, result });
            }
          }

          if (process.env.BET365_DEBUG === "true" || process.env.COLLECT_DEBUG === "true") {
            await this.logger("info", "aba direta da bet365 finalizada", {
              tabIndex: tabIndex + 1,
              tabs: tabCount,
              fixtures: processed
            });
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
    const canonicalFixtures = await getCanonicalFixtures(dateKeys, leagueSlug);
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
    for (const fixture of activeCanonicalFixtures) this.fixturesTargetedThisCycle.add(fixture.id);
    const savedEventLinks = await getSavedBookmakerEventLinks(this.config.slug, activeCanonicalFixtures.map((fixture) => fixture.id));
    const cacheSuccessEventKeys = new Set<string>();
    for (const fixture of activeCanonicalFixtures) {
      const direct = this.directRefreshResults.get(fixture.id);
      if (!direct?.success) continue;
      leagueSummary.eventsCollected += direct.eventsCollected;
      leagueSummary.eventsWithoutOdds += direct.eventsWithoutOdds;
      leagueSummary.oddsFound += direct.oddsFound;
      leagueSummary.oddsUpserted += direct.oddsUpserted;
      const link = savedEventLinks.get(fixture.id);
      const key = link
        ? bet365ListingEventKey(fixture.date_key, link.bookmaker_home_team, link.bookmaker_away_team)
        : null;
      if (key) cacheSuccessEventKeys.add(key);
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
        const listing = await this.chrome.collectEventOdds(candidate.sourceUrl, -1, false, true);
        const allPageEvents = parseBet365LeaguePageEvents(listing.pageText, dateKeys);
        const pageEvents = allPageEvents.slice(0, activeCanonicalFixtures.length);
        leagueSummary.fixturesAvailable = allPageEvents.length;
        leagueSummary.fixturesTargeted = pageEvents.length;
        if (!allPageEvents.length) {
          leagueSummary.lastError = `Nenhum evento D0/D1 encontrado na pagina da liga ${league.name}.`;
          await this.logger("warn", "pagina da liga bet365 sem eventos D0/D1", {
            leagueName: league.name,
            sourceUrl: candidate.sourceUrl,
            pagePreview: listing.pageText.slice(0, 300)
          });
          continue;
        }
        if (!pageEvents.length) continue;

        let collectedAny = false;
        let failedEvents: Bet365LeaguePageEvent[] = [];
        for (let index = 0; index < pageEvents.length; index += 1) {
          const pageEvent = pageEvents[index];
          const pageEventKey = bet365ListingEventKey(pageEvent.dateKey, pageEvent.homeTeam, pageEvent.awayTeam);
          if (pageEventKey && cacheSuccessEventKeys.has(pageEventKey)) {
            collectedAny = true;
            await this.logger("info", "evento da liga bet365 ja atualizado pelo cache", {
              eventName: `${pageEvent.homeTeam} x ${pageEvent.awayTeam}`,
              leagueName: league.name
            });
            continue;
          }
          const canonicalMatch = canonicalFixtures.find((f) =>
            teamNameSimilarity(f.home_team, pageEvent.homeTeam) >= 0.6 &&
            teamNameSimilarity(f.away_team, pageEvent.awayTeam) >= 0.6
          );
          if (canonicalMatch) {
            await this.logger("info", "pre-match encontrado para evento da liga bet365", {
              pageHome: pageEvent.homeTeam,
              pageAway: pageEvent.awayTeam,
              canonicalHome: canonicalMatch.home_team,
              canonicalAway: canonicalMatch.away_team,
              pageStartsAt: pageEvent.startsAt,
              canonicalStartsAt: canonicalMatch.starts_at
            });
          } else {
            await this.logger("warn", "pre-match nao encontrado para evento da liga bet365", {
              pageHome: pageEvent.homeTeam,
              pageAway: pageEvent.awayTeam,
              pageStartsAt: pageEvent.startsAt,
              leagueName: league.name
            });
          }
          const syntheticFixture: CanonicalFixture = {
            id: `bet365-raw:${league.api_football_league_id}:${pageEvent.dateKey}:${normalizeName(pageEvent.homeTeam)}:${normalizeName(pageEvent.awayTeam)}`,
            api_football_fixture_id: 0,
            name: `${pageEvent.homeTeam} x ${pageEvent.awayTeam}`,
            league,
            home_team: pageEvent.homeTeam,
            away_team: pageEvent.awayTeam,
            starts_at: canonicalMatch?.starts_at ?? pageEvent.startsAt,
            date_key: canonicalMatch?.date_key ?? pageEvent.dateKey
          };
          const result = await this.collectFixtureFromLeague(syntheticFixture, candidate.sourceUrl, null, index, canonicalMatch?.id ?? null);
          leagueSummary.eventsCollected += result.eventsCollected;
          leagueSummary.eventsWithoutOdds += result.eventsWithoutOdds;
          leagueSummary.oddsFound += result.oddsFound;
          leagueSummary.oddsUpserted += result.oddsUpserted;
          if (result.success) {
            collectedAny = true;
          } else {
            leagueSummary.errors += 1;
            if (result.lastError) leagueSummary.lastError = result.lastError;
            failedEvents.push(pageEvent);
          }
          if (index < pageEvents.length - 1) await this.chrome.reset(candidate.sourceUrl);
        }

        if (failedEvents.length > 0 && collectedAny) {
          await this.logger("info", "alguns eventos da liga falhou na coleta", {
            leagueName: league.name,
            collectedSuccessfully: pageEvents.length - failedEvents.length,
            failed: failedEvents.length,
            failedEvents: failedEvents.slice(0, 5).map((e) => `${e.homeTeam} x ${e.awayTeam}`)
          });
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
    }
    return leagueSummary;
  }

  private async collectFixtureFromTextFile(fixture: CanonicalFixture): Promise<Bet365FixtureCollectResult> {
    const result = emptyFixtureCollectResult();
    const rawText = await readFile(this.config.eventTextFile ?? "", "utf8");
    await this.logger("info", "payload bet365 lido de arquivo", { file: this.config.eventTextFile, fixtureId: fixture.id });
    const event = buildBet365UnmatchedEvent(this.config.competitionUrl ?? this.config.baseUrl, rawText.split(/\n+/).filter(Boolean));

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
      eventName: savedBet365EventName(fixture, link),
      canonicalEventName: fixture.name,
      leagueName: league?.name ?? null,
      sourceUrl: collectionUrl,
      failCount: savedEventFailCount(link)
    });

    const collectResult = await this.collectFromNetworkUrl(fixture, collectionUrl, false, -1, tab);
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
    if (result.success) this.fixturesCollectedReliably.add(fixture.id);
    return result;
  }

  private async collectFixtureFromLeague(fixture: CanonicalFixture, competitionUrl: string, savedLink: SavedBookmakerEventLink | null, eventIndex: number, confirmedFixtureId: string | null = null): Promise<Bet365FixtureCollectResult> {
    const league = fixtureLeague(fixture);
    const result = emptyFixtureCollectResult();

    if (this.config.eventTextFile) return this.collectFixtureFromTextFile(fixture);

    await this.logger("info", "coletando jogo bet365 com automacao local", {
      fixtureId: fixture.id,
      eventName: savedLink ? savedBet365EventName(fixture, savedLink) : fixture.name,
      canonicalEventName: fixture.name,
      leagueName: league?.name ?? null,
      eventIndex,
      hasSavedEventUrl: Boolean(savedEventCollectionUrl(savedLink)),
      confirmedFixtureId
    });

    const collectResult = await this.collectFromNetworkUrl(fixture, competitionUrl, true, eventIndex);
    if (!collectResult.ok) {
      result.reason = collectResult.reason;
      result.lastError = `Bet365 nao retornou odds para ${fixture.home_team ?? "HOME"} x ${fixture.away_team ?? "AWAY"}.`;
      await this.logger("warn", "camada de discovery da bet365 falhou", {
        fixtureId: fixture.id,
        sourceUrl: competitionUrl,
        reason: collectResult.reason
      });
      return result;
    }

    const event = collectResult.event;

    const MIN_WRONG_EVENT_SIDE_SCORE = 0.4;
    if (fixture.home_team && fixture.away_team && event.bookmakerHomeTeam && event.bookmakerAwayTeam) {
      const homeOk = Math.max(
        teamNameSimilarity(fixture.home_team, event.bookmakerHomeTeam),
        teamNameSimilarity(fixture.home_team, event.bookmakerAwayTeam)
      ) >= MIN_WRONG_EVENT_SIDE_SCORE;
      const awayOk = Math.max(
        teamNameSimilarity(fixture.away_team, event.bookmakerAwayTeam),
        teamNameSimilarity(fixture.away_team, event.bookmakerHomeTeam)
      ) >= MIN_WRONG_EVENT_SIDE_SCORE;
      if (!homeOk || !awayOk) {
        result.reason = "match-error";
        result.lastError = `Bet365 abriu evento diferente do esperado: esperado ${fixture.home_team} x ${fixture.away_team}, recebido ${event.bookmakerHomeTeam} x ${event.bookmakerAwayTeam}.`;
        await this.logger("warn", "clique de linha da bet365 rejeitado", {
          expectedHome: fixture.home_team,
          expectedAway: fixture.away_team,
          capturedHome: event.bookmakerHomeTeam,
          capturedAway: event.bookmakerAwayTeam,
          eventName: event.eventName,
          eventIndex
        });
        return result;
      }
    }

    result.eventsCollected += 1;
    if (!event.markets.length) result.eventsWithoutOdds += 1;

    const persisted = await this.persistEvent(fixture, event, {
      layer: "discovery",
      collectionUrl: event.sourceUrl,
      rawSourceUrl: event.sourceUrl,
      discoveredFromLeagueUrl: competitionUrl,
      confirmedFixtureId,
      previousRaw: savedLink?.raw
    });
    result.oddsFound += persisted.oddsFound;
    result.oddsUpserted += persisted.oddsUpserted;
    result.success = persisted.oddsFound > 0;
    return result;
  }

  private async collectFromNetworkUrl(
    canonicalFixture: CanonicalFixture,
    sourceUrl: string,
    clickEvent: boolean,
    eventIndex: number,
    tab?: Bet365ChromeTabSession
  ): Promise<Bet365CollectResult> {
    let lastReason: Bet365CollectFailReason = "timeout";
    let parseErrorCount = 0;
    let marketTimeoutCount = 0;
    const maxParseErrorAttempts = 5;
    const maxMarketTimeoutAttempts = 5;
    const debugAttempts = process.env.BET365_DEBUG === "true" || process.env.COLLECT_DEBUG === "true";

    const attemptLimit = (reason: Bet365CollectFailReason | null) => {
      if (reason === "parse-error") return maxParseErrorAttempts;
      if (reason === "market-timeout") return maxMarketTimeoutAttempts;
      return 3;
    };

    let attempt = 0;
    let maxAttempt = 3;
    while (attempt < maxAttempt) {
      attempt += 1;
      if (attempt > 1) {
        const delayMs = Math.min(1000 + (attempt - 2) * 500, 3000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      await this.logger("info", "escutando WebSocket da bet365", { fixtureId: canonicalFixture.id, sourceUrl, clickEvent, eventIndex, attempt, maxAttempt });
      try {
        const forceNavigate = attempt > 1;
        const homeTeam = canonicalFixture.home_team ?? "";
        const awayTeam = canonicalFixture.away_team ?? "";
        const capture = tab
          ? await tab.collectEventOdds(sourceUrl, eventIndex, clickEvent, forceNavigate, homeTeam, awayTeam)
          : await this.chrome.collectEventOdds(sourceUrl, eventIndex, clickEvent, forceNavigate, homeTeam, awayTeam);

        // Verifica se um evento foi aberto (URL de evento Bet365 esperada)
        const eventWasOpened = isBet365EventUrl(capture.sourceUrl);
        if (!eventWasOpened) {
          lastReason = "match-error";
          if (attempt === maxAttempt || debugAttempts) {
            await this.logger("warn", "pagina aberta pela bet365 nao e um evento valido", {
              fixtureId: canonicalFixture.id,
              fixtureName: canonicalFixture.name,
              eventIndex,
              sourceUrl: capture.sourceUrl,
              pageState: capture.pageState,
              attempt,
              maxAttempt
            });
          }
          continue;
        }

        const rawText = capture.payloads.join("\n");
        const payloadEvent = buildBet365UnmatchedEvent(capture.sourceUrl, capture.payloads);
        const domEvent = capture.domMarkets.length
          ? buildBet365UnmatchedEventFromDomMarkets(capture.sourceUrl, capture.domMarkets)
          : null;
        const event = mergeBet365EventMarkets(payloadEvent, domEvent);

        if (!event.markets.length) {
          lastReason = "parse-error";
          parseErrorCount += 1;
          maxAttempt = Math.max(maxAttempt, attemptLimit("parse-error"));
          if (attempt === maxAttempt || debugAttempts) {
            const dumpFile = await maybeDumpBet365Payloads(canonicalFixture, capture.sourceUrl, capture.payloads);
            const payloadSummary = summarizeBet365Payloads(capture.payloads);
            await this.logger("warn", "payloads da bet365 capturados, mas decoder nao encontrou mercado 1X2", {
              fixtureId: canonicalFixture.id,
              sourceUrl: capture.sourceUrl,
              pageState: capture.pageState,
              payloads: capture.payloads.length,
              domMarkets: capture.domMarkets.length,
              domMarketsExpanded: capture.domMarketsExpanded,
              dumpFile,
              payloadSummary,
              preview: rawText.slice(0, 300),
              pagePreview: capture.pageText.slice(0, 300),
              attempt,
              maxAttempt,
              parseErrorCount
            });
          }
          continue;
        }

        if (!hasCollectableBet365Market(event)) {
          lastReason = "market-timeout";
          marketTimeoutCount += 1;
          maxAttempt = Math.max(maxAttempt, attemptLimit("market-timeout"));
          if (attempt === maxAttempt || debugAttempts) {
            await this.logger("warn", "nenhum mercado 1X2 completo da bet365 foi encontrado", {
              fixtureId: canonicalFixture.id,
              sourceUrl: capture.sourceUrl,
              pageState: capture.pageState,
              payloads: capture.payloads.length,
              domMarkets: capture.domMarkets.length,
              domMarketsExpanded: capture.domMarketsExpanded,
              markets: event.markets.map((market) => market.paCategory),
              attempt,
              maxAttempt,
              marketTimeoutCount
            });
          }
          continue;
        }

        await this.logger("info", "odds da bet365 capturadas via WebSocket", {
          fixtureId: canonicalFixture.id,
          capturedEvent: event.eventName,
          sourceUrl: capture.sourceUrl,
          pageState: capture.pageState,
          payloads: capture.payloads.length,
          domMarkets: capture.domMarkets.length,
          domMarketsExpanded: capture.domMarketsExpanded,
          markets: event.markets.length,
          categories: marketsSeen(event),
          missingCategories: missingBet365MarketCategories(event),
          attempt,
          parseErrorsEncountered: parseErrorCount
        });

        return { ok: true, event };
      } catch (error) {
        lastReason = "nav-error";
        if (attempt === maxAttempt || debugAttempts) {
          await this.logger("warn", "captura WebSocket da bet365 falhou", {
            fixtureId: canonicalFixture.id,
            sourceUrl,
            attempt,
            maxAttempt,
            error: errorMessage(error)
          });
        }
      }
    }

    return { ok: false, reason: lastReason };
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
          awayTeam: fixture.away_team,
          eventName: event.eventName,
          context: context.layer,
          bookmakerTeams: `${event.bookmakerHomeTeam} x ${event.bookmakerAwayTeam}`
        });
        return { oddsFound: 0, oddsUpserted: 0 };
      }

      if (!hasCollectableBet365Market(event)) {
        await this.logger("warn", "snapshot da bet365 sem mercado 1X2 completo ignorado", {
          fixtureId: fixture.id,
          eventName: event.eventName,
          externalEventId: event.externalEventId,
          markets: event.markets.map((m) => m.paCategory),
          context: context.layer
        });
        return { oddsFound: 0, oddsUpserted: 0 };
      }

      const league = fixtureLeague(fixture);
      const updatedAt = new Date().toISOString();
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
          external_event_id: event.externalEventId,
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
          raw: { stage: "unmatched", candidateFixtureId: fixture.id, confirmedFixtureId: context.confirmedFixtureId ?? null, context },
          updated_at: updatedAt
        },
        { onConflict: "bookmaker_slug,external_event_id" }
      );
      if (error) throw error;
      const oddsFound = event.markets.reduce((total, market) => total + market.selections.length, 0);
      await this.logger("info", "snapshot bruto da bet365 salvo", {
        eventName: event.eventName,
        externalEventId: event.externalEventId,
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

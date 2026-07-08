import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents } from "../domain/matching/event-matcher.js";
import { teamNameSimilarity } from "../domain/matching/text-similarity.js";
import { normalizeName } from "../domain/text.js";
import { buildBet365Event, buildBet365EventFromDomMarkets, summarizeBet365Payloads } from "../providers/bet365/parser.js";
import type { Bet365Event, Bet365FixtureTarget, Bet365Market, Logger } from "../providers/bet365/types.js";
import { ChromeClient, type Bet365ChromeTabSession } from "../providers/bet365/chrome-client.js";
import { isFixturePrematchForOddsRefresh as isPrematch } from "./collector-resilience.js";
import { Bet365CollectionStateRepository } from "./bet365-collection-state.js";
import { requestBookmakerLeagueUrl, resolveBookmakerLeagueUrlRequest } from "./bookmaker-league-url-requests.js";
import { getSavedBookmakerEventLinks, objectRaw, type SavedBookmakerEventLink } from "./saved-bookmaker-events.js";
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

function candidateTeamEvidence(fixture: Bet365FixtureTarget, homeTeam: string | null, awayTeam: string | null) {
  if (!fixture.homeTeam || !fixture.awayTeam || !homeTeam || !awayTeam) {
    return { pairScore: 0, minPairSideScore: 0, bestSingleTeamScore: 0 };
  }

  const normalHome = teamNameSimilarity(fixture.homeTeam, homeTeam);
  const normalAway = teamNameSimilarity(fixture.awayTeam, awayTeam);
  const invertedHome = teamNameSimilarity(fixture.homeTeam, awayTeam);
  const invertedAway = teamNameSimilarity(fixture.awayTeam, homeTeam);
  const normalPair = { score: (normalHome + normalAway) / 2, minSideScore: Math.min(normalHome, normalAway) };
  const invertedPair = { score: (invertedHome + invertedAway) / 2, minSideScore: Math.min(invertedHome, invertedAway) };
  const selectedPair = normalPair.score >= invertedPair.score ? normalPair : invertedPair;

  return {
    pairScore: selectedPair.score,
    minPairSideScore: selectedPair.minSideScore,
    bestSingleTeamScore: Math.max(normalHome, normalAway, invertedHome, invertedAway)
  };
}

function candidateTeamsHaveBet365Evidence(fixture: Bet365FixtureTarget, homeTeam: string | null, awayTeam: string | null) {
  const evidence = candidateTeamEvidence(fixture, homeTeam, awayTeam);
  return (
    (evidence.pairScore >= 0.66 && evidence.minPairSideScore >= 0.58) ||
    evidence.bestSingleTeamScore >= 0.88
  );
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

    if (candidateTeamsHaveBet365Evidence(fixture, homeTeam, awayTeam)) {
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
      if (candidateTeamsHaveBet365Evidence(fixture, parts[0], parts[1])) {
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

    if (homeTeam && awayTeam && candidateTeamsHaveBet365Evidence(fixture, homeTeam, awayTeam)) return { homeTeam, awayTeam };
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

  const fixtureTarget = fixtureTargetFromCanonical(fixture);
  const marketTeams = marketTeamsFromSelections(event, fixtureTarget);
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

  if (match.matched) return { ok: true as const, match };

  const evidence = candidateTeamEvidence(fixtureTarget, event.bookmakerHomeTeam, event.bookmakerAwayTeam);
  if (evidence.bestSingleTeamScore >= 0.88) {
    return {
      ok: true as const,
      match: {
        ...match,
        matched: true,
        score: Math.max(match.score, evidence.bestSingleTeamScore * 0.78),
        teamScore: Math.max(match.teamScore, evidence.bestSingleTeamScore),
        reason: "single-team-bet365-league-evidence"
      }
    };
  }

  return { ok: false as const, reason: match.reason, score: match.score };
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
  if (message === "iniciando refresh direto global da bet365 por URLs cacheadas") {
    return `[bet365] Monitorando URLs salvas em ${contextValue(context, "tabs")} abas: ${contextValue(context, "fixtures")} jogos.`;
  }
  if (message === "iniciando refresh direto da bet365 por URLs cacheadas") {
    return `[bet365] Monitorando URLs salvas em ${contextValue(context, "tabs")} abas: ${contextValue(context, "fixtures")} jogos.`;
  }
  if (message === "abrindo liga da bet365 por URL") return `[bet365] Abrindo liga por URL: ${contextValue(context, "leagueName")}.`;
  if (message === "jogo da bet365 salvo no banco") return `[bet365] Odds salvas: ${contextValue(context, "eventName")} | ${contextValue(context, "oddsUpserted")} odds.`;
  if (message === "coleta da bet365 finalizada") {
    return `[bet365] Coleta finalizada: ${contextValue(context, "eventsCollected")} jogos coletados | ${contextValue(context, "oddsUpserted")} odds salvas | ${contextValue(context, "errors")} erros.`;
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
  if (/enhanced prices|precos ajustados|preços ajustados|pagamento antecipado|early payout/i.test(market.rawText)) score += 1;
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
    .from("bookmaker_event_links")
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

function bet365DirectTabCount(configuredTabs: number | null | undefined, itemCount: number) {
  return Math.min(Math.max(configuredTabs || 1, 1), 2, Math.max(itemCount, 1));
}

export class Bet365Collector {
  private readonly directRefreshResults = new Map<string, Bet365FixtureCollectResult>();
  private directRefreshCompleted = false;
  private persistQueue: Promise<void> = Promise.resolve();

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
        this.directRefreshResults.clear();
        this.directRefreshCompleted = false;
        await this.collectCachedDirectForTargetLeagues(targetLeagueSlugs, dateKeys);

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

    const directTabs = bet365DirectTabCount(this.config.monitorTabs, queue.length);
    await this.logger("info", "iniciando refresh direto global da bet365 por URLs cacheadas", {
      fixtures: queue.length,
      tabs: directTabs,
      leagues: new Set(queue.map((item) => item.leagueSlug)).size
    });

    const queueByLeague = new Map<string, Bet365CachedDirectItem[]>();
    for (const item of queue) {
      const leagueQueue = queueByLeague.get(item.leagueSlug) ?? [];
      leagueQueue.push(item);
      queueByLeague.set(item.leagueSlug, leagueQueue);
    }

    for (const leagueQueue of queueByLeague.values()) {
      const leagueTabs = bet365DirectTabCount(this.config.monitorTabs, leagueQueue.length);
      const directResults = await this.collectCachedDirectCarousel(leagueQueue, leagueTabs);

      for (const { fixtureId, result } of directResults) {
        this.directRefreshResults.set(fixtureId, result);
      }
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
      leagueUrlsOpened: 0,
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
    const savedEventLinks = await getSavedBookmakerEventLinks(this.config.slug, fixtures.map((fixture) => fixture.id));
    const processedFixtureIds = new Set<string>();
    const attemptedLeagueUrls: Bet365LeagueUrlCandidate[] = [];
    let openedAnyLeagueUrl = false;
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
        const directTabs = bet365DirectTabCount(this.config.monitorTabs, cachedDirectQueue.length);
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
        openedAnyLeagueUrl = true;
        leagueSummary.leagueUrlsOpened += 1;
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

    if (!processedFixtureIds.size && !openedAnyLeagueUrl) {
      await requestLeagueUrlUpdate(this.config, firstLeague, savedLeagueLink?.source_url ?? null, attemptedLeagueUrls, this.logger);
    } else if (!processedFixtureIds.size && openedAnyLeagueUrl) {
      await this.logger("warn", "liga da bet365 abriu, mas nenhum evento alvo foi coletado", {
        leagueName: firstLeague.name,
        apiFootballLeagueId: firstLeague.api_football_league_id,
        attemptedUrls: attemptedLeagueUrls.map((candidate) => ({ source: candidate.source, label: candidate.label, sourceUrl: candidate.sourceUrl }))
      });
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
    const attempts = 3;
    const debugAttempts = process.env.BET365_DEBUG === "true" || process.env.COLLECT_DEBUG === "true";

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.logger("info", "escutando WebSocket da bet365", { fixtureId: fixture.id, sourceUrl, clickEvent, attempt, attempts });
      try {
        const forceNavigate = attempt > 1;
        const capture = tab
          ? await tab.collectEventOdds(sourceUrl, fixture, clickEvent, forceNavigate)
          : await this.chrome.collectEventOdds(sourceUrl, fixture, clickEvent, forceNavigate);
        const rawText = capture.payloads.join("\n");
        const payloadEvent = applyVisibleEventIdentity(buildBet365Event(fixture, capture.sourceUrl, capture.payloads), fixture, capture.pageText);
        const domEvent = capture.domMarkets.length
          ? applyVisibleEventIdentity(buildBet365EventFromDomMarkets(fixture, capture.sourceUrl, capture.domMarkets), fixture, capture.pageText)
          : null;
        const event = mergeBet365EventMarkets(payloadEvent, domEvent);
        if (!event.markets.length) {
          lastReason = "parse-error";
          if (attempt === attempts || debugAttempts) {
            const dumpFile = await maybeDumpBet365Payloads(fixture, capture.sourceUrl, capture.payloads);
            const payloadSummary = summarizeBet365Payloads(capture.payloads);
            await this.logger("warn", "payloads da bet365 capturados, mas decoder nao encontrou mercado 1X2", {
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
            });
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

        const validation = validateCollectedEvent(canonicalFixture, event);
        if (!validation.ok) {
          lastReason = "match-error";
          if (attempt === attempts || debugAttempts) {
            await this.logger("warn", "evento da bet365 rejeitado no matching", {
              fixtureId: fixture.id,
              sourceUrl: capture.sourceUrl,
              homeTeam: fixture.homeTeam,
              awayTeam: fixture.awayTeam,
              bookmakerHomeTeam: event.bookmakerHomeTeam,
              bookmakerAwayTeam: event.bookmakerAwayTeam,
              pageState: capture.pageState,
              markets: event.markets.map((market) => market.paCategory),
              missingCategories: missingBet365MarketCategories(event),
              reason: validation.reason,
              score: validation.score,
              attempt,
              attempts
            });
          }
          continue;
        }

        await this.logger("info", "odds da bet365 capturadas via WebSocket", {
          fixtureId: fixture.id,
          sourceUrl: capture.sourceUrl,
          pageState: capture.pageState,
          clickedTeam: capture.clickedTeam,
          payloads: capture.payloads.length,
          domMarkets: capture.domMarkets.length,
          domMarketsExpanded: capture.domMarketsExpanded,
          markets: event.markets.length,
          categories: marketsSeen(event),
          missingCategories: missingBet365MarketCategories(event),
          matchScore: validation.match.score
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
        await this.logger("warn", "jogo bruto coletado, mas nenhum mercado 1X2 foi identificado na bet365", {
          fixtureId: fixture.id,
          homeTeam: fixture.home_team,
          awayTeam: fixture.away_team
        });
        return { oddsFound: 0, oddsUpserted: 0 };
      }

      const link = buildBookmakerLink(this.config, fixture, event, context);
      const odds = buildMoneylineOdds(this.config, fixture, event);
      const oddsUpserted = await OddsRepository.saveAll(this.config.slug, [link], odds, { replaceExistingOdds: true });
      const { error: linkRawError } = await supabase
        .from("bookmaker_event_links")
        .update({ source_url: link.source_url, raw: link.raw, updated_at: link.updated_at })
        .eq("bookmaker_slug", link.bookmaker_slug)
        .eq("fixture_id", link.fixture_id);
      if (linkRawError) {
        await this.logger("warn", "nao consegui atualizar raw do link bet365", {
          fixtureId: fixture.id,
          sourceUrl: link.source_url,
          error: errorMessage(linkRawError)
        });
      }
      await this.logger("info", "jogo da bet365 salvo no banco", {
        fixtureId: fixture.id,
        eventName: event.eventName,
        oddsFound: odds.length,
        oddsUpserted
      });
      return { oddsFound: odds.length, oddsUpserted };
    });
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

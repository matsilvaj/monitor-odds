import { createHash } from "node:crypto";
import pMap from "p-map";
import { env } from "../config/env.js";
import { supabase } from "../db/supabase.js";
import { groundedKickoffMatches } from "../domain/matching/grounded-identity.js";
import {
  findBestCanonicalEventMatch,
  type EventMatchResult,
  type MatchableEvent,
  type MatchEventsOptions
} from "../domain/matching/event-matcher.js";
import { normalizeForMatching } from "../domain/matching/text-similarity.js";
import { errorMessage } from "../utils/errors.js";
import {
  discoverGroundedTeamIdentity,
  groundedTeamIdentityEnabled,
  type BookmakerIdentityQuestion,
  type GroundedTeamIdentity
} from "./gemini-team-identity.js";
import { refreshLearnedTeamAliases, saveGroundedTeamAliases } from "./team-alias-store.js";

type CandidateRecord = Record<string, unknown>;

type QueueOptions = MatchEventsOptions & {
  bookmakerSlug: string;
  leagueCountry?: string | null;
};

type PendingAttemptRow = {
  id: string;
  bookmaker_slug: string;
  event_key: string;
  event_hash: string;
  bookmaker_home_team: string;
  bookmaker_away_team: string;
  league_name: string | null;
  starts_at: string;
  status: "pending";
  attempt_count: number;
  raw_request: unknown;
  updated_at: string;
};

type FixtureIdentityRow = {
  id: string;
  league_id: string;
  home_team_id: string;
  away_team_id: string;
  home_team: string;
  away_team: string;
  starts_at: string;
  league: { name: string; country: string | null } | Array<{ name: string; country: string | null }> | null;
};

type ResidualRequest = {
  candidateFixtureIds?: string[];
  candidateFingerprint?: string;
  leagueCountry?: string | null;
  matchOptions?: {
    context?: "strict" | "league-scoped";
    trustedLeagueScope?: boolean;
    maxTimeDiffMs?: number;
    pairScoreMargin?: number;
  };
};

export type ResidualIdentitySummary = {
  queued: number;
  processed: number;
  resolved: number;
  exhausted: number;
  conflicts: number;
  disabled: number;
  errors: number;
  resolvedFixtureIds: string[];
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function candidateValue(candidate: unknown, camel: string, snake: string) {
  const record = objectValue(candidate);
  return record[camel] ?? record[snake] ?? null;
}

function candidateFingerprint(candidates: unknown[]) {
  return candidates
    .map((candidate) => {
      const id = String(candidateValue(candidate, "id", "id") ?? "");
      const startsAt = String(candidateValue(candidate, "startsAt", "starts_at") ?? "");
      const home = normalizeForMatching(candidateValue(candidate, "homeTeam", "home_team"));
      const away = normalizeForMatching(candidateValue(candidate, "awayTeam", "away_team"));
      return [id, startsAt, home, away].join(":");
    })
    .sort()
    .join("|");
}

export function residualEventHash(question: BookmakerIdentityQuestion, candidates: unknown[]) {
  const material = [
    question.bookmakerSlug,
    normalizeForMatching(question.homeTeam),
    normalizeForMatching(question.awayTeam),
    normalizeForMatching(question.leagueName),
    new Date(question.startsAt).toISOString(),
    candidateFingerprint(candidates)
  ].join("|");
  return createHash("sha256").update(material).digest("hex");
}

function candidateIds(candidates: unknown[]) {
  return [
    ...new Set(
      candidates
        .map((candidate) => candidateValue(candidate, "id", "id"))
        .filter((value) => value !== undefined && value !== null)
        .map(String)
    )
  ];
}

type StagedResidualIdentity = {
  question: BookmakerIdentityQuestion;
  canonicalCandidates: unknown[];
  options: QueueOptions;
};

const stagedResidualIdentities = new Map<string, Map<string, StagedResidualIdentity>>();
const matchedEventKeys = new Map<string, Set<string>>();
const matchedFixtureIds = new Map<string, Set<string>>();

function trackingSet(map: Map<string, Set<string>>, bookmakerSlug: string) {
  const values = map.get(bookmakerSlug) ?? new Set<string>();
  map.set(bookmakerSlug, values);
  return values;
}

function clearResidualTracking(bookmakerSlug: string) {
  stagedResidualIdentities.delete(bookmakerSlug);
  matchedEventKeys.delete(bookmakerSlug);
  matchedFixtureIds.delete(bookmakerSlug);
}

export function discardStagedResidualIdentities(bookmakerSlug: string) {
  clearResidualTracking(bookmakerSlug);
}

export function stagedResidualIdentityCount(bookmakerSlug: string) {
  return stagedResidualIdentities.get(bookmakerSlug)?.size ?? 0;
}

export function markResidualIdentityMatched(bookmakerSlug: string, eventKey: string, fixtureId: string | null) {
  trackingSet(matchedEventKeys, bookmakerSlug).add(eventKey);
  if (fixtureId) trackingSet(matchedFixtureIds, bookmakerSlug).add(fixtureId);

  const staged = stagedResidualIdentities.get(bookmakerSlug);
  if (!staged) return;
  for (const [hash, entry] of staged) {
    if (entry.question.eventKey === eventKey || (fixtureId && candidateIds(entry.canonicalCandidates).includes(fixtureId))) {
      staged.delete(hash);
    }
  }
  if (!staged.size) stagedResidualIdentities.delete(bookmakerSlug);
}

export async function enqueueResidualIdentity(
  question: BookmakerIdentityQuestion,
  canonicalCandidates: unknown[],
  options: QueueOptions
) {
  if (!groundedTeamIdentityEnabled()) return false;
  const fixtureIds = candidateIds(canonicalCandidates);
  if (!fixtureIds.length) return false;
  if (matchedEventKeys.get(question.bookmakerSlug)?.has(question.eventKey)) return false;
  if (fixtureIds.some((fixtureId) => matchedFixtureIds.get(question.bookmakerSlug)?.has(fixtureId))) return false;

  const eventHash = residualEventHash(question, canonicalCandidates);
  const staged = stagedResidualIdentities.get(question.bookmakerSlug) ?? new Map<string, StagedResidualIdentity>();
  staged.set(eventHash, { question, canonicalCandidates, options });
  stagedResidualIdentities.set(question.bookmakerSlug, staged);
  return true;
}

async function persistResidualIdentity(entry: StagedResidualIdentity) {
  const { question, canonicalCandidates, options } = entry;
  const fixtureIds = candidateIds(canonicalCandidates);
  const eventHash = residualEventHash(question, canonicalCandidates);
  const { data: previous, error: readError } = await supabase
    .from("team_resolution_attempts")
    .select("status,attempt_count,retry_after")
    .eq("bookmaker_slug", question.bookmakerSlug)
    .eq("event_hash", eventHash)
    .maybeSingle();
  if (readError) throw readError;

  if (previous && ["resolved", "conflict", "exhausted"].includes(String(previous.status))) return false;

  const now = new Date().toISOString();
  const rawRequest: ResidualRequest = {
    candidateFixtureIds: fixtureIds,
    candidateFingerprint: candidateFingerprint(canonicalCandidates),
    leagueCountry: options.leagueCountry ?? null,
    matchOptions: {
      context: options.context,
      trustedLeagueScope: options.trustedLeagueScope,
      maxTimeDiffMs: options.maxTimeDiffMs,
      pairScoreMargin: options.pairScoreMargin
    }
  };
  const { error } = await supabase.from("team_resolution_attempts").upsert(
    {
      bookmaker_slug: question.bookmakerSlug,
      event_key: question.eventKey,
      event_hash: eventHash,
      bookmaker_home_team: question.homeTeam,
      bookmaker_away_team: question.awayTeam,
      league_name: question.leagueName ?? null,
      starts_at: new Date(question.startsAt).toISOString(),
      status: "pending",
      attempt_count: Number(previous?.attempt_count ?? 0),
      model: env.GEMINI_MODEL,
      raw_request: rawRequest,
      last_error: null,
      retry_after: null,
      updated_at: now
    },
    { onConflict: "bookmaker_slug,event_hash" }
  );
  if (error) throw error;
  return true;
}

export async function flushResidualIdentityQueue(bookmakerSlug: string) {
  const staged = [...(stagedResidualIdentities.get(bookmakerSlug)?.values() ?? [])];
  clearResidualTracking(bookmakerSlug);
  let queued = 0;
  for (const entry of staged) {
    if (await persistResidualIdentity(entry)) queued += 1;
  }
  return queued;
}

function relatedLeague(row: FixtureIdentityRow) {
  return Array.isArray(row.league) ? row.league[0] ?? null : row.league;
}

async function loadCandidateFixtures(ids: string[]) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("fixtures")
    .select("id,league_id,home_team_id,away_team_id,home_team,away_team,starts_at,league:leagues(name,country)")
    .in("id", ids);
  if (error) throw error;
  return (data ?? []) as unknown as FixtureIdentityRow[];
}

async function fixtureAlreadyClaimed(bookmakerSlug: string, eventKey: string, eventHash: string, fixtureId: string) {
  const numericEventKey = /^\d+$/.test(eventKey) ? eventKey : null;
  const [links, attempts] = await Promise.all([
    numericEventKey
      ? supabase
          .from("bookmaker_event_links")
          .select("fixture_id")
          .eq("bookmaker_slug", bookmakerSlug)
          .eq("external_event_id", numericEventKey)
          .limit(5)
      : Promise.resolve({ data: [] as Array<{ fixture_id: string }>, error: null }),
    supabase
      .from("team_resolution_attempts")
      .select("event_hash")
      .eq("bookmaker_slug", bookmakerSlug)
      .eq("fixture_id", fixtureId)
      .eq("status", "resolved")
      .neq("event_hash", eventHash)
      .limit(5)
  ]);
  if (links.error) throw links.error;
  if (attempts.error) throw attempts.error;
  return (links.data ?? []).some((row) => String(row.fixture_id) !== fixtureId) || (attempts.data?.length ?? 0) > 0;
}

function groundedRaw(identity: GroundedTeamIdentity) {
  return {
    identity: {
      sameEventFound: identity.sameEventFound,
      officialHomeTeam: identity.officialHomeTeam,
      officialAwayTeam: identity.officialAwayTeam,
      competition: identity.competition ?? null,
      country: identity.country ?? null,
      kickoff: identity.kickoff ?? null,
      confidence: identity.confidence,
      explanation: identity.explanation ?? null
    },
    sources: identity.sources,
    searchQueries: identity.searchQueries,
    gemini: identity.raw
  };
}

async function saveAliases(
  row: PendingAttemptRow,
  fixture: FixtureIdentityRow,
  identity: GroundedTeamIdentity,
  orientation: EventMatchResult["orientation"]
) {
  const homeTeamId = orientation === "NORMAL" ? fixture.home_team_id : fixture.away_team_id;
  const awayTeamId = orientation === "NORMAL" ? fixture.away_team_id : fixture.home_team_id;
  const homeCanonicalName = orientation === "NORMAL" ? fixture.home_team : fixture.away_team;
  const awayCanonicalName = orientation === "NORMAL" ? fixture.away_team : fixture.home_team;
  const evidence = {
    sources: identity.sources,
    searchQueries: identity.searchQueries,
    competition: identity.competition ?? null,
    kickoff: identity.kickoff ?? null
  };

  const saved = await saveGroundedTeamAliases([
    {
      teamId: homeTeamId,
      canonicalName: homeCanonicalName,
      alias: row.bookmaker_home_team,
      bookmakerSlug: row.bookmaker_slug,
      leagueId: fixture.league_id,
      confidence: identity.confidence,
      evidence
    },
    {
      teamId: awayTeamId,
      canonicalName: awayCanonicalName,
      alias: row.bookmaker_away_team,
      bookmakerSlug: row.bookmaker_slug,
      leagueId: fixture.league_id,
      confidence: identity.confidence,
      evidence
    },
    {
      teamId: homeTeamId,
      canonicalName: homeCanonicalName,
      alias: identity.officialHomeTeam,
      bookmakerSlug: row.bookmaker_slug,
      leagueId: fixture.league_id,
      confidence: identity.confidence,
      evidence
    },
    {
      teamId: awayTeamId,
      canonicalName: awayCanonicalName,
      alias: identity.officialAwayTeam,
      bookmakerSlug: row.bookmaker_slug,
      leagueId: fixture.league_id,
      confidence: identity.confidence,
      evidence
    }
  ]);

  return { ...saved, homeTeamId, awayTeamId };
}

async function updateAttempt(id: string, values: Record<string, unknown>) {
  const { error } = await supabase
    .from("team_resolution_attempts")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

function matchOptions(rawRequest: ResidualRequest): MatchEventsOptions {
  const raw = rawRequest.matchOptions ?? {};
  return {
    context: raw.context,
    trustedLeagueScope: raw.trustedLeagueScope,
    maxTimeDiffMs: raw.maxTimeDiffMs,
    pairScoreMargin: raw.pairScoreMargin
  };
}

async function resolveAttempt(row: PendingAttemptRow) {
  const rawRequest = objectValue(row.raw_request) as ResidualRequest;
  const fixtureIds = Array.isArray(rawRequest.candidateFixtureIds)
    ? rawRequest.candidateFixtureIds.map(String).filter(Boolean)
    : [];
  const fixtures = await loadCandidateFixtures(fixtureIds);
  if (!fixtures.length) throw new Error("Fila residual sem fixtures canonicas validas.");

  const candidates = fixtures.map((fixture) => ({
    ...fixture,
    leagueName: relatedLeague(fixture)?.name ?? null
  }));
  const question: BookmakerIdentityQuestion = {
    bookmakerSlug: row.bookmaker_slug,
    eventKey: row.event_key,
    homeTeam: row.bookmaker_home_team,
    awayTeam: row.bookmaker_away_team,
    leagueName: row.league_name,
    leagueCountry: rawRequest.leagueCountry ?? null,
    startsAt: row.starts_at,
    canonicalEvents: fixtures.map((fixture) => ({
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team,
      startsAt: fixture.starts_at,
      leagueName: relatedLeague(fixture)?.name ?? null
    }))
  };
  const options = matchOptions(rawRequest);
  let attemptCount = row.attempt_count;

  for (; attemptCount < env.TEAM_IDENTITY_MAX_ATTEMPTS; attemptCount += 1) {
    const attempt = attemptCount + 1;
    await updateAttempt(row.id, {
      status: "pending",
      attempt_count: attempt,
      model: env.GEMINI_MODEL,
      last_error: null,
      retry_after: null
    });

    try {
      const identity = await discoverGroundedTeamIdentity(question, attempt);
      if (!identity) {
        await updateAttempt(row.id, { status: "disabled", attempt_count: attempt });
        return { status: "disabled" as const, fixtureId: null };
      }
      if (!identity.sameEventFound) throw new Error("A pesquisa nao confirmou o confronto completo.");
      if (identity.confidence < 0.9) throw new Error("Confianca insuficiente para aprender o alias.");
      if (!groundedKickoffMatches(question.startsAt, identity.kickoff)) {
        throw new Error("A data fundamentada nao corresponde ao evento da casa.");
      }

      const resolvedEvent: MatchableEvent = {
        id: row.event_key,
        startsAt: row.starts_at,
        homeTeam: identity.officialHomeTeam,
        awayTeam: identity.officialAwayTeam,
        leagueName: identity.competition ?? row.league_name
      };
      const resolvedMatch = findBestCanonicalEventMatch(candidates, resolvedEvent, options);
      if (!resolvedMatch) throw new Error("As identidades nao formam um fixture canonico unico.");

      const fixture = resolvedMatch.fixture as FixtureIdentityRow;
      if (await fixtureAlreadyClaimed(row.bookmaker_slug, row.event_key, row.event_hash, fixture.id)) {
        await updateAttempt(row.id, {
          status: "conflict",
          attempt_count: attempt,
          fixture_id: fixture.id,
          raw_response: groundedRaw(identity),
          grounded_sources: identity.sources,
          last_error: "Fixture ja associado a outro evento da mesma casa."
        });
        return { status: "conflict" as const, fixtureId: null };
      }

      const aliases = await saveAliases(row, fixture, identity, resolvedMatch.orientation);
      if (aliases.conflict) {
        await updateAttempt(row.id, {
          status: "conflict",
          attempt_count: attempt,
          fixture_id: fixture.id,
          raw_response: groundedRaw(identity),
          grounded_sources: identity.sources,
          last_error: aliases.conflict
        });
        return { status: "conflict" as const, fixtureId: null };
      }

      await updateAttempt(row.id, {
        status: "resolved",
        attempt_count: attempt,
        fixture_id: fixture.id,
        resolved_home_team_id: aliases.homeTeamId,
        resolved_away_team_id: aliases.awayTeamId,
        orientation: resolvedMatch.orientation,
        grounded_sources: identity.sources,
        raw_response: groundedRaw(identity),
        last_error: null,
        retry_after: null,
        resolved_at: new Date().toISOString()
      });
      return { status: "resolved" as const, fixtureId: fixture.id };
    } catch (error) {
      const exhausted = attempt >= env.TEAM_IDENTITY_MAX_ATTEMPTS;
      await updateAttempt(row.id, {
        status: exhausted ? "exhausted" : "pending",
        attempt_count: attempt,
        last_error: errorMessage(error),
        retry_after: null
      }).catch(() => undefined);
      if (exhausted || /limite diario/i.test(errorMessage(error))) {
        return { status: "exhausted" as const, fixtureId: null };
      }
    }
  }

  return { status: "exhausted" as const, fixtureId: null };
}

export async function resolveResidualIdentities(bookmakerSlug: string, queuedSince: string) {
  const summary: ResidualIdentitySummary = {
    queued: 0,
    processed: 0,
    resolved: 0,
    exhausted: 0,
    conflicts: 0,
    disabled: 0,
    errors: 0,
    resolvedFixtureIds: []
  };
  if (!groundedTeamIdentityEnabled()) return summary;

  const { data, error } = await supabase
    .from("team_resolution_attempts")
    .select("id,bookmaker_slug,event_key,event_hash,bookmaker_home_team,bookmaker_away_team,league_name,starts_at,status,attempt_count,raw_request,updated_at")
    .eq("bookmaker_slug", bookmakerSlug)
    .eq("status", "pending")
    .gte("updated_at", queuedSince)
    .gt("starts_at", new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
    .order("updated_at", { ascending: true })
    .limit(100);
  if (error) throw error;

  const rows = (data ?? []) as PendingAttemptRow[];
  summary.queued = rows.length;
  const results = await pMap(
    rows,
    async (row) => {
      try {
        return await resolveAttempt(row);
      } catch (attemptError) {
        await updateAttempt(row.id, { last_error: errorMessage(attemptError) }).catch(() => undefined);
        return { status: "error" as const, fixtureId: null };
      }
    },
    { concurrency: env.TEAM_IDENTITY_MAX_CONCURRENCY }
  );

  summary.processed = results.length;
  for (const result of results) {
    if (result.status === "resolved" && result.fixtureId) {
      summary.resolved += 1;
      summary.resolvedFixtureIds.push(result.fixtureId);
    } else if (result.status === "exhausted") {
      summary.exhausted += 1;
    } else if (result.status === "conflict") {
      summary.conflicts += 1;
    } else if (result.status === "disabled") {
      summary.disabled += 1;
    } else {
      summary.errors += 1;
    }
  }
  summary.resolvedFixtureIds = [...new Set(summary.resolvedFixtureIds)];
  if (summary.resolvedFixtureIds.length) await refreshLearnedTeamAliases(true);
  return summary;
}

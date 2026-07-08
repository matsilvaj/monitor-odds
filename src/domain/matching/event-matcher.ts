import { matchingTokens, normalizeForMatching, significantTokenSet, teamNameSimilarity, tokenSetSimilarity } from "./text-similarity.js";
import { nationalTeamTokenGroups, tokenGroupsOverlap } from "./team-aliases.js";
import type { Selection } from "../normalize.js";

export type MatchableEvent = {
  id?: string | number;
  startsAt: string | number | Date;
  homeTeam: string | null;
  awayTeam: string | null;
  leagueName?: string | null;
};

export type EventMatchResult = {
  matched: boolean;
  score: number;
  timeScore: number;
  teamScore: number;
  bestSingleTeamScore?: number;
  orientation: "NORMAL" | "INVERTED";
  reason: string;
};

export type MatchEventsOptions = {
  context?: "strict" | "league-scoped";
  trustedLeagueScope?: boolean;
  maxTimeDiffMs?: number;
  singleTeamMinScore?: number;
  singleTeamMinTimeScore?: number;
  pairScoreMargin?: number;
  singleTeamScoreMargin?: number;
};

const MAX_TIME_DIFF_MS = 20 * 60 * 1000;
const MIN_TEAM_SCORE = 0.65;
const MIN_SIDE_TEAM_SCORE = 0.62;
const MIN_SINGLE_TEAM_SCORE = 0.88;
const MIN_SINGLE_TEAM_TIME_SCORE = 0.62;
const VIRTUAL_EVENT_RE = /\b(?:e\s*soccer|esoccer|virtual|fantasy|simulado|simulacao|srl|cyber|pes|ebasket|basketball\s*cyber|kings\s*league)\b/i;
const SAFE_PARTICIPANT_QUALIFIER_RE = /^(?:w|women|woman|f|fem|feminino|feminina|u\d{2}|sub\s*\d{2}|reserve|reserves|reserva|b|ii|iii|iv)$/;

function timestamp(value: string | number | Date) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

function parentheticalQualifiers(value: unknown) {
  return [...String(value ?? "").matchAll(/\(([^)]{1,40})\)/g)]
    .map((match) => normalizeForMatching(match[1]))
    .filter(Boolean);
}

export function hasSuspiciousParticipantQualifier(value: unknown) {
  return parentheticalQualifiers(value).some((qualifier) => !SAFE_PARTICIPANT_QUALIFIER_RE.test(qualifier));
}

function looksLikeVirtualEvent(event: MatchableEvent) {
  const text = normalizeForMatching(`${event.leagueName ?? ""} ${event.homeTeam ?? ""} ${event.awayTeam ?? ""}`);
  return VIRTUAL_EVENT_RE.test(text) || hasSuspiciousParticipantQualifier(event.homeTeam) || hasSuspiciousParticipantQualifier(event.awayTeam);
}

function hasSharedSignificantToken(left: MatchableEvent, right: MatchableEvent) {
  const leftTokens = significantTokenSet(`${left.homeTeam ?? ""} ${left.awayTeam ?? ""}`);
  const rightTokens = significantTokenSet(`${right.homeTeam ?? ""} ${right.awayTeam ?? ""}`);

  for (const token of leftTokens) {
    if (rightTokens.has(token)) return true;
  }

  const leftAll = matchingTokens(`${left.homeTeam ?? ""} ${left.awayTeam ?? ""}`).join("");
  const rightAll = matchingTokens(`${right.homeTeam ?? ""} ${right.awayTeam ?? ""}`).join("");
  if (leftAll.length >= 5 && rightAll.length >= 5 && (leftAll.includes(rightAll) || rightAll.includes(leftAll))) return true;

  const leftHomeGroups = nationalTeamTokenGroups(left.homeTeam);
  const leftAwayGroups = nationalTeamTokenGroups(left.awayTeam);
  const rightHomeGroups = nationalTeamTokenGroups(right.homeTeam);
  const rightAwayGroups = nationalTeamTokenGroups(right.awayTeam);
  return (
    (tokenGroupsOverlap(leftHomeGroups, rightHomeGroups) && tokenGroupsOverlap(leftAwayGroups, rightAwayGroups)) ||
    (tokenGroupsOverlap(leftHomeGroups, rightAwayGroups) && tokenGroupsOverlap(leftAwayGroups, rightHomeGroups))
  );
}

function hasStrongLeagueSignal(left: MatchableEvent, right: MatchableEvent) {
  if (!left.leagueName || !right.leagueName) return false;
  return tokenSetSimilarity(left.leagueName, right.leagueName) >= 0.82;
}

function pairScore(leftHome: unknown, leftAway: unknown, rightHome: unknown, rightAway: unknown) {
  const homeScore = teamNameSimilarity(leftHome, rightHome);
  const awayScore = teamNameSimilarity(leftAway, rightAway);

  return {
    homeScore,
    awayScore,
    score: (homeScore + awayScore) / 2,
    minSideScore: Math.min(homeScore, awayScore)
  };
}

function teamEvidence(leftHome: unknown, leftAway: unknown, rightHome: unknown, rightAway: unknown) {
  const normalHome = teamNameSimilarity(leftHome, rightHome);
  const normalAway = teamNameSimilarity(leftAway, rightAway);
  const invertedHome = teamNameSimilarity(leftHome, rightAway);
  const invertedAway = teamNameSimilarity(leftAway, rightHome);
  const bestSingle = [
    { score: normalHome, orientation: "NORMAL" as const },
    { score: normalAway, orientation: "NORMAL" as const },
    { score: invertedHome, orientation: "INVERTED" as const },
    { score: invertedAway, orientation: "INVERTED" as const }
  ].sort((left, right) => right.score - left.score)[0];

  return {
    bestSingleTeamScore: bestSingle?.score ?? 0,
    bestSingleOrientation: bestSingle?.orientation ?? ("NORMAL" as const)
  };
}

export function matchEvents(canonical: MatchableEvent, bookmaker: MatchableEvent, options: MatchEventsOptions = {}): EventMatchResult {
  const canonicalTime = timestamp(canonical.startsAt);
  const bookmakerTime = timestamp(bookmaker.startsAt);
  const diffMs = Math.abs(canonicalTime - bookmakerTime);
  const maxTimeDiffMs = options.maxTimeDiffMs ?? MAX_TIME_DIFF_MS;

  if (!Number.isFinite(canonicalTime) || !Number.isFinite(bookmakerTime)) {
    return { matched: false, score: 0, timeScore: 0, teamScore: 0, orientation: "NORMAL", reason: "invalid-time" };
  }

  if (diffMs > maxTimeDiffMs) {
    return { matched: false, score: 0, timeScore: 0, teamScore: 0, orientation: "NORMAL", reason: "time-rejected" };
  }

  if (!looksLikeVirtualEvent(canonical) && looksLikeVirtualEvent(bookmaker)) {
    return { matched: false, score: 0, timeScore: 1 - diffMs / maxTimeDiffMs, teamScore: 0, orientation: "NORMAL", reason: "virtual-event-rejected" };
  }

  const strongLeagueSignal = Boolean(options.trustedLeagueScope) || hasStrongLeagueSignal(canonical, bookmaker);
  if (!hasSharedSignificantToken(canonical, bookmaker) && !strongLeagueSignal) {
    return { matched: false, score: 0, timeScore: 1 - diffMs / maxTimeDiffMs, teamScore: 0, orientation: "NORMAL", reason: "no-shared-token" };
  }

  const normalScore = pairScore(canonical.homeTeam, canonical.awayTeam, bookmaker.homeTeam, bookmaker.awayTeam);
  const invertedScore = pairScore(canonical.homeTeam, canonical.awayTeam, bookmaker.awayTeam, bookmaker.homeTeam);
  const selectedScore = normalScore.score >= invertedScore.score ? normalScore : invertedScore;
  const orientation = normalScore.score >= invertedScore.score ? "NORMAL" : "INVERTED";
  const evidence = teamEvidence(canonical.homeTeam, canonical.awayTeam, bookmaker.homeTeam, bookmaker.awayTeam);
  const teamScore = selectedScore.score;
  const timeScore = 1 - diffMs / maxTimeDiffMs;
  const score = timeScore * 0.4 + teamScore * 0.6;
  const threshold = timeScore >= 0.95 ? 0.58 : timeScore >= 0.85 ? 0.64 : 0.72;
  const pairMatched = selectedScore.minSideScore >= MIN_SIDE_TEAM_SCORE && teamScore >= MIN_TEAM_SCORE && score >= threshold;

  if (pairMatched) {
    return {
      matched: true,
      score,
      timeScore,
      teamScore,
      bestSingleTeamScore: evidence.bestSingleTeamScore,
      orientation,
      reason: "matched"
    };
  }

  const singleTeamMinScore = options.singleTeamMinScore ?? MIN_SINGLE_TEAM_SCORE;
  const singleTeamMinTimeScore = options.singleTeamMinTimeScore ?? MIN_SINGLE_TEAM_TIME_SCORE;
  const canUseSingleTeam =
    options.context === "league-scoped" &&
    strongLeagueSignal &&
    timeScore >= singleTeamMinTimeScore &&
    evidence.bestSingleTeamScore >= singleTeamMinScore;

  if (canUseSingleTeam) {
    const singleScore = evidence.bestSingleTeamScore * 0.72 + timeScore * 0.28;
    return {
      matched: true,
      score: Math.max(score, singleScore),
      timeScore,
      teamScore,
      bestSingleTeamScore: evidence.bestSingleTeamScore,
      orientation: evidence.bestSingleOrientation,
      reason: "single-team-league-scope"
    };
  }

  if (selectedScore.minSideScore < MIN_SIDE_TEAM_SCORE) {
    return {
      matched: false,
      score,
      timeScore,
      teamScore,
      bestSingleTeamScore: evidence.bestSingleTeamScore,
      orientation,
      reason: "side-score-rejected"
    };
  }

  if (teamScore < MIN_TEAM_SCORE) {
    return {
      matched: false,
      score,
      timeScore,
      teamScore,
      bestSingleTeamScore: evidence.bestSingleTeamScore,
      orientation,
      reason: "team-score-rejected"
    };
  }

  return {
    matched: false,
    score,
    timeScore,
    teamScore,
    bestSingleTeamScore: evidence.bestSingleTeamScore,
    orientation,
    reason: "below-threshold"
  };
}

export function selectionForCanonicalOrientation(selection: Selection, orientation: EventMatchResult["orientation"]): Selection {
  if (orientation !== "INVERTED") return selection;
  if (selection === "HOME") return "AWAY";
  if (selection === "AWAY") return "HOME";
  return selection;
}

export function findBestEventMatch<T extends MatchableEvent>(canonical: MatchableEvent, candidates: T[]) {
  let best: (EventMatchResult & { event: T }) | null = null;

  for (const event of candidates) {
    const result = matchEvents(canonical, event);
    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, event };
  }

  return best;
}

function matchableFromCanonicalCandidate(candidate: unknown): MatchableEvent {
  const record = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {};
  return {
    id: record.id as string | number | undefined,
    startsAt: (record.startsAt ?? record.starts_at ?? "") as string | number | Date,
    homeTeam: (record.homeTeam ?? record.home_team ?? null) as string | null,
    awayTeam: (record.awayTeam ?? record.away_team ?? null) as string | null,
    leagueName: (record.leagueName ?? record.league_name ?? null) as string | null
  };
}

function hasTrustedCandidateScope(candidates: MatchableEvent[]) {
  if (candidates.length === 1) return true;

  const leagueKeys = new Set(
    candidates
      .map((candidate) => normalizeForMatching(candidate.leagueName))
      .filter(Boolean)
  );
  return leagueKeys.size === 1;
}

export function findBestCanonicalEventMatch<T>(canonicalCandidates: T[], bookmaker: MatchableEvent, options: MatchEventsOptions = {}) {
  const candidates = canonicalCandidates.map((fixture) => ({ fixture, matchable: matchableFromCanonicalCandidate(fixture) }));
  const matchOptions = {
    ...options,
    trustedLeagueScope:
      options.trustedLeagueScope || (options.context === "league-scoped" && hasTrustedCandidateScope(candidates.map((candidate) => candidate.matchable)))
  };
  const accepted = candidates
    .map(({ fixture, matchable }) => ({ fixture, match: matchEvents(matchable, bookmaker, matchOptions) }))
    .filter((item) => item.match.matched)
    .sort((left, right) => right.match.score - left.match.score);

  const best = accepted[0];
  if (!best) return null;

  const runnerUp = accepted[1];
  const requiredMargin =
    best.match.reason === "single-team-league-scope"
      ? options.singleTeamScoreMargin ?? 0.08
      : options.pairScoreMargin ?? 0.02;

  if (runnerUp && best.match.score - runnerUp.match.score < requiredMargin) return null;
  return { ...best.match, fixture: best.fixture };
}

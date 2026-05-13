import { matchingTokens, significantTokenSet, teamNameSimilarity, tokenSetSimilarity } from "./text-similarity.js";
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
  orientation: "NORMAL" | "INVERTED";
  reason: string;
};

const MAX_TIME_DIFF_MS = 20 * 60 * 1000;

function timestamp(value: string | number | Date) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

function hasSharedSignificantToken(left: MatchableEvent, right: MatchableEvent) {
  const leftTokens = significantTokenSet(`${left.homeTeam ?? ""} ${left.awayTeam ?? ""}`);
  const rightTokens = significantTokenSet(`${right.homeTeam ?? ""} ${right.awayTeam ?? ""}`);

  for (const token of leftTokens) {
    if (rightTokens.has(token)) return true;
  }

  const leftAll = matchingTokens(`${left.homeTeam ?? ""} ${left.awayTeam ?? ""}`).join("");
  const rightAll = matchingTokens(`${right.homeTeam ?? ""} ${right.awayTeam ?? ""}`).join("");
  return leftAll.length >= 5 && rightAll.length >= 5 && (leftAll.includes(rightAll) || rightAll.includes(leftAll));
}

function hasStrongLeagueSignal(left: MatchableEvent, right: MatchableEvent) {
  if (!left.leagueName || !right.leagueName) return false;
  return tokenSetSimilarity(left.leagueName, right.leagueName) >= 0.82;
}

function pairScore(leftHome: unknown, leftAway: unknown, rightHome: unknown, rightAway: unknown) {
  return (teamNameSimilarity(leftHome, rightHome) + teamNameSimilarity(leftAway, rightAway)) / 2;
}

export function matchEvents(canonical: MatchableEvent, bookmaker: MatchableEvent): EventMatchResult {
  const canonicalTime = timestamp(canonical.startsAt);
  const bookmakerTime = timestamp(bookmaker.startsAt);
  const diffMs = Math.abs(canonicalTime - bookmakerTime);

  if (!Number.isFinite(canonicalTime) || !Number.isFinite(bookmakerTime)) {
    return { matched: false, score: 0, timeScore: 0, teamScore: 0, orientation: "NORMAL", reason: "invalid-time" };
  }

  if (diffMs > MAX_TIME_DIFF_MS) {
    return { matched: false, score: 0, timeScore: 0, teamScore: 0, orientation: "NORMAL", reason: "time-rejected" };
  }

  if (!hasSharedSignificantToken(canonical, bookmaker) && !hasStrongLeagueSignal(canonical, bookmaker)) {
    return { matched: false, score: 0, timeScore: 1 - diffMs / MAX_TIME_DIFF_MS, teamScore: 0, orientation: "NORMAL", reason: "no-shared-token" };
  }

  const normalScore = pairScore(canonical.homeTeam, canonical.awayTeam, bookmaker.homeTeam, bookmaker.awayTeam);
  const invertedScore = pairScore(canonical.homeTeam, canonical.awayTeam, bookmaker.awayTeam, bookmaker.homeTeam);
  const orientation = normalScore >= invertedScore ? "NORMAL" : "INVERTED";
  const teamScore = Math.max(normalScore, invertedScore);
  const timeScore = 1 - diffMs / MAX_TIME_DIFF_MS;
  const score = timeScore * 0.4 + teamScore * 0.6;
  const threshold = timeScore >= 0.95 ? 0.58 : timeScore >= 0.85 ? 0.64 : 0.72;

  return {
    matched: score >= threshold,
    score,
    timeScore,
    teamScore,
    orientation,
    reason: score >= threshold ? "matched" : "below-threshold"
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

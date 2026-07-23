import {
  findBestCanonicalEventMatch,
  type EventMatchResult,
  type MatchableEvent,
  type MatchEventsOptions
} from "../domain/matching/event-matcher.js";
import { errorMessage } from "../utils/errors.js";
import {
  groundedTeamIdentityEnabled,
  type BookmakerIdentityQuestion
} from "./gemini-team-identity.js";
import { enqueueResidualIdentity, markResidualIdentityMatched } from "./residual-identity-worker.js";
import { refreshLearnedTeamAliases } from "./team-alias-store.js";

export type OnlineEventMatchOptions = MatchEventsOptions & {
  bookmakerSlug: string;
  leagueCountry?: string | null;
};

let schemaWarningShown = false;

function candidateRecord(candidate: unknown) {
  return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {};
}
function candidateId(candidate: unknown) {
  const id = candidateRecord(candidate).id;
  return id === undefined || id === null ? null : String(id);
}


function timestamp(value: string | number | Date) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

function nearbyCanonicalCandidates<T>(candidates: T[], event: MatchableEvent, maxTimeDiffMs: number) {
  const eventTime = timestamp(event.startsAt);
  if (!Number.isFinite(eventTime)) return [];
  return candidates.filter((candidate) => {
    const record = candidateRecord(candidate);
    const candidateTime = timestamp((record.startsAt ?? record.starts_at ?? "") as string | number | Date);
    return Number.isFinite(candidateTime) && Math.abs(candidateTime - eventTime) <= maxTimeDiffMs;
  });
}

export async function findBestCanonicalEventMatchOnline<T>(
  canonicalCandidates: T[],
  bookmaker: MatchableEvent,
  options: OnlineEventMatchOptions
): Promise<(EventMatchResult & { fixture: T }) | null> {
  await refreshLearnedTeamAliases().catch((error) => {
    if (!schemaWarningShown) {
      schemaWarningShown = true;
      console.warn(`[matching] Nao foi possivel carregar aliases aprendidos: ${errorMessage(error)}`);
    }
  });

  const eventKey = String(bookmaker.id ?? `${bookmaker.homeTeam}|${bookmaker.awayTeam}|${bookmaker.startsAt}`);
  const local = findBestCanonicalEventMatch(canonicalCandidates, bookmaker, options);
  if (local) {
    markResidualIdentityMatched(options.bookmakerSlug, eventKey, candidateId(local.fixture));
    return local;
  }
  if (!groundedTeamIdentityEnabled()) return null;
  if (!bookmaker.homeTeam?.trim() || !bookmaker.awayTeam?.trim()) return null;

  const maxTimeDiffMs = options.maxTimeDiffMs ?? 20 * 60 * 1000;
  const nearbyCandidates = nearbyCanonicalCandidates(canonicalCandidates, bookmaker, maxTimeDiffMs);
  if (!nearbyCandidates.length) return null;

  const question: BookmakerIdentityQuestion = {
    bookmakerSlug: options.bookmakerSlug,
    eventKey,
    homeTeam: bookmaker.homeTeam,
    awayTeam: bookmaker.awayTeam,
    leagueName: bookmaker.leagueName ?? null,
    leagueCountry: options.leagueCountry ?? null,
    startsAt: bookmaker.startsAt
  };
  await enqueueResidualIdentity(question, nearbyCandidates, options);
  return null;
}

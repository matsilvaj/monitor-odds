import { supabase } from "../db/supabase.js";
import { errorMessage } from "../utils/errors.js";

export type LeagueUrlRequestReason = "league-not-found" | "saved-url-failed";

type LeagueUrlRequestLeague = {
  name: string;
  country: string | null;
  api_football_league_id: number;
};

type LeagueUrlRequestLogger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

type RequestLeagueUrlInput = {
  bookmakerSlug: string;
  league: LeagueUrlRequestLeague;
  reason: LeagueUrlRequestReason;
  previousUrl?: string | null;
  raw?: Record<string, unknown>;
};

function isMissingRequestsTable(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = errorMessage(error);
  return code === "42P01" || /bookmaker_league_url_requests|relation .* does not exist/i.test(message);
}

export async function requestBookmakerLeagueUrl(input: RequestLeagueUrlInput, logger?: LeagueUrlRequestLogger) {
  const now = new Date().toISOString();
  const mode = input.previousUrl ? "update" : "add";
  const { error } = await supabase.from("bookmaker_league_url_requests").upsert(
    {
      bookmaker_slug: input.bookmakerSlug,
      api_football_league_id: input.league.api_football_league_id,
      league_name: input.league.name,
      league_country: input.league.country,
      mode,
      reason: input.reason,
      previous_url: input.previousUrl ?? null,
      status: "pending",
      resolved_url: null,
      resolved_at: null,
      raw: {
        ...(input.raw ?? {}),
        requestedAt: now
      },
      updated_at: now
    },
    { onConflict: "bookmaker_slug,api_football_league_id" }
  );

  if (error) {
    if (isMissingRequestsTable(error)) {
      await logger?.("warn", "pendencias de URL de liga indisponiveis; rode db:setup para habilitar", {
        bookmakerSlug: input.bookmakerSlug,
        leagueName: input.league.name,
        apiFootballLeagueId: input.league.api_football_league_id,
        error: errorMessage(error)
      });
      return false;
    }

    throw error;
  }

  await logger?.("warn", "pendencia de URL de liga criada", {
    bookmakerSlug: input.bookmakerSlug,
    leagueName: input.league.name,
    country: input.league.country,
    apiFootballLeagueId: input.league.api_football_league_id,
    mode,
    reason: input.reason,
    previousUrl: input.previousUrl ?? null
  });
  return true;
}

export async function resolveBookmakerLeagueUrlRequest(
  bookmakerSlug: string,
  league: LeagueUrlRequestLeague,
  resolvedUrl: string | null,
  logger?: LeagueUrlRequestLogger
) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("bookmaker_league_url_requests")
    .update({
      status: "resolved",
      resolved_url: resolvedUrl,
      resolved_at: now,
      updated_at: now
    })
    .eq("bookmaker_slug", bookmakerSlug)
    .eq("api_football_league_id", league.api_football_league_id);

  if (error) {
    if (isMissingRequestsTable(error)) return false;
    throw error;
  }

  await logger?.("info", "pendencia de URL de liga resolvida", {
    bookmakerSlug,
    leagueName: league.name,
    apiFootballLeagueId: league.api_football_league_id,
    resolvedUrl
  });
  return true;
}

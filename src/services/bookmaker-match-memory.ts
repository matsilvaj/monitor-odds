import { supabase } from "../db/supabase.js";
import { normalizeName } from "../domain/text.js";

export type MatchMemoryLogger = (
  level: "info" | "warn" | "error",
  message: string,
  context?: Record<string, unknown>
) => Promise<void>;

export type FixtureTeamIdentity = {
  home_team_id: string;
  away_team_id: string;
  home_team: string;
  away_team: string;
};

type AliasRow = {
  team_id: string;
  alias: string;
  normalized_alias: string;
};

export type BookmakerAliasIndex = Map<string, { teamId: string; canonicalName: string }>;

export function linkOrientation(raw: unknown): "NORMAL" | "INVERTED" | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const orientation = (raw as Record<string, unknown>).orientation;
  return orientation === "NORMAL" || orientation === "INVERTED" ? orientation : null;
}

export async function loadBookmakerAliasIndex(fixtures: FixtureTeamIdentity[]): Promise<BookmakerAliasIndex> {
  const canonicalNameByTeamId = new Map<string, string>();
  for (const fixture of fixtures) {
    canonicalNameByTeamId.set(fixture.home_team_id, fixture.home_team);
    canonicalNameByTeamId.set(fixture.away_team_id, fixture.away_team);
  }
  const teamIds = [...canonicalNameByTeamId.keys()];
  if (!teamIds.length) return new Map();

  const { data, error } = await supabase
    .from("apelidos_times")
    .select("team_id,alias,normalized_alias")
    .in("team_id", teamIds);
  if (error) throw error;

  const candidates = new Map<string, Set<string>>();
  for (const row of (data ?? []) as AliasRow[]) {
    const normalized = normalizeName(row.normalized_alias || row.alias);
    if (!normalized) continue;
    const ids = candidates.get(normalized) ?? new Set<string>();
    ids.add(row.team_id);
    candidates.set(normalized, ids);
  }
  for (const [teamId, canonicalName] of canonicalNameByTeamId) {
    const normalized = normalizeName(canonicalName);
    const ids = candidates.get(normalized) ?? new Set<string>();
    ids.add(teamId);
    candidates.set(normalized, ids);
  }

  const aliases: BookmakerAliasIndex = new Map();
  for (const [normalized, ids] of candidates) {
    if (ids.size !== 1) continue;
    const teamId = [...ids][0];
    const canonicalName = canonicalNameByTeamId.get(teamId);
    if (canonicalName) aliases.set(normalized, { teamId, canonicalName });
  }
  return aliases;
}

export function canonicalNameFromAlias(index: BookmakerAliasIndex, bookmakerName: string | null) {
  if (!bookmakerName) return bookmakerName;
  return index.get(normalizeName(bookmakerName))?.canonicalName ?? bookmakerName;
}

async function learnOneAlias(
  bookmakerSlug: string,
  teamId: string,
  canonicalName: string,
  alias: string | null,
  context: Record<string, unknown>,
  logger?: MatchMemoryLogger
) {
  const normalizedAlias = normalizeName(alias ?? "");
  if (!alias || !normalizedAlias || normalizedAlias === normalizeName(canonicalName)) return false;

  const { data, error } = await supabase
    .from("apelidos_times")
    .select("team_id,source")
    .eq("normalized_alias", normalizedAlias);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ team_id: string; source: string }>;
  if (rows.some((row) => row.team_id !== teamId)) {
    await logger?.("warn", "alias de time ambiguo nao foi aprendido", {
      bookmakerSlug,
      alias,
      canonicalName,
      ...context
    });
    return false;
  }
  if (rows.some((row) => row.team_id === teamId)) return false;

  const { error: insertError } = await supabase.from("apelidos_times").insert({
    team_id: teamId,
    alias,
    normalized_alias: normalizedAlias,
    source: `bookmaker:${bookmakerSlug}`,
    confidence: 1,
    raw: { bookmakerSlug, canonicalName, learnedFrom: "confirmed-event", ...context },
    updated_at: new Date().toISOString()
  });
  if (insertError) {
    const duplicate = String((insertError as { code?: unknown }).code ?? "") === "23505";
    if (!duplicate) throw insertError;
    return false;
  }
  await logger?.("info", "alias de time aprendido", { bookmakerSlug, alias, canonicalName, ...context });
  return true;
}

export async function learnConfirmedEventAliases(options: {
  bookmakerSlug: string;
  fixture: FixtureTeamIdentity;
  bookmakerHomeTeam: string | null;
  bookmakerAwayTeam: string | null;
  orientation: "NORMAL" | "INVERTED";
  externalEventId: string | number;
  leagueApiFootballId?: number | null;
  logger?: MatchMemoryLogger;
}) {
  const { fixture, orientation } = options;
  const homeIdentity = orientation === "NORMAL"
    ? { teamId: fixture.home_team_id, canonicalName: fixture.home_team }
    : { teamId: fixture.away_team_id, canonicalName: fixture.away_team };
  const awayIdentity = orientation === "NORMAL"
    ? { teamId: fixture.away_team_id, canonicalName: fixture.away_team }
    : { teamId: fixture.home_team_id, canonicalName: fixture.home_team };
  const context = {
    externalEventId: options.externalEventId,
    leagueApiFootballId: options.leagueApiFootballId ?? null
  };
  const learned = await Promise.all([
    learnOneAlias(options.bookmakerSlug, homeIdentity.teamId, homeIdentity.canonicalName, options.bookmakerHomeTeam, context, options.logger),
    learnOneAlias(options.bookmakerSlug, awayIdentity.teamId, awayIdentity.canonicalName, options.bookmakerAwayTeam, context, options.logger)
  ]);
  return learned.filter(Boolean).length;
}

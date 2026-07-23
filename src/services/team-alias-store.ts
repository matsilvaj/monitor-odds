import { supabase } from "../db/supabase.js";
import { replaceLearnedTeamAliases, type LearnedTeamAlias } from "../domain/matching/team-aliases.js";
import { normalizeForMatching } from "../domain/matching/text-similarity.js";

const ALIAS_REFRESH_TTL_MS = 60_000;

type AliasRow = {
  id: string;
  team_id: string;
  alias: string;
  normalized_alias: string;
  bookmaker_slug: string | null;
  league_id: string | null;
  confidence: number | string;
  raw: unknown;
  team: { name: string } | Array<{ name: string }> | null;
};

export type GroundedAliasInput = {
  teamId: string;
  canonicalName: string;
  alias: string;
  bookmakerSlug: string;
  leagueId?: string | null;
  confidence: number;
  evidence: unknown;
};

let loadedAt = 0;
let loadPromise: Promise<number> | null = null;

function relatedTeamName(row: AliasRow) {
  const team = Array.isArray(row.team) ? row.team[0] ?? null : row.team;
  return team?.name?.trim() || null;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sourceBookmakers(raw: unknown) {
  const sources = objectValue(raw).bookmakerSlugs;
  return Array.isArray(sources) ? sources.map(String).filter(Boolean) : [];
}

export async function refreshLearnedTeamAliases(force = false) {
  if (!force && Date.now() - loadedAt < ALIAS_REFRESH_TTL_MS) return 0;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    let { data, error } = await supabase
      .from("team_aliases")
      .select("id,team_id,alias,normalized_alias,bookmaker_slug,league_id,confidence,raw,team:teams(name)");

    if (error) {
      if (/bookmaker_slug|league_id|verified_at/i.test(error.message ?? "")) {
        const legacy = await supabase
          .from("team_aliases")
          .select("id,team_id,alias,normalized_alias,confidence,raw,team:teams(name)");
        if (legacy.error) throw legacy.error;
        data = (legacy.data ?? []).map((row) => ({ ...row, bookmaker_slug: null, league_id: null }));
      } else {
        throw error;
      }
    }

    const rows = (data ?? []) as unknown as AliasRow[];
    const teamIdsByAlias = new Map<string, Set<string>>();
    for (const row of rows) {
      const key = row.normalized_alias || normalizeForMatching(row.alias);
      if (!key) continue;
      const ids = teamIdsByAlias.get(key) ?? new Set<string>();
      ids.add(row.team_id);
      teamIdsByAlias.set(key, ids);
    }

    const teamIdsByCanonicalName = new Map<string, Set<string>>();
    for (const row of rows) {
      const canonicalName = relatedTeamName(row);
      const key = normalizeForMatching(canonicalName);
      if (!key) continue;
      const ids = teamIdsByCanonicalName.get(key) ?? new Set<string>();
      ids.add(row.team_id);
      teamIdsByCanonicalName.set(key, ids);
    }

    const learned: LearnedTeamAlias[] = [];
    for (const row of rows) {
      const key = row.normalized_alias || normalizeForMatching(row.alias);
      const canonicalName = relatedTeamName(row);
      const canonicalKey = normalizeForMatching(canonicalName);
      if (
        !key ||
        !canonicalName ||
        (teamIdsByAlias.get(key)?.size ?? 0) !== 1 ||
        (teamIdsByCanonicalName.get(canonicalKey)?.size ?? 0) !== 1
      ) continue;
      learned.push({ canonicalName, alias: row.alias });
    }

    replaceLearnedTeamAliases(learned);
    loadedAt = Date.now();
    return learned.length;
  })().finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

async function existingAliasRows(normalizedAlias: string) {
  const { data, error } = await supabase
    .from("team_aliases")
    .select("id,team_id,alias,normalized_alias,bookmaker_slug,league_id,confidence,raw")
    .eq("normalized_alias", normalizedAlias);
  if (error) throw error;
  return (data ?? []) as Array<Omit<AliasRow, "team">>;
}

export async function saveGroundedTeamAliases(inputs: GroundedAliasInput[]) {
  const saved: LearnedTeamAlias[] = [];

  for (const input of inputs) {
    const alias = input.alias.trim();
    const normalizedAlias = normalizeForMatching(alias);
    if (!alias || !normalizedAlias) continue;

    const existing = await existingAliasRows(normalizedAlias);
    const conflicting = existing.find(
      (row) => row.team_id !== input.teamId && (row.bookmaker_slug === null || row.bookmaker_slug === input.bookmakerSlug)
    );
    if (conflicting) {
      return {
        saved: 0,
        conflict: `Alias "${alias}" ja esta ligado a outro time no mesmo contexto.`
      };
    }

    const sameTeam = existing.find((row) => row.team_id === input.teamId);
    const now = new Date().toISOString();
    const raw = {
      ...objectValue(sameTeam?.raw),
      bookmakerSlugs: [...new Set([...sourceBookmakers(sameTeam?.raw), input.bookmakerSlug])],
      evidence: input.evidence
    };

    if (sameTeam) {
      const { error } = await supabase
        .from("team_aliases")
        .update({
          alias,
          source: "gemini-grounded",
          confidence: Math.max(Number(sameTeam.confidence) || 0, input.confidence),
          raw,
          verified_at: now,
          updated_at: now
        })
        .eq("id", sameTeam.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("team_aliases").insert({
        team_id: input.teamId,
        alias,
        normalized_alias: normalizedAlias,
        bookmaker_slug: input.bookmakerSlug,
        league_id: input.leagueId ?? null,
        source: "gemini-grounded",
        confidence: input.confidence,
        raw,
        verified_at: now,
        updated_at: now
      });
      if (error) throw error;
    }

    saved.push({ canonicalName: input.canonicalName, alias });
  }

  await refreshLearnedTeamAliases(true);
  return { saved: saved.length, conflict: null as string | null };
}

export function invalidateLearnedTeamAliasCache() {
  loadedAt = 0;
}

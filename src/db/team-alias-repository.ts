import { supabase } from "./supabase.js";

function normalizeForAlias(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function orderedPair(a: string, b: string): [string, string] {
  const na = normalizeForAlias(a);
  const nb = normalizeForAlias(b);
  return na <= nb ? [na, nb] : [nb, na];
}

export async function lookupTeamAlias(nameA: string, nameB: string): Promise<boolean | null> {
  const [a, b] = orderedPair(nameA, nameB);
  const { data } = await supabase
    .from("team_name_aliases")
    .select("same_team")
    .eq("name_a", a)
    .eq("name_b", b)
    .maybeSingle();
  return data ? (data.same_team as boolean) : null;
}

export async function saveTeamAlias(
  nameA: string,
  nameB: string,
  sameTeam: boolean,
  confirmedBy: "gemini" | "manual" = "gemini"
): Promise<void> {
  const [a, b] = orderedPair(nameA, nameB);
  await supabase.from("team_name_aliases").upsert(
    { name_a: a, name_b: b, same_team: sameTeam, confirmed_by: confirmedBy },
    { onConflict: "name_a,name_b" }
  );
}

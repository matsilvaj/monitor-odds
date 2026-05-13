import { supabase } from "../db/supabase.js";

export type StartedFixtureCleanupSummary = {
  startedFixturesDeleted: number;
  startedSnapshotsDeleted: number;
};

export async function cleanupStartedFixtures(now = new Date()): Promise<StartedFixtureCleanupSummary> {
  const cutoff = now.toISOString();
  const { data, error } = await supabase.from("fixtures").select("id").lte("starts_at", cutoff);

  if (error) throw error;

  const fixtureIds = (data ?? []).map((row) => row.id);

  if (fixtureIds.length) {
    const { error: deleteError } = await supabase.from("fixtures").delete().in("id", fixtureIds);
    if (deleteError) throw deleteError;
  }

  const { count: snapshotsDeleted, error: snapshotsError } = await supabase
    .from("bookmaker_event_snapshots")
    .delete({ count: "exact" })
    .lte("starts_at", cutoff);

  if (snapshotsError) throw snapshotsError;

  return {
    startedFixturesDeleted: fixtureIds.length,
    startedSnapshotsDeleted: snapshotsDeleted ?? 0
  };
}

export function formatStartedFixtureCleanupSummary(summary: StartedFixtureCleanupSummary) {
  return `[sync] Jogos iniciados removidos: ${summary.startedFixturesDeleted} | snapshots removidos: ${summary.startedSnapshotsDeleted}.`;
}

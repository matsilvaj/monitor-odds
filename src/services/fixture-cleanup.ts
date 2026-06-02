import { supabase } from "../db/supabase.js";
import { MVP_LEAGUES } from "../config/leagues.js";
import { fixtureEligibilityDecision } from "../domain/fixture-eligibility.js";

export type StartedFixtureCleanupSummary = {
  startedFixturesDeleted: number;
  startedSnapshotsDeleted: number;
};

export type IneligibleFixtureCleanupSummary = {
  ineligibleFixturesDeleted: number;
  ineligibleSnapshotsDeleted: number;
};

const ELIGIBILITY_LEAGUES = MVP_LEAGUES.filter((league) => league.eligibility);
const ELIGIBILITY_LEAGUE_IDS = ELIGIBILITY_LEAGUES.map((league) => league.apiFootballLeagueId);
const ELIGIBILITY_LEAGUE_BY_API_ID = new Map(ELIGIBILITY_LEAGUES.map((league) => [league.apiFootballLeagueId, league]));

async function deleteRowsById(table: "fixtures" | "bookmaker_event_snapshots", ids: string[]) {
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const { error } = await supabase.from(table).delete().in("id", batch);
    if (error) throw error;
  }
}

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

export async function cleanupIneligibleFixtures(): Promise<IneligibleFixtureCleanupSummary> {
  if (!ELIGIBILITY_LEAGUE_IDS.length) {
    return { ineligibleFixturesDeleted: 0, ineligibleSnapshotsDeleted: 0 };
  }

  const { data: fixtures, error: fixturesError } = await supabase
    .from("fixtures")
    .select("id,home_team,away_team,round,league:leagues!inner(name,api_football_league_id)")
    .in("leagues.api_football_league_id", ELIGIBILITY_LEAGUE_IDS);

  if (fixturesError) throw fixturesError;

  const fixtureIds = (fixtures ?? [])
    .filter((fixture) => {
      const leagueRow = Array.isArray(fixture.league) ? fixture.league[0] : fixture.league;
      const league = ELIGIBILITY_LEAGUE_BY_API_ID.get(Number(leagueRow?.api_football_league_id));
      return !fixtureEligibilityDecision(league, {
        leagueName: leagueRow?.name ?? null,
        round: fixture.round,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team
      }).eligible;
    })
    .map((fixture) => String(fixture.id));

  if (fixtureIds.length) {
    await deleteRowsById("fixtures", fixtureIds);
  }

  const { data: snapshots, error: snapshotsError } = await supabase
    .from("bookmaker_event_snapshots")
    .select("id,league_api_football_id,league_name,event_name,home_team,away_team")
    .in("league_api_football_id", ELIGIBILITY_LEAGUE_IDS);

  if (snapshotsError) throw snapshotsError;

  const snapshotIds = (snapshots ?? [])
    .filter((snapshot) => {
      const league = ELIGIBILITY_LEAGUE_BY_API_ID.get(Number(snapshot.league_api_football_id));
      return !fixtureEligibilityDecision(league, {
        leagueName: snapshot.league_name,
        round: snapshot.event_name,
        homeTeam: snapshot.home_team,
        awayTeam: snapshot.away_team
      }).eligible;
    })
    .map((snapshot) => String(snapshot.id));

  if (snapshotIds.length) {
    await deleteRowsById("bookmaker_event_snapshots", snapshotIds);
  }

  return {
    ineligibleFixturesDeleted: fixtureIds.length,
    ineligibleSnapshotsDeleted: snapshotIds.length
  };
}

export function formatStartedFixtureCleanupSummary(summary: StartedFixtureCleanupSummary) {
  return `[sync] Jogos iniciados removidos: ${summary.startedFixturesDeleted} | snapshots removidos: ${summary.startedSnapshotsDeleted}.`;
}

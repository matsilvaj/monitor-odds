import { MVP_LEAGUES } from "../config/leagues.js";
import { env } from "../config/env.js";
import { supabase } from "../db/supabase.js";
import { normalizeName } from "../domain/text.js";
import { ApiFootballClient, type ApiFootballFixtureRow, type ApiFootballLeagueCatalogRow } from "../providers/api-football.js";
import { cleanupStartedFixtures } from "./fixture-cleanup.js";

const TARGET_LEAGUE_IDS = new Set(MVP_LEAGUES.map((league) => league.apiFootballLeagueId));
const TARGET_LEAGUE_ID_LIST = [...TARGET_LEAGUE_IDS].sort((a, b) => a - b);
const LEAGUE_IDS_HASH = TARGET_LEAGUE_ID_LIST.join(",");
const LEAGUE_CATALOG_SYNC_SOURCE = "api-football-leagues";

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function targetDates() {
  const now = new Date();
  return [0, 1].map((offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
}

function shouldDeleteFixture(row: ApiFootballFixtureRow) {
  const startsAt = new Date(row.fixture.date);
  if (startsAt <= new Date()) return true;

  const short = row.fixture.status?.short ?? "";
  return ["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "FT", "AET", "PEN", "CANC", "ABD", "AWD", "WO"].includes(short);
}

async function log(level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: "api-football",
    level,
    message,
    context
  });
}

async function hasTargetFixturesForDate(key: string) {
  const { count, error } = await supabase
    .from("fixtures")
    .select("id,leagues!inner(api_football_league_id)", { count: "exact", head: true })
    .eq("date_key", key)
    .in("leagues.api_football_league_id", [...TARGET_LEAGUE_IDS]);

  if (error) throw error;
  return (count ?? 0) > 0;
}

function configuredLeague(apiFootballLeagueId: number) {
  return MVP_LEAGUES.find((league) => league.apiFootballLeagueId === apiFootballLeagueId);
}

function leagueSlug(name: string) {
  return normalizeName(name).replace(/\s+/g, "-");
}

function catalogSeason(row: ApiFootballLeagueCatalogRow) {
  const seasons = row.seasons ?? [];
  const currentSeason = seasons.find((season) => season.current === true && typeof season.year === "number" && Number.isFinite(season.year));
  if (typeof currentSeason?.year === "number") return currentSeason.year;

  const years = seasons.map((season) => season.year).filter((year): year is number => typeof year === "number" && Number.isFinite(year));
  return years.length ? Math.max(...years) : null;
}

async function deactivateRemovedLeagues() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("leagues")
    .update({
      enabled: false,
      deleted_at: now,
      updated_at: now
    })
    .not("api_football_league_id", "in", `(${LEAGUE_IDS_HASH})`)
    .eq("enabled", true)
    .select("id");

  if (error) throw error;
  return data?.length ?? 0;
}

async function shouldSyncConfiguredLeaguesCatalog(key: string) {
  const forceSync = process.env.FORCE_SYNC === "true" || process.env.FORCE_SYNC === "1";
  if (forceSync) return true;

  const { data, error } = await supabase
    .from("fixture_sync_runs")
    .select("synced_at,status,league_ids_hash")
    .eq("date_key", key)
    .eq("source", LEAGUE_CATALOG_SYNC_SOURCE)
    .maybeSingle();

  if (error) throw error;

  return !(data?.status === "SUCCESS" && data.league_ids_hash === LEAGUE_IDS_HASH);
}

async function syncConfiguredLeaguesCatalog(client: ApiFootballClient) {
  const key = dateKey(new Date());
  if (!(await shouldSyncConfiguredLeaguesCatalog(key))) {
    return {
      apiCalls: 0,
      leaguesSynced: 0,
      leaguesMissing: 0,
      leaguesDisabled: 0
    };
  }

  const rows = await client.getLeaguesCatalog();
  const rowsByApiId = new Map<number, ApiFootballLeagueCatalogRow>();

  for (const row of rows) {
    if (TARGET_LEAGUE_IDS.has(row.league.id)) {
      rowsByApiId.set(row.league.id, row);
    }
  }

  const now = new Date().toISOString();
  const payload = [...rowsByApiId.values()].map((row) => {
    const configured = configuredLeague(row.league.id);
    const name = configured?.name ?? row.league.name;

    return {
      api_football_league_id: row.league.id,
      name,
      slug: configured?.slug ?? leagueSlug(name),
      country: row.country?.name ?? null,
      season: catalogSeason(row),
      logo_url: row.league.logo ?? null,
      country_flag_url: row.country?.flag ?? null,
      enabled: true,
      deleted_at: null,
      raw: row,
      updated_at: now
    };
  });

  if (payload.length) {
    const { error } = await supabase.from("leagues").upsert(payload, { onConflict: "api_football_league_id" });
    if (error) throw error;
  }

  const disabled = await deactivateRemovedLeagues();

  const { error: syncRunError } = await supabase.from("fixture_sync_runs").upsert(
    {
      date_key: key,
      source: LEAGUE_CATALOG_SYNC_SOURCE,
      status: "SUCCESS",
      league_ids_hash: LEAGUE_IDS_HASH,
      fixtures_seen: payload.length,
      synced_at: now
    },
    { onConflict: "date_key,source" }
  );
  if (syncRunError) throw syncRunError;

  return {
    apiCalls: 1,
    leaguesSynced: payload.length,
    leaguesMissing: TARGET_LEAGUE_ID_LIST.length - payload.length,
    leaguesDisabled: disabled
  };
}

async function upsertLeague(row: ApiFootballFixtureRow) {
  const configured = configuredLeague(row.league.id);
  const mediaFields: { logo_url?: string | null; country_flag_url?: string | null } = {};
  if ("logo" in row.league) mediaFields.logo_url = row.league.logo ?? null;
  if ("flag" in row.league) mediaFields.country_flag_url = row.league.flag ?? null;

  const { data, error } = await supabase
    .from("leagues")
    .upsert(
      {
        api_football_league_id: row.league.id,
        name: configured?.name ?? row.league.name,
        slug: configured?.slug ?? normalizeName(row.league.name).replace(/\s+/g, "-"),
        country: row.league.country ?? null,
        season: row.league.season ?? null,
        ...mediaFields,
        enabled: true,
        deleted_at: null,
        raw: row.league,
        updated_at: new Date().toISOString()
      },
      { onConflict: "api_football_league_id" }
    )
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

async function upsertTeam(team: ApiFootballFixtureRow["teams"]["home"]) {
  const { data, error } = await supabase
    .from("teams")
    .upsert(
      {
        api_football_team_id: team.id,
        name: team.name,
        normalized_name: normalizeName(team.name),
        logo_url: team.logo ?? null,
        raw: team,
        updated_at: new Date().toISOString()
      },
      { onConflict: "api_football_team_id" }
    )
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

async function upsertFixture(row: ApiFootballFixtureRow, leagueId: string, homeTeamId: string, awayTeamId: string) {
  const startsAt = new Date(row.fixture.date);
  const { data, error } = await supabase
    .from("fixtures")
    .upsert(
      {
        api_football_fixture_id: row.fixture.id,
        league_id: leagueId,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        name: `${row.teams.home.name} vs. ${row.teams.away.name}`,
        home_team: row.teams.home.name,
        away_team: row.teams.away.name,
        normalized_home_team: normalizeName(row.teams.home.name),
        normalized_away_team: normalizeName(row.teams.away.name),
        starts_at: startsAt.toISOString(),
        date_key: dateKey(startsAt),
        status: row.fixture.status?.short ?? "NS",
        round: row.league.round ?? null,
        raw: row,
        updated_at: new Date().toISOString()
      },
      { onConflict: "api_football_fixture_id" }
    )
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

export async function syncApiFootballFixtures() {
  const client = new ApiFootballClient();
  const summary = {
    apiCalls: 0,
    leaguesSynced: 0,
    leaguesMissing: 0,
    leaguesDisabled: 0,
    skippedByCache: 0,
    skippedByExistingData: 0,
    fixturesSeen: 0,
    fixturesKept: 0,
    fixturesDeleted: 0,
    startedFixturesDeleted: 0,
    startedSnapshotsDeleted: 0,
    errors: 0
  };

  try {
    const leagueCatalog = await syncConfiguredLeaguesCatalog(client);
    summary.apiCalls += leagueCatalog.apiCalls;
    summary.leaguesSynced = leagueCatalog.leaguesSynced;
    summary.leaguesMissing = leagueCatalog.leaguesMissing;
    summary.leaguesDisabled = leagueCatalog.leaguesDisabled;
  } catch (error) {
    summary.errors += 1;
    await log("error", "api-football league catalog sync failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    const cleanup = await cleanupStartedFixtures();
    summary.startedFixturesDeleted = cleanup.startedFixturesDeleted;
    summary.startedSnapshotsDeleted = cleanup.startedSnapshotsDeleted;
  } catch (error) {
    summary.errors += 1;
    await log("error", "started fixtures cleanup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  for (const date of targetDates()) {
    const key = dateKey(date);

    try {
      const { data: syncRun, error: syncRunError } = await supabase
        .from("fixture_sync_runs")
        .select("synced_at,status,league_ids_hash")
        .eq("date_key", key)
        .eq("source", "api-football")
        .maybeSingle();

      if (syncRunError) throw syncRunError;

      const lastSyncAt = syncRun?.status === "SUCCESS" && syncRun.synced_at ? new Date(syncRun.synced_at).getTime() : 0;
      const ttlMs = env.API_FOOTBALL_FIXTURE_TTL_MINUTES * 60 * 1000;
      const forceSync = process.env.FORCE_SYNC === "true" || process.env.FORCE_SYNC === "1";
      const sameLeagueSet = syncRun?.league_ids_hash === LEAGUE_IDS_HASH;
      if (!forceSync && sameLeagueSet && lastSyncAt && Date.now() - lastSyncAt < ttlMs) {
        summary.skippedByCache += 1;
        continue;
      }

      if (!forceSync && sameLeagueSet && (await hasTargetFixturesForDate(key))) {
        summary.skippedByExistingData += 1;
        continue;
      }

      const rows = await client.getFixturesByDate(key);
      summary.apiCalls += 1;
      summary.fixturesSeen += rows.length;

      for (const row of rows.filter((item) => TARGET_LEAGUE_IDS.has(item.league.id))) {
        if (shouldDeleteFixture(row)) {
          const { data: existing } = await supabase
            .from("fixtures")
            .select("id")
            .eq("api_football_fixture_id", row.fixture.id)
            .maybeSingle();

          if (existing?.id) {
            const { error } = await supabase.from("fixtures").delete().eq("id", existing.id);
            if (error) throw error;
            summary.fixturesDeleted += 1;
          }
          continue;
        }

        const leagueId = await upsertLeague(row);
        const homeTeamId = await upsertTeam(row.teams.home);
        const awayTeamId = await upsertTeam(row.teams.away);
        await upsertFixture(row, leagueId, homeTeamId, awayTeamId);
        summary.fixturesKept += 1;
      }

      await supabase.from("fixture_sync_runs").upsert(
        {
          date_key: key,
          source: "api-football",
          status: "SUCCESS",
          league_ids_hash: LEAGUE_IDS_HASH,
          fixtures_seen: rows.length,
          synced_at: new Date().toISOString()
        },
        { onConflict: "date_key,source" }
      );
    } catch (error) {
      summary.errors += 1;
      await log("error", "api-football sync failed", {
        date: key,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await log("info", "api-football sync finished", summary);
  return summary;
}

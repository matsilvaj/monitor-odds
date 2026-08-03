import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { findBestCanonicalEventMatch, selectionForCanonicalOrientation } from "../domain/matching/event-matcher.js";
import { normalizeName } from "../domain/text.js";
import type { Bet365Market, Logger } from "../providers/bet365/types.js";

type SnapshotRow = {
  id: string;
  external_event_id: number;
  league_api_football_id: number | null;
  league_name: string | null;
  event_name: string;
  home_team: string | null;
  away_team: string | null;
  starts_at: string | null;
  date_key: string | null;
  source_url: string | null;
  markets: Bet365Market[];
  raw: Record<string, unknown> | null;
};

type CanonicalFixtureRow = {
  id: string;
  home_team: string;
  away_team: string;
  starts_at: string;
  date_key: string;
  league: { name: string; api_football_league_id: number } | Array<{ name: string; api_football_league_id: number }> | null;
};

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function targetDateKeys(date: BookmakerCollectOptions["date"]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (!date) return [dateKey(today), dateKey(tomorrow)];
  if (date === "today") return [dateKey(today)];
  if (date === "tomorrow") return [dateKey(tomorrow)];
  return [date];
}

function fixtureLeague(fixture: CanonicalFixtureRow) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function snapshotMarkets(value: unknown): Bet365Market[] {
  if (!Array.isArray(value)) return [];
  return value.filter((market): market is Bet365Market => {
    if (!market || typeof market !== "object") return false;
    const candidate = market as { paCategory?: unknown; selections?: unknown };
    if (candidate.paCategory !== "COM_PA" && candidate.paCategory !== "SEM_PA") return false;
    if (!Array.isArray(candidate.selections)) return false;
    const selections = candidate.selections as Array<{ selection?: unknown; price?: unknown }>;
    if (
      selections.some(
        (selection) =>
          (selection.selection !== "HOME" && selection.selection !== "DRAW" && selection.selection !== "AWAY") ||
          !Number.isFinite(Number(selection.price)) ||
          Number(selection.price) <= 1
      )
    ) return false;
    const selectionTypes = new Set(selections.map((selection) => selection.selection));
    return selectionTypes.has("HOME") && selectionTypes.has("DRAW") && selectionTypes.has("AWAY");
  }) as Bet365Market[];
}

function buildLink(snapshot: SnapshotRow, fixture: CanonicalFixtureRow, score: number): BookmakerLinkRow {
  const updatedAt = new Date().toISOString();
  return {
    bookmaker_slug: "bet365",
    external_event_id: snapshot.external_event_id,
    fixture_id: fixture.id,
    bookmaker_event_name: snapshot.event_name,
    bookmaker_home_team: snapshot.home_team,
    bookmaker_away_team: snapshot.away_team,
    normalized_bookmaker_home_team: normalizeName(snapshot.home_team ?? ""),
    normalized_bookmaker_away_team: normalizeName(snapshot.away_team ?? ""),
    starts_at: snapshot.starts_at ?? fixture.starts_at,
    match_confidence_score: Number(score.toFixed(3)),
    source_url: snapshot.source_url,
    raw: { stage: "matched-from-snapshot", snapshotId: snapshot.id, snapshotRaw: snapshot.raw },
    updated_at: updatedAt
  };
}

function buildOdds(snapshot: SnapshotRow, fixture: CanonicalFixtureRow, orientation: "NORMAL" | "INVERTED"): OddRow[] {
  const updatedAt = new Date().toISOString();
  const rows = snapshot.markets.flatMap((market, marketIndex) =>
    market.selections.map((selection, selectionIndex) => ({
      fixture_id: fixture.id,
      bookmaker_slug: "bet365",
      market_code: "1X2",
      market_name: "MoneyLine",
      selection: selectionForCanonicalOrientation(selection.selection, orientation),
      price: selection.price,
      pa_category: market.paCategory,
      confidence_score: market.confidence,
      raw_market_name: market.marketName,
      raw_label: selection.label,
      raw_odd_type: selection.selection,
      source_odd_id: Number(`${snapshot.external_event_id}${marketIndex}${selectionIndex}`),
      raw: { snapshotId: snapshot.id, marketIndex, selectionIndex, orientation },
      updated_at: updatedAt
    }))
  );
  return [...new Map(rows.map((row) => [`${row.pa_category}:${row.selection}:${row.source_odd_id}`, row])).values()];
}

export async function matchBet365Snapshots(options: { date?: BookmakerCollectOptions["date"]; logger?: Logger } = {}) {
  const dates = targetDateKeys(options.date);
  const [{ data: snapshotData, error: snapshotError }, { data: fixtureData, error: fixtureError }] = await Promise.all([
    supabase
      .from("bookmaker_event_snapshots")
      .select("id,external_event_id,league_api_football_id,league_name,event_name,home_team,away_team,starts_at,date_key,source_url,markets,raw")
      .eq("bookmaker_slug", "bet365")
      .in("date_key", dates),
    supabase
      .from("fixtures")
      .select("id,home_team,away_team,starts_at,date_key,league:leagues!inner(name,api_football_league_id,enabled)")
      .in("date_key", dates)
      .eq("leagues.enabled", true)
  ]);
  if (snapshotError) throw snapshotError;
  if (fixtureError) throw fixtureError;

  const snapshots = (snapshotData ?? []).map((row) => ({ ...row, markets: snapshotMarkets(row.markets) })) as unknown as SnapshotRow[];
  const fixtures = (fixtureData ?? []) as unknown as CanonicalFixtureRow[];
  let matched = 0;
  let unmatched = 0;
  let invalid = 0;
  let oddsUpserted = 0;

  for (const snapshot of snapshots) {
    if (!snapshot.markets.length) {
      invalid += 1;
      continue;
    }
    const candidates = fixtures
      .filter((fixture) => {
        const league = fixtureLeague(fixture);
        return !snapshot.league_api_football_id || Number(league?.api_football_league_id) === Number(snapshot.league_api_football_id);
      })
      .map((fixture) => ({
        ...fixture,
        startsAt: fixture.starts_at,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team,
        leagueName: fixtureLeague(fixture)?.name ?? null
      }));
    const result = findBestCanonicalEventMatch(
      candidates,
      {
        id: snapshot.external_event_id,
        startsAt: snapshot.starts_at ?? "",
        homeTeam: snapshot.home_team,
        awayTeam: snapshot.away_team,
        leagueName: snapshot.league_name
      },
      { context: "league-scoped" }
    );
    if (!result) {
      unmatched += 1;
      await options.logger?.("warn", "evento bet365 pendente no matching", {
        eventName: snapshot.event_name,
        externalEventId: snapshot.external_event_id,
        leagueName: snapshot.league_name,
        startsAt: snapshot.starts_at
      });
      continue;
    }

    const link = buildLink(snapshot, result.fixture, result.score);
    const odds = buildOdds(snapshot, result.fixture, result.orientation);
    const oddsSaved = await OddsRepository.saveAll("bet365", [link], odds, {
      replaceExistingOdds: true,
      cleanupPaCategories: [...new Set(snapshot.markets.map((market) => market.paCategory))]
    });
    oddsUpserted += oddsSaved;
    const { error: linkRawError } = await supabase
      .from("bookmaker_event_links")
      .update({ source_url: link.source_url, raw: link.raw, updated_at: link.updated_at })
      .eq("bookmaker_slug", link.bookmaker_slug)
      .eq("external_event_id", link.external_event_id);
    if (linkRawError) throw linkRawError;
    const { error: updateError } = await supabase
      .from("bookmaker_event_snapshots")
      .update({
        raw: { ...(snapshot.raw ?? {}), stage: "matched", fixtureId: result.fixture.id, score: result.score, orientation: result.orientation },
        updated_at: new Date().toISOString()
      })
      .eq("id", snapshot.id);
    if (updateError) throw updateError;
    await options.logger?.("info", "evento bet365 confirmado no matching", {
      eventName: snapshot.event_name,
      externalEventId: snapshot.external_event_id,
      fixtureId: result.fixture.id,
      sourceUrl: snapshot.source_url,
      oddsSaved
    });
    matched += 1;
  }

  const summary = { dates, snapshots: snapshots.length, matched, unmatched, invalid, oddsUpserted };
  await options.logger?.("info", "matching externo da bet365 finalizado", summary);
  return summary;
}

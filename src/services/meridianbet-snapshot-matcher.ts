import { createHash } from "node:crypto";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { findBestCanonicalEventMatch, selectionForCanonicalOrientation } from "../domain/matching/event-matcher.js";
import { normalizeName } from "../domain/text.js";
import type { MeridianCollectedMarket } from "../providers/meridianbet.js";
import {
  canonicalNameFromAlias,
  learnConfirmedEventAliases,
  linkOrientation,
  loadBookmakerAliasIndex
} from "./bookmaker-match-memory.js";

type Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;
type Snapshot = {
  id: string; external_event_id: number; league_api_football_id: number | null; league_name: string | null;
  event_name: string; home_team: string | null; away_team: string | null; starts_at: string | null;
  date_key: string | null; source_url: string | null; markets: MeridianCollectedMarket[]; raw: Record<string, unknown> | null;
};
type Fixture = {
  id: string; home_team_id: string; away_team_id: string; home_team: string; away_team: string; starts_at: string; date_key: string;
  league: { name: string; api_football_league_id: number } | Array<{ name: string; api_football_league_id: number }> | null;
};
type ExistingLink = {
  fixture_id: string; external_event_id: number; match_confidence_score: number; raw: Record<string, unknown> | null;
};

function key(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function targetDates(date: BookmakerCollectOptions["date"]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (!date) return [key(today), key(tomorrow)];
  if (date === "today") return [key(today)];
  if (date === "tomorrow") return [key(tomorrow)];
  return [date];
}

function league(fixture: Fixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function snapshotOddsSignature(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function validMarkets(value: unknown): MeridianCollectedMarket[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MeridianCollectedMarket => {
    if (!item || typeof item !== "object") return false;
    const market = item as { paCategory?: unknown; selections?: unknown };
    if (market.paCategory !== "COM_PA" && market.paCategory !== "SEM_PA" || !Array.isArray(market.selections)) return false;
    const selections = market.selections as Array<{ selection?: unknown; price?: unknown }>;
    const kinds = new Set(selections.map((selection) => selection.selection));
    return kinds.has("HOME") && kinds.has("DRAW") && kinds.has("AWAY") && selections.every((selection) => Number(selection.price) > 1);
  });
}

function buildLink(
  snapshot: Snapshot,
  fixture: Fixture,
  score: number,
  orientation: "NORMAL" | "INVERTED",
  previousRaw: Record<string, unknown> | null = null
): BookmakerLinkRow {
  const raw = previousRaw ?? {};
  return {
    bookmaker_slug: "meridianbet",
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
    raw: {
      stage: "matched-from-snapshot",
      collectionUrl: typeof raw.collectionUrl === "string" ? raw.collectionUrl : snapshot.source_url,
      rawSourceUrl: typeof raw.rawSourceUrl === "string" ? raw.rawSourceUrl : snapshot.source_url,
      snapshotId: snapshot.id,
      lastDirectOkAt: typeof raw.lastDirectOkAt === "string" ? raw.lastDirectOkAt : null,
      lastDirectFailAt: typeof raw.lastDirectFailAt === "string" ? raw.lastDirectFailAt : null,
      lastFailReason: typeof raw.lastFailReason === "string" ? raw.lastFailReason : null,
      failCount: Number.isFinite(Number(raw.failCount)) ? Number(raw.failCount) : 0,
      marketsSeen: snapshot.markets.map((market) => market.paCategory),
      orientation,
      associationConfirmed: true
    },
    updated_at: new Date().toISOString()
  };
}

function buildOdds(snapshot: Snapshot, fixture: Fixture, orientation: "NORMAL" | "INVERTED"): OddRow[] {
  const updatedAt = new Date().toISOString();
  return snapshot.markets.flatMap((market, marketIndex) => market.selections.map((selection, selectionIndex) => ({
    fixture_id: fixture.id,
    bookmaker_slug: "meridianbet",
    market_code: "1X2",
    market_name: "MoneyLine",
    selection: selectionForCanonicalOrientation(selection.selection, orientation),
    price: selection.price,
    pa_category: market.paCategory,
    confidence_score: market.confidence,
    raw_market_name: market.marketName,
    raw_label: selection.label,
    raw_odd_type: selection.index === 0 ? "1" : selection.index === 1 ? "X" : "2",
    source_odd_id: snapshot.external_event_id * 1000 + marketIndex * 10 + selectionIndex,
    raw: { snapshotId: snapshot.id, orientation, marketIndex, selectionIndex },
    updated_at: updatedAt
  })));
}

export async function matchMeridianbetSnapshots(options: { date?: BookmakerCollectOptions["date"]; logger?: Logger } = {}) {
  const dates = targetDates(options.date);
  const [
    { data: snapshotRows, error: snapshotError },
    { data: fixtureRows, error: fixtureError },
    { data: linkRows, error: linkError },
    { data: oddRows, error: oddError }
  ] = await Promise.all([
    supabase.from("bookmaker_event_snapshots")
      .select("id,external_event_id,league_api_football_id,league_name,event_name,home_team,away_team,starts_at,date_key,source_url,markets,raw")
      .eq("bookmaker_slug", "meridianbet")
      .in("date_key", dates),
    supabase.from("fixtures")
      .select("id,home_team_id,away_team_id,home_team,away_team,starts_at,date_key,league:leagues!inner(name,api_football_league_id,enabled)")
      .in("date_key", dates).eq("leagues.enabled", true),
    supabase.from("bookmaker_event_links")
      .select("fixture_id,external_event_id,match_confidence_score,raw")
      .eq("bookmaker_slug", "meridianbet"),
    supabase.from("odds")
      .select("fixture_id")
      .eq("bookmaker_slug", "meridianbet")
  ]);
  if (snapshotError) throw snapshotError;
  if (fixtureError) throw fixtureError;
  if (linkError) throw linkError;
  if (oddError) throw oddError;
  const fixtures = (fixtureRows ?? []) as unknown as Fixture[];
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const linkByEventId = new Map(((linkRows ?? []) as ExistingLink[]).map((link) => [String(link.external_event_id), link]));
  const oddFixtureIds = new Set((oddRows ?? []).map((row) => row.fixture_id));
  const snapshots = (snapshotRows ?? [])
    .filter((row) => {
      const raw = row.raw as Record<string, unknown> | null;
      const link = linkByEventId.get(String(row.external_event_id));
      const oddsMissingForCurrentSnapshot = !oddFixtureIds.has(link?.fixture_id ?? "") && raw?.oddsSnapshotSignature !== snapshotOddsSignature(row.markets);
      return raw?.stage !== "matched" || !link || !fixtureById.has(link.fixture_id) || oddsMissingForCurrentSnapshot;
    })
    .map((row) => ({ ...row, markets: validMarkets(row.markets) })) as unknown as Snapshot[];
  const aliasIndex = await loadBookmakerAliasIndex(fixtures);
  let unmatched = 0;
  let invalid = 0;
  const processed: Array<{
    snapshot: Snapshot;
    fixture: Fixture;
    orientation: "NORMAL" | "INVERTED";
    score: number;
    reused: boolean;
    link: BookmakerLinkRow;
    odds: OddRow[];
  }> = [];

  for (const snapshot of snapshots) {
    if (!snapshot.markets.length || !snapshot.home_team || !snapshot.away_team) {
      invalid += 1;
      await options.logger?.("warn", "snapshot da meridianbet sem dados suficientes para matching", {
        eventName: snapshot.event_name,
        externalEventId: snapshot.external_event_id
      });
      continue;
    }
    const existingLink = linkByEventId.get(String(snapshot.external_event_id));
    const linkedFixture = existingLink ? fixtureById.get(existingLink.fixture_id) : null;
    const snapshotOrientation = linkOrientation(snapshot.raw);
    const rememberedOrientation = linkOrientation(existingLink?.raw) ?? snapshotOrientation;
    const rememberedFixtureId = typeof snapshot.raw?.fixtureId === "string" ? snapshot.raw.fixtureId : null;
    const associatedFixture = linkedFixture ?? (rememberedFixtureId ? fixtureById.get(rememberedFixtureId) : null);
    const matchedHomeTeam = canonicalNameFromAlias(aliasIndex, snapshot.home_team);
    const matchedAwayTeam = canonicalNameFromAlias(aliasIndex, snapshot.away_team);
    const candidates = (associatedFixture ? [associatedFixture] : fixtures)
      .filter((fixture) => !snapshot.league_api_football_id || Number(league(fixture)?.api_football_league_id) === Number(snapshot.league_api_football_id))
      .map((fixture) => ({
        ...fixture,
        startsAt: fixture.starts_at,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team,
        leagueName: league(fixture)?.name ?? null
      }));
    const result = associatedFixture && rememberedOrientation
      ? {
          fixture: associatedFixture,
          orientation: rememberedOrientation,
          score: Number(existingLink?.match_confidence_score ?? snapshot.raw?.score ?? 1),
          reused: true
        }
      : findBestCanonicalEventMatch(candidates, {
          id: snapshot.external_event_id,
          startsAt: snapshot.starts_at ?? "",
          homeTeam: matchedHomeTeam,
          awayTeam: matchedAwayTeam,
          leagueName: snapshot.league_name
        }, { context: "league-scoped" });
    const confirmedResult = result
      ? { ...result, reused: "reused" in result ? result.reused : Boolean(associatedFixture || (snapshot.raw?.stage === "matched" && snapshotOrientation)) }
      : null;
    if (!confirmedResult) {
      unmatched += 1;
      await options.logger?.("warn", "evento meridianbet pendente no matching", {
        eventName: snapshot.event_name,
        externalEventId: snapshot.external_event_id,
        leagueName: snapshot.league_name
      });
      continue;
    }

    processed.push({
      snapshot,
      fixture: confirmedResult.fixture,
      orientation: confirmedResult.orientation,
      score: confirmedResult.score,
      reused: confirmedResult.reused,
      link: buildLink(snapshot, confirmedResult.fixture, confirmedResult.score, confirmedResult.orientation, existingLink?.raw ?? null),
      odds: buildOdds(snapshot, confirmedResult.fixture, confirmedResult.orientation)
    });
  }

  const oddsUpserted = processed.length
    ? await OddsRepository.saveAll(
        "meridianbet",
        processed.map((item) => item.link),
        processed.flatMap((item) => item.odds),
        { replaceExistingOdds: false, replaceExistingLinks: false }
      )
    : 0;

  for (let offset = 0; offset < processed.length; offset += 20) {
    await Promise.all(processed.slice(offset, offset + 20).map(async (item) => {
      const { error } = await supabase.from("bookmaker_event_snapshots").update({
        raw: {
          ...(item.snapshot.raw ?? {}),
          stage: "matched",
          fixtureId: item.fixture.id,
          score: item.score,
          orientation: item.orientation,
          associationReused: item.reused,
          oddsSnapshotSignature: snapshotOddsSignature(item.snapshot.markets)
        },
        updated_at: new Date().toISOString()
      }).eq("id", item.snapshot.id);
      if (error) throw error;
    }));
  }

  const newMatches = processed.filter((item) => !item.reused);
  for (const item of newMatches) {
    await learnConfirmedEventAliases({
      bookmakerSlug: "meridianbet",
      fixture: item.fixture,
      bookmakerHomeTeam: item.snapshot.home_team,
      bookmakerAwayTeam: item.snapshot.away_team,
      orientation: item.orientation,
      externalEventId: item.snapshot.external_event_id,
      leagueApiFootballId: item.snapshot.league_api_football_id,
      logger: options.logger
    }).catch(async (error) => {
      await options.logger?.("warn", "falha ao aprender aliases confirmados da meridianbet", {
        externalEventId: item.snapshot.external_event_id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await options.logger?.("info", "evento meridianbet confirmado no matching", {
      eventName: item.snapshot.event_name,
      externalEventId: item.snapshot.external_event_id,
      fixtureId: item.fixture.id,
      orientation: item.orientation,
      sourceUrl: item.snapshot.source_url,
      oddsSaved: item.odds.length
    });
  }

  const reused = processed.length - newMatches.length;
  const summary = {
    dates,
    snapshots: snapshots.length,
    matched: processed.length,
    reused,
    newMatches: newMatches.length,
    unmatched,
    invalid,
    oddsProcessed: processed.reduce((total, item) => total + item.odds.length, 0),
    oddsUpserted
  };
  await options.logger?.("info", "matching externo da meridianbet finalizado", summary);
  return summary;
}

import { createHash } from "node:crypto";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { findBestCanonicalEventMatch, selectionForCanonicalOrientation } from "../domain/matching/event-matcher.js";
import { normalizeName } from "../domain/text.js";
import type { Bet365Market, Logger } from "../providers/bet365/types.js";
import {
  canonicalNameFromAlias,
  learnConfirmedEventAliases,
  linkOrientation,
  loadBookmakerAliasIndex
} from "./bookmaker-match-memory.js";

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
  home_team_id: string;
  away_team_id: string;
  home_team: string;
  away_team: string;
  starts_at: string;
  date_key: string;
  league: { name: string; api_football_league_id: number } | Array<{ name: string; api_football_league_id: number }> | null;
};

type ExistingLinkRow = {
  id: string;
  fixture_id: string;
  external_event_id: number;
  match_confidence_score: number;
  source_url: string | null;
  raw: Record<string, unknown> | null;
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

function duplicateBet365LinkIds(links: ExistingLinkRow[]) {
  const byFixtureAndUrl = new Map<string, ExistingLinkRow[]>();
  for (const link of links) {
    if (!link.source_url) continue;
    const key = `${link.fixture_id}:${link.source_url}`;
    const group = byFixtureAndUrl.get(key) ?? [];
    group.push(link);
    byFixtureAndUrl.set(key, group);
  }

  const duplicateIds: string[] = [];
  for (const group of byFixtureAndUrl.values()) {
    if (group.length < 2) continue;
    const urlEventId = group[0].source_url?.match(/\/D8\/E(\d+)\//i)?.[1];
    if (!urlEventId) continue;
    const keeper = group.find((link) => String(link.external_event_id) === urlEventId);
    if (!keeper) continue;
    duplicateIds.push(...group.filter((link) => link.id !== keeper.id).map((link) => link.id));
  }
  return duplicateIds;
}

async function removeDuplicateBet365Links(links: ExistingLinkRow[]) {
  const ids = duplicateBet365LinkIds(links);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { error } = await supabase.from("links_eventos").delete().in("id", ids.slice(offset, offset + 100));
    if (error) throw error;
  }
  return ids.length;
}
function snapshotOddsSignature(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
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

function buildLink(
  snapshot: SnapshotRow,
  fixture: CanonicalFixtureRow,
  score: number,
  orientation: "NORMAL" | "INVERTED",
  previousRaw: Record<string, unknown> | null = null
): BookmakerLinkRow {
  const updatedAt = new Date().toISOString();
  const raw = previousRaw ?? {};
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
    raw: {
      stage: "matched-from-snapshot",
      snapshotId: snapshot.id,
      collectionUrl: typeof raw.collectionUrl === "string" ? raw.collectionUrl : snapshot.source_url,
      rawSourceUrl: typeof raw.rawSourceUrl === "string" ? raw.rawSourceUrl : snapshot.source_url,
      discoveredFromLeagueUrl: typeof raw.discoveredFromLeagueUrl === "string" ? raw.discoveredFromLeagueUrl : null,
      discoveredAt: typeof raw.discoveredAt === "string" ? raw.discoveredAt : null,
      lastDirectOkAt: typeof raw.lastDirectOkAt === "string" ? raw.lastDirectOkAt : null,
      lastDirectFailAt: typeof raw.lastDirectFailAt === "string" ? raw.lastDirectFailAt : null,
      lastFailReason: typeof raw.lastFailReason === "string" ? raw.lastFailReason : null,
      failCount: Number.isFinite(Number(raw.failCount)) ? Number(raw.failCount) : 0,
      marketsSeen: snapshot.markets.map((market) => market.paCategory),
      missingMarkets: [],
      orientation,
      associationConfirmed: true
    },
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
  const [
    { data: snapshotData, error: snapshotError },
    { data: fixtureData, error: fixtureError },
    { data: linkData, error: linkError },
    { data: oddData, error: oddError }
  ] = await Promise.all([
    supabase
      .from("capturas_eventos")
      .select("id,external_event_id,league_api_football_id,league_name,event_name,home_team,away_team,starts_at,date_key,source_url,markets,raw")
      .eq("bookmaker_slug", "bet365"),
    supabase
      .from("jogos")
      .select("id,home_team_id,away_team_id,home_team,away_team,starts_at,date_key,league:campeonatos!inner(name,api_football_league_id,enabled)")
      .in("date_key", dates)
      .eq("campeonatos.enabled", true),
    supabase
      .from("links_eventos")
      .select("id,fixture_id,external_event_id,match_confidence_score,source_url,raw")
      .eq("bookmaker_slug", "bet365"),
    supabase
      .from("cotacoes")
      .select("fixture_id")
      .eq("bookmaker_slug", "bet365")
  ]);
  if (snapshotError) throw snapshotError;
  if (fixtureError) throw fixtureError;
  if (linkError) throw linkError;
  if (oddError) throw oddError;

  const fixtures = (fixtureData ?? []) as unknown as CanonicalFixtureRow[];
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const existingLinks = (linkData ?? []) as ExistingLinkRow[];
  const linksByEventId = new Map(existingLinks.map((link) => [String(link.external_event_id), link]));
  const linksBySourceUrl = new Map(existingLinks.filter((link) => link.source_url).map((link) => [link.source_url as string, link]));
  const linksByFixtureId = new Map<string, ExistingLinkRow[]>();
  for (const link of existingLinks) {
    const group = linksByFixtureId.get(link.fixture_id) ?? [];
    group.push(link);
    linksByFixtureId.set(link.fixture_id, group);
  }
  const rememberedLinkForSnapshot = (row: { external_event_id: string | number; source_url: string | null }) =>
    linksByEventId.get(String(row.external_event_id)) ?? (row.source_url ? linksBySourceUrl.get(row.source_url) : undefined);
  const oddFixtureIds = new Set((oddData ?? []).map((row) => row.fixture_id));
  const snapshots = (snapshotData ?? [])
    .filter((row) => {
      const raw = row.raw as Record<string, unknown> | null;
      const link = rememberedLinkForSnapshot(row);
      const oddsMissingForCurrentSnapshot = !oddFixtureIds.has(link?.fixture_id ?? "") && raw?.oddsSnapshotSignature !== snapshotOddsSignature(row.markets);
      return raw?.stage !== "matched" || !link || !fixtureById.has(link.fixture_id) || oddsMissingForCurrentSnapshot;
    })
    .map((row) => ({ ...row, markets: snapshotMarkets(row.markets) })) as unknown as SnapshotRow[];
  const aliasIndex = await loadBookmakerAliasIndex(fixtures);
  let unmatched = 0;
  let invalid = 0;
  const processed: Array<{
    snapshot: SnapshotRow;
    fixture: CanonicalFixtureRow;
    orientation: "NORMAL" | "INVERTED";
    score: number;
    reused: boolean;
    link: BookmakerLinkRow;
    odds: OddRow[];
  }> = [];

  for (const snapshot of snapshots) {
    if (!snapshot.markets.length) {
      invalid += 1;
      continue;
    }
    const existingLink = rememberedLinkForSnapshot(snapshot);
    const linkedFixture = existingLink ? fixtureById.get(existingLink.fixture_id) : null;
    const snapshotOrientation = linkOrientation(snapshot.raw);
    const rememberedOrientation = linkOrientation(existingLink?.raw) ?? snapshotOrientation;
    const rememberedFixtureId = typeof snapshot.raw?.fixtureId === "string" ? snapshot.raw.fixtureId : null;
    const confirmedFixtureId = typeof snapshot.raw?.confirmedFixtureId === "string" ? snapshot.raw.confirmedFixtureId : null;
    const associatedFixture = linkedFixture ?? (rememberedFixtureId ? fixtureById.get(rememberedFixtureId) : null);
    const confirmedFixture = confirmedFixtureId ? fixtureById.get(confirmedFixtureId) : null;
    const matchedHomeTeam = canonicalNameFromAlias(aliasIndex, snapshot.home_team);
    const matchedAwayTeam = canonicalNameFromAlias(aliasIndex, snapshot.away_team);
    const candidates = (associatedFixture ? [associatedFixture] : fixtures)
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
    const confirmedCandidates = confirmedFixture
      ? [{ ...confirmedFixture, startsAt: confirmedFixture.starts_at, homeTeam: confirmedFixture.home_team, awayTeam: confirmedFixture.away_team, leagueName: fixtureLeague(confirmedFixture)?.name ?? null }]
      : null;
    const result = associatedFixture && rememberedOrientation
      ? {
          fixture: associatedFixture,
          orientation: rememberedOrientation,
          score: Number(existingLink?.match_confidence_score ?? snapshot.raw?.score ?? 1),
          reused: true
        }
      : findBestCanonicalEventMatch(
          candidates,
          {
            id: snapshot.external_event_id,
            startsAt: snapshot.starts_at ?? "",
            homeTeam: matchedHomeTeam,
            awayTeam: matchedAwayTeam,
            leagueName: snapshot.league_name
          },
          { context: "league-scoped" }
        ) ?? (snapshot.league_api_football_id
          ? findBestCanonicalEventMatch(
              candidates,
              {
                id: snapshot.external_event_id,
                startsAt: snapshot.starts_at ?? "",
                homeTeam: matchedHomeTeam,
                awayTeam: matchedAwayTeam,
                leagueName: snapshot.league_name
              },
              { context: "league-scoped", maxTimeDiffMs: 48 * 60 * 60 * 1000, teamOnlyMinScore: 0.8 }
            )
          : null) ?? (confirmedCandidates
          ? findBestCanonicalEventMatch(
              confirmedCandidates,
              {
                id: snapshot.external_event_id,
                startsAt: snapshot.starts_at ?? "",
                homeTeam: matchedHomeTeam,
                awayTeam: matchedAwayTeam,
                leagueName: snapshot.league_name
              },
              { context: "league-scoped", maxTimeDiffMs: 48 * 60 * 60 * 1000, teamOnlyMinScore: 0.65 }
            )
          : null);
    const confirmedResult = result
      ? { ...result, reused: "reused" in result ? result.reused : Boolean(associatedFixture || (snapshot.raw?.stage === "matched" && snapshotOrientation)) }
      : null;
    if (!confirmedResult) {
      unmatched += 1;
      await options.logger?.("warn", "evento bet365 pendente no matching", {
        eventName: snapshot.event_name,
        externalEventId: snapshot.external_event_id,
        leagueName: snapshot.league_name,
        startsAt: snapshot.starts_at
      });
      continue;
    }

    const fixtureLinks = linksByFixtureId.get(confirmedResult.fixture.id) ?? [];
    const conflictingExistingLinks = fixtureLinks.filter(
      (link) => String(link.external_event_id) !== String(snapshot.external_event_id)
    );
    if (conflictingExistingLinks.length) {
      unmatched += 1;
      await options.logger?.("warn", "evento bet365 rejeitado: fixture ja possui outro link confirmado", {
        eventName: snapshot.event_name,
        externalEventId: snapshot.external_event_id,
        fixtureId: confirmedResult.fixture.id,
        existingEventIds: conflictingExistingLinks.map((link) => link.external_event_id),
        startsAt: snapshot.starts_at
      });
      continue;
    }

    processed.push({
      snapshot,
      fixture: confirmedResult.fixture,
      orientation: confirmedResult.orientation,
      score: confirmedResult.score,
      reused: confirmedResult.reused,
      link: buildLink(
        snapshot,
        confirmedResult.fixture,
        confirmedResult.score,
        confirmedResult.orientation,
        existingLink?.raw ?? null
      ),
      odds: buildOdds(snapshot, confirmedResult.fixture, confirmedResult.orientation)
    });
  }

  const processedByFixture = new Map<string, typeof processed>();
  for (const item of processed) {
    const group = processedByFixture.get(item.fixture.id) ?? [];
    group.push(item);
    processedByFixture.set(item.fixture.id, group);
  }
  const conflictingFixtureIds = new Set<string>();
  for (const [fixtureId, group] of processedByFixture) {
    const eventIds = new Set(group.map((item) => String(item.snapshot.external_event_id)));
    if (eventIds.size <= 1) continue;
    conflictingFixtureIds.add(fixtureId);
    await options.logger?.("warn", "matching ignorado por conflito de eventos no mesmo fixture", {
      bookmakerSlug: "bet365",
      fixtureId,
      events: group.map((item) => ({
        eventName: item.snapshot.event_name,
        externalEventId: item.snapshot.external_event_id,
        sourceUrl: item.snapshot.source_url
      }))
    });
  }
  const safeProcessed = conflictingFixtureIds.size
    ? processed.filter((item) => !conflictingFixtureIds.has(item.fixture.id))
    : processed;

  const oddsUpserted = safeProcessed.length
    ? await OddsRepository.saveAll(
        "bet365",
        safeProcessed.map((item) => item.link),
        safeProcessed.flatMap((item) => item.odds),
        { replaceExistingOdds: false, replaceExistingLinks: true }
      )
    : 0;

  const { data: currentLinkData, error: currentLinkError } = await supabase
    .from("links_eventos")
    .select("id,fixture_id,external_event_id,match_confidence_score,source_url,raw")
    .eq("bookmaker_slug", "bet365");
  if (currentLinkError) throw currentLinkError;
  const duplicateLinksRemoved = await removeDuplicateBet365Links((currentLinkData ?? []) as ExistingLinkRow[]);

  for (let offset = 0; offset < safeProcessed.length; offset += 20) {
    await Promise.all(safeProcessed.slice(offset, offset + 20).map(async (item) => {
      const { error } = await supabase
        .from("capturas_eventos")
        .update({
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
        })
        .eq("id", item.snapshot.id);
      if (error) throw error;
    }));
  }

  const newMatches = safeProcessed.filter((item) => !item.reused);
  for (const item of newMatches) {
    await learnConfirmedEventAliases({
      bookmakerSlug: "bet365",
      fixture: item.fixture,
      bookmakerHomeTeam: item.snapshot.home_team,
      bookmakerAwayTeam: item.snapshot.away_team,
      orientation: item.orientation,
      externalEventId: item.snapshot.external_event_id,
      leagueApiFootballId: item.snapshot.league_api_football_id,
      logger: options.logger
    }).catch(async (error) => {
      await options.logger?.("warn", "falha ao aprender aliases confirmados da bet365", {
        externalEventId: item.snapshot.external_event_id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await options.logger?.("info", "evento bet365 confirmado no matching", {
      eventName: item.snapshot.event_name,
      externalEventId: item.snapshot.external_event_id,
      fixtureId: item.fixture.id,
      orientation: item.orientation,
      sourceUrl: item.snapshot.source_url,
      oddsSaved: item.odds.length
    });
  }

  const reused = safeProcessed.length - newMatches.length;
  const summary = {
    dates,
    snapshots: snapshots.length,
    matched: safeProcessed.length,
    reused,
    newMatches: newMatches.length,
    unmatched,
    invalid,
    oddsProcessed: safeProcessed.reduce((total, item) => total + item.odds.length, 0),
    conflicts: processed.length - safeProcessed.length,
    duplicateLinksRemoved,
    oddsUpserted
  };
  await options.logger?.("info", "matching externo da bet365 finalizado", summary);
  return summary;
}

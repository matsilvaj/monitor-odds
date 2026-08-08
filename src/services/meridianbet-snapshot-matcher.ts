import { createHash } from "node:crypto";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { findBestCanonicalEventMatch, selectionForCanonicalOrientation } from "../domain/matching/event-matcher.js";
import { teamNameSimilarity } from "../domain/matching/text-similarity.js";
import { normalizeName } from "../domain/text.js";
import type { MeridianCollectedMarket, MeridianCollectedSelection } from "../providers/meridianbet.js";
import type { Selection } from "../domain/normalize.js";
import {
  canonicalNameFromAlias,
  learnConfirmedEventAliases,
  linkOrientation,
  loadBookmakerAliasIndex
} from "./bookmaker-match-memory.js";
import { findFixtureWithLlm } from "./llm-fixture-matcher.js";

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
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bahia" }).format(date);
}
function targetDates(date: BookmakerCollectOptions["date"]) {
  const now = new Date();
  const yesterdayKey = key(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const todayKey = key(now);
  const tomorrowKey = key(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  if (!date) return [yesterdayKey, todayKey, tomorrowKey];
  if (date === "today") return [yesterdayKey, todayKey];
  if (date === "tomorrow") return [todayKey, tomorrowKey];
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
  return value.flatMap((item): MeridianCollectedMarket[] => {
    if (!item || typeof item !== "object") return [];
    const market = item as { paCategory?: unknown; selections?: unknown; marketName?: unknown; confidence?: unknown; rawText?: unknown; index?: unknown };
    if (!Array.isArray(market.selections)) return [];
    const selections = market.selections as Array<{ selection?: unknown; price?: unknown; label?: unknown; index?: unknown }>;
    const kinds = new Set(selections.map((s) => s.selection));
    if (!kinds.has("HOME") || !kinds.has("DRAW") || !kinds.has("AWAY")) return [];
    if (!selections.every((s) => Number(s.price) > 1)) return [];
    const paCategory: "COM_PA" | "SEM_PA" = market.paCategory === "COM_PA" ? "COM_PA" : "SEM_PA";
    return [{
      marketName: typeof market.marketName === "string" ? market.marketName : "MoneyLine",
      paCategory,
      confidence: typeof market.confidence === "number" ? market.confidence : 1,
      rawText: typeof market.rawText === "string" ? market.rawText : "",
      index: typeof market.index === "number" ? market.index : 0,
      selections: selections.map((s) => ({
        selection: s.selection as MeridianCollectedSelection["selection"],
        label: typeof s.label === "string" ? s.label : String(s.selection ?? ""),
        price: Number(s.price),
        index: typeof s.index === "number" ? s.index : 0
      }))
    }];
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
    supabase.from("capturas_eventos")
      .select("id,external_event_id,league_api_football_id,league_name,event_name,home_team,away_team,starts_at,date_key,source_url,markets,raw")
      .eq("bookmaker_slug", "meridianbet")
      .in("date_key", dates),
    supabase.from("jogos")
      .select("id,home_team_id,away_team_id,home_team,away_team,starts_at,date_key,league:campeonatos!inner(name,api_football_league_id,enabled)")
      .in("date_key", dates).eq("campeonatos.enabled", true),
    supabase.from("links_eventos")
      .select("fixture_id,external_event_id,match_confidence_score,raw")
      .eq("bookmaker_slug", "meridianbet"),
    supabase.from("cotacoes")
      .select("fixture_id")
      .eq("bookmaker_slug", "meridianbet")
  ]);
  if (snapshotError) throw snapshotError;
  if (fixtureError) throw fixtureError;
  if (linkError) throw linkError;
  if (oddError) throw oddError;
  const fixtures = (fixtureRows ?? []) as unknown as Fixture[];
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const existingLinks = (linkRows ?? []) as ExistingLink[];
  const linkByEventId = new Map(existingLinks.map((link) => [String(link.external_event_id), link]));
  const linksByFixtureId = new Map<string, ExistingLink[]>();
  for (const link of existingLinks) {
    const group = linksByFixtureId.get(link.fixture_id) ?? [];
    group.push(link);
    linksByFixtureId.set(link.fixture_id, group);
  }
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
    if (!candidates.length && snapshot.league_api_football_id) {
      await options.logger?.("warn", "meridianbet sem candidatos para matching (fixture fora do range de datas)", {
        eventName: snapshot.event_name,
        leagueName: snapshot.league_name,
        leagueApiFootballId: snapshot.league_api_football_id,
        snapshotStartsAt: snapshot.starts_at,
        dates
      });
    }
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
        }, { context: "league-scoped" })
        ?? (snapshot.league_api_football_id
          ? findBestCanonicalEventMatch(candidates, {
              id: snapshot.external_event_id,
              startsAt: snapshot.starts_at ?? "",
              homeTeam: matchedHomeTeam,
              awayTeam: matchedAwayTeam,
              leagueName: snapshot.league_name
            }, { context: "league-scoped", maxTimeDiffMs: 48 * 60 * 60 * 1000, teamOnlyMinScore: 0.8 })
          : null);
    const confirmedResult = result
      ? { ...result, reused: "reused" in result ? result.reused : Boolean(associatedFixture || (snapshot.raw?.stage === "matched" && snapshotOrientation)) }
      : null;
    if (!confirmedResult) {
      const llmResult = snapshot.league_api_football_id
        ? await findFixtureWithLlm({
            bookmakerHomeTeam: snapshot.home_team ?? "",
            bookmakerAwayTeam: snapshot.away_team ?? "",
            leagueName: snapshot.league_name,
            startsAt: snapshot.starts_at,
            candidates: candidates.map((c) => ({ id: c.id, home_team: c.home_team, away_team: c.away_team, starts_at: c.starts_at }))
          }).catch(async (err: unknown) => {
            await options.logger?.("warn", "erro no fallback llm da meridianbet", {
              eventName: snapshot.event_name,
              error: err instanceof Error ? err.message : String(err)
            });
            return null;
          })
        : null;
      if (llmResult) {
        const llmFixture = fixtureById.get(llmResult.fixtureId);
        if (llmFixture) {
          const MIN_LLM_SIDE_SCORE = 0.3;
          const [fixtureHome, fixtureAway] = llmResult.orientation === "INVERTED"
            ? [llmFixture.away_team, llmFixture.home_team]
            : [llmFixture.home_team, llmFixture.away_team];
          const homeScore = teamNameSimilarity(snapshot.home_team ?? "", fixtureHome);
          const awayScore = teamNameSimilarity(snapshot.away_team ?? "", fixtureAway);
          if (homeScore < MIN_LLM_SIDE_SCORE || awayScore < MIN_LLM_SIDE_SCORE) {
            unmatched += 1;
            await options.logger?.("warn", "resultado do llm rejeitado por baixa similaridade de times", {
              eventName: snapshot.event_name,
              bookmakerHome: snapshot.home_team,
              bookmakerAway: snapshot.away_team,
              fixtureHome: llmFixture.home_team,
              fixtureAway: llmFixture.away_team,
              homeScore: Number(homeScore.toFixed(3)),
              awayScore: Number(awayScore.toFixed(3)),
              minRequired: MIN_LLM_SIDE_SCORE
            });
            continue;
          }
        }
        const llmFixtureLinks = llmFixture ? (linksByFixtureId.get(llmFixture.id) ?? []) : [];
        const hasConflict = llmFixtureLinks.some((link) => String(link.external_event_id) !== String(snapshot.external_event_id));
        if (llmFixture && !hasConflict) {
          await options.logger?.("info", "evento meridianbet confirmado via llm", {
            eventName: snapshot.event_name,
            bookmakerHome: snapshot.home_team,
            bookmakerAway: snapshot.away_team,
            canonicalHome: llmFixture.home_team,
            canonicalAway: llmFixture.away_team,
            orientation: llmResult.orientation
          });
          processed.push({
            snapshot,
            fixture: llmFixture,
            orientation: llmResult.orientation,
            score: 0.9,
            reused: false,
            link: buildLink(snapshot, llmFixture, 0.9, llmResult.orientation, existingLink?.raw ?? null),
            odds: buildOdds(snapshot, llmFixture, llmResult.orientation)
          });
          continue;
        }
      }
      unmatched += 1;
      await options.logger?.("warn", "evento meridianbet pendente no matching", {
        eventName: snapshot.event_name,
        externalEventId: snapshot.external_event_id,
        leagueName: snapshot.league_name
      });
      continue;
    }

    const fixtureLinks = linksByFixtureId.get(confirmedResult.fixture.id) ?? [];
    const conflictingExistingLinks = fixtureLinks.filter(
      (link) => String(link.external_event_id) !== String(snapshot.external_event_id)
    );
    if (conflictingExistingLinks.length) {
      unmatched += 1;
      await options.logger?.("warn", "evento meridianbet rejeitado: fixture ja possui outro link confirmado", {
        eventName: snapshot.event_name,
        externalEventId: snapshot.external_event_id,
        fixtureId: confirmedResult.fixture.id,
        existingEventIds: conflictingExistingLinks.map((link) => link.external_event_id)
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
      bookmakerSlug: "meridianbet",
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
        "meridianbet",
        safeProcessed.map((item) => item.link),
        safeProcessed.flatMap((item) => item.odds),
        { replaceExistingOdds: true, replaceExistingLinks: true }
      )
    : 0;

  for (let offset = 0; offset < safeProcessed.length; offset += 20) {
    await Promise.all(safeProcessed.slice(offset, offset + 20).map(async (item) => {
      const { error } = await supabase.from("capturas_eventos").update({
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

  const newMatches = safeProcessed.filter((item) => !item.reused);
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
    oddsUpserted
  };
  await options.logger?.("info", "matching externo da meridianbet finalizado", summary);
  return summary;
}

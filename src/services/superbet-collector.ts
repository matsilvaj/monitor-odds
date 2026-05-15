import type { SuperbetBookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents, selectionForCanonicalOrientation, type EventMatchResult } from "../domain/matching/event-matcher.js";
import type { Selection } from "../domain/normalize.js";
import { normalizeName } from "../domain/text.js";
import { SuperbetClient, type SuperbetEvent, type SuperbetOdd } from "../providers/superbet.js";
import { errorMessage } from "../utils/errors.js";

function serializeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };

  try {
    return JSON.parse(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

type CanonicalFixture = {
  id: string;
  api_football_fixture_id: number;
  name: string;
  home_team: string | null;
  away_team: string | null;
  normalized_home_team: string | null;
  normalized_away_team: string | null;
  starts_at: string;
};

async function log(bookmaker: SuperbetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: SuperbetBookmakerConfig) {
  const { error } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
  if (error) throw error;
}

async function getCanonicalFixtures() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);

  const { data, error } = await supabase
    .from("fixtures")
    .select("id,api_football_fixture_id,name,home_team,away_team,normalized_home_team,normalized_away_team,starts_at")
    .gt("starts_at", now.toISOString())
    .lt("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CanonicalFixture[];
}

function splitTeams(event: SuperbetEvent) {
  const [homeTeam, awayTeam] = String(event.matchName ?? "").split(/[·Â]+/);
  return { homeTeam: homeTeam?.trim() || null, awayTeam: awayTeam?.trim() || null };
}

function matchFixture(event: SuperbetEvent, fixtures: CanonicalFixture[]) {
  const { homeTeam, awayTeam } = splitTeams(event);
  let best: (EventMatchResult & { fixture: CanonicalFixture }) | null = null;

  for (const fixture of fixtures) {
    const result = matchEvents(
      {
        id: fixture.id,
        startsAt: fixture.starts_at,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team
      },
      {
        id: event.eventId,
        startsAt: event.unixDateMillis ?? event.utcDate ?? "",
        homeTeam,
        awayTeam
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { ...result, fixture };
  }

  return best;
}

function isNearCanonicalFixtureWindow(event: SuperbetEvent, fixtures: CanonicalFixture[]) {
  const eventStart = Number(event.unixDateMillis ?? Date.parse(event.utcDate ?? ""));
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => Math.abs(new Date(fixture.starts_at).getTime() - eventStart) <= 20 * 60 * 1000);
}

function isMoneylineOdd(odd: SuperbetOdd) {
  return odd.status === "active" && odd.marketId === 547 && /resultado final/i.test(odd.marketName ?? "") && ["1", "0", "2"].includes(String(odd.code));
}

function selectionFromOdd(odd: SuperbetOdd): Selection | null {
  if (String(odd.code) === "1") return "HOME";
  if (String(odd.code) === "0") return "DRAW";
  if (String(odd.code) === "2") return "AWAY";
  return null;
}

function paForEvent(event: SuperbetEvent) {
  if (event.superAdvantage === "SA_PREMATCH") {
    return {
      category: "COM_PA" as const,
      confidence: 0.98,
      reason: "superbet-superplacar-2-goal-advantage"
    };
  }

  return {
    category: "SEM_PA" as const,
    confidence: 1,
    reason: "superbet-standard-result-market"
  };
}

function buildBookmakerLink(bookmaker: SuperbetBookmakerConfig, fixtureId: string, event: SuperbetEvent, confidenceScore: number): BookmakerLinkRow {
  const { homeTeam, awayTeam } = splitTeams(event);
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.eventId,
    fixture_id: fixtureId,
    bookmaker_event_name: event.matchName ?? [homeTeam, awayTeam].filter(Boolean).join(" vs "),
    bookmaker_home_team: homeTeam,
    bookmaker_away_team: awayTeam,
    normalized_bookmaker_home_team: normalizeName(homeTeam),
    normalized_bookmaker_away_team: normalizeName(awayTeam),
    starts_at: event.utcDate ?? new Date(event.unixDateMillis ?? Date.now()).toISOString(),
    match_confidence_score: confidenceScore,
    source_url: `${bookmaker.referer.replace(/\/$/, "")}/odds/futebol/${normalizeName(event.matchName).replace(/\s+/g, "-")}-${event.eventId}/`,
    raw: event,
    updated_at: new Date().toISOString()
  };
}

function buildMoneylineOdds(bookmaker: SuperbetBookmakerConfig, fixtureId: string, event: SuperbetEvent, orientation: EventMatchResult["orientation"]): OddRow[] {
  const rows: OddRow[] = [];
  const pa = paForEvent(event);

  for (const odd of (event.odds ?? []).filter(isMoneylineOdd)) {
    const selection = selectionFromOdd(odd);
    if (!selection || Number(odd.price) <= 0) continue;

    rows.push({
      fixture_id: fixtureId,
      bookmaker_slug: bookmaker.slug,
      market_code: "1X2",
      market_name: "MoneyLine",
      selection: selectionForCanonicalOrientation(selection, orientation),
      price: Number(odd.price),
      pa_category: pa.category,
      confidence_score: pa.confidence,
      raw_market_name: pa.category === "COM_PA" ? `${odd.marketName ?? "Resultado Final"} - SuperPlacar` : odd.marketName ?? null,
      raw_label: odd.name ?? null,
      raw_odd_type: odd.code ?? String(odd.outcomeId ?? ""),
      source_odd_id: Number(String(odd.uuid).replace(/\D/g, "").slice(0, 15)) || Number(odd.outcomeId),
      raw: { event, odd, classificationReason: pa.reason },
      updated_at: new Date().toISOString()
    });
  }

  return rows;
}

export function createSuperbetCollector(bookmaker: SuperbetBookmakerConfig) {
  return async function collectSuperbet() {
    const client = new SuperbetClient(bookmaker);
    const summary = {
      eventsSeen: 0,
      eventsInWindow: 0,
      eventsCollected: 0,
      eventsMatched: 0,
      eventsUnmatched: 0,
      oddsUpserted: 0,
      errors: 0,
      lastError: null as string | null
    };

    await ensureBaseRows(bookmaker);
    const fixtures = await getCanonicalFixtures();
    if (!fixtures.length) {
      await log(bookmaker, "warn", "no canonical fixtures; run api-football sync first");
      return summary;
    }

    try {
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0, 0);
      const maps = await client.getStructMaps();
      const events = (await client.getPrematchEvents(now, end)).map((event) => ({
        ...event,
        sourceCategoryName: maps.categories.get(Number(event.categoryId)) ?? null,
        sourceTournamentName: maps.tournaments.get(Number(event.tournamentId)) ?? null
      }));

      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: SuperbetEvent; matched: NonNullable<ReturnType<typeof matchFixture>> }>();
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      for (const event of targetEvents) {
        const matched = matchFixture(event, fixtures);
        if (!matched) {
          summary.eventsUnmatched += 1;
          continue;
        }

        const previous = bestMatchByFixtureId.get(matched.fixture.id);
        if (!previous || matched.score > previous.matched.score) {
          bestMatchByFixtureId.set(matched.fixture.id, { event, matched });
        }
      }

      for (const { event, matched } of bestMatchByFixtureId.values()) {
        linksToSave.push(buildBookmakerLink(bookmaker, matched.fixture.id, event, matched.score));
        oddsToSave.push(...buildMoneylineOdds(bookmaker, matched.fixture.id, event, matched.orientation));
        summary.eventsCollected += 1;
        summary.eventsMatched += 1;
      }

      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave, {
        cleanupFixtureIds: fixtures.map((fixture) => fixture.id)
      });
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "superbet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "superbet collection finished", summary);
    return summary;
  };
}

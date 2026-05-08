import type { SuperbetBookmakerConfig } from "../config/bookmakers.js";
import { supabase } from "../db/supabase.js";
import type { Selection } from "../domain/normalize.js";
import { nameSimilarity, normalizeName } from "../domain/text.js";
import { SuperbetClient, type SuperbetEvent, type SuperbetOdd } from "../providers/superbet.js";

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
  league:
    | {
        name: string;
        slug: string;
        api_football_league_id: number;
      }
    | Array<{
        name: string;
        slug: string;
        api_football_league_id: number;
      }>
    | null;
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
    .select("id,api_football_fixture_id,name,league:leagues(name,slug,api_football_league_id),home_team,away_team,normalized_home_team,normalized_away_team,starts_at")
    .gt("starts_at", now.toISOString())
    .lt("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as CanonicalFixture[];
}

function fixtureLeague(fixture: CanonicalFixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function compactNormalized(value: unknown) {
  return normalizeName(value).replace(/\s+/g, "");
}

function mappedLeagueMatches(bookmaker: SuperbetBookmakerConfig, event: SuperbetEvent, fixture: CanonicalFixture) {
  const league = fixtureLeague(fixture);
  const eventLeagueText = `${event.sourceCategoryName ?? ""} ${event.sourceTournamentName ?? ""}`;

  return bookmaker.leagueMappings.some(
    (mapping) => mapping.fixtureLeagueSlug === league?.slug && new RegExp(mapping.sourcePattern, "i").test(eventLeagueText)
  );
}

function leagueSimilarity(bookmaker: SuperbetBookmakerConfig, event: SuperbetEvent, fixture: CanonicalFixture) {
  if (mappedLeagueMatches(bookmaker, event, fixture)) return 1;

  const eventLeagueText = `${event.sourceCategoryName ?? ""} ${event.sourceTournamentName ?? ""}`;
  const fixtureLeagueText = fixtureLeague(fixture)?.name ?? "";
  const eventCompact = compactNormalized(eventLeagueText);
  const fixtureCompact = compactNormalized(fixtureLeagueText);

  if (!eventCompact || !fixtureCompact) return 0;
  if (eventCompact === fixtureCompact) return 1;
  if (eventCompact.includes(fixtureCompact) || fixtureCompact.includes(eventCompact)) return 0.95;

  return nameSimilarity(eventLeagueText, fixtureLeagueText);
}

function splitTeams(event: SuperbetEvent) {
  const [homeTeam, awayTeam] = String(event.matchName ?? "").split("·");
  return { homeTeam: homeTeam?.trim() || null, awayTeam: awayTeam?.trim() || null };
}

function teamPairScore(event: SuperbetEvent, fixture: CanonicalFixture) {
  const { homeTeam, awayTeam } = splitTeams(event);
  const directHome = nameSimilarity(homeTeam, fixture.normalized_home_team ?? fixture.home_team);
  const directAway = nameSimilarity(awayTeam, fixture.normalized_away_team ?? fixture.away_team);
  const swappedHome = nameSimilarity(homeTeam, fixture.away_team);
  const swappedAway = nameSimilarity(awayTeam, fixture.home_team);
  return Math.max((directHome + directAway) / 2, (swappedHome + swappedAway) / 2);
}

function matchesConfiguredLeague(bookmaker: SuperbetBookmakerConfig, event: SuperbetEvent) {
  const haystack = `${event.sourceCategoryName ?? ""} ${event.sourceTournamentName ?? ""}`;
  return (
    bookmaker.leagueMappings.some((mapping) => new RegExp(mapping.sourcePattern, "i").test(haystack)) ||
    bookmaker.leagueNamePatterns.some((pattern) => new RegExp(pattern, "i").test(haystack))
  );
}

function matchFixture(bookmaker: SuperbetBookmakerConfig, event: SuperbetEvent, fixtures: CanonicalFixture[]) {
  const eventStart = Number(event.unixDateMillis ?? Date.parse(event.utcDate ?? ""));

  const candidates: Array<{ fixture: CanonicalFixture; score: number; teamScore: number; hoursApart: number; leagueScore: number }> = [];
  for (const fixture of fixtures) {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    const hoursApart = Math.abs(fixtureStart - eventStart) / 36e5;
    if (!Number.isFinite(hoursApart) || hoursApart > 0.35) continue;

    const leagueScore = leagueSimilarity(bookmaker, event, fixture);
    if (leagueScore < 0.55) continue;

    const teamScore = teamPairScore(event, fixture);
    const timeScore = 1 - hoursApart / 0.35;
    const score = leagueScore * 0.55 + timeScore * 0.3 + teamScore * 0.15;
    candidates.push({ fixture, score, teamScore, hoursApart, leagueScore });
  }

  if (!candidates.length) return null;

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best) return null;

  if (candidates.length > 1) {
    const second = candidates[1];
    if (best.teamScore >= 0.45) return best;
    if (!second || (best.teamScore >= 0.2 && best.teamScore - second.teamScore >= 0.15)) return best;
    return null;
  }

  return best;
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

async function upsertBookmakerLink(bookmaker: SuperbetBookmakerConfig, fixtureId: string, event: SuperbetEvent, confidenceScore: number) {
  const { homeTeam, awayTeam } = splitTeams(event);
  const { error } = await supabase.from("bookmaker_event_links").upsert(
    {
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
    },
    { onConflict: "bookmaker_slug,external_event_id" }
  );

  if (error) throw error;
}

async function replaceMoneylineOdds(bookmaker: SuperbetBookmakerConfig, fixtureId: string, event: SuperbetEvent) {
  const rows = [];
  const pa = paForEvent(event);

  for (const odd of (event.odds ?? []).filter(isMoneylineOdd)) {
    const selection = selectionFromOdd(odd);
    if (!selection || Number(odd.price) <= 0) continue;

    rows.push({
      fixture_id: fixtureId,
      bookmaker_slug: bookmaker.slug,
      market_code: "1X2",
      market_name: "MoneyLine",
      selection,
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

  const uniqueRows = [...new Map(rows.map((row) => [`${row.fixture_id}:${row.bookmaker_slug}:${row.market_code}:${row.selection}:${row.pa_category}:${row.source_odd_id}`, row])).values()];

  await supabase.from("odds").delete().eq("fixture_id", fixtureId).eq("bookmaker_slug", bookmaker.slug).eq("market_code", "1X2");

  if (!uniqueRows.length) return 0;

  const { error } = await supabase.from("odds").upsert(uniqueRows, {
    onConflict: "fixture_id,bookmaker_slug,market_code,selection,pa_category,source_odd_id"
  });
  if (error) throw error;

  return uniqueRows.length;
}

export function createSuperbetCollector(bookmaker: SuperbetBookmakerConfig) {
  return async function collectSuperbet() {
    const client = new SuperbetClient(bookmaker);
    const summary = {
      eventsSeen: 0,
      eventsInConfiguredLeagues: 0,
      eventsInWindow: 0,
      eventsCollected: 0,
      eventsMatched: 0,
      eventsUnmatched: 0,
      oddsUpserted: 0,
      errors: 0
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

      const configuredEvents = events.filter(matchesConfiguredLeague.bind(null, bookmaker));
      summary.eventsInConfiguredLeagues = configuredEvents.length;

      const targetEvents = configuredEvents.filter((event) =>
        fixtures.some((fixture) => {
          const eventStart = Number(event.unixDateMillis ?? Date.parse(event.utcDate ?? ""));
          const fixtureStart = new Date(fixture.starts_at).getTime();
          return Number.isFinite(eventStart) && Math.abs(fixtureStart - eventStart) / 36e5 <= 0.35;
        })
      );
      summary.eventsInWindow = targetEvents.length;

      const bestMatchByFixtureId = new Map<string, { event: SuperbetEvent; matched: NonNullable<ReturnType<typeof matchFixture>> }>();

      for (const event of targetEvents) {
        const matched = matchFixture(bookmaker, event, fixtures);
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
        try {
          await upsertBookmakerLink(bookmaker, matched.fixture.id, event, matched.score);
          summary.oddsUpserted += await replaceMoneylineOdds(bookmaker, matched.fixture.id, event);
          summary.eventsCollected += 1;
          summary.eventsMatched += 1;
        } catch (error) {
          summary.errors += 1;
          await log(bookmaker, "error", "superbet event collection failed", { eventId: event.eventId, error: serializeError(error) });
        }
      }
    } catch (error) {
      summary.errors += 1;
      await log(bookmaker, "error", "superbet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "superbet collection finished", summary);
    return summary;
  };
}

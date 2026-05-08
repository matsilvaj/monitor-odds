import type { VaidebetBookmakerConfig } from "../config/bookmakers.js";
import { env } from "../config/env.js";
import { supabase } from "../db/supabase.js";
import type { PaCategory, Selection } from "../domain/normalize.js";
import { nameSimilarity, normalizeName } from "../domain/text.js";
import { VaidebetClient, type VaidebetFixture, type VaidebetMarket, type VaidebetOdd, type VaidebetSeason } from "../providers/vaidebet.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function collectDelayMs() {
  return env.COLLECT_DELAY_MS + Math.floor(Math.random() * (env.COLLECT_JITTER_MS + 1));
}

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

async function log(bookmaker: VaidebetBookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: VaidebetBookmakerConfig) {
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

function matchesSeason(bookmaker: VaidebetBookmakerConfig, season: VaidebetSeason) {
  const haystack = `${season.seaN ?? ""} ${season.lName ?? ""}`;
  return bookmaker.seasonNamePatterns.some((pattern) => new RegExp(pattern, "i").test(haystack));
}

function matchesEventSeason(bookmaker: VaidebetBookmakerConfig, event: VaidebetFixture) {
  const haystack = `${event.sourceSeasonName ?? ""} ${event.sourceLeagueName ?? ""}`;
  return bookmaker.seasonNamePatterns.some((pattern) => new RegExp(pattern, "i").test(haystack));
}

function compactNormalized(value: unknown) {
  return normalizeName(value).replace(/\s+/g, "");
}

function levenshtein(left: string, right: string) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }

    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
}

function fuzzyNameSimilarity(left: unknown, right: unknown) {
  const tokenScore = nameSimilarity(left, right);
  const leftCompact = compactNormalized(left);
  const rightCompact = compactNormalized(right);
  if (!leftCompact || !rightCompact) return tokenScore;

  const editScore = 1 - levenshtein(leftCompact, rightCompact) / Math.max(leftCompact.length, rightCompact.length);
  const containmentScore =
    Math.min(leftCompact.length, rightCompact.length) >= 5 && (leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact)) ? 0.9 : 0;

  return Math.max(tokenScore, editScore, containmentScore);
}

function fixtureLeague(fixture: CanonicalFixture) {
  return Array.isArray(fixture.league) ? fixture.league[0] ?? null : fixture.league;
}

function leagueSimilarity(event: VaidebetFixture, fixture: CanonicalFixture) {
  const eventLeagueText = `${event.sourceSeasonName ?? ""} ${event.sourceLeagueName ?? ""}`;
  const fixtureLeagueText = fixtureLeague(fixture)?.name ?? "";
  const eventCompact = compactNormalized(eventLeagueText);
  const fixtureCompact = compactNormalized(fixtureLeagueText);

  if (!eventCompact || !fixtureCompact) return 0;
  if (eventCompact === fixtureCompact) return 1;
  if (eventCompact.includes(fixtureCompact) || fixtureCompact.includes(eventCompact)) return 0.95;

  return nameSimilarity(eventLeagueText, fixtureLeagueText);
}

function teamPairScore(event: VaidebetFixture, fixture: CanonicalFixture) {
  const homeTeam = event.hcN ?? null;
  const awayTeam = event.acN ?? null;
  const directHome = fuzzyNameSimilarity(homeTeam, fixture.normalized_home_team ?? fixture.home_team);
  const directAway = fuzzyNameSimilarity(awayTeam, fixture.normalized_away_team ?? fixture.away_team);
  const swappedHome = fuzzyNameSimilarity(homeTeam, fixture.away_team);
  const swappedAway = fuzzyNameSimilarity(awayTeam, fixture.home_team);
  return Math.max((directHome + directAway) / 2, (swappedHome + swappedAway) / 2);
}

function matchFixture(event: VaidebetFixture, fixtures: CanonicalFixture[]) {
  const homeTeam = event.hcN ?? null;
  const awayTeam = event.acN ?? null;
  const eventStart = Number(event.fsd);

  const candidates: Array<{ fixture: CanonicalFixture; score: number; teamScore: number; hoursApart: number; leagueScore: number }> = [];
  for (const fixture of fixtures) {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    const hoursApart = Math.abs(fixtureStart - eventStart) / 36e5;
    if (!Number.isFinite(hoursApart) || hoursApart > 0.35) continue;

    const leagueScore = leagueSimilarity(event, fixture);
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
    if (best.teamScore >= 0.45) return { ...best, homeTeam, awayTeam };
    if (!second || (best.teamScore >= 0.2 && best.teamScore - second.teamScore >= 0.15)) return { ...best, homeTeam, awayTeam };
    return null;
  }

  return { ...best, homeTeam, awayTeam };
}

function isNearCanonicalFixtureWindow(event: VaidebetFixture, fixtures: CanonicalFixture[]) {
  const eventStart = Number(event.fsd);
  if (!Number.isFinite(eventStart)) return false;

  return fixtures.some((fixture) => {
    const fixtureStart = new Date(fixture.starts_at).getTime();
    return Number.isFinite(fixtureStart) && Math.abs(fixtureStart - eventStart) / 36e5 <= 12;
  });
}

function isMoneylineMarket(market: VaidebetMarket) {
  const text = `${market.btgN ?? ""} ${market.btgNO ?? ""} ${market.btgMN ?? ""} ${market.mbtgMN ?? ""} ${market.mrkp ?? ""}`;
  return (
    market.btgId === 7988 ||
    market.btgId === 115382 ||
    (/resultado/i.test(text) && /partida|h\/d\/a|1x2/i.test(text)) ||
    /1x2\s*\(\s*2up\s*\)|xup=2/i.test(text)
  );
}

function paForMarket(market: VaidebetMarket): { category: PaCategory; confidence: number; reason: string } {
  const text = `${market.btgN ?? ""} ${market.btgNO ?? ""} ${market.btgMN ?? ""} ${market.mbtgMN ?? ""} ${market.mrkp ?? ""}`;
  if (/1x2\s*\(\s*2up\s*\)|xup=2/i.test(text)) {
    return { category: "COM_PA", confidence: 0.95, reason: "vaidebet-2up-market" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "vaidebet-standard-result-market" };
}

function selectionFromOdd(odd: VaidebetOdd, homeTeam: string | null, awayTeam: string | null): Selection | null {
  const label = `${odd.pSh ?? ""} ${odd.hSh ?? ""} ${odd.oc ?? ""}`;
  if (/empate|draw/i.test(label)) return "DRAW";
  if (/home/i.test(String(odd.pSh ?? "")) || nameSimilarity(odd.hSh, homeTeam) >= 0.5 || nameSimilarity(odd.oc, homeTeam) >= 0.5) return "HOME";
  if (/away/i.test(String(odd.pSh ?? "")) || nameSimilarity(odd.hSh, awayTeam) >= 0.5 || nameSimilarity(odd.oc, awayTeam) >= 0.5) return "AWAY";
  return null;
}

function sourceUrl(bookmaker: VaidebetBookmakerConfig, event: VaidebetFixture) {
  const name = `${event.hcN ?? ""}-${event.acN ?? ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${bookmaker.baseUrl.replace(/\/$/, "")}/esportes/futebol/evento/${name}-${event.fId}`;
}

async function upsertBookmakerLink(bookmaker: VaidebetBookmakerConfig, fixtureId: string, event: VaidebetFixture, confidenceScore: number) {
  const { error } = await supabase.from("bookmaker_event_links").upsert(
    {
      bookmaker_slug: bookmaker.slug,
      external_event_id: event.fId,
      fixture_id: fixtureId,
      bookmaker_event_name: [event.hcN, event.acN].filter(Boolean).join(" vs "),
      bookmaker_home_team: event.hcN ?? null,
      bookmaker_away_team: event.acN ?? null,
      normalized_bookmaker_home_team: normalizeName(event.hcN),
      normalized_bookmaker_away_team: normalizeName(event.acN),
      starts_at: new Date(event.fsd).toISOString(),
      match_confidence_score: confidenceScore,
      source_url: sourceUrl(bookmaker, event),
      raw: event,
      updated_at: new Date().toISOString()
    },
    { onConflict: "bookmaker_slug,external_event_id" }
  );

  if (error) throw error;
}

async function replaceMoneylineOdds(bookmaker: VaidebetBookmakerConfig, fixtureId: string, event: VaidebetFixture) {
  const rows = [];

  for (const market of (event.btgs ?? []).filter(isMoneylineMarket)) {
    const pa = paForMarket(market);

    for (const odd of market.fos ?? []) {
      if (!odd.valid || odd.freeze || Number(odd.hO) <= 0) continue;

      const selection = selectionFromOdd(odd, event.hcN ?? null, event.acN ?? null);
      if (!selection) continue;

      rows.push({
        fixture_id: fixtureId,
        bookmaker_slug: bookmaker.slug,
        market_code: "1X2",
        market_name: "MoneyLine",
        selection,
        price: Number(odd.hO),
        pa_category: pa.category,
        confidence_score: pa.confidence,
        raw_market_name: market.mbtgMN ?? market.btgNO ?? market.btgN ?? null,
        raw_label: odd.hSh ?? odd.oc ?? odd.pSh ?? null,
        raw_odd_type: odd.btN ?? String(market.btgId),
        source_odd_id: odd.foId,
        raw: { event, market, odd, classificationReason: pa.reason },
        updated_at: new Date().toISOString()
      });
    }
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

export function createVaidebetCollector(bookmaker: VaidebetBookmakerConfig) {
  return async function collectVaidebet() {
    const client = new VaidebetClient(bookmaker);
    const summary = {
      seasonsSeen: 0,
      seasonsSelected: 0,
      eventsSeen: 0,
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
      let seasons: VaidebetSeason[] = [];
      try {
        seasons = await client.getFootballSeasons();
      } catch (error) {
        if (!bookmaker.fallbackLeagueCardPath) throw error;
        await log(bookmaker, "warn", "left-menu failed; using fallback league-card", { error: serializeError(error) });
      }

      const selectedSeasonIds = [...new Set(seasons.filter((season) => matchesSeason(bookmaker, season)).map((season) => season.sId))];
      summary.seasonsSeen = seasons.length;
      summary.seasonsSelected = selectedSeasonIds.length;

      await sleep(collectDelayMs());
      const events = await client.getLeagueCard(selectedSeasonIds);
      summary.eventsSeen = events.length;

      const targetEvents = events.filter((event) => event.vld !== false && event.frz !== true && matchesEventSeason(bookmaker, event) && isNearCanonicalFixtureWindow(event, fixtures));
      summary.eventsInWindow = targetEvents.length;

      for (const event of targetEvents) {
        try {
          const matched = matchFixture(event, fixtures);

          if (!matched) {
            summary.eventsUnmatched += 1;
            continue;
          }

          await upsertBookmakerLink(bookmaker, matched.fixture.id, event, matched.score);
          summary.oddsUpserted += await replaceMoneylineOdds(bookmaker, matched.fixture.id, event);
          summary.eventsCollected += 1;
          summary.eventsMatched += 1;
        } catch (error) {
          summary.errors += 1;
          await log(bookmaker, "error", "vaidebet event collection failed", { eventId: event.fId, error: serializeError(error) });
        }
      }
    } catch (error) {
      summary.errors += 1;
      await log(bookmaker, "error", "vaidebet collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "vaidebet collection finished", summary);
    return summary;
  };
}

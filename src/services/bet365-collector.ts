import { readFile } from "node:fs/promises";
import path from "node:path";
import pMap from "p-map";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import { OddsRepository, type BookmakerLinkRow, type OddRow } from "../db/odds-repository.js";
import { supabase } from "../db/supabase.js";
import { matchEvents } from "../domain/matching/event-matcher.js";
import { nameSimilarity, normalizeName } from "../domain/text.js";
import { errorMessage } from "../utils/errors.js";
import { httpClient } from "../utils/http-client.js";

const TOKEN_FILE = path.resolve(process.cwd(), "bet365-token.json");

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

type Bet365SessionToken = {
  xNetSyncTerm: string;
  cookie: string;
  capturedFrom?: string;
  capturedAt?: string;
};

export type ParsedBet365Odd = {
  id: string;
  name: string;
  oddsDecimal: number;
  rawFractional: string;
};

export type ParsedBet365Event = {
  id: string;
  name: string;
  startDate: string;
  odds: ParsedBet365Odd[];
};

function serializeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };

  try {
    return JSON.parse(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

async function log(bookmaker: Bet365BookmakerConfig, level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  await supabase.from("collection_logs").insert({
    bookmaker_slug: bookmaker.slug,
    level,
    message,
    context
  });
}

async function ensureBaseRows(bookmaker: Bet365BookmakerConfig) {
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

async function readToken(bookmaker: Bet365BookmakerConfig) {
  try {
    const raw = await readFile(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Bet365SessionToken>;
    if (!parsed.xNetSyncTerm || !parsed.cookie) {
      throw new Error("bet365-token.json missing xNetSyncTerm or cookie");
    }

    return parsed as Bet365SessionToken;
  } catch (error) {
    await log(bookmaker, "warn", "bet365 token unavailable; skipping collection", { tokenFile: TOKEN_FILE, error: serializeError(error) });
    return null;
  }
}

function buildSplashContentUrl(bookmaker: Bet365BookmakerConfig) {
  const url = new URL("splashcontentapi/soccertab", bookmaker.baseUrl);
  url.searchParams.set("lid", "33");
  url.searchParams.set("zid", "0");
  url.searchParams.set("pd", "#AS#B1#K^5#");
  url.searchParams.set("cid", "28");
  url.searchParams.set("cgid", "0");
  url.searchParams.set("ctid", "28");
  return url;
}

function buildSearchUrl(bookmaker: Bet365BookmakerConfig, query: string) {
  const url = new URL("searchapi/query", bookmaker.baseUrl);
  url.searchParams.set("lid", "33");
  url.searchParams.set("zid", "0");
  url.searchParams.set("pd", `#AX#K^${query}#`);
  url.searchParams.set("cid", "28");
  url.searchParams.set("cgid", "0");
  url.searchParams.set("ctid", "28");
  return url;
}

export function parseBet365Data(rawString: string): ParsedBet365Event[] {
  if (!rawString || typeof rawString !== "string") return [];

  const nodes = rawString.split("|");
  const events: ParsedBet365Event[] = [];
  const searchEventMeta = new Map<string, ParsedBet365Event>();
  const searchEventOdds = new Map<string, ParsedBet365Odd[]>();

  let currentEvent: ParsedBet365Event | null = null;
  let isMoneylineMarket = false;

  for (const node of nodes) {
    if (!node) continue;

    const parts = node.split(";");
    const nodeType = parts[0];

    const props: Record<string, string> = {};
    for (let i = 1; i < parts.length; i += 1) {
      const [key, ...valParts] = parts[i].split("=");
      if (key) props[key] = valParts.join("=");
    }

    if (nodeType === "EV") {
      if (currentEvent && currentEvent.odds.length > 0) {
        events.push(currentEvent);
      }

      currentEvent = {
        id: props.FI || props.OI || props.ID || "",
        name: props.EX || props.NA || [props.N2, props.N3].filter(Boolean).join(" v "),
        startDate: formatBet365Date(props.BC || props.FD || props.D || ""),
        odds: []
      };
      isMoneylineMarket = false;
    } else if (nodeType === "MG" || nodeType === "MA") {
      const marketName = props.NA || props.N2 || "";
      if (marketName) {
        isMoneylineMarket = /resultado final|full time result|match odds/i.test(marketName);
      }
    } else if (nodeType === "PA" && isMoneylineMarket && currentEvent) {
      const fractionalOdd = props.OD || "";

      if (fractionalOdd && fractionalOdd.includes("/")) {
        const [num, den] = fractionalOdd.split("/").map(Number);
        if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) continue;

        const decimalOdd = Number((num / den + 1).toFixed(2));

        currentEvent.odds.push({
          id: props.FI || props.ID || `${Date.now()}-${Math.random()}`,
          name: props.NA || "",
          oddsDecimal: decimalOdd,
          rawFractional: fractionalOdd
        });
      }
    }

    if (nodeType === "PA") {
      const pdEventId = eventIdFromPd(props.PD);
      if (pdEventId && props.NA && props.BC && !props.OD) {
        searchEventMeta.set(pdEventId, {
          id: pdEventId,
          name: props.NA,
          startDate: formatBet365Date(props.BC),
          odds: []
        });
      }

      const eventId = props.FI || props.PF || "";
      const fractionalOdd = props.OD || "";
      if (eventId && fractionalOdd.includes("/")) {
        const [num, den] = fractionalOdd.split("/").map(Number);
        if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
          const odds = searchEventOdds.get(eventId) ?? [];
          odds.push({
            id: props.ID || `${eventId}-${props.N2 || props.NA || odds.length}`,
            name: props.BS || props.NA || "",
            oddsDecimal: Number((num / den + 1).toFixed(2)),
            rawFractional: fractionalOdd
          });
          searchEventOdds.set(eventId, odds);
        }
      }
    }
  }

  if (currentEvent && currentEvent.odds.length > 0) {
    events.push(currentEvent);
  }

  for (const [eventId, odds] of searchEventOdds) {
    const meta = searchEventMeta.get(eventId);
    if (!meta || odds.length === 0) continue;
    events.push({ ...meta, odds });
  }

  return [...new Map(events.filter((event) => event.id && event.odds.length > 0).map((event) => [event.id, event])).values()];
}

function eventIdFromPd(pd: string | undefined) {
  const match = pd?.match(/#E(\d+)#/i);
  return match?.[1] ?? null;
}

function formatBet365Date(rawDate: string): string {
  if (/^\d{14}$/.test(rawDate)) {
    const year = rawDate.slice(0, 4);
    const month = rawDate.slice(4, 6);
    const day = rawDate.slice(6, 8);
    const hour = rawDate.slice(8, 10);
    const minute = rawDate.slice(10, 12);
    const second = rawDate.slice(12, 14);
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  }

  return rawDate || new Date().toISOString();
}

function eventTeams(event: ParsedBet365Event) {
  const [homeTeam, awayTeam] = event.name.split(/\s+v\s+|\s+x\s+/i);
  return {
    homeTeam: homeTeam?.trim() || null,
    awayTeam: awayTeam?.trim() || null
  };
}

function searchKeyword(fixture: CanonicalFixture) {
  return (fixture.home_team ?? fixture.away_team ?? fixture.name).replace(/\s*\([^)]*\)/g, "").split(/\s+/).slice(0, 3).join(" ");
}

async function fetchSearchEvents(bookmaker: Bet365BookmakerConfig, token: Bet365SessionToken, query: string) {
  const rawString = await httpClient<string>({
    url: buildSearchUrl(bookmaker, query),
    referer: bookmaker.referer,
    engine: "got-scraping",
    responseType: "text",
    timeoutMs: 20_000,
    maxRetries: 1,
    headers: {
      accept: "*/*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      cookie: token.cookie,
      "x-net-sync-term": token.xNetSyncTerm,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    }
  });

  return parseBet365Data(rawString);
}

function matchFixture(event: ParsedBet365Event, fixtures: CanonicalFixture[]) {
  const { homeTeam, awayTeam } = eventTeams(event);
  let best: { fixture: CanonicalFixture; score: number; homeTeam: string | null; awayTeam: string | null } | null = null;

  for (const fixture of fixtures) {
    const result = matchEvents(
      {
        id: fixture.id,
        startsAt: fixture.starts_at,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team
      },
      {
        id: event.id,
        startsAt: event.startDate,
        homeTeam,
        awayTeam
      }
    );

    if (!result.matched) continue;
    if (!best || result.score > best.score) best = { fixture, score: result.score, homeTeam, awayTeam };
  }

  return best;
}

function buildBookmakerLink(
  bookmaker: Bet365BookmakerConfig,
  fixtureId: string,
  event: ParsedBet365Event,
  matched: { score: number; homeTeam: string | null; awayTeam: string | null }
): BookmakerLinkRow {
  return {
    bookmaker_slug: bookmaker.slug,
    external_event_id: event.id,
    fixture_id: fixtureId,
    bookmaker_event_name: event.name,
    bookmaker_home_team: matched.homeTeam,
    bookmaker_away_team: matched.awayTeam,
    normalized_bookmaker_home_team: normalizeName(matched.homeTeam),
    normalized_bookmaker_away_team: normalizeName(matched.awayTeam),
    starts_at: new Date(event.startDate).toISOString(),
    match_confidence_score: matched.score,
    source_url: bookmaker.baseUrl,
    raw: event,
    updated_at: new Date().toISOString()
  };
}

function selectionFromOddName(oddName: string, homeTeam: string | null, awayTeam: string | null) {
  if (/empate|draw|^x$/i.test(oddName)) return "DRAW";
  if (nameSimilarity(oddName, homeTeam) >= 0.5) return "HOME";
  if (nameSimilarity(oddName, awayTeam) >= 0.5) return "AWAY";
  return null;
}

function buildMoneylineOdds(
  bookmaker: Bet365BookmakerConfig,
  fixtureId: string,
  event: ParsedBet365Event,
  matched: { homeTeam: string | null; awayTeam: string | null }
): OddRow[] {
  const rows: OddRow[] = [];

  for (const odd of event.odds) {
    if (Number(odd.oddsDecimal) <= 0) continue;

    const selection = selectionFromOddName(odd.name, matched.homeTeam, matched.awayTeam);
    if (!selection) continue;

    rows.push({
      fixture_id: fixtureId,
      bookmaker_slug: bookmaker.slug,
      market_code: "1X2",
      market_name: "MoneyLine",
      selection,
      price: odd.oddsDecimal,
      pa_category: "SEM_PA",
      confidence_score: 1,
      raw_market_name: "Resultado Final",
      raw_label: odd.name,
      raw_odd_type: odd.rawFractional,
      source_odd_id: odd.id,
      raw: { event, originalFractional: odd.rawFractional },
      updated_at: new Date().toISOString()
    });
  }

  return rows;
}

export function createBet365Collector(bookmaker: Bet365BookmakerConfig) {
  return async function collectBet365() {
    const summary = {
      searches: 0,
      eventsSeen: 0,
      eventsCollected: 0,
      eventsMatched: 0,
      eventsUnmatched: 0,
      oddsUpserted: 0,
      errors: 0,
      lastError: null as string | null
    };

    const token = await readToken(bookmaker);
    if (!token) return summary;

    await ensureBaseRows(bookmaker);
    const fixtures = await getCanonicalFixtures();
    if (!fixtures.length) {
      await log(bookmaker, "warn", "no canonical fixtures; run api-football sync first");
      return summary;
    }

    try {
      const bestByFixtureId = new Map<string, { fixture: CanonicalFixture; event: ParsedBet365Event; matched: NonNullable<ReturnType<typeof matchFixture>> }>();
      const linksToSave: BookmakerLinkRow[] = [];
      const oddsToSave: OddRow[] = [];

      await pMap(
        fixtures,
        async (fixture) => {
          try {
            const events = await fetchSearchEvents(bookmaker, token, searchKeyword(fixture));
            summary.searches += 1;
            summary.eventsSeen += events.length;

            for (const event of events) {
              const matched = matchFixture(event, [fixture]);
              if (!matched) continue;

              const previous = bestByFixtureId.get(fixture.id);
              if (!previous || matched.score > previous.matched.score) {
                bestByFixtureId.set(fixture.id, { fixture, event, matched });
              }
            }
          } catch (error) {
            summary.errors += 1;
            summary.lastError = errorMessage(error);
            await log(bookmaker, "error", "bet365 search failed", { fixtureId: fixture.id, fixtureName: fixture.name, error: serializeError(error) });
          }
        },
        { concurrency: 2 }
      );

      summary.eventsUnmatched = fixtures.length - bestByFixtureId.size;

      for (const { fixture, event, matched } of bestByFixtureId.values()) {
        linksToSave.push(buildBookmakerLink(bookmaker, fixture.id, event, matched));
        oddsToSave.push(...buildMoneylineOdds(bookmaker, fixture.id, event, matched));
        summary.eventsCollected += 1;
        summary.eventsMatched += 1;
      }

      summary.oddsUpserted = await OddsRepository.saveAll(bookmaker.slug, linksToSave, oddsToSave);
    } catch (error) {
      summary.errors += 1;
      summary.lastError = errorMessage(error);
      await log(bookmaker, "error", "bet365 collection failed", { error: serializeError(error) });
    }

    await log(bookmaker, "info", "bet365 collection finished", summary);
    return summary;
  };
}

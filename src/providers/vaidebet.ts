import type { VaidebetBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type VaidebetOdd = {
  foId: number | string;
  btId?: number;
  btN?: string;
  valid?: boolean;
  tvalid?: boolean;
  freeze?: boolean;
  hO?: number;
  hSh?: string;
  pSh?: string;
  oc?: string;
  sv?: string;
  [key: string]: unknown;
};

export type VaidebetMarket = {
  btgId: number | string;
  btgN?: string;
  btgNO?: string;
  btgMN?: string;
  mbtgMN?: string;
  mrkp?: string;
  prm?: boolean;
  cshOut?: boolean;
  fos?: VaidebetOdd[];
  [key: string]: unknown;
};

export type VaidebetFixture = {
  fId: number | string;
  fsd: number;
  hcN?: string;
  acN?: string;
  sourceSeasonId?: number;
  sourceSeasonName?: string;
  sourceLeagueName?: string;
  mDat?: { st?: string; sud?: number };
  vld?: boolean;
  frz?: boolean;
  btgs?: VaidebetMarket[];
  [key: string]: unknown;
};

type VaidebetDeltaOdd = {
  value?: number;
  enable?: boolean;
  status?: string;
  source_id?: string;
  last_update?: string;
  [key: string]: unknown;
};

type VaidebetDeltaEvent = {
  _id?: string;
  home_team?: string;
  away_team?: string;
  home_team_en?: string;
  away_team_en?: string;
  championship?: string;
  championship_en?: string;
  start_date?: string;
  date?: string;
  status?: string;
  is_live?: boolean;
  market_config?: {
    has_early_payout?: boolean;
    has_super_odds?: boolean;
  };
  odds?: {
    full_time?: {
      home?: VaidebetDeltaOdd;
      draw?: VaidebetDeltaOdd;
      away?: VaidebetDeltaOdd;
      [key: string]: unknown;
    };
  };
  [key: string]: unknown;
};

export type VaidebetSeason = {
  sId: number;
  seaN?: string;
  pseaN?: string;
  lName?: string;
  fs?: VaidebetFixture[];
  sns?: VaidebetSeason[];
  [key: string]: unknown;
};

type VaidebetSport = {
  stN?: string;
  cs?: Array<{
    cN?: string;
    sns?: VaidebetSeason[];
  }>;
};

function payloadPath(payload: unknown) {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function sportsFromResponse(data: unknown) {
  if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data)) return [];
  return data.data as VaidebetSport[];
}

function flattenSeasons(seasons: VaidebetSeason[]): VaidebetSeason[] {
  return seasons.flatMap((season) => [season, ...flattenSeasons(season.sns ?? [])]);
}

function seasonsFromSports(sports: VaidebetSport[]) {
  const seasons = sports.flatMap((sport) => (sport.cs ?? []).flatMap((country) => country.sns ?? []));
  return flattenSeasons(seasons);
}

function fixturesFromSports(sports: VaidebetSport[]) {
  return seasonsFromSports(sports).flatMap((season) =>
    (season.fs ?? []).map((fixture) => ({
      ...fixture,
      sourceSeasonId: season.sId,
      sourceSeasonName: [season.pseaN, season.seaN].filter(Boolean).join(" "),
      sourceLeagueName: season.lName
    }))
  );
}

function localDateParam(date: Date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function dateParamsInRange(start: Date, end: Date) {
  const dates: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const limit = new Date(end.getFullYear(), end.getMonth(), end.getDate());

  while (cursor <= limit) {
    dates.push(localDateParam(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function numericIdFromText(value: string) {
  let hash = 0n;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31n + BigInt(value.charCodeAt(index))) % 9_000_000_000_000_000n;
  }

  return hash.toString();
}

function deltaOdd(eventId: string, key: "home" | "draw" | "away", label: string, odd: VaidebetDeltaOdd | undefined): VaidebetOdd {
  return {
    foId: numericIdFromText(`${eventId}:${key}`),
    btN: key,
    pSh: key,
    hSh: label,
    oc: label,
    hO: Number(odd?.value),
    valid: odd?.enable !== false && (!odd?.status || odd.status === "ACTIVE"),
    tvalid: odd?.enable !== false,
    freeze: false,
    rawDeltaOdd: odd
  };
}

function deltaEventToFixture(event: VaidebetDeltaEvent): VaidebetFixture | null {
  if (!event._id || !event.home_team || !event.away_team) return null;

  const startsAt = new Date(event.start_date ?? event.date ?? "").getTime();
  if (!Number.isFinite(startsAt)) return null;

  const fullTime = event.odds?.full_time ?? {};
  const home = fullTime.home as VaidebetDeltaOdd | undefined;
  const draw = fullTime.draw as VaidebetDeltaOdd | undefined;
  const away = fullTime.away as VaidebetDeltaOdd | undefined;
  const prices = [home?.value, draw?.value, away?.value].map(Number);
  if (!prices.every((price) => Number.isFinite(price) && price > 0)) return null;

  const hasEarlyPayout = event.market_config?.has_early_payout === true;
  const externalEventId = numericIdFromText(event._id);

  return {
    fId: externalEventId,
    fsd: startsAt,
    hcN: event.home_team,
    acN: event.away_team,
    sourceSeasonName: event.championship ?? event.championship_en,
    sourceLeagueName: event.championship ?? event.championship_en,
    vld: event.status !== "ENDED" && event.status !== "CANCELLED",
    frz: false,
    btgs: [
      {
        btgId: hasEarlyPayout ? 115382 : 7988,
        btgN: hasEarlyPayout ? "1X2 (2Up)" : "Resultado Final",
        btgNO: hasEarlyPayout ? "1X2 - Pagamento Antecipado" : "Resultado Final",
        btgMN: hasEarlyPayout ? "1X2 - Pagamento Antecipado" : "Resultado Final",
        mbtgMN: hasEarlyPayout ? "1X2 - Pagamento Antecipado" : "Resultado Final",
        mrkp: hasEarlyPayout ? "xup=2" : "standard",
        fos: [
          deltaOdd(event._id, "home", event.home_team, home),
          deltaOdd(event._id, "draw", "Empate", draw),
          deltaOdd(event._id, "away", event.away_team, away)
        ],
        rawDeltaEvent: event
      }
    ],
    rawDeltaEvent: event
  };
}

export class VaidebetClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: VaidebetBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      bragiurl: "https://bragi.sportingtech.com/",
      customorigin: new URL(config.baseUrl).origin,
      device: "m",
      languageid: String(config.languageId),
      referer: config.referer
    };
  }

  private requestHeaders(encodedBody: string) {
    return {
      ...this.headers,
      encodedbody: encodedBody
    };
  }

  async getFootballSeasons() {
    const payload = payloadPath({ requestBody: {} });
    const path = `api-v2/left-menu/${this.config.routeSegment}/${this.config.languageId}/${this.config.brand}/${payload}`;
    const data = await httpClient<unknown>({
      url: new URL(path, this.config.baseUrl),
      headers: this.requestHeaders(payload),
      referer: this.config.referer,
      engine: this.config.engine
    });
    const sports = sportsFromResponse(data);
    return seasonsFromSports(sports.filter((sport) => sport.stN === "Futebol"));
  }

  async getLeagueCard(seasonIds: number[]) {
    if (!seasonIds.length) return [];

    const payload = payloadPath({ requestBody: { seasonIds } });
    const joinedSeasonIds = seasonIds.join("-");
    const path = `api-v2/league-card/${this.config.routeSegment}/${this.config.languageId}/${this.config.brand}/${joinedSeasonIds}/${payload}`;
    const data = await httpClient<unknown>({
      url: new URL(path, this.config.baseUrl),
      headers: this.requestHeaders(payload),
      referer: this.config.referer,
      engine: this.config.engine
    });
    const sports = sportsFromResponse(data);
    return fixturesFromSports(sports.filter((sport) => sport.stN === "Futebol"));
  }

  async getEventCard(fixtureIds: number[]) {
    if (!fixtureIds.length) return [];

    const payload = payloadPath({ requestBody: { fixtureIds } });
    const joinedFixtureIds = fixtureIds.join("-");
    const path = `api-v2/event-card/${this.config.routeSegment}/${this.config.languageId}/${this.config.brand}/${joinedFixtureIds}/${payload}`;
    const data = await httpClient<unknown>({
      url: new URL(path, this.config.baseUrl),
      headers: this.requestHeaders(payload),
      referer: this.config.referer,
      engine: this.config.engine
    });
    const sports = sportsFromResponse(data);
    return fixturesFromSports(sports.filter((sport) => sport.stN === "Futebol"));
  }

  async getDeltaSoccerEvents(start: Date, end: Date) {
    if (!this.config.deltaApiBaseUrl) return [];

    const pages = await Promise.all(
      dateParamsInRange(start, end).map((date) => {
        const eventUrl = new URL("event", this.config.deltaApiBaseUrl);
        const url = `${eventUrl.href}?type=SOCCER&date=${date}&sub_type=SOCCER`;

        return httpClient<VaidebetDeltaEvent[]>({
          url,
          headers: {
            accept: "application/json, text/plain, */*",
            "accept-language": "pt-BR,pt;q=0.9",
            "ngx-source": "DESKTOP",
            origin: "https://www.vaidebet.bet.br",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
          },
          referer: "https://www.vaidebet.bet.br/",
          engine: this.config.engine,
          timeoutMs: 15_000,
          maxRetries: 2
        });
      })
    );

    return [...new Map(pages.flat().map(deltaEventToFixture).filter((event): event is VaidebetFixture => Boolean(event)).map((event) => [event.fId, event])).values()];
  }
}

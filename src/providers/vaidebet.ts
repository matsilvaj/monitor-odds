import type { VaidebetBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type VaidebetOdd = {
  foId: number;
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
  btgId: number;
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
  fId: number;
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
}

import type { VaidebetBookmakerConfig } from "../config/bookmakers.js";

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
  lName?: string;
  fs?: VaidebetFixture[];
  [key: string]: unknown;
};

type VaidebetSport = {
  stN?: string;
  cs?: Array<{
    cN?: string;
    sns?: VaidebetSeason[];
  }>;
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] ?? USER_AGENTS[0];
}

function payloadPath(payload: unknown) {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function sportsFromResponse(data: unknown) {
  if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data)) return [];
  return data.data as VaidebetSport[];
}

function seasonsFromSports(sports: VaidebetSport[]) {
  return sports.flatMap((sport) => (sport.cs ?? []).flatMap((country) => country.sns ?? []));
}

function fixturesFromSports(sports: VaidebetSport[]) {
  return seasonsFromSports(sports).flatMap((season) =>
    (season.fs ?? []).map((fixture) => ({
      ...fixture,
      sourceSeasonId: season.sId,
      sourceSeasonName: season.seaN,
      sourceLeagueName: season.lName
    }))
  );
}

export class VaidebetClient {
  private readonly headers: HeadersInit;

  constructor(private readonly config: VaidebetBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      bragiurl: "https://bragi.sportingtech.com/",
      customorigin: new URL(config.baseUrl).origin,
      device: "m",
      languageid: String(config.languageId),
      referer: config.referer,
      "user-agent": randomUserAgent()
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
    const response = await fetch(new URL(path, this.config.baseUrl), { headers: this.requestHeaders(payload) });
    if (!response.ok) {
      throw new Error(`VaiDeBet left-menu failed: ${response.status}`);
    }

    const sports = sportsFromResponse(await response.json());
    return seasonsFromSports(sports.filter((sport) => sport.stN === "Futebol"));
  }

  async getFallbackLeagueCard() {
    if (!this.config.fallbackLeagueCardPath) return [];

    const encodedBody = this.config.fallbackLeagueCardPath.split("/").pop() ?? "";
    const response = await fetch(new URL(this.config.fallbackLeagueCardPath, this.config.baseUrl), { headers: this.requestHeaders(encodedBody) });
    if (!response.ok) {
      throw new Error(`VaiDeBet fallback league-card failed: ${response.status}`);
    }

    const sports = sportsFromResponse(await response.json());
    return fixturesFromSports(sports.filter((sport) => sport.stN === "Futebol"));
  }

  async getLeagueCard(seasonIds: number[]) {
    if (!seasonIds.length) return this.getFallbackLeagueCard();

    const payload = payloadPath({ requestBody: { seasonIds } });
    const joinedSeasonIds = seasonIds.join("-");
    const path = `api-v2/league-card/${this.config.routeSegment}/${this.config.languageId}/${this.config.brand}/${joinedSeasonIds}/${payload}`;
    const response = await fetch(new URL(path, this.config.baseUrl), { headers: this.requestHeaders(payload) });

    if (!response.ok && this.config.fallbackLeagueCardPath) return this.getFallbackLeagueCard();

    if (!response.ok) {
      throw new Error(`VaiDeBet league-card failed: ${response.status}`);
    }

    const sports = sportsFromResponse(await response.json());
    return fixturesFromSports(sports.filter((sport) => sport.stN === "Futebol"));
  }
}

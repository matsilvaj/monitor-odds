import type { BetanoBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type BetanoLeague = {
  id: string;
  name?: string;
  text?: string;
  nameLatin?: string;
  textLatin?: string;
  url: string;
  regionName?: string;
  regionCode?: string;
};

export type BetanoSelection = {
  id: string;
  name?: string;
  fullName?: string;
  shortName?: string;
  price?: number;
  handicap?: number;
  betRef?: string;
  columnIndex?: number;
};

export type BetanoMarket = {
  id?: string;
  uniqueId?: string;
  name?: string;
  type?: string;
  typeId?: number;
  handicap?: number;
  marketNotes?: string;
  selections?: BetanoSelection[];
  [key: string]: unknown;
};

export type BetanoEvent = {
  id: string;
  name?: string;
  shortName?: string;
  startTime?: number;
  url?: string;
  regionName?: string;
  leagueId?: string;
  leagueName?: string;
  leagueDescription?: string;
  markets?: BetanoMarket[];
  participants?: Array<{ id?: string; name?: string }>;
  [key: string]: unknown;
};

export type BetanoOffer = {
  offerTypeId?: number;
  text?: string;
  description?: string;
};

export type BetanoEventDetails = {
  data?: {
    event?: BetanoEvent;
    markets?: BetanoMarket[];
    marketOffersData?: {
      marketOffers?: Record<string, BetanoOffer[]>;
    };
  };
};

type SportPageResponse = {
  data?: {
    topLeagues?: BetanoLeague[];
    dropdownList?: Array<{
      id?: string;
      name?: string;
      nameLatin?: string;
      regionCode?: string;
      leagues?: BetanoLeague[];
    }>;
    blocks?: Array<{
      id?: string;
      name?: string;
      events?: BetanoEvent[];
    }>;
  };
};

const REQ = "req=s,stnf,c,mb,mbl";

export class BetanoClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: BetanoBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getFootballPage() {
    return httpClient<SportPageResponse>({
      url: new URL(`api/sport/futebol/?${REQ}`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });
  }

  async getLeaguePage(leagueUrl: string) {
    return httpClient<SportPageResponse>({
      url: new URL(`api${this.leagueApiPath(leagueUrl)}?${REQ}`, this.config.baseUrl),
      headers: this.headers,
      referer: new URL(leagueUrl, this.config.baseUrl).href,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });
  }

  async getEventDetails(event: BetanoEvent) {
    if (!event.url) throw new Error(`Betano event ${event.id} does not include url`);

    return httpClient<BetanoEventDetails>({
      url: new URL(`api${event.url.replace(/^\/?/, "/")}?${REQ}`, this.config.baseUrl),
      headers: this.headers,
      referer: new URL(event.url, this.config.baseUrl).href,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });
  }

  private leagueApiPath(leagueUrl: string) {
    const path = leagueUrl.replace(/^\/?/, "/").replace(/\/$/, "");
    const parts = path.split("/");
    const last = parts.at(-1) ?? "";

    if (/^\d+$/.test(last)) {
      parts[parts.length - 1] = `${last}r`;
    }

    return `${parts.join("/")}/`;
  }
}

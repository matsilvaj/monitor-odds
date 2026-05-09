import type { NovibetBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type NovibetSearchDocument = {
  betContextId: number;
  caption?: string;
  isLive?: boolean;
  startTimeUTC?: string;
  path?: string;
  pathLocations?: Array<{
    caption?: string;
    marketViewGroupSysname?: string;
    regionCaption?: string | null;
  }>;
  additionalCaptions?: {
    competitor1?: string;
    competitor2?: string;
  };
  competitors?: {
    homeTeam?: { teamCaption?: string };
    awayTeam?: { teamCaption?: string };
  };
  [key: string]: unknown;
};

export type NovibetBetItem = {
  id: string;
  code?: string;
  caption?: string;
  price?: number;
  oddsText?: string;
  isAvailable?: boolean;
};

export type NovibetMarket = {
  marketId?: number;
  marketSysname?: string;
  caption?: string | null;
  displayCaption?: string | null;
  betItems?: Array<NovibetBetItem | null>;
  [key: string]: unknown;
};

export type NovibetMarketTag = {
  marketId?: number;
  tag?: string;
};

export type NovibetEventDetails = {
  betContextId: number;
  caption?: string;
  path?: string;
  eventSysname?: string;
  startTimeUTC?: string;
  additionalCaptions?: {
    competitor1?: string;
    competitor2?: string;
  };
  competitors?: {
    homeTeam?: { teamCaption?: string };
    awayTeam?: { teamCaption?: string };
  };
  pathLocations?: Array<{
    caption?: string;
    marketViewGroupSysname?: string;
    regionCaption?: string | null;
  }>;
  marketTags?: NovibetMarketTag[];
  marketCategories?: unknown[];
  [key: string]: unknown;
};

type SearchResponse = Array<{
  categorySysname?: string;
  documents?: NovibetSearchDocument[];
}>;

const TIMEZONE = "E. South America Standard Time";

export class NovibetClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: NovibetBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9",
      "cache-control": "no-cache",
      "content-type": "application/json",
      origin: "https://www.novibet.bet.br",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      "x-gw-application-name": "NoviBR",
      "x-gw-channel": "WebPC",
      "x-gw-client-timezone": "America/Bahia",
      "x-gw-cms-key": "_BR",
      "x-gw-country-sysname": "BR",
      "x-gw-currency-sysname": "BRL",
      "x-gw-domain-key": "_BR",
      "x-gw-language-sysname": "pt-BR",
      "x-gw-odds-representation": "Decimal",
      "x-gw-state-sysname": ""
    };
  }

  async searchDocuments(keyword: string) {
    const params = new URLSearchParams({
      lang: "pt-BR",
      timeZ: TIMEZONE,
      oddsR: "1",
      usrGrp: "BR"
    });

    const data = await httpClient<SearchResponse>({
      url: new URL(`spt/feed/search/${this.config.contentGroupId}/documents?${params}`, this.config.baseUrl),
      method: "POST",
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      json: {
        keyword,
        rootLocationIds: [this.config.rootLocationId],
        categorySysnames: ["EVENT_HISTORY"],
        skip: 0,
        take: 10
      },
      timeoutMs: 15_000,
      maxRetries: 1
    });

    return data.flatMap((group) => (group.categorySysname === "EVENT_HISTORY" ? group.documents ?? [] : []));
  }

  async getEventDetails(eventId: number, path?: string | null) {
    const params = new URLSearchParams({
      lang: "pt-BR",
      timeZ: TIMEZONE,
      oddsR: "1",
      usrGrp: "BR",
      filterAlias: ""
    });

    return httpClient<NovibetEventDetails>({
      url: new URL(`spt/feed/marketviews/event/${this.config.contentGroupId}/${eventId}?${params}`, this.config.baseUrl),
      headers: this.headers,
      referer: path ? `${this.config.baseUrl.replace(/\/$/, "")}/apostas-esportivas/${path}/e${eventId}` : this.config.referer,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });
  }
}

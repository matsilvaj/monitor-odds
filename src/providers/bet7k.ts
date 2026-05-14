import type { Bet7kBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type Bet7kParticipant = {
  _id?: string;
  Name?: string;
  VenueRole?: "Home" | "Away" | string;
  Country?: string;
  [key: string]: unknown;
};

export type Bet7kEvent = {
  _id: string;
  BetslipLine?: string;
  EventName?: string;
  IsLive?: boolean;
  IsSuspended?: boolean;
  LeagueId?: string;
  LeagueName?: string;
  Participants?: Bet7kParticipant[];
  RegionName?: string;
  Settings?: {
    EarlyPayout?: number | string | boolean;
    [key: string]: unknown;
  };
  SportId?: string;
  StartEventDate?: string;
  UrlEventName?: string;
  UrlLeagueName?: string;
  UrlSportName?: string;
  [key: string]: unknown;
};

export type Bet7kFeaturedEvent = {
  id?: string;
  type?: number;
  event?: Bet7kEvent;
  [key: string]: unknown;
};

export type Bet7kSelection = {
  _id: string;
  Name?: string;
  OutcomeType?: string;
  Side?: number;
  IsDisabled?: boolean;
  DisplayOdds?: {
    Decimal?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type Bet7kMarket = {
  _id: string;
  EventId?: string;
  IsLive?: boolean;
  IsRemoved?: boolean;
  IsSuspended?: boolean;
  MarketType?: {
    _id?: string;
    Name?: string;
    LineTypeName?: string;
    [key: string]: unknown;
  };
  Name?: string;
  Selections?: Bet7kSelection[];
  [key: string]: unknown;
};

export type Bet7kFeaturedMarkets = {
  id?: string;
  markets?: Bet7kMarket[];
  [key: string]: unknown;
};

const MARKET_TYPES = "ML587,ML0,OU0,HC0,ML39,OU39,HC39";
const MARKET_TYPES_BY_SPORTS = JSON.stringify({
  "1": ["ML0", "OU200", "ML39", "OU249", "QA158", "ML169", "OU1697", "QA1693", "ML1633", "OU1633", "ML167"],
  "6": ["ML0", "OU0", "HC0", "ML39", "OU39", "HC39", "ML716", "ML717", "ML718", "ML719", "ML720"],
  "59": ["ML587", "ML0", "OU0", "HC0", "ML39", "OU39", "HC39"],
  default: ["ML0", "OU0", "HC0", "ML39", "OU39", "HC39", "OU6001"]
});

export class Bet7kClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: Bet7kBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getFeaturedEvents() {
    const url = new URL("api/sportscenter/carousels/featured-matches/events", this.config.apiBaseUrl);
    url.searchParams.set("language", "BR-PT");
    url.searchParams.set("customerLevel", "0");
    url.searchParams.set("draft", "false");
    url.searchParams.set("epoEnabled", "true");

    const data = await httpClient<Bet7kFeaturedEvent[]>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 25_000,
      maxRetries: 1
    });

    return data.map((item) => item.event).filter((event): event is Bet7kEvent => Boolean(event?._id));
  }

  async getFeaturedMarkets() {
    const url = new URL("api/sportscenter/carousels/featured-matches/markets", this.config.apiBaseUrl);
    url.searchParams.set("language", "BR-PT");
    url.searchParams.set("customerLevel", "0");
    url.searchParams.set("selectedOptionId", "0");
    url.searchParams.set("marketTypes", MARKET_TYPES);
    url.searchParams.set("marketTypesBySports", MARKET_TYPES_BY_SPORTS);
    url.searchParams.set("minimumOddsRestrictedMarkets", "ML39,ML13,ML1,ML169");
    url.searchParams.set("minimumOdds", "1.009");
    url.searchParams.set("draft", "false");

    return httpClient<Bet7kFeaturedMarkets[]>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 25_000,
      maxRetries: 1
    });
  }
}

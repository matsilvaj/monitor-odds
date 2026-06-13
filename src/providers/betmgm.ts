import type { BetmgmBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type BetmgmGroup = {
  id: number;
  name: string;
  eventCount?: number;
  parentId?: number;
  groups?: BetmgmGroup[];
  hasSubGroups?: boolean;
};

export type BetmgmParticipant = {
  id?: number;
  name?: string;
  position?: "HOME" | "AWAY" | string;
  abbreviation?: string;
  [key: string]: unknown;
};

export type BetmgmOutcome = {
  id?: string;
  name?: string;
  odds?: number | string;
  formatDecimal?: string;
  status?: string;
  [key: string]: unknown;
};

export type BetmgmMarket = {
  id?: string;
  type?: string;
  name?: string;
  betMarketStatus?: string;
  metadata?: Record<string, unknown>;
  outcomes?: BetmgmOutcome[];
  [key: string]: unknown;
};

export type BetmgmEvent = {
  id: number;
  name?: string;
  eventName?: string | null;
  leagueName?: string;
  sportType?: string;
  eventType?: string;
  matchState?: string;
  startTime?: string;
  participants?: BetmgmParticipant[];
  markets?: BetmgmMarket[];
  groupMappings?: Record<string, unknown>;
  eventMetadata?: Record<string, unknown>;
  [key: string]: unknown;
};

type GroupsResponse = {
  data?: BetmgmGroup[];
};

type EventsResponse = {
  data?: BetmgmEvent[];
};

const BETMGM_MARKET_TYPES = [
  "standard",
  "standard-ot",
  "standard-3-way",
  "standard-3-way-early-payout",
  "overtime-3-way",
  "match-odds"
].join(",");

export class BetmgmClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: BetmgmBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getGroups() {
    const url = new URL("program/v1/api/groups", this.config.apiBaseUrl);
    url.searchParams.set("matchState", "PREMATCH,ONGOING");
    url.searchParams.set("marketStatus", "OPEN");
    url.searchParams.set("marketTypes", BETMGM_MARKET_TYPES);
    url.searchParams.set("startTimeOffsetFrom", "-86400000");
    url.searchParams.set("openMarketsOnly", "true");
    url.searchParams.set("lang", "pt");
    url.searchParams.set("brand", "betmgm");
    url.searchParams.set("location", "BR");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("fields", "SUBGROUPS");

    const data = await httpClient<GroupsResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 20_000,
      maxRetries: 1
    });

    return data.data ?? [];
  }

  async getEventsByGroupIds(groupIds: number[]) {
    if (!groupIds.length) return [];

    const url = new URL("program/v1/api/events", this.config.apiBaseUrl);
    url.searchParams.set("groupIds", groupIds.join(","));
    url.searchParams.set("matchState", "PREMATCH,ONGOING");
    url.searchParams.set("startTimeOffsetFrom", "-86400000");
    url.searchParams.set("marketStatus", "OPEN");
    url.searchParams.set("marketTypes", BETMGM_MARKET_TYPES);
    url.searchParams.set("openMarketsOnly", "true");
    url.searchParams.set("lang", "pt");
    url.searchParams.set("brand", "betmgm");
    url.searchParams.set("location", "BR");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("fields", "GROUPS,BETMARKETS");

    const data = await httpClient<EventsResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 25_000,
      maxRetries: 1
    });

    return data.data ?? [];
  }

  async getEventsByIds(eventIds: number[]) {
    if (!eventIds.length) return [];

    const url = new URL("program/v1/api/events", this.config.apiBaseUrl);
    url.searchParams.set("ids", eventIds.join(","));
    url.searchParams.set("marketTypes", BETMGM_MARKET_TYPES);
    url.searchParams.set("marketStatus", "OPEN");
    url.searchParams.set("openMarketsOnly", "true");
    url.searchParams.set("lang", "pt");
    url.searchParams.set("brand", "betmgm");
    url.searchParams.set("location", "BR");
    url.searchParams.set("fields", "GROUPS,BETMARKETS");

    const data = await httpClient<EventsResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 25_000,
      maxRetries: 1
    });

    return data.data ?? [];
  }
}

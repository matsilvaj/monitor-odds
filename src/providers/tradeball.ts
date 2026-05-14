import type { TradeballBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type TradeballPrice = {
  odds?: number;
  "decimal-odds"?: number;
  side?: string;
  currency?: string;
  "available-amount"?: number;
  [key: string]: unknown;
};

export type TradeballRunner = {
  id: string;
  name: string;
  status?: string;
  withdrawn?: boolean;
  prices?: TradeballPrice[];
  "event-participant-id"?: string;
  [key: string]: unknown;
};

export type TradeballMarket = {
  id: string;
  name: string;
  live?: boolean;
  status?: string;
  runners?: TradeballRunner[];
  "market-type"?: string;
  "name-original"?: string;
  [key: string]: unknown;
};

export type TradeballParticipant = {
  id?: string;
  number?: string;
  "participant-name"?: string;
  "participant-name-original"?: string;
};

export type TradeballMetaTag = {
  name?: string;
  type?: string;
  "url-name"?: string;
};

export type TradeballEvent = {
  id: string;
  name: string;
  start: string;
  status?: string;
  markets?: TradeballMarket[];
  "event-participants"?: TradeballParticipant[];
  "in-running-flag"?: boolean;
  "sport-id"?: string;
  "meta-tags"?: TradeballMetaTag[];
  [key: string]: unknown;
};

type TradeballEventsResponse = {
  offset?: number;
  total?: number;
  events?: TradeballEvent[];
  lastUpdated?: string;
};

export class TradeballClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: TradeballBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getSoccerMoneylineEvents(start: Date, end: Date) {
    const events: TradeballEvent[] = [];

    for (let page = 0; page < this.config.maxPages; page += 1) {
      const offset = page * this.config.perPage;
      const data = await this.getSoccerMoneylinePage(start, end, offset);
      const pageEvents = data.events ?? [];
      events.push(...pageEvents);

      if (pageEvents.length < this.config.perPage) break;
    }

    return [...new Map(events.map((event) => [event.id, event])).values()];
  }

  private async getSoccerMoneylinePage(start: Date, end: Date, offset: number) {
    const url = new URL("api/events", this.config.apiBaseUrl);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("per-page", String(this.config.perPage));
    url.searchParams.set("after", String(Math.floor(start.getTime() / 1000)));
    url.searchParams.set("before", String(Math.floor(end.getTime() / 1000)));
    url.searchParams.set("sort-by", "volume");
    url.searchParams.set("sort-direction", "desc");
    url.searchParams.set("sport-ids", this.config.sportId);
    url.searchParams.set("market-types", "one_x_two");
    url.searchParams.set("en-market-names", "Match Odds,Moneyline,Winner");
    url.searchParams.set("markets-limit", "30");

    return httpClient<TradeballEventsResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });
  }
}

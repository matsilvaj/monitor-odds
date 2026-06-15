import type { BetnacionalBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type BetnacionalOdd = {
  id: string;
  sport_id?: number;
  category_id?: number;
  category_name?: string;
  event_id: number;
  event_status_id?: number;
  tournament_id?: number;
  tournament_name?: string;
  home?: string;
  away?: string;
  date_start?: string;
  date_start_original?: string;
  market_id?: number;
  market_status_id?: number;
  odd?: number | string;
  outcome_id?: string;
  outcome_name?: string;
  outcome_code?: string;
  market_name?: string;
  market_code?: string;
  specifier?: string;
  specifier_value?: string;
  is_live?: number;
  selection_market_id?: number;
  season_id?: number;
  updated_at?: string;
  updated_at_ts?: number;
  [key: string]: unknown;
};

type EventsBySeasonsResponse = {
  odds?: BetnacionalOdd[];
};

export type BetnacionalSearchEvent = {
  home?: string;
  away?: string;
  tournament_id?: number;
  tournament_name?: string;
  sport_id?: number;
  sport_name?: string;
  season_id?: number;
  category_id?: number;
  category_name?: string;
  event_id?: number;
  date_start?: string;
  event_status_id?: number;
  [key: string]: unknown;
};

type SearchResponse = {
  results?: Array<{
    source?: string;
    score?: number;
    data?: BetnacionalSearchEvent;
  }>;
};

type EventOddsResponse = {
  events?: Array<{
    id?: number;
    event_id?: number;
    home?: string;
    away?: string;
    date_start?: string;
    category_id?: number;
    category_name?: string;
    tournament_id?: number;
    tournament_name?: string;
    event_status_id?: number;
    [key: string]: unknown;
  }>;
  odds?: BetnacionalOdd[];
};

export class BetnacionalClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: BetnacionalBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getMoneylineOdds() {
    const filters = ["", "2", "3"];
    const pages = await Promise.all(filters.map((filter) => this.getMoneylineOddsByTimeFilter(filter)));
    const odds = pages.flat();
    return [...new Map(odds.map((odd) => [odd.id, odd])).values()];
  }

  private async getMoneylineOddsByTimeFilter(filterTimeEvent: string) {
    const url = new URL("api/odds/1/events-by-seasons", this.config.apiBaseUrl);
    url.searchParams.set("sport_id", "1");
    url.searchParams.set("category_id", "0");
    url.searchParams.set("tournament_id", "");
    url.searchParams.set("markets", "1");
    url.searchParams.set("filter_time_event", filterTimeEvent);
    url.searchParams.set("provider", "ramp");

    const data = await httpClient<EventsBySeasonsResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 20_000,
      maxRetries: 1
    });

    return data.odds ?? [];
  }

  async searchEvents(query: string) {
    const url = new URL("api/v1/search", this.config.searchBaseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("source", "sports");
    url.searchParams.set("provider", "ramp");

    const data = await httpClient<SearchResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("HTTP 404 ")) {
        return {} as SearchResponse;
      }

      throw error;
    });

    return (data.results ?? []).map((result) => result.data).filter((event): event is BetnacionalSearchEvent => event?.sport_id === 1 && event.event_status_id === 0);
  }

  async getEventMoneylineOdds(eventId: number) {
    const url = new URL(`api/event-odds/${eventId}/grouped`, this.config.apiBaseUrl);
    url.searchParams.set("languageId", "1");
    url.searchParams.set("marketIds", "");
    url.searchParams.set("outcomeIds", "");
    url.searchParams.set("statusId", "0");
    url.searchParams.set("provider", "ramp");

    return httpClient<EventOddsResponse>({
      url,
      headers: this.headers,
      referer: new URL(`event/1/0/${eventId}`, this.config.baseUrl).href,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });
  }
}

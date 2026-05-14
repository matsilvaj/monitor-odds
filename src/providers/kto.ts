import type { KtoBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type KtoEvent = {
  id: number;
  name?: string;
  englishName?: string;
  homeName?: string;
  awayName?: string;
  start?: string;
  group?: string;
  groupId?: number;
  path?: Array<{
    id?: number;
    name?: string;
    englishName?: string;
    termKey?: string;
  }>;
  sport?: string;
  state?: string;
  tags?: string[];
  [key: string]: unknown;
};

export type KtoOutcome = {
  id: number;
  label?: string;
  englishLabel?: string;
  odds?: number;
  participant?: string;
  type?: string;
  status?: string;
  [key: string]: unknown;
};

export type KtoBetOffer = {
  id: number;
  criterion?: {
    id?: number;
    label?: string;
    englishLabel?: string;
    lifetime?: string;
    occurrenceType?: string;
    [key: string]: unknown;
  };
  betOfferType?: {
    id?: number;
    name?: string;
    englishName?: string;
    [key: string]: unknown;
  };
  eventId?: number;
  outcomes?: KtoOutcome[];
  tags?: string[];
  [key: string]: unknown;
};

export type KtoListEvent = {
  event?: KtoEvent;
  betOffers?: KtoBetOffer[];
  [key: string]: unknown;
};

type KtoListResponse = {
  events?: KtoListEvent[];
};

type KtoBetOfferResponse = {
  events?: KtoEvent[];
  betOffers?: KtoBetOffer[];
};

export class KtoClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: KtoBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getFootballMatches() {
    const url = new URL("listView/football/all/all/all/matches.json", this.config.apiBaseUrl);
    url.searchParams.set("channel_id", "1");
    url.searchParams.set("client_id", "200");
    url.searchParams.set("lang", "pt_BR");
    url.searchParams.set("market", "BR");
    url.searchParams.set("useCombined", "true");
    url.searchParams.set("useCombinedLive", "true");

    const data = await httpClient<KtoListResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 30_000,
      maxRetries: 1
    });

    return data.events ?? [];
  }

  async getEventBetOffers(eventIds: number[]) {
    if (!eventIds.length) return { events: [], betOffers: [] } satisfies Required<KtoBetOfferResponse>;

    const url = new URL(`betoffer/event/${eventIds.join(",")}`, this.config.apiBaseUrl);
    url.searchParams.set("lang", "pt_BR");
    url.searchParams.set("market", "BR");
    url.searchParams.set("includeParticipants", "false");
    url.searchParams.set("onlyMain", "false");

    const data = await httpClient<KtoBetOfferResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 30_000,
      maxRetries: 1
    });

    return { events: data.events ?? [], betOffers: data.betOffers ?? [] };
  }
}

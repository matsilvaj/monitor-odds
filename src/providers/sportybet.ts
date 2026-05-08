import type { SportybetBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type SportybetOutcome = {
  id: string;
  odds: string;
  isActive?: number;
  desc?: string;
  [key: string]: unknown;
};

export type SportybetMarket = {
  id: string;
  desc?: string;
  name?: string;
  status?: number;
  outcomes?: SportybetOutcome[];
  marketGuide?: string;
  [key: string]: unknown;
};

export type SportybetEvent = {
  eventId: string;
  gameId?: string;
  estimateStartTime: number;
  status?: number;
  matchStatus?: string;
  homeTeamName?: string;
  awayTeamName?: string;
  markets?: SportybetMarket[];
  [key: string]: unknown;
};

export class SportybetClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: SportybetBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      referer: config.referer
    };
  }

  async getUpcomingEventsPage(pageNum: number) {
    const params = new URLSearchParams({
      sportId: "sr:sport:1",
      marketId: "1,60100",
      pageSize: String(this.config.pageSize),
      pageNum: String(pageNum),
      option: "1",
      _t: String(Date.now())
    });

    const data = await httpClient<{ bizCode?: number; data?: { totalNum?: number; tournaments?: Array<{ events?: SportybetEvent[] }> } }>({
      url: new URL(`api/int/factsCenter/pcUpcomingEvents?${params}`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine
    });
    if (data.bizCode !== 10000) {
      throw new Error(`SportyBet unexpected response: ${data.bizCode ?? "unknown"}`);
    }

    return {
      totalNum: data.data?.totalNum ?? 0,
      events: (data.data?.tournaments ?? []).flatMap((tournament) => tournament.events ?? [])
    };
  }
}

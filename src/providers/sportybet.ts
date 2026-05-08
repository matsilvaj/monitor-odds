import type { SportybetBookmakerConfig } from "../config/bookmakers.js";

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

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] ?? USER_AGENTS[0];
}

export class SportybetClient {
  private readonly headers: HeadersInit;

  constructor(private readonly config: SportybetBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      referer: config.referer,
      "user-agent": randomUserAgent()
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

    const response = await fetch(new URL(`api/int/factsCenter/pcUpcomingEvents?${params}`, this.config.baseUrl), { headers: this.headers });
    if (!response.ok) {
      throw new Error(`SportyBet upcoming events failed: ${response.status}`);
    }

    const data = (await response.json()) as { bizCode?: number; data?: { totalNum?: number; tournaments?: Array<{ events?: SportybetEvent[] }> } };
    if (data.bizCode !== 10000) {
      throw new Error(`SportyBet unexpected response: ${data.bizCode ?? "unknown"}`);
    }

    return {
      totalNum: data.data?.totalNum ?? 0,
      events: (data.data?.tournaments ?? []).flatMap((tournament) => tournament.events ?? [])
    };
  }
}

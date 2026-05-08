import type { SportingbetBookmakerConfig } from "../config/bookmakers.js";

export type SportingbetOption = {
  id: number;
  name?: { value?: string };
  status?: string;
  price?: { odds?: number };
  parameters?: {
    optionTypes?: string[];
    fixtureParticipant?: number;
  };
  [key: string]: unknown;
};

export type SportingbetMarket = {
  id: number;
  name?: { value?: string };
  status?: string;
  options?: SportingbetOption[];
  parameters?: Array<{ key: string; value: string }>;
  isMain?: boolean;
  [key: string]: unknown;
};

export type SportingbetFixture = {
  id: string;
  sourceId?: number;
  name?: { value?: string };
  stage?: string;
  startDate: string;
  participants?: Array<{
    id: number;
    name?: { value?: string };
    properties?: { type?: string };
  }>;
  optionMarkets?: SportingbetMarket[];
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

export class SportingbetClient {
  private readonly headers: HeadersInit;

  constructor(private readonly config: SportingbetBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      referer: config.referer,
      "user-agent": randomUserAgent()
    };
  }

  async getFixtures() {
    const params = new URLSearchParams({
      "x-bwin-accessid": this.config.accessId,
      lang: "pt-br",
      country: "BR",
      userCountry: "BR",
      fixtureTypes: "Standard",
      state: "Latest",
      offerMapping: "Filtered",
      offerCategories: "Gridable",
      fixtureCategories: "Gridable,NonGridable,Other",
      sportIds: "4",
      isPriceBoost: "false",
      statisticsModes: "None",
      skip: "0",
      take: String(this.config.take),
      sortBy: "Tags"
    });

    const response = await fetch(new URL(`cds-api/bettingoffer/fixtures?${params}`, this.config.baseUrl), { headers: this.headers });
    if (!response.ok) {
      throw new Error(`Sportingbet fixtures failed: ${response.status}`);
    }

    const data = (await response.json()) as { fixtures?: SportingbetFixture[] };
    return Array.isArray(data.fixtures) ? data.fixtures : [];
  }
}

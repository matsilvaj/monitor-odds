export type AltenarEvent = {
  id: number;
  name: string;
  startDate: string;
  status?: number;
  champId?: number;
  competitorIds?: number[];
  [key: string]: unknown;
};

export type AltenarMarket = {
  id: number;
  name: string;
  shortName?: string;
  typeId?: number;
  desktopOddIds?: number[][];
  mobileOddIds?: number[][];
  offers?: unknown;
  isMB?: boolean;
  [key: string]: unknown;
};

export type AltenarOdd = {
  id: number;
  name: string;
  price: number;
  typeId?: number;
  oddStatus?: number;
  offers?: unknown;
  competitorId?: number;
  [key: string]: unknown;
};

export type AltenarEventDetails = {
  id: number;
  name: string;
  startDate: string;
  sport?: { id?: number; name?: string };
  champ?: { id?: number; name?: string };
  category?: { id?: number; name?: string };
  competitors?: Array<{ id?: number; name?: string }>;
  markets?: AltenarMarket[];
  childMarkets?: AltenarMarket[];
  odds?: AltenarOdd[];
  [key: string]: unknown;
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] ?? USER_AGENTS[0];
}

export type AltenarClientConfig = {
  baseUrl: string;
  integration: string;
  origin: string;
  referer: string;
};

export class AltenarClient {
  private readonly headers: HeadersInit;

  constructor(private readonly config: AltenarClientConfig) {
    this.headers = {
      accept: "application/json",
      origin: config.origin,
      referer: config.referer,
      "user-agent": randomUserAgent()
    };
  }

  async getEvents(champId: number) {
    const params = new URLSearchParams({
      culture: "pt-BR",
      timezoneOffset: "180",
      integration: this.config.integration,
      deviceType: "2",
      numFormat: "en-GB",
      countryCode: "BR",
      eventCount: "0",
      sportId: "0",
      champIds: String(champId)
    });

    const response = await fetch(new URL(`widget/GetEvents?${params}`, this.config.baseUrl), { headers: this.headers });
    if (!response.ok) {
      throw new Error(`Altenar GetEvents failed: ${response.status}`);
    }

    const data = (await response.json()) as { events?: AltenarEvent[] };
    return Array.isArray(data.events) ? data.events : [];
  }

  async getEventDetails(eventId: number) {
    const params = new URLSearchParams({
      culture: "pt-BR",
      timezoneOffset: "180",
      integration: this.config.integration,
      deviceType: "1",
      numFormat: "en-GB",
      countryCode: "BR",
      eventId: String(eventId),
      showNonBoosts: "false"
    });

    const response = await fetch(new URL(`widget/GetEventDetails?${params}`, this.config.baseUrl), { headers: this.headers });
    if (!response.ok) {
      throw new Error(`Altenar GetEventDetails failed: ${response.status}`);
    }

    return (await response.json()) as AltenarEventDetails;
  }
}

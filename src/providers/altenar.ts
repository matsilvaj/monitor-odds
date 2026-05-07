import { env } from "../config/env.js";

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

const defaultHeaders = {
  accept: "application/json",
  origin: "https://esportiva.bet.br",
  referer: "https://esportiva.bet.br/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
};

export class AltenarClient {
  constructor(
    private readonly baseUrl = env.ALTENAR_BASE_URL,
    private readonly integration = env.ALTENAR_INTEGRATION
  ) {}

  async getEvents(champId: number) {
    const params = new URLSearchParams({
      culture: "pt-BR",
      timezoneOffset: "180",
      integration: this.integration,
      deviceType: "2",
      numFormat: "en-GB",
      countryCode: "BR",
      eventCount: "0",
      sportId: "0",
      champIds: String(champId)
    });

    const response = await fetch(new URL(`widget/GetEvents?${params}`, this.baseUrl), { headers: defaultHeaders });
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
      integration: this.integration,
      deviceType: "1",
      numFormat: "en-GB",
      countryCode: "BR",
      eventId: String(eventId),
      showNonBoosts: "false"
    });

    const response = await fetch(new URL(`widget/GetEventDetails?${params}`, this.baseUrl), { headers: defaultHeaders });
    if (!response.ok) {
      throw new Error(`Altenar GetEventDetails failed: ${response.status}`);
    }

    return (await response.json()) as AltenarEventDetails;
  }
}

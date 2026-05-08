import type { SuperbetBookmakerConfig } from "../config/bookmakers.js";

export type SuperbetOdd = {
  uuid: string;
  marketUuid?: string;
  marketId?: number;
  outcomeId?: number;
  price?: number;
  status?: string;
  tags?: string;
  code?: string;
  name?: string;
  marketName?: string;
  info?: string;
  [key: string]: unknown;
};

export type SuperbetEvent = {
  eventId: number;
  sportId?: number;
  categoryId?: number;
  tournamentId?: number;
  matchName?: string;
  utcDate?: string;
  unixDateMillis?: number;
  odds?: SuperbetOdd[] | null;
  sourceCategoryName?: string | null;
  sourceTournamentName?: string | null;
  [key: string]: unknown;
};

type SuperbetStructItem = {
  id: string | number;
  localNames?: Record<string, string>;
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

function formatDateParam(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}+${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00`;
}

function nameMap(items: SuperbetStructItem[] | undefined, language: string) {
  return new Map((items ?? []).map((item) => [Number(item.id), item.localNames?.[language] ?? null]));
}

export class SuperbetClient {
  private readonly headers: HeadersInit;

  constructor(private readonly config: SuperbetBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      referer: config.referer,
      "user-agent": randomUserAgent()
    };
  }

  async getStructMaps() {
    const response = await fetch(new URL(`v2/${this.config.language}/struct`, this.config.baseUrl), { headers: this.headers });
    if (!response.ok) throw new Error(`Superbet struct failed: ${response.status}`);

    const payload = (await response.json()) as {
      data?: {
        categories?: SuperbetStructItem[];
        tournaments?: SuperbetStructItem[];
      };
    };

    return {
      categories: nameMap(payload.data?.categories, this.config.language),
      tournaments: nameMap(payload.data?.tournaments, this.config.language)
    };
  }

  async getPrematchEvents(start: Date, end: Date) {
    const query = [
      "currentStatus=active",
      "offerState=prematch",
      `startDate=${formatDateParam(start)}`,
      `endDate=${formatDateParam(end)}`,
      `sportId=${this.config.sportId}`
    ].join("&");

    const response = await fetch(new URL(`v2/${this.config.language}/events/by-date?${query}`, this.config.baseUrl), { headers: this.headers });
    if (!response.ok) throw new Error(`Superbet events by date failed: ${response.status}`);

    const payload = (await response.json()) as { data?: SuperbetEvent[] };
    return Array.isArray(payload.data) ? payload.data : [];
  }
}

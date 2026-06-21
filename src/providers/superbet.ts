import type { SuperbetBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

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

function formatDateParam(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}+${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00`;
}

function nameMap(items: SuperbetStructItem[] | undefined, language: string) {
  return new Map((items ?? []).map((item) => [Number(item.id), item.localNames?.[language] ?? null]));
}

export class SuperbetClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: SuperbetBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      referer: config.referer
    };
  }

  async getStructMaps() {
    const payload = await httpClient<{
      data?: {
        categories?: SuperbetStructItem[];
        tournaments?: SuperbetStructItem[];
      };
    }>({
      url: new URL(`v2/${this.config.language}/struct`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 15000,
      maxRetries: 2
    });

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

    const payload = await httpClient<{ data?: SuperbetEvent[] }>({
      url: new URL(`v2/${this.config.language}/events/by-date?${query}`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 20000,
      maxRetries: 2
    });
    return Array.isArray(payload.data) ? payload.data : [];
  }
}

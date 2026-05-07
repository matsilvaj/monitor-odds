import { env } from "../config/env.js";

export type ApiFootballFixtureRow = {
  fixture: {
    id: number;
    date: string;
    timestamp?: number;
    status?: {
      long?: string;
      short?: string;
      elapsed?: number | null;
    };
  };
  league: {
    id: number;
    name: string;
    country?: string;
    season?: number;
    round?: string;
  };
  teams: {
    home: { id: number; name: string; logo?: string | null };
    away: { id: number; name: string; logo?: string | null };
  };
  goals?: {
    home?: number | null;
    away?: number | null;
  };
};

type ApiFootballResponse<T> = {
  response?: T;
  errors?: unknown;
};

export class ApiFootballClient {
  constructor(
    private readonly baseUrl = env.API_FOOTBALL_BASE_URL,
    private readonly apiKey = env.API_FOOTBALL_KEY
  ) {}

  async getFixturesByDate(date: string) {
    const params = new URLSearchParams({
      date,
      timezone: env.API_FOOTBALL_TIMEZONE
    });

    const response = await fetch(new URL(`fixtures?${params}`, this.baseUrl), {
      headers: {
        accept: "application/json",
        "x-apisports-key": this.apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`API-Football fixtures failed: ${response.status}`);
    }

    const data = (await response.json()) as ApiFootballResponse<ApiFootballFixtureRow[]>;
    if (data.errors && JSON.stringify(data.errors) !== "[]") {
      throw new Error(`API-Football returned errors: ${JSON.stringify(data.errors)}`);
    }

    return Array.isArray(data.response) ? data.response : [];
  }
}

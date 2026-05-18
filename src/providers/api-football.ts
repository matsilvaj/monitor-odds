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
    logo?: string | null;
    flag?: string | null;
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

export type ApiFootballLeagueCatalogRow = {
  league: {
    id: number;
    name: string;
    type?: string | null;
    logo?: string | null;
  };
  country?: {
    name?: string | null;
    code?: string | null;
    flag?: string | null;
  };
  seasons?: Array<{
    year?: number | null;
    current?: boolean | null;
    coverage?: unknown;
  }>;
};

type ApiFootballResponse<T> = {
  response?: T;
  errors?: unknown;
};

export class ApiFootballHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string
  ) {
    super(message);
    this.name = "ApiFootballHttpError";
  }
}

export class ApiFootballClient {
  constructor(
    private readonly baseUrl = env.API_FOOTBALL_BASE_URL,
    private readonly apiKey = env.API_FOOTBALL_KEY,
    private readonly timeoutMs = 15_000
  ) {}

  async getFixturesByDate(date: string) {
    const params = new URLSearchParams({
      date,
      timezone: env.API_FOOTBALL_TIMEZONE
    });

    const url = new URL(`fixtures?${params}`, this.baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/json",
          "x-apisports-key": this.apiKey
        },
        signal: controller.signal
      });
    } catch (error) {
      throw new ApiFootballHttpError(error instanceof Error ? error.message : "API-Football request failed", undefined, url.href);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new ApiFootballHttpError(`API-Football request failed with status ${response.status}`, response.status, url.href);
    }

    const data = (await response.json()) as ApiFootballResponse<ApiFootballFixtureRow[]>;

    if (data.errors && JSON.stringify(data.errors) !== "[]") {
      throw new Error(`API-Football returned errors: ${JSON.stringify(data.errors)}`);
    }

    return Array.isArray(data.response) ? data.response : [];
  }

  async getLeaguesCatalog() {
    const url = new URL("leagues", this.baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/json",
          "x-apisports-key": this.apiKey
        },
        signal: controller.signal
      });
    } catch (error) {
      throw new ApiFootballHttpError(error instanceof Error ? error.message : "API-Football request failed", undefined, url.href);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new ApiFootballHttpError(`API-Football request failed with status ${response.status}`, response.status, url.href);
    }

    const data = (await response.json()) as ApiFootballResponse<ApiFootballLeagueCatalogRow[]>;

    if (data.errors && JSON.stringify(data.errors) !== "[]") {
      throw new Error(`API-Football returned errors: ${JSON.stringify(data.errors)}`);
    }

    return Array.isArray(data.response) ? data.response : [];
  }
}

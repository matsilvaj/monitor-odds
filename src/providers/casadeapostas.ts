import { gotScraping } from "got-scraping";
import pMap from "p-map";
import { CookieJar } from "tough-cookie";
import type { CasaDeApostasBookmakerConfig } from "../config/bookmakers.js";

export type CasaDeApostasOdd = {
  id: number;
  marketId?: number;
  value?: number;
  state?: number;
  name?: string;
  externalId?: string;
  published?: boolean;
  [key: string]: unknown;
};

export type CasaDeApostasMarket = {
  id: number;
  marketTypeId?: number;
  name?: string;
  shortSign?: string;
  description?: string;
  published?: boolean;
  state?: number;
  odds?: CasaDeApostasOdd[];
  [key: string]: unknown;
};

export type CasaDeApostasGame = {
  id: number;
  name?: string;
  sportId?: number;
  leagueId?: number;
  leagueName?: string;
  sportName?: string;
  startDate?: string;
  competitors?: Array<{
    name?: string;
    competitor?: {
      name?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  markets?: CasaDeApostasMarket[];
  [key: string]: unknown;
};

type GamesResponse = {
  items?: CasaDeApostasGame[];
  totalCount?: number;
};

export class CasaDeApostasClient {
  private readonly jar = new CookieJar();
  private warmed = false;
  private readonly headers: Record<string, string>;

  constructor(private readonly config: CasaDeApostasBookmakerConfig) {
    this.headers = {
      accept: "*/*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  private async warmSession() {
    if (this.warmed) return;

    await gotScraping({
      url: this.config.referer,
      cookieJar: this.jar,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": this.headers["accept-language"],
        "user-agent": this.headers["user-agent"]
      },
      timeout: { request: 20_000 },
      retry: { limit: 0 }
    });

    this.warmed = true;
  }

  private async getJson<T>(url: URL): Promise<T> {
    await this.warmSession();

    const response = await gotScraping({
      url: url.href,
      cookieJar: this.jar,
      headers: { ...this.headers, referer: this.config.referer },
      timeout: { request: 20_000 },
      retry: { limit: 0 },
      responseType: "json"
    });

    return response.body as T;
  }

  async getGames(startDate: Date, endDate: Date) {
    const pageSize = 100;
    const maxPages = 10;

    const firstPage = await this.getGamesPage(startDate, endDate, 0, pageSize);
    const otherPages = await pMap(
      Array.from({ length: maxPages - 1 }, (_, index) => index + 1),
      (pageNumber) => this.getGamesPage(startDate, endDate, pageNumber, pageSize),
      { concurrency: 3 }
    );

    return [
      ...new Map(
        [firstPage, ...otherPages]
          .flatMap((page) => page.items ?? [])
          .filter((game) => Number.isFinite(Number(game.id)))
          .map((game) => [game.id, game])
      ).values()
    ];
  }

  private async getGamesPage(startDate: Date, endDate: Date, pageNumber: number, pageSize: number) {
    const url = new URL("api/odds/games", this.config.baseUrl);
    url.searchParams.set("startDate", startDate.toISOString());
    url.searchParams.set("endDate", endDate.toISOString());
    url.searchParams.set("languageId", String(this.config.languageId));
    url.searchParams.set("gameMode", "3");
    url.searchParams.set("pageNumber", String(pageNumber));
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("sportId", "1");
    url.searchParams.set("marketTypeIds", "1,1252");

    return this.getJson<GamesResponse>(url);
  }
}

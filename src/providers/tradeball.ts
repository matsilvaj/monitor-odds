import type { TradeballBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";
import { randomUUID } from "node:crypto";

export type TradeballPrice = {
  odds?: number;
  "decimal-odds"?: number;
  side?: string;
  currency?: string;
  "available-amount"?: number;
  [key: string]: unknown;
};

export type TradeballRunner = {
  id: string;
  name: string;
  status?: string;
  withdrawn?: boolean;
  prices?: TradeballPrice[];
  "event-participant-id"?: string;
  [key: string]: unknown;
};

export type TradeballMarket = {
  id: string;
  name: string;
  live?: boolean;
  status?: string;
  runners?: TradeballRunner[];
  "market-type"?: string;
  "name-original"?: string;
  [key: string]: unknown;
};

export type TradeballParticipant = {
  id?: string;
  number?: string;
  "participant-name"?: string;
  "participant-name-original"?: string;
};

export type TradeballMetaTag = {
  name?: string;
  type?: string;
  "url-name"?: string;
};

export type TradeballEvent = {
  id: string;
  name: string;
  start: string;
  status?: string;
  markets?: TradeballMarket[];
  "event-participants"?: TradeballParticipant[];
  "in-running-flag"?: boolean;
  "sport-id"?: string;
  "meta-tags"?: TradeballMetaTag[];
  [key: string]: unknown;
};

type TradeballDballEvent = {
  ceId?: string;
  dg?: string;
  cthName?: string;
  ctaName?: string;
  clName?: string;
  iso3?: string;
  wldHm?: string | number;
  wldDm?: string | number;
  wldAm?: string | number;
  [key: string]: unknown;
};

type TradeballDballResponse = {
  total?: number;
  init?: TradeballDballEvent[];
};

type TradeballExchangeResponse = {
  total?: number;
  events?: TradeballEvent[];
  "per-page"?: number;
};

const TRADEBALL_UTC_OFFSET_HOURS = 1;
const TRADEBALL_UTC_OFFSET_MS = TRADEBALL_UTC_OFFSET_HOURS * 60 * 60 * 1000;

function collectionDates(start: Date, end: Date) {
  const dates: string[] = [];
  const shiftedStart = new Date(start.getTime() + TRADEBALL_UTC_OFFSET_MS);
  const shiftedEnd = new Date(end.getTime() + TRADEBALL_UTC_OFFSET_MS);
  const cursor = new Date(Date.UTC(shiftedStart.getUTCFullYear(), shiftedStart.getUTCMonth(), shiftedStart.getUTCDate(), 0, 0, 0, 0));
  const limit = new Date(Date.UTC(shiftedEnd.getUTCFullYear(), shiftedEnd.getUTCMonth(), shiftedEnd.getUTCDate(), 0, 0, 0, 0));

  while (cursor <= limit) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

function parseDballDateTime(value: string | undefined) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return new Date(value ?? "").toISOString();

  const [, year, month, day, hour, minute, second] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - TRADEBALL_UTC_OFFSET_HOURS, minute, second, 0)).toISOString();
}

function dballRunner(eventId: string, code: string, name: string, price: unknown): TradeballRunner {
  const eventDigits = eventId.replace(/\D/g, "").slice(-14);

  return {
    id: `${eventDigits}${code}`,
    name,
    status: "open",
    withdrawn: false,
    prices: [
      {
        side: "back",
        odds: Number(price),
        "decimal-odds": Number(price)
      }
    ]
  };
}

function dballEventToTradeballEvent(event: TradeballDballEvent): TradeballEvent | null {
  if (!event.ceId || !event.dg || !event.cthName || !event.ctaName) return null;

  const homePrice = Number(event.wldHm);
  const drawPrice = Number(event.wldDm);
  const awayPrice = Number(event.wldAm);
  if (![homePrice, drawPrice, awayPrice].every((price) => Number.isFinite(price) && price > 0)) return null;

  return {
    id: String(event.ceId),
    name: `${event.cthName} x ${event.ctaName}`,
    start: parseDballDateTime(event.dg),
    status: "open",
    "in-running-flag": false,
    "sport-id": "15",
    "event-participants": [
      { id: `${event.ceId}:1`, number: "1", "participant-name": event.cthName },
      { id: `${event.ceId}:2`, number: "2", "participant-name": event.ctaName }
    ],
    "meta-tags": [
      {
        name: event.clName,
        type: "COMPETITION"
      }
    ],
    markets: [
      {
        id: `${event.ceId}:1x2`,
        name: "Tradeball 1X2",
        live: false,
        status: "open",
        "market-type": "one_x_two",
        runners: [
          dballRunner(String(event.ceId), "001", event.cthName, homePrice),
          dballRunner(String(event.ceId), "002", "Empate", drawPrice),
          dballRunner(String(event.ceId), "003", event.ctaName, awayPrice)
        ]
      }
    ],
    rawDball: event
  };
}

export class TradeballClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: TradeballBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getSoccerMoneylineEvents(start: Date, end: Date) {
    const dballEvents = await this.getDballGuestEvents(start, end).catch(() => []);
    if (dballEvents.length) {
      return [...new Map(dballEvents.map((event) => [event.id, event])).values()];
    }

    const exchangeEvents = await this.getExchangeEvents(start, end).catch(() => []);
    return [...new Map(exchangeEvents.map((event) => [event.id, event])).values()];
  }

  private async getExchangeEvents(start: Date, end: Date) {
    const perPage = this.config.perPage;
    const maxPages = this.config.maxPages;
    const events: TradeballEvent[] = [];
    const after = Math.floor(start.getTime() / 1000);
    const before = Math.floor(end.getTime() / 1000);

    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * perPage;
      const url = new URL("api/events", this.config.exchangeApiBaseUrl);
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("per-page", String(perPage));
      url.searchParams.set("sort-by", "volume");
      url.searchParams.set("sort-direction", "desc");
      url.searchParams.set("sport-ids", this.config.sportId);
      url.searchParams.set("market-types", "one_x_two");
      url.searchParams.set("en-market-names", "Match Odds,Moneyline,Winner");
      url.searchParams.set("after", String(after));
      url.searchParams.set("before", String(before));
      url.searchParams.set("markets-limit", "30");

      const pageData = await httpClient<TradeballExchangeResponse>({
        url,
        headers: this.headers,
        referer: this.config.referer,
        engine: this.config.engine,
        timeoutMs: 20_000,
        maxRetries: 2
      });

      const pageEvents = pageData.events ?? [];
      events.push(...pageEvents);

      if (pageEvents.length < perPage || events.length >= (pageData.total ?? 0)) break;
    }

    return events;
  }

  private async getDballGuestEvents(start: Date, end: Date) {
    const results = await Promise.allSettled([this.getDballGuestPages(), ...collectionDates(start, end).map((date) => this.getDballGuestPages(date))]);
    const pages = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);

    return pages
      .flat()
      .flatMap((page) => page.init ?? [])
      .map(dballEventToTradeballEvent)
      .filter((event): event is TradeballEvent => Boolean(event));
  }

  private async getDballGuestPages(date?: string) {
    const pages: TradeballDballResponse[] = [];

    for (let page = 0; page < this.config.maxPages; page += 1) {
      const start = page * this.config.perPage;
      const pageData = await this.getDballGuestPage(date, start, this.config.perPage);
      const pageEvents = pageData.init ?? [];
      pages.push(pageData);

      if (!pageEvents.length || start + pageEvents.length >= Number(pageData.total ?? 0)) break;
    }

    return pages;
  }

  private async getDballGuestPage(date?: string, start = 0, limit = this.config.perPage) {
    const url = new URL("api/feedDballGuest/list", this.config.dballBaseUrl);
    url.searchParams.set("page", "1");
    url.searchParams.set("filter", JSON.stringify({ line: 1, periodTypeId: 1, tradingTypeId: 2, marketId: 2, ...(date ? { date } : {}) }));
    url.searchParams.set("start", String(start));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", JSON.stringify([{ property: "created_at", direction: "desc" }]));
    url.searchParams.append("requiredDictionaries[]", "LeagueGroup");
    url.searchParams.set("version", "0");
    url.searchParams.set("currencyId", "4");
    url.searchParams.set("uniqAppId", randomUUID());
    url.searchParams.set("locale", "pt");
    url.searchParams.set("_", String(Date.now()));

    return httpClient<TradeballDballResponse>({
      url,
      headers: {
        ...this.headers,
        "x-requested-with": "XMLHttpRequest"
      },
      referer: new URL("dballTradingFeed", this.config.dballBaseUrl).href,
      engine: this.config.engine,
      timeoutMs: 20_000,
      maxRetries: 1
    });
  }
}

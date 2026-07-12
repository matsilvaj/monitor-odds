import type { BookmakerHttpEngine } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

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

export type AltenarClientConfig = {
  baseUrl: string;
  integration: string;
  origin: string;
  referer: string;
  engine: BookmakerHttpEngine;
  eventListMode?: "legacy" | "coupon-events";
  listDeviceType?: "1" | "2";
  detailDeviceType?: "1" | "2";
  acceptHeader?: string;
};

export class AltenarClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: AltenarClientConfig) {
    this.headers = {
      accept: config.acceptHeader ?? "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      origin: config.origin,
      referer: config.referer,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    };
  }

  private get listDeviceType() {
    return this.config.listDeviceType ?? "2";
  }

  private get detailDeviceType() {
    return this.config.detailDeviceType ?? "1";
  }

  async getEvents(champId: number) {
    if (this.config.eventListMode === "coupon-events") {
      const params = new URLSearchParams({
        culture: "pt-BR",
        timezoneOffset: "180",
        integration: this.config.integration,
        deviceType: this.listDeviceType,
        numFormat: "en-GB",
        countryCode: "BR",
        champId: String(champId),
        isLive: "false"
      });

      const data = await httpClient<{ events?: AltenarEvent[] }>({
        url: new URL(`widget/GetBreadcrumbEvents?${params}`, this.config.baseUrl),
        headers: this.headers,
        referer: this.config.referer,
        engine: this.config.engine
      });
      return Array.isArray(data.events) ? data.events.map((event) => ({ ...event, champId: event.champId ?? champId })) : [];
    }
    const params = new URLSearchParams({
      culture: "pt-BR",
      timezoneOffset: "180",
      integration: this.config.integration,
      deviceType: this.listDeviceType,
      numFormat: "en-GB",
      countryCode: "BR",
      eventCount: "0",
      sportId: "0",
      champIds: String(champId)
    });

    const data = await httpClient<{ events?: AltenarEvent[] }>({
      url: new URL(`widget/GetEvents?${params}`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine
    });
    return Array.isArray(data.events) ? data.events : [];
  }

  async getFootballEvents() {
    if (this.config.eventListMode === "coupon-events") {
      const periods = [
        { period: "5", couponType: "1" },
        { period: "6", couponType: "2" }
      ];
      const responses = await Promise.all(
        periods.map(async ({ period, couponType }) => {
          const params = new URLSearchParams({
            culture: "pt-BR",
            timezoneOffset: "180",
            integration: this.config.integration,
            deviceType: this.listDeviceType,
            numFormat: "en-GB",
            countryCode: "BR",
            eventCount: "0",
            sportId: "66",
            period,
            couponType
          });
          return httpClient<{ events?: AltenarEvent[] }>({
            url: new URL(`widget/GetCouponEvents?${params}`, this.config.baseUrl),
            headers: this.headers,
            referer: this.config.referer,
            engine: this.config.engine,
            timeoutMs: 30_000,
            maxRetries: 1
          });
        })
      );

      const events = responses.flatMap((data) => (Array.isArray(data.events) ? data.events : []));
      return [...new Map(events.map((event) => [Number(event.id), event])).values()];
    }
    const params = new URLSearchParams({
      culture: "pt-BR",
      timezoneOffset: "180",
      integration: this.config.integration,
      deviceType: this.listDeviceType,
      numFormat: "en-GB",
      countryCode: "BR",
      eventCount: "0",
      sportId: "66"
    });

    const data = await httpClient<{ events?: AltenarEvent[] }>({
      url: new URL(`widget/GetEvents?${params}`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 30_000,
      maxRetries: 1
    });
    return Array.isArray(data.events) ? data.events : [];
  }

  async getEventDetails(eventId: number) {
    const params = new URLSearchParams({
      culture: "pt-BR",
      timezoneOffset: "180",
      integration: this.config.integration,
      deviceType: this.detailDeviceType,
      numFormat: "en-GB",
      countryCode: "BR",
      eventId: String(eventId),
      showNonBoosts: "false"
    });

    return httpClient<AltenarEventDetails>({
      url: new URL(`widget/GetEventDetails?${params}`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine
    });
  }
}

import type { BetesporteBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type BetesporteOption = {
  id: number;
  name?: string;
  odd?: number;
  externalId?: string;
  locked?: boolean;
  blocked?: boolean;
  hide?: boolean;
  [key: string]: unknown;
};

export type BetesporteMarket = {
  id: number;
  name?: string;
  type?: number;
  locked?: boolean;
  options?: BetesporteOption[];
  [key: string]: unknown;
};

export type BetesporteEvent = {
  id: number;
  betRadarId?: number;
  homeTeamName?: string;
  awayTeamName?: string;
  homeTeamId?: number;
  awayTeamId?: number;
  date?: string;
  markets?: BetesporteMarket[];
  countryName?: string;
  tournamentName?: string;
  tournamentId?: number;
  countryId?: number;
  [key: string]: unknown;
};

type BetesporteTournament = {
  id?: number;
  name?: string;
  events?: BetesporteEvent[];
};

type BetesporteCountry = {
  id?: number;
  name?: string;
  tournaments?: BetesporteTournament[];
};

type BetesporteEventsResponse = {
  data?: {
    id?: number;
    name?: string;
    countries?: BetesporteCountry[];
  };
};

export class BetesporteClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: BetesporteBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getEventsByDate(startDate: Date, endDate: Date) {
    const url = new URL("api/PreMatch/GetEventsByDate", this.config.baseUrl);
    url.searchParams.set("sportId", "1");
    url.searchParams.set("startDate", startDate.toISOString());
    url.searchParams.set("endDate", endDate.toISOString());
    url.searchParams.set("searchNextDays", "false");

    const data = await httpClient<BetesporteEventsResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });

    return this.flattenEvents(data);
  }

  async getEventDetail(event: BetesporteEvent) {
    const url = new URL("api/PreMatch/GetEventDetail", this.config.baseUrl);
    url.searchParams.set("eventId", String(event.id));
    url.searchParams.set("sportId", "1");
    url.searchParams.set("tournamentId", String(event.tournamentId ?? ""));
    url.searchParams.set("countryId", "NaN");

    const data = await httpClient<BetesporteEventsResponse>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });

    return this.flattenEvents(data).find((detailEvent) => detailEvent.id === event.id) ?? event;
  }

  private flattenEvents(data: BetesporteEventsResponse) {
    const events: BetesporteEvent[] = [];

    for (const country of data.data?.countries ?? []) {
      for (const tournament of country.tournaments ?? []) {
        for (const event of tournament.events ?? []) {
          events.push({
            ...event,
            countryId: country.id,
            countryName: country.name,
            tournamentId: tournament.id,
            tournamentName: tournament.name
          });
        }
      }
    }

    return events;
  }
}

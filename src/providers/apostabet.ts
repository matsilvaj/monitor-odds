import type { ApostabetBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type ApostabetTournament = {
  tournamentId: string;
  tournamentName?: string;
  categoryId?: string;
  categoryName?: string;
  countryCode?: string | null;
  seasonName?: string | null;
  [key: string]: unknown;
};

export type ApostabetCategory = {
  categoryId?: string;
  categoryName?: string;
  countryCode?: string | null;
  tournaments?: ApostabetTournament[];
  [key: string]: unknown;
};

export type ApostabetOutcome = {
  id: string;
  outcomeId?: string;
  active?: boolean;
  name?: string;
  odds?: number | string;
  [key: string]: unknown;
};

export type ApostabetMarket = {
  id: string;
  smarketId?: number;
  nameDefault?: string;
  nameTranslated?: string | null;
  status?: number;
  isMarketCancel?: boolean;
  inPlay?: boolean;
  sportOutcomeDetails?: ApostabetOutcome[];
  [key: string]: unknown;
};

export type ApostabetEvent = {
  id: string;
  tournamentId?: string;
  tournamentName?: string;
  seasonName?: string | null;
  sportId?: string;
  producerId?: number;
  isEarlyPayout?: boolean;
  homeCompetitorName?: string;
  awayCompetitorName?: string;
  name?: string;
  scheduleTime?: string;
  status?: number;
  sportMarketDetails?: ApostabetMarket[];
  [key: string]: unknown;
};

type ApostabetSearchMatch = {
  scheduleTime?: string;
  matchName?: string;
  matchId?: string;
  parentStageId?: string | null;
  producerId?: number;
  status?: number;
  [key: string]: unknown;
};

type ApostabetSearchTournament = {
  tournamentId?: string;
  tournamentName?: string;
  seasonName?: string | null;
  events?: ApostabetSearchMatch[];
  [key: string]: unknown;
};

type ApostabetSearchSport = {
  sportId?: string;
  sportName?: string;
  tournaments?: ApostabetSearchTournament[];
  [key: string]: unknown;
};

type ApostabetFixtureDetail = {
  eventId?: string;
  eventName?: string;
  sportId?: string;
  tournamentId?: string;
  tournamentName?: string;
  seasonName?: string | null;
  scheduledTime?: string;
  eventStatus?: number;
  producerId?: number;
  isEarlyPayout?: boolean;
  [key: string]: unknown;
};

type ApostabetPrincipalMarkets = {
  sportMarketDetails?: ApostabetMarket[];
  totalActiveMarkets?: number;
  [key: string]: unknown;
};

type ApostabetPrincipalTournament = {
  eventFixtureDetails?: ApostabetEvent[];
  [key: string]: unknown;
};

export type ApostabetEarlyPayoutTournament = {
  tournamentId: string;
  enabled?: boolean;
  label?: string;
  categoryId?: string;
  [key: string]: unknown;
};

export class ApostabetClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: ApostabetBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getFootballSidebar() {
    const url = new URL("api/SidebarSport/v3/all/categories/tournaments/sorted/sr:sport:1", this.config.apiBaseUrl);

    return httpClient<ApostabetCategory[]>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 20_000,
      maxRetries: 1
    });
  }

  async getEarlyPayoutTournaments() {
    const url = new URL("api/EarlyPayoutFeatures/v1/GetEarlyPayoutTournaments/sr:sport:1", this.config.apiBaseUrl);

    return httpClient<ApostabetEarlyPayoutTournament[]>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });
  }

  async getEventsByTournament(tournamentId: string) {
    const url = new URL(`api/FixtureDetail/v1/GetEventsByTournament/${tournamentId}`, this.config.apiBaseUrl);

    return httpClient<ApostabetEvent[]>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 25_000,
      maxRetries: 1
    });
  }

  async getPrincipalTournamentEvents() {
    const url = new URL("api/PrincipalTournaments/v1/GetEventsByPrincipalTournaments", this.config.apiBaseUrl);
    url.searchParams.set("tournamentToShow", "16");
    url.searchParams.set("forwardDays", "20");

    const tournaments = await httpClient<ApostabetPrincipalTournament[]>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 25_000,
      maxRetries: 1
    });

    return tournaments.flatMap((tournament) => tournament.eventFixtureDetails ?? []);
  }

  async searchEvents(eventName: string) {
    const url = new URL("api/SportBook/v1/search", this.config.apiBaseUrl);
    url.searchParams.set("eventName", eventName);

    const sports = await httpClient<ApostabetSearchSport[]>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 15_000,
      maxRetries: 1
    });

    return sports.flatMap((sport) =>
      (sport.tournaments ?? []).flatMap((tournament) =>
        (tournament.events ?? []).map((event) => ({
          ...event,
          sportId: sport.sportId,
          sportName: sport.sportName,
          tournamentId: tournament.tournamentId,
          tournamentName: tournament.tournamentName,
          seasonName: tournament.seasonName ?? null
        }))
      )
    );
  }

  async getEventWithPrincipalMarkets(eventId: string) {
    const [detail, markets] = await Promise.all([
      httpClient<ApostabetFixtureDetail>({
        url: new URL(`api/EventFixture/v1/GetFixtureDetail/${eventId}`, this.config.apiBaseUrl),
        headers: this.headers,
        referer: this.config.referer,
        engine: this.config.engine,
        timeoutMs: 15_000,
        maxRetries: 1
      }),
      httpClient<ApostabetPrincipalMarkets>({
        url: new URL(`api/EventFixture/v1/GetPrincipalMarkets/${eventId}`, this.config.apiBaseUrl),
        headers: this.headers,
        referer: this.config.referer,
        engine: this.config.engine,
        timeoutMs: 15_000,
        maxRetries: 1
      })
    ]);

    return {
      id: detail.eventId ?? eventId,
      tournamentId: detail.tournamentId,
      tournamentName: detail.tournamentName,
      seasonName: detail.seasonName ?? null,
      name: detail.eventName,
      scheduleTime: detail.scheduledTime,
      status: detail.eventStatus,
      sportId: detail.sportId,
      producerId: detail.producerId,
      isEarlyPayout: detail.isEarlyPayout,
      sportMarketDetails: markets.sportMarketDetails ?? [],
      totalActiveMarkets: markets.totalActiveMarkets,
      rawDetail: detail
    } satisfies ApostabetEvent;
  }
}

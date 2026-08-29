import type { BravobetBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

// A Bravo Bet roda a plataforma FSB (fssb.io). A API exige dois JWT anonimos que o
// proprio HTML do sportsbook entrega: sessionToken vai no header `session` e
// internalToken no header `authorization`. Sem o authorization a API responde
// 403 "token expected".
const SESSION_TOKEN_PATTERN = /'sessionToken':'([^']+)'/;
const INTERNAL_TOKEN_PATTERN = /'internalToken':'([^']+)'/;

export type BravobetSelection = "HOME" | "DRAW" | "AWAY";

type BravobetParticipant = {
  _id?: string;
  Name?: string;
  VenueRole?: string;
};

export type BravobetRawEvent = {
  _id?: string;
  SportId?: string;
  Type?: string;
  IsLive?: boolean;
  IsSuspended?: boolean;
  EventName?: string;
  LeagueId?: string;
  LeagueName?: string;
  RegionName?: string;
  StartEventDate?: string;
  UrlEventName?: string;
  UrlLeagueName?: string;
  UrlRegionName?: string;
  UrlSportName?: string;
  Participants?: BravobetParticipant[];
};

type BravobetRawSelection = {
  _id?: string;
  Name?: string;
  DisplayOdds?: { Decimal?: string };
};

type BravobetRawMarket = {
  _id?: string;
  EventId?: string;
  IsSuspended?: boolean;
  MarketType?: { _id?: string; Name?: string };
  Selections?: BravobetRawSelection[];
};

export type BravobetOdd = {
  id: string;
  selection: BravobetSelection;
  price: number;
  label: string | null;
  marketName: string | null;
};

export type BravobetEvent = {
  id: string;
  startsAt: string;
  homeTeam: string | null;
  awayTeam: string | null;
  eventName: string | null;
  leagueName: string | null;
  regionName: string | null;
  path: string | null;
  odds: BravobetOdd[];
};

// O sufixo do id da selecao carrega o lado: H (casa), D (empate), A (fora).
const SELECTION_BY_SUFFIX: Record<string, BravobetSelection> = {
  H: "HOME",
  D: "DRAW",
  A: "AWAY"
};

function participantName(event: BravobetRawEvent, role: string) {
  return event.Participants?.find((participant) => participant.VenueRole === role)?.Name?.trim() || null;
}

function eventPath(event: BravobetRawEvent) {
  const segments = [event.UrlSportName, event.UrlRegionName, event.UrlLeagueName, event.UrlEventName, event._id];
  return segments.every(Boolean) ? segments.join("/") : null;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export class BravobetClient {
  private readonly baseHeaders: Record<string, string>;
  private tokens: { session: string; authorization: string } | null = null;

  constructor(private readonly config: BravobetBookmakerConfig) {
    this.baseHeaders = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      origin: new URL(config.baseUrl).origin,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
    };
  }

  private async authenticate() {
    if (this.tokens) return this.tokens;

    const html = await httpClient<string>({
      url: new URL(this.config.sportsbookPath, this.config.baseUrl),
      headers: {
        ...this.baseHeaders,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      referer: this.config.referer,
      engine: this.config.engine,
      responseType: "text",
      timeoutMs: 30_000,
      maxRetries: 2
    });

    const session = SESSION_TOKEN_PATTERN.exec(html)?.[1];
    const authorization = INTERNAL_TOKEN_PATTERN.exec(html)?.[1];
    if (!session || !authorization) throw new Error("Bravobet: tokens anonimos ausentes no HTML do sportsbook");

    this.tokens = { session, authorization };
    return this.tokens;
  }

  private async authHeaders() {
    const tokens = await this.authenticate();
    return { ...this.baseHeaders, session: tokens.session, authorization: tokens.authorization };
  }

  async getFootballEvents(): Promise<BravobetRawEvent[]> {
    const headers = await this.authHeaders();
    const events: BravobetRawEvent[] = [];

    for (let page = 0; page < this.config.maxPages; page += 1) {
      const payload = await httpClient<{ data?: BravobetRawEvent[]; meta?: { hasMore?: boolean } }>({
        url: new URL("api/eventlist/eu/events/v2/all", this.config.baseUrl),
        method: "POST",
        headers,
        json: {
          sport: [this.config.sportId],
          type: ["Fixture"],
          live: false,
          sortBy: "time",
          limit: this.config.pageSize,
          skip: page * this.config.pageSize
        },
        referer: this.config.referer,
        engine: this.config.engine,
        timeoutMs: 30_000,
        maxRetries: 2
      });

      const batch = Array.isArray(payload.data) ? payload.data : [];
      events.push(...batch);
      if (!payload.meta?.hasMore || !batch.length) break;
    }

    return events;
  }

  async getMoneylineMarkets(eventIds: string[]): Promise<BravobetRawMarket[]> {
    if (!eventIds.length) return [];

    const headers = await this.authHeaders();
    const markets: BravobetRawMarket[] = [];

    for (const ids of chunk(eventIds, this.config.marketBatchSize)) {
      const params = new URLSearchParams({ markets: `${ids.join("|")}:${this.config.moneylineMarketType}` });
      const payload = await httpClient<BravobetRawMarket[]>({
        url: new URL(`api/eventlist/eu/markets/all?${params}`, this.config.baseUrl),
        headers,
        referer: this.config.referer,
        engine: this.config.engine,
        timeoutMs: 30_000,
        maxRetries: 2
      });
      if (Array.isArray(payload)) markets.push(...payload);
    }

    return markets;
  }

  async getPrematchFootballEvents(): Promise<BravobetEvent[]> {
    const rawEvents = (await this.getFootballEvents()).filter(
      (event) => event._id && event.Type === "Fixture" && !event.IsLive && !event.IsSuspended && event.StartEventDate
    );
    if (!rawEvents.length) return [];

    const markets = await this.getMoneylineMarkets(rawEvents.map((event) => event._id as string));
    const oddsByEventId = new Map<string, BravobetOdd[]>();

    for (const market of markets) {
      if (!market.EventId || market.IsSuspended) continue;
      if (market.MarketType?._id !== this.config.moneylineMarketType) continue;

      for (const selection of market.Selections ?? []) {
        const suffix = selection._id?.slice(-1) ?? "";
        const side = SELECTION_BY_SUFFIX[suffix];
        const price = Number(selection.DisplayOdds?.Decimal);
        if (!side || !selection._id || !Number.isFinite(price) || price <= 1) continue;

        const list = oddsByEventId.get(market.EventId) ?? [];
        list.push({
          id: selection._id,
          selection: side,
          price,
          label: selection.Name?.trim() || null,
          marketName: market.MarketType?.Name?.trim() || null
        });
        oddsByEventId.set(market.EventId, list);
      }
    }

    return rawEvents
      .map((event) => ({
        id: event._id as string,
        startsAt: new Date(event.StartEventDate as string).toISOString(),
        homeTeam: participantName(event, "Home"),
        awayTeam: participantName(event, "Away"),
        eventName: event.EventName?.trim() || null,
        leagueName: event.LeagueName?.trim() || null,
        regionName: event.RegionName?.trim() || null,
        path: eventPath(event),
        odds: oddsByEventId.get(event._id as string) ?? []
      }))
      .filter((event) => event.odds.length > 0);
  }
}

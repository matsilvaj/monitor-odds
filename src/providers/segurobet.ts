import type { SegurobetBookmakerConfig } from "../config/bookmakers.js";

export type SegurobetEvent = {
  id: number;
  name?: string;
  price?: number;
  base?: number;
  order?: number;
  type_1?: string;
  extra_info?: unknown;
  display_column?: number;
  [key: string]: unknown;
};

export type SegurobetMarket = {
  id: number;
  name?: string;
  type?: string;
  market_type?: string;
  name_template?: string;
  has_early_payout?: boolean;
  event?: Record<string, SegurobetEvent>;
  [key: string]: unknown;
};

export type SegurobetGame = {
  id: number;
  type?: number;
  team1_name?: string;
  team2_name?: string;
  start_ts?: number;
  region_alias?: string;
  markets_count?: number;
  is_started?: number;
  is_blocked?: number;
  market?: Record<string, SegurobetMarket>;
  competitionName?: string | null;
  competitionId?: number | null;
  regionName?: string | null;
  regionAlias?: string | null;
  [key: string]: unknown;
};

type SwarmResponse<T = unknown> = {
  code?: number;
  rid?: string;
  data?: T;
};

type BettingSearchResponse = {
  data?: {
    sport?: Record<
      string,
      {
        region?: Record<
          string,
          {
            name?: string;
            alias?: string;
            competition?: Record<
              string,
              {
                name?: string;
                id?: number;
                game?: Record<string, SegurobetGame>;
              }
            >;
          }
        >;
      }
    >;
  };
};

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("SeguroBet WebSocket connection failed")), { once: true });
  });
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value) as SwarmResponse;
  } catch {
    return null;
  }
}

function rid(prefix: string) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}

export class SegurobetClient {
  private ws: WebSocket | null = null;

  constructor(private readonly config: SegurobetBookmakerConfig) {}

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.config.swarmUrl);
    await waitForOpen(this.ws);
    await this.request({
      command: "request_session",
      params: {
        language: this.config.language,
        site_id: String(this.config.siteId),
        source: this.config.source,
        is_wrap_app: false
      },
      rid: rid("request_session")
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  private async request<T>(message: Record<string, unknown>, timeoutMs = 30_000): Promise<SwarmResponse<T>> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("SeguroBet WebSocket is not open");

    return new Promise((resolve, reject) => {
      const messageRid = String(message.rid ?? "");
      const timeout = setTimeout(() => {
        ws.removeEventListener("message", onMessage);
        reject(new Error(`SeguroBet WebSocket timeout for ${messageRid}`));
      }, timeoutMs);

      const onMessage = (event: MessageEvent) => {
        const parsed = safeJsonParse(String(event.data));
        if (!parsed || parsed.rid !== messageRid) return;

        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
        resolve(parsed as SwarmResponse<T>);
      };

      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify(message));
    });
  }

  async searchGames(query: string) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];

    const response = await this.request<BettingSearchResponse>({
      command: "get",
      params: {
        source: "betting",
        what: {
          sport: ["id", "name", "alias"],
          region: ["name", "alias"],
          competition: ["name", "id"],
          game: [
            "id",
            "type",
            "team1_name",
            "team2_name",
            "team1_id",
            "team2_id",
            "info",
            "start_ts",
            "markets_count",
            "is_started",
            "is_blocked",
            "sport_alias",
            "#sport:type"
          ],
          market: [
            "type",
            "name",
            "order",
            "main_order",
            "id",
            "base",
            "express_id",
            "col_count",
            "group_id",
            "group_name",
            "cashout",
            "point_sequence",
            "sequence",
            "market_type",
            "extra_info",
            "group_order",
            "prematch_express_id",
            "has_early_payout"
          ],
          event: ["name", "id", "price", "base", "order", "type_1", "extra_info", "display_column"],
        },
        where: {
          "@or": [
            {
              game: {
                "@or": [
                  { team1_name: { "@like": { eng: normalizedQuery, "pt-br": normalizedQuery } } },
                  { team2_name: { "@like": { eng: normalizedQuery, "pt-br": normalizedQuery } } }
                ],
                type: { "@in": [0, 2] }
              },
              sport: { alias: "Soccer", type: { "@ne": 1 } }
            },
            {
              game: { type: { "@in": [0, 2] } },
              competition: { name: { "@like": { eng: normalizedQuery, "pt-br": normalizedQuery } } },
              sport: { alias: "Soccer", type: { "@ne": 1 } }
            }
          ]
        },
        subscribe: false
      },
      rid: rid("SegurobetSearchCmd")
    });

    return flattenGames(response.data);
  }
}

function flattenGames(response: BettingSearchResponse | undefined) {
  const games = new Map<number, SegurobetGame>();

  for (const sport of Object.values(response?.data?.sport ?? {})) {
    for (const region of Object.values(sport.region ?? {})) {
      for (const competition of Object.values(region.competition ?? {})) {
        for (const game of Object.values(competition.game ?? {})) {
          const gameId = Number(game.id);
          if (!Number.isFinite(gameId)) continue;

          games.set(gameId, {
            ...game,
            id: gameId,
            competitionName: competition.name ?? null,
            competitionId: competition.id ?? null,
            regionName: region.name ?? null,
            regionAlias: region.alias ?? game.region_alias ?? null
          });
        }
      }
    }
  }

  return [...games.values()];
}

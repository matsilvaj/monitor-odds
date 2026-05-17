import type { BetfastBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type BetfastOdd = {
  pos?: number;
  coef?: number;
  lock?: boolean;
  res?: number;
  p1?: number;
  [key: string]: unknown;
};

export type BetfastGame = {
  id: number;
  ch: number;
  t1: number;
  t2: number;
  st: string;
  sport: number;
  region: number;
  ev?: Record<string, Record<string, BetfastOdd>>;
  [key: string]: unknown;
};

export type BetfastEvent = BetfastGame & {
  homeTeam: string | null;
  awayTeam: string | null;
  startsAt: string;
  leagueName: string | null;
  regionName: string | null;
};

type BetfastHeaderGame = {
  ID?: number;
  Sport?: number;
  Champ?: number;
  Region?: number;
  t1?: number;
  t2?: number;
  StartTime?: string;
};

type BetfastHeaderMeta = {
  leagueName: string | null;
  regionName: string | null;
};

function parseDeepJson<T = unknown>(value: unknown): T {
  let current = value;
  for (let index = 0; index < 3 && typeof current === "string"; index += 1) {
    current = JSON.parse(current);
  }

  return current as T;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function objectValues(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function utcIso(value: unknown) {
  const text = String(value ?? "");
  if (!text) return "";
  const withZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  return new Date(withZone).toISOString();
}

export class BetfastClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: BetfastBookmakerConfig) {
    this.headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async getFootballEvents() {
    const { gameIds, gameMeta } = await this.getFootballGameIndex();
    const events: BetfastEvent[] = [];

    for (const ids of chunk(gameIds, 40)) {
      const { games, teams } = await this.getGames(ids);
      const teamNames = new Map(teams.map((team) => [Number(team.ID), String(team.Name ?? "")]));

      for (const game of games) {
        if (Number(game.sport) !== 1 || !game.id || !game.t1 || !game.t2) continue;
        const meta = gameMeta.get(Number(game.id)) ?? gameMeta.get(Number(game.ch));

        events.push({
          ...game,
          homeTeam: teamNames.get(Number(game.t1)) || null,
          awayTeam: teamNames.get(Number(game.t2)) || null,
          startsAt: utcIso(game.st),
          leagueName: meta?.leagueName ?? null,
          regionName: meta?.regionName ?? null
        });
      }
    }

    return events;
  }

  async getEventDetails(event: BetfastEvent) {
    const url = new URL(`api/prematch/getprematchgamefull/${this.config.companyId}/${event.id}`, this.config.apiBaseUrl);
    const response = await httpClient<unknown>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 30_000,
      maxRetries: 1
    });

    const body = parseDeepJson<Record<string, unknown>>(response);
    const game = parseDeepJson<BetfastGame>(body.game ?? {});

    return {
      ...event,
      ...game,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      startsAt: event.startsAt,
      leagueName: event.leagueName,
      regionName: event.regionName
    } satisfies BetfastEvent;
  }

  private async getFootballGameIndex() {
    const url = new URL(`api/sport/getheader/${this.config.language}`, this.config.apiBaseUrl);
    const response = await httpClient<unknown>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 30_000,
      maxRetries: 1
    });

    const header = parseDeepJson<Record<string, unknown>>(response);
    const root = header.BR as Record<string, unknown> | undefined;
    const sports = root?.Sports as Record<string, unknown> | undefined;
    const football = sports?.["1"] as Record<string, unknown> | undefined;
    const regions = objectValues(football?.Regions);
    const gameIds: number[] = [];
    const gameMeta = new Map<number, BetfastHeaderMeta>();

    for (const region of regions) {
      const regionName = typeof region.Name === "string" ? region.Name : null;
      const champs = objectValues(region.Champs);

      for (const champ of champs) {
        const leagueName = typeof champ.Name === "string" ? champ.Name : null;
        for (const game of objectValues(champ.GameSmallItems)) {
          const small = game as BetfastHeaderGame;
          const id = Number(small.ID);
          if (!Number.isFinite(id) || id <= 0 || Number(small.Sport) !== 1 || !small.t1 || !small.t2) continue;
          gameIds.push(id);
          gameMeta.set(id, { leagueName, regionName });
        }
      }
    }

    return {
      gameIds: [...new Set(gameIds)],
      gameMeta
    };
  }

  private async getGames(gameIds: number[]) {
    const url = new URL(`api/prematch/getprematchgameall/${this.config.language}/${this.config.companyId}/`, this.config.apiBaseUrl);
    url.searchParams.set("games", `,${gameIds.join(",")}`);

    const response = await httpClient<unknown>({
      url,
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 30_000,
      maxRetries: 1
    });

    const body = parseDeepJson<Record<string, unknown>>(response);
    const games = parseDeepJson<BetfastGame[]>(body.game ?? []);
    const teams = parseDeepJson<Array<{ ID?: number; Name?: string }>>(body.teams ?? []);

    return {
      games: Array.isArray(games) ? games : [],
      teams: Array.isArray(teams) ? teams : []
    };
  }
}

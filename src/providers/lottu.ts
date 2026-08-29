import type { LottuBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

// A Lottu roda na plataforma NGB (alpha-sb.ngbras.com). O endpoint /event devolve o
// catalogo inteiro de um status; o filtro por esporte fica do nosso lado porque a API
// ignora o parametro type e responde com todos os esportes.
const FOOTBALL_TYPE = "Soccer";

export type LottuSelection = "HOME" | "DRAW" | "AWAY";

type LottuRawOdd = {
  value?: number;
  enable?: boolean;
  status?: string;
};

type LottuRawEvent = {
  _id?: string;
  __t?: string;
  status?: string;
  date?: string;
  start_date?: string;
  home_team?: string;
  away_team?: string;
  championship?: string;
  country?: string;
  category?: string;
  external_id?: string | null;
  market_config?: { has_early_payout?: boolean; has_super_odds?: boolean };
  odds?: { full_time?: Record<string, LottuRawOdd | undefined> };
};

export type LottuOdd = {
  id: string;
  selection: LottuSelection;
  price: number;
};

export type LottuEvent = {
  id: string;
  startsAt: string;
  homeTeam: string | null;
  awayTeam: string | null;
  championship: string | null;
  country: string | null;
  hasEarlyPayout: boolean;
  odds: LottuOdd[];
};

const SELECTION_BY_KEY: Record<string, LottuSelection> = {
  home: "HOME",
  draw: "DRAW",
  away: "AWAY"
};

function parseOdd(eventId: string, key: string, raw: LottuRawOdd | undefined): LottuOdd | null {
  const selection = SELECTION_BY_KEY[key];
  if (!selection || !raw || raw.enable === false || raw.status !== "ACTIVE") return null;

  const price = Number(raw.value);
  if (!Number.isFinite(price) || price <= 1) return null;

  return { id: `${eventId}:full_time:${key}`, selection, price };
}

export class LottuClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: LottuBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      origin: new URL(config.referer).origin,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
    };
  }

  async getPrematchFootballEvents(): Promise<LottuEvent[]> {
    const params = new URLSearchParams({ type: FOOTBALL_TYPE, status: "NOT_STARTED" });
    const payload = await httpClient<LottuRawEvent[]>({
      url: new URL(`event?${params}`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 30_000,
      maxRetries: 2
    });

    if (!Array.isArray(payload)) return [];

    const events: LottuEvent[] = [];
    for (const raw of payload) {
      if (raw?.__t !== FOOTBALL_TYPE || !raw._id) continue;

      const startsAt = raw.date ?? raw.start_date;
      if (!startsAt || Number.isNaN(Date.parse(startsAt))) continue;

      const fullTime = raw.odds?.full_time ?? {};
      const odds = Object.keys(SELECTION_BY_KEY)
        .map((key) => parseOdd(raw._id as string, key, fullTime[key]))
        .filter((odd): odd is LottuOdd => Boolean(odd));
      if (!odds.length) continue;

      events.push({
        id: raw._id,
        startsAt: new Date(startsAt).toISOString(),
        homeTeam: raw.home_team?.trim() || null,
        awayTeam: raw.away_team?.trim() || null,
        championship: raw.championship?.trim() || null,
        country: raw.country?.trim() || null,
        hasEarlyPayout: raw.market_config?.has_early_payout === true,
        odds
      });
    }

    return events;
  }
}

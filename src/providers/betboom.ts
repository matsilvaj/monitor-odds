import type { BetboomBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

// A BetBoom migrou do WebSocket protobuf (com-br-ws.sporthub.bet) para a plataforma
// SportPub. O catalogo prematch vem em paginas versionadas: a chamada com versao 0
// devolve so o manifesto de versoes, e cada versao listada e uma pagina do snapshot.
const FOOTBALL_SPORT_ID = "1";
const MONEYLINE_MARKET_ID = "1";
const MONEYLINE_SELECTION_BY_OUTCOME: Record<string, BetboomSelection> = {
  "1": "HOME",
  "2": "DRAW",
  "3": "AWAY"
};

export type BetboomSelection = "HOME" | "DRAW" | "AWAY";

type SptpubCompetitor = { id?: string; name?: string };

type SptpubEventDesc = {
  scheduled?: number;
  type?: string;
  sport?: string;
  category?: string;
  tournament?: string;
  competitors?: SptpubCompetitor[];
};

type SptpubOutcome = { k?: string };

type SptpubEventNode = {
  desc?: SptpubEventDesc;
  markets?: Record<string, Record<string, Record<string, SptpubOutcome>>>;
};

type SptpubPage = {
  version?: number;
  events?: Record<string, SptpubEventNode | null>;
  tournaments?: Record<string, { name?: string; category_id?: string } | null>;
  categories?: Record<string, { name?: string } | null>;
  top_events_versions?: number[];
  rest_events_versions?: number[];
};

export type BetboomOdd = {
  id: string;
  outcomeId: string;
  selection: BetboomSelection;
  price: number;
};

export type BetboomEvent = {
  id: string;
  startsAt: string;
  homeTeam: string | null;
  awayTeam: string | null;
  tournamentId: string | null;
  tournamentName: string | null;
  categoryName: string | null;
  odds: BetboomOdd[];
};

function parsePrice(value: unknown) {
  const price = Number(value);
  return Number.isFinite(price) && price > 1 ? price : null;
}

export class BetboomClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: BetboomBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      origin: new URL(config.referer).origin,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
    };
  }

  private fetchPage(version: number | string) {
    return httpClient<SptpubPage>({
      url: new URL(`v4/prematch/brand/${this.config.brandId}/${this.config.locale}/${version}`, this.config.apiBaseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 30_000,
      maxRetries: 2
    });
  }

  async getPrematchFootballEvents(): Promise<BetboomEvent[]> {
    const manifest = await this.fetchPage(0);
    const versions = [...(manifest.top_events_versions ?? []), ...(manifest.rest_events_versions ?? [])];
    if (!versions.length) return [];

    const pages = await Promise.all(versions.map((version) => this.fetchPage(version)));

    const tournaments = new Map<string, { name?: string; category_id?: string }>();
    const categories = new Map<string, { name?: string }>();
    for (const page of pages) {
      for (const [id, tournament] of Object.entries(page.tournaments ?? {})) {
        if (tournament) tournaments.set(id, tournament);
      }
      for (const [id, category] of Object.entries(page.categories ?? {})) {
        if (category) categories.set(id, category);
      }
    }

    const events = new Map<string, BetboomEvent>();
    for (const page of pages) {
      for (const [eventId, node] of Object.entries(page.events ?? {})) {
        const desc = node?.desc;
        if (!desc || desc.sport !== FOOTBALL_SPORT_ID || !desc.scheduled) continue;

        const [home, away] = desc.competitors ?? [];
        const moneyline = node?.markets?.[MONEYLINE_MARKET_ID]?.[""];
        if (!moneyline) continue;

        const odds: BetboomOdd[] = [];
        for (const [outcomeId, outcome] of Object.entries(moneyline)) {
          const selection = MONEYLINE_SELECTION_BY_OUTCOME[outcomeId];
          const price = parsePrice(outcome?.k);
          if (!selection || price === null) continue;
          odds.push({ id: `${eventId}:${MONEYLINE_MARKET_ID}:${outcomeId}`, outcomeId, selection, price });
        }
        if (!odds.length) continue;

        const tournament = desc.tournament ? tournaments.get(desc.tournament) : undefined;
        const categoryId = desc.category ?? tournament?.category_id ?? null;

        events.set(eventId, {
          id: eventId,
          startsAt: new Date(desc.scheduled * 1000).toISOString(),
          homeTeam: home?.name?.trim() || null,
          awayTeam: away?.name?.trim() || null,
          tournamentId: desc.tournament ?? null,
          tournamentName: tournament?.name?.trim() || null,
          categoryName: (categoryId ? categories.get(categoryId)?.name?.trim() : null) || null,
          odds
        });
      }
    }

    return [...events.values()];
  }
}

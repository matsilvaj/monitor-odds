import type { BetfairBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type BetfairSearchResult = {
  __typename?: string;
  urn?: string;
  url?: string;
  sportevent?: {
    name?: string;
    openDate?: string;
    competition?: {
      name?: string;
      competitionId?: number;
      sport?: {
        name?: string;
        sportId?: number;
      };
    };
    sport?: {
      name?: string;
      sportId?: number;
    };
  };
};

export type BetfairRunner = {
  runnerURN?: string;
  name?: string;
  selectionId?: number;
  resultType?: "HOME" | "DRAW" | "AWAY" | string;
};

export type BetfairRunnerLiveData = {
  selectionId?: number;
  runnerStatus?: string;
  displayOdds?: {
    decimal?: number;
  };
  odds?: {
    decimal?: number;
  };
};

export type BetfairMarket = {
  urn?: string;
  name?: string;
  marketType?: string;
  liveData?: {
    sportsbookMarketStatus?: string;
    inplay?: boolean;
    runners?: BetfairRunnerLiveData[];
  };
  hierarchy?: {
    sportevent?: {
      eventId?: number;
      name?: string;
      openDate?: string;
      competition?: {
        name?: string;
      };
    };
  };
  runners?: BetfairRunner[];
  [key: string]: unknown;
};

export type BetfairMarketWithContext = {
  groupTitle: string | null;
  market: BetfairMarket;
};

type SearchResponse = {
  data?: {
    Search?: {
      results?: BetfairSearchResult[];
    };
  };
};

type CardsResponse = {
  data?: {
    Cards?: unknown[];
  };
};

const SEARCH_DOCUMENT_ID = "SearchView#13b532dd425df596ca31f05a35aed9b2";
const CARD_DOCUMENT_ID = "Card#2cb9a894754301e94e941b59a9fe938f";
const EXPERIMENTS = [
  { id: "uki_safety_rti_10k_stakes", variant: "display" },
  { id: "cms-int-bf-br-player-widget-experiment", variant: "control" }
];
const MARKET_TEMPLATE_URNS = [
  "Z-KJShEAACIAkTdu",
  "ZxDkyRIAACAAf2za",
  "aZxLFhAAACMAuJnT",
  "ZxDkzxIAACIAf2zo"
];

function preferences() {
  return {
    userProducts: ["SPORTSBOOK", "GAMES"],
    favoriteSports: []
  };
}

function isMoneylineMarketType(value: unknown) {
  return value === "MATCH_ODDS" || value === "FULL_TIME_RESULT_-_2_UP";
}

function collectMoneylineMarkets(value: unknown, groupTitle: string | null, output: BetfairMarketWithContext[]) {
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (isMoneylineMarketType(record.marketType)) {
    output.push({ groupTitle, market: record as BetfairMarket });
  }

  if (Array.isArray(value)) {
    for (const item of value) collectMoneylineMarkets(item, groupTitle, output);
    return;
  }

  for (const child of Object.values(record)) {
    collectMoneylineMarkets(child, groupTitle, output);
  }
}

export class BetfairClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: BetfairBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  async search(query: string) {
    const data = await httpClient<SearchResponse>({
      url: this.apiUrl(),
      method: "POST",
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      json: {
        variables: {
          query,
          preferences: preferences(),
          productExclusions: [],
          experiments: EXPERIMENTS
        },
        documentId: SEARCH_DOCUMENT_ID
      },
      timeoutMs: 15_000,
      maxRetries: 1
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("HTTP 404 ")) {
        return {} as SearchResponse;
      }

      throw error;
    });

    return (data.data?.Search?.results ?? []).filter((result) => result?.__typename === "EventView" && result.sportevent?.sport?.sportId === 1);
  }

  async getMatchOdds(eventId: number, eventUrl: string) {
    const urn = MARKET_TEMPLATE_URNS.map((template) => (
      template === "aZxLFhAAACMAuJnT"
        ? `ppb:tbd:cardgroup:swimlane:${template}/e/${eventId}`
        : `ppb:tbd:cardgroup:pebble:marketTemplateEvent:${template}/e/${eventId}`
    ));
    const data = await httpClient<CardsResponse>({
      url: this.apiUrl(`currentViewUrn=ppb%3Atbd%3Aview%3Aevent%3A${eventId}`),
      method: "POST",
      headers: this.headers,
      referer: new URL(`apostas/${eventUrl}`, this.config.baseUrl).href,
      engine: this.config.engine,
      json: {
        variables: {
          urn,
          numberOfFilledCardsInCardGroup: 2,
          preferences: preferences(),
          productExclusions: [],
          experiments: EXPERIMENTS
        },
        documentId: CARD_DOCUMENT_ID
      },
      timeoutMs: 15_000,
      maxRetries: 1
    });

    const markets: BetfairMarketWithContext[] = [];
    for (const card of data.data?.Cards ?? []) {
      const record = card && typeof card === "object" ? card as Record<string, unknown> : {};
      const titleRecord = record.pebbleCardGroupTitle && typeof record.pebbleCardGroupTitle === "object" ? record.pebbleCardGroupTitle as Record<string, unknown> : {};
      const groupTitle = typeof titleRecord.translated === "string" ? titleRecord.translated : null;
      collectMoneylineMarkets(card, groupTitle, markets);
    }

    return markets;
  }

  private apiUrl(query?: string) {
    const params = new URLSearchParams({ _ak: this.config.appKey });
    const base = new URL(`${this.config.apiBaseUrl}?${params}`);
    if (query) return `${base.href}&${query}`;
    return base;
  }
}

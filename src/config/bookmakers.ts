import { env } from "./env.js";

export type BookmakerHttpEngine = "fetch" | "got-scraping";

export type AltenarBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "altenar";
  integration: string;
  baseUrl: string;
  origin: string;
  referer: string;
  engine: BookmakerHttpEngine;
};

export type SportingbetBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "sportingbet";
  baseUrl: string;
  accessId: string;
  referer: string;
  take: number;
  engine: BookmakerHttpEngine;
};

export type SportybetBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "sportybet";
  baseUrl: string;
  referer: string;
  pageSize: number;
  maxPages: number;
  engine: BookmakerHttpEngine;
};

export type VaidebetBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "vaidebet";
  baseUrl: string;
  deltaApiBaseUrl?: string;
  referer: string;
  routeSegment: string;
  languageId: number;
  brand: string;
  engine: BookmakerHttpEngine;
};

export type SuperbetBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "superbet";
  baseUrl: string;
  referer: string;
  language: string;
  sportId: number;
  engine: BookmakerHttpEngine;
};

export type NovibetBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "novibet";
  baseUrl: string;
  referer: string;
  contentGroupId: number;
  rootLocationId: number;
  engine: BookmakerHttpEngine;
};

export type BetanoBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "betano";
  baseUrl: string;
  referer: string;
  engine: BookmakerHttpEngine;
};

export type ApostabetBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "apostabet";
  baseUrl: string;
  apiBaseUrl: string;
  frontbackBaseUrl: string;
  referer: string;
  engine: BookmakerHttpEngine;
};

export type Bet7kBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "bet7k";
  baseUrl: string;
  apiBaseUrl: string;
  referer: string;
  engine: BookmakerHttpEngine;
};

export type BetfastBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "betfast";
  baseUrl: string;
  apiBaseUrl: string;
  referer: string;
  companyId: number;
  language: string;
  engine: BookmakerHttpEngine;
};

export type KtoBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "kto";
  baseUrl: string;
  apiBaseUrl: string;
  referer: string;
  engine: BookmakerHttpEngine;
};

export type Bet365BookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "bet365";
  baseUrl: string;
  chromeProfileDir: string;
  chromeExecutablePath?: string;
  manualFallback: boolean;
  navigationTimeoutMs: number;
};

export type MeridianbetBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "meridianbet";
  baseUrl: string;
  chromeProfileDir: string;
  chromeExecutablePath?: string;
  navigationTimeoutMs: number;
};

export type BetfairBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "betfair";
  baseUrl: string;
  apiBaseUrl: string;
  referer: string;
  appKey: string;
  engine: BookmakerHttpEngine;
};

export type BetesporteBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "betesporte";
  baseUrl: string;
  referer: string;
  engine: BookmakerHttpEngine;
};

export type BetnacionalBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "betnacional";
  baseUrl: string;
  apiBaseUrl: string;
  searchBaseUrl: string;
  referer: string;
  engine: BookmakerHttpEngine;
};

export type BetmgmBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "betmgm";
  baseUrl: string;
  apiBaseUrl: string;
  referer: string;
  engine: BookmakerHttpEngine;
};

export type CasaDeApostasBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "casadeapostas";
  baseUrl: string;
  referer: string;
  languageId: number;
  engine: BookmakerHttpEngine;
};

export type SegurobetBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "segurobet";
  baseUrl: string;
  referer: string;
  swarmUrl: string;
  siteId: number;
  source: number;
  language: string;
  engine: BookmakerHttpEngine;
};

export type BetboomBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "betboom";
  baseUrl: string;
  referer: string;
  wsUrl: string;
};

export type TradeballBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "tradeball";
  baseUrl: string;
  dballBaseUrl: string;
  exchangeApiBaseUrl: string;
  referer: string;
  sportId: string;
  perPage: number;
  maxPages: number;
  engine: BookmakerHttpEngine;
};

export type VersusbetBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "versusbet";
  baseUrl: string;
  cdnBaseUrl: string;
  referer: string;
  language: string;
  engine: BookmakerHttpEngine;
};

export type BookmakerConfig =
  | AltenarBookmakerConfig
  | SportingbetBookmakerConfig
  | SportybetBookmakerConfig
  | VaidebetBookmakerConfig
  | SuperbetBookmakerConfig
  | NovibetBookmakerConfig
  | BetanoBookmakerConfig
  | ApostabetBookmakerConfig
  | Bet7kBookmakerConfig
  | BetfastBookmakerConfig
  | KtoBookmakerConfig
  | Bet365BookmakerConfig
  | MeridianbetBookmakerConfig
  | BetfairBookmakerConfig
  | BetesporteBookmakerConfig
  | BetnacionalBookmakerConfig
  | BetmgmBookmakerConfig
  | CasaDeApostasBookmakerConfig
  | SegurobetBookmakerConfig
  | BetboomBookmakerConfig
  | TradeballBookmakerConfig
  | VersusbetBookmakerConfig;

export const BOOKMAKERS: BookmakerConfig[] = [
  {
    slug: "esportiva",
    name: "Esportiva",
    enabled: true,
    provider: "altenar",
    integration: "esportiva",
    baseUrl: env.ALTENAR_BASE_URL,
    origin: "https://esportiva.bet.br",
    referer: "https://esportiva.bet.br/",
    engine: "fetch"
  },
  {
    slug: "estrelabet",
    name: "EstrelaBet",
    enabled: true,
    provider: "altenar",
    integration: "estrelabet",
    baseUrl: env.ALTENAR_BASE_URL,
    origin: "https://www.estrelabet.bet.br",
    referer: "https://www.estrelabet.bet.br/",
    engine: "fetch"
  },
  {
    slug: "br4bet",
    name: "BR4Bet",
    enabled: true,
    provider: "altenar",
    integration: "br4bet",
    baseUrl: env.ALTENAR_BASE_URL,
    origin: "https://br4.bet.br",
    referer: "https://br4.bet.br/",
    engine: "fetch"
  },
  {
    slug: "lotogreen",
    name: "LotoGreen",
    enabled: true,
    provider: "altenar",
    integration: "lotogreen",
    baseUrl: env.ALTENAR_BASE_URL,
    origin: "https://lotogreen.bet.br",
    referer: "https://lotogreen.bet.br/",
    engine: "fetch"
  },
  {
    slug: "jogodeouro",
    name: "Jogo de Ouro",
    enabled: true,
    provider: "altenar",
    integration: "jogodeouro",
    baseUrl: env.ALTENAR_BASE_URL,
    origin: "https://jogodeouro.bet.br",
    referer: "https://jogodeouro.bet.br/",
    engine: "fetch"
  },
  {
    slug: "vupibet",
    name: "VupiBet",
    enabled: true,
    provider: "altenar",
    integration: "vupi",
    baseUrl: env.ALTENAR_BASE_URL,
    origin: "https://www.vupi.bet.br",
    referer: "https://www.vupi.bet.br/",
    engine: "fetch"
  },
  {
    slug: "sportingbet",
    name: "Sportingbet",
    enabled: true,
    provider: "sportingbet",
    baseUrl: "https://www.sportingbet.bet.br/",
    accessId: "YTRhMjczYjctNTBlNy00MWZlLTliMGMtMWNkOWQxMThmZTI2",
    referer: "https://www.sportingbet.bet.br/pt-br/sports/futebol-4",
    take: 200,
    engine: "got-scraping"
  },
  {
    slug: "sportybet",
    name: "SportyBet",
    enabled: true,
    provider: "sportybet",
    baseUrl: "https://www.sporty.bet.br/",
    referer: "https://www.sporty.bet.br/br/sport/football",
    pageSize: 100,
    maxPages: 20,
    engine: "fetch"
  },
  {
    slug: "vaidebet",
    name: "VaiDeBet",
    enabled: true,
    provider: "vaidebet",
    baseUrl: "https://vaidebet.bet.br/",
    deltaApiBaseUrl: "https://delta-sb.ngbras.com/",
    referer: "https://vaidebet.bet.br/",
    routeSegment: "d",
    languageId: 23,
    brand: "vaidebet",
    engine: "fetch"
  },
  {
    slug: "esportesdasorte",
    name: "Esportes da Sorte",
    enabled: true,
    provider: "vaidebet",
    baseUrl: "https://esportesdasorte.bet.br/",
    referer: "https://esportesdasorte.bet.br/",
    routeSegment: "null",
    languageId: 23,
    brand: "esportesdasortevip",
    engine: "fetch"
  },
  {
    slug: "superbet",
    name: "Superbet",
    enabled: true,
    provider: "superbet",
    baseUrl: "https://production-superbet-offer-br.freetls.fastly.net/",
    referer: "https://superbet.bet.br/",
    language: "pt-BR",
    sportId: 5,
    engine: "fetch"
  },
  {
    slug: "novibet",
    name: "Novibet",
    enabled: true,
    provider: "novibet",
    baseUrl: "https://www.novibet.bet.br/",
    referer: "https://www.novibet.bet.br/apostas-esportivas/futebol/4372606",
    contentGroupId: 4324,
    rootLocationId: 4372606,
    engine: "got-scraping"
  },
  {
    slug: "betano",
    name: "Betano",
    enabled: true,
    provider: "betano",
    baseUrl: "https://www.betano.bet.br/",
    referer: "https://www.betano.bet.br/sport/futebol/",
    engine: "got-scraping"
  },
  {
    slug: "apostabet",
    name: "Aposta Bet",
    enabled: true,
    provider: "apostabet",
    baseUrl: "https://aposta.bet.br/",
    apiBaseUrl: "https://sportsbook.aposta.bet.br/",
    frontbackBaseUrl: "https://sportsbook-frontback.aposta.bet.br/",
    referer: "https://aposta.bet.br/esportes",
    engine: "fetch"
  },
  {
    slug: "bet7k",
    name: "Bet7k",
    enabled: true,
    provider: "bet7k",
    baseUrl: "https://7k.bet.br/",
    apiBaseUrl: "https://prod20350-kbet-152319626.fssb.io/",
    referer: "https://prod20350-kbet-152319626.fssb.io/br-pt/spbkv4?operatorToken=logout",
    engine: "got-scraping"
  },
  {
    slug: "betvip",
    name: "BetVIP",
    enabled: true,
    provider: "bet7k",
    baseUrl: "https://betvip.bet.br/",
    apiBaseUrl: "https://prod20524.fssb.io/",
    referer: "https://prod20524.fssb.io/br-pt/spbkv4?operatorToken=logout",
    engine: "got-scraping"
  },
  {
    slug: "betfast",
    name: "BetFast",
    enabled: true,
    provider: "betfast",
    baseUrl: "https://betfast.bet.br/",
    apiBaseUrl: "https://analytics-sp.googleserv.tech/",
    referer: "https://betfast.bet.br/",
    companyId: 99,
    language: "br",
    engine: "fetch"
  },
  {
    slug: "kto",
    name: "KTO",
    enabled: true,
    provider: "kto",
    baseUrl: "https://www.kto.bet.br/",
    apiBaseUrl: "https://us.offering-api.kambicdn.com/offering/v2018/ktobr/",
    referer: "https://www.kto.bet.br/esportes/",
    engine: "fetch"
  },
  {
    slug: "bet365",
    name: "bet365",
    enabled: true,
    provider: "bet365",
    baseUrl: env.BET365_BASE_URL,
    chromeProfileDir: env.BET365_CHROME_PROFILE_DIR,
    chromeExecutablePath: env.BET365_CHROME_EXECUTABLE,
    manualFallback: env.BET365_MANUAL_FALLBACK,
    navigationTimeoutMs: env.BET365_NAVIGATION_TIMEOUT_MS
  },
  {
    slug: "meridianbet",
    name: "MeridianBet",
    enabled: true,
    provider: "meridianbet",
    baseUrl: env.MERIDIANBET_BASE_URL,
    chromeProfileDir: env.MERIDIANBET_CHROME_PROFILE_DIR,
    chromeExecutablePath: env.MERIDIANBET_CHROME_EXECUTABLE,
    navigationTimeoutMs: env.MERIDIANBET_NAVIGATION_TIMEOUT_MS
  },
  {
    slug: "betfair",
    name: "Betfair",
    enabled: true,
    provider: "betfair",
    baseUrl: "https://www.betfair.bet.br/",
    apiBaseUrl: "https://apitbd.betfair.bet.br/api/tbd/bff-gql/v11/",
    referer: "https://www.betfair.bet.br/apostas/",
    appKey: "K61C39rIC0WKzoQ7",
    engine: "fetch"
  },
  {
    slug: "betesporte",
    name: "Betesporte",
    enabled: true,
    provider: "betesporte",
    baseUrl: "https://betesporte.bet.br/",
    referer: "https://betesporte.bet.br/",
    engine: "fetch"
  },
  {
    slug: "betnacional",
    name: "Betnacional",
    enabled: true,
    provider: "betnacional",
    baseUrl: "https://betnacional.bet.br/",
    apiBaseUrl: "https://prod-global-bff-events.bet6.com.br/",
    searchBaseUrl: "https://prod-search-svc.bet6.com.br/",
    referer: "https://betnacional.bet.br/sports/1",
    engine: "got-scraping"
  },
  {
    slug: "betmgm",
    name: "BetMGM",
    enabled: true,
    provider: "betmgm",
    baseUrl: "https://www.betmgm.bet.br/",
    apiBaseUrl: "https://br-program-api.goldrush.llc/",
    referer: "https://www.betmgm.bet.br/aposta-esportiva",
    engine: "fetch"
  },
  {
    slug: "casadeapostas",
    name: "Casa de Apostas",
    enabled: true,
    provider: "casadeapostas",
    baseUrl: "https://casadeapostas.bet.br/",
    referer: "https://casadeapostas.bet.br/br/sports",
    languageId: 21,
    engine: "got-scraping"
  },
  {
    slug: "segurobet",
    name: "SeguroBet",
    enabled: true,
    provider: "segurobet",
    baseUrl: "https://www.seguro.bet.br/",
    referer: "https://www.seguro.bet.br/esportes/match",
    swarmUrl: "wss://eu-swarm-springre.trexname.com/",
    siteId: 1866308,
    source: 42,
    language: "pt-br",
    engine: "fetch"
  },
  {
    slug: "betboom",
    name: "BetBoom",
    enabled: true,
    provider: "betboom",
    baseUrl: "https://betboom.bet.br/",
    referer: "https://betboom.bet.br/sport/football/",
    wsUrl: "wss://com-br-ws.sporthub.bet:444/api/tree_ws/v1"
  },
  {
    slug: "tradeball",
    name: "Tradeball",
    enabled: true,
    provider: "tradeball",
    baseUrl: "https://fulltbet.bet.br/",
    dballBaseUrl: "https://tradeball.fulltbet.bet.br/",
    exchangeApiBaseUrl: "https://mexchange-api.fulltbet.bet.br/",
    referer: "https://tradeball.fulltbet.bet.br/dballTradingFeed",
    sportId: "15",
    perPage: 50,
    maxPages: 5,
    engine: "fetch"
  },
  {
    slug: "versusbet",
    name: "VersusBet",
    enabled: true,
    provider: "versusbet",
    baseUrl: "https://www.versus.bet.br/",
    cdnBaseUrl: "https://sportswidget-cdn.versus.bet.br/",
    referer: "https://www.versus.bet.br/esportes/sports/soccer",
    language: "pt_BR",
    engine: "fetch"
  }
];

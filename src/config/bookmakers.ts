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

export type BookmakerConfig =
  | AltenarBookmakerConfig
  | SportingbetBookmakerConfig
  | SportybetBookmakerConfig
  | VaidebetBookmakerConfig
  | SuperbetBookmakerConfig
  | NovibetBookmakerConfig
  | BetanoBookmakerConfig
  | BetfairBookmakerConfig
  | BetesporteBookmakerConfig
  | BetnacionalBookmakerConfig
  | BetmgmBookmakerConfig
  | CasaDeApostasBookmakerConfig
  | SegurobetBookmakerConfig;

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
  }
];

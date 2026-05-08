import { env } from "./env.js";

export type AltenarBookmakerConfig = {
  slug: string;
  name: string;
  enabled: boolean;
  provider: "altenar";
  integration: string;
  baseUrl: string;
  origin: string;
  referer: string;
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
  seasonNamePatterns: string[];
  fallbackLeagueCardPath?: string;
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
  leagueNamePatterns: string[];
  leagueMappings: Array<{
    fixtureLeagueSlug: string;
    sourcePattern: string;
  }>;
};

export type BookmakerConfig =
  | AltenarBookmakerConfig
  | SportingbetBookmakerConfig
  | SportybetBookmakerConfig
  | VaidebetBookmakerConfig
  | SuperbetBookmakerConfig;

export const BOOKMAKERS: BookmakerConfig[] = [
  {
    slug: "esportiva",
    name: "Esportiva",
    enabled: true,
    provider: "altenar",
    integration: "esportiva",
    baseUrl: env.ALTENAR_BASE_URL,
    origin: "https://esportiva.bet.br",
    referer: "https://esportiva.bet.br/"
  },
  {
    slug: "estrelabet",
    name: "EstrelaBet",
    enabled: true,
    provider: "altenar",
    integration: "estrelabet",
    baseUrl: env.ALTENAR_BASE_URL,
    origin: "https://www.estrelabet.bet.br",
    referer: "https://www.estrelabet.bet.br/"
  },
  {
    slug: "sportingbet",
    name: "Sportingbet",
    enabled: true,
    provider: "sportingbet",
    baseUrl: "https://www.sportingbet.bet.br/",
    accessId: "YTRhMjczYjctNTBlNy00MWZlLTliMGMtMWNkOWQxMThmZTI2",
    referer: "https://www.sportingbet.bet.br/pt-br/sports/futebol-4",
    take: 200
  },
  {
    slug: "sportybet",
    name: "SportyBet",
    enabled: true,
    provider: "sportybet",
    baseUrl: "https://www.sporty.bet.br/",
    referer: "https://www.sporty.bet.br/br/sport/football",
    pageSize: 100,
    maxPages: 20
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
    seasonNamePatterns: [
      "CONMEBOL Libertadores|Copa Libertadores",
      "Brasileiro Série A|Brasileirão Série A",
      "UEFA Europa League",
      "Premier League Inglaterra",
      "Bundesliga Alemanha",
      "La Liga 25/26|LaLiga Espanha",
      "Série A 25/26|Serie A Italia",
      "Liga 1 França",
      "Liga Portugal"
    ],
    fallbackLeagueCardPath:
      "api-v2/league-card/d/23/vaidebet/821269-823262-828788-830734-829881-831574-831977-833913-818206-817472-833507-834748-819675-833646/eyJyZXF1ZXN0Qm9keSI6eyJzZWFzb25JZHMiOls4MjEyNjksODIzMjYyLDgyODc4OCw4MzA3MzQsODI5ODgxLDgzMTU3NCw4MzE5NzcsODMzOTEzLDgxODIwNiw4MTc0NzIsODMzNTA3LDgzNDc0OCw4MTk2NzUsODMzNjQ2XX19"
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
    seasonNamePatterns: [
      "CONMEBOL Libertadores|Copa Libertadores",
      "Brasileiro Série A|Brasileirão Série A",
      "UEFA Europa League",
      "Premier League Inglaterra",
      "Bundesliga Alemanha",
      "La Liga 25/26|LaLiga Espanha",
      "Série A 25/26|Serie A Italia",
      "Liga 1 França",
      "Liga Portugal"
    ],
    fallbackLeagueCardPath:
      "api-v2/league-card/null/23/esportesdasortevip/853558-828788-830734-829881-831574-833507-853604-818206-833913-853963-854167-831977-857258-771389-853363/eyJyZXF1ZXN0Qm9keSI6eyJzZWFzb25JZHMiOls4NTM1NTgsODI4Nzg4LDgzMDczNCw4Mjk4ODEsODMxNTc0LDgzMzUwNyw4NTM2MDQsODE4MjA2LDgzMzkxMyw4NTM5NjMsODU0MTY3LDgzMTk3Nyw4NTcyNTgsNzcxMzg5LDg1MzM2M119fQ=="
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
    leagueNamePatterns: [
      "CONMEBOL Libertadores|Copa Libertadores",
      "Brasileiro Série A|Brasileirão Série A|Brazil - Serie A|Brasil - Série A",
      "UEFA Europa League|Europa League",
      "Premier League|Inglaterra - Premiership",
      "Bundesliga|Alemanha - Bundesliga",
      "La Liga|Espanha - La Liga",
      "Serie A|Série A|Itália - Série A",
      "Ligue 1|Liga 1|França - Ligue 1"
    ],
    leagueMappings: [
      { fixtureLeagueSlug: "libertadores", sourcePattern: "CONMEBOL Libertadores|Copa Libertadores" },
      { fixtureLeagueSlug: "brasileirao", sourcePattern: "Brasil - Brasileiro - Série A|Brazil - Serie A" },
      { fixtureLeagueSlug: "europa-league", sourcePattern: "UEFA Europa League|Europa League" },
      { fixtureLeagueSlug: "premier-league", sourcePattern: "Inglaterra - Premier League|Inglaterra - Premiership|England - Premier League" },
      { fixtureLeagueSlug: "bundesliga", sourcePattern: "Alemanha - Bundesliga$|Germany - Bundesliga$" },
      { fixtureLeagueSlug: "la-liga", sourcePattern: "Espanha - LaLiga$|Spain - LaLiga$|Espanha - La Liga$|Spain - La Liga$" },
      { fixtureLeagueSlug: "serie-a", sourcePattern: "Itália - Série A$|Italy - Serie A$" },
      { fixtureLeagueSlug: "ligue-1", sourcePattern: "França - Ligue 1$|France - Ligue 1$" }
    ]
  }
];

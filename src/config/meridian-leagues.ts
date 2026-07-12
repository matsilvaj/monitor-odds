export type MeridianLeagueConfig = {
  id: number;
  name: string;
  url: string | null;
};

export const MERIDIAN_LEAGUES: Record<number, MeridianLeagueConfig> = {
  1: { id: 1, name: "Copa do Mundo", url: "https://meridianbet.bet.br/ca/esportes/futebol/mundo/copa-do-mundo-2026?leagueIds=176327" },
  2: { id: 2, name: "Champions League - Classificatórias", url: "https://meridianbet.bet.br/ca/esportes/futebol/europa/liga-dos-campe%C3%B5es?leagueIds=84" },
  3: { id: 3, name: "Europa League", url: "https://meridianbet.bet.br/ca/esportes/futebol/europa/liga-europa?leagueIds=86" },
  10: { id: 10, name: "Friendlies", url: "https://meridianbet.bet.br/ca/esportes/futebol/mundo/amistosos-internacionais?leagueIds=106" },
  11: { id: 11, name: "Copa Sul-Americana", url: "https://meridianbet.bet.br/ca/esportes/futebol/am%C3%A9rica-do-sul/sudamericana?leagueIds=417" },
  13: { id: 13, name: "Libertadores", url: "https://meridianbet.bet.br/ca/esportes/futebol/am%C3%A9rica-do-sul/copa-libertadores?leagueIds=231" },
  39: { id: 39, name: "Premier League", url: "https://meridianbet.bet.br/ca/esportes/futebol/inglaterra/premier-league?leagueIds=80" },
  40: { id: 40, name: "Championship", url: "https://meridianbet.bet.br/ca/esportes/futebol/inglaterra/campeonato?leagueIds=122" },
  61: { id: 61, name: "Ligue 1", url: "https://meridianbet.bet.br/ca/esportes/futebol/fran%C3%A7a/ligue-1?leagueIds=87" },
  66: { id: 66, name: "Coupe de France", url: "https://meridianbet.bet.br/ca/esportes/futebol/fran%C3%A7a/copa-da-fran%C3%A7a?leagueIds=221" },
  71: { id: 71, name: "Brasileirao", url: "https://meridianbet.bet.br/ca/esportes/futebol/brasil/s%C3%A9rie-a?leagueIds=89" },
  72: { id: 72, name: "Brasileirao Serie B", url: "https://meridianbet.bet.br/ca/esportes/futebol/brasil/s%C3%A9rie-b?leagueIds=90" },
  73: { id: 73, name: "Copa do Brasil", url: "https://meridianbet.bet.br/ca/esportes/futebol/brasil/copa-do-brasil?leagueIds=217" },
  78: { id: 78, name: "Bundesliga", url: "https://meridianbet.bet.br/ca/esportes/futebol/alemanha/bundesliga?leagueIds=107" },
  79: { id: 79, name: "2. Bundesliga", url: "https://meridianbet.bet.br/ca/esportes/futebol/alemanha/2.-bundesliga?leagueIds=108" },
  81: { id: 81, name: "DFB Pokal", url: "https://meridianbet.bet.br/ca/esportes/futebol/alemanha/dfb-pokal?leagueIds=235" },
  88: { id: 88, name: "Eredivisie", url: "https://meridianbet.bet.br/ca/esportes/futebol/holanda/eredivisie?leagueIds=125" },
  94: { id: 94, name: "Primeira Liga", url: "https://meridianbet.bet.br/ca/esportes/futebol/portugu%C3%AAs/" },
  119: { id: 119, name: "Danish Superliga", url: "https://meridianbet.bet.br/ca/esportes/futebol/dinamarca/superliga?leagueIds=133" },
  128: { id: 128, name: "Argentina Primera Division", url: "https://meridianbet.bet.br/ca/esportes/futebol/argentina/liga-profissional?leagueIds=174077" },
  136: { id: 136, name: "Serie B Itália", url: "https://meridianbet.bet.br/ca/esportes/futebol/it%C3%A1lia/serie-b?leagueIds=96" },
  141: { id: 141, name: "La Liga 2", url: "https://meridianbet.bet.br/ca/esportes/futebol/espanha/la-liga-2?leagueIds=93" },
  179: { id: 179, name: "Premiership Escócia", url: "https://meridianbet.bet.br/ca/esportes/futebol/esc%C3%B3cia/premiership?leagueIds=145" },
  181: { id: 181, name: "Scottish FA Cup", url: "https://meridianbet.bet.br/ca/esportes/futebol/esc%C3%B3cia/cup?leagueIds=244" },
  253: { id: 253, name: "MLS", url: "https://meridianbet.bet.br/ca/esportes/futebol/estados-unidos/major-league-soccer?leagueIds=284" },
  848: { id: 848, name: "Conference League", url: "https://meridianbet.bet.br/ca/esportes/futebol/europa/confer%C3%AAncia-liga-europa?leagueIds=173762" }
};

export type LeagueConfig = {
  slug: string;
  name: string;
  apiFootballLeagueId: number;
  altenarChampId: number;
};

export const MVP_LEAGUES: LeagueConfig[] = [
  { slug: "europa-league", name: "Europa League", apiFootballLeagueId: 3, altenarChampId: 16809 },
  { slug: "libertadores", name: "Libertadores", apiFootballLeagueId: 13, altenarChampId: 3709 },
  { slug: "brasileirao", name: "Brasileirao", apiFootballLeagueId: 71, altenarChampId: 11318 },
  { slug: "bundesliga", name: "Bundesliga", apiFootballLeagueId: 78, altenarChampId: 2950 },
  { slug: "la-liga", name: "La Liga", apiFootballLeagueId: 140, altenarChampId: 2941 },
  { slug: "premier-league", name: "Premier League", apiFootballLeagueId: 39, altenarChampId: 2936 },
  { slug: "serie-a", name: "Serie A", apiFootballLeagueId: 135, altenarChampId: 2942 },
];

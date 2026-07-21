const TEAM_ALIAS_STOP_WORDS = new Set([
  "fc",
  "cf",
  "sc",
  "ec",
  "ac",
  "ca",
  "cd",
  "sd",
  "ud",
  "club",
  "clube",
  "de",
  "do",
  "da",
  "dos",
  "das",
  "of",
  "and",
  "e",
  "the",
  "real",
  "new",
  "united",
  "city",
  "sub"
]);

const REGION_CODES = [
  "AF",
  "AX",
  "AL",
  "DZ",
  "AS",
  "AD",
  "AO",
  "AI",
  "AG",
  "AR",
  "AM",
  "AW",
  "AU",
  "AT",
  "AZ",
  "BS",
  "BH",
  "BD",
  "BB",
  "BY",
  "BE",
  "BZ",
  "BJ",
  "BM",
  "BT",
  "BO",
  "BA",
  "BW",
  "BR",
  "VG",
  "BN",
  "BG",
  "BF",
  "BI",
  "KH",
  "CM",
  "CA",
  "CV",
  "KY",
  "CF",
  "TD",
  "CL",
  "CN",
  "CO",
  "KM",
  "CG",
  "CD",
  "CK",
  "CR",
  "CI",
  "HR",
  "CU",
  "CW",
  "CY",
  "CZ",
  "DK",
  "DJ",
  "DM",
  "DO",
  "EC",
  "EG",
  "SV",
  "GQ",
  "ER",
  "EE",
  "SZ",
  "ET",
  "FO",
  "FJ",
  "FI",
  "FR",
  "GF",
  "PF",
  "GA",
  "GM",
  "GE",
  "DE",
  "GH",
  "GI",
  "GR",
  "GL",
  "GD",
  "GP",
  "GU",
  "GT",
  "GG",
  "GN",
  "GW",
  "GY",
  "HT",
  "HN",
  "HK",
  "HU",
  "IS",
  "IN",
  "ID",
  "IR",
  "IQ",
  "IE",
  "IM",
  "IL",
  "IT",
  "JM",
  "JP",
  "JE",
  "JO",
  "KZ",
  "KE",
  "KI",
  "XK",
  "KW",
  "KG",
  "LA",
  "LV",
  "LB",
  "LS",
  "LR",
  "LY",
  "LI",
  "LT",
  "LU",
  "MO",
  "MG",
  "MW",
  "MY",
  "MV",
  "ML",
  "MT",
  "MQ",
  "MR",
  "MU",
  "YT",
  "MX",
  "MD",
  "MC",
  "MN",
  "ME",
  "MS",
  "MA",
  "MZ",
  "MM",
  "NA",
  "NP",
  "NL",
  "NC",
  "NZ",
  "NI",
  "NE",
  "NG",
  "NU",
  "MK",
  "KP",
  "MP",
  "NO",
  "OM",
  "PK",
  "PS",
  "PA",
  "PG",
  "PY",
  "PE",
  "PH",
  "PL",
  "PT",
  "PR",
  "QA",
  "RE",
  "RO",
  "RU",
  "RW",
  "BL",
  "SH",
  "KN",
  "LC",
  "MF",
  "PM",
  "VC",
  "WS",
  "SM",
  "ST",
  "SA",
  "SN",
  "RS",
  "SC",
  "SL",
  "SG",
  "SX",
  "SK",
  "SI",
  "SB",
  "SO",
  "ZA",
  "KR",
  "SS",
  "ES",
  "LK",
  "SD",
  "SR",
  "SE",
  "CH",
  "SY",
  "TW",
  "TJ",
  "TZ",
  "TH",
  "TL",
  "TG",
  "TO",
  "TT",
  "TN",
  "TR",
  "TM",
  "TC",
  "UG",
  "UA",
  "AE",
  "GB",
  "US",
  "VI",
  "UY",
  "UZ",
  "VU",
  "VA",
  "VE",
  "VN",
  "YE",
  "ZM",
  "ZW"
];

const MANUAL_ALIAS_GROUPS = [
  ["PSG", "Paris Saint Germain", "Paris Saint-Germain"],
  ["Man United", "Man Utd", "Manchester United", "Manchester Utd"],
  ["Man City", "Manchester City"],
  ["Bayern Munich", "Bayern Munchen", "Bayern Muenchen", "Bayern München"],
  ["Inter Milan", "Internazionale", "Internazionale Milano"],
  ["AC Milan", "Milan"],
  ["Atletico Madrid", "Atlético Madrid", "Atleti"],
  ["Athletic Bilbao", "Athletic Club Bilbao", "Athletic Club"],
  ["Real Betis", "Betis"],
  ["Real Sociedad", "Sociedad"],
  ["Tottenham", "Tottenham Hotspur", "Spurs"],
  ["Wolves", "Wolverhampton", "Wolverhampton Wanderers"],
  ["West Ham", "West Ham United"],
  ["Leverkusen", "Bayer Leverkusen"],
  ["Monchengladbach", "Moenchengladbach", "Borussia Monchengladbach", "Borussia Mönchengladbach"],
  ["Koln", "Koeln", "FC Koln", "FC Köln"],
  ["Sporting CP", "Sporting Lisbon", "Sporting Lisboa"],
  ["Benfica", "SL Benfica"],
  ["Porto", "FC Porto"],
  ["Athletico PR", "Athletico Paranaense", "Atletico Paranaense", "Atlético Paranaense"],
  ["Atletico MG", "Atletico Mineiro", "Atlético Mineiro"],
  ["Atletico GO", "Atletico Goianiense", "Atlético Goianiense", "AC Goianiense"],
  ["America MG", "America Mineiro", "América Mineiro"],
  ["FC Iberia 1999", "Iberia 1999", "Saburtalo", "FC Saburtalo", "Saburtalo Tbilisi"],
  ["Gyori ETO FC", "Gyor ETO FC", "Győri ETO FC", "Győr ETO FC"],
  ["Vardar Skopje", "Vardar", "FK Vardar"],
  ["ML Vitebsk", "FC ML Vitebsk", "Maxline Vitebsk", "FC Maxline Vitebsk", "Maxline Rogachev"],
  ["Rigas FS", "RFS", "Riga FS", "Rigas Futbola Skola"],
  ["Vikingur Gota", "Vikingur Gøta", "Vikingur Goeta", "Víkingur Gøta"],
  ["Stjarnan", "Stjarnan Gardabaer", "Stjarnan Gardabaer FC", "Stjarnan Garðabær"],
  ["FK Sarajevo", "Sarajevo"],
  ["Paide", "Paide Linnameeskond", "Paide FC"],
  ["Hegelmann Litauen", "FC Hegelmann", "Hegelmann"],
  ["Levadia Tallinn", "FC Levadia Tallinn", "Levadia"],
  ["Caernarfon Town", "Caernarfon"],
  ["Milsami Orhei", "FC Milsami", "Milsami"],
  ["Velez", "Velez Mostar", "Vele\u017e", "FK Velez Mostar"],
  ["Mornar", "FK Mornar Bar", "Mornar Bar"],
  ["Atletic Club d'Escaldes", "Atl\u00e8tic Club d'Escaldes", "AC d'Escaldes", "Atletic d'Escaldes"],
  ["Zilina", "\u017dilina", "MSK Zilina", "M\u0160K \u017dilina"],
  ["HNK Hajduk Split", "Hajduk Split"],
  ["RB Bragantino", "Bragantino", "Red Bull Bragantino"],
  ["St Louis City", "St. Louis City SC"],
  ["Sporting Kansas City", "Sporting KC", "Kansas City"],
  ["Nashville SC", "Nashville"],
  ["Atlanta United FC", "Atlanta United"],
  ["Los Angeles Galaxy", "LA Galaxy"],
  ["Los Angeles FC", "LAFC"],
  ["Inter Turku", "FC Inter Turku"],
  ["Ferencvarosi TC", "Ferencvaros", "Ferencváros", "FTC"],
  ["Connah's Quay Nomads", "Connahs Quay Nomads", "Connahs Quay", "GAP Connah S Quay FC", "Connah's Quay"],
  ["Dinamo Tirana", "Dinamo City Tirana", "FC Dinamo City", "KS Dinamo de Tirana"],
  ["St Joseph S Fc", "St Josephs FC", "St Joseph's FC", "Saint Josephs FC"],
  ["CRB", "CR Brasil", "CR Brasil AL", "Clube de Regatas Brasil", "Clube de Regatas Brasil AL"],
  ["Nautico Recife", "Nautico PE", "Nautico", "Náutico"],
  ["Novorizontino", "Gremio Novorizontino", "Grêmio Novorizontino"],
  ["Gremio", "Grêmio"],
  ["Sao Paulo", "São Paulo"],
  ["Fluminense", "Fluminense FC"],
  ["England", "Inglaterra"],
  ["Scotland", "Escocia", "Escócia"],
  ["Wales", "Pais de Gales", "País de Gales", "Gales"],
  ["Northern Ireland", "Irlanda do Norte"],
  ["Ireland", "Republic of Ireland", "Irlanda", "Republica da Irlanda", "República da Irlanda"],
  ["United States", "USA", "US", "Estados Unidos", "EUA"],
  ["United Arab Emirates", "UAE", "Emirados Arabes Unidos", "Emirados Árabes Unidos"],
  ["South Korea", "Korea Republic", "Republic of Korea", "Republica da Coreia", "Republica da Coreia do Sul", "Coreia do Sul", "Coreia Sul"],
  ["North Korea", "Korea DPR", "Coreia do Norte", "Coreia Norte"],
  ["Congo DR", "DR Congo", "Democratic Republic of the Congo", "RD Congo", "Republica Democratica do Congo", "República Democrática do Congo"],
  ["Congo", "Congo Republic", "Republic of the Congo", "Republica do Congo", "República do Congo"],
  ["Ivory Coast", "Cote d Ivoire", "Côte d'Ivoire", "Costa do Marfim"],
  ["Cape Verde", "Cape Verde Islands", "Cabo Verde"],
  ["Czechia", "Czech Republic", "Tchequia", "Tchéquia", "Republica Tcheca", "República Tcheca"],
  ["Netherlands", "Paises Baixos", "Países Baixos", "Holanda"],
  ["Turkey", "Turkiye", "Türkiye", "Turquia"],
  ["Russia", "Russian Federation", "Russia", "Rússia"],
  ["Moldova", "Moldavia", "Moldavia", "Moldávia"],
  ["Eswatini", "Swaziland", "Essuatini", "Suazilandia", "Suazilândia"],
  ["Myanmar", "Burma", "Mianmar", "Birmania", "Birmânia"],
  ["Vietnam", "Viet Nam", "Vietname", "Vietna", "Vietnã"],
  ["Syria", "Siria", "Síria"],
  ["Iran", "Ira", "Irã"],
  ["Iraq", "Iraque"],
  ["Qatar", "Catar"],
  ["Saudi Arabia", "Saudi", "Arabia Saudita", "Arabia Saudita"],
  ["Morocco", "Marrocos"],
  ["Algeria", "Argelia", "Argélia"],
  ["Tunisia", "Tunisia", "Tunísia"],
  ["Egypt", "Egito"],
  ["Croatia", "Croacia", "Croácia"],
  ["Belgium", "Belgica", "Bélgica"],
  ["Romania", "Romenia", "Romênia"],
  ["Poland", "Polonia", "Polônia"],
  ["Denmark", "Dinamarca"],
  ["Italy", "Italia", "Itália"],
  ["Luxembourg", "Luxemburgo"],
  ["New Zealand", "Nova Zelandia", "Nova Zelândia"],
  ["Philippines", "Filipinas"],
  ["Dominican Republic", "Republica Dominicana", "República Dominicana"],
  ["British Virgin Islands", "Ilhas Virgens Britanicas", "Ilhas Virgens Britânicas"],
  ["US Virgin Islands", "United States Virgin Islands", "Ilhas Virgens Americanas", "Ilhas Virgens dos EUA"],
  ["Chinese Taipei", "Taiwan", "Taipe Chines", "Taipei Chines", "Taipé Chinês"],
  ["Hong Kong", "Honguecongue"],
  ["Macau", "Macao"],
  ["Palestine", "Palestina"],
  ["Kosovo", "Kosovo"],
  ["Faroe Islands", "Ilhas Faroe"],
  ["Tahiti", "Taiti", "French Polynesia", "Polinesia Francesa", "Polinésia Francesa"],
  ["New Caledonia", "Nova Caledonia", "Nova Caledônia"],
  ["Cook Islands", "Ilhas Cook"],
  ["American Samoa", "Samoa Americana"],
  ["Puerto Rico", "Porto Rico"],
  ["Guam", "Guam"],
  ["Gibraltar", "Gibraltar"],
  ["Panama", "Panama", "Panamá"],
  ["El Salvador", "El Salvador"],
  ["Sao Tome and Principe", "São Tomé and Príncipe", "Sao Tome e Principe", "São Tomé e Príncipe"],
  ["Timor Leste", "Timor-Leste", "East Timor", "Timor Oriental"],
  ["Guinea Bissau", "Guinea-Bissau", "Guine Bissau", "Guiné-Bissau"],
  ["Equatorial Guinea", "Guine Equatorial", "Guiné Equatorial"],
  ["Bosnia and Herzegovina", "Bosnia Herzegovina", "Bosnia e Herzegovina", "Bósnia e Herzegovina"],
  ["North Macedonia", "Macedonia", "Macedonia do Norte", "Macedônia do Norte"],
  ["Trinidad and Tobago", "Trinidad Tobago", "Trindade e Tobago"],
  ["Saint Kitts and Nevis", "St Kitts and Nevis", "Sao Cristovao e Nevis", "São Cristóvão e Nevis"],
  ["Saint Lucia", "St Lucia", "Santa Lucia", "Santa Lúcia"],
  ["Saint Vincent and the Grenadines", "St Vincent and the Grenadines", "Sao Vicente e Granadinas", "São Vicente e Granadinas"]
  ,
  ["England", "England National Team"],
  ["Scotland", "Scotland National Team"],
  ["Ireland", "Eire"],
  ["United States", "U.S.", "U.S.A.", "United States of America"],
  ["United Arab Emirates", "U.A.E.", "EAU", "Emirates"],
  ["South Korea", "Korea Rep", "Korea Rep.", "Rep Korea", "Republic Korea", "Korea South", "Coreia Republica"],
  ["North Korea", "DPR Korea", "Korea DPR.", "Korea North", "Coreia DPR"],
  ["Congo DR", "D.R. Congo", "Congo Democratic Republic", "Democratic Congo", "Congo Kinshasa", "Congo-Kinshasa", "Zaire"],
  ["Congo", "Congo Brazzaville", "Congo-Brazzaville"],
  ["Ivory Coast", "Cote d'Ivoire"],
  ["Cape Verde", "Ilhas de Cabo Verde"],
  ["Czechia", "Czech Rep", "Czech Rep.", "Czech", "Rep Tcheca"],
  ["Russia", "Russian Fed"],
  ["Saudi Arabia", "KSA"],
  ["Dominican Republic", "Dominican Rep", "Dominican Rep.", "Dom Republic", "Rep Dominicana", "Dominicana"],
  ["Central African Republic", "Central African Rep", "Central African Rep.", "Central Africa Republic", "Republica Centro Africana", "Rep Centro Africana", "CAR"],
  ["Chinese Taipei", "Taipei"],
  ["Hong Kong", "Hong Kong China"],
  ["Macau", "Macau China", "Macao China"],
  ["Palestine", "Palestinian Territories", "Territorios Palestinos"],
  ["Faroe Islands", "Faroe", "Ilhas Feroe"],
  ["Sao Tome and Principe", "Sao Tome Principe"],
  ["Equatorial Guinea", "Guinea Equatorial", "Guinea Ecuatorial"],
  ["Bosnia and Herzegovina", "Bosnia-Herzegovina", "Bosnia & Herzegovina", "Bosnia y Herzegovina"],
  ["North Macedonia", "FYR Macedonia", "Macedonia FYR", "Macedonia North"],
  ["Trinidad and Tobago", "T&T"],
  ["Saint Kitts and Nevis", "St. Kitts and Nevis", "St Kitts Nevis"],
  ["Saint Lucia", "St. Lucia"],
  ["Saint Vincent and the Grenadines", "St. Vincent and the Grenadines", "St Vincent Grenadines"]
];

const displayNamesByLocale = new Map<string, Intl.DisplayNames>();
let aliasIndex: Map<string, Set<string>> | null = null;
const SAFE_SHORT_ALIAS_TOKENS = new Set(["u17", "u18", "u19", "u20", "u21", "u22", "u23", "usa", "eua", "uae"]);

function displayNames(locale: string) {
  const cached = displayNamesByLocale.get(locale);
  if (cached) return cached;

  const names = new Intl.DisplayNames([locale], { type: "region" });
  displayNamesByLocale.set(locale, names);
  return names;
}

function normalizeAlias(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addAliasGroup(index: Map<string, Set<string>>, aliases: unknown[]) {
  const normalizedAliases = aliases.map(normalizeAlias).filter(Boolean);
  if (!normalizedAliases.length) return;

  const group = new Set(normalizedAliases);
  for (const alias of normalizedAliases) {
    const existing = index.get(alias);
    if (existing) {
      for (const value of group) existing.add(value);
      for (const value of existing) group.add(value);
    }
  }

  for (const alias of group) {
    index.set(alias, new Set(group));
  }
}

function buildAliasIndex() {
  const index = new Map<string, Set<string>>();

  for (const code of REGION_CODES) {
    const aliases = [displayNames("en").of(code), displayNames("pt-BR").of(code)];
    addAliasGroup(index, aliases);
  }

  for (const aliases of MANUAL_ALIAS_GROUPS) {
    addAliasGroup(index, aliases);
  }

  return index;
}

function nationalTeamAliasIndex() {
  aliasIndex ??= buildAliasIndex();
  return aliasIndex;
}

function teamAgeSuffix(value: string) {
  return /\bu(\d{2})\b/.exec(value)?.[1] ?? /\bsub\s*(\d{2})\b/.exec(value)?.[1] ?? null;
}

export function nationalTeamAliases(value: unknown) {
  const normalized = normalizeAlias(value);
  if (!normalized) return [];

  const age = teamAgeSuffix(normalized);
  const baseName = age ? normalized.replace(/\bu\d{2}\b/g, "").replace(/\bsub\s*\d{2}\b/g, "").trim() : normalized;
  const aliases = new Set([normalized].filter(Boolean));
  for (const alias of nationalTeamAliasIndex().get(baseName) ?? []) {
    if (age) {
      aliases.add(`${alias} u${age}`);
      aliases.add(`${alias} sub ${age}`);
    } else {
      aliases.add(alias);
    }
  }

  return [...aliases];
}

export function teamAliasTokens(value: unknown) {
  return normalizeAlias(value)
    .replace(/\bsub\s*(\d{2})\b/g, "u$1")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !TEAM_ALIAS_STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function significantAliasToken(token: string) {
  return token.length >= 3 || SAFE_SHORT_ALIAS_TOKENS.has(token);
}

function textTokenSet(value: unknown) {
  return new Set(
    normalizeAlias(value)
      .replace(/\bsub\s*(\d{2})\b/g, "u$1")
      .split(/\s+/)
      .filter(Boolean)
  );
}

export function nationalTeamTokenGroups(value: unknown) {
  return nationalTeamAliases(value)
    .map(teamAliasTokens)
    .filter((tokens) => tokens.length > 0);
}

export function tokenGroupMatchesText(text: string, tokenGroups: string[][]) {
  if (!tokenGroups.length) return false;
  const searchableTokens = textTokenSet(text);
  return tokenGroups.some((tokens) => {
    const ageToken = tokens.find((token) => /^u\d{2}$/.test(token));
    if (ageToken && !searchableTokens.has(ageToken)) return false;

    const candidateTokens = tokens.filter(significantAliasToken).slice(0, 4);
    if (!candidateTokens.length) return false;
    return candidateTokens.every((token) => searchableTokens.has(token));
  });
}

export function tokenGroupsOverlap(leftGroups: string[][], rightGroups: string[][]) {
  for (const left of leftGroups) {
    const leftTokens = new Set(left.filter(significantAliasToken));
    const leftAgeToken = left.find((token) => /^u\d{2}$/.test(token));
    for (const right of rightGroups) {
      const rightAgeToken = right.find((token) => /^u\d{2}$/.test(token));
      if ((leftAgeToken || rightAgeToken) && leftAgeToken !== rightAgeToken) continue;
      if (right.filter(significantAliasToken).some((token) => leftTokens.has(token))) return true;
    }
  }

  return false;
}

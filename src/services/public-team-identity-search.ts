export type PublicIdentityEvidence = {
  uri: string;
  title: string | null;
  snippet: string;
  provider: "wikidata" | "duckduckgo";
};

export type PublicIdentitySearchInput = {
  homeTeam: string;
  awayTeam: string;
  leagueName?: string | null;
  leagueCountry?: string | null;
  startsAt: string | number | Date;
};

type WikidataSearchResponse = {
  search?: Array<{
    id?: string;
    label?: string;
    description?: string;
    aliases?: string[];
  }>;
};

const USER_AGENT = "MonitorOdds/1.0 (team identity resolver)";
const wikidataCache = new Map<string, PublicIdentityEvidence[]>();

function decodeHtml(text: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#")) {
      const hexadecimal = code[1]?.toLowerCase() === "x";
      const value = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function plainText(html: string) {
  return decodeHtml(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function directDuckDuckGoUrl(href: string) {
  const decoded = decodeHtml(href);
  try {
    const parsed = new URL(decoded.startsWith("//") ? "https:" + decoded : decoded);
    return parsed.searchParams.get("uddg") || parsed.toString();
  } catch {
    return decoded;
  }
}

export function parseDuckDuckGoResults(html: string) {
  const results: PublicIdentityEvidence[] = [];
  const anchorPattern = /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const href = /\bhref="([^"]+)"/i.exec(match[1] ?? "")?.[1];
    const title = plainText(match[2] ?? "");
    if (!href || !title) continue;

    const uri = directDuckDuckGoUrl(href);
    if (!/^https?:\/\//i.test(uri)) continue;
    results.push({
      uri,
      title,
      snippet: title,
      provider: "duckduckgo"
    });
    if (results.length >= 6) break;
  }

  return results;
}

async function searchWikidata(teamName: string, signal: AbortSignal) {
  const cacheKey = teamName.trim().toLocaleLowerCase("en-US");
  const cached = wikidataCache.get(cacheKey);
  if (cached) return cached;

  const url = new URL("https://www.wikidata.org/w/api.php");
  url.search = new URLSearchParams({
    action: "wbsearchentities",
    search: teamName,
    language: "en",
    uselang: "en",
    type: "item",
    limit: "5",
    format: "json",
    origin: "*"
  }).toString();

  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal
  });
  if (!response.ok) throw new Error("Wikidata respondeu HTTP " + response.status + ".");

  const body = (await response.json()) as WikidataSearchResponse;
  const results = (body.search ?? [])
    .filter((item) => item.id && item.label)
    .map((item): PublicIdentityEvidence => {
      const aliases = (item.aliases ?? []).filter(Boolean);
      const details = [
        item.description?.trim(),
        aliases.length ? "Aliases: " + aliases.join(", ") : null,
        "Nome consultado: " + teamName
      ].filter(Boolean);
      return {
        uri: "https://www.wikidata.org/wiki/" + item.id,
        title: item.label?.trim() || null,
        snippet: details.join(". "),
        provider: "wikidata"
      };
    });

  wikidataCache.set(cacheKey, results);
  return results;
}

async function searchDuckDuckGo(query: string, signal: AbortSignal) {
  const response = await fetch(
    "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
    {
      headers: {
        "accept-language": "en-US,en;q=0.9,pt-BR;q=0.8",
        "user-agent": USER_AGENT
      },
      signal
    }
  );
  if (!response.ok) throw new Error("DuckDuckGo respondeu HTTP " + response.status + ".");
  return parseDuckDuckGoResults(await response.text());
}

function searchQueries(input: PublicIdentitySearchInput, attempt: number) {
  const kickoff = new Date(input.startsAt);
  const date = Number.isFinite(kickoff.getTime())
    ? kickoff.toISOString().slice(0, 10)
    : String(input.startsAt);
  const context = [input.leagueName, input.leagueCountry, date].filter(Boolean).join(" ");

  if (attempt === 1) {
    return [input.homeTeam + " vs " + input.awayTeam + " " + context];
  }
  if (attempt === 2) {
    return [
      input.homeTeam + " football club " + input.awayTeam + " " + context,
      input.awayTeam + " football club " + input.homeTeam + " " + context
    ];
  }
  if (attempt === 3) {
    return [
      input.homeTeam + " official former names aliases football club",
      input.awayTeam + " official former names aliases football club"
    ];
  }
  return ['"' + input.homeTeam + '" "' + input.awayTeam + '" football ' + context];
}

export async function collectPublicTeamIdentityEvidence(
  input: PublicIdentitySearchInput,
  attempt: number,
  signal: AbortSignal
) {
  const queries = searchQueries(input, attempt);
  const operations = [
    searchWikidata(input.homeTeam, signal),
    searchWikidata(input.awayTeam, signal),
    ...queries.map((query) => searchDuckDuckGo(query, signal))
  ];
  const settled = await Promise.allSettled(operations);
  const evidence = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const unique = [...new Map(evidence.map((item) => [item.uri, item])).values()].slice(0, 20);

  if (!unique.length) {
    const errors = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    throw new Error("Nenhuma fonte publica respondeu. " + errors.join(" "));
  }

  return {
    evidence: unique,
    searchQueries: [
      "Wikidata: " + input.homeTeam,
      "Wikidata: " + input.awayTeam,
      ...queries.map((query) => "DuckDuckGo: " + query)
    ]
  };
}

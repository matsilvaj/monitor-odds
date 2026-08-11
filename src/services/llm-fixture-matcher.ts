import { jaroWinkler, significantTokenSet, tokenSetSimilarity } from "../domain/matching/text-similarity.js";
import { lookupTeamAlias, saveTeamAlias } from "../db/team-alias-repository.js";
import { selectFixtureWithGemini, verifyTeamsSameClub } from "./gemini-team-verifier.js";

export type LlmFixtureCandidate = {
  id: string;
  home_team: string;
  away_team: string;
  starts_at: string;
};

export type LlmMatchResult = {
  fixtureId: string;
  orientation: "NORMAL" | "INVERTED";
};

const LLM_MAX_CANDIDATES = 30;
const LLM_LEAGUE_MIN_SIMILARITY = 0.6;
// Limiar token-a-token para pré/pós validação.
// jaro-winkler por token elimina falsos positivos por sobreposição casual de caracteres.
// (ex: "atlas" vs "tolima" ≈ 0.58 falha, "atlas" vs "atlas" = 1.0 passa)
const LLM_TOKEN_MATCH_THRESHOLD = 0.85;

// Cache em memória: evita chamar o LLM para o mesmo par na mesma sessão
const matchCache = new Map<string, LlmMatchResult | null>();

function cacheKey(homeTeam: string, awayTeam: string, leagueName: string | null): string {
  return `${homeTeam.toLowerCase()}|${awayTeam.toLowerCase()}|${leagueName?.toLowerCase() ?? ""}`;
}

// Retorna true se ao menos um token significativo de `a` bate com algum token de `b`.
function hasTokenEvidence(a: string, b: string): boolean {
  const aTokens = significantTokenSet(a);
  const bTokens = significantTokenSet(b);
  if (!aTokens.size || !bTokens.size) return false;
  for (const at of aTokens) {
    for (const bt of bTokens) {
      if (jaroWinkler(at, bt) >= LLM_TOKEN_MATCH_THRESHOLD) return true;
    }
  }
  return false;
}

// Verifica via DB de aliases se dois nomes são o mesmo clube (true/false/null=desconhecido).
async function checkAlias(nameA: string, nameB: string): Promise<boolean | null> {
  try {
    return await lookupTeamAlias(nameA, nameB);
  } catch {
    return null;
  }
}

// Verifica via Gemini + Google Search e persiste o resultado no banco.
async function verifyAndLearn(
  bookmakerName: string,
  canonicalName: string,
  leagueContext: string | null
): Promise<boolean | null> {
  const result = await verifyTeamsSameClub(bookmakerName, canonicalName, leagueContext);
  if (result !== null) {
    await saveTeamAlias(bookmakerName, canonicalName, result, "gemini").catch(() => {});
    if (result) {
      console.log(`[Gemini] Alias confirmado: "${bookmakerName}" = "${canonicalName}"`);
    } else {
      console.log(`[Gemini] Times diferentes confirmados: "${bookmakerName}" ≠ "${canonicalName}"`);
    }
  }
  return result;
}

export async function findFixtureWithLlmFallback<T extends { id: string; home_team: string | null; away_team: string | null; starts_at: string }>(input: {
  bookmakerHomeTeam: string | null | undefined;
  bookmakerAwayTeam: string | null | undefined;
  startsAt: string | number | null | undefined;
  leagueName: string | null | undefined;
  fixtures: T[];
  getLeagueName: (fixture: T) => string | null;
}): Promise<(LlmMatchResult & { fixture: T }) | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!input.bookmakerHomeTeam || !input.bookmakerAwayTeam) return null;

  const bkHome = input.bookmakerHomeTeam;
  const bkAway = input.bookmakerAwayTeam;
  const leagueName = input.leagueName ?? null;

  const candidates = leagueName
    ? input.fixtures.filter((f) => {
        const fixtureLn = input.getLeagueName(f);
        return fixtureLn && tokenSetSimilarity(fixtureLn, leagueName) >= LLM_LEAGUE_MIN_SIMILARITY;
      })
    : [];

  if (candidates.length === 0 || candidates.length > LLM_MAX_CANDIDATES) return null;

  // Pré-filtro: exige evidência textual OU alias confirmado em ao menos um candidato.
  // Sem nenhuma sobreposição o modelo não tem base para decidir.
  const hasTextualEvidence = candidates.some((f) =>
    hasTokenEvidence(bkHome, f.home_team ?? "") ||
    hasTokenEvidence(bkHome, f.away_team ?? "") ||
    hasTokenEvidence(bkAway, f.home_team ?? "") ||
    hasTokenEvidence(bkAway, f.away_team ?? "")
  );

  // Verifica aliases no DB para os candidatos sem evidência textual
  const aliasEvidenceCandidate = !hasTextualEvidence
    ? await (async () => {
        for (const f of candidates) {
          const homeAlias = await checkAlias(bkHome, f.home_team ?? "");
          const awayAlias = await checkAlias(bkAway, f.away_team ?? "");
          if (homeAlias === true && awayAlias === true) return f;
          const invHomeAlias = await checkAlias(bkHome, f.away_team ?? "");
          const invAwayAlias = await checkAlias(bkAway, f.home_team ?? "");
          if (invHomeAlias === true && invAwayAlias === true) return f;
        }
        return null;
      })()
    : null;

  // Se encontrou via alias sem evidência textual, retorna direto
  if (!hasTextualEvidence && aliasEvidenceCandidate) {
    const homeAlias = await checkAlias(bkHome, aliasEvidenceCandidate.home_team ?? "");
    const orientation: "NORMAL" | "INVERTED" = homeAlias === true ? "NORMAL" : "INVERTED";
    return { fixtureId: aliasEvidenceCandidate.id, orientation, fixture: aliasEvidenceCandidate };
  }

  if (!hasTextualEvidence && !aliasEvidenceCandidate) return null;

  const key = cacheKey(bkHome, bkAway, leagueName);
  if (matchCache.has(key)) {
    const cached = matchCache.get(key) ?? null;
    if (!cached) return null;
    const fixture = candidates.find((f) => f.id === cached.fixtureId);
    return fixture ? { ...cached, fixture } : null;
  }

  const startsAt =
    typeof input.startsAt === "number"
      ? new Date(input.startsAt).toISOString()
      : (input.startsAt ?? null);

  // Chama Gemini para selecionar o melhor candidato
  const result = await selectFixtureWithGemini({
    bookmakerHomeTeam: bkHome,
    bookmakerAwayTeam: bkAway,
    leagueName,
    startsAt,
    candidates: candidates.map((f) => ({
      id: f.id,
      home_team: f.home_team ?? "",
      away_team: f.away_team ?? "",
      starts_at: f.starts_at,
    })),
  });

  if (!result) {
    matchCache.set(key, null);
    return null;
  }

  const fixture = candidates.find((f) => f.id === result.fixtureId);
  if (!fixture) {
    matchCache.set(key, null);
    return null;
  }

  const [fixtureHome, fixtureAway] =
    result.orientation === "INVERTED"
      ? [fixture.away_team ?? "", fixture.home_team ?? ""]
      : [fixture.home_team ?? "", fixture.away_team ?? ""];

  // Pós-validação por token: ambos os lados devem ter evidência textual
  const postHomeOk = hasTokenEvidence(bkHome, fixtureHome);
  const postAwayOk = hasTokenEvidence(bkAway, fixtureAway);

  if (postHomeOk && postAwayOk) {
    // Nomes próximos o suficiente — aceita e salva aliases
    await saveTeamAlias(bkHome, fixtureHome, true, "gemini").catch(() => {});
    await saveTeamAlias(bkAway, fixtureAway, true, "gemini").catch(() => {});
    console.log(`[Gemini] Match confirmado: "${bkHome} x ${bkAway}" → fixture ${result.fixtureId} (${result.orientation})`);
    matchCache.set(key, result);
    return { ...result, fixture };
  }

  // Nomes diferentes: verifica via Google Search se são o mesmo clube
  const homeVerified = postHomeOk ? true : await (async () => {
    const cached = await checkAlias(bkHome, fixtureHome);
    if (cached !== null) return cached;
    return verifyAndLearn(bkHome, fixtureHome, leagueName);
  })();

  if (!homeVerified) {
    matchCache.set(key, null);
    return null;
  }

  const awayVerified = postAwayOk ? true : await (async () => {
    const cached = await checkAlias(bkAway, fixtureAway);
    if (cached !== null) return cached;
    return verifyAndLearn(bkAway, fixtureAway, leagueName);
  })();

  if (!awayVerified) {
    matchCache.set(key, null);
    return null;
  }

  console.log(`[Gemini] Match via verificação web: "${bkHome} x ${bkAway}" → fixture ${result.fixtureId} (${result.orientation})`);
  matchCache.set(key, result);
  return { ...result, fixture };
}

// Mantida para compatibilidade — coletores que chamavam findFixtureWithLlm diretamente
// devem migrar para findFixtureWithLlmFallback
export async function findFixtureWithLlm(input: {
  bookmakerHomeTeam: string;
  bookmakerAwayTeam: string;
  leagueName: string | null;
  startsAt: string | null;
  candidates: LlmFixtureCandidate[];
}): Promise<LlmMatchResult | null> {
  return selectFixtureWithGemini(input);
}

import Groq from "groq-sdk";
import { tokenSetSimilarity } from "../domain/matching/text-similarity.js";

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
const LLM_LEAGUE_MIN_SIMILARITY = 0.45;

export async function findFixtureWithLlm(input: {
  bookmakerHomeTeam: string;
  bookmakerAwayTeam: string;
  leagueName: string | null;
  startsAt: string | null;
  candidates: LlmFixtureCandidate[];
}): Promise<LlmMatchResult | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !input.candidates.length) return null;

  try {
    const groq = new Groq({ apiKey });

    const candidateList = input.candidates
      .map((c, i) => `${i + 1}. id="${c.id}" | casa="${c.home_team}" | visitante="${c.away_team}" | data="${c.starts_at}"`)
      .join("\n");

    const prompt = `Você é especialista em futebol internacional. Identifique qual fixture do banco de dados corresponde ao evento abaixo.

EVENTO DA CASA DE APOSTAS:
- Casa: "${input.bookmakerHomeTeam}"
- Visitante: "${input.bookmakerAwayTeam}"
- Liga: "${input.leagueName ?? "desconhecida"}"
- Data/Hora: "${input.startsAt ?? "desconhecida"}"

FIXTURES DISPONÍVEIS NA LIGA:
${candidateList}

Os times na casa de apostas podem ter nomes diferentes dos fixtures (nome oficial completo vs abreviado, grafia alternativa, idioma diferente). Use seu conhecimento sobre futebol para identificar a qual clube cada nome corresponde.

Responda SOMENTE com JSON válido (sem markdown, sem explicações):
- Se encontrou o fixture: {"fixtureId":"<o id do fixture>","orientation":"NORMAL"} ou {"fixtureId":"<id>","orientation":"INVERTED"} se os times estão com posições trocadas
- Se não encontrou: {"fixtureId":null}`;

    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 100
    });

    const text = completion.choices[0]?.message?.content?.trim() ?? "";
    const jsonMatch = text.match(/\{[^{}]*"fixtureId"[^{}]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { fixtureId?: string | null; orientation?: unknown };
    if (!parsed.fixtureId || typeof parsed.fixtureId !== "string") return null;

    return {
      fixtureId: parsed.fixtureId,
      orientation: parsed.orientation === "INVERTED" ? "INVERTED" : "NORMAL"
    };
  } catch (err) {
    throw new Error(`LLM fixture matching failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function findFixtureWithLlmFallback<T extends { id: string; home_team: string | null; away_team: string | null; starts_at: string }>(input: {
  bookmakerHomeTeam: string | null | undefined;
  bookmakerAwayTeam: string | null | undefined;
  startsAt: string | number | null | undefined;
  leagueName: string | null | undefined;
  fixtures: T[];
  getLeagueName: (fixture: T) => string | null;
}): Promise<(LlmMatchResult & { fixture: T }) | null> {
  if (!process.env.GROQ_API_KEY) return null;
  if (!input.bookmakerHomeTeam || !input.bookmakerAwayTeam) return null;

  const leagueName = input.leagueName ?? null;
  const candidates = leagueName
    ? input.fixtures.filter((f) => {
        const fixtureLn = input.getLeagueName(f);
        return fixtureLn && tokenSetSimilarity(fixtureLn, leagueName) >= LLM_LEAGUE_MIN_SIMILARITY;
      })
    : [];

  if (candidates.length === 0 || candidates.length > LLM_MAX_CANDIDATES) return null;

  const startsAt =
    typeof input.startsAt === "number"
      ? new Date(input.startsAt).toISOString()
      : (input.startsAt ?? null);

  const result = await findFixtureWithLlm({
    bookmakerHomeTeam: input.bookmakerHomeTeam,
    bookmakerAwayTeam: input.bookmakerAwayTeam,
    leagueName,
    startsAt,
    candidates: candidates.map((f) => ({ id: f.id, home_team: f.home_team ?? "", away_team: f.away_team ?? "", starts_at: f.starts_at }))
  });

  if (!result) return null;
  const fixture = candidates.find((f) => f.id === result.fixtureId);
  if (!fixture) return null;
  return { ...result, fixture };
}

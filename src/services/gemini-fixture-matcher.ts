import { GoogleGenerativeAI } from "@google/generative-ai";

export type GeminiFixtureCandidate = {
  id: string;
  home_team: string;
  away_team: string;
  starts_at: string;
};

export type GeminiMatchResult = {
  fixtureId: string;
  orientation: "NORMAL" | "INVERTED";
};

export async function findFixtureWithGemini(input: {
  bookmakerHomeTeam: string;
  bookmakerAwayTeam: string;
  leagueName: string | null;
  startsAt: string | null;
  candidates: GeminiFixtureCandidate[];
}): Promise<GeminiMatchResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !input.candidates.length) return null;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
      tools: [{ googleSearchRetrieval: {} }]
    });

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

Os times na casa de apostas podem ter nomes diferentes dos fixtures (nome oficial completo vs abreviado, grafia alternativa, idioma diferente). Use seu conhecimento e pesquise na web se necessário para identificar a qual clube cada nome corresponde.

Responda SOMENTE com JSON válido (sem markdown, sem explicações):
- Se encontrou o fixture: {"fixtureId":"<o id do fixture>","orientation":"NORMAL"} ou {"fixtureId":"<id>","orientation":"INVERTED"} se os times estão com posições trocadas
- Se não encontrou: {"fixtureId":null}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    const jsonMatch = text.match(/\{[^{}]*"fixtureId"[^{}]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { fixtureId?: string | null; orientation?: unknown };
    if (!parsed.fixtureId || typeof parsed.fixtureId !== "string") return null;

    return {
      fixtureId: parsed.fixtureId,
      orientation: parsed.orientation === "INVERTED" ? "INVERTED" : "NORMAL"
    };
  } catch {
    return null;
  }
}

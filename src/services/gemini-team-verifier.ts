import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-3.5-flash-lite";

// Fila de rate limit: máximo 10 req/min (abaixo do limite de 15 do tier gratuito).
// Chamadas concorrentes entram na fila e saem uma a cada 6s, em ordem.
const MIN_INTERVAL_MS = 6_000;
let lastCallAt = 0;
let queueTail = Promise.resolve();

function waitForRateLimit(): Promise<void> {
  const myTurn = queueTail.then(async () => {
    const now = Date.now();
    const wait = MIN_INTERVAL_MS - (now - lastCallAt);
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  queueTail = myTurn.catch(() => {});
  return myTurn;
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error("GEMINI_API_KEY não configurada");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export type GeminiSelectionInput = {
  bookmakerHomeTeam: string;
  bookmakerAwayTeam: string;
  leagueName: string | null;
  startsAt: string | null;
  candidates: Array<{ id: string; home_team: string; away_team: string; starts_at: string }>;
};

export type GeminiSelectionResult = {
  fixtureId: string;
  orientation: "NORMAL" | "INVERTED";
};

export async function selectFixtureWithGemini(
  input: GeminiSelectionInput
): Promise<GeminiSelectionResult | null> {
  if (!process.env.GEMINI_API_KEY || !input.candidates.length) return null;

  const candidateList = input.candidates
    .map((c, i) => `${i + 1}. id="${c.id}" | casa="${c.home_team}" | visitante="${c.away_team}" | data="${c.starts_at}"`)
    .join("\n");

  const prompt = `Você é especialista em futebol internacional. Identifique qual fixture corresponde ao evento abaixo.

EVENTO DA CASA DE APOSTAS:
- Casa: "${input.bookmakerHomeTeam}"
- Visitante: "${input.bookmakerAwayTeam}"
- Liga: "${input.leagueName ?? "desconhecida"}"
- Data/Hora: "${input.startsAt ?? "desconhecida"}"

FIXTURES DISPONÍVEIS:
${candidateList}

Os times podem ter nomes diferentes (abreviados, idioma diferente, grafia alternativa). Use seu conhecimento para identificar o clube correto.

ATENÇÃO: Clubes com nomes parcialmente parecidos são times DISTINTOS. Verifique se AMBOS os times correspondem. Em caso de dúvida, responda {"fixtureId":null}.

Responda SOMENTE com JSON válido (sem markdown):
- Se encontrou: {"fixtureId":"<id>","orientation":"NORMAL"} ou {"fixtureId":"<id>","orientation":"INVERTED"} se os times estão trocados
- Se não encontrou: {"fixtureId":null}`;

  try {
    await waitForRateLimit();
    const response = await getClient().interactions.create({ model: MODEL, input: prompt });
    const text = (response.output_text ?? "").trim();
    const jsonMatch = text.match(/\{[^{}]*"fixtureId"[^{}]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { fixtureId?: string | null; orientation?: unknown };
    if (!parsed.fixtureId || typeof parsed.fixtureId !== "string") return null;

    return {
      fixtureId: parsed.fixtureId,
      orientation: parsed.orientation === "INVERTED" ? "INVERTED" : "NORMAL",
    };
  } catch (err) {
    console.error("[Gemini selection error]", err);
    return null;
  }
}

// Verifica via Google Search se dois nomes se referem ao mesmo clube.
// Retorna true, false, ou null se não conseguiu determinar.
export async function verifyTeamsSameClub(
  bookmakerName: string,
  canonicalName: string,
  leagueContext?: string | null
): Promise<boolean | null> {
  if (!process.env.GEMINI_API_KEY) return null;

  const context = leagueContext ? ` (contexto: liga "${leagueContext}")` : "";
  const prompt = `Pesquise na internet e responda: o nome "${bookmakerName}"${context} e o nome "${canonicalName}" se referem ao MESMO clube de futebol?

Considere que podem ser o mesmo clube com nomes em idiomas diferentes, apelidos, ou grafias alternativas.
Se forem claramente clubes diferentes (de países ou divisões diferentes), responda NÃO.

Responda SOMENTE com JSON: {"sameClub": true} ou {"sameClub": false}`;

  try {
    await waitForRateLimit();
    const response = await getClient().interactions.create({
      model: MODEL,
      input: prompt,
      tools: [{ type: "google_search" }],
    });
    const text = (response.output_text ?? "").trim();
    const jsonMatch = text.match(/\{[^{}]*"sameClub"[^{}]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { sameClub?: unknown };
    if (typeof parsed.sameClub !== "boolean") return null;
    return parsed.sameClub;
  } catch (err) {
    console.error("[Gemini verification error]", err);
    return null;
  }
}

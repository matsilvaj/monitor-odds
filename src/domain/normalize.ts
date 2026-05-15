export type PaCategory = "COM_PA" | "SEM_PA";
export type Selection = "HOME" | "DRAW" | "AWAY";

const normalizeText = (value: unknown) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

export function isMoneylineMarket(marketName: unknown) {
  const text = normalizeText(marketName);
  const exactAliases = new Set([
    "1x2",
    "vencedor do encontro",
    "resultado final",
    "resultado da partida",
    "resultado da partida 1x2",
    "match odds",
    "match winner",
    "moneyline",
    "quem vence",
    "vencedor do encontro - super odds",
    "vencedor do encontro - odds aumentadas",
    "vencedor do encontro - odds turbinadas",
    "resultado final - super odds",
    "resultado final - odds aumentadas",
    "resultado final - odds turbinadas"
  ]);

  if (exactAliases.has(text)) return true;

  return /^1x2\s*-\s*(odds aumentadas|super odds|odds turbinadas|turbo odds|boost)/.test(text);
}

export function classifyPa(...rawParts: unknown[]): { category: PaCategory; confidence: number; reason: string } {
  const text = normalizeText(rawParts.filter(Boolean).join(" "));

  if (/"type"\s*:\s*0/.test(text) && /"parameter"\s*:\s*2/.test(text)) {
    return { category: "COM_PA", confidence: 0.95, reason: "altenar-offer-type-0-parameter-2" };
  }

  if (/(pagamento antecipado|pague antecipado|early payout|early pay out|ganha antes|cashout antecipado)/.test(text)) {
    return { category: "COM_PA", confidence: 0.98, reason: "explicit-pa-term" };
  }

  if (/\bpa\b/.test(text) && /(antecip|payout|pague|pagamento)/.test(text)) {
    return { category: "COM_PA", confidence: 0.9, reason: "pa-with-context" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "no-explicit-pa-term" };
}

export function selectionFromOddType(typeId: unknown): Selection | null {
  const id = Number(typeId);
  if (id === 1) return "HOME";
  if (id === 2) return "DRAW";
  if (id === 3) return "AWAY";
  return null;
}

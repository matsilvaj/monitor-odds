import type { PaCategory, Selection } from "../../domain/normalize.js";
import { teamNameSearchPatterns } from "../../domain/matching/text-similarity.js";
import type { Bet365DomMarket, Bet365Event, Bet365FixtureTarget, Bet365Market } from "./types.js";

export type Bet365Node = {
  type: string;
  [key: string]: string;
};

type ExtractedOdd = {
  event: string;
  market: string;
  selection: string;
  price: number;
  rawPrice: string;
  payloadIndex: number;
};

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.,]+/g, " ")
    .trim();
}

function hashToPositiveInt(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function stableEventId(_sourceUrl: string, fixture: Bet365FixtureTarget): number {
  return hashToPositiveInt(`bet365:${fixture.id}`);
}

function cleanNodeType(value: string) {
  return value.replace(/^[^A-Z0-9]+/i, "").replace(/[^A-Z0-9]+$/i, "").toUpperCase();
}

export function decodeBet365Payload(payload: string): Bet365Node[] {
  const nodes: Bet365Node[] = [];
  const blocks = payload.split("|").map((block) => block.trim()).filter(Boolean);

  for (const block of blocks) {
    const attributes = block.split(";").filter(Boolean);
    const nodeType = cleanNodeType(attributes[0] ?? "");
    if (!nodeType) continue;

    const node: Bet365Node = { type: nodeType };
    for (let index = 1; index < attributes.length; index += 1) {
      const attr = attributes[index];
      const equalIndex = attr.indexOf("=");
      if (equalIndex === -1) {
        node[attr] = "true";
        continue;
      }

      const key = attr.slice(0, equalIndex).trim();
      const value = attr.slice(equalIndex + 1).trim();
      if (key) node[key] = value;
    }
    nodes.push(node);
  }

  return nodes;
}

export function fractionalToDecimal(value: string): number {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return 0;
  if (!normalized.includes("/")) {
    const decimal = Number(normalized);
    return Number.isFinite(decimal) ? decimal : 0;
  }

  const [numerator, denominator] = normalized.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator + 1;
}

function isTargetEventName(eventName: string, fixture: Bet365FixtureTarget) {
  if (fixture.homeTeam && fixture.awayTeam) {
    return teamNameSearchPatterns(fixture.homeTeam).some((pattern) => pattern.test(eventName)) && teamNameSearchPatterns(fixture.awayTeam).some((pattern) => pattern.test(eventName));
  }
  if (fixture.homeTeam) return teamNameSearchPatterns(fixture.homeTeam).some((pattern) => pattern.test(eventName));
  if (fixture.awayTeam) return teamNameSearchPatterns(fixture.awayTeam).some((pattern) => pattern.test(eventName));
  return true;
}

function isMoneylineMarket(marketName: string) {
  const market = normalizeText(marketName);
  return (
    market === "full time result" ||
    market === "resultado final" ||
    market === "match result" ||
    market === "resultado da partida" ||
    market === "vencedor da partida" ||
    market.includes("full time result") ||
    market.includes("resultado final") ||
    market.includes("match result")
  );
}

function classifyMarket(marketName: string): { category: PaCategory; confidence: number } {
  const market = normalizeText(marketName);
  if (market.includes("pagamento antecipado") || market.includes("early payout") || market.includes("early pay out")) {
    return { category: "COM_PA", confidence: 0.99 };
  }
  return { category: "SEM_PA", confidence: 0.96 };
}

function isDrawLabel(label: string) {
  const text = normalizeText(label);
  return text === "draw" || text === "empate" || text === "x";
}

function selectionForLabel(label: string, fixture: Bet365FixtureTarget, fallbackIndex: number): Selection {
  if (isDrawLabel(label)) return "DRAW";
  if (fixture.homeTeam && teamNameSearchPatterns(fixture.homeTeam).some((pattern) => pattern.test(label))) return "HOME";
  if (fixture.awayTeam && teamNameSearchPatterns(fixture.awayTeam).some((pattern) => pattern.test(label))) return "AWAY";
  return fallbackIndex === 0 ? "HOME" : fallbackIndex === 1 ? "DRAW" : "AWAY";
}

function oddsValue(node: Bet365Node) {
  return node.OD ?? node.O ?? node.PR ?? node.SP ?? "";
}

export function extractOddsFromPayload(payload: string, fixture: Bet365FixtureTarget, payloadIndex = 0): ExtractedOdd[] {
  const nodes = decodeBet365Payload(payload);
  const selections: ExtractedOdd[] = [];
  let currentEventName = "";
  let currentMarketName = "";

  for (const node of nodes) {
    if (node.type === "EV" && node.NA) {
      currentEventName = node.NA;
      currentMarketName = "";
      continue;
    }

    if ((node.type === "MG" || node.type === "MA") && node.NA) {
      currentMarketName = node.NA;
      continue;
    }

    const rawPrice = oddsValue(node);
    if (node.type !== "PA" || !node.NA || !rawPrice) continue;
    if (currentMarketName && !isMoneylineMarket(currentMarketName)) continue;

    const price = fractionalToDecimal(rawPrice);
    if (!Number.isFinite(price) || price < 1.01 || price > 1000) continue;

    selections.push({
      event: currentEventName,
      market: currentMarketName || "Full Time Result",
      selection: node.NA,
      price,
      rawPrice,
      payloadIndex
    });
  }

  return selections;
}

function rowsToMarket(rows: ExtractedOdd[], fixture: Bet365FixtureTarget, marketIndex: number): Bet365Market | null {
  const unique = [...new Map(rows.map((row) => [`${normalizeText(row.selection)}:${row.price}`, row])).values()];
  if (unique.length < 3) return null;

  const ordered = unique.slice(0, 3);
  const drawIndex = ordered.findIndex((row) => isDrawLabel(row.selection));
  if (drawIndex > 0 && drawIndex !== 1) {
    const draw = ordered.splice(drawIndex, 1)[0];
    ordered.splice(1, 0, draw);
  }

  const marketName = ordered[0]?.market ?? "Full Time Result";
  const pa = classifyMarket(marketName);
  return {
    marketName: "MoneyLine",
    paCategory: pa.category,
    confidence: pa.confidence,
    rawText: ordered.map((row) => `${row.selection}=${row.rawPrice}`).join("|"),
    index: marketIndex,
    selections: ordered.map((row, index) => ({
      selection: selectionForLabel(row.selection, fixture, index),
      label: row.selection,
      price: row.price,
      index
    }))
  };
}

export function parseBet365MoneylinePayloads(payloads: string[], fixture: Bet365FixtureTarget): Bet365Market[] {
  const grouped = new Map<string, ExtractedOdd[]>();

  payloads.forEach((payload, payloadIndex) => {
    const extracted = extractOddsFromPayload(payload, fixture, payloadIndex);
    const hasFixtureEvent = extracted.some((odd) => odd.event && isTargetEventName(odd.event, fixture));
    for (const odd of extracted) {
      if (hasFixtureEvent && odd.event && !isTargetEventName(odd.event, fixture)) continue;
      const key = `${normalizeText(odd.event)}:${normalizeText(odd.market)}`;
      grouped.set(key, [...(grouped.get(key) ?? []), odd]);
    }
  });

  const markets = [...grouped.values()]
    .map((rows, index) => rowsToMarket(rows, fixture, index))
    .filter((market): market is Bet365Market => Boolean(market));

  const selected: Bet365Market[] = [];
  for (const category of ["COM_PA", "SEM_PA"] as const) {
    const market = markets.find((item) => item.paCategory === category);
    if (market) selected.push(market);
  }
  return selected.length ? selected : markets.slice(0, 1);
}

export function summarizeBet365Payloads(payloads: string[]) {
  const typeCounts = new Map<string, number>();
  const markets = new Set<string>();
  const participants: Array<{ name: string; price: string; keys: string[] }> = [];

  for (const payload of payloads) {
    for (const node of decodeBet365Payload(payload)) {
      typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
      if ((node.type === "MG" || node.type === "MA") && node.NA) markets.add(node.NA);
      const rawPrice = oddsValue(node);
      if (node.type === "PA" && node.NA && rawPrice && participants.length < 12) {
        participants.push({ name: node.NA, price: rawPrice, keys: Object.keys(node).slice(0, 12) });
      }
    }
  }

  return {
    payloads: payloads.length,
    nodeTypes: Object.fromEntries([...typeCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    markets: [...markets].slice(0, 25),
    participants
  };
}

export function buildBet365Event(fixture: Bet365FixtureTarget, sourceUrl: string, payloads: string[] | string): Bet365Event {
  const normalizedPayloads = Array.isArray(payloads) ? payloads : [payloads];
  const markets = parseBet365MoneylinePayloads(normalizedPayloads, fixture);
  const rawText = normalizedPayloads.join("\n");

  return {
    externalEventId: stableEventId(sourceUrl, fixture),
    sourceUrl,
    eventName: [fixture.homeTeam, fixture.awayTeam].filter(Boolean).join(" x "),
    bookmakerHomeTeam: fixture.homeTeam,
    bookmakerAwayTeam: fixture.awayTeam,
    markets,
    rawText
  };
}

export function buildBet365EventFromDomMarkets(fixture: Bet365FixtureTarget, sourceUrl: string, domMarkets: Bet365DomMarket[]): Bet365Event {
  const markets = domMarkets
    .map((market, marketIndex) => {
      if (market.selections.length < 3) return null;
      return {
        marketName: "MoneyLine",
        paCategory: market.paCategory,
        confidence: 0.94,
        rawText: market.rawText.slice(0, 1500),
        index: marketIndex,
        selections: market.selections.slice(0, 3).map((selection, index) => ({
          selection: selectionForLabel(selection.label, fixture, index),
          label: selection.label,
          price: selection.price,
          index
        }))
      } satisfies Bet365Market;
    })
    .filter((market): market is Bet365Market => Boolean(market));

  const rawText = domMarkets.map((market) => market.rawText).join("\n");

  return {
    externalEventId: stableEventId(sourceUrl, fixture),
    sourceUrl,
    eventName: [fixture.homeTeam, fixture.awayTeam].filter(Boolean).join(" x "),
    bookmakerHomeTeam: fixture.homeTeam,
    bookmakerAwayTeam: fixture.awayTeam,
    markets,
    rawText
  };
}

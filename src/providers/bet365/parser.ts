import type { PaCategory, Selection } from "../../domain/normalize.js";
import type { Bet365Event, Bet365FixtureTarget, Bet365Market } from "./types.js";

const PRICE_RE = /(?:^|\s)([1-9]\d{0,2}[.,]\d{1,3})(?:\s|$)/;
const ODD_LINE_RE = /^(.+?)\s+(\d+(?:[.,]\d{1,3})?)$/;
const PAIR_RE = /([^\d]+?)\s+(\d+(?:[.,]\d{1,3})?)/g;
const NUMBER_LINE_RE = /^\d+(?:[.,]\d{1,3})?$/;

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.,]+/g, " ")
    .trim();
}

function compactSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function hashToPositiveInt(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

export function cleanBet365Lines(text: string) {
  return text.replace(/\r/g, "\n").split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function isMarketHeader(line: string) {
  const normalized = normalizeText(line);
  return normalized.startsWith("full time result") || normalized.startsWith("resultado final");
}

function marketStarts(lines: string[]) {
  return lines.map((line, index) => ({ line, index })).filter(({ line }) => isMarketHeader(line));
}

function moneylineBlocksFromText(rawText: string) {
  const lines = cleanBet365Lines(rawText);
  const starts = marketStarts(lines);

  return starts.map(({ index }, blockIndex) => {
    const nextStart = starts[blockIndex + 1]?.index ?? lines.length;
    return lines.slice(index, nextStart).join("\n");
  });
}

function classifyMarket(rawText: string): { category: PaCategory; confidence: number } {
  const text = normalizeText(rawText);
  if (text.includes("enhanced prices") || text.includes("odds aumentadas") || text.includes("cotas aumentadas")) {
    return { category: "SEM_PA", confidence: 0.98 };
  }
  if (text.includes("pagamento antecipado") || text.includes("early payout") || text.includes("early pay out")) {
    return { category: "COM_PA", confidence: 0.99 };
  }
  return { category: "SEM_PA", confidence: 1 };
}

function shouldSkipOutcomeLine(line: string) {
  const normalized = normalizeText(line);
  return (
    isMarketHeader(line) ||
    normalized.includes("pagamento antecipado") ||
    normalized.includes("early payout") ||
    normalized.includes("precos ajustados") ||
    normalized.includes("pre os ajustados") ||
    normalized.includes("enhanced prices") ||
    normalized.includes("acum") ||
    normalized === "ca"
  );
}

function isDrawLabel(label: string) {
  const text = normalizeText(label);
  return text === "draw" || text === "empate" || text === "x";
}

function selectionForLabel(label: string, fixture: Bet365FixtureTarget, fallbackIndex: number): Selection {
  const normalized = normalizeText(label);
  if (isDrawLabel(label)) return "DRAW";
  if (fixture.homeTeam && normalized.includes(normalizeText(fixture.homeTeam))) return "HOME";
  if (fixture.awayTeam && normalized.includes(normalizeText(fixture.awayTeam))) return "AWAY";
  return fallbackIndex === 0 ? "HOME" : fallbackIndex === 1 ? "DRAW" : "AWAY";
}

function selectionRowsFromBlock(rawText: string, fixture: Bet365FixtureTarget) {
  const lines = cleanBet365Lines(rawText);
  const rows: Array<{ label: string; price: number }> = [];
  let pendingName = "";
  const seenNames = new Set<string>();

  const pushRow = (label: string, rawPrice: string) => {
    const normalizedLabel = normalizeText(label);
    if (!label || NUMBER_LINE_RE.test(label) || seenNames.has(normalizedLabel)) return;
    const price = Number(rawPrice.replace(",", "."));
    if (!Number.isFinite(price) || price < 1.01 || price > 1000) return;
    rows.push({ label, price });
    seenNames.add(normalizedLabel);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (shouldSkipOutcomeLine(line)) continue;

    const pairs = [...line.matchAll(PAIR_RE)]
      .map((match) => ({ label: match[1].trim(), price: match[2].replace(",", ".") }))
      .filter((item) => item.label && !NUMBER_LINE_RE.test(item.label));
    if (pairs.length > 1) {
      for (const pair of pairs) {
        pushRow(pair.label, pair.price);
        if (rows.length >= 3) return rowsToSelections(rows, fixture);
      }
      pendingName = "";
      continue;
    }

    const match = ODD_LINE_RE.exec(line);
    if (match) {
      pushRow(match[1].trim(), match[2]);
      pendingName = "";
      continue;
    }

    if (NUMBER_LINE_RE.test(line) && pendingName) {
      pushRow(pendingName, line);
      pendingName = "";
      continue;
    }

    if (line.length <= 40 && !/\d/.test(line)) {
      pendingName = line;
    }

    if (rows.length >= 3) break;
  }

  return rowsToSelections(rows, fixture);
}

function rowsToSelections(rows: Array<{ label: string; price: number }>, fixture: Bet365FixtureTarget) {
  const unique = [...new Map(rows.map((row) => [`${normalizeText(row.label)}:${row.price}`, row])).values()];
  if (unique.length < 3) return [];

  const drawIndex = unique.findIndex((row) => isDrawLabel(row.label));
  if (drawIndex > 0 && drawIndex !== 1) {
    const draw = unique.splice(drawIndex, 1)[0];
    unique.splice(1, 0, draw);
  }

  return unique.slice(0, 3).map((row, index) => ({
    selection: selectionForLabel(row.label, fixture, index),
    label: row.label,
    price: row.price,
    index
  }));
}

export function parseBet365MoneylineText(rawText: string, fixture: Bet365FixtureTarget): Bet365Market[] {
  const markets = moneylineBlocksFromText(rawText)
    .map((block, index) => {
      const selections = selectionRowsFromBlock(block, fixture);
      if (selections.length !== 3) return null;
      const pa = classifyMarket(block);
      return {
        marketName: "MoneyLine",
        paCategory: pa.category,
        confidence: pa.confidence,
        rawText: block.slice(0, 1500),
        index,
        selections
      } satisfies Bet365Market;
    })
    .filter((market): market is Bet365Market => Boolean(market));

  const selected: Bet365Market[] = [];
  for (const category of ["COM_PA", "SEM_PA"] as const) {
    const market = markets.find((item) => item.paCategory === category);
    if (market) selected.push(market);
  }
  return selected.length ? selected : markets.slice(0, 1);
}

export function buildBet365Event(fixture: Bet365FixtureTarget, sourceUrl: string, rawText: string): Bet365Event {
  const markets = parseBet365MoneylineText(rawText, fixture);
  const sourceKey = `${fixture.id}:${sourceUrl}:${compactSpaces(rawText).slice(0, 250)}`;
  return {
    externalEventId: hashToPositiveInt(sourceKey),
    sourceUrl,
    eventName: [fixture.homeTeam, fixture.awayTeam].filter(Boolean).join(" x "),
    bookmakerHomeTeam: fixture.homeTeam,
    bookmakerAwayTeam: fixture.awayTeam,
    markets,
    rawText
  };
}

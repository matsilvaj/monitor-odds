import { chromium, type Browser, type BrowserContext, type Page, type WebSocket } from "playwright-core";
import { nationalTeamAliases } from "../../domain/matching/team-aliases.js";
import { matchingTokens, teamNameSearchPatterns, teamNameSimilarity } from "../../domain/matching/text-similarity.js";
import type { Bet365DomMarket, Logger } from "./types.js";

export type Bet365NetworkCapture = {
  sourceUrl: string;
  payloads: string[];
  domMarkets: Bet365DomMarket[];
  domMarketsExpanded: number;
  clickedTeam: string | null;
  pageText: string;
  pageState: Bet365PageStateName;
};

export type Bet365ClickTarget = {
  homeTeam: string | null;
  awayTeam: string | null;
  startsAt?: string | null;
};

export type Bet365NetworkTabSession = {
  collectEventOdds(url: string, waitMs: number, target?: Bet365ClickTarget | null, clickEvent?: boolean, forceNavigate?: boolean): Promise<Bet365NetworkCapture>;
};

type Bet365PageStateName = "HOME" | "LEAGUE" | "EVENT" | "WRONG_EVENT" | "EVENT_READY" | "EVENT_LOADING" | "UNKNOWN";

type Bet365PageState = {
  name: Bet365PageStateName;
  sourceUrl: string;
  pageText: string;
  domMarkets: Bet365DomMarket[];
  hasTargetFixture: boolean;
  isEventUrl: boolean;
};

type Bet365DomMarketCard = {
  header: string;
  text: string;
  x: number;
  y: number;
  priceCount: number;
};

type Bet365FixtureCandidate = {
  text: string;
  homeTeam: string | null;
  awayTeam: string | null;
  startTime: string | null;
  x: number;
  y: number;
};

type Bet365FixtureEvidence = {
  matched: boolean;
  mode: "PAIR_MATCH" | "SINGLE_TEAM_UNIQUE" | "NO_MATCH";
  score: number;
  timeScore: number;
  teamScore: number;
  bestSingleTeamScore: number;
  minPairSideScore: number;
  reason: string;
};

type Bet365ClickPoint = {
  x: number;
  y: number;
  reason: string;
};

function payloadToString(payload: string | Buffer) {
  return typeof payload === "string" ? payload : payload.toString("utf8");
}

function looksLikeBet365Payload(payload: string) {
  if (!payload) return false;
  if (payload.includes("OVInPlay")) return true;
  if (payload.includes("|EV;") || payload.includes("|MA;") || payload.includes("|PA;")) return true;
  return payload.length > 100 && payload.includes("|") && payload.includes(";");
}

function isBet365EventUrl(url: string | null | undefined) {
  return /\/E\d+\/F/i.test(String(url ?? ""));
}

function bet365EventId(url: string | null | undefined) {
  return String(url ?? "").match(/\/E(\d+)\//i)?.[1] ?? null;
}

function matchesExpectedBet365EventUrl(expectedUrl: string | null | undefined, currentUrl: string | null | undefined) {
  const expectedEventId = bet365EventId(expectedUrl);
  if (!expectedEventId) return true;
  return bet365EventId(currentUrl) === expectedEventId;
}

function targetTeamNames(target: Bet365ClickTarget | null | undefined) {
  return [target?.homeTeam, target?.awayTeam].filter((team): team is string => Boolean(team?.trim()));
}

function withAmpersandAliases(value: string) {
  return [value, value.replace(/\band\b/gi, "&"), value.replace(/\s*&\s*/g, " and ")].filter(Boolean);
}

function targetTeamAliases(target: Bet365ClickTarget | null | undefined) {
  return targetTeamNames(target).map((team) => [...new Set(nationalTeamAliases(team).flatMap(withAmpersandAliases))]);
}

function teamTokenGroups(team: string | null | undefined) {
  if (!team?.trim()) return [];
  const groups = nationalTeamAliases(team)
    .flatMap(withAmpersandAliases)
    .map((alias) => matchingTokens(alias).filter((token) => token.length > 1))
    .filter((tokens) => tokens.length > 0);

  return [...new Map(groups.map((tokens) => [tokens.join(":"), tokens])).values()];
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.,]+/g, " ")
    .trim();
}

function textMatchesTokenGroups(rawText: string, groups: string[][]) {
  const normalized = normalizeText(rawText);
  if (!normalized || !groups.length) return false;
  const tokenSet = new Set(normalized.split(/\s+/).filter(Boolean));
  return groups.some((group) =>
    group.every((token) => (token.length <= 3 ? tokenSet.has(token) : normalized.includes(token)))
  );
}

function looksLikeFixtureTeamLine(line: string) {
  const clean = line.trim();
  if (clean.length < 2 || clean.length > 90) return false;
  if (!/[A-Za-z\u00C0-\u024F]/.test(clean)) return false;
  if (/\b(?:[1-9]\d{0,2}|0)[.,]\d{2,3}\b/.test(clean)) return false;
  if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(clean)) return false;
  if (/^(?:v|vs|x|-|draw|empate|full time result|resultado final|popular|matches|jogos)$/i.test(normalizeText(clean))) return false;
  if (/\b(?:pagamento antecipado|early payout|precos ajustados|enhanced prices|acum aumentado|acrescimos)\b/i.test(normalizeText(clean))) return false;
  return true;
}

function fixtureTeamPairsFromText(rawText: string) {
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 160);
  const pairs: Array<{ homeTeam: string; awayTeam: string }> = [];

  for (const line of lines) {
    const parts = line.split(/\s+(?:v|vs|x)\s+/i).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 2 && looksLikeFixtureTeamLine(parts[0]) && looksLikeFixtureTeamLine(parts[1])) {
      pairs.push({ homeTeam: parts[0], awayTeam: parts[1] });
    }
  }

  for (let index = 1; index < lines.length - 1; index += 1) {
    if (!/^(?:v|vs|x|-)$/.test(lines[index].trim().toLowerCase())) continue;
    const homeTeam = lines.slice(Math.max(0, index - 8), index).reverse().find(looksLikeFixtureTeamLine);
    const awayTeam = lines.slice(index + 1, Math.min(lines.length, index + 8)).find(looksLikeFixtureTeamLine);
    if (homeTeam && awayTeam) pairs.push({ homeTeam, awayTeam });
  }

  return [...new Map(pairs.map((pair) => [`${normalizeText(pair.homeTeam)}:${normalizeText(pair.awayTeam)}`, pair])).values()];
}

function fixturePairScore(target: Bet365ClickTarget | null | undefined, homeTeam: string | null | undefined, awayTeam: string | null | undefined) {
  if (!target?.homeTeam || !target.awayTeam || !homeTeam || !awayTeam) return { score: 0, minSideScore: 0 };
  const normalHome = teamNameSimilarity(target.homeTeam, homeTeam);
  const normalAway = teamNameSimilarity(target.awayTeam, awayTeam);
  const invertedHome = teamNameSimilarity(target.homeTeam, awayTeam);
  const invertedAway = teamNameSimilarity(target.awayTeam, homeTeam);
  const normal = { score: (normalHome + normalAway) / 2, minSideScore: Math.min(normalHome, normalAway) };
  const inverted = { score: (invertedHome + invertedAway) / 2, minSideScore: Math.min(invertedHome, invertedAway) };
  return normal.score >= inverted.score ? normal : inverted;
}

function fixtureSingleTeamScore(target: Bet365ClickTarget | null | undefined, homeTeam: string | null | undefined, awayTeam: string | null | undefined) {
  if (!target?.homeTeam || !target.awayTeam || !homeTeam || !awayTeam) return 0;
  return Math.max(
    teamNameSimilarity(target.homeTeam, homeTeam),
    teamNameSimilarity(target.homeTeam, awayTeam),
    teamNameSimilarity(target.awayTeam, homeTeam),
    teamNameSimilarity(target.awayTeam, awayTeam)
  );
}

function fixtureTimeScore(target: Bet365ClickTarget | null | undefined, startTime: string | null | undefined) {
  if (!target?.startsAt || !startTime) return 0.86;
  const canonical = new Date(target.startsAt).getTime();
  const candidate = new Date(candidateStartsAt(target, startTime)).getTime();
  if (!Number.isFinite(canonical) || !Number.isFinite(candidate)) return 0.86;
  const diffMs = Math.abs(canonical - candidate);
  const maxDiffMs = 45 * 60 * 1000;
  return Math.max(0, 1 - diffMs / maxDiffMs);
}

function textHasFixturePair(rawText: string, target: Bet365ClickTarget | null | undefined) {
  if (textMatchesTokenGroups(rawText, teamTokenGroups(target?.homeTeam)) && textMatchesTokenGroups(rawText, teamTokenGroups(target?.awayTeam))) {
    return true;
  }

  return fixtureTeamPairsFromText(rawText).some((pair) => {
    const pairScore = fixturePairScore(target, pair.homeTeam, pair.awayTeam);
    const singleTeamScore = fixtureSingleTeamScore(target, pair.homeTeam, pair.awayTeam);
    return (pairScore.score >= 0.66 && pairScore.minSideScore >= 0.58) || singleTeamScore >= 0.88;
  });
}

function pageLooksLikeHome(rawText: string) {
  const normalized = normalizeText(rawText);
  return /\b(?:bet365|todos os esportes|ao vivo|login|registre se|promocoes|inicio|cassino)\b/i.test(normalized);
}

function pageLooksLikeLeague(rawText: string) {
  const normalized = normalizeText(rawText);
  return /\b(?:matches|full time result|resultado final|pagamento antecipado|early payout|acum aumentado|aposta aumentada|bet builder)\b/i.test(normalized);
}

function pageStateIsTargetEvent(state: Bet365PageState | null | undefined): state is Bet365PageState & { name: "EVENT_READY" | "EVENT_LOADING" } {
  return state?.name === "EVENT_READY" || state?.name === "EVENT_LOADING";
}

const PRICE_RE = /\b([1-9]\d{0,2}[.,]\d{2,3})\b/g;
const PRICE_VALUE_RE = /\b([1-9]\d{0,2}[.,]\d{2,3})\b/;

function isTargetMoneylineHeader(normalizedLine: string) {
  return normalizedLine.includes("full time result") || normalizedLine.includes("resultado final");
}

function isMarketBoundaryLine(normalizedLine: string) {
  return (
    /^(?:to qualify|para se qualificar|para se classificar|team to kick off|time para dar o pontape inicial|equipe a dar o pontape inicial|aposta aumentada|ganhos aumentados|criar aposta|correct score|placar correto|both teams|ambas equipes|total goals|total de gols|goals|gols|corners|escanteios|cartoes faltas|cartoes|cards|half|intervalo|1 tempo 2 tempo|other|outro|outros|asian lines|odds asiaticas|linhas asiaticas|bet builder|marcadores|scorers|chutes|shots|estatisticas do jogador|player stats)\b/.test(
      normalizedLine
    ) || (/^[a-z0-9 ]{3,70}$/.test(normalizedLine) && !normalizedLine.includes(".") && !normalizedLine.includes(",") && /\b(?:qualify|qualificar|classificar|kick|pontape|score|placar|goals|gols|corners|escanteios|cards|cartoes|half|tempo|other|outro|asian|asiaticas|builder|stats|estatisticas|chutes|marcadores)\b/.test(normalizedLine))
  );
}

function moneylineBlocksFromText(rawText: string) {
  const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const normalized = normalizeText(line);
    if (isTargetMoneylineHeader(normalized)) {
      if (current?.length) blocks.push(current);
      current = [line];
      continue;
    }

    if (!current) continue;
    if (isMarketBoundaryLine(normalized)) {
      blocks.push(current);
      current = null;
      continue;
    }

    current.push(line);
  }

  if (current?.length) blocks.push(current);
  return blocks.map((block) => block.join("\n"));
}

function extractPriceValues(rawText: string) {
  return [...rawText.matchAll(PRICE_RE)]
    .map((match) => Number(match[1].replace(",", ".")))
    .filter((value) => Number.isFinite(value) && value >= 1.01 && value <= 1000);
}

function extractSelectionRows(rawText: string) {
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows: Array<{ label: string; price: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const priceMatch = lines[index].match(PRICE_VALUE_RE);
    if (!priceMatch) continue;

    const price = Number(priceMatch[1].replace(",", "."));
    if (!Number.isFinite(price)) continue;

    let label = lines[index].replace(priceMatch[0], "").trim();
    if (!label) {
      for (let cursor = index - 1; cursor >= Math.max(0, index - 4); cursor -= 1) {
        const previous = lines[cursor].trim();
        if (!previous || PRICE_VALUE_RE.test(previous)) continue;
        if (isMarketBoundaryLine(normalizeText(previous)) || isTargetMoneylineHeader(normalizeText(previous))) break;
        label = previous;
        break;
      }
    }

    rows.push({ label, price });
  }

  return rows;
}

function selectionRowsMatchTarget(target: Bet365ClickTarget | null | undefined, rows: Array<{ label: string; price: number }>) {
  if (!target?.homeTeam || !target.awayTeam || rows.length !== 3) return false;
  const homeLabel = rows[0]?.label ?? "";
  const drawLabel = normalizeText(rows[1]?.label ?? "");
  const awayLabel = rows[2]?.label ?? "";
  if (!homeLabel || !awayLabel || (drawLabel && drawLabel !== "draw" && drawLabel !== "empate" && drawLabel !== "x")) return false;
  const pairScore = fixturePairScore(target, homeLabel, awayLabel);
  const singleTeamScore = fixtureSingleTeamScore(target, homeLabel, awayLabel);
  return (pairScore.score >= 0.66 && pairScore.minSideScore >= 0.58) || singleTeamScore >= 0.88;
}

function blockLooksContaminated(rawText: string) {
  return rawText
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .some((line) => !isTargetMoneylineHeader(line) && isMarketBoundaryLine(line));
}

function blockLooksLikeEnhancedOfferGroup(rawText: string) {
  const normalized = normalizeText(rawText);
  return (
    (normalized.includes("enhanced prices") || normalized.includes("precos ajustados")) &&
    /\b(?:aumentos|increases|score from outside|shots on target|chutes ao gol|both teams to score|ambos marcam|corners shots|escanteios chutes|ver mais)\b/.test(normalized)
  );
}

function marketHeaderKey(header: string) {
  return normalizeText(header).replace(/\s+/g, " ");
}

function closedMoneylineHeaders(rawText: string) {
  return moneylineBlocksFromText(rawText)
    .map((block) => {
      const header = block
        .split(/\n+/)
        .map((line) => line.trim())
        .find((line) => isTargetMoneylineHeader(normalizeText(line)));
      return header ? { header, prices: extractPriceValues(block).length } : null;
    })
    .filter((item): item is { header: string; prices: number } => Boolean(item))
    .filter((item) => item.prices < 3)
    .filter((item) => {
      const block = moneylineBlocksFromText(rawText).find((candidate) => candidate.includes(item.header));
      return block ? !blockLooksLikeEnhancedOfferGroup(block) : true;
    });
}

function classifyVisibleMoneylineCategory(rawText: string) {
  const normalized = normalizeText(rawText);
  if (normalized.includes("pagamento antecipado") || normalized.includes("early payout") || normalized.includes("early pay out")) {
    return "COM_PA" as const;
  }
  return "SEM_PA" as const;
}

function marketQualityScore(market: Bet365DomMarket) {
  const normalized = normalizeText(market.rawText);
  let score = 0;
  if (market.selections.length >= 3) score += 3;
  if (normalized.includes("full time result") || normalized.includes("resultado final")) score += 2;
  if (normalized.includes("pagamento antecipado") || normalized.includes("early payout")) score += 1;
  if (normalized.includes("enhanced prices") || normalized.includes("precos ajustados")) score += 1;
  if (!normalized.includes("to qualify") && !normalized.includes("para se classificar")) score += 1;
  return score;
}

function parseVisibleMoneylineMarkets(rawTexts: string[], target: Bet365ClickTarget | null | undefined): Bet365DomMarket[] {
  const markets: Bet365DomMarket[] = [];
  const teams = targetTeamNames(target);
  const aliasesByTeam = targetTeamAliases(target);
  const marketBlocks = rawTexts.flatMap(moneylineBlocksFromText);

  const priceAfterLabel = (rawText: string, label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefix = normalizeText(label) === "x" ? "(?:^|[^A-Za-z0-9\\u00C0-\\u024F])" : "";
    const suffix = normalizeText(label) === "x" ? "(?=$|[^A-Za-z0-9\\u00C0-\\u024F])" : "";
    const literalMatch = rawText.match(new RegExp(`${prefix}${escaped}${suffix}[\\s\\S]{0,60}?([1-9]\\d{0,2}[.,]\\d{2,3})\\b`, "i"));
    if (literalMatch) return Number(literalMatch[1].replace(",", "."));

    const match = teamNameSearchPatterns(label)
      .map((pattern) => rawText.match(new RegExp(`${pattern.source}[\\s\\S]{0,60}?([1-9]\\d{0,2}[.,]\\d{2,3})\\b`, "i")))
      .find((result): result is RegExpMatchArray => Boolean(result));
    return match ? Number(match[1].replace(",", ".")) : null;
  };

  for (const rawText of marketBlocks) {
    const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const normalized = normalizeText(rawText);
    if (!isTargetMoneylineHeader(normalized)) continue;

    let selections = teams
      .map((team, index) => {
        const price = aliasesByTeam[index]?.map((alias) => priceAfterLabel(rawText, alias)).find((value): value is number => value != null) ?? null;
        return price ? { label: team, price } : null;
      })
      .filter((selection): selection is { label: string; price: number } => Boolean(selection));

    const drawLabel = normalized.includes("empate") ? "Empate" : "Draw";
    const drawPrice = priceAfterLabel(rawText, drawLabel);
    if (drawPrice) {
      selections.splice(1, 0, { label: drawLabel, price: drawPrice });
    }

    const priceRows = extractSelectionRows(rawText);
    if (
      selections.length < 3 &&
      teams.length >= 2 &&
      priceRows.length === 3 &&
      selectionRowsMatchTarget(target, priceRows) &&
      !blockLooksContaminated(rawText) &&
      !blockLooksLikeEnhancedOfferGroup(rawText)
    ) {
      const prices = priceRows.map((row) => row.price);
      if (prices.every((price) => Number.isFinite(price))) {
        selections = [
          { label: teams[0], price: prices[0] },
          { label: drawLabel, price: prices[1] },
          { label: teams[1], price: prices[2] }
        ];
      }
    }

    if (selections.length < 3) continue;
    markets.push({
      marketName: lines.find((line) => isTargetMoneylineHeader(normalizeText(line))) ?? "Full Time Result",
      paCategory: classifyVisibleMoneylineCategory(rawText),
      rawText,
      selections: selections.slice(0, 3)
    });
  }

  const unique = new Map<string, Bet365DomMarket>();
  for (const market of markets) {
    const key = `${market.paCategory}:${market.selections.map((selection) => selection.price).join("/")}`;
    const existing = unique.get(key);
    if (!existing || marketQualityScore(market) > marketQualityScore(existing)) unique.set(key, market);
  }
  const values = [...unique.values()];
  const selected: Bet365DomMarket[] = [];
  for (const category of ["COM_PA", "SEM_PA"] as const) {
    const candidates = values.filter((market) => market.paCategory === category);
    const best = candidates.sort((left, right) => marketQualityScore(right) - marketQualityScore(left))[0];
    if (best) selected.push(best);
  }
  return selected.length ? selected : values.slice(0, 1);
}

function candidateStartsAt(target: Bet365ClickTarget | null | undefined, startTime: string | null | undefined) {
  if (!target?.startsAt || !startTime) return target?.startsAt ?? "1970-01-01T00:00:00.000Z";
  const base = new Date(target.startsAt);
  const match = startTime.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!Number.isFinite(base.getTime()) || !match) return target.startsAt;

  const candidates = [-1, 0, 1].map((dayOffset) => {
    const value = new Date(base);
    value.setDate(value.getDate() + dayOffset);
    value.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return value;
  });
  const closest = candidates.sort((left, right) => Math.abs(left.getTime() - base.getTime()) - Math.abs(right.getTime() - base.getTime()))[0];
  return closest.toISOString();
}

function scoreFixtureCandidate(target: Bet365ClickTarget | null | undefined, candidate: Bet365FixtureCandidate): Bet365FixtureEvidence | null {
  if (!target?.homeTeam || !target.awayTeam || !candidate.homeTeam || !candidate.awayTeam) return null;
  const pair = fixturePairScore(target, candidate.homeTeam, candidate.awayTeam);
  const singleTeamScore = fixtureSingleTeamScore(target, candidate.homeTeam, candidate.awayTeam);
  const timeScore = fixtureTimeScore(target, candidate.startTime);
  const pairMatch = pair.score >= 0.68 && pair.minSideScore >= 0.58;
  const singleMatch = singleTeamScore >= 0.88 && timeScore >= 0.62;

  if (pairMatch) {
    return {
      matched: true,
      mode: "PAIR_MATCH",
      score: pair.score * 0.75 + timeScore * 0.25,
      timeScore,
      teamScore: pair.score,
      bestSingleTeamScore: singleTeamScore,
      minPairSideScore: pair.minSideScore,
      reason: "pair-match"
    } satisfies Bet365FixtureEvidence;
  }

  if (singleMatch) {
    return {
      matched: true,
      mode: "SINGLE_TEAM_UNIQUE",
      score: singleTeamScore * 0.72 + timeScore * 0.28,
      timeScore,
      teamScore: singleTeamScore,
      bestSingleTeamScore: singleTeamScore,
      minPairSideScore: pair.minSideScore,
      reason: "single-team-time-league"
    } satisfies Bet365FixtureEvidence;
  }

  return {
    matched: false,
    mode: "NO_MATCH",
    score: Math.max(pair.score, singleTeamScore) * 0.75 + timeScore * 0.25,
    timeScore,
    teamScore: pair.score,
    bestSingleTeamScore: singleTeamScore,
    minPairSideScore: pair.minSideScore,
    reason: "below-evidence-threshold"
  } satisfies Bet365FixtureEvidence;
}

function selectFixtureCandidate(scored: Array<{ candidate: Bet365FixtureCandidate; match: Bet365FixtureEvidence }>) {
  const accepted = scored
    .filter((item) => item.match.matched)
    .sort((left, right) => right.match.score - left.match.score);
  const best = accepted[0];
  if (!best) return null;

  const runnerUp = accepted[1];
  if (best.match.mode === "PAIR_MATCH") {
    return !runnerUp || best.match.score - runnerUp.match.score >= 0.02 ? best : null;
  }

  if (best.match.mode === "SINGLE_TEAM_UNIQUE") {
    return !runnerUp || best.match.score - runnerUp.match.score >= 0.08 ? best : null;
  }

  return null;
}

class Bet365PageController {
  constructor(
    private readonly page: Page,
    private readonly logger?: Logger,
    private readonly closePageOnClose = false
  ) {}

  async navigate(url: string, timeoutMs: number) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(timeoutMs, 10_000) });
  }

  async currentUrl() {
    if (!this.page) return "";
    return this.page.url();
  }

  private async pageBodyText(timeout = 2_000) {
    if (!this.page) return "";
    return this.page.locator("body").innerText({ timeout }).catch(() => "");
  }

  private classifyPageState(sourceUrl: string, pageText: string, target: Bet365ClickTarget | null | undefined): Bet365PageState {
    const isEventUrl = isBet365EventUrl(sourceUrl);
    const hasTargetFixture = target?.homeTeam && target.awayTeam ? textHasFixturePair(pageText, target) : false;
    const domMarkets = target ? parseVisibleMoneylineMarkets([pageText], target) : [];
    let name: Bet365PageStateName = "UNKNOWN";

    if (isEventUrl && hasTargetFixture && domMarkets.length) name = "EVENT_READY";
    else if (isEventUrl && hasTargetFixture) name = "EVENT_LOADING";
    else if (isEventUrl && target && pageText.trim().length > 200) name = "WRONG_EVENT";
    else if (isEventUrl) name = "EVENT";
    else if (hasTargetFixture) name = "LEAGUE";
    else if (pageLooksLikeLeague(pageText)) name = "LEAGUE";
    else if (pageLooksLikeHome(pageText)) name = "HOME";

    return {
      name,
      sourceUrl,
      pageText,
      domMarkets,
      hasTargetFixture: Boolean(hasTargetFixture),
      isEventUrl
    };
  }

  private async inspectCurrentPage(target: Bet365ClickTarget | null | undefined, timeout = 2_000) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    const sourceUrl = this.page.url();
    const pageText = await this.page.locator("body").innerText({ timeout }).catch(() => "");
    return this.classifyPageState(sourceUrl, pageText, target);
  }

  private async waitForPageState(
    target: Bet365ClickTarget | null | undefined,
    accepts: (state: Bet365PageState) => boolean,
    timeoutMs: number
  ) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    const deadline = Date.now() + timeoutMs;
    let latest = await this.inspectCurrentPage(target, 1_500);

    while (Date.now() < deadline) {
      if (accepts(latest)) return latest;
      await this.page.waitForTimeout(500);
      latest = await this.inspectCurrentPage(target, 1_500);
    }

    return latest;
  }

  private async clickOpenedEvent(target: Bet365ClickTarget | null | undefined) {
    if (!this.page) return false;

    await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
    const state = await this.waitForPageState(
      target,
      (candidate) => pageStateIsTargetEvent(candidate) || (candidate.isEventUrl && !target),
      5_000
    );

    return target ? pageStateIsTargetEvent(state) : state.isEventUrl;
  }

  private async restoreAfterRejectedClick(sourceUrl: string) {
    if (!this.page) return;
    const currentUrl = this.page.url();
    if (currentUrl === sourceUrl) return;
    if (isBet365EventUrl(currentUrl) || currentUrl.includes("bet365")) {
      await this.page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => undefined);
      await this.page.waitForTimeout(800);
    }
  }

  private async scrollSearchViewport(step: number) {
    if (!this.page) return;
    const viewport = this.page.viewportSize();
    if (viewport) {
      await this.page.mouse.move(Math.round(viewport.width * 0.72), Math.round(viewport.height * 0.62)).catch(() => undefined);
      await this.page.mouse.wheel(0, step).catch(() => undefined);
    }

    await this.page
      .evaluate((scrollStep) => {
        const elements = [document.scrollingElement, ...document.querySelectorAll("*")]
          .filter((node): node is Element => Boolean(node))
          .map((node) => node as HTMLElement)
          .filter((element) => {
            const style = window.getComputedStyle(element);
            const canScroll = element.scrollHeight > element.clientHeight + 40;
            const visible = style.display !== "none" && style.visibility !== "hidden";
            const overflow = `${style.overflowY} ${style.overflow}`.toLowerCase();
            return canScroll && visible && !overflow.includes("hidden");
          })
          .sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight);

        for (const element of elements.slice(0, 6)) {
          element.scrollTop += scrollStep;
        }

        window.scrollBy(0, scrollStep);
      }, step)
      .catch(() => undefined);
  }

  private async readFixtureCandidates(): Promise<Bet365FixtureCandidate[]> {
    if (!this.page) return [];
    return this.page
      .evaluate(() => {
        const normalize = (value: unknown) =>
          String(value ?? "")
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
            .replace(/[^a-z0-9.,]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const priceRe = /\b(?:[1-9]\d{0,2}|0)[.,]\d{2,3}\b/;
        const timeRe = /^([01]?\d|2[0-3]):[0-5]\d$/;
        const isVisible = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width >= 30 && rect.height >= 12 && rect.bottom >= 0 && rect.top <= window.innerHeight && style.display !== "none" && style.visibility !== "hidden";
        };
        const looksLikeTeamLine = (line: string) => {
          const clean = line.trim();
          const normalized = normalize(clean);
          if (clean.length < 2 || clean.length > 90) return false;
          if (!/[A-Za-z\u00C0-\u024F]/.test(clean)) return false;
          if (priceRe.test(clean) || timeRe.test(clean)) return false;
          if (/^(?:v|vs|x|-|draw|empate|popular|matches|jogos|full time result|resultado final)$/.test(normalized)) return false;
          if (/\b(?:pagamento antecipado|early payout|precos ajustados|enhanced prices|acum aumentado|acrescimos|promocoes|registre se|login)\b/.test(normalized)) return false;
          return true;
        };
        const parseTeams = (text: string) => {
          const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 30);
          for (const line of lines) {
            const parts = line.split(/\s+(?:v|vs|x)\s+/i).map((part) => part.trim()).filter(Boolean);
            if (parts.length === 2 && looksLikeTeamLine(parts[0]) && looksLikeTeamLine(parts[1])) {
              return { homeTeam: parts[0], awayTeam: parts[1], startTime: lines.find((candidate) => timeRe.test(candidate)) ?? null };
            }
          }

          for (let index = 1; index < lines.length - 1; index += 1) {
            if (!/^(?:v|vs|x|-)$/.test(lines[index].trim().toLowerCase())) continue;
            const homeTeam = lines.slice(Math.max(0, index - 8), index).reverse().find(looksLikeTeamLine);
            const awayTeam = lines.slice(index + 1, Math.min(lines.length, index + 8)).find(looksLikeTeamLine);
            if (homeTeam && awayTeam) return { homeTeam, awayTeam, startTime: lines.find((candidate) => timeRe.test(candidate)) ?? null };
          }

          const teamLines = lines.filter(looksLikeTeamLine);
          if (teamLines.length >= 2) return { homeTeam: teamLines[0], awayTeam: teamLines[1], startTime: lines.find((candidate) => timeRe.test(candidate)) ?? null };
          return { homeTeam: null, awayTeam: null, startTime: lines.find((candidate) => timeRe.test(candidate)) ?? null };
        };

        const selectors = [
          ".rcl-ParticipantFixtureDetails-clickable",
          "[class*='ParticipantFixtureDetails-clickable']",
          "[class*='ParticipantFixtureDetails']",
          "[class*='FixtureDetails']",
          "[class*='EventRow']",
          "[class*='CouponParticipant']"
        ];
        const seen = new Set<Element>();
        const nodes = selectors.flatMap((selector) =>
          [...document.querySelectorAll(selector)].filter((node) => {
            if (seen.has(node)) return false;
            seen.add(node);
            return true;
          })
        );
        const candidates: Bet365FixtureCandidate[] = [];

        for (const node of nodes) {
          const element = node as HTMLElement;
          if (!isVisible(element)) continue;
          const rect = element.getBoundingClientRect();
          const text = (element.innerText || element.textContent || "").trim();
          if (text.length < 4 || text.length > 500 || rect.height > 240) continue;
          const teams = parseTeams(text);
          if (!teams.homeTeam || !teams.awayTeam) continue;
          candidates.push({
            text: text.slice(0, 500),
            homeTeam: teams.homeTeam,
            awayTeam: teams.awayTeam,
            startTime: teams.startTime,
            x: rect.left + Math.min(Math.max(rect.width * 0.35, 24), rect.width - 6),
            y: rect.top + rect.height / 2
          });
        }

        return [...new Map(candidates.map((candidate) => [`${normalize(candidate.homeTeam)}:${normalize(candidate.awayTeam)}:${candidate.startTime ?? ""}`, candidate])).values()];
      })
      .catch(() => []);
  }

  private async readMoneylineMarketCards(): Promise<Bet365DomMarketCard[]> {
    if (!this.page) return [];
    return this.page
      .evaluate(() => {
        const normalize = (value: unknown) =>
          String(value ?? "")
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
            .replace(/[^a-z0-9.,]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const isTargetHeader = (line: string) => {
          const normalized = normalize(line);
          return normalized.includes("full time result") || normalized.includes("resultado final");
        };
        const priceCount = (text: string) => [...text.matchAll(/\b([1-9]\d{0,2}[.,]\d{2,3})\b/g)].length;
        const headerCount = (text: string) => text.split(/\n+/).filter((line) => isTargetHeader(line)).length;
        const isVisible = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width >= 180 && rect.height >= 20 && style.display !== "none" && style.visibility !== "hidden";
        };
        const chooseCardRoot = (element: HTMLElement) => {
          let best: HTMLElement | null = null;
          let cursor: HTMLElement | null = element;
          while (cursor && cursor !== document.body && cursor !== document.documentElement) {
            if (!isVisible(cursor)) {
              cursor = cursor.parentElement;
              continue;
            }
            const rect = cursor.getBoundingClientRect();
            const text = (cursor.innerText || cursor.textContent || "").trim();
            const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
            if (text && text.length <= 1200 && lines.length <= 28 && rect.height <= 320 && headerCount(text) === 1) {
              best = cursor;
            }
            if (rect.height > 380 || lines.length > 34 || headerCount(text) > 1) break;
            cursor = cursor.parentElement;
          }
          return best ?? element;
        };

        const nodes = [...document.querySelectorAll("body *")].filter((node) => {
          const element = node as HTMLElement;
          if (!isVisible(element)) return false;
          const text = (element.innerText || element.textContent || "").trim();
          if (!text || text.length > 1300) return false;
          return text.split(/\n+/).some((line) => isTargetHeader(line));
        });
        const cards: Bet365DomMarketCard[] = [];

        for (const node of nodes) {
          const root = chooseCardRoot(node as HTMLElement);
          const rect = root.getBoundingClientRect();
          const text = (root.innerText || root.textContent || "").trim();
          const header = text.split(/\n+/).map((line) => line.trim()).find((line) => isTargetHeader(line)) ?? "Full Time Result";
          if (!text || headerCount(text) !== 1) continue;
          cards.push({
            header,
            text: text.slice(0, 1200),
            x: rect.right - 24,
            y: rect.top + Math.min(Math.max(rect.height / 2, 18), 34),
            priceCount: priceCount(text)
          });
        }

        return [...new Map(cards.map((card) => [`${Math.round(card.x)}:${Math.round(card.y)}:${normalize(card.header)}`, card])).values()];
      })
      .catch(() => []);
  }

  private async moneylineMarketHeaderClickPoints(header: string): Promise<Bet365ClickPoint[]> {
    if (!this.page) return [];
    return this.page
      .evaluate((targetHeader) => {
        const normalize = (value: unknown) =>
          String(value ?? "")
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
            .replace(/[^a-z0-9.,]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const target = normalize(targetHeader);
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
        const isVisible = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width >= 8 && rect.height >= 8 && style.display !== "none" && style.visibility !== "hidden";
        };
        const hasTargetHeader = (element: HTMLElement) =>
          (element.innerText || element.textContent || "")
            .split(/\n+/)
            .map((line) => normalize(line))
            .some((line) => line === target || line.includes(target));
        const visibleRect = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          return {
            left: clamp(rect.left, 0, window.innerWidth - 2),
            right: clamp(rect.right, 2, window.innerWidth - 2),
            top: clamp(rect.top, 0, window.innerHeight - 2),
            bottom: clamp(rect.bottom, 2, window.innerHeight - 2),
            width: rect.width,
            height: rect.height
          };
        };
        const clickPoints: Bet365ClickPoint[] = [];
        const addPoint = (x: number, y: number, reason: string) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          clickPoints.push({
            x: clamp(x, 2, window.innerWidth - 2),
            y: clamp(y, 2, window.innerHeight - 2),
            reason
          });
        };

        const headerElements = [...document.querySelectorAll("body *")]
          .map((node) => node as HTMLElement)
          .filter((element) => isVisible(element) && hasTargetHeader(element))
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
          });

        for (const headerElement of headerElements.slice(0, 8)) {
          headerElement.scrollIntoView({ block: "center", inline: "nearest" });
          const headerRect = visibleRect(headerElement);
          const headerY = headerRect.top + Math.max(Math.min(headerRect.height / 2, 24), 10);
          addPoint(window.innerWidth - 118, headerY, "viewport-right-at-header");
          addPoint(window.innerWidth - 64, headerY, "viewport-far-right-at-header");

          let root: HTMLElement | null = headerElement;
          let bestRoot: HTMLElement | null = headerElement;
          while (root && root !== document.body && root !== document.documentElement) {
            if (hasTargetHeader(root) && isVisible(root)) {
              const rect = root.getBoundingClientRect();
              const text = root.innerText || root.textContent || "";
              if (rect.width >= 180 && rect.height >= 24 && rect.height <= 360 && text.length <= 1400) {
                bestRoot = root;
              }
            }
            root = root.parentElement;
          }

          const rootRect = visibleRect(bestRoot);
          const clickableSelectors = [
            "button",
            "[role='button']",
            "[class*='Chevron']",
            "[class*='chevron']",
            "[class*='Arrow']",
            "[class*='arrow']",
            "[class*='Toggle']",
            "[class*='toggle']",
            "[class*='Header']",
            "[class*='Market']"
          ];
          const clickables = clickableSelectors
            .flatMap((selector) => [...bestRoot.querySelectorAll(selector)])
            .map((node) => node as HTMLElement)
            .filter(isVisible)
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.left >= rootRect.left && rect.right <= rootRect.right + 4)
            .sort((left, right) => right.rect.right - left.rect.right || Math.abs(left.rect.top - headerRect.top) - Math.abs(right.rect.top - headerRect.top));

          const clickable = clickables[0];
          if (clickable) {
            addPoint(clickable.rect.left + clickable.rect.width / 2, clickable.rect.top + clickable.rect.height / 2, "child-clickable");
          }

          addPoint(rootRect.right - 24, headerY, "root-right-at-header");
          addPoint(window.innerWidth - 140, headerY, "viewport-safe-right-at-header");
          addPoint(rootRect.left + Math.min(180, Math.max(24, rootRect.width * 0.18)), headerY, "header-left-label");
        }

        return [...new Map(clickPoints.map((point) => [`${Math.round(point.x)}:${Math.round(point.y)}:${point.reason}`, point])).values()].slice(0, 24);
      }, header)
      .catch(() => []);
  }

  private async clickMoneylineMarketHeaderPoint(point: Bet365ClickPoint) {
    if (!this.page) return false;
    await this.page.mouse.move(point.x, point.y).catch(() => undefined);
    await this.page.mouse.click(point.x, point.y).catch(() => undefined);
    return true;
  }

  private async clickMoneylineMarketHeader(header: string) {
    if (!this.page) return false;

    for (const point of await this.moneylineMarketHeaderClickPoints(header)) {
      if (await this.clickMoneylineMarketHeaderPoint(point)) return true;
    }

    const clickHeaderRowChevron = async (locator: ReturnType<Page["getByText"]>, index: number) => {
      const box = await locator.nth(index).boundingBox().catch(() => null);
      const viewport = this.page?.viewportSize();
      if (!box || !viewport) return false;
      const x = Math.min(Math.max(box.x + box.width + 40, viewport.width - 140), viewport.width - 24);
      const y = box.y + Math.max(box.height / 2, 10);
      await this.page?.mouse.click(x, y).catch(() => undefined);
      return true;
    };

    const locator = this.page.getByText(header, { exact: true });
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 4); index += 1) {
      try {
        if (await clickHeaderRowChevron(locator, index)) return true;
        await locator.nth(index).click({ timeout: 2_500 });
        return true;
      } catch {
        // Tenta outro elemento com o mesmo header.
      }
    }

    const looseLocator = this.page.getByText(header, { exact: false });
    const looseCount = await looseLocator.count().catch(() => 0);
    for (let index = 0; index < Math.min(looseCount, 4); index += 1) {
      try {
        if (await clickHeaderRowChevron(looseLocator, index)) return true;
        await looseLocator.nth(index).click({ timeout: 2_500 });
        return true;
      } catch {
        // Tenta outro elemento compativel com o mesmo header.
      }
    }

    return false;
  }

  private async expandMoneylineMarketHeader(header: string) {
    if (!this.page) return false;

    for (const point of await this.moneylineMarketHeaderClickPoints(header)) {
      await this.clickMoneylineMarketHeaderPoint(point);
      if (await this.waitForMoneylineHeaderPrices(header, 3, 1_250)) return true;
    }

    const clickHeaderRowChevron = async (locator: ReturnType<Page["getByText"]>, index: number) => {
      const box = await locator.nth(index).boundingBox().catch(() => null);
      const viewport = this.page?.viewportSize();
      if (!box || !viewport) return false;
      const x = Math.min(Math.max(box.x + box.width + 40, viewport.width - 140), viewport.width - 24);
      const y = box.y + Math.max(box.height / 2, 10);
      await this.page?.mouse.click(x, y).catch(() => undefined);
      return this.waitForMoneylineHeaderPrices(header, 3, 1_250);
    };

    const locator = this.page.getByText(header, { exact: true });
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 4); index += 1) {
      if (await clickHeaderRowChevron(locator, index)) return true;
      await locator.nth(index).click({ timeout: 1_500 }).catch(() => undefined);
      if (await this.waitForMoneylineHeaderPrices(header, 3, 1_250)) return true;
    }

    const looseLocator = this.page.getByText(header, { exact: false });
    const looseCount = await looseLocator.count().catch(() => 0);
    for (let index = 0; index < Math.min(looseCount, 4); index += 1) {
      if (await clickHeaderRowChevron(looseLocator, index)) return true;
      await looseLocator.nth(index).click({ timeout: 1_500 }).catch(() => undefined);
      if (await this.waitForMoneylineHeaderPrices(header, 3, 1_250)) return true;
    }

    return false;
  }

  private async clickMoneylineMarketCard(card: Bet365DomMarketCard) {
    if (!this.page) return false;
    if (await this.clickMoneylineMarketHeader(card.header)) return true;
    await this.page.mouse.click(card.x, card.y).catch(() => undefined);
    return true;
  }

  private async waitForMoneylineHeaderPrices(header: string, expectedPrices: number, timeoutMs: number) {
    if (!this.page) return false;
    const deadline = Date.now() + timeoutMs;
    const key = marketHeaderKey(header);

    while (Date.now() < deadline) {
      const bodyText = await this.page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
      const block = moneylineBlocksFromText(bodyText).find((candidate) => {
        const candidateHeader = candidate
          .split(/\n+/)
          .map((line) => line.trim())
          .find((line) => isTargetMoneylineHeader(normalizeText(line)));
        return candidateHeader ? marketHeaderKey(candidateHeader) === key : false;
      });
      if (block && extractPriceValues(block).length >= expectedPrices) return true;
      await this.page.waitForTimeout(250);
    }

    return false;
  }

  private async expandCollapsedMoneylineMarkets(target: Bet365ClickTarget | null | undefined) {
    if (!this.page) return 0;
    const attemptsByKey = new Map<string, number>();
    let expanded = 0;

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const cards = await this.readMoneylineMarketCards();
      const candidate = cards.find((card) => {
        const key = `${Math.round(card.x)}:${Math.round(card.y)}:${marketHeaderKey(card.header)}`;
        if ((attemptsByKey.get(key) ?? 0) >= 2) return false;
        const parsed = target ? parseVisibleMoneylineMarkets([card.text], target) : [];
        return card.priceCount < 3 || (target ? parsed.length === 0 : false);
      });

      if (candidate) {
        const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}:${marketHeaderKey(candidate.header)}`;
        attemptsByKey.set(key, (attemptsByKey.get(key) ?? 0) + 1);
        if (await this.expandMoneylineMarketHeader(candidate.header)) expanded += 1;
        continue;
      }

      const bodyText = await this.page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
      const bodyCandidate = moneylineBlocksFromText(bodyText)
        .map((block) => ({
          block,
          header: block.split(/\n+/).map((line) => line.trim()).find((line) => isTargetMoneylineHeader(normalizeText(line))) ?? "Full Time Result",
          priceCount: extractPriceValues(block).length,
          parsed: target ? parseVisibleMoneylineMarkets([block], target) : []
        }))
        .find((block) => {
          const key = `body:${marketHeaderKey(block.header)}:${block.priceCount}`;
          if ((attemptsByKey.get(key) ?? 0) >= 2) return false;
          return block.priceCount < 3 || (target ? block.parsed.length === 0 : false);
        });

      if (!bodyCandidate) break;
      const key = `body:${marketHeaderKey(bodyCandidate.header)}:${bodyCandidate.priceCount}`;
      attemptsByKey.set(key, (attemptsByKey.get(key) ?? 0) + 1);
      if (await this.expandMoneylineMarketHeader(bodyCandidate.header)) {
        expanded += 1;
        continue;
      }

      break;
    }

    if (expanded > 0) {
      await this.logger?.("info", "mercados 1X2 da bet365 expandidos no DOM", { expanded });
    }
    return expanded;
  }

  private async clickFixtureContainerByTeam(target: Bet365ClickTarget | null | undefined, sourceUrl: string) {
    if (!this.page || !target?.homeTeam || !target.awayTeam) return null;

    const homeGroups = teamTokenGroups(target.homeTeam);
    const awayGroups = teamTokenGroups(target.awayTeam);
    if (!homeGroups.length || !awayGroups.length) return null;

    await this.page.keyboard.press("Home").catch(() => undefined);
    await this.page
      .evaluate(() => {
        for (const node of [document.scrollingElement, ...document.querySelectorAll("*")]) {
          const element = node as HTMLElement | null;
          if (element && element.scrollHeight > element.clientHeight + 40) element.scrollTop = 0;
        }
      })
      .catch(() => undefined);
    await this.page.waitForTimeout(500);

    for (let pageDown = 0; pageDown < 18; pageDown += 1) {
      const scoredCandidates = (await this.readFixtureCandidates())
        .map((candidate) => ({ candidate, match: scoreFixtureCandidate(target, candidate) }))
        .filter((item): item is { candidate: Bet365FixtureCandidate; match: Bet365FixtureEvidence } => Boolean(item.match))
        .sort((left, right) => right.match.score - left.match.score);
      const bestCandidate = selectFixtureCandidate(scoredCandidates);
      if (bestCandidate) {
        await this.page.mouse.click(bestCandidate.candidate.x, bestCandidate.candidate.y);
        if (await this.clickOpenedEvent(target)) {
          await this.logger?.("info", "evento da bet365 aberto por matching DOM", {
            homeTeam: target.homeTeam,
            awayTeam: target.awayTeam,
            bookmakerHomeTeam: bestCandidate.candidate.homeTeam,
            bookmakerAwayTeam: bestCandidate.candidate.awayTeam,
            mode: bestCandidate.match.mode,
            score: bestCandidate.match.score,
            teamScore: bestCandidate.match.teamScore,
            bestSingleTeamScore: bestCandidate.match.bestSingleTeamScore,
            timeScore: bestCandidate.match.timeScore,
            sourceUrl: this.page.url(),
            text: bestCandidate.candidate.text.slice(0, 180)
          });
          return target.homeTeam;
        }
        await this.restoreAfterRejectedClick(sourceUrl);
      }

      const candidate = await this.page
        .evaluate(
          ({ homeGroups, awayGroups }) => {
            const normalize = (value: unknown) =>
              String(value ?? "")
                .normalize("NFD")
                .replace(/\p{Diacritic}/gu, "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            const matchesGroup = (rawText: string, groups: string[][]) => {
              const normalized = normalize(rawText);
              const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
              return groups.some((group) => group.every((token) => (token.length <= 3 ? tokens.has(token) : normalized.includes(token))));
            };
            const selectors = [
              ".rcl-ParticipantFixtureDetails-clickable",
              "[class*='ParticipantFixtureDetails-clickable']",
              "[class*='ParticipantFixtureDetails']"
            ];
            const seen = new Set<Element>();
            const nodes = selectors.flatMap((selector) =>
              [...document.querySelectorAll(selector)].filter((node) => {
                if (seen.has(node)) return false;
                seen.add(node);
                return true;
              })
            );

            for (const node of nodes) {
              const element = node as HTMLElement;
              const text = element.innerText || element.textContent || "";
              if (!matchesGroup(text, homeGroups) || !matchesGroup(text, awayGroups)) continue;
              const rect = element.getBoundingClientRect();
              if (rect.width < 20 || rect.height < 15) continue;
              if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

              return {
                x: rect.left + Math.min(Math.max(rect.width * 0.35, 24), rect.width - 6),
                y: rect.top + rect.height / 2,
                text: text.trim().slice(0, 180)
              };
            }

            return null;
          },
          { homeGroups, awayGroups }
        )
        .catch(() => null);

      if (candidate) {
        await this.page.mouse.click(candidate.x, candidate.y);
        if (await this.clickOpenedEvent(target)) {
          await this.logger?.("info", "evento da bet365 aberto por container DOM", {
            homeTeam: target.homeTeam,
            awayTeam: target.awayTeam,
            sourceUrl: this.page.url(),
            text: candidate.text
          });
          return target.homeTeam;
        }
        await this.restoreAfterRejectedClick(sourceUrl);
      }

      await this.scrollSearchViewport(850);
      await this.page.waitForTimeout(750);
    }

    return null;
  }

  private async clickEventByTeam(target: Bet365ClickTarget | null | undefined, sourceUrl: string) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");

    const containerClickedTeam = await this.clickFixtureContainerByTeam(target, sourceUrl);
    if (containerClickedTeam) return containerClickedTeam;

    for (const team of targetTeamNames(target)) {
      for (const alias of [...new Set(nationalTeamAliases(team).flatMap(withAmpersandAliases))]) {
        const locator = this.page.getByText(alias, { exact: false });
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 10); index += 1) {
          try {
            await locator.nth(index).click({ timeout: 2_500 });
            if (await this.clickOpenedEvent(target)) {
              await this.logger?.("info", "evento da bet365 aberto por clique DOM", { team, alias, sourceUrl: this.page.url() });
              return team;
            }
            await this.restoreAfterRejectedClick(sourceUrl);
          } catch {
            // Tenta o proximo match de texto visivel.
          }
        }
      }

      for (const pattern of teamNameSearchPatterns(team)) {
        const locator = this.page.getByText(pattern);
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 10); index += 1) {
          try {
            await locator.nth(index).click({ timeout: 2_500 });
            if (await this.clickOpenedEvent(target)) {
              await this.logger?.("info", "evento da bet365 aberto por clique DOM flexivel", { team, pattern: pattern.source, sourceUrl: this.page.url() });
              return team;
            }
            await this.restoreAfterRejectedClick(sourceUrl);
          } catch {
            // Tenta o proximo match de texto visivel.
          }
        }
      }
    }

    await this.logger?.("warn", "nao encontrei jogo da bet365 para clique DOM", { target });
    return null;
  }

  private async readVisibleMoneylineMarkets(target: Bet365ClickTarget | null | undefined) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    let rawText = "";
    let expanded = 0;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (attempt === 1) expanded += await this.expandCollapsedMoneylineMarkets(target);

      const cards = await this.readMoneylineMarketCards();
      const cardTexts = cards.map((card) => card.text).filter(Boolean);
      rawText = cardTexts.length
        ? cardTexts.join("\n")
        : await this.page.locator("body").innerText({ timeout: 4_000 }).catch(() => "");
      let markets = parseVisibleMoneylineMarkets(cardTexts.length ? cardTexts : [rawText], target);

      if (!markets.length && cardTexts.length) {
        const bodyText = await this.page.locator("body").innerText({ timeout: 4_000 }).catch(() => "");
        const bodyMarkets = parseVisibleMoneylineMarkets([bodyText], target);
        if (bodyMarkets.length) {
          markets = bodyMarkets;
          rawText = bodyText;
        }
      }

      if (markets.length) {
        const closedHeaders = closedMoneylineHeaders(rawText);
        if (closedHeaders.length && attempt < 4) {
          expanded += await this.expandCollapsedMoneylineMarkets(target);
          await this.page.waitForTimeout(350);
          continue;
        }

        await this.logger?.("info", "mercados da bet365 lidos do DOM", {
          markets: markets.length,
          categories: markets.map((market) => market.paCategory),
          cards: cards.length,
          expanded,
          closedHeaders: closedHeaders.map((item) => item.header)
        });
        return { markets, rawText, expanded };
      }
      await this.page.waitForTimeout(500);
    }

    return { markets: [], rawText, expanded };
  }

  async collectEventOdds(
    url: string,
    waitMs: number,
    target?: Bet365ClickTarget | null,
    clickEvent = Boolean(target),
    forceNavigate = false
  ): Promise<Bet365NetworkCapture> {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");

    const payloads: string[] = [];
    let domMarkets: Bet365DomMarket[] = [];
    let domMarketsExpanded = 0;
    let pageText = "";
    let clickedTeam: string | null = null;
    let pageState: Bet365PageStateName = "UNKNOWN";
    const onWebSocket = (ws: WebSocket) => {
      ws.on("framereceived", (frame) => {
        const payload = payloadToString(frame.payload);
        if (looksLikeBet365Payload(payload)) payloads.push(payload);
      });
    };

    this.page.on("websocket", onWebSocket);
    try {
      const isExpectedEventPage = (candidate: Bet365PageState | null | undefined) =>
        Boolean(candidate && matchesExpectedBet365EventUrl(url, candidate.sourceUrl));
      let state = target ? await this.inspectCurrentPage(target, 1_500).catch(() => null) : null;
      if (state) pageState = state.name;

      if (!forceNavigate && target && pageStateIsTargetEvent(state) && isExpectedEventPage(state)) {
        await this.logger?.("info", "pagina atual da bet365 ja esta no evento alvo", {
          state: state.name,
          sourceUrl: state.sourceUrl,
          markets: state.domMarkets.length
        });
      } else {
        await this.navigate(url, waitMs);
        state = target
          ? await this.waitForPageState(
              target,
              (candidate) => (pageStateIsTargetEvent(candidate) && isExpectedEventPage(candidate)) || candidate.name === "LEAGUE",
              Math.max(4_000, Math.min(waitMs, 10_000))
            )
          : await this.inspectCurrentPage(target, 1_500).catch(() => null);
        if (state) pageState = state.name;
      }

      if (target && clickEvent) {
        if (!pageStateIsTargetEvent(state)) {
          if (state?.name !== "LEAGUE") {
            state = await this.waitForPageState(
              target,
              (candidate) => (pageStateIsTargetEvent(candidate) && isExpectedEventPage(candidate)) || candidate.name === "LEAGUE",
              Math.max(4_000, Math.min(waitMs, 10_000))
            );
            pageState = state.name;
          }

          if (pageStateIsTargetEvent(state) && isExpectedEventPage(state)) {
            await this.logger?.("info", "evento alvo da bet365 detectado sem novo clique", {
              state: state.name,
              sourceUrl: state.sourceUrl,
              markets: state.domMarkets.length
            });
          } else if (state?.name === "LEAGUE") {
            clickedTeam = await this.clickEventByTeam(target, url);
            const inspectedState = await this.inspectCurrentPage(target, 1_500).catch(() => null);
            if (inspectedState) state = inspectedState;
            pageState = state.name;
          }
        }
      }

      if (target && clickEvent && !clickedTeam && (!pageStateIsTargetEvent(state) || !isExpectedEventPage(state))) {
        pageText = state?.pageText || (await this.pageBodyText(2_000));
        return {
          sourceUrl: this.page.url(),
          payloads,
          domMarkets,
          domMarketsExpanded,
          clickedTeam,
          pageText,
          pageState
        };
      }

      if (!matchesExpectedBet365EventUrl(url, this.page.url())) {
        pageText = state?.pageText || (await this.pageBodyText(2_000));
        return {
          sourceUrl: this.page.url(),
          payloads,
          domMarkets,
          domMarketsExpanded,
          clickedTeam,
          pageText,
          pageState: "WRONG_EVENT"
        };
      }

      if (target && pageStateIsTargetEvent(state)) {
        state = await this.waitForPageState(
          target,
          (candidate) => candidate.name === "EVENT_READY" && isExpectedEventPage(candidate),
          Math.min(waitMs, 6_000)
        );
        pageState = state.name;
      }

      await this.page.waitForTimeout(pageState === "EVENT_READY" ? Math.min(waitMs, 2_500) : waitMs);
      try {
        const domRead = await this.readVisibleMoneylineMarkets(target);
        domMarkets = domRead.markets;
        domMarketsExpanded = domRead.expanded;
        pageText = domRead.rawText;
        pageState = this.classifyPageState(this.page.url(), pageText, target).name;
      } catch (error) {
        await this.logger?.("warn", "leitura DOM da bet365 falhou", {
          error: error instanceof Error ? error.message : String(error)
        });
        pageText = await this.page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
        pageState = this.classifyPageState(this.page.url(), pageText, target).name;
      }
      return {
        sourceUrl: this.page.url(),
        payloads,
        domMarkets,
        domMarketsExpanded,
        clickedTeam,
        pageText,
        pageState
      };
    } finally {
      this.page.off("websocket", onWebSocket);
    }
  }

  async close() {
    if (this.closePageOnClose) {
      await this.page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
  }
}

export class Bet365NetworkClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private mainController: Bet365PageController | null = null;

  constructor(private readonly logger?: Logger) {}

  async connectToExistingChrome(debugPort: number) {
    if (this.browser?.isConnected() && this.context && this.mainController) return;

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const contexts = browser.contexts();
    const context = contexts[0] ?? (await browser.newContext());
    const pages = context.pages();
    const bet365Page = pages.find((page) => page.url().includes("bet365"));
    const page = bet365Page ?? pages[0] ?? (await context.newPage());

    this.browser = browser;
    this.context = context;
    this.mainController = new Bet365PageController(page, this.logger, false);
    await this.logger?.("info", "cliente CDP da bet365 conectado", { debugPort, pages: pages.length });
  }

  private requireMainController() {
    if (!this.mainController) throw new Error("Browser da Bet365 nao conectado via CDP.");
    return this.mainController;
  }

  private async newTabController() {
    if (!this.context) throw new Error("Browser da Bet365 nao conectado via CDP.");
    const page = await this.context.newPage();
    return new Bet365PageController(page, this.logger, true);
  }

  async navigate(url: string, timeoutMs: number) {
    return this.requireMainController().navigate(url, timeoutMs);
  }

  async currentUrl() {
    return this.mainController?.currentUrl() ?? "";
  }

  async collectEventOdds(
    url: string,
    waitMs: number,
    target?: Bet365ClickTarget | null,
    clickEvent = Boolean(target),
    forceNavigate = false
  ): Promise<Bet365NetworkCapture> {
    return this.requireMainController().collectEventOdds(url, waitMs, target, clickEvent, forceNavigate);
  }

  async collectEventOddsInNewTab(
    url: string,
    waitMs: number,
    target?: Bet365ClickTarget | null,
    clickEvent = Boolean(target),
    forceNavigate = false
  ): Promise<Bet365NetworkCapture> {
    const controller = await this.newTabController();
    try {
      return await controller.collectEventOdds(url, waitMs, target, clickEvent, forceNavigate);
    } finally {
      await controller.close();
    }
  }

  async withNewTab<T>(worker: (tab: Bet365NetworkTabSession) => Promise<T>): Promise<T> {
    const controller = await this.newTabController();
    const tab: Bet365NetworkTabSession = {
      collectEventOdds: (url, waitMs, target, clickEvent = Boolean(target), forceNavigate = false) =>
        controller.collectEventOdds(url, waitMs, target, clickEvent, forceNavigate)
    };

    try {
      return await worker(tab);
    } finally {
      await controller.close();
    }
  }

  async close() {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.mainController = null;
  }
}

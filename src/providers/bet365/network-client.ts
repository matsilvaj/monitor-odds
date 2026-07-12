import { chromium, type Browser, type BrowserContext, type Page, type WebSocket } from "playwright-core";
import { nationalTeamAliases } from "../../domain/matching/team-aliases.js";
import { matchingTokens, teamNameSearchPatterns } from "../../domain/matching/text-similarity.js";
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

function textHasFixturePair(rawText: string, target: Bet365ClickTarget | null | undefined) {
  return textMatchesTokenGroups(rawText, teamTokenGroups(target?.homeTeam)) && textMatchesTokenGroups(rawText, teamTokenGroups(target?.awayTeam));
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
    ) ||
    (/^[a-z0-9 ]{3,70}$/.test(normalizedLine) &&
      !normalizedLine.includes(".") &&
      !normalizedLine.includes(",") &&
      /\b(?:qualify|qualificar|classificar|kick|pontape|score|placar|goals|gols|corners|escanteios|cards|cartoes|half|tempo|other|outro|asian|asiaticas|builder|stats|estatisticas|chutes|marcadores)\b/.test(normalizedLine))
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
  const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
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

function labelMatchesTeam(label: string, team: string | null | undefined) {
  if (!label.trim() || !team?.trim()) return false;
  if (textMatchesTokenGroups(label, teamTokenGroups(team))) return true;
  return teamNameSearchPatterns(team).some((pattern) => new RegExp(pattern.source, "i").test(label));
}

function selectionRowsMatchTarget(target: Bet365ClickTarget | null | undefined, rows: Array<{ label: string; price: number }>) {
  if (!target?.homeTeam || !target.awayTeam || rows.length !== 3) return false;
  const drawLabel = normalizeText(rows[1]?.label ?? "");
  if (drawLabel && drawLabel !== "draw" && drawLabel !== "empate" && drawLabel !== "x") return false;

  const normalPair = labelMatchesTeam(rows[0]?.label ?? "", target.homeTeam) && labelMatchesTeam(rows[2]?.label ?? "", target.awayTeam);
  const invertedPair = labelMatchesTeam(rows[0]?.label ?? "", target.awayTeam) && labelMatchesTeam(rows[2]?.label ?? "", target.homeTeam);
  return normalPair || invertedPair;
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
  if (isTargetMoneylineHeader(normalized)) score += 2;
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
    const drawPrice = priceAfterLabel(rawText, drawLabel) ?? priceAfterLabel(rawText, "X");
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

  private async moneylineMarketHeaderClickPoint(header: string): Promise<Bet365ClickPoint | null> {
    if (!this.page) return null;
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
        const priceRe = /\b([1-9]\d{0,2}[.,]\d{2,3})\b/;
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
        const isVisible = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width >= 8 && rect.height >= 8 && style.display !== "none" && style.visibility !== "hidden";
        };
        const hasExactTargetHeader = (element: HTMLElement) =>
          (element.innerText || element.textContent || "")
            .split(/\n+/)
            .map((line) => normalize(line))
            .some((line) => line === target);

        const headerElements = [...document.querySelectorAll("body *")]
          .map((node) => node as HTMLElement)
          .filter((element) => isVisible(element) && hasExactTargetHeader(element))
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
          });

        for (const headerElement of headerElements.slice(0, 8)) {
          headerElement.scrollIntoView({ block: "center", inline: "nearest" });
          let cursor: HTMLElement | null = headerElement;
          let headerRow: HTMLElement | null = null;
          while (cursor && cursor !== document.body && cursor !== document.documentElement) {
            if (!hasExactTargetHeader(cursor) || !isVisible(cursor)) break;
            const rect = cursor.getBoundingClientRect();
            const text = (cursor.innerText || cursor.textContent || "").trim();

            // A faixa do cabecalho nunca contem odds. Paramos antes de subir
            // para o card inteiro, cuja area inclui as selecoes clicaveis.
            if (priceRe.test(text) || rect.height > 120 || text.length > 420) break;
            if (rect.width >= 180 && rect.height >= 20) headerRow = cursor;
            cursor = cursor.parentElement;
          }

          if (!headerRow) continue;
          const headerRect = headerRow.getBoundingClientRect();
          const toggleSelectors = [
            "[class*='Chevron']",
            "[class*='chevron']",
            "[class*='Arrow']",
            "[class*='arrow']",
            "[class*='Toggle']",
            "[class*='toggle']",
            "[aria-expanded]"
          ];
          const toggles = toggleSelectors
            .flatMap((selector) => [...headerRow.querySelectorAll(selector)])
            .map((node) => node as HTMLElement)
            .filter(isVisible)
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => {
              const centerY = rect.top + rect.height / 2;
              return (
                rect.left >= headerRect.left &&
                rect.right <= headerRect.right + 2 &&
                centerY >= headerRect.top &&
                centerY <= headerRect.bottom
              );
            })
            .sort((left, right) => right.rect.right - left.rect.right);

          const toggle = toggles[0];
          if (toggle) {
            return {
              x: clamp(toggle.rect.left + toggle.rect.width / 2, 2, window.innerWidth - 2),
              y: clamp(toggle.rect.top + toggle.rect.height / 2, 2, window.innerHeight - 2),
              reason: "header-toggle"
            } satisfies Bet365ClickPoint;
          }

          // Fallback seguro: extremo direito da propria faixa de cabecalho.
          // Nunca usa o viewport nem procura qualquer <button> do card.
          return {
            x: clamp(headerRect.right - 24, headerRect.left + 8, window.innerWidth - 2),
            y: clamp(headerRect.top + Math.min(Math.max(headerRect.height / 2, 12), 32), 2, window.innerHeight - 2),
            reason: "header-row-right"
          } satisfies Bet365ClickPoint;
        }

        return null;
      }, header)
      .catch(() => null);
  }
  private async clickMoneylineMarketHeaderPoint(point: Bet365ClickPoint) {
    if (!this.page) return false;
    await this.page.mouse.move(point.x, point.y).catch(() => undefined);
    await this.page.mouse.click(point.x, point.y).catch(() => undefined);
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

  private async expandMoneylineMarketHeader(header: string) {
    if (!this.page) return false;
    const point = await this.moneylineMarketHeaderClickPoint(header);
    if (!point) {
      await this.logger?.("warn", "cabecalho 1X2 da bet365 sem alvo seguro para expansao", { header });
      return false;
    }

    await this.clickMoneylineMarketHeaderPoint(point);
    const expanded = await this.waitForMoneylineHeaderPrices(header, 3, 1_500);
    if (!expanded) {
      await this.logger?.("warn", "mercado 1X2 da bet365 nao expandiu apos clique seguro", {
        header,
        reason: point.reason
      });
    }
    return expanded;
  }
  private async expandCollapsedMoneylineMarkets(target: Bet365ClickTarget | null | undefined) {
    if (!this.page) return 0;
    const attempted = new Set<string>();
    let expanded = 0;

    // Existem no maximo dois mercados 1X2 relevantes: com PA e sem PA.
    // Cada card fechado recebe no maximo um clique.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const cards = await this.readMoneylineMarketCards();
      const candidate = cards.find((card) => {
        const key = `${Math.round(card.x)}:${Math.round(card.y)}:${marketHeaderKey(card.header)}`;
        if (attempted.has(key)) return false;
        return card.priceCount === 0 && (!target || !textHasFixturePair(card.text, target));
      });

      if (!candidate) break;
      const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}:${marketHeaderKey(candidate.header)}`;
      attempted.add(key);
      if (await this.expandMoneylineMarketHeader(candidate.header)) expanded += 1;
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
        const closedCards = cards.filter((card) => card.priceCount === 0 && (!target || !textHasFixturePair(card.text, target)));
        if (closedCards.length && attempt < 4) {
          const newlyExpanded = await this.expandCollapsedMoneylineMarkets(target);
          expanded += newlyExpanded;
          if (newlyExpanded > 0) {
            await this.page.waitForTimeout(350);
            continue;
          }
          await this.logger?.("warn", "mercado 1X2 fechado permaneceu sem alvo seguro", {
            headers: closedCards.map((card) => card.header)
          });
        }

        await this.logger?.("info", "mercados da bet365 lidos do DOM", {
          markets: markets.length,
          categories: markets.map((market) => market.paCategory),
          cards: cards.length,
          expanded,
          closedHeaders: closedCards.map((card) => card.header)
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
      let state = target ? await this.inspectCurrentPage(target, 1_500).catch(() => null) : null;
      if (state) pageState = state.name;

      if (!forceNavigate && target && pageStateIsTargetEvent(state)) {
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
              (candidate) => pageStateIsTargetEvent(candidate) || candidate.name === "LEAGUE",
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
              (candidate) => pageStateIsTargetEvent(candidate) || candidate.name === "LEAGUE",
              Math.max(4_000, Math.min(waitMs, 10_000))
            );
            pageState = state.name;
          }

          if (pageStateIsTargetEvent(state)) {
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

      if (target && clickEvent && !clickedTeam && !pageStateIsTargetEvent(state)) {
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

      if (target && pageStateIsTargetEvent(state)) {
        state = await this.waitForPageState(target, (candidate) => candidate.name === "EVENT_READY", Math.min(waitMs, 6_000));
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

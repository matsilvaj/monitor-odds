import { chromium, type Browser, type BrowserContext, type Page, type WebSocket } from "playwright-core";
import type { Bet365DomMarket, Logger } from "./types.js";

export type Bet365NetworkCapture = {
  sourceUrl: string;
  payloads: string[];
  domMarkets: Bet365DomMarket[];
  domMarketsExpanded: number;
  pageText: string;
  pageState: Bet365PageStateName;
};

export type Bet365NetworkTabSession = {
  collectEventOdds(url: string, waitMs: number, eventIndex?: number, clickEvent?: boolean, forceNavigate?: boolean, homeTeam?: string, awayTeam?: string): Promise<Bet365NetworkCapture>;
};

type Bet365PageStateName = "HOME" | "LEAGUE" | "EVENT" | "EVENT_READY" | "EVENT_LOADING" | "UNKNOWN";

type Bet365PageState = {
  name: Bet365PageStateName;
  sourceUrl: string;
  pageText: string;
  domMarkets: Bet365DomMarket[];
  hasFixtureRows: boolean;
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

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.,]+/g, " ")
    .trim();
}

function pageLooksLikeHome(rawText: string) {
  const normalized = normalizeText(rawText);
  return /\b(?:bet365|todos os esportes|ao vivo|login|registre se|promocoes|inicio|cassino)\b/i.test(normalized);
}

function pageLooksLikeLeague(rawText: string) {
  const normalized = normalizeText(rawText);
  return /\b(?:matches|full time result|resultado final|pagamento antecipado|early payout|acum aumentado|aposta aumentada|bet builder)\b/i.test(normalized);
}

function pageStateIsEventReady(state: Bet365PageState | null | undefined): state is Bet365PageState & { name: "EVENT_READY" | "EVENT_LOADING" } {
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

// Extrai mercados 1X2 visíveis por posição (HOME=0, DRAW=1, AWAY=2).
// Sem matching por nome — pega as 3 primeiras linhas de preço de cada bloco.
function parseVisibleMoneylineMarkets(rawTexts: string[]): Bet365DomMarket[] {
  const markets: Bet365DomMarket[] = [];
  const marketBlocks = rawTexts.flatMap(moneylineBlocksFromText);

  for (const rawText of marketBlocks) {
    const normalized = normalizeText(rawText);
    if (!isTargetMoneylineHeader(normalized)) continue;
    if (blockLooksContaminated(rawText) || blockLooksLikeEnhancedOfferGroup(rawText)) continue;

    const priceRows = extractSelectionRows(rawText);
    if (priceRows.length < 3) continue;

    const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    markets.push({
      marketName: lines.find((line) => isTargetMoneylineHeader(normalizeText(line))) ?? "Full Time Result",
      paCategory: classifyVisibleMoneylineCategory(rawText),
      rawText,
      selections: priceRows.slice(0, 3).map((row) => ({ label: row.label, price: row.price }))
    });
  }

  const unique = new Map<string, Bet365DomMarket>();
  for (const market of markets) {
    const key = `${market.paCategory}:${market.selections.map((s) => s.price).join("/")}`;
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
    const timeout = Math.max(timeoutMs, 10_000);
    await this.page.goto(url, { waitUntil: "commit", timeout });
    await this.page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeout, 8_000) }).catch(() => undefined);
  }

  async currentUrl() {
    if (!this.page) return "";
    return this.page.url();
  }

  private async pageBodyText(timeout = 2_000) {
    if (!this.page) return "";
    return this.page.locator("body").innerText({ timeout }).catch(() => "");
  }

  private classifyPageState(sourceUrl: string, pageText: string, hasFixtureRows = false): Bet365PageState {
    const isEventUrl = isBet365EventUrl(sourceUrl);
    const domMarkets = parseVisibleMoneylineMarkets([pageText]);
    let name: Bet365PageStateName = "UNKNOWN";

    if (isEventUrl && domMarkets.length) name = "EVENT_READY";
    else if (isEventUrl && pageText.trim().length > 200) name = "EVENT_LOADING";
    else if (isEventUrl) name = "EVENT";
    else if (pageLooksLikeLeague(pageText)) name = "LEAGUE"; // hasFixtureRows não obrigatório — layout varia por liga
    else if (pageLooksLikeHome(pageText)) name = "HOME";

    return { name, sourceUrl, pageText, domMarkets, hasFixtureRows, isEventUrl };
  }

  private async inspectCurrentPage(timeout = 2_000) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    const sourceUrl = this.page.url();
    const pageText = await this.page.locator("body").innerText({ timeout }).catch(() => "");
    const hasFixtureRows = await this.page
      .locator("[class*='ParticipantFixtureDetails']")
      .count()
      .then((count) => count > 0)
      .catch(() => false);
    return this.classifyPageState(sourceUrl, pageText, hasFixtureRows);
  }

  private async waitForPageState(accepts: (state: Bet365PageState) => boolean, timeoutMs: number) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    const deadline = Date.now() + timeoutMs;
    let latest = await this.inspectCurrentPage(1_500);

    while (Date.now() < deadline) {
      if (accepts(latest)) return latest;
      await this.page.waitForTimeout(500);
      latest = await this.inspectCurrentPage(1_500);
    }

    return latest;
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

  private async expandCollapsedMoneylineMarkets() {
    if (!this.page) return 0;
    const attempted = new Set<string>();
    let expanded = 0;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const cards = await this.readMoneylineMarketCards();
      const candidate = cards.find((card) => {
        const key = `${Math.round(card.x)}:${Math.round(card.y)}:${marketHeaderKey(card.header)}`;
        if (attempted.has(key)) return false;
        return card.priceCount === 0;
      });

      if (!candidate) break;
      const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}:${marketHeaderKey(candidate.header)}`;
      attempted.add(key);

      const point = await this.moneylineMarketHeaderClickPoint(candidate.header);
      const clickPoint: Bet365ClickPoint = point ?? { x: candidate.x, y: candidate.y, reason: "card-coords-fallback" };
      await this.clickMoneylineMarketHeaderPoint(clickPoint);
      const confirmed = await this.waitForMoneylineHeaderPrices(candidate.header, 3, 2_500);
      if (confirmed) {
        expanded += 1;
      } else {
        await this.logger?.("warn", "mercado 1X2 da bet365 nao expandiu apos clique seguro", {
          header: candidate.header,
          reason: clickPoint.reason
        });
      }
    }

    if (expanded > 0) {
      await this.logger?.("info", "mercados 1X2 da bet365 expandidos no DOM", { expanded });
    }
    return expanded;
  }

  // Clica no evento da página de liga — busca por conteúdo (independente de classes CSS).
  private async clickFixtureContainerByIndex(eventIndex: number, sourceUrl: string, homeTeam = "", awayTeam = ""): Promise<boolean> {
    if (!this.page) return false;

    await this.logger?.("info", "tentando abrir evento da bet365", { eventIndex, homeTeam, awayTeam, sourceUrl });

    try {
      // Localiza a linha de fixture pelo nome do time via seletor de texto.
      // Independente de classes CSS e usa o click nativo do Playwright
      // (scroll → hover → click), que é indistinguível de um clique humano.
      if (!homeTeam) throw new Error("homeTeam não fornecido");
      const locator = this.page.getByText(homeTeam, { exact: true }).first();
      await locator.click({ timeout: 5_000 });
    } catch (error) {
      await this.logger?.("warn", "linha de fixture da bet365 nao encontrada", {
        eventIndex, homeTeam, awayTeam, sourceUrl,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }

    // Aguarda URL mudar para URL de evento (SPA com hash routing)
    const clickStart = Date.now();
    while (Date.now() - clickStart < 7_000) {
      await this.page.waitForTimeout(400);
      if (isBet365EventUrl(this.page.url())) break;
    }

    if (isBet365EventUrl(this.page.url())) {
      await this.logger?.("info", "evento da bet365 aberto com sucesso", {
        eventIndex, homeTeam, awayTeam, sourceUrl: this.page.url()
      });
      return true;
    }

    await this.logger?.("warn", "clique de fixture da bet365 nao abriu evento", {
      eventIndex, homeTeam, awayTeam, currentUrl: this.page.url()
    });
    await this.restoreAfterRejectedClick(sourceUrl);
    return false;
  }

  private async readVisibleMoneylineMarkets() {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    let rawText = "";
    let expanded = 0;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (attempt === 1) expanded += await this.expandCollapsedMoneylineMarkets();

      const cards = await this.readMoneylineMarketCards();
      const cardTexts = cards.map((card) => card.text).filter(Boolean);
      rawText = cardTexts.length
        ? cardTexts.join("\n")
        : await this.page.locator("body").innerText({ timeout: 4_000 }).catch(() => "");
      let markets = parseVisibleMoneylineMarkets(cardTexts.length ? cardTexts : [rawText]);

      if (!markets.length && cardTexts.length) {
        const bodyText = await this.page.locator("body").innerText({ timeout: 4_000 }).catch(() => "");
        const bodyMarkets = parseVisibleMoneylineMarkets([bodyText]);
        if (bodyMarkets.length) {
          markets = bodyMarkets;
          rawText = bodyText;
        }
      }

      if (markets.length) {
        const closedCards = cards.filter((card) => card.priceCount === 0);
        if (closedCards.length && attempt < 4) {
          const newlyExpanded = await this.expandCollapsedMoneylineMarkets();
          expanded += newlyExpanded;
          await this.page.waitForTimeout(400);
          continue;
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
    eventIndex = -1,
    clickEvent = false,
    forceNavigate = false,
    homeTeam = "",
    awayTeam = ""
  ): Promise<Bet365NetworkCapture> {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");

    const payloads: string[] = [];
    let domMarkets: Bet365DomMarket[] = [];
    let domMarketsExpanded = 0;
    let pageText = "";
    let pageState: Bet365PageStateName = "UNKNOWN";
    const onWebSocket = (ws: WebSocket) => {
      ws.on("framereceived", (frame) => {
        const payload = payloadToString(frame.payload);
        if (looksLikeBet365Payload(payload)) payloads.push(payload);
      });
    };

    this.page.on("websocket", onWebSocket);
    try {
      let state = await this.inspectCurrentPage(1_500).catch(() => null);
      if (state) pageState = state.name;

      // Otimização: se já estamos no evento certo (fluxo direto por URL), pula a navegação
      if (!forceNavigate && !clickEvent && isBet365EventUrl(url) && state?.sourceUrl === url && pageStateIsEventReady(state)) {
        await this.logger?.("info", "pagina atual da bet365 ja esta no evento alvo", {
          state: state.name,
          sourceUrl: state.sourceUrl,
          markets: state.domMarkets.length
        });
      } else {
        await this.navigate(url, waitMs);
        state = await this.waitForPageState(
          (candidate) => pageStateIsEventReady(candidate) || candidate.name === "LEAGUE",
          Math.max(4_000, Math.min(waitMs, 10_000))
        );
        if (state) pageState = state.name;
      }

      // Recuperação: página caiu na home em vez do destino
      if (
        !pageStateIsEventReady(state) &&
        state?.name !== "LEAGUE" &&
        (state?.name === "HOME" || state?.name === "UNKNOWN" || pageLooksLikeHome(state?.pageText ?? ""))
      ) {
        await this.logger?.("warn", "conteudo da bet365 nao carregou para a URL solicitada; reiniciando a rota da pagina", {
          requestedUrl: url,
          sourceUrl: state?.sourceUrl,
          state: state?.name
        });
        const baseUrl = `${new URL(url).origin}/`;
        await this.navigate(baseUrl, Math.max(waitMs, 10_000));
        await this.page.waitForTimeout(750);
        await this.navigate(url, waitMs);
        state = await this.waitForPageState(
          (candidate) => pageStateIsEventReady(candidate) || (clickEvent && candidate.name === "LEAGUE"),
          Math.max(4_000, Math.min(waitMs, 10_000))
        );
        pageState = state.name;

        if (!pageStateIsEventReady(state) && (!clickEvent || state.name !== "LEAGUE")) {
          await this.logger?.("warn", "rota recuperada da bet365 ainda sem conteudo; ativando a URL solicitada novamente", {
            requestedUrl: url,
            sourceUrl: state.sourceUrl,
            state: state.name
          });
          await this.navigate(url, waitMs);
          state = await this.waitForPageState(
            (candidate) => pageStateIsEventReady(candidate) || (clickEvent && candidate.name === "LEAGUE"),
            Math.max(4_000, Math.min(waitMs, 10_000))
          );
          pageState = state.name;
        }
      }

      // Fluxo de liga: clica no N-ésimo evento por índice de posição
      if (clickEvent && !pageStateIsEventReady(state)) {
        if (state?.name !== "LEAGUE") {
          state = await this.waitForPageState(
            (candidate) => pageStateIsEventReady(candidate) || candidate.name === "LEAGUE",
            Math.max(4_000, Math.min(waitMs, 10_000))
          );
          pageState = state.name;
        }

        if (!pageStateIsEventReady(state) && state?.name === "LEAGUE") {
          const clicked = await this.clickFixtureContainerByIndex(eventIndex, url, homeTeam, awayTeam);
          if (clicked) {
            state = await this.inspectCurrentPage(1_500).catch(() => null);
            if (state) pageState = state.name;
          } else {
            // Clique falhou — retorna capture com estado atual
            pageText = state?.pageText || (await this.pageBodyText(2_000));
            return { sourceUrl: this.page.url(), payloads, domMarkets, domMarketsExpanded, pageText, pageState };
          }
        }
      }

      // Aguarda EVENT_READY completo
      if (pageStateIsEventReady(state)) {
        state = await this.waitForPageState((candidate) => candidate.name === "EVENT_READY", Math.min(waitMs, 6_000));
        pageState = state.name;
      }

      await this.page.waitForTimeout(pageState === "EVENT_READY" ? Math.min(waitMs, 2_500) : waitMs);
      try {
        const domRead = await this.readVisibleMoneylineMarkets();
        domMarkets = domRead.markets;
        domMarketsExpanded = domRead.expanded;
        pageText = domRead.rawText;
        pageState = this.classifyPageState(this.page.url(), pageText).name;
      } catch (error) {
        await this.logger?.("warn", "leitura DOM da bet365 falhou", {
          error: error instanceof Error ? error.message : String(error)
        });
        pageText = await this.page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
        pageState = this.classifyPageState(this.page.url(), pageText).name;
      }
      return { sourceUrl: this.page.url(), payloads, domMarkets, domMarketsExpanded, pageText, pageState };
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

  async collectEventOdds(url: string, waitMs: number, eventIndex = -1, clickEvent = false, forceNavigate = false, homeTeam = "", awayTeam = ""): Promise<Bet365NetworkCapture> {
    return this.requireMainController().collectEventOdds(url, waitMs, eventIndex, clickEvent, forceNavigate, homeTeam, awayTeam);
  }

  async collectEventOddsInNewTab(url: string, waitMs: number, eventIndex = -1, clickEvent = false, forceNavigate = false, homeTeam = "", awayTeam = ""): Promise<Bet365NetworkCapture> {
    const controller = await this.newTabController();
    try {
      return await controller.collectEventOdds(url, waitMs, eventIndex, clickEvent, forceNavigate, homeTeam, awayTeam);
    } finally {
      await controller.close();
    }
  }

  async withNewTab<T>(worker: (tab: Bet365NetworkTabSession) => Promise<T>): Promise<T> {
    const controller = await this.newTabController();
    const tab: Bet365NetworkTabSession = {
      collectEventOdds: (url, waitMs, eventIndex = -1, clickEvent = false, forceNavigate = false, homeTeam = "", awayTeam = "") =>
        controller.collectEventOdds(url, waitMs, eventIndex ?? -1, clickEvent ?? false, forceNavigate ?? false, homeTeam ?? "", awayTeam ?? "")
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

import { chromium, type Browser, type BrowserContext, type Page, type WebSocket } from "playwright-core";
import { nationalTeamAliases } from "../../domain/matching/team-aliases.js";
import type { Bet365DomMarket, Logger } from "./types.js";

export type Bet365NetworkCapture = {
  sourceUrl: string;
  payloads: string[];
  domMarkets: Bet365DomMarket[];
  clickedTeam: string | null;
  pageText: string;
};

export type Bet365ClickTarget = {
  homeTeam: string | null;
  awayTeam: string | null;
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

function targetTeamNames(target: Bet365ClickTarget | null | undefined) {
  return [target?.homeTeam, target?.awayTeam].filter((team): team is string => Boolean(team?.trim()));
}

function withAmpersandAliases(value: string) {
  return [value, value.replace(/\band\b/gi, "&"), value.replace(/\s*&\s*/g, " and ")].filter(Boolean);
}

function targetTeamAliases(target: Bet365ClickTarget | null | undefined) {
  return targetTeamNames(target).map((team) => [...new Set(nationalTeamAliases(team).flatMap(withAmpersandAliases))]);
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.,]+/g, " ")
    .trim();
}

function parseVisibleMoneylineMarkets(rawTexts: string[], target: Bet365ClickTarget | null | undefined): Bet365DomMarket[] {
  const markets: Bet365DomMarket[] = [];
  const teams = targetTeamNames(target);
  const aliasesByTeam = targetTeamAliases(target);
  const marketBlocks = rawTexts.flatMap((rawText) => {
    const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const blocks: string[][] = [];
    for (const line of lines) {
      const normalized = normalizeText(line);
      const isHeader = normalized.includes("full time result") || normalized.includes("resultado final");
      if (isHeader || !blocks.length) blocks.push([]);
      blocks[blocks.length - 1].push(line);
    }
    return blocks.map((block) => block.join("\n"));
  });

  const priceAfterLabel = (rawText: string, label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = rawText.match(new RegExp(`${escaped}[\\s\\S]{0,60}?([1-9]\\d{0,2}[.,]\\d{2,3})\\b`, "i"));
    return match ? Number(match[1].replace(",", ".")) : null;
  };

  for (const rawText of marketBlocks) {
    const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const normalized = normalizeText(rawText);
    if (!normalized.includes("full time result") && !normalized.includes("resultado final")) continue;

    const paCategory =
      normalized.includes("pagamento antecipado") || normalized.includes("early payout")
        ? "COM_PA"
        : normalized.includes("enhanced prices") || normalized.includes("precos ajustados")
          ? "SEM_PA"
          : "SEM_PA";

    const selections = teams
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

    if (selections.length < 3) continue;
    markets.push({
      marketName: lines.find((line) => normalizeText(line).includes("full time result") || normalizeText(line).includes("resultado final")) ?? "Full Time Result",
      paCategory,
      rawText,
      selections: selections.slice(0, 3)
    });
  }

  const unique = new Map<string, Bet365DomMarket>();
  for (const market of markets) {
    const key = `${market.paCategory}:${market.selections.map((selection) => selection.price).join("/")}`;
    if (!unique.has(key)) unique.set(key, market);
  }
  const values = [...unique.values()];
  const comPa = values.find((market) => market.paCategory === "COM_PA");
  const semPa = values.find((market) => market.paCategory === "SEM_PA");
  return [comPa, semPa].filter((market): market is Bet365DomMarket => Boolean(market));
}

export class Bet365NetworkClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private readonly logger?: Logger) {}

  async connectToExistingChrome(debugPort: number) {
    if (this.browser?.isConnected() && this.context && this.page) return;

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const contexts = browser.contexts();
    const context = contexts[0] ?? (await browser.newContext());
    const pages = context.pages();
    const bet365Page = pages.find((page) => page.url().includes("bet365"));
    const page = bet365Page ?? pages[0] ?? (await context.newPage());

    this.browser = browser;
    this.context = context;
    this.page = page;
    await this.logger?.("info", "cliente CDP da bet365 conectado", { debugPort, pages: pages.length });
  }

  async navigate(url: string, timeoutMs: number) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(timeoutMs, 10_000) });
  }

  async currentUrl() {
    if (!this.page) return "";
    return this.page.url();
  }

  private async clickEventByTeam(target: Bet365ClickTarget | null | undefined) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");

    for (const team of targetTeamNames(target)) {
      for (const alias of [...new Set(nationalTeamAliases(team).flatMap(withAmpersandAliases))]) {
        const locator = this.page.getByText(alias, { exact: false });
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 10); index += 1) {
          try {
            await locator.nth(index).click({ timeout: 2_500 });
            await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
            await this.logger?.("info", "evento da bet365 aberto por clique DOM", { team, alias });
            return team;
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
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      rawText = await this.page.locator("body").innerText({ timeout: 4_000 }).catch(() => "");
      const markets = parseVisibleMoneylineMarkets([rawText], target);
      if (markets.length) {
        await this.logger?.("info", "mercados da bet365 lidos do DOM", {
          markets: markets.length,
          categories: markets.map((market) => market.paCategory)
        });
        return { markets, rawText };
      }
      await this.page.waitForTimeout(500);
    }

    await this.logger?.("warn", "texto DOM da bet365 sem mercados 1X2", {
      textChars: rawText.length,
      preview: rawText.slice(0, 600)
    });
    return { markets: [], rawText };
  }

  async collectEventOdds(url: string, waitMs: number, target?: Bet365ClickTarget | null): Promise<Bet365NetworkCapture> {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");

    const payloads: string[] = [];
    let domMarkets: Bet365DomMarket[] = [];
    let pageText = "";
    let clickedTeam: string | null = null;
    const onWebSocket = (ws: WebSocket) => {
      ws.on("framereceived", (frame) => {
        const payload = payloadToString(frame.payload);
        if (looksLikeBet365Payload(payload)) payloads.push(payload);
      });
    };

    this.page.on("websocket", onWebSocket);
    try {
      await this.navigate(url, waitMs);
      if (target) clickedTeam = await this.clickEventByTeam(target);
      await this.page.waitForTimeout(waitMs);
      try {
        const domRead = await this.readVisibleMoneylineMarkets(target);
        domMarkets = domRead.markets;
        pageText = domRead.rawText;
      } catch (error) {
        await this.logger?.("warn", "leitura DOM da bet365 falhou", {
          error: error instanceof Error ? error.message : String(error)
        });
        pageText = await this.page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      }
      return {
        sourceUrl: this.page.url(),
        payloads,
        domMarkets,
        clickedTeam,
        pageText
      };
    } finally {
      this.page.off("websocket", onWebSocket);
    }
  }

  async close() {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

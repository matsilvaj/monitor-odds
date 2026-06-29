import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { MeridianbetBookmakerConfig } from "../config/bookmakers.js";
import { nationalTeamAliases, nationalTeamTokenGroups, tokenGroupMatchesText } from "../domain/matching/team-aliases.js";
import type { PaCategory, Selection } from "../domain/normalize.js";

type Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

export type MeridianFixtureTarget = {
  id: string;
  homeTeam: string | null;
  awayTeam: string | null;
  leagueName: string | null;
  leagueCountry: string | null;
  startsAt: string;
};

export type MeridianCollectedSelection = {
  selection: Selection;
  label: string;
  price: number;
  index: number;
};

export type MeridianCollectedMarket = {
  marketName: string;
  paCategory: PaCategory;
  confidence: number;
  rawText: string;
  index: number;
  selections: MeridianCollectedSelection[];
};

export type MeridianCollectedEvent = {
  externalEventId: number;
  sourceUrl: string;
  eventName: string;
  bookmakerHomeTeam: string | null;
  bookmakerAwayTeam: string | null;
  orientation: "NORMAL" | "INVERTED";
  markets: MeridianCollectedMarket[];
  rawText: string;
};

type ClickTarget = {
  text: string;
  href: string | null;
  x: number;
  y: number;
  priority: number;
};

const PRICE_RE = /^(?:[1-9]\d{0,2}|0)(?:[.,]\d{1,3})?$/;
const SAFE_SHORT_TEAM_TOKENS = new Set(["dr", "rd", "u17", "u18", "u19", "u20", "u21", "u22", "usa", "eua", "uae"]);

function findChromeExecutable(configuredPath: string | undefined) {
  const candidates = [
    configuredPath,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => existsSync(candidate));
}

async function waitForCdp(port: number, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Chrome CDP não respondeu na porta ${port}`);
}

function normalizeVisibleText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parsePriceLine(value: string) {
  const trimmed = value.trim();
  if (!PRICE_RE.test(trimmed)) return null;
  const price = Number(trimmed.replace(",", "."));
  return Number.isFinite(price) && price >= 1.01 && price <= 1000 ? price : null;
}

function moneylinePricesFromBlock(rawText: string) {
  const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const prices = new Map<"1" | "X" | "2", number>();

  for (let index = 0; index < lines.length - 1; index += 1) {
    const label = lines[index].toUpperCase();
    if (label !== "1" && label !== "X" && label !== "2") continue;
    const price = parsePriceLine(lines[index + 1]);
    if (price != null) prices.set(label, price);
  }

  const home = prices.get("1");
  const draw = prices.get("X");
  const away = prices.get("2");
  return home != null && draw != null && away != null ? [home, draw, away] : [];
}

function hashToPositiveInt(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function parseMeridianEventId(sourceUrl: string, fallbackKey: string) {
  const eventId = /\/(\d+)(?:[/?#]|$)/.exec(sourceUrl)?.[1] ?? /[?&](?:event|eventId|matchId)=(\d+)/i.exec(sourceUrl)?.[1];
  const parsed = eventId ? Number(eventId) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : hashToPositiveInt(`${sourceUrl}:${fallbackKey}`);
}

export function isMeridianEventPageUrl(sourceUrl: string | null | undefined) {
  if (!sourceUrl) return false;
  try {
    return /\/\d+\/?$/.test(new URL(sourceUrl).pathname);
  } catch {
    return false;
  }
}

function classifyMarket(rawText: string): { category: PaCategory; confidence: number } {
  return normalizeVisibleText(rawText).includes("pagamento antecipado")
    ? { category: "COM_PA", confidence: 0.99 }
    : { category: "SEM_PA", confidence: 1 };
}

function canonicalSelectionForDisplayOrder(selection: Selection, orientation: "NORMAL" | "INVERTED"): Selection {
  if (orientation !== "INVERTED") return selection;
  if (selection === "HOME") return "AWAY";
  if (selection === "AWAY") return "HOME";
  return selection;
}

function parseMoneylineMarket(rawText: string, fixture: MeridianFixtureTarget, orientation: "NORMAL" | "INVERTED", index: number) {
  if (!/resultado\s+final/i.test(rawText)) return null;
  const odds = moneylinePricesFromBlock(rawText);
  if (odds.length < 3) return null;

  const pa = classifyMarket(rawText);
  const displayHomeTeam = orientation === "INVERTED" ? fixture.awayTeam : fixture.homeTeam;
  const displayAwayTeam = orientation === "INVERTED" ? fixture.homeTeam : fixture.awayTeam;
  return {
    marketName: "MoneyLine",
    paCategory: pa.category,
    confidence: pa.confidence,
    rawText: rawText.slice(0, 1500),
    index,
    selections: [
      { selection: canonicalSelectionForDisplayOrder("HOME", orientation), label: displayHomeTeam ?? "Home", price: odds[0], index: 0 },
      { selection: "DRAW" as Selection, label: "Draw", price: odds[1], index: 1 },
      { selection: canonicalSelectionForDisplayOrder("AWAY", orientation), label: displayAwayTeam ?? "Away", price: odds[2], index: 2 }
    ]
  } satisfies MeridianCollectedMarket;
}

function moneylineBlocksFromText(rawText: string) {
  const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^resultado\s+final(?:\s+-\s+pagamento\s+antecipado)?/i.test(line));
  const boundaryRe = /^(resultado\s+final|total\s+de\s+gols|gols|resultados\s+finais|gg-ng|inicio|time\s+visitante|dupla\s+chance|1o\s*\/\s*2o\s*tempo|marca\s+1)/i;

  return starts.map(({ index }, blockIndex) => {
    const nextStart = starts[blockIndex + 1]?.index ?? lines.length;
    let end = nextStart;
    for (let cursor = index + 1; cursor < nextStart; cursor += 1) {
      if (cursor > index + 2 && boundaryRe.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    return lines.slice(index, end).join("\n");
  });
}

function significantTokensFromText(value: string) {
  return normalizeVisibleText(value).split(/\s+/).filter((token) => token.length >= 3 || SAFE_SHORT_TEAM_TOKENS.has(token));
}

function orderedTokenPosition(textTokens: string[], candidateTokens: string[]) {
  let firstPosition: number | null = null;
  let cursor = 0;
  for (const token of candidateTokens) {
    const foundAt = textTokens.indexOf(token, cursor);
    if (foundAt < 0) return null;
    if (firstPosition == null) firstPosition = foundAt;
    cursor = foundAt + 1;
  }
  return firstPosition;
}

function teamPositionInText(text: string, teamName: unknown) {
  const normalizedText = normalizeVisibleText(text);
  if (!normalizedText) return null;
  const textTokens = normalizedText.split(/\s+/).filter(Boolean);
  const searchable = ` ${normalizedText} `;

  for (const alias of nationalTeamAliases(teamName)) {
    const normalizedAlias = normalizeVisibleText(alias);
    if (!normalizedAlias) continue;
    const exactPosition = searchable.indexOf(` ${normalizedAlias} `);
    if (exactPosition >= 0) return textTokens.indexOf(normalizedAlias.split(/\s+/)[0]);
    const position = orderedTokenPosition(textTokens, significantTokensFromText(alias).slice(0, 4));
    if (position != null) return position;
  }
  return null;
}

function eventOrderTextFromUrl(sourceUrl: string) {
  try {
    const pathParts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    const eventIdIndex = pathParts.findIndex((part) => /^\d+$/.test(part));
    const slug = eventIdIndex > 0 ? pathParts[eventIdIndex - 1] : null;
    return slug ? decodeURIComponent(slug).replace(/[-_]+/g, " ") : "";
  } catch {
    return "";
  }
}

function eventDisplayOrder(sourceUrl: string, fixture: MeridianFixtureTarget) {
  const text = eventOrderTextFromUrl(sourceUrl);
  const homePosition = teamPositionInText(text, fixture.homeTeam);
  const awayPosition = teamPositionInText(text, fixture.awayTeam);
  const orientation = homePosition != null && awayPosition != null && awayPosition < homePosition ? "INVERTED" : "NORMAL";
  return {
    orientation: orientation as "NORMAL" | "INVERTED",
    bookmakerHomeTeam: orientation === "INVERTED" ? fixture.awayTeam : fixture.homeTeam,
    bookmakerAwayTeam: orientation === "INVERTED" ? fixture.homeTeam : fixture.awayTeam
  };
}

export class MeridianbetBrowserClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private chromeProcess: ChildProcess | null = null;

  constructor(
    private readonly config: MeridianbetBookmakerConfig,
    private readonly logger: Logger
  ) {}

  async start() {
    const profileDir = path.resolve(this.config.chromeProfileDir);
    await mkdir(profileDir, { recursive: true });
    const chromePath = findChromeExecutable(this.config.chromeExecutablePath);
    if (!chromePath) throw new Error("chrome.exe não encontrado. Configure MERIDIANBET_CHROME_EXECUTABLE no .env.");

    const port = 9800 + Math.floor(Math.random() * 600);
    await this.logger("info", "iniciando Chrome real via CDP para meridianbet", { profileDir, chromePath, port });
    this.chromeProcess = spawn(
      chromePath,
      [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--new-window", "about:blank"],
      { detached: true, stdio: "ignore" }
    );
    this.chromeProcess.unref();

    await waitForCdp(port, this.config.navigationTimeoutMs);
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    this.context = this.browser.contexts()[0] ?? null;
    if (!this.context) throw new Error("Chrome CDP iniciou sem contexto de navegação");
  }

  async stop() {
    if (!this.browser && !this.chromeProcess) return;
    await this.logger("info", "fechando Chrome da meridianbet");
    await Promise.allSettled((this.context?.pages() ?? []).map((page) => page.close({ runBeforeUnload: false })));
    await this.browser?.close().catch(() => undefined);
    this.chromeProcess?.kill();
    this.browser = null;
    this.context = null;
    this.chromeProcess = null;
  }

  async newPage() {
    if (!this.context) throw new Error("MeridianBet browser context is not initialized");
    const page = await this.context.newPage();
    page.setDefaultTimeout(this.config.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    await page.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);
    return page;
  }

  async goToUrl(page: Page, url: string, label: string) {
    await this.logger("info", label, { url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
    await this.waitForUi(page);
    await this.acceptCookies(page);
  }

  async selectAllPeriod(page: Page) {
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(300);

    await page
      .waitForFunction(
        () => {
          const normalize = (value: unknown) =>
            String(value ?? "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase()
              .replace(/\s+/g, " ")
              .trim();
          const text = normalize(document.body?.innerText || document.body?.textContent || "");
          return text.includes("uma hora") && text.includes("tres horas") && text.includes("dia") && text.includes("3 dias") && text.includes("tudo");
        },
        { timeout: Math.min(this.config.navigationTimeoutMs, 8000) }
      )
      .catch(() => undefined);

    if (await this.isTopPeriodFilterSelected(page, "TUDO")) return;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const clicked = (await this.clickAllPeriodTab(page)) || (await this.clickTopPeriodFilter(page, "TUDO"));
      if (clicked) {
        await this.logger("info", "filtro TUDO da meridianbet clicado", { attempt });
        await page.waitForTimeout(1200);
        await this.waitForUi(page);
        if (await this.isTopPeriodFilterSelected(page, "TUDO")) return;
        return;
      }
    }

    await this.logger("warn", "filtro TUDO da meridianbet não encontrado na barra de tempo");
  }

  async pageHasAnyFixture(page: Page, fixtures: MeridianFixtureTarget[]) {
    if (!fixtures.length) return false;
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(600);

    for (let attempt = 0; attempt < 18; attempt += 1) {
      const text = normalizeVisibleText(await this.visibleText(page));
      const found = fixtures.some((fixture) => {
        const home = nationalTeamTokenGroups(fixture.homeTeam);
        const away = nationalTeamTokenGroups(fixture.awayTeam);
        return tokenGroupMatchesText(text, home) && tokenGroupMatchesText(text, away);
      });
      if (found) return true;

      await page.keyboard.press("PageDown").catch(() => undefined);
      await this.scrollMainContent(page, 800);
      await page.waitForTimeout(350);
    }

    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(300);
    return false;
  }

  async openFixture(page: Page, fixture: MeridianFixtureTarget) {
    const homeTokenGroups = nationalTeamTokenGroups(fixture.homeTeam);
    const awayTokenGroups = nationalTeamTokenGroups(fixture.awayTeam);
    if (!homeTokenGroups.length || !awayTokenGroups.length) return false;

    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(700);
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const target = await this.findFixtureClickTarget(page, homeTokenGroups, awayTokenGroups);
      if (target) {
        await this.logger("info", "jogo encontrado na meridianbet; abrindo página do evento", {
          fixtureId: fixture.id,
          attempt: attempt + 1,
          targetText: target.text.slice(0, 180),
          href: target.href
        });
        if (target.href && isMeridianEventPageUrl(target.href)) await this.goToUrl(page, target.href, "abrindo jogo da meridianbet por link encontrado");
        else {
          await page.mouse.click(target.x, target.y);
          await this.waitForEventPage(page, fixture);
        }
        return this.verifyCurrentEvent(page, fixture);
      }
      await page.keyboard.press("PageDown").catch(() => undefined);
      await this.scrollMainContent(page, 750);
      await page.waitForTimeout(450);
    }
    return false;
  }

  async verifyCurrentEvent(page: Page, fixture: MeridianFixtureTarget) {
    const rawText = await this.visibleText(page);
    const text = normalizeVisibleText(rawText);
    const hasTeams = tokenGroupMatchesText(text, nationalTeamTokenGroups(fixture.homeTeam)) && tokenGroupMatchesText(text, nationalTeamTokenGroups(fixture.awayTeam));
    return hasTeams && (isMeridianEventPageUrl(page.url()) || text.includes("resultado final"));
  }

  async collectCurrentEvent(page: Page, fixture: MeridianFixtureTarget): Promise<MeridianCollectedEvent> {
    await this.waitForUi(page);
    if (!(await this.verifyCurrentEvent(page, fixture))) {
      throw new Error(`MeridianBet não abriu a página do evento: ${fixture.homeTeam} x ${fixture.awayTeam}`);
    }

    await page.getByText("PRINCIPAL", { exact: true }).first().click({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const sourceUrl = (await this.eventSourceUrlFromPage(page, fixture)) ?? page.url();
    const rawText = await this.visibleText(page);
    const displayOrder = eventDisplayOrder(sourceUrl, fixture);
    const rawMarkets = [
      ...new Map(moneylineBlocksFromText(rawText).map((text) => [compactSpaces(text).slice(0, 220), text])).values()
    ];
    const markets = rawMarkets
      .map((text, index) => parseMoneylineMarket(text, fixture, displayOrder.orientation, index))
      .filter((market): market is MeridianCollectedMarket => Boolean(market));

    await this.logger("info", "odds lidas na página do jogo da meridianbet", {
      fixtureId: fixture.id,
      sourceUrl,
      orientation: displayOrder.orientation,
      markets: markets.length,
      odds: markets.reduce((total, market) => total + market.selections.length, 0),
      categories: markets.map((market) => market.paCategory)
    });

    return {
      externalEventId: parseMeridianEventId(sourceUrl, fixture.id),
      sourceUrl,
      eventName: [displayOrder.bookmakerHomeTeam, displayOrder.bookmakerAwayTeam].filter(Boolean).join(" x "),
      bookmakerHomeTeam: displayOrder.bookmakerHomeTeam,
      bookmakerAwayTeam: displayOrder.bookmakerAwayTeam,
      orientation: displayOrder.orientation,
      markets,
      rawText
    };
  }

  private async waitForUi(page: Page) {
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(900);
  }

  private async eventSourceUrlFromPage(page: Page, fixture: MeridianFixtureTarget) {
    if (isMeridianEventPageUrl(page.url())) return page.url();

    const homeTokenGroups = nationalTeamTokenGroups(fixture.homeTeam);
    const awayTokenGroups = nationalTeamTokenGroups(fixture.awayTeam);
    const payload = JSON.stringify({ homeTokenGroups, awayTokenGroups });
    const script = String.raw`
(() => {
  const { homeTokenGroups: pageHomeTokenGroups, awayTokenGroups: pageAwayTokenGroups } = ${payload};
  const norm = (value) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const hasToken = (text, tokens) => tokens.slice(0, 4).some((token) => text.includes(token));
  const hasTokenGroup = (text, tokenGroups) => tokenGroups.some((tokens) => hasToken(text, tokens));
  const toEventUrl = (href) => {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.href);
      return /\/\d+\/?$/.test(url.pathname) ? url.href : null;
    } catch {
      return null;
    }
  };

  const candidates = [];
  for (const anchor of [...document.querySelectorAll("a[href]")]) {
    const href = toEventUrl(anchor.getAttribute("href"));
    if (!href) continue;

    const rect = anchor.getBoundingClientRect();
    const hrefText = norm(decodeURIComponent(href));
    const container = anchor.closest("section,article,dialog,[role='dialog'],.modal,.c-modal,.event-details,.c-event-details,div");
    const containerText = norm(container?.innerText || container?.textContent || "");
    const hrefMatchesTeams = hasTokenGroup(hrefText, pageHomeTokenGroups) && hasTokenGroup(hrefText, pageAwayTokenGroups);
    const containerMatchesTeams = hasTokenGroup(containerText, pageHomeTokenGroups) && hasTokenGroup(containerText, pageAwayTokenGroups);
    if (!hrefMatchesTeams && !containerMatchesTeams) continue;

    candidates.push({
      href,
      score: (hrefMatchesTeams ? 0 : 50) + (containerMatchesTeams ? 0 : 10) + Math.max(0, Math.round(rect.top))
    });
  }

  candidates.sort((left, right) => left.score - right.score);
  return candidates[0]?.href ?? null;
})()
`;

    return (await page.evaluate(script).catch(() => null)) as string | null;
  }

  private async waitForEventPage(page: Page, fixture: MeridianFixtureTarget) {
    const homeTokenGroups = nationalTeamTokenGroups(fixture.homeTeam);
    const awayTokenGroups = nationalTeamTokenGroups(fixture.awayTeam);
    await page
      .waitForFunction(
        ({ homeTokenGroups: pageHomeTokenGroups, awayTokenGroups: pageAwayTokenGroups }) => {
          const norm = (value: unknown) =>
            String(value ?? "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, " ")
              .trim();
          const hasToken = (text: string, tokens: string[]) => tokens.slice(0, 4).some((token) => text.includes(token));
          const hasTokenGroup = (text: string, tokenGroups: string[][]) => tokenGroups.some((tokens) => hasToken(text, tokens));
          const text = norm(document.body?.innerText || document.body?.textContent || "");
          return hasTokenGroup(text, pageHomeTokenGroups) && hasTokenGroup(text, pageAwayTokenGroups) && (/\d+$/.test(window.location.pathname) || text.includes("resultado final"));
        },
        { homeTokenGroups, awayTokenGroups },
        { timeout: Math.min(this.config.navigationTimeoutMs, 8000) }
      )
      .catch(() => undefined);
    await this.waitForUi(page);
  }

  private async visibleText(page: Page) {
    return page.locator("body").innerText({ timeout: this.config.navigationTimeoutMs }).catch(() => "");
  }

  private async acceptCookies(page: Page) {
    const clicked = await page
      .evaluate(() => {
        const normalized = (value: unknown) =>
          String(value ?? "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
        const nodes = [...document.querySelectorAll("button,[role='button'],a")];
        for (const node of nodes) {
          const element = node as HTMLElement;
          const text = normalized(element.innerText || element.textContent);
          const containerText = normalized(element.closest("section,div,aside,footer,dialog")?.textContent);
          if (/^(aceitar|aceitar todos|aceitar cookies|concordo|ok|entendi)$/.test(text) && /cookie|cookies|privacidade/.test(containerText)) {
            element.click();
            return true;
          }
        }
        return false;
      })
      .catch(() => false);
    if (clicked) await page.waitForTimeout(500);
  }

  private async clickTopPeriodFilter(page: Page, text: string) {
    const target = await page
      .evaluate((expectedText) => {
        const normalize = (value: unknown) =>
          String(value ?? "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
        const expected = normalize(expectedText);
        const nodes = [...document.querySelectorAll("button,[role='button'],div,span,a")];
        const candidates: Array<{ x: number; y: number; score: number }> = [];

        for (const node of [...document.querySelectorAll(".c-event-filter__tab")]) {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const textValue = normalize(element.innerText || element.textContent);
          if (textValue !== expected) continue;
          if (rect.width < 20 || rect.height < 18) continue;
          candidates.push({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            score: rect.top * 10 + rect.left - 10_000
          });
        }

        for (const node of nodes) {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const textValue = normalize(element.innerText || element.textContent);
          if (textValue !== expected) continue;
          if (rect.width < 30 || rect.height < 20) continue;
          if (rect.bottom < 150 || rect.top > 380) continue;

          let current: HTMLElement | null = element.parentElement;
          let matchedPeriodBar = false;
          for (let depth = 0; current && depth < 8; depth += 1) {
            const currentRect = current.getBoundingClientRect();
            const currentText = normalize(current.innerText || current.textContent);
            const hasPeriodLabels =
              currentText.includes("uma hora") &&
              currentText.includes("tres horas") &&
              currentText.includes("dia") &&
              currentText.includes("3 dias") &&
              currentText.includes("tudo");
            const looksLikeMainToolbar = currentRect.bottom >= 150 && currentRect.top <= 360 && currentRect.width >= 300;
            if (hasPeriodLabels && looksLikeMainToolbar) {
              matchedPeriodBar = true;
              break;
            }
            current = current.parentElement;
          }

          if (!matchedPeriodBar) continue;

          candidates.push({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            score: rect.top * 10 + rect.left
          });
        }

        candidates.sort((left, right) => left.score - right.score);
        return candidates[0] ?? null;
      }, text)
      .catch(() => null);

    if (!target) return false;
    await page.mouse.click(target.x, target.y);
    return true;
  }

  private async clickAllPeriodTab(page: Page) {
    const script = String.raw`
(() => {
  const normalize = (value) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const candidates = [...document.querySelectorAll(".c-event-filter__tab")].filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    return normalize(node.innerText || node.textContent) === "tudo" && rect.width >= 20 && rect.height >= 18;
  });
  const target = candidates.sort((left, right) => {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
  })[0];
  if (!target) return null;

  const rect = target.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
})()
`;
    const target = (await page.evaluate(script).catch(() => null)) as { x: number; y: number } | null;

    if (!target) return false;
    await page.mouse.click(target.x, target.y);
    return true;
  }

  private async isTopPeriodFilterSelected(page: Page, text: string) {
    return page
      .evaluate((expectedText) => {
        const normalize = (value: unknown) =>
          String(value ?? "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
        const expected = normalize(expectedText);
        const nodes = [...document.querySelectorAll("button,[role='button'],div,span,a")];

        for (const node of nodes) {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const textValue = normalize(element.innerText || element.textContent);
          if (textValue !== expected) continue;
          if (rect.width < 30 || rect.height < 20) continue;
          if (rect.bottom < 150 || rect.top > 380) continue;

          let current: HTMLElement | null = element.parentElement;
          let matchedPeriodBar = false;
          for (let depth = 0; current && depth < 8; depth += 1) {
            const currentRect = current.getBoundingClientRect();
            const currentText = normalize(current.innerText || current.textContent);
            const hasPeriodLabels =
              currentText.includes("uma hora") &&
              currentText.includes("tres horas") &&
              currentText.includes("dia") &&
              currentText.includes("3 dias") &&
              currentText.includes("tudo");
            const looksLikeMainToolbar = currentRect.bottom >= 150 && currentRect.top <= 360 && currentRect.width >= 300;
            if (hasPeriodLabels && looksLikeMainToolbar) {
              matchedPeriodBar = true;
              break;
            }
            current = current.parentElement;
          }

          if (!matchedPeriodBar) continue;

          const style = window.getComputedStyle(element);
          const background = style.backgroundColor.match(/\d+/g)?.map(Number) ?? [];
          const looksYellow = background.length >= 3 && background[0] > 180 && background[1] > 140 && background[2] < 80;
          if (looksYellow || element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-pressed") === "true") return true;
        }

        return false;
      }, text)
      .catch(() => false);
  }

  private async scrollMainContent(page: Page, deltaY: number) {
    await page.mouse.wheel(0, deltaY).catch(() => undefined);
    const script = String.raw`
((amount) => {
  const scrollables = [...document.querySelectorAll("main, [class*='content'], [class*='scroll'], [class*='events'], body")].filter((node) => {
    return node.scrollHeight > node.clientHeight + 50;
  });
  const target = scrollables.sort((left, right) => right.clientHeight - left.clientHeight)[0] ?? document.scrollingElement;
  target?.scrollBy({ top: amount, behavior: "instant" });
})(${JSON.stringify(deltaY)})
`;
    await page.evaluate(script).catch(() => undefined);
  }

  private async findFixtureClickTarget(page: Page, homeTokenGroups: string[][], awayTokenGroups: string[][]) {
    const payload = JSON.stringify({ homeTokenGroups, awayTokenGroups });
    const script = String.raw`
(() => {
  const { homeTokenGroups: pageHomeTokenGroups, awayTokenGroups: pageAwayTokenGroups } = ${payload};
  const norm = (value) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const hasToken = (text, tokens) => tokens.slice(0, 4).some((token) => text.includes(token));
  const hasTokenGroup = (text, tokenGroups) => tokenGroups.some((tokens) => hasToken(text, tokens));
  const isVisible = (node) => {
    if (!node || !(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width >= 4 && rect.height >= 4 && rect.bottom >= 100 && rect.top <= window.innerHeight - 8 && style.visibility !== "hidden" && style.display !== "none";
  };
  const eventUrl = (href) => {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.href);
      return /\/\d+\/?$/.test(url.pathname) ? url.href : null;
    } catch {
      return null;
    }
  };

  const candidates = [];
  const rows = [...document.querySelectorAll(".c-event, standard-event, [class*='event']")];
  for (const row of rows) {
    if (!isVisible(row)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 32 || rect.height > 220) continue;
    const text = (row.textContent || "").replace(/\s+/g, " ").trim();
    const normalized = norm(text);
    if (!hasTokenGroup(normalized, pageHomeTokenGroups) || !hasTokenGroup(normalized, pageAwayTokenGroups)) continue;
    if (/bilhete|valor apostado|registrar|entrar|missoes/i.test(normalized)) continue;

    const push = (target, href, priority) => {
      if (!isVisible(target)) return;
      const targetRect = target.getBoundingClientRect();
      candidates.push({
        text,
        href,
        x: targetRect.left + targetRect.width / 2,
        y: targetRect.top + targetRect.height / 2,
        priority
      });
    };

    for (const anchor of [...row.querySelectorAll("a[href]")]) push(anchor, eventUrl(anchor.getAttribute("href")), 1);
    push(row.querySelector(".c-event-action__bottom"), null, 5);
    push(row.querySelector("svg-icon[icon='event-link']")?.closest(".c-event-action__bottom") ?? null, null, 8);
    push(row.querySelector("svg-icon[icon='event-details']")?.closest(".c-event-action__top") ?? null, null, 20);
    push(row.querySelector(".c-event__info"), null, 30);
    push(row, null, 50);
  }
  candidates.sort((left, right) => left.priority - right.priority || left.y - right.y);
  return candidates[0] ?? null;
})()
`;
    return page.evaluate(script) as Promise<ClickTarget | null>;
  }
}

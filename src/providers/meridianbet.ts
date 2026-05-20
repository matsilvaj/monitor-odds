import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { MeridianbetBookmakerConfig } from "../config/bookmakers.js";
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
  classificationReason: string;
  rawText: string;
  index: number;
  selections: MeridianCollectedSelection[];
};

export type MeridianCollectedEvent = {
  externalEventId: number;
  sourceUrl: string;
  eventName: string;
  markets: MeridianCollectedMarket[];
  rawText: string;
};

const ODD_RE = /\b(?:[1-9]\d{0,2}|0)[.,]\d{2,3}\b/g;

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
      // Chrome is still starting.
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

function tokensFromName(value: unknown) {
  const ignored = new Set(["fc", "cf", "sc", "ac", "ec", "club", "de", "da", "do", "dos", "das", "the", "real", "new", "united", "city"]);
  return normalizeVisibleText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !ignored.has(token));
}

function hasImportantToken(text: string, tokens: string[]) {
  if (!tokens.length) return false;
  return tokens.slice(0, 4).some((token) => text.includes(token));
}

function parseOdd(value: string) {
  return Number(value.replace(",", "."));
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

function isMeridianEventPageUrl(sourceUrl: string | null | undefined) {
  if (!sourceUrl) return false;
  try {
    return /\/\d+\/?$/.test(new URL(sourceUrl).pathname);
  } catch {
    return false;
  }
}

function classifyMarket(rawText: string): { category: PaCategory; confidence: number; reason: string } {
  const normalized = normalizeVisibleText(rawText);
  if (normalized.includes("pagamento antecipado")) {
    return { category: "COM_PA", confidence: 0.99, reason: "meridianbet-resultado-final-pagamento-antecipado" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "meridianbet-resultado-final" };
}

function parseMoneylineMarket(rawText: string, fixture: MeridianFixtureTarget, index: number): MeridianCollectedMarket | null {
  if (!/resultado\s+final/i.test(rawText)) return null;

  const odds = [...rawText.matchAll(ODD_RE)]
    .map((match) => parseOdd(match[0]))
    .filter((value) => Number.isFinite(value) && value >= 1.01 && value <= 1000);

  if (odds.length < 3) return null;

  const pa = classifyMarket(rawText);
  return {
    marketName: "MoneyLine",
    paCategory: pa.category,
    confidence: pa.confidence,
    classificationReason: pa.reason,
    rawText: rawText.slice(0, 1500),
    index,
    selections: [
      { selection: "HOME", label: fixture.homeTeam ?? "Home", price: odds[0], index: 0 },
      { selection: "DRAW", label: "Draw", price: odds[1], index: 1 },
      { selection: "AWAY", label: fixture.awayTeam ?? "Away", price: odds[2], index: 2 }
    ]
  };
}

function moneylineBlocksFromText(rawText: string) {
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
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

function looksLikeStandaloneMoneylineBlock(rawText: string) {
  const firstLine = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);

  return Boolean(firstLine && /^resultado\s+final(?:\s+-\s+pagamento\s+antecipado)?/i.test(firstLine));
}

function eventDetailTextFromRawText(rawText: string, fixture: MeridianFixtureTarget) {
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const homeTokens = tokensFromName(fixture.homeTeam);
  const awayTokens = tokensFromName(fixture.awayTeam);

  for (let index = 0; index < lines.length; index += 1) {
    if (normalizeVisibleText(lines[index]) !== "principal") continue;

    const headerText = normalizeVisibleText(lines.slice(Math.max(0, index - 12), index + 1).join(" "));
    const tabsText = normalizeVisibleText(lines.slice(index, index + 14).join(" "));
    const marketText = normalizeVisibleText(lines.slice(index, index + 80).join(" "));
    const hasFixtureHeader = hasImportantToken(headerText, homeTokens) && hasImportantToken(headerText, awayTokens);
    const hasEventTabs = tabsText.includes("gols") && tabsText.includes("resultados finais");
    const hasMoneyline = marketText.includes("resultado final");

    if (hasFixtureHeader && hasEventTabs && hasMoneyline) return lines.slice(index).join("\n");
  }

  return null;
}

export class MeridianbetBrowserClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
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

    const launch = async (targetProfileDir: string) => {
      const port = 9800 + Math.floor(Math.random() * 500);
      await this.logger("info", "iniciando Chrome real via CDP para meridianbet", { profileDir: targetProfileDir, chromePath, port });

      this.chromeProcess = spawn(
        chromePath,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${targetProfileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--new-window",
          "about:blank"
        ],
        { detached: true, stdio: "ignore" }
      );
      this.chromeProcess.unref();

      await waitForCdp(port, this.config.navigationTimeoutMs);
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      this.context = this.browser.contexts()[0] ?? null;
      if (!this.context) throw new Error("Chrome CDP iniciou sem contexto de navegação");
    };

    try {
      await launch(profileDir);
    } catch (error) {
      this.chromeProcess?.kill();
      const fallbackProfileDir = path.resolve(`${this.config.chromeProfileDir}-run-${Date.now()}`);
      await mkdir(fallbackProfileDir, { recursive: true });
      await this.logger("warn", "perfil principal da meridianbet não abriu CDP; tentando perfil temporário", {
        profileDir,
        fallbackProfileDir,
        error: error instanceof Error ? error.message : String(error)
      });
      await launch(fallbackProfileDir);
    }

    if (!this.context) throw new Error("Chrome CDP iniciou sem contexto de navegação");
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.navigationTimeoutMs);
    this.page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    await this.page.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);
    await this.blockHeavyAssets();
  }

  async stop() {
    if (!this.browser && !this.chromeProcess) return;
    await this.logger("info", "fechando Chrome da meridianbet");
    await this.closePages();
    await this.browser?.close().catch(() => undefined);
    this.chromeProcess?.kill();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromeProcess = null;
  }

  private async closePages() {
    const pages = this.context?.pages() ?? (this.page ? [this.page] : []);
    await Promise.allSettled(pages.map((page) => page.close({ runBeforeUnload: false })));
  }

  currentUrl() {
    return this.requirePage().url();
  }

  async goToUrl(url: string, label: string) {
    const page = this.requirePage();
    await this.logger("info", label, { url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
    await this.waitForUi();
    await this.acceptCookies();
  }

  async openFootballHome() {
    await this.goToUrl(new URL("/ca/esportes/futebol", this.config.baseUrl).toString(), "abrindo futebol da meridianbet");
    await this.selectAllPeriod();
  }

  async selectAllPeriod() {
    const page = this.requirePage();
    if (await this.isTopPeriodFilterSelected("TUDO")) return;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const clicked = await this.clickTopPeriodFilter("TUDO");
      if (clicked) {
        await page.waitForTimeout(1200);
        await this.waitForUi();
        if (await this.isTopPeriodFilterSelected("TUDO")) return;
      }
    }

    await this.logger("warn", "filtro TUDO da meridianbet não encontrado na barra de tempo");
  }

  async pageHasFixturePair(fixtures: MeridianFixtureTarget[]) {
    if (!fixtures.length) return false;
    const page = this.requirePage();
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(600);

    for (let attempt = 0; attempt < 18; attempt += 1) {
      const text = normalizeVisibleText(await this.visibleText());
      const found = fixtures.some(
        (fixture) => hasImportantToken(text, tokensFromName(fixture.homeTeam)) && hasImportantToken(text, tokensFromName(fixture.awayTeam))
      );
      if (found) return true;

      await page.keyboard.press("PageDown").catch(() => undefined);
      await this.scrollMainContent(800);
      await page.waitForTimeout(350);
    }

    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(300);
    return false;
  }

  async openFixture(fixture: MeridianFixtureTarget) {
    const page = this.requirePage();
    const homeTokens = tokensFromName(fixture.homeTeam);
    const awayTokens = tokensFromName(fixture.awayTeam);

    if (!homeTokens.length || !awayTokens.length) {
      await this.logger("warn", "fixture sem nomes suficientes para procurar na meridianbet", {
        fixtureId: fixture.id,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam
      });
      return false;
    }

    await this.logger("info", "procurando jogo na meridianbet", {
      fixtureId: fixture.id,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      startsAt: fixture.startsAt
    });

    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(800);

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const target = await this.findFixtureClickTarget(homeTokens, awayTokens);
      if (target) {
        await this.logger("info", "jogo encontrado na meridianbet; abrindo página do evento", {
          fixtureId: fixture.id,
          attempt: attempt + 1,
          targetText: target.text.slice(0, 180),
          href: target.href
        });

        const href = target.href;
        if (href && isMeridianEventPageUrl(href)) {
          await this.goToUrl(href, "abrindo jogo da meridianbet por link encontrado");
        } else {
          await page.mouse.click(target.x, target.y);
          await this.waitForEventPage(fixture);
        }

        if (await this.verifyCurrentEvent(fixture)) return true;
      }

      await page.keyboard.press("PageDown").catch(() => undefined);
      await this.scrollMainContent(750);
      await page.waitForTimeout(450);
    }

    await this.logger("warn", "não consegui abrir o jogo automaticamente na meridianbet", {
      fixtureId: fixture.id,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam
    });
    return false;
  }

  async verifyCurrentEvent(fixture: MeridianFixtureTarget) {
    const rawText = await this.visibleText();
    const text = normalizeVisibleText(rawText);
    const hasTeams = hasImportantToken(text, tokensFromName(fixture.homeTeam)) && hasImportantToken(text, tokensFromName(fixture.awayTeam));
    if (!hasTeams) return false;
    return isMeridianEventPageUrl(this.requirePage().url()) || Boolean(eventDetailTextFromRawText(rawText, fixture));
  }

  async collectCurrentEvent(fixture: MeridianFixtureTarget): Promise<MeridianCollectedEvent> {
    const page = this.requirePage();
    await this.waitForUi();
    const sourceUrl = page.url();
    if (!(await this.verifyCurrentEvent(fixture))) {
      throw new Error(`MeridianBet não abriu a página do evento: ${fixture.homeTeam} x ${fixture.awayTeam}`);
    }

    await this.clickExactText("PRINCIPAL").catch(() => false);
    await page.waitForTimeout(500);

    let rawText = await this.visibleText();
    let eventDetailText = eventDetailTextFromRawText(rawText, fixture) ?? (isMeridianEventPageUrl(sourceUrl) ? rawText : null);
    let marketTexts = await this.marketGroupTexts();

    for (let attempt = 0; attempt < 12 && !eventDetailText && !marketTexts.length; attempt += 1) {
      await page.waitForTimeout(1500);
      rawText = await this.visibleText();
      eventDetailText = eventDetailTextFromRawText(rawText, fixture) ?? (isMeridianEventPageUrl(sourceUrl) ? rawText : null);
      marketTexts = await this.marketGroupTexts();
    }

    if (!eventDetailText) {
      throw new Error(`MeridianBet abriu a lista da liga, mas não confirmou o painel do evento: ${fixture.homeTeam} x ${fixture.awayTeam}`);
    }

    const textBlocks = moneylineBlocksFromText(eventDetailText);
    const directBlocks = marketTexts.filter(looksLikeStandaloneMoneylineBlock);
    const rawMarkets = [
      ...new Map([...(textBlocks.length ? textBlocks : directBlocks), ...directBlocks].map((text) => [compactSpaces(text).slice(0, 220), text])).values()
    ];
    const markets = rawMarkets
      .map((text, index) => parseMoneylineMarket(text, fixture, index))
      .filter((market): market is MeridianCollectedMarket => Boolean(market));

    await this.logger("info", "odds lidas na página do jogo da meridianbet", {
      fixtureId: fixture.id,
      sourceUrl,
      markets: markets.length,
      odds: markets.reduce((total, market) => total + market.selections.length, 0),
      categories: markets.map((market) => market.paCategory)
    });

    return {
      externalEventId: parseMeridianEventId(sourceUrl, fixture.id),
      sourceUrl,
      eventName: [fixture.homeTeam, fixture.awayTeam].filter(Boolean).join(" x "),
      markets,
      rawText: eventDetailText
    };
  }

  private async blockHeavyAssets() {
    const page = this.requirePage();
    await page.route("**/*", async (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") {
        await route.abort().catch(() => undefined);
        return;
      }

      await route.continue().catch(() => undefined);
    });
  }

  private async acceptCookies() {
    const page = this.requirePage();
    const clicked = await page
      .evaluate(() => {
        const normalized = (value: unknown) =>
          String(value ?? "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
        const cookieWords = /cookie|cookies|privacidade|politica de privacidade/;
        const acceptWords = /^(aceitar|aceitar todos|aceitar cookies|concordo|ok|entendi)$/;

        const nodes = [...document.querySelectorAll("button,[role='button'],a")];
        for (const node of nodes) {
          const element = node as HTMLElement;
          const text = normalized(element.innerText || element.textContent);
          if (!acceptWords.test(text)) continue;

          const containerText = normalized(element.closest("section,div,aside,footer,dialog")?.textContent);
          if (!cookieWords.test(containerText)) continue;

          element.click();
          return true;
        }

        return false;
      })
      .catch(() => false);

    if (clicked) await page.waitForTimeout(500);
  }

  private async clickExactText(text: string) {
    const page = this.requirePage();
    const locator = page.getByText(text, { exact: true }).first();
    if (!(await locator.isVisible().catch(() => false))) return false;
    await locator.click({ timeout: 1500 }).catch(() => undefined);
    return true;
  }

  private async clickTopPeriodFilter(text: string) {
    const page = this.requirePage();
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

        for (const node of nodes) {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const text = normalize(element.innerText || element.textContent);
          if (text !== expected) continue;
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
            const looksLikeMainToolbar = currentRect.bottom >= 190 && currentRect.top <= 360 && currentRect.width >= 300;
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

  private async isTopPeriodFilterSelected(text: string) {
    const page = this.requirePage();
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
            const looksLikeMainToolbar = currentRect.bottom >= 190 && currentRect.top <= 360 && currentRect.width >= 300;
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

  private async clickText(pattern: RegExp | string) {
    const page = this.requirePage();
    const locator = page.getByText(pattern).first();
    if (!(await locator.isVisible().catch(() => false))) return false;
    await locator.click({ timeout: 1500 }).catch(() => undefined);
    return true;
  }

  private async findFixtureClickTarget(homeTokens: string[], awayTokens: string[]) {
    const page = this.requirePage();
    const payload = JSON.stringify({ homeTokens, awayTokens });
    const script = String.raw`
(() => {
  const { homeTokens: pageHomeTokens, awayTokens: pageAwayTokens } = ${payload};
  const norm = (value) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const hasToken = (text, tokens) => tokens.slice(0, 4).some((token) => text.includes(token));
  const nodes = [...document.querySelectorAll("a,button,[role='button'],div")];
  const candidates = [];
  const eventUrl = (href) => {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.href);
      return /\/\d+\/?$/.test(url.pathname) ? url.href : null;
    } catch {
      return null;
    }
  };

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 24 || rect.bottom < 100 || rect.top > window.innerHeight - 8) continue;

    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

    const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 900) continue;

    const normalized = norm(text);
    if (!hasToken(normalized, pageHomeTokens) || !hasToken(normalized, pageAwayTokens)) continue;
    if (/bilhete|valor apostado|registrar|entrar|missoes/i.test(normalized)) continue;

    let row = node;
    let current = node.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const currentRect = current.getBoundingClientRect();
      const currentText = norm(current.innerText || current.textContent);
      const isSameMatch = hasToken(currentText, pageHomeTokens) && hasToken(currentText, pageAwayTokens);
      const looksLikeSingleRow = currentRect.width >= rect.width && currentRect.height >= rect.height && currentRect.height <= 180;
      if (!isSameMatch || !looksLikeSingleRow || /bilhete|valor apostado|registrar|entrar|missoes/i.test(currentText)) break;
      row = current;
      current = current.parentElement;
    }

    const rowRect = row.getBoundingClientRect();
    const eventAnchor = [...row.querySelectorAll("a[href]")]
      .map((element) => ({ element, href: eventUrl(element.getAttribute("href")) }))
      .find((item) => item.href);
    const anchor = node.closest("a[href]");
    const ownHref = eventUrl(anchor ? anchor.getAttribute("href") : null);
    const href = ownHref || eventAnchor?.href || null;
    const anchorRect = eventAnchor?.element.getBoundingClientRect();
    const hasAnchorPoint = anchorRect && anchorRect.width > 4 && anchorRect.height > 4;
    const x = hasAnchorPoint ? anchorRect.left + anchorRect.width / 2 : rowRect.right - Math.min(Math.max(rowRect.width * 0.035, 28), 76);
    const y = hasAnchorPoint ? anchorRect.top + anchorRect.height / 2 : rowRect.top + rowRect.height / 2;

    candidates.push({
      text,
      href,
      x,
      y,
      area: rowRect.width * rowRect.height
    });
  }

  candidates.sort((left, right) => left.area - right.area);
  return candidates[0] ?? null;
})()
`;

    return page.evaluate(script) as Promise<{ text: string; href: string | null; x: number; y: number; area: number } | null>;
  }

  private async marketGroupTexts() {
    const page = this.requirePage();
    const script = String.raw`
(() => {
  const oddRe = /\b(?:[1-9]\d{0,2}|0)[.,]\d{2,3}\b/g;
  const nodes = [...document.querySelectorAll("div,section,article")];
  const selected = [];
  const signatures = new Set();

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 30 || rect.bottom < 90 || rect.top > window.innerHeight * 1.5) continue;

    const text = (node.innerText || node.textContent || "").trim();
    if (!text || text.length > 1200) continue;
    if (!/resultado\s+final/i.test(text)) continue;
    if (!/^resultado\s+final(?:\s+-\s+pagamento\s+antecipado)?/i.test(text.split(/\n+/).map((line) => line.trim()).find(Boolean) || "")) continue;

    const odds = text.match(oddRe) ?? [];
    if (odds.length < 3) continue;

    const signature = text.replace(/\s+/g, " ").slice(0, 180);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    selected.push(text);
  }

  return selected.slice(0, 5);
})()
`;
    return page.evaluate(script) as Promise<string[]>;
  }

  private async visibleText() {
    return this.requirePage()
      .locator("body")
      .innerText({ timeout: this.config.navigationTimeoutMs })
      .catch(() => "");
  }

  private async scrollMainContent(deltaY: number) {
    const page = this.requirePage();
    await page.mouse.wheel(0, deltaY).catch(() => undefined);
    await page.evaluate((amount) => {
      const scrollables = [...document.querySelectorAll("main, [class*='content'], [class*='scroll'], [class*='events'], body")].filter((node) => {
        const element = node as HTMLElement;
        return element.scrollHeight > element.clientHeight + 50;
      }) as HTMLElement[];
      const target = scrollables.sort((left, right) => right.clientHeight - left.clientHeight)[0] ?? document.scrollingElement;
      target?.scrollBy({ top: amount, behavior: "instant" });
    }, deltaY).catch(() => undefined);
  }

  private async waitForUi() {
    const page = this.requirePage();
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(900);
  }

  private async waitForEventPage(fixture: MeridianFixtureTarget) {
    const page = this.requirePage();
    await page
      .waitForFunction(
        () => /\/\d+\/?$/.test(window.location.pathname),
        undefined,
        { timeout: Math.min(this.config.navigationTimeoutMs, 8000) }
      )
      .catch(() => undefined);
    await this.waitForUi();
    return this.verifyCurrentEvent(fixture);
  }

  private requirePage() {
    if (!this.page) throw new Error("MeridianBet browser page is not initialized");
    return this.page;
  }
}

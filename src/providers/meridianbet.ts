import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { MeridianbetBookmakerConfig } from "../config/bookmakers.js";
import { nationalTeamTokenGroups, tokenGroupMatchesText } from "../domain/matching/team-aliases.js";
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

export type MeridianPeriodSelectionState =
  | "TARGET_EVENTS_VISIBLE"
  | "ALL_ALREADY_SELECTED"
  | "ALL_FILTER_APPLIED"
  | "FILTER_ABSENT_WITH_EVENTS"
  | "FILTER_ABSENT_WITHOUT_EVENTS";

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

export type MeridianLeagueEvent = {
  externalEventId: number;
  sourceUrl: string;
  eventName: string;
  homeTeam: string | null;
  awayTeam: string | null;
  rawText: string;
  dateLabel: string | null;
  timeLabel: string | null;
};

type ClickTarget = {
  text: string;
  href: string | null;
  x: number;
  y: number;
  priority: number;
  matchKind: "PAIR" | "SINGLE";
  timeMatched: boolean;
};

const PRICE_RE = /^(?:[1-9]\d{0,2}|0)(?:[.,]\d{1,3})?$/;

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

function fixtureTextEvidence(rawText: string, fixture: MeridianFixtureTarget) {
  const text = normalizeVisibleText(rawText);
  const home = nationalTeamTokenGroups(fixture.homeTeam);
  const away = nationalTeamTokenGroups(fixture.awayTeam);
  const hasHome = tokenGroupMatchesText(text, home);
  const hasAway = tokenGroupMatchesText(text, away);

  return {
    hasHome,
    hasAway,
    hasBoth: hasHome && hasAway,
    hasAny: hasHome || hasAway
  };
}

function fixtureLocalTimeLabels(startsAt: string) {
  const date = new Date(startsAt);
  if (!Number.isFinite(date.getTime())) return [];
  const labels = new Set<string>();
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  labels.add(formatter.format(date).replace(/^24:/, "00:"));
  return [...labels];
}

function looksLikeUsableLeagueText(rawText: string) {
  const text = normalizeVisibleText(rawText);
  return (
    text.includes("meridianbet") ||
    text.includes("resultado final") ||
    text.includes("uma hora") ||
    text.includes("tres horas") ||
    text.includes("tudo") ||
    text.includes("principal") ||
    text.includes("futebol")
  );
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

function parseMoneylineMarket(rawText: string, homeTeam: string | null, awayTeam: string | null, index: number) {
  if (!/resultado\s+final/i.test(rawText)) return null;
  const odds = moneylinePricesFromBlock(rawText);
  if (odds.length < 3) return null;

  const pa = classifyMarket(rawText);
  return {
    marketName: "MoneyLine",
    paCategory: pa.category,
    confidence: pa.confidence,
    rawText: rawText.slice(0, 1500),
    index,
    selections: [
      { selection: "HOME" as Selection, label: homeTeam ?? "Home", price: odds[0], index: 0 },
      { selection: "DRAW" as Selection, label: "Draw", price: odds[1], index: 1 },
      { selection: "AWAY" as Selection, label: awayTeam ?? "Away", price: odds[2], index: 2 }
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
      { stdio: "ignore" }
    );

    try {
      await waitForCdp(port, this.config.navigationTimeoutMs);
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      this.context = this.browser.contexts()[0] ?? null;
    } catch (error) {
      this.chromeProcess.kill();
      this.chromeProcess = null;
      throw error;
    }
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

  async selectAllPeriod(page: Page, fixtures: MeridianFixtureTarget[] = []): Promise<MeridianPeriodSelectionState> {
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(600);

    if (fixtures.length && (await this.pageHasVisibleTargetFixture(page, fixtures))) {
      await this.logger("info", "eventos alvo da meridianbet ja visiveis; filtro TUDO dispensado", { fixtures: fixtures.length });
      return "TARGET_EVENTS_VISIBLE";
    }

    if (await this.isTopPeriodFilterSelected(page, "TUDO")) {
      await this.logger("info", "filtro TUDO da meridianbet ja estava selecionado");
      return "ALL_ALREADY_SELECTED";
    }

    const clicked = (await this.clickAllPeriodTab(page)) || (await this.clickTopPeriodFilter(page, "TUDO"));
    if (clicked) {
      await this.logger("info", "filtro TUDO da meridianbet clicado", { attempt: 1 });
      await page.waitForTimeout(1200);
      await this.waitForUi(page);
      return "ALL_FILTER_APPLIED";
    }

    const hasEvents = await this.pageHasVisibleEvents(page);
    if (hasEvents) {
      await this.logger("info", "filtro TUDO da meridianbet ausente; eventos visiveis encontrados");
      return "FILTER_ABSENT_WITH_EVENTS";
    }

    await this.logger("warn", "filtro TUDO da meridianbet ausente e nenhum evento visivel encontrado");
    return "FILTER_ABSENT_WITHOUT_EVENTS";
  }

  private async pageHasVisibleTargetFixture(page: Page, fixtures: MeridianFixtureTarget[]) {
    for (const fixture of fixtures) {
      if (await this.findFixtureClickTargetForFixture(page, fixture)) return true;
    }
    return false;
  }

  private async pageHasVisibleEvents(page: Page) {
    const checks = await Promise.all(
      page.frames().map((frame) =>
        frame.evaluate(() => [...document.querySelectorAll(".c-event__game")].some((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 80 && rect.height > 20 && rect.bottom > 80 && rect.top < window.innerHeight && style.visibility !== "hidden" && style.display !== "none";
        })).catch(() => false)
      )
    );
    return checks.some(Boolean);
  }

  async pageHasAnyFixture(page: Page, fixtures: MeridianFixtureTarget[]) {
    if (!fixtures.length) return false;
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(600);

    for (let attempt = 0; attempt < 18; attempt += 1) {
      for (const fixture of fixtures) {
        if (await this.findFixtureClickTargetForFixture(page, fixture)) {
          await page.keyboard.press("Home").catch(() => undefined);
          await page.waitForTimeout(300);
          return true;
        }
      }

      await page.keyboard.press("PageDown").catch(() => undefined);
      await this.scrollMainContent(page, 800);
      await page.waitForTimeout(350);
    }

    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(300);
    return false;
  }

  async pageLooksLikeLeague(page: Page) {
    const rawText = await this.visibleText(page);
    if (looksLikeUsableLeagueText(rawText)) return true;

    try {
      const url = new URL(page.url());
      return /meridianbet/i.test(url.hostname);
    } catch {
      return false;
    }
  }

  async listLeagueEvents(page: Page): Promise<MeridianLeagueEvent[]> {
    const found = new Map<number, MeridianLeagueEvent>();
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(500);

    const script = String.raw`
(() => {
  const eventUrl = (href) => {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.href);
      return /\/\d+\/?$/.test(url.pathname) ? url.href : null;
    } catch {
      return null;
    }
  };
  const extractFromNode = (node) => {
    if (!(node instanceof HTMLElement)) return [];
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    if (rect.width < 200 || rect.height < 20 || style.visibility === "hidden" || style.display === "none") return [];
    const homeTeam = node.querySelector(".c-event__rivals--home span")?.textContent?.trim() || null;
    const awayTeam = node.querySelector(".c-event__rivals--away span")?.textContent?.trim() || null;
    if (!homeTeam || !awayTeam) return [];
    const rawText = node.innerText || node.textContent || "";
    const dateLabel = node.querySelector(".c-event__period-min")?.textContent?.trim() || null;
    const timeLabel = node.querySelector(".c-event__period-time")?.textContent?.trim() || null;
    const anchor = [...node.querySelectorAll("a[href]")].find((item) => eventUrl(item.getAttribute("href")));
    const sourceUrl = anchor ? (eventUrl(anchor.getAttribute("href") || null) || "") : "";
    return [{ sourceUrl, rawText, homeTeam, awayTeam, dateLabel, timeLabel }];
  };
  // Tenta primeiro .c-event; se vazio, tenta .c-event__game como container alternativo
  const primaryNodes = [...document.querySelectorAll(".c-event")];
  const results = primaryNodes.flatMap(extractFromNode);
  if (results.length > 0) return results;
  const fallbackNodes = [...document.querySelectorAll(".c-event__game")];
  return fallbackNodes.flatMap(extractFromNode);
})()
`;

    for (let attempt = 0; attempt < 18; attempt += 1) {
      const rows = (await page.mainFrame().evaluate(script)) as Array<{ sourceUrl: string; rawText: string; homeTeam: string; awayTeam: string; dateLabel: string | null; timeLabel: string | null }>;
      for (const row of rows) {
        const externalEventId = parseMeridianEventId(row.sourceUrl, row.rawText);
        if (found.has(externalEventId)) continue;
        found.set(externalEventId, {
          externalEventId,
          sourceUrl: row.sourceUrl,
          eventName: `${row.homeTeam} x ${row.awayTeam}`,
          homeTeam: row.homeTeam,
          awayTeam: row.awayTeam,
          rawText: row.rawText,
          dateLabel: row.dateLabel,
          timeLabel: row.timeLabel
        });
      }
      await page.keyboard.press("PageDown").catch(() => undefined);
      await this.scrollMainContent(page, 750);
      await page.waitForTimeout(350);
    }
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(300);
    return [...found.values()];
  }

  async openLeagueEvent(page: Page, event: MeridianLeagueEvent) {
    if (event.sourceUrl) {
      await this.goToUrl(page, event.sourceUrl, "abrindo evento bruto da meridianbet por link da linha");
      return true;
    }
    const payload = JSON.stringify({ homeTeam: normalizeVisibleText(event.homeTeam), awayTeam: normalizeVisibleText(event.awayTeam) });
    const script = String.raw`
(() => {
  const expected = ${payload};
  const norm = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const row of [...document.querySelectorAll(".c-event")]) {
    const home = norm(row.querySelector(".c-event__rivals--home span")?.textContent);
    const away = norm(row.querySelector(".c-event__rivals--away span")?.textContent);
    if (home !== expected.homeTeam || away !== expected.awayTeam) continue;
    const target = row.querySelector(".c-event-action__bottom") || row.querySelector(".c-event__info") || row;
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  }
  return false;
})()
`;
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(400);
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const clicked = Boolean(await page.mainFrame().evaluate(script));
      if (clicked) {
        await page.waitForTimeout(1500);
        await this.waitForUi(page);
        return page.frames().some((frame) => isMeridianEventPageUrl(frame.url()));
      }
      await page.keyboard.press("PageDown").catch(() => undefined);
      await this.scrollMainContent(page, 750);
      await page.waitForTimeout(350);
    }
    return false;
  }

  async openFixture(page: Page, fixture: MeridianFixtureTarget) {
    const homeTokenGroups = nationalTeamTokenGroups(fixture.homeTeam);
    const awayTokenGroups = nationalTeamTokenGroups(fixture.awayTeam);
    if (!homeTokenGroups.length && !awayTokenGroups.length) return false;

    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(700);
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const target = await this.findFixtureClickTarget(page, homeTokenGroups, awayTokenGroups, fixtureLocalTimeLabels(fixture.startsAt));
      if (target) {
        await this.logger("info", "jogo encontrado na meridianbet; abrindo página do evento", {
          fixtureId: fixture.id,
          attempt: attempt + 1,
          matchKind: target.matchKind,
          timeMatched: target.timeMatched,
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
    const evidence = fixtureTextEvidence(rawText, fixture);
    return evidence.hasAny && (isMeridianEventPageUrl(page.url()) || text.includes("resultado final"));
  }

  async collectCurrentEvent(page: Page, fixture?: MeridianFixtureTarget): Promise<MeridianCollectedEvent> {
    await this.waitForUi(page);
    const eventFrame = page.frames().find((frame) => isMeridianEventPageUrl(frame.url()));
    if (!eventFrame) throw new Error("MeridianBet não abriu uma página de evento válida");

    await eventFrame.getByText("PRINCIPAL", { exact: true }).first().click({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const sourceUrl = eventFrame.url();
    const rawText = await eventFrame.locator("body").innerText().catch(() => "");
    const bookmakerHomeTeam = fixture?.homeTeam ?? null;
    const bookmakerAwayTeam = fixture?.awayTeam ?? null;
    const rawMarkets = [
      ...new Map(moneylineBlocksFromText(rawText).map((text) => [compactSpaces(text).slice(0, 220), text])).values()
    ];
    const markets = rawMarkets
      .map((text, index) => parseMoneylineMarket(text, bookmakerHomeTeam, bookmakerAwayTeam, index))
      .filter((market): market is MeridianCollectedMarket => Boolean(market));

    await this.logger("info", "odds lidas na página do jogo da meridianbet", {
      fixtureId: fixture?.id ?? null,
      sourceUrl,
      orientation: "DISPLAY_ORDER",
      markets: markets.length,
      odds: markets.reduce((total, market) => total + market.selections.length, 0),
      categories: markets.map((market) => market.paCategory)
    });

    return {
      externalEventId: parseMeridianEventId(sourceUrl, fixture?.id ?? rawText.slice(0, 100)),
      sourceUrl,
      eventName: [bookmakerHomeTeam, bookmakerAwayTeam].filter(Boolean).join(" x ") || `MeridianBet ${parseMeridianEventId(sourceUrl, rawText.slice(0, 100))}`,
      bookmakerHomeTeam,
      bookmakerAwayTeam,
      orientation: "NORMAL",
      markets,
      rawText
    };
  }

  private async waitForUi(page: Page) {
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await this.waitForVerificationIfNeeded(page);
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(900);
  }

  private async waitForVerificationIfNeeded(page: Page) {
    const timeoutMs = Math.max(this.config.navigationTimeoutMs, 45_000);
    const startedAt = Date.now();
    let detected = false;

    while (Date.now() - startedAt < timeoutMs) {
      const state = await page
        .evaluate(() => {
          const normalize = (value: unknown) =>
            String(value ?? "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase()
              .replace(/\s+/g, " ")
              .trim();
          const text = normalize(document.body?.innerText || document.body?.textContent || "");
          const title = normalize(document.title);
          const hasCloudflareNode = Boolean(
            document.querySelector("[id^='cf-'], .cf-browser-verification, .cf-challenge, [class*='challenge'], [class*='cloudflare']")
          );
          const looksLikeVerification =
            hasCloudflareNode ||
            title.includes("just a moment") ||
            text.includes("checking your browser") ||
            text.includes("verificando se") ||
            text.includes("verificacao") ||
            (text.includes("cloudflare") && (text.includes("seguranca") || text.includes("security") || text.includes("verification")));
          const looksReady =
            text.includes("meridianbet") ||
            text.includes("futebol") ||
            text.includes("esportes") ||
            text.includes("entrar") ||
            text.includes("cadastre");

          return { looksLikeVerification, looksReady, textLength: text.length, title, url: window.location.href };
        })
        .catch(() => ({ looksLikeVerification: false, looksReady: false, textLength: 0, title: "", url: page.url() }));

      if (state.looksLikeVerification || (detected && !state.looksReady && state.textLength < 80)) {
        if (!detected) {
          detected = true;
          await this.logger("info", "verificacao da meridianbet detectada; aguardando liberar pagina", {
            url: state.url,
            title: state.title
          });
        }
        await page.waitForTimeout(1500);
        continue;
      }

      if (detected) {
        await this.logger("info", "verificacao da meridianbet concluida", {
          elapsedMs: Date.now() - startedAt,
          url: state.url
        });
      }
      return;
    }

    if (detected) {
      await this.logger("warn", "verificacao da meridianbet nao liberou dentro do tempo esperado", {
        elapsedMs: Date.now() - startedAt,
        url: page.url()
      });
    }
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
    const hrefHome = hasTokenGroup(hrefText, pageHomeTokenGroups);
    const hrefAway = hasTokenGroup(hrefText, pageAwayTokenGroups);
    const containerHome = hasTokenGroup(containerText, pageHomeTokenGroups);
    const containerAway = hasTokenGroup(containerText, pageAwayTokenGroups);
    const hrefMatchesTeams = hrefHome && hrefAway;
    const containerMatchesTeams = containerHome && containerAway;
    const hrefMatchesOneTeam = hrefHome || hrefAway;
    const containerMatchesOneTeam = containerHome || containerAway;
    if (!hrefMatchesTeams && !containerMatchesTeams && !hrefMatchesOneTeam && !containerMatchesOneTeam) continue;

    candidates.push({
      href,
      score:
        (hrefMatchesTeams || containerMatchesTeams ? 0 : 80) +
        (hrefMatchesTeams ? 0 : 30) +
        (containerMatchesTeams ? 0 : 10) +
        Math.max(0, Math.round(rect.top))
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
          const hasHome = hasTokenGroup(text, pageHomeTokenGroups);
          const hasAway = hasTokenGroup(text, pageAwayTokenGroups);
          return (hasHome || hasAway) && (/\d+$/.test(window.location.pathname) || text.includes("resultado final"));
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

  private async findFixtureClickTargetForFixture(page: Page, fixture: MeridianFixtureTarget) {
    const homeTokenGroups = nationalTeamTokenGroups(fixture.homeTeam);
    const awayTokenGroups = nationalTeamTokenGroups(fixture.awayTeam);
    if (!homeTokenGroups.length && !awayTokenGroups.length) return null;
    return this.findFixtureClickTarget(page, homeTokenGroups, awayTokenGroups, fixtureLocalTimeLabels(fixture.startsAt));
  }

  private async findFixtureClickTarget(page: Page, homeTokenGroups: string[][], awayTokenGroups: string[][], expectedTimeLabels: string[] = []) {
    const payload = JSON.stringify({ homeTokenGroups, awayTokenGroups, expectedTimeLabels });
    const script = String.raw`
(() => {
  const { homeTokenGroups: pageHomeTokenGroups, awayTokenGroups: pageAwayTokenGroups, expectedTimeLabels: pageExpectedTimeLabels } = ${payload};
  const norm = (value) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, " ")
    .trim();
  const hasToken = (text, tokens) => tokens.slice(0, 4).some((token) => text.includes(token));
  const hasTokenGroup = (text, tokenGroups) => tokenGroups.some((tokens) => hasToken(text, tokens));
  const normalizedTimeLabels = pageExpectedTimeLabels.map(norm).filter(Boolean);
  const hasExpectedTime = (text) => normalizedTimeLabels.length > 0 && normalizedTimeLabels.some((label) => text.includes(label));
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
  const distinctKey = (candidate) => norm(candidate.text).slice(0, 220) + "|" + Math.round(candidate.y / 8);

  const candidates = [];
  const rows = [...document.querySelectorAll("standard-event, .c-event")];
  for (const row of rows) {
    if (!isVisible(row)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 32 || rect.height > 220) continue;
    const text = (row.textContent || "").replace(/\s+/g, " ").trim();
    const normalized = norm(text);
    const hasHome = hasTokenGroup(normalized, pageHomeTokenGroups);
    const hasAway = hasTokenGroup(normalized, pageAwayTokenGroups);
    if (!hasHome && !hasAway) continue;
    if (/bilhete|valor apostado|registrar|entrar|missoes/i.test(normalized)) continue;
    const matchKind = hasHome && hasAway ? "PAIR" : "SINGLE";
    const timeMatched = hasExpectedTime(normalized);

    const push = (target, href, priority) => {
      if (!isVisible(target)) return;
      const targetRect = target.getBoundingClientRect();
      candidates.push({
        text,
        href,
        x: targetRect.left + targetRect.width / 2,
        y: targetRect.top + targetRect.height / 2,
        priority: priority + (matchKind === "PAIR" ? 0 : 100) - (timeMatched ? 35 : 0),
        matchKind,
        timeMatched
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
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = distinctKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  const pair = unique.find((candidate) => candidate.matchKind === "PAIR");
  if (pair) return pair;

  const timedSingles = unique.filter((candidate) => candidate.matchKind === "SINGLE" && candidate.timeMatched);
  if (timedSingles.length === 1) return timedSingles[0];
  if (timedSingles.length > 1) return null;

  const singles = unique.filter((candidate) => candidate.matchKind === "SINGLE");
  return singles.length === 1 ? singles[0] : null;
})()
`;
    return page.evaluate(script) as Promise<ClickTarget | null>;
  }
}

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
  classificationReason: string;
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
  orientation: MeridianEventOrientation;
  markets: MeridianCollectedMarket[];
  rawText: string;
};

type MeridianClickTarget = {
  text: string;
  href: string | null;
  x: number;
  y: number;
  area: number;
  kind: string;
};

type MeridianEventOrientation = "NORMAL" | "INVERTED";

const PRICE_LINE_RE = /^(?:[1-9]\d{0,2}|0)(?:[.,]\d{1,3})?$/;
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

function parseOdd(value: string) {
  return Number(value.replace(",", "."));
}

function parsePriceLine(value: string) {
  const trimmed = value.trim();
  if (!PRICE_LINE_RE.test(trimmed)) return null;
  const price = parseOdd(trimmed);
  return Number.isFinite(price) && price >= 1.01 && price <= 1000 ? price : null;
}

function moneylinePricesFromBlock(rawText: string) {
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const prices = new Map<"1" | "X" | "2", number>();

  for (let index = 0; index < lines.length - 1; index += 1) {
    const label = lines[index].toUpperCase();
    if (label !== "1" && label !== "X" && label !== "2") continue;
    const price = parsePriceLine(lines[index + 1]);
    if (price == null) continue;
    prices.set(label, price);
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

function canonicalSelectionForDisplayOrder(selection: Selection, orientation: MeridianEventOrientation): Selection {
  if (orientation !== "INVERTED") return selection;
  if (selection === "HOME") return "AWAY";
  if (selection === "AWAY") return "HOME";
  return selection;
}

function parseMoneylineMarket(
  rawText: string,
  fixture: MeridianFixtureTarget,
  orientation: MeridianEventOrientation,
  index: number
): MeridianCollectedMarket | null {
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
    classificationReason: pa.reason,
    rawText: rawText.slice(0, 1500),
    index,
    selections: [
      { selection: canonicalSelectionForDisplayOrder("HOME", orientation), label: displayHomeTeam ?? "Home", price: odds[0], index: 0 },
      { selection: "DRAW", label: "Draw", price: odds[1], index: 1 },
      { selection: canonicalSelectionForDisplayOrder("AWAY", orientation), label: displayAwayTeam ?? "Away", price: odds[2], index: 2 }
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
  const homeTokenGroups = nationalTeamTokenGroups(fixture.homeTeam);
  const awayTokenGroups = nationalTeamTokenGroups(fixture.awayTeam);

  for (let index = 0; index < lines.length; index += 1) {
    if (normalizeVisibleText(lines[index]) !== "principal") continue;

    const headerText = normalizeVisibleText(lines.slice(Math.max(0, index - 12), index + 1).join(" "));
    const tabsText = normalizeVisibleText(lines.slice(index, index + 14).join(" "));
    const marketText = normalizeVisibleText(lines.slice(index, index + 80).join(" "));
    const hasFixtureHeader = tokenGroupMatchesText(headerText, homeTokenGroups) && tokenGroupMatchesText(headerText, awayTokenGroups);
    const hasEventTabs = tabsText.includes("gols") && tabsText.includes("resultados finais");
    const hasMoneyline = marketText.includes("resultado final");

    if (hasFixtureHeader && hasEventTabs && hasMoneyline) return lines.slice(index).join("\n");
  }

  return null;
}

function eventHeaderLinesFromRawText(rawText: string, fixture: MeridianFixtureTarget) {
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const homeTokenGroups = nationalTeamTokenGroups(fixture.homeTeam);
  const awayTokenGroups = nationalTeamTokenGroups(fixture.awayTeam);

  for (let index = 0; index < lines.length; index += 1) {
    if (normalizeVisibleText(lines[index]) !== "principal") continue;

    const headerLines = lines.slice(Math.max(0, index - 12), index);
    const headerText = normalizeVisibleText(headerLines.join(" "));
    const tabsText = normalizeVisibleText(lines.slice(index, index + 14).join(" "));
    const marketText = normalizeVisibleText(lines.slice(index, index + 80).join(" "));
    const hasFixtureHeader = tokenGroupMatchesText(headerText, homeTokenGroups) && tokenGroupMatchesText(headerText, awayTokenGroups);
    const hasEventTabs = tabsText.includes("gols") && tabsText.includes("resultados finais");
    const hasMoneyline = marketText.includes("resultado final");

    if (hasFixtureHeader && hasEventTabs && hasMoneyline) return headerLines;
  }

  return [];
}

function significantTokensFromText(value: string) {
  return normalizeVisibleText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 || SAFE_SHORT_TEAM_TOKENS.has(token));
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

function unorderedTokenWindowPosition(textTokens: string[], candidateTokens: string[]) {
  if (!candidateTokens.length || candidateTokens.length > textTokens.length) return null;

  let best: { position: number; span: number } | null = null;
  for (let start = 0; start < textTokens.length; start += 1) {
    const remaining = new Map<string, number>();
    for (const token of candidateTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1);

    for (let end = start; end < textTokens.length; end += 1) {
      const current = remaining.get(textTokens[end]);
      if (current != null) {
        if (current <= 1) remaining.delete(textTokens[end]);
        else remaining.set(textTokens[end], current - 1);
      }

      if (remaining.size) continue;

      const span = end - start + 1;
      if (!best || span < best.span || (span === best.span && start < best.position)) {
        best = { position: start, span };
      }
      break;
    }
  }

  return best;
}

function teamPositionInText(text: string, teamName: unknown, mode: "ordered" | "slug" = "ordered") {
  const normalizedText = normalizeVisibleText(text);
  if (!normalizedText) return null;

  const textTokens = normalizedText.split(/\s+/).filter(Boolean);
  const searchable = ` ${normalizedText} `;
  let best: { position: number; span: number } | null = null;

  for (const alias of nationalTeamAliases(teamName)) {
    const normalizedAlias = normalizeVisibleText(alias);
    if (!normalizedAlias) continue;

    const exactPosition = searchable.indexOf(` ${normalizedAlias} `);
    if (exactPosition >= 0) {
      const tokenPosition = textTokens.indexOf(normalizedAlias.split(/\s+/)[0]);
      const candidate = { position: tokenPosition >= 0 ? tokenPosition : exactPosition, span: significantTokensFromText(alias).length || 1 };
      if (!best || candidate.span < best.span || (candidate.span === best.span && candidate.position < best.position)) best = candidate;
      continue;
    }

    const candidateTokens = significantTokensFromText(alias).slice(0, 4);
    if (!candidateTokens.length) continue;

    const candidate =
      mode === "slug"
        ? unorderedTokenWindowPosition(textTokens, candidateTokens)
        : (() => {
            const position = orderedTokenPosition(textTokens, candidateTokens);
            return position == null ? null : { position, span: candidateTokens.length };
          })();

    if (candidate && (!best || candidate.span < best.span || (candidate.span === best.span && candidate.position < best.position))) {
      best = candidate;
    }
  }

  return best?.position ?? null;
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

function eventDisplayOrderFromSignals(rawText: string, sourceUrl: string, fixture: MeridianFixtureTarget) {
  const headerText = eventHeaderLinesFromRawText(rawText, fixture).join(" ");
  const signals = [
    { text: eventOrderTextFromUrl(sourceUrl), mode: "slug" as const },
    { text: headerText, mode: "ordered" as const }
  ].filter((signal) => Boolean(signal.text));
  let orientation: MeridianEventOrientation = "NORMAL";

  for (const signal of signals) {
    const homePosition = teamPositionInText(signal.text, fixture.homeTeam, signal.mode);
    const awayPosition = teamPositionInText(signal.text, fixture.awayTeam, signal.mode);
    if (homePosition != null && awayPosition != null && homePosition !== awayPosition) {
      orientation = awayPosition < homePosition ? "INVERTED" : "NORMAL";
      break;
    }

    if (signal.mode === "slug" && homePosition === 0 && awayPosition == null) {
      orientation = "NORMAL";
      break;
    }

    if (signal.mode === "slug" && awayPosition === 0 && homePosition == null) {
      orientation = "INVERTED";
      break;
    }
  }

  return {
    orientation,
    bookmakerHomeTeam: orientation === "INVERTED" ? fixture.awayTeam : fixture.homeTeam,
    bookmakerAwayTeam: orientation === "INVERTED" ? fixture.homeTeam : fixture.awayTeam
  };
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
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
        await this.waitForUi();
        await this.acceptCookies();
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const canRetry = /ERR_NETWORK_CHANGED|ERR_ABORTED|Timeout/i.test(message);
        if (!canRetry || attempt === 3) throw error;

        await this.logger("warn", "falha temporÃ¡ria ao navegar na meridianbet; tentando novamente", {
          url,
          attempt,
          error: message
        });
        await page.waitForTimeout(1000 * attempt).catch(() => undefined);
      }
    }

    throw lastError;
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
        (fixture) => tokenGroupMatchesText(text, nationalTeamTokenGroups(fixture.homeTeam)) && tokenGroupMatchesText(text, nationalTeamTokenGroups(fixture.awayTeam))
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
    const homeTokenGroups = nationalTeamTokenGroups(fixture.homeTeam);
    const awayTokenGroups = nationalTeamTokenGroups(fixture.awayTeam);

    if (!homeTokenGroups.length || !awayTokenGroups.length) {
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
      const target = await this.findFixtureClickTarget(homeTokenGroups, awayTokenGroups);
      if (target) {
        await this.logger("info", "jogo encontrado na meridianbet; abrindo página do evento", {
          fixtureId: fixture.id,
          attempt: attempt + 1,
          targetText: target.text.slice(0, 180),
          href: target.href,
          targetKind: target.kind
        });

        const href = target.href;
        if (href && isMeridianEventPageUrl(href)) {
          await this.goToUrl(href, "abrindo jogo da meridianbet por link encontrado");
        } else {
          await page.mouse.click(target.x, target.y);
          await this.waitForEventPage(fixture);
        }

        if (await this.verifyCurrentEvent(fixture)) return true;

        await this.logger("warn", "evento clicado na meridianbet, mas nÃ£o confirmado como jogo alvo", {
          fixtureId: fixture.id,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          currentUrl: page.url(),
          targetKind: target.kind,
          textSample: (await this.visibleText()).slice(0, 700)
        });
        return false;
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
    const hasTeams = tokenGroupMatchesText(text, nationalTeamTokenGroups(fixture.homeTeam)) && tokenGroupMatchesText(text, nationalTeamTokenGroups(fixture.awayTeam));
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

    const displayOrder = eventDisplayOrderFromSignals(rawText, sourceUrl, fixture);
    const textBlocks = moneylineBlocksFromText(eventDetailText);
    const directBlocks = marketTexts.filter(looksLikeStandaloneMoneylineBlock);
    const rawMarkets = [
      ...new Map([...(textBlocks.length ? textBlocks : directBlocks), ...directBlocks].map((text) => [compactSpaces(text).slice(0, 220), text])).values()
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

  private async findFixtureClickTarget(homeTokenGroups: string[][], awayTokenGroups: string[][]) {
    const page = this.requirePage();
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
  const isVisible = (node) => {
    if (!node || !(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || rect.bottom < 100 || rect.top > window.innerHeight - 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };
  const center = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const rowText = (row) => (row.innerText || row.textContent || "").replace(/\s+/g, " ").trim();
  const badText = /bilhete|valor apostado|registrar|entrar|missoes/i;
  const pushTarget = (row, target, kind, href = null, priority = 50) => {
    if (!isVisible(target)) return;
    const text = rowText(row);
    const point = center(target);
    const rowRect = row.getBoundingClientRect();
    candidates.push({
      text,
      href,
      x: point.x,
      y: point.y,
      area: rowRect.width * rowRect.height,
      kind,
      priority
    });
  };

  const rows = [...document.querySelectorAll(".c-event, standard-event")];
  for (const row of rows) {
    if (!isVisible(row)) continue;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.width < 280 || rowRect.height < 36 || rowRect.height > 180) continue;
    const text = rowText(row);
    if (!text || text.length > 900 || badText.test(norm(text))) continue;
    const normalized = norm(text);
    if (!hasTokenGroup(normalized, pageHomeTokenGroups) || !hasTokenGroup(normalized, pageAwayTokenGroups)) continue;

    const anchors = [...row.querySelectorAll("a[href]")];
    for (const anchor of anchors) {
      const href = eventUrl(anchor.getAttribute("href"));
      if (href) pushTarget(row, anchor, "event-url-anchor", href, 1);
    }

    for (const action of [...row.querySelectorAll(".c-event-action__bottom")]) {
      pushTarget(row, action, "event-action-bottom", null, 5);
    }

    for (const icon of [...row.querySelectorAll("svg-icon[icon='event-link']")]) {
      pushTarget(row, icon.closest(".c-event-action__bottom") || icon, "event-link-icon", null, 8);
    }

    for (const icon of [...row.querySelectorAll("svg-icon[icon='event-details']")]) {
      pushTarget(row, icon.closest(".c-event-action__top") || icon, "event-preview-icon", null, 20);
    }

    const info = row.querySelector(".c-event__info");
    if (info) pushTarget(row, info, "event-preview-info", null, 30);
  }

  candidates.sort((left, right) => left.priority - right.priority || left.area - right.area || left.y - right.y);
  return candidates[0] ?? null;
})()
`;

    return page.evaluate(script) as Promise<MeridianClickTarget | null>;
  }

  private async marketGroupTexts() {
    const page = this.requirePage();
    const script = String.raw`
(() => {
  const oddRe = /\b(?:[1-9]\d{0,2}|0)(?:[.,]\d{1,3})?\b/g;
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
          const isEventUrl = /\/\d+\/?$/.test(window.location.pathname);
          const text = norm(document.body?.innerText || document.body?.textContent || "");
          const hasTeams = hasTokenGroup(text, pageHomeTokenGroups) && hasTokenGroup(text, pageAwayTokenGroups);
          return hasTeams && (isEventUrl || (text.includes("principal") && text.includes("resultado final")));
        },
        { homeTokenGroups, awayTokenGroups },
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

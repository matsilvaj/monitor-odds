import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import type { PaCategory, Selection } from "../domain/normalize.js";

type Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

export type Bet365FixtureTarget = {
  id: string;
  homeTeam: string | null;
  awayTeam: string | null;
  leagueName: string | null;
  leagueCountry: string | null;
  startsAt: string;
};

export type Bet365LeagueEventCandidate = {
  externalEventId: number;
  homeTeam: string;
  awayTeam: string;
  startsAt: string;
  dateKey: string;
  startTime: string | null;
  sourceText: string;
  sourceUrl: string | null;
};

export type Bet365CollectedSelection = {
  selection: Selection;
  label: string;
  price: number;
  index: number;
};

export type Bet365CollectedMarket = {
  marketName: string;
  paCategory: PaCategory;
  confidence: number;
  classificationReason: string;
  rawText: string;
  index: number;
  selections: Bet365CollectedSelection[];
};

export type Bet365CollectedEvent = {
  externalEventId: number;
  sourceUrl: string;
  eventName: string;
  markets: Bet365CollectedMarket[];
  rawText: string;
};

const MONEYLINE_MARKET_RE = /(full\s*time\s*result|resultado\s+final|resultado\s+da\s+partida|resultado\s+do\s+jogo|\b1x2\b)/i;
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

  throw new Error(`Chrome CDP nao respondeu na porta ${port}`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const ignored = new Set(["fc", "cf", "sc", "ac", "ec", "afc", "club", "de", "da", "do", "dos", "das", "the", "real"]);
  return normalizeVisibleText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !ignored.has(token));
}

function hasEveryImportantToken(text: string, tokens: string[]) {
  if (!tokens.length) return false;
  const important = tokens.slice(0, 3);
  return important.some((token) => text.includes(token));
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

function parseBet365EventId(sourceUrl: string, fallbackKey: string) {
  const eventId = /\/E(\d+)(?:\/|$)/i.exec(sourceUrl)?.[1] ?? /[?&]event(?:Id)?=(\d+)/i.exec(sourceUrl)?.[1];
  const parsed = eventId ? Number(eventId) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : hashToPositiveInt(`${sourceUrl}:${fallbackKey}`);
}

function eventCandidateKey(event: Bet365LeagueEventCandidate) {
  return [event.dateKey, event.startTime ?? "", normalizeVisibleText(event.homeTeam), normalizeVisibleText(event.awayTeam)].join(":");
}

function leagueSearchTerms(leagueName: string, country: string | null) {
  const terms = new Set<string>();
  terms.add(leagueName);

  if (country) {
    terms.add(`${country} ${leagueName}`);
  }

  const translatedCountries: Record<string, string[]> = {
    spain: ["Spain", "Espanha"],
    england: ["England", "Inglaterra", "Reino Unido", "United Kingdom"],
    france: ["France", "Franca", "França"],
    italy: ["Italy", "Italia", "Itália"],
    germany: ["Germany", "Alemanha"],
    brazil: ["Brazil", "Brasil"]
  };

  const countryKey = normalizeVisibleText(country);
  for (const translated of translatedCountries[countryKey] ?? []) {
    terms.add(`${translated} ${leagueName}`);
    terms.add(`${translated} - ${leagueName}`);
  }

  const normalized = normalizeVisibleText(`${country ?? ""} ${leagueName}`);
  const aliases: Record<string, string[]> = {
    "spain la liga": ["Spain La Liga", "Espanha - La Liga", "La Liga"],
    "la liga": ["Spain La Liga", "Espanha - La Liga", "La Liga"],
    "england premier league": ["England Premier League", "Inglaterra - Premier League", "Premier League"],
    "premier league": ["England Premier League", "Inglaterra - Premier League", "Premier League"],
    "france ligue 1": ["France Ligue 1", "Franca - Ligue 1", "França - Ligue 1", "Ligue 1"],
    "ligue 1": ["France Ligue 1", "Franca - Ligue 1", "França - Ligue 1", "Ligue 1"],
    "italy serie a": ["Italy Serie A", "Italia - Serie A", "Itália - Serie A", "Serie A"],
    "serie a": ["Italy Serie A", "Italia - Serie A", "Itália - Serie A", "Serie A"],
    "germany bundesliga": ["Germany Bundesliga", "Alemanha - Bundesliga", "Bundesliga"],
    "bundesliga": ["Germany Bundesliga", "Alemanha - Bundesliga", "Bundesliga"],
    brasileirao: ["Brazil Serie A", "Brasil - Serie A", "Brasileirao", "Brasileirão"],
    "brazil brasileirao": ["Brazil Serie A", "Brasil - Serie A", "Brasileirao", "Brasileirão"],
    libertadores: ["Copa Libertadores", "Libertadores"],
    "europa league": ["UEFA Europa League", "Europa League"]
  };

  for (const [key, values] of Object.entries(aliases)) {
    if (normalized.includes(key)) {
      for (const value of values) terms.add(value);
    }
  }

  return [...terms].filter(Boolean).sort((left, right) => right.length - left.length);
}

function classifyMarket(rawText: string): { category: PaCategory; confidence: number; reason: string } {
  const normalized = normalizeVisibleText(rawText);

  if (/(pagamento antecipado|pague antecipado|resultado antecipado|early payout|early pay out|2 gols de vantagem)/.test(normalized)) {
    return { category: "COM_PA", confidence: 0.98, reason: "bet365-explicit-payment-advance" };
  }

  if (/(precos ajustados|odds aumentadas|acumuladores aumentados|super odds|boost|boosted)/.test(normalized)) {
    return { category: "SEM_PA", confidence: 1, reason: "bet365-adjusted-prices-without-payment-advance" };
  }

  return { category: "SEM_PA", confidence: 1, reason: "bet365-standard-without-payment-advance" };
}

function parseMoneylineMarket(rawText: string, fixture: Bet365FixtureTarget, index: number): Bet365CollectedMarket | null {
  if (!MONEYLINE_MARKET_RE.test(rawText)) return null;

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
    .filter(({ line }) => /^(full\s*time\s*result|resultado\s+final|resultado\s+da\s+partida|resultado\s+do\s+jogo|\b1x2\b)/i.test(line));

  const boundaryRe =
    /^(full\s*time\s*result|resultado\s+final|resultado\s+da\s+partida|resultado\s+do\s+jogo|\b1x2\b|double\s+chance|total\s+goals|both\s+teams|goalscorers|aposta\s+aumentada|criar\s+aposta|cards|corners|half|player|specials|minutes|asian\s+lines)/i;

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

async function question(prompt: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export class Bet365BrowserClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private chromeProcess: ChildProcess | null = null;

  constructor(
    private readonly config: Bet365BookmakerConfig,
    private readonly logger: Logger
  ) {}

  async start() {
    const profileDir = path.resolve(this.config.chromeProfileDir);
    await mkdir(profileDir, { recursive: true });
    const chromePath = findChromeExecutable(this.config.chromeExecutablePath);
    if (!chromePath) throw new Error("chrome.exe nao encontrado. Configure BET365_CHROME_EXECUTABLE no .env.");

    const launch = async (targetProfileDir: string) => {
      const port = 9300 + Math.floor(Math.random() * 500);
      await this.logger("info", "iniciando Chrome real via CDP para bet365", { profileDir: targetProfileDir, chromePath, port });

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
      if (!this.context) throw new Error("Chrome CDP iniciou sem contexto de navegacao");
    };

    try {
      await launch(profileDir);
    } catch (error) {
      this.chromeProcess?.kill();
      const fallbackProfileDir = path.resolve(`${this.config.chromeProfileDir}-run-${Date.now()}`);
      await mkdir(fallbackProfileDir, { recursive: true });
      await this.logger("warn", "perfil principal da bet365 nao abriu CDP; tentando perfil temporario", {
        profileDir,
        fallbackProfileDir,
        error: error instanceof Error ? error.message : String(error)
      });
      await launch(fallbackProfileDir);
    }

    if (!this.context) throw new Error("Chrome CDP iniciou sem contexto de navegacao");
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.navigationTimeoutMs);
    this.page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
  }

  async stop() {
    if (!this.browser || this.config.keepBrowserOpen) return;
    await this.logger("info", "fechando Chrome da bet365");
    await this.browser.close();
    this.chromeProcess?.kill();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromeProcess = null;
  }

  currentUrl() {
    return this.requirePage().url();
  }

  async goToUrl(url: string, label: string) {
    const page = this.requirePage();
    await this.logger("info", label, { url });
    if (this.isEventUrl(page.url()) && /\/G40\//i.test(url)) {
      await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
    await this.waitForUi();
  }

  async openHome() {
    await this.goToUrl(this.config.baseUrl, "abrindo bet365");
    await this.acceptCookies();
  }

  async openFootball() {
    await this.logger("info", "abrindo aba de futebol pela interface");
    const clicked = await this.clickExactText("Futebol");

    if (!clicked) {
      await this.goToUrl(this.hashUrl("/AS/B1/"), "abrindo aba de futebol por URL");
    } else {
      await this.waitForUi();
    }
  }

  async openCompetitions() {
    await this.logger("info", "abrindo lista de competicoes de futebol");
    const clicked = await this.clickText(/competitions|competições/i);

    if (!clicked) {
      await this.goToUrl(this.hashUrl("/AS/B1/K%5E5/"), "abrindo lista de competicoes de futebol por URL");
    } else {
      await this.waitForUi();
    }

    await this.acceptCookies();
  }

  async collectLeagueCandidates() {
    const text = await this.visibleText();
    const ignored = new Set([
      "featured",
      "competitions",
      "outrights",
      "offers",
      "free games",
      "markets",
      "popular",
      "soccer",
      "futebol",
      "todos os esportes"
    ]);

    return [
      ...new Set(
        text
          .split(/\n+/)
          .map((line) => compactSpaces(line.replace(/\d+\s*>?$/, "")))
          .filter((line) => {
            const normalized = normalizeVisibleText(line);
            return line.length >= 4 && line.length <= 80 && /[a-zA-Z]/.test(line) && !ignored.has(normalized);
          })
      )
    ];
  }

  async openLeague(leagueName: string, country: string | null, expectedTeamNames: string[] = []) {
    const page = this.requirePage();
    const beforeUrl = page.url();
    const terms = leagueSearchTerms(leagueName, country);
    await this.logger("info", "procurando liga na bet365", { leagueName, country, terms, expectedTeams: expectedTeamNames.slice(0, 8) });

    for (const term of terms) {
      const clicked = (await this.clickLeagueText(term)) || (await this.clickText(term));
      if (!clicked) continue;

      await this.waitForUi();
      const afterUrl = page.url();
      const pageText = await this.visibleText();
      if (afterUrl !== beforeUrl || this.hasExpectedTeams(pageText, expectedTeamNames) || /upcoming matches|proximos jogos|partidas/i.test(pageText)) {
        await this.logger("info", "liga aberta na bet365", { leagueName, clickedTerm: term, url: afterUrl });
        return true;
      }
    }

    await this.logger("warn", "nao consegui abrir a liga automaticamente", { leagueName, country });
    return false;
  }

  async collectLeagueEvents(targetDateKeys: string[]) {
    const page = this.requirePage();
    const byKey = new Map<string, Bet365LeagueEventCandidate>();
    await this.logger("info", "varrendo jogos da liga aberta na bet365", { targetDateKeys });

    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(6000);

    for (let attempt = 0; attempt < 18; attempt += 1) {
      const beforeCount = byKey.size;
      const visibleEvents = await this.visibleLeagueEvents(targetDateKeys);

      for (const event of visibleEvents) {
        byKey.set(eventCandidateKey(event), event);
      }

      const atBottom = await this.isMainContentNearBottom();
      await this.logger("info", "jogos visiveis lidos na liga", {
        attempt: attempt + 1,
        visible: visibleEvents.length,
        totalUnique: byKey.size,
        atBottom
      });

      if (atBottom && byKey.size === beforeCount) break;

      await page.keyboard.press("PageDown").catch(() => undefined);
      await this.scrollMainContent(850);
      await page.waitForTimeout(650);
    }

    const events = [...byKey.values()].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    if (!events.length) {
      const textSample = (await this.visibleText()).slice(0, 1200);
      await this.logger("warn", "nenhum jogo bruto encontrado na liga aberta", {
        url: page.url(),
        textSample
      });
    }

    await this.logger("info", "jogos brutos encontrados na liga", {
      total: events.length,
      sample: events.slice(0, 8).map((event) => ({
        dateKey: event.dateKey,
        time: event.startTime,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam
      }))
    });

    return events;
  }

  async openFixture(fixture: Bet365FixtureTarget) {
    const page = this.requirePage();
    const homeTokens = tokensFromName(fixture.homeTeam);
    const awayTokens = tokensFromName(fixture.awayTeam);

    if (!homeTokens.length || !awayTokens.length) {
      await this.logger("warn", "fixture sem nomes suficientes para procurar na tela", { fixtureId: fixture.id, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam });
      return false;
    }

    await this.logger("info", "procurando jogo na liga aberta", {
      fixtureId: fixture.id,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      startsAt: fixture.startsAt
    });

    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(700);

    for (let attempt = 0; attempt < 14; attempt += 1) {
      const beforeDomUrl = page.url();
      const domTarget = await this.clickFixtureDomTarget(homeTokens, awayTokens);
      if (domTarget.clicked) {
        await this.logger("info", "jogo encontrado no container clicavel; abrindo pagina do evento", {
          fixtureId: fixture.id,
          attempt: attempt + 1,
          targetText: domTarget.text.slice(0, 180)
        });

        await this.waitForUi();
        if (await this.verifyCurrentEvent(fixture)) return true;
        if (page.url() !== beforeDomUrl && this.isEventUrl(page.url())) {
          await this.logger("warn", "pagina do evento abriu, mas os mercados ainda nao apareceram na validacao inicial", {
            fixtureId: fixture.id,
            url: page.url()
          });
          return true;
        }
      }

      const target = await this.findFixtureClickTarget(homeTokens, awayTokens);
      if (target) {
        const beforeUrl = page.url();
        await this.logger("info", "jogo encontrado na tela; abrindo pagina do evento", {
          fixtureId: fixture.id,
          attempt: attempt + 1,
          targetText: target.text.slice(0, 180)
        });

        await page.mouse.click(target.x, target.y);
        await this.waitForUi();

        if (page.url() !== beforeUrl && (await this.verifyCurrentEvent(fixture))) {
          return true;
        }

        const fallbackClicked = await this.clickText(fixture.homeTeam ?? homeTokens[0]);
        if (fallbackClicked) {
          await this.waitForUi();
          if (await this.verifyCurrentEvent(fixture)) return true;
        }
      }

      await page.keyboard.press("PageDown").catch(() => undefined);
      await this.scrollMainContent(650);
      await page.waitForTimeout(500);
    }

    await this.logger("warn", "nao consegui abrir o jogo automaticamente", {
      fixtureId: fixture.id,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam
    });
    return false;
  }

  async waitForManualEvent(fixture: Bet365FixtureTarget) {
    if (!this.config.manualFallback || !process.stdin.isTTY) return false;

    await this.logger("warn", "fallback manual solicitado para jogo da bet365", {
      fixtureId: fixture.id,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam
    });

    const answer = await question(
      `[bet365] Abra manualmente "${fixture.homeTeam} x ${fixture.awayTeam}" no Chrome aberto e pressione ENTER para coletar, ou digite "pular": `
    );

    if (/^(pular|skip|s)$/i.test(answer.trim())) return false;
    await this.waitForUi();
    return this.verifyCurrentEvent(fixture);
  }

  async verifyCurrentEvent(fixture: Bet365FixtureTarget) {
    const page = this.requirePage();
    const text = normalizeVisibleText(await this.visibleText());
    const hasTeams = hasEveryImportantToken(text, tokensFromName(fixture.homeTeam)) && hasEveryImportantToken(text, tokensFromName(fixture.awayTeam));
    const hasEventSignal = /\/AC\//i.test(page.url()) || MONEYLINE_MARKET_RE.test(text);
    return hasTeams && hasEventSignal;
  }

  async collectCurrentEvent(fixture: Bet365FixtureTarget): Promise<Bet365CollectedEvent> {
    const page = this.requirePage();
    await this.waitForUi();
    const sourceUrl = page.url();
    let rawText = await this.visibleText();
    let marketTexts = await this.marketGroupTexts();
    let reloadedEventPage = false;

    for (let attempt = 0; attempt < 20 && !marketTexts.length && !MONEYLINE_MARKET_RE.test(rawText); attempt += 1) {
      if (!reloadedEventPage && attempt === 5 && this.isEventUrl(sourceUrl)) {
        await this.logger("info", "recarregando URL do evento para aguardar mercados da bet365", { fixtureId: fixture.id, sourceUrl });
        await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
        await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
        await this.waitForUi();
        reloadedEventPage = true;
      }

      await page.waitForTimeout(2000);
      rawText = await this.visibleText();
      marketTexts = await this.marketGroupTexts();
    }

    const rawMarkets = [
      ...new Map([...marketTexts, ...moneylineBlocksFromText(rawText), rawText].map((text) => [compactSpaces(text).slice(0, 240), text])).values()
    ];
    const markets = rawMarkets
      .map((text, index) => parseMoneylineMarket(text, fixture, index))
      .filter((market): market is Bet365CollectedMarket => Boolean(market));

    await this.logger("info", "odds lidas na pagina do jogo", {
      fixtureId: fixture.id,
      sourceUrl,
      markets: markets.length,
      odds: markets.reduce((total, market) => total + market.selections.length, 0),
      categories: markets.map((market) => market.paCategory)
    });

    return {
      externalEventId: parseBet365EventId(sourceUrl, fixture.id),
      sourceUrl,
      eventName: [fixture.homeTeam, fixture.awayTeam].filter(Boolean).join(" x "),
      markets,
      rawText: rawText.slice(0, 2500)
    };
  }

  private async acceptCookies() {
    for (const label of [/aceitar todos/i, /accept all/i, /concordo/i]) {
      const clicked = await this.clickText(label);
      if (clicked) {
        await this.logger("info", "banner de cookies aceito");
        await this.requirePage().waitForTimeout(700);
        return;
      }
    }
  }

  private async clickText(term: string | RegExp) {
    const page = this.requirePage();
    const locator = typeof term === "string" ? page.getByText(new RegExp(escapeRegExp(term), "i")).first() : page.getByText(term).first();

    try {
      if ((await locator.count()) < 1) return false;
      await locator.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => undefined);
      await locator.click({ timeout: 4500 });
      return true;
    } catch {
      return false;
    }
  }

  private async clickExactText(term: string) {
    const page = this.requirePage();
    const locator = page.getByText(term, { exact: true }).first();

    try {
      if ((await locator.count()) < 1) return false;
      await locator.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => undefined);
      await locator.click({ timeout: 4500 });
      return true;
    } catch {
      return false;
    }
  }

  private hasExpectedTeams(pageText: string, expectedTeamNames: string[]) {
    if (!expectedTeamNames.length) return false;
    const normalized = normalizeVisibleText(pageText);
    return expectedTeamNames.some((teamName) => hasEveryImportantToken(normalized, tokensFromName(teamName)));
  }

  private isEventUrl(url: string) {
    return /\/AC\/B1\/C1\/D\d+\/E\d+\/F/i.test(url);
  }

  private async visibleLeagueEvents(targetDateKeys: string[]) {
    const page = this.requirePage();
    const payload = JSON.stringify({ targetDateKeys, pageUrl: page.url() });
    const script = String.raw`
(() => {
  const { targetDateKeys: pageTargetDateKeys, pageUrl } = ${payload};
  const targetDateSet = new Set(pageTargetDateKeys);
  const targetByMonthDay = new Map(pageTargetDateKeys.map((key) => [key.slice(5), key]));
  const oddRe = /\b(?:[1-9]\d{0,2}|0)[.,]\d{2,3}\b/;
  const timeRe = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

  const norm = (value) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const dateKeyFromDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  };

  const localToday = new Date();
  const localTomorrow = new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate() + 1);
  const todayKey = dateKeyFromDate(localToday);
  const tomorrowKey = dateKeyFromDate(localTomorrow);
  const months = new Map([
    ["jan", 1], ["janeiro", 1], ["january", 1],
    ["feb", 2], ["fev", 2], ["fevereiro", 2], ["february", 2],
    ["mar", 3], ["marco", 3], ["march", 3],
    ["apr", 4], ["abr", 4], ["abril", 4], ["april", 4],
    ["may", 5], ["mai", 5], ["maio", 5],
    ["jun", 6], ["junho", 6], ["june", 6],
    ["jul", 7], ["julho", 7], ["july", 7],
    ["aug", 8], ["ago", 8], ["agosto", 8], ["august", 8],
    ["sep", 9], ["set", 9], ["setembro", 9], ["september", 9],
    ["oct", 10], ["out", 10], ["outubro", 10], ["october", 10],
    ["nov", 11], ["novembro", 11], ["november", 11],
    ["dec", 12], ["dez", 12], ["dezembro", 12], ["december", 12]
  ]);

  const parseDateKey = (text) => {
    const normalized = norm(text);
    if (!normalized) return null;
    if (/\b(hoje|today)\b/.test(normalized)) return targetDateSet.has(todayKey) ? todayKey : null;
    if (/\b(amanha|tomorrow)\b/.test(normalized)) return targetDateSet.has(tomorrowKey) ? tomorrowKey : null;

    const match = normalized.match(/\b(\d{1,2})\s+(jan|janeiro|january|feb|fev|fevereiro|february|mar|marco|march|apr|abr|abril|april|may|mai|maio|jun|junho|june|jul|julho|july|aug|ago|agosto|august|sep|set|setembro|september|oct|out|outubro|october|nov|novembro|november|dec|dez|dezembro|december)\b/);
    if (!match) return null;

    const day = Number(match[1]);
    const month = months.get(match[2]);
    if (!month || !Number.isFinite(day)) return null;

    const monthDay = String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    return targetByMonthDay.get(monthDay) ?? null;
  };

  const looksLikeDateHeader = (text) => {
    const normalized = norm(text);
    return /\b(hoje|today|amanha|tomorrow)\b/.test(normalized) || /\b(\d{1,2})\s+(jan|janeiro|january|feb|fev|fevereiro|february|mar|marco|march|apr|abr|abril|april|may|mai|maio|jun|junho|june|jul|julho|july|aug|ago|agosto|august|sep|set|setembro|september|oct|out|outubro|october|nov|novembro|november|dec|dez|dezembro|december)\b/.test(normalized);
  };

  const toIso = (dateKey, time) => {
    const [year, month, day] = dateKey.split("-").map(Number);
    const timeMatch = time.match(timeRe);
    if (!timeMatch) return null;
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
  };

  const stableHash = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0);
  };

  const parseTeams = (text) => {
    const timeMatch = text.match(timeRe);
    if (!timeMatch) return null;

    const lines = text
      .split(/\n+/)
      .map((line) => line.replace(timeRe, "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const teams = [];

    for (const line of lines) {
      const normalized = norm(line);
      if (!normalized) continue;
      if (parseDateKey(line)) continue;
      if (oddRe.test(line)) continue;
      if (/^\(?\d+\)?$/.test(line)) continue;
      if (/^\d+\s*>?$/.test(line)) continue;
      if (/^(tv|live|ao vivo|mais|markets?|mercados?|estatisticas|stats)$/i.test(normalized)) continue;
      if (line.length < 2 || line.length > 80) continue;
      if (!/[A-Za-z\u00C0-\u024F]/.test(line)) continue;
      teams.push(line);
    }

    if (teams.length < 2) return null;
    return {
      homeTeam: teams[0],
      awayTeam: teams[1],
      startTime: timeMatch[1].padStart(2, "0") + ":" + timeMatch[2]
    };
  };

  const allNodes = [...document.querySelectorAll("div,span,p")];
  const dateHeaders = [];

  for (const node of allNodes) {
    const rect = node.getBoundingClientRect();
    const text = (node.innerText || node.textContent || "").trim();
    if (!text || text.length > 80) continue;
    if (!looksLikeDateHeader(text)) continue;
    const dateKey = parseDateKey(text);
    dateHeaders.push({ top: rect.top, bottom: rect.bottom, dateKey, text });
  }

  dateHeaders.sort((left, right) => left.top - right.top);

  const nodes = [...document.querySelectorAll(".rcl-ParticipantFixtureDetails-clickable,[class*='ParticipantFixtureDetails-clickable']")];
  const events = [];
  const seen = new Set();
  const addEvent = (event) => {
    const key = [event.dateKey, event.startTime, norm(event.homeTeam), norm(event.awayTeam)].join(":");
    if (seen.has(key)) return;
    seen.add(key);
    events.push(event);
  };

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 24 || rect.bottom < 0 || rect.top > window.innerHeight) continue;

    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

    const text = (node.innerText || node.textContent || "").trim();
    if (!text || text.length > 700) continue;

    const parsed = parseTeams(text);
    if (!parsed) continue;

    const ownDateKey = parseDateKey(text);
    const header = [...dateHeaders].reverse().find((item) => item.bottom <= rect.top + 8) ?? null;
    const headerDateKey = header?.dateKey ?? null;
    const dateKey = ownDateKey ?? headerDateKey;
    if (!dateKey || !targetDateSet.has(dateKey)) continue;

    const startsAt = toIso(dateKey, parsed.startTime);
    if (!startsAt) continue;

    const sourceUrl = node.closest("a[href]")?.href ?? null;
    const urlEventId = sourceUrl?.match(/\/E(\d+)(?:\/|$)/i)?.[1] ?? null;
    const externalEventId = urlEventId ? Number(urlEventId) : stableHash([pageUrl, dateKey, parsed.startTime, parsed.homeTeam, parsed.awayTeam].join(":"));

    addEvent({
      externalEventId,
      homeTeam: parsed.homeTeam,
      awayTeam: parsed.awayTeam,
      startsAt,
      dateKey,
      startTime: parsed.startTime,
      sourceText: text.slice(0, 700),
      sourceUrl
    });
  }

  const isTeamLine = (line) => {
    const normalized = norm(line);
    if (!normalized) return false;
    if (parseDateKey(line)) return false;
    if (timeRe.test(line)) return false;
    if (oddRe.test(line)) return false;
    if (/^\(?\d+\)?$/.test(line)) return false;
    if (/^\d+\s*>?$/.test(line)) return false;
    if (/^(tv|live|ao vivo|mais|matches|jogos|markets?|mercados?|teams?|times?|table|all|todos|full time result|resultado final|total goals|ambas marcam|both teams to score|double chance|pagamento antecipado|acumuladores aumentados|aposta aumentada|criar aposta)$/i.test(normalized)) return false;
    return line.length >= 2 && line.length <= 80 && /[A-Za-z\u00C0-\u024F]/.test(line);
  };

  const lines = (document.body.innerText || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let currentDateKey = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const parsedDateKey = parseDateKey(line);
    if (parsedDateKey || looksLikeDateHeader(line)) {
      currentDateKey = parsedDateKey;
      continue;
    }

    const timeMatch = line.match(timeRe);
    if (!timeMatch || !currentDateKey || !targetDateSet.has(currentDateKey)) continue;

    const teamLines = [];
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 8); cursor += 1) {
      if (parseDateKey(lines[cursor])) break;
      if (timeRe.test(lines[cursor]) && teamLines.length < 2) break;
      if (!isTeamLine(lines[cursor])) continue;
      teamLines.push(lines[cursor]);
      if (teamLines.length >= 2) break;
    }

    if (teamLines.length < 2) continue;

    const startTime = timeMatch[1].padStart(2, "0") + ":" + timeMatch[2];
    const startsAt = toIso(currentDateKey, startTime);
    if (!startsAt) continue;

    const homeTeam = teamLines[0];
    const awayTeam = teamLines[1];
    addEvent({
      externalEventId: stableHash([pageUrl, currentDateKey, startTime, homeTeam, awayTeam].join(":")),
      homeTeam,
      awayTeam,
      startsAt,
      dateKey: currentDateKey,
      startTime,
      sourceText: [line, homeTeam, awayTeam].join("\n"),
      sourceUrl: null
    });
  }

  return events;
})()
`;

    return page.evaluate(script) as Promise<Bet365LeagueEventCandidate[]>;
  }

  private async clickLeagueText(term: string) {
    const page = this.requirePage();
    const script = String.raw`
(() => {
  const candidateTerm = ${JSON.stringify(term)};
  const norm = (value) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const normalizedTerm = norm(candidateTerm);
  const termTokens = normalizedTerm.split(/\s+/).filter((token) => token.length >= 3);
  const nodes = [...document.querySelectorAll("a,button,[role='button'],div,span")];
  const candidates = [];

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 14 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.width * rect.height > window.innerWidth * window.innerHeight * 0.35) continue;

    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

    const text = (node.innerText || node.textContent || "").trim();
    if (text.length < 3 || text.length > 220) continue;

    const normalizedText = norm(text);
    const tokenHits = termTokens.filter((token) => normalizedText.includes(token)).length;
    const exactish = normalizedText.includes(normalizedTerm) || normalizedTerm.includes(normalizedText);
    if (!exactish && tokenHits < Math.min(2, termTokens.length)) continue;

    const area = rect.width * rect.height;
    const score = (exactish ? 30 : 0) + tokenHits * 8 - area / 60000 - text.length / 300;
    candidates.push({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text,
      score,
      area
    });
  }

  candidates.sort((left, right) => right.score - left.score || left.area - right.area);
  return candidates[0] ?? null;
})()
`;
    const target = (await page.evaluate(script)) as { x: number; y: number; text: string } | null;

    if (!target) return false;

    await this.logger("info", "clicando candidato visual de liga", { term, targetText: target.text.slice(0, 120) });
    await page.mouse.click(target.x, target.y);
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

  const nodes = [...document.querySelectorAll("a,button,[role='button'],div,span")];
  const viewportArea = window.innerWidth * window.innerHeight;
  const candidates = [];

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 16 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.width * rect.height > viewportArea * 0.55) continue;

    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

    const text = (node.innerText || node.textContent || "").trim();
    if (text.length < 4 || text.length > 650) continue;

    const normalized = norm(text);
    const homeHits = pageHomeTokens.filter((token) => normalized.includes(token)).length;
    const awayHits = pageAwayTokens.filter((token) => normalized.includes(token)).length;
    if (!homeHits || !awayHits) continue;

    const oddsCount = (text.match(/\b(?:[1-9]\d{0,2}|0)[.,]\d{2,3}\b/g) ?? []).length;
    const area = rect.width * rect.height;
    const score = homeHits * 12 + awayHits * 12 + Math.min(oddsCount, 3) * 2 - area / 60000 - text.length / 500;

    candidates.push({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text,
      score,
      area
    });
  }

  candidates.sort((left, right) => right.score - left.score || left.area - right.area);
  return candidates[0] ?? null;
})()
`;
    return page.evaluate(script) as Promise<{ x: number; y: number; text: string } | null>;
  }

  private async clickFixtureDomTarget(homeTokens: string[], awayTokens: string[]) {
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

  const candidates = [...document.querySelectorAll(".rcl-ParticipantFixtureDetails-clickable")];
  const target = candidates.find((node) => {
    const normalized = norm(node.innerText || node.textContent || "");
    return pageHomeTokens.some((token) => normalized.includes(token)) && pageAwayTokens.some((token) => normalized.includes(token));
  });

  if (!target) return { clicked: false, text: "" };
  target.scrollIntoView({ block: "center", inline: "nearest" });
  target.click();
  return { clicked: true, text: (target.innerText || target.textContent || "").trim() };
})()
`;

    return page.evaluate(script) as Promise<{ clicked: boolean; text: string }>;
  }

  private async scrollMainContent(deltaY: number) {
    const page = this.requirePage();
    const script = String.raw`
(() => {
  const candidates = [...document.querySelectorAll("div")].filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.height > window.innerHeight * 0.45 && rect.width > window.innerWidth * 0.35 && node.scrollHeight > node.clientHeight + 40;
  });
  candidates.sort((left, right) => {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    return rightRect.left - leftRect.left;
  });
  const target = candidates[0] || document.scrollingElement || document.documentElement;
  target.scrollBy(0, ${deltaY});
  return true;
})()
`;
    await page.evaluate(script).catch(() => undefined);
  }

  private async isMainContentNearBottom() {
    const page = this.requirePage();
    const script = String.raw`
(() => {
  const candidates = [...document.querySelectorAll("div")].filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.height > window.innerHeight * 0.45 && rect.width > window.innerWidth * 0.35 && node.scrollHeight > node.clientHeight + 40;
  });
  candidates.sort((left, right) => {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    return rightRect.left - leftRect.left;
  });
  const target = candidates[0] || document.scrollingElement || document.documentElement;
  return target.scrollTop + target.clientHeight >= target.scrollHeight - 80;
})()
`;

    return page.evaluate(script).catch(() => false) as Promise<boolean>;
  }

  private async marketGroupTexts() {
    const page = this.requirePage();
    const script = String.raw`
(() => {
  const moneylineRe = /(full\s*time\s*result|resultado\s+final|resultado\s+da\s+partida|resultado\s+do\s+jogo|\b1x2\b)/i;
  const oddRe = /\b(?:[1-9]\d{0,2}|0)[.,]\d{2,3}\b/g;
  const nodes = [...document.querySelectorAll("[class*='MarketGroup'],[class*='Market'],[class*='Coupon'],div")];
  const candidates = [];

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 24 || rect.bottom < 0 || rect.top > window.innerHeight * 1.5) continue;

    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

    const text = (node.innerText || node.textContent || "").trim();
    if (text.length < 20 || text.length > 1800) continue;
    if (!moneylineRe.test(text)) continue;
    if ((text.match(oddRe) ?? []).length < 3) continue;

    candidates.push({
      text,
      area: rect.width * rect.height
    });
  }

  candidates.sort((left, right) => left.area - right.area || left.text.length - right.text.length);
  const selected = [];
  const signatures = new Set();

  for (const candidate of candidates) {
    const odds = candidate.text.match(oddRe)?.slice(0, 3).join("|") ?? candidate.text.slice(0, 80);
    const signature = odds + ":" + candidate.text.toLowerCase().includes("pagamento antecipado");
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    selected.push(candidate.text);
  }

  return selected.slice(0, 4);
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

  private async waitForUi() {
    const page = this.requirePage();
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
  }

  private hashUrl(hashPath: string) {
    const base = this.config.baseUrl.replace(/\/$/, "");
    return `${base}/#${hashPath.startsWith("/") ? hashPath : `/${hashPath}`}`;
  }

  private requirePage() {
    if (!this.page) throw new Error("Bet365 browser page is not initialized");
    return this.page;
  }
}

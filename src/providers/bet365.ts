import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import type { PaCategory, Selection } from "../domain/normalize.js";

export type Bet365FixtureTarget = {
  id: string;
  homeTeam: string | null;
  awayTeam: string | null;
  startsAt: string;
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
  rawText: string;
  index: number;
  selections: Bet365CollectedSelection[];
};

export type Bet365CollectedEvent = {
  externalEventId: number;
  sourceUrl: string;
  eventName: string;
  bookmakerHomeTeam: string | null;
  bookmakerAwayTeam: string | null;
  markets: Bet365CollectedMarket[];
  rawText: string;
};

export type Bet365CollectedPage = {
  rawText: string;
  sourceUrl: string;
};

type Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;

const PRICE_RE = /(?:^|\s)([1-9]\d{0,2}[.,]\d{1,3})(?:\s|$)/;
const ODD_LINE_RE = /^(.+?)\s+(\d+(?:[.,]\d{1,3})?)$/;
const PAIR_RE = /([^\d]+?)\s+(\d+(?:[.,]\d{1,3})?)/g;
const NUMBER_LINE_RE = /^\d+(?:[.,]\d{1,3})?$/;
const execFileAsync = promisify(execFile);
const BET365_SCREEN_HELPER_PATH = path.resolve("src/providers/bet365-screen-helper.py");

type Highlight = {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
};

function findChromeExecutable(configuredPath: string | undefined) {
  const candidates = [
    configuredPath,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => existsSync(candidate));
}

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePrice(value: string) {
  const match = PRICE_RE.exec(value);
  if (!match) return null;
  const price = Number(match[1].replace(",", "."));
  return Number.isFinite(price) && price >= 1.01 && price <= 1000 ? price : null;
}

function stripPrice(value: string) {
  return value.replace(PRICE_RE, " ").replace(/\s+/g, " ").trim();
}

function hashToPositiveInt(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function singleQuotedPowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function runPowerShell(script: string, timeoutMs = 10_000) {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

async function activateChromeWindow() {
  const script = String.raw`
$shell = New-Object -ComObject WScript.Shell
$activated = $shell.AppActivate('Bet365') -or $shell.AppActivate('bet365') -or $shell.AppActivate('Google Chrome')
if (-not $activated) { throw 'Chrome window not found' }
Start-Sleep -Milliseconds 250
`;
  await runPowerShell(script, 5_000);
}

async function sendKeys(keys: string, delayMs = 300) {
  const script = `
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys(${singleQuotedPowerShell(keys)})
Start-Sleep -Milliseconds ${delayMs}
`;
  await runPowerShell(script, Math.max(5_000, delayMs + 2_000));
}

async function setClipboardText(text: string) {
  await runPowerShell(`Set-Clipboard -Value ${singleQuotedPowerShell(text)}`, 5_000);
}

async function readClipboardText() {
  return runPowerShell("Get-Clipboard -Raw", 10_000);
}

async function navigateChromeCurrentTab(url: string) {
  await activateChromeWindow();
  await setClipboardText(url);
  await sendKeys("^l", 300);
  await sendKeys("^v", 300);
  await sendKeys("{ENTER}", 500);
}

function parseHighlightResult(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "{}") return null;
  return JSON.parse(trimmed) as Highlight;
}

async function runScreenHelper(command: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return parseHighlightResult(stdout);
  } catch (caught) {
    const error = caught as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = String(error.stdout ?? "");
    if (stdout.trim() === "{}") return null;
    throw error;
  }
}

async function clickChromeFindHighlight() {
  if (!existsSync(BET365_SCREEN_HELPER_PATH)) {
    throw new Error(`Helper visual da Bet365 nao encontrado: ${BET365_SCREEN_HELPER_PATH}`);
  }

  try {
    return await runScreenHelper("python", [BET365_SCREEN_HELPER_PATH]);
  } catch (firstError) {
    try {
      return await runScreenHelper("py", ["-3", BET365_SCREEN_HELPER_PATH]);
    } catch (secondError) {
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`Falha ao clicar destaque visual da Bet365. python: ${firstMessage}; py -3: ${secondMessage}`);
    }
  }
}

async function waitForDevtools(port: number, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return true;
    } catch {
      // Chrome still starting or remote debugging disabled.
    }
    await sleep(350);
  }
  return false;
}

async function getBet365PageWebSocketUrl(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  if (!response.ok) throw new Error(`Chrome DevTools retornou HTTP ${response.status}`);
  const pages = (await response.json()) as Array<Record<string, unknown>>;
  const bet365Page = pages.find((page) => page.type === "page" && String(page.url ?? "").includes("bet365.bet.br") && page.webSocketDebuggerUrl);
  const fallbackPage = pages.find((page) => page.type === "page" && page.webSocketDebuggerUrl);
  const wsUrl = bet365Page?.webSocketDebuggerUrl ?? fallbackPage?.webSocketDebuggerUrl;
  if (typeof wsUrl !== "string") throw new Error("Nao encontrei aba disponivel no Chrome DevTools.");
  return wsUrl;
}

async function evaluateDevtoolsText(port: number, expression: string) {
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (!WebSocketCtor) throw new Error("WebSocket global indisponivel para ler Chrome DevTools.");
  const ws = new WebSocketCtor(await getBet365PageWebSocketUrl(port));

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timeout lendo texto via Chrome DevTools."));
    }, 8_000);

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression,
            returnByValue: true,
            awaitPromise: true
          }
        })
      );
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, any>;
      if (message.id !== 1) return;
      clearTimeout(timeout);
      ws.close();
      if (message.exceptionDetails) {
        reject(new Error(JSON.stringify(message.exceptionDetails)));
        return;
      }
      resolve(String(message.result?.result?.value ?? ""));
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Falha no WebSocket do Chrome DevTools."));
    });
  });
}

async function readVisibleTextFromDevtools(port: number) {
  return evaluateDevtoolsText(
    port,
    String.raw`
(() => {
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0 &&
      rect.width > 2 &&
      rect.height > 2 &&
      rect.bottom >= 0 &&
      rect.top <= window.innerHeight &&
      rect.right >= 0 &&
      rect.left <= window.innerWidth
    );
  };

  const normalized = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const rows = [];

  for (const element of document.querySelectorAll("body *")) {
    if (!visible(element)) continue;
    const text = normalized(element.innerText || element.textContent || "");
    if (!text) continue;
    if (text.length > 120) continue;

    const childTexts = Array.from(element.children)
      .filter(visible)
      .map((child) => normalized(child.innerText || child.textContent || ""))
      .filter(Boolean);
    if (childTexts.some((childText) => childText === text)) continue;

    const rect = element.getBoundingClientRect();
    rows.push({ text, top: Math.round(rect.top), left: Math.round(rect.left) });
  }

  rows.sort((a, b) => a.top - b.top || a.left - b.left);
  return rows.map((row) => row.text).join("\n");
})()
`
  );
}

async function readCurrentUrlFromDevtools(port: number) {
  return evaluateDevtoolsText(port, "window.location.href");
}

function cleanLines(text: string) {
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
  const lines = cleanLines(rawText);
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
  const lines = cleanLines(rawText);
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

export function parseBet365MoneylineText(rawText: string, fixture: Bet365FixtureTarget): Bet365CollectedMarket[] {
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
      } satisfies Bet365CollectedMarket;
    })
    .filter((market): market is Bet365CollectedMarket => Boolean(market));

  const selected: Bet365CollectedMarket[] = [];
  for (const category of ["COM_PA", "SEM_PA"] as const) {
    const market = markets.find((item) => item.paCategory === category);
    if (market) selected.push(market);
  }
  return selected.length ? selected : markets.slice(0, 1);
}

export class Bet365LocalAutomationClient {
  private chromeProcess: ChildProcess | null = null;

  constructor(
    private readonly config: Bet365BookmakerConfig,
    private readonly logger: Logger
  ) {}

  async openCompetition(url: string) {
    const profileDir = path.resolve(this.config.chromeProfileDir);
    await mkdir(profileDir, { recursive: true });
    const chromePath = findChromeExecutable(this.config.chromeExecutablePath);
    if (!chromePath) throw new Error("chrome.exe nao encontrado. Configure BET365_CHROME_EXECUTABLE no .env.");

    if (await waitForDevtools(this.config.debugPort, 1_000)) {
      await this.logger("info", "Chrome da bet365 ja estava aberto; navegando aba atual", { url, debugPort: this.config.debugPort });
      await navigateChromeCurrentTab(url);
      await sleep(this.config.navigationWaitMs);
      return;
    }

    await this.logger("info", "abrindo Chrome normal para bet365", { profileDir, chromePath, url });
    this.chromeProcess = spawn(
      chromePath,
      [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${this.config.debugPort}`,
        `--remote-allow-origins=http://127.0.0.1:${this.config.debugPort}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        "--new-window",
        url
      ],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    this.chromeProcess.unref();
    await new Promise((resolve) => setTimeout(resolve, this.config.navigationWaitMs));
    await waitForDevtools(this.config.debugPort, Math.min(this.config.navigationWaitMs, 5_000));
  }

  async collectEventText(fixture: Bet365FixtureTarget) {
    if (this.config.eventTextFile) {
      const text = await readFile(this.config.eventTextFile, "utf8");
      await this.logger("info", "texto do evento bet365 lido de arquivo", { file: this.config.eventTextFile, fixtureId: fixture.id });
      return { rawText: text, sourceUrl: this.config.competitionUrl ?? this.config.baseUrl } satisfies Bet365CollectedPage;
    }

    return this.collectEventTextWithLocalAutomation(fixture);
  }

  async collectEventTextFromUrl(sourceUrl: string, fixture: Bet365FixtureTarget) {
    await this.logger("info", "abrindo evento bet365 por URL salva", { fixtureId: fixture.id, sourceUrl });
    await navigateChromeCurrentTab(sourceUrl);
    await sleep(this.config.eventWaitMs);
    const rawText = await this.readParsableEventText(fixture);
    if (!this.looksLikeEventText(rawText, fixture)) {
      throw new Error(`URL salva da Bet365 nao retornou odds para ${fixture.homeTeam ?? "HOME"} x ${fixture.awayTeam ?? "AWAY"}.`);
    }

    const currentUrl = await this.readCurrentEventUrl();
    await this.logger("info", "evento da bet365 aberto por URL salva", { fixtureId: fixture.id, sourceUrl: currentUrl });
    return { rawText, sourceUrl: currentUrl } satisfies Bet365CollectedPage;
  }

  private async collectEventTextWithLocalAutomation(fixture: Bet365FixtureTarget) {
    const searchTerms = [fixture.homeTeam, fixture.awayTeam].filter((team): team is string => Boolean(team?.trim()));
    if (!searchTerms.length) throw new Error("Fixture da Bet365 sem mandante/visitante para buscar.");

    let lastText = "";
    for (const term of searchTerms) {
      await this.logger("info", "buscando jogo da bet365 com Ctrl+F", { fixtureId: fixture.id, term });
      await activateChromeWindow();
      await setClipboardText(term);
      await sendKeys("^f", 400);
      await sendKeys("^v", 800);

      const highlight = await clickChromeFindHighlight();
      if (!highlight) {
        await sendKeys("{ESC}", 400);
        await this.logger("warn", "busca da bet365 nao encontrou destaque visual", { fixtureId: fixture.id, term });
        continue;
      }

      await this.logger("info", "destaque visual da bet365 encontrado", { fixtureId: fixture.id, term, highlight });
      await sleep(this.config.eventWaitMs);
      const copiedAfterClick = await this.readParsableEventText(fixture);
      lastText = copiedAfterClick;
      if (this.looksLikeEventText(copiedAfterClick, fixture)) {
        const sourceUrl = await this.readCurrentEventUrl();
        await this.logger("info", "evento da bet365 aberto por clique visual", { fixtureId: fixture.id, highlight, sourceUrl });
        return { rawText: copiedAfterClick, sourceUrl } satisfies Bet365CollectedPage;
      }

      await this.logger("warn", "busca da bet365 nao abriu mercado Resultado Final", {
        fixtureId: fixture.id,
        term,
        copiedChars: copiedAfterClick.length
      });
    }

    throw new Error(
      `Bet365 nao retornou texto de evento com mercado Full Time Result/Resultado Final para ${fixture.homeTeam ?? "HOME"} x ${fixture.awayTeam ?? "AWAY"}. Texto capturado: ${lastText.slice(0, 200)}`
    );
  }

  async resetCompetition(url: string) {
    await this.closeCurrentTab();
    await sleep(1_000);
    await this.openCompetition(url);
  }

  private async closeCurrentTab() {
    try {
      await activateChromeWindow();
      await sendKeys("^w", 800);
      await this.logger("info", "aba atual da bet365 fechada");
    } catch (error) {
      await this.logger("warn", "nao consegui fechar aba atual da bet365", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async copyVisiblePageText() {
    await activateChromeWindow();
    await sendKeys("^a", 500);
    await sendKeys("^c", 900);
    const text = await readClipboardText();
    return text.replace(/\r\n/g, "\n").trim();
  }

  private async readVisibleEventText() {
    try {
      const text = await readVisibleTextFromDevtools(this.config.debugPort);
      if (text.trim()) return text.replace(/\r\n/g, "\n").trim();
    } catch (error) {
      await this.logger("warn", "leitura via DevTools falhou; tentando clipboard", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return this.copyVisiblePageText();
  }

  private async readCurrentEventUrl() {
    try {
      const currentUrl = (await readCurrentUrlFromDevtools(this.config.debugPort)).trim();
      if (currentUrl) return currentUrl;
    } catch (error) {
      await this.logger("warn", "nao consegui ler URL atual da bet365 via DevTools", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return this.config.competitionUrl ?? this.config.baseUrl;
  }

  private async readParsableEventText(fixture: Bet365FixtureTarget, retries = 3) {
    let lastText = "";
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const text = await this.readVisibleEventText();
      lastText = text;
      const markets = parseBet365MoneylineText(text, fixture);
      if (markets.length) return text;

      await this.logger("warn", "texto da bet365 lido, mas parser ainda nao encontrou odds", {
        fixtureId: fixture.id,
        attempt,
        copiedChars: text.length,
        preview: cleanLines(text).slice(0, 20).join(" | ")
      });
      await sleep(1_000);
    }

    return lastText;
  }

  private looksLikeEventText(text: string, fixture: Bet365FixtureTarget) {
    return parseBet365MoneylineText(text, fixture).length > 0;
  }

  async stop() {
    if (!this.chromeProcess) return;
    await this.logger("info", "encerrando tentativa bet365");
    this.chromeProcess.kill();
    this.chromeProcess = null;
  }
}

export function buildBet365CollectedEvent(fixture: Bet365FixtureTarget, sourceUrl: string, rawText: string): Bet365CollectedEvent {
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

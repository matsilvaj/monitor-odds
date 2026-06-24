import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { clickFindHighlight } from "./screen-helper.js";
import type { Logger } from "./types.js";

const execFileAsync = promisify(execFile);

export type Bet365ChromeConfig = {
  baseUrl: string;
  chromeProfileDir: string;
  chromeExecutablePath?: string;
  debugPort: number;
  navigationWaitMs: number;
  eventWaitMs: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function findChromeExecutable(configuredPath: string | undefined) {
  const candidates = [
    configuredPath,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => existsSync(candidate));
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

export class ChromeClient {
  private chromeProcess: ChildProcess | null = null;

  constructor(
    private readonly config: Bet365ChromeConfig,
    private readonly logger?: Logger
  ) {}

  async ensureOpen(competitionUrl: string) {
    const profileDir = path.resolve(this.config.chromeProfileDir);
    await mkdir(profileDir, { recursive: true });
    const chromePath = findChromeExecutable(this.config.chromeExecutablePath);
    if (!chromePath) throw new Error("chrome.exe nao encontrado. Configure BET365_CHROME_EXECUTABLE no .env.");

    if (await waitForDevtools(this.config.debugPort, 1_000)) {
      await this.logger?.("info", "Chrome da bet365 ja estava aberto; navegando aba atual", { url: competitionUrl, debugPort: this.config.debugPort });
      await this.navigateTo(competitionUrl);
      await sleep(this.config.navigationWaitMs);
      return;
    }

    await this.logger?.("info", "abrindo Chrome normal para bet365", { profileDir, chromePath, url: competitionUrl });
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
        competitionUrl
      ],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    this.chromeProcess.unref();
    await sleep(this.config.navigationWaitMs);
    await waitForDevtools(this.config.debugPort, Math.min(this.config.navigationWaitMs, 5_000));
  }

  async reset(competitionUrl: string) {
    await this.closeCurrentTab();
    await sleep(1_000);
    await this.ensureOpen(competitionUrl);
  }

  async stop() {
    if (!this.chromeProcess) return;
    await this.logger?.("info", "encerrando tentativa bet365");
    this.chromeProcess.kill();
    this.chromeProcess = null;
  }

  async navigateTo(url: string) {
    await activateChromeWindow();
    await setClipboardText(url);
    await sendKeys("^l", 300);
    await sendKeys("^v", 300);
    await sendKeys("{ENTER}", 500);
  }

  async currentUrl() {
    return (await evaluateDevtoolsText(this.config.debugPort, "window.location.href")).trim();
  }

  async readVisibleText() {
    try {
      const text = await readVisibleTextFromDevtools(this.config.debugPort);
      if (text.trim()) return text.replace(/\r\n/g, "\n").trim();
    } catch (error) {
      await this.logger?.("warn", "leitura via DevTools falhou; tentando clipboard", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return this.copyVisiblePageText();
  }

  async findAndClickTerm(term: string) {
    await activateChromeWindow();
    await setClipboardText(term);
    await sendKeys("^f", 400);
    await sendKeys("^v", 800);

    const result = await clickFindHighlight();
    if (!result.clicked) {
      await sendKeys("{ESC}", 400);
      return result;
    }
    return result;
  }

  private async closeCurrentTab() {
    try {
      await activateChromeWindow();
      await sendKeys("^w", 800);
      await this.logger?.("info", "aba atual da bet365 fechada");
    } catch (error) {
      await this.logger?.("warn", "nao consegui fechar aba atual da bet365", {
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
}


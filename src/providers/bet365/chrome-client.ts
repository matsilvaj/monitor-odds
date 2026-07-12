import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Bet365NetworkClient, type Bet365ClickTarget, type Bet365NetworkCapture } from "./network-client.js";
import type { Logger } from "./types.js";

export type Bet365ChromeConfig = {
  baseUrl: string;
  chromeProfileDir: string;
  chromeExecutablePath?: string;
  debugPort: number;
  navigationWaitMs: number;
  eventWaitMs: number;
};

export type Bet365ChromeTabSession = {
  collectEventOdds(url: string, target?: Bet365ClickTarget | null, clickEvent?: boolean, forceNavigate?: boolean): Promise<Bet365NetworkCapture>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForDevtools(port: number, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return true;
    } catch {
      // Chrome ainda esta inicializando.
    }
    await sleep(350);
  }
  return false;
}

export class ChromeClient {
  private chromeProcess: ChildProcess | null = null;
  private readonly networkClient: Bet365NetworkClient;

  constructor(
    private readonly config: Bet365ChromeConfig,
    private readonly logger?: Logger
  ) {
    this.networkClient = new Bet365NetworkClient(logger);
  }

  async ensureOpen(competitionUrl: string) {
    const profileDir = path.resolve(this.config.chromeProfileDir);
    await mkdir(profileDir, { recursive: true });
    const chromePath = findChromeExecutable(this.config.chromeExecutablePath);
    if (!chromePath) throw new Error("chrome.exe nao encontrado. Configure BET365_CHROME_EXECUTABLE no .env.");
    const initialUrl = this.config.baseUrl || competitionUrl;

    if (!(await waitForDevtools(this.config.debugPort, 1_000))) {
      await this.logger?.("info", "abrindo Chrome normal para bet365", {
        profileDir,
        chromePath,
        url: initialUrl,
        requestedUrl: competitionUrl,
        debugPort: this.config.debugPort
      });
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
          initialUrl
        ],
        {
          stdio: "ignore"
        }
      );
      await sleep(this.config.navigationWaitMs);
    }

    if (!(await waitForDevtools(this.config.debugPort, Math.max(this.config.navigationWaitMs, 5_000)))) {
      throw new Error(`Chrome CDP nao respondeu na porta ${this.config.debugPort}.`);
    }

    await this.networkClient.connectToExistingChrome(this.config.debugPort);
  }

  async collectEventOdds(url: string, target?: Bet365ClickTarget | null, clickEvent = Boolean(target), forceNavigate = false): Promise<Bet365NetworkCapture> {
    await this.ensureOpen(this.config.baseUrl);
    return this.networkClient.collectEventOdds(url, this.config.eventWaitMs, target, clickEvent, forceNavigate);
  }

  async collectEventOddsInNewTab(
    url: string,
    target?: Bet365ClickTarget | null,
    clickEvent = Boolean(target),
    forceNavigate = false
  ): Promise<Bet365NetworkCapture> {
    await this.ensureOpen(this.config.baseUrl);
    return this.networkClient.collectEventOddsInNewTab(url, this.config.eventWaitMs, target, clickEvent, forceNavigate);
  }

  async withNewTab<T>(worker: (tab: Bet365ChromeTabSession) => Promise<T>): Promise<T> {
    return this.networkClient.withNewTab((tab) =>
      worker({
        collectEventOdds: (url, target, clickEvent = Boolean(target), forceNavigate = false) =>
          tab.collectEventOdds(url, this.config.eventWaitMs, target, clickEvent, forceNavigate)
      })
    );
  }

  async navigateTo(url: string) {
    await this.ensureOpen(url);
    await this.networkClient.navigate(url, this.config.navigationWaitMs);
  }

  async currentUrl() {
    return this.networkClient.currentUrl();
  }

  async reset(competitionUrl: string) {
    await this.navigateTo(competitionUrl);
  }

  async stop() {
    await this.networkClient.close();
    if (!this.chromeProcess) return;
    await this.logger?.("info", "encerrando tentativa bet365");
    this.chromeProcess.kill();
    this.chromeProcess = null;
  }
}

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vanillaPuppeteer from "puppeteer";
import { addExtra } from "puppeteer-extra";
import type { VanillaPuppeteer } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Cookie, HTTPRequest, Protocol } from "puppeteer";

const puppeteer = addExtra(vanillaPuppeteer as unknown as VanillaPuppeteer);
puppeteer.use(StealthPlugin());

const SESSION_URL = process.env.BET365_SESSION_URL ?? "https://www.bet365.bet.br/";
const TOKEN_FILE = path.resolve(process.cwd(), "bet365-token.json");
const TARGET_ENDPOINTS = ["searchapi/query", "splashcontentapi", "matchbettingcontentapi"];
const SPLASH_CONTENT_PATH = "/splashcontentapi/soccertab?lid=33&zid=0&pd=%23AS%23B1%23K%5E5%23&cid=28&cgid=0&ctid=28";
const SESSION_ORIGIN = new URL(SESSION_URL).origin;

type Bet365SessionToken = {
  xNetSyncTerm: string;
  cookie: string;
  capturedFrom: string;
  capturedAt: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTargetRequest(request: HTTPRequest) {
  const url = request.url().toLowerCase();
  return TARGET_ENDPOINTS.some((endpoint) => url.includes(endpoint));
}

function isBet365RequestUrl(requestUrl: string) {
  try {
    return new URL(requestUrl).origin === SESSION_ORIGIN;
  } catch {
    return false;
  }
}

function headerValue(headers: Record<string, string>, name: string) {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1] ?? null;
}

function cdpHeaderValue(headers: Protocol.Network.Headers, name: string) {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  const value = entry?.[1];
  return typeof value === "string" ? value : null;
}

function formatCookies(cookies: Cookie[]) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export async function captureBet365Session() {
  let browser: Browser | null = null;

  try {
    const activeBrowser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    browser = activeBrowser;

    const page = await activeBrowser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
    });

    const tokenPromise = new Promise<Bet365SessionToken>((resolve, reject) => {
      const seenTargetRequests: string[] = [];
      const requestUrls = new Map<string, string>();
      let settled = false;

      async function resolveToken(xNetSyncTerm: string, capturedFrom: string) {
        settled = true;
        clearTimeout(timeout);
        const cookies = await page.cookies();
        resolve({
          xNetSyncTerm,
          cookie: formatCookies(cookies),
          capturedFrom,
          capturedAt: new Date().toISOString()
        });
      }

      const timeout = setTimeout(() => {
        const seen = seenTargetRequests.length
          ? ` Endpoints vistos sem token: ${seenTargetRequests.slice(-5).join(" | ")}`
          : " Nenhum endpoint-alvo foi visto.";
        settled = true;
        reject(new Error(`Bet365 token not found after listening for ${TARGET_ENDPOINTS.join(", ")}.${seen}`));
      }, 90_000);

      page.on("request", async (request) => {
        try {
          if (settled || !isBet365RequestUrl(request.url())) return;

          if (isTargetRequest(request)) {
            seenTargetRequests.push(request.url());
            console.log(`[bet365-session] endpoint visto: ${request.url()}`);
          }

          const xNetSyncTerm = headerValue(request.headers(), "x-net-sync-term");
          if (!xNetSyncTerm) return;

          console.log(`[bet365-session] token capturado via page.request: ${request.url()}`);
          await resolveToken(xNetSyncTerm, request.url());
        } catch (error) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });

      cdp.on("Network.requestWillBeSent", (event) => {
        requestUrls.set(event.requestId, event.request.url);
      });

      cdp.on("Network.requestWillBeSentExtraInfo", async (event) => {
        try {
          if (settled) return;

          const requestUrl = requestUrls.get(event.requestId) ?? "";
          if (!requestUrl || !isBet365RequestUrl(requestUrl)) return;

          const xNetSyncTerm = cdpHeaderValue(event.headers, "x-net-sync-term");
          if (!xNetSyncTerm) {
            if (TARGET_ENDPOINTS.some((endpoint) => requestUrl.toLowerCase().includes(endpoint))) {
              const headerKeys = Object.keys(event.headers).join(", ");
              console.log(`[bet365-session] CDP sem x-net-sync-term em ${requestUrl}. headers: ${headerKeys}`);
            }
            return;
          }

          console.log(`[bet365-session] token capturado via CDP: ${requestUrl}`);
          await resolveToken(xNetSyncTerm, requestUrl);
        } catch (error) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
    });

    console.log(`[bet365-session] abrindo ${SESSION_URL}`);
    await page.goto(SESSION_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

    try {
      await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 15_000 });
    } catch {
      await sleep(5_000);
    }

    console.log(`[bet365-session] pagina carregada: ${page.url()} | ${await page.title()}`);

    await page.evaluate((pathToFetch) => {
      return fetch(pathToFetch, {
        credentials: "include",
        headers: {
          accept: "*/*",
          "cache-control": "no-cache",
          "x-codex-session-probe": "1",
          pragma: "no-cache"
        }
      }).catch(() => null);
    }, SPLASH_CONTENT_PATH);

    const token = await tokenPromise;
    await writeFile(TOKEN_FILE, `${JSON.stringify(token, null, 2)}\n`, "utf8");
    console.log(`[bet365-session] token salvo em ${TOKEN_FILE}`);
    return token;
  } catch (error) {
    console.error("[bet365-session] falha ao gerar token", error);
    throw error;
  } finally {
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  captureBet365Session().catch(() => {
    process.exitCode = 1;
  });
}

import { join } from "node:path";
import { pathToFileURL } from "node:url";

type GotScrapingModule = {
  gotScraping: (options: Record<string, unknown>) => Promise<{
    body: unknown;
    statusCode: number;
  }>;
};

let modulePromise: Promise<GotScrapingModule> | null = null;

export async function loadGotScraping() {
  modulePromise ??= import(pathToFileURL(join(process.cwd(), "node_modules", "got-scraping", "dist", "index.js")).href) as Promise<GotScrapingModule>;
  const module = await modulePromise;
  return module.gotScraping;
}

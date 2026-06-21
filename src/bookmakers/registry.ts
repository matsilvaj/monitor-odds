import pMap from "p-map";
import { BOOKMAKERS } from "../config/bookmakers.js";
import { createAltenarCollector } from "../services/altenar-collector.js";
import { createApostabetCollector } from "../services/apostabet-collector.js";
import { createBet7kCollector } from "../services/bet7k-collector.js";
import { createBetanoCollector } from "../services/betano-collector.js";
import { createBetboomCollector } from "../services/betboom-collector.js";
import { createBetesporteCollector } from "../services/betesporte-collector.js";
import { createBetfastCollector } from "../services/betfast-collector.js";
import { createBetfairCollector } from "../services/betfair-collector.js";
import { createBetmgmCollector } from "../services/betmgm-collector.js";
import { createBetnacionalCollector } from "../services/betnacional-collector.js";
import { createCasaDeApostasCollector } from "../services/casadeapostas-collector.js";
import { createKtoCollector } from "../services/kto-collector.js";
import { createNovibetCollector } from "../services/novibet-collector.js";
import { createSegurobetCollector } from "../services/segurobet-collector.js";
import { createSportingbetCollector } from "../services/sportingbet-collector.js";
import { createSportybetCollector } from "../services/sportybet-collector.js";
import { createSuperbetCollector } from "../services/superbet-collector.js";
import { createTradeballCollector } from "../services/tradeball-collector.js";
import { createVaidebetCollector } from "../services/vaidebet-collector.js";
import { createVersusbetCollector } from "../services/versusbet-collector.js";
import { cleanupStartedFixtures, formatStartedFixtureCleanupSummary } from "../services/fixture-cleanup.js";
import {
  formatBookmakerResultLines,
  formatBookmakerStartLine,
  formatFixtureReportLines,
  getBookmakerOddsReport,
  getFixtureReport
} from "../services/sync-report.js";
import { errorMessage } from "../utils/errors.js";
import type { BookmakerCollector, BookmakerCollectorResult } from "./types.js";

export const BOOKMAKER_COLLECTORS: BookmakerCollector[] = BOOKMAKERS.filter((bookmaker) => bookmaker.enabled).map((bookmaker) => {
  if (bookmaker.provider === "altenar") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createAltenarCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "sportingbet") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createSportingbetCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "sportybet") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createSportybetCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "superbet") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createSuperbetCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "novibet") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createNovibetCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "betano") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBetanoCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "betboom") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBetboomCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "tradeball") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createTradeballCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "versusbet") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createVersusbetCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "apostabet") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createApostabetCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "bet7k") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBet7kCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "betfast") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBetfastCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "kto") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createKtoCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "betfair") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBetfairCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "betesporte") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBetesporteCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "betnacional") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBetnacionalCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "betmgm") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBetmgmCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "casadeapostas") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createCasaDeApostasCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "segurobet") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createSegurobetCollector(bookmaker)
    };
  }

  return {
    slug: bookmaker.slug,
    name: bookmaker.name,
    collect: createVaidebetCollector(bookmaker)
  };
});

export type CollectAllBookmakersOptions = {
  concurrency?: number;
  logProgress?: boolean;
  trigger?: "manual" | "sync" | "watch";
  cleanupStarted?: boolean;
};

const BROWSER_COLLECTOR_SLUGS = new Set<string>();

async function collectBookmakers(bookmakers: BookmakerCollector[], options: CollectAllBookmakersOptions = {}) {
  const concurrency = options.concurrency ?? 3;
  const logProgress = options.logProgress ?? true;
  const trigger = options.trigger ?? "sync";
  if (options.cleanupStarted ?? true) {
    const cleanup = await cleanupStartedFixtures();
    if (logProgress) {
      console.log(formatStartedFixtureCleanupSummary(cleanup));
    }
  }

  const fixtureReport = await getFixtureReport();

  if (logProgress) {
    for (const line of formatFixtureReportLines(fixtureReport)) console.log(line);
  }

  const printBookmakerResult = async (result: BookmakerCollectorResult) => {
    if (!logProgress) return;

    try {
      const report = await getBookmakerOddsReport(result.bookmaker, fixtureReport);
      for (const line of formatBookmakerResultLines(result, report, fixtureReport)) console.log(line);
    } catch (error) {
      console.warn(`[${result.bookmaker}] Coleta finalizada, mas não consegui montar o resumo do banco: ${errorMessage(error)}`);
    }
  };

  const collectOne = async (bookmaker: BookmakerCollector) => {
    const start = performance.now();
    if (logProgress) {
      console.log(formatBookmakerStartLine(bookmaker.slug, fixtureReport));
    }

    try {
      const summary = await bookmaker.collect({ logToConsole: logProgress, manualFallback: false, trigger });
      const durationMs = Math.round(performance.now() - start);
      const result = { bookmaker: bookmaker.slug, summary, durationMs } satisfies BookmakerCollectorResult;
      await printBookmakerResult(result);
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const result = { bookmaker: bookmaker.slug, summary: null, error: errorMessage(error), durationMs } satisfies BookmakerCollectorResult;
      await printBookmakerResult(result);
      return result;
    }
  };

  return pMap(bookmakers, collectOne, { concurrency });
}

export async function collectAllBookmakers(options: CollectAllBookmakersOptions = {}) {
  const concurrency = options.concurrency ?? 3;
  const logProgress = options.logProgress ?? true;
  const trigger = options.trigger ?? "sync";
  const cleanup = await cleanupStartedFixtures();
  if (logProgress) {
    console.log(formatStartedFixtureCleanupSummary(cleanup));
  }

  const fixtureReport = await getFixtureReport();

  if (logProgress) {
    for (const line of formatFixtureReportLines(fixtureReport)) console.log(line);
  }

  const printBookmakerResult = async (result: BookmakerCollectorResult) => {
    if (!logProgress) return;

    try {
      const report = await getBookmakerOddsReport(result.bookmaker, fixtureReport);
      for (const line of formatBookmakerResultLines(result, report, fixtureReport)) console.log(line);
    } catch (error) {
      console.warn(`[${result.bookmaker}] Coleta finalizada, mas não consegui montar o resumo do banco: ${errorMessage(error)}`);
    }
  };

  const collectOne = async (bookmaker: BookmakerCollector) => {
    const start = performance.now();
    if (logProgress) {
      console.log(formatBookmakerStartLine(bookmaker.slug, fixtureReport));
    }

    try {
      const summary = await bookmaker.collect({ logToConsole: logProgress, manualFallback: false, trigger });
      const durationMs = Math.round(performance.now() - start);
      const result = { bookmaker: bookmaker.slug, summary, durationMs } satisfies BookmakerCollectorResult;
      await printBookmakerResult(result);
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const result = { bookmaker: bookmaker.slug, summary: null, error: errorMessage(error), durationMs } satisfies BookmakerCollectorResult;
      await printBookmakerResult(result);
      return result;
    }
  };

  const browserCollectorSlugs = BROWSER_COLLECTOR_SLUGS;
  const fastCollectors = BOOKMAKER_COLLECTORS.filter((bookmaker) => !browserCollectorSlugs.has(bookmaker.slug));
  const slowCollectors = BOOKMAKER_COLLECTORS.filter((bookmaker) => browserCollectorSlugs.has(bookmaker.slug));

  if (logProgress && slowCollectors.length) {
    console.log("[sync] Casas com Chrome real iniciadas em uma raia própria; as outras casas continuam em paralelo.");
  }

  const fastResults = await pMap(fastCollectors, collectOne, { concurrency });
  const slowResults: BookmakerCollectorResult[] = [];
  for (const bookmaker of slowCollectors) {
    slowResults.push(await collectOne(bookmaker));
  }

  return [...fastResults, ...slowResults];
}

export async function collectFastBookmakers(options: CollectAllBookmakersOptions = {}) {
  const fastCollectors = BOOKMAKER_COLLECTORS.filter((bookmaker) => !BROWSER_COLLECTOR_SLUGS.has(bookmaker.slug));
  return collectBookmakers(fastCollectors, options);
}

export async function collectBookmakerBySlug(slug: string, options: CollectAllBookmakersOptions = {}) {
  const bookmaker = BOOKMAKER_COLLECTORS.find((collector) => collector.slug === slug);
  if (!bookmaker) throw new Error(`Bookmaker "${slug}" não encontrada ou desabilitada.`);

  return collectBookmakers([bookmaker], { ...options, concurrency: 1 });
}

export async function collectBrowserBookmakers(options: CollectAllBookmakersOptions = {}) {
  const browserCollectors = BOOKMAKER_COLLECTORS.filter((bookmaker) => BROWSER_COLLECTOR_SLUGS.has(bookmaker.slug));
  if ((options.logProgress ?? true) && browserCollectors.length) {
    console.log("[sync] Casas com Chrome real iniciadas em uma raia própria.");
  }

  return collectBookmakers(browserCollectors, { ...options, concurrency: 1 });
}


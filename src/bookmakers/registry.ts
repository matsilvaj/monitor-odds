import pMap from "p-map";
import { BOOKMAKERS } from "../config/bookmakers.js";
import { createAltenarCollector } from "../services/altenar-collector.js";
import { createApostabetCollector } from "../services/apostabet-collector.js";
import { createBet7kCollector } from "../services/bet7k-collector.js";
import { createBet365Collector } from "../services/bet365-collector.js";
import { createBetanoCollector } from "../services/betano-collector.js";
import { createBetboomCollector } from "../services/betboom-collector.js";
import { createBravobetCollector } from "../services/bravobet-collector.js";
import { createBetesporteCollector } from "../services/betesporte-collector.js";
import { createBetfastCollector } from "../services/betfast-collector.js";
import { createBetfairCollector } from "../services/betfair-collector.js";
import { createBetmgmCollector } from "../services/betmgm-collector.js";
import { createBetnacionalCollector } from "../services/betnacional-collector.js";
import { createCasaDeApostasCollector } from "../services/casadeapostas-collector.js";
import { createKtoCollector } from "../services/kto-collector.js";
import { createLottuCollector } from "../services/lottu-collector.js";
import { createMeridianbetCollector } from "../services/meridianbet-collector.js";
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
  getFixtureReport,
  type FixtureReport
} from "../services/sync-report.js";
import { OddsRepository } from "../db/odds-repository.js";
import { sweepInconsistentOdds } from "../services/odds-consistency.js";
import { errorMessage } from "../utils/errors.js";
import type { BookmakerCollector, BookmakerCollectorResult } from "./types.js";
import type { BookmakerConfig } from "../config/bookmakers.js";

function createBookmakerCollector(bookmaker: BookmakerConfig): BookmakerCollector {
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

  if (bookmaker.provider === "meridianbet") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createMeridianbetCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "bet365") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBet365Collector(bookmaker)
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

  if (bookmaker.provider === "lottu") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createLottuCollector(bookmaker)
    };
  }

  if (bookmaker.provider === "bravobet") {
    return {
      slug: bookmaker.slug,
      name: bookmaker.name,
      collect: createBravobetCollector(bookmaker)
    };
  }

  return {
    slug: bookmaker.slug,
    name: bookmaker.name,
    collect: createVaidebetCollector(bookmaker)
  };
}

export const BOOKMAKER_COLLECTORS: BookmakerCollector[] = BOOKMAKERS.filter((bookmaker) => bookmaker.enabled).map(createBookmakerCollector);

export function findBookmakerCollectorForManualRun(slug: string) {
  const bookmaker = BOOKMAKERS.find((item) => item.slug === slug);
  if (!bookmaker) return null;
  if (!bookmaker.enabled && bookmaker.provider !== "bet365") return null;
  return createBookmakerCollector(bookmaker);
}

export type CollectAllBookmakersOptions = {
  concurrency?: number;
  logProgress?: boolean;
  trigger?: "manual" | "sync" | "watch";
  cleanupStarted?: boolean;
  sharedFixtureReport?: FixtureReport;
  onBookmakerResult?: (slug: string, today: number, tomorrow: number) => void;
};

const BROWSER_COLLECTOR_SLUGS = new Set<string>(["meridianbet", "bet365"]);

// Casas com raia propria no watch por confirmadamente travarem sob contencao das
// demais no mesmo processo. Sportingbet coleta perfeita isolada (11-18s, 0 erros em
// testes repetidos) mas ficou horas congelada rodando junto com as ~22 outras casas
// rapidas — sinal de contencao de CPU/event-loop ou throttling anti-scraping sob uso
// sustentado, nao um defeito no coletor em si. Isolar em processo proprio da a ela o
// mesmo tratamento que bet365/meridianbet ja recebem.
const DEDICATED_LANE_SLUGS = new Set<string>([...BROWSER_COLLECTOR_SLUGS, "sportingbet"]);

// Odds nao vistas neste intervalo saem quando o ciclo coletou normalmente.
const STALE_ODDS_MS = 2 * 60 * 60 * 1000;
// Limite duro: roda mesmo em ciclo falho. Uma casa que quebra em silencio mantinha
// odds de ontem no ar indefinidamente — a sportingbet ficou 18,7h congelada enquanto
// o mercado andava. Preserva o dado numa queda curta, nunca numa longa.
const STALE_ODDS_HARD_LIMIT_MS = 8 * 60 * 60 * 1000;

function summaryNumber(summary: unknown, key: string) {
  if (!summary || typeof summary !== "object") return 0;
  const value = (summary as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A limpeza de odds nao vistas so pode rodar quando o ciclo realmente coletou.
 * Um coletor que falha (Chrome fora do ar, por exemplo) retorna resumo com erro em
 * vez de lancar, e sem esta guarda a casa inteira era apagada do banco depois de 2h
 * de indisponibilidade — perda de dados causada por uma falha de infraestrutura.
 */
function collectedSomething(summary: unknown) {
  if (summaryNumber(summary, "errors") > 0) return false;
  return summaryNumber(summary, "eventsCollected") > 0 || summaryNumber(summary, "oddsUpserted") > 0;
}

/**
 * Ciclo saudavel limpa em 2h; ciclo falho ainda limpa no limite duro. Assim uma queda
 * de infraestrutura nao apaga a casa inteira, mas tambem nao deixa odds velhas no ar.
 */
async function cleanupStaleOdds(slug: string, summary: unknown, logProgress: boolean) {
  const ok = collectedSomething(summary);
  const windowMs = ok ? STALE_ODDS_MS : STALE_ODDS_HARD_LIMIT_MS;
  const threshold = new Date(Date.now() - windowMs).toISOString();

  try {
    const deleted = await OddsRepository.deleteStaleByBookmaker(slug, threshold);
    if (!deleted) return;

    const horas = Math.round(windowMs / 3_600_000);
    const motivo = ok ? `não vistas há mais de ${horas}h` : `ciclo sem coleta e odds paradas há mais de ${horas}h`;
    console.warn(`[${slug}] ${deleted} odd(s) obsoleta(s) removidas (${motivo}).`);
  } catch (error) {
    if (logProgress) console.warn(`[${slug}] Falha ao limpar odds obsoletas: ${errorMessage(error)}`);
  }
}

// Roda so depois que todas as casas do ciclo salvaram, quando ja existe consenso
// suficiente para julgar quem esta fora da media.
async function runConsistencySweep(logProgress: boolean) {
  try {
    await sweepInconsistentOdds({ logProgress });
  } catch (error) {
    console.warn(`[consistencia] Varredura falhou: ${errorMessage(error)}`);
  }
}

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

  const fixtureReport = options.sharedFixtureReport ?? await getFixtureReport();

  if (logProgress && !options.sharedFixtureReport) {
    for (const line of formatFixtureReportLines(fixtureReport)) console.log(line);
  }

  const printBookmakerResult = async (result: BookmakerCollectorResult) => {
    const needsReport = logProgress || !!options.onBookmakerResult;
    if (!needsReport) return;

    try {
      const report = await getBookmakerOddsReport(result.bookmaker, fixtureReport);
      if (logProgress) {
        for (const line of formatBookmakerResultLines(result, report, fixtureReport)) console.log(line);
      }
      if (options.onBookmakerResult) {
        const todayKey = fixtureReport.buckets[0]?.key ?? "";
        const tomorrowKey = fixtureReport.buckets[1]?.key ?? "";
        options.onBookmakerResult(result.bookmaker, report.byDate.get(todayKey)?.games ?? 0, report.byDate.get(tomorrowKey)?.games ?? 0);
      }
    } catch (error) {
      if (logProgress) {
        console.warn(`[${result.bookmaker}] Coleta finalizada, mas não consegui montar o resumo do banco: ${errorMessage(error)}`);
      }
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
      await cleanupStaleOdds(bookmaker.slug, summary, logProgress);
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
    const needsReport = logProgress || !!options.onBookmakerResult;
    if (!needsReport) return;

    try {
      const report = await getBookmakerOddsReport(result.bookmaker, fixtureReport);
      if (logProgress) {
        for (const line of formatBookmakerResultLines(result, report, fixtureReport)) console.log(line);
      }
      if (options.onBookmakerResult) {
        const todayKey = fixtureReport.buckets[0]?.key ?? "";
        const tomorrowKey = fixtureReport.buckets[1]?.key ?? "";
        options.onBookmakerResult(result.bookmaker, report.byDate.get(todayKey)?.games ?? 0, report.byDate.get(tomorrowKey)?.games ?? 0);
      }
    } catch (error) {
      if (logProgress) {
        console.warn(`[${result.bookmaker}] Coleta finalizada, mas não consegui montar o resumo do banco: ${errorMessage(error)}`);
      }
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
      await cleanupStaleOdds(bookmaker.slug, summary, logProgress);
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
  const browserCollectors = BOOKMAKER_COLLECTORS.filter((bookmaker) => browserCollectorSlugs.has(bookmaker.slug));

  if (logProgress && browserCollectors.length) {
    console.log("[sync] Casas com Chrome real iniciadas em raias independentes no inicio do ciclo; casas rapidas seguem em paralelo.");
  }

  const fastResultsPromise = pMap(fastCollectors, collectOne, { concurrency });
  const browserResultsPromise = Promise.all(browserCollectors.map((bookmaker) => collectOne(bookmaker)));
  const [fastResults, browserResults] = await Promise.all([fastResultsPromise, browserResultsPromise]);

  await runConsistencySweep(logProgress);

  return [...fastResults, ...browserResults];
}

// Concorrência máxima por provider dentro do grupo (providers únicos usam 1 por padrão)
const FAST_PROVIDER_CONCURRENCY: Partial<Record<string, number>> = {
  altenar: 3, // 7 casas, mesma API Altenar (integrações distintas, seguro em 3)
  bet7k: 1,   // 2 casas (bet7k + betvip), mesmo backend fssb.io
};

export async function collectFastBookmakers(options: CollectAllBookmakersOptions = {}) {
  const logProgress = options.logProgress ?? true;
  const fastCollectors = BOOKMAKER_COLLECTORS.filter((bookmaker) => !DEDICATED_LANE_SLUGS.has(bookmaker.slug));

  // Cleanup e fixture report uma única vez para todos os grupos
  if (options.cleanupStarted ?? true) {
    const cleanup = await cleanupStartedFixtures();
    if (logProgress) console.log(formatStartedFixtureCleanupSummary(cleanup));
  }
  const sharedFixtureReport = await getFixtureReport();
  if (logProgress) {
    for (const line of formatFixtureReportLines(sharedFixtureReport)) console.log(line);
  }

  // Agrupa por provider — mesmo provider = mesmo backend = mesmo rate limit
  const groups = new Map<string, BookmakerCollector[]>();
  for (const collector of fastCollectors) {
    const providerKey = BOOKMAKERS.find((b) => b.slug === collector.slug)?.provider ?? collector.slug;
    const existing = groups.get(providerKey) ?? [];
    existing.push(collector);
    groups.set(providerKey, existing);
  }

  // Todos os grupos rodam em paralelo (APIs distintas = sem conflito)
  const groupResults = await Promise.all(
    [...groups.entries()].map(([provider, group]) =>
      collectBookmakers(group, {
        ...options,
        concurrency: FAST_PROVIDER_CONCURRENCY[provider] ?? 1,
        cleanupStarted: false,
        sharedFixtureReport,
      })
    )
  );

  // No modo watch quem dispara a varredura e o supervisor, em intervalo proprio:
  // amarrar ao fim da raia rapida deixava odds de bet365/meridianbet um ciclo inteiro
  // no ar, porque elas gravam em processos separados com timing independente.
  return groupResults.flat();
}

export async function collectBookmakerBySlug(slug: string, options: CollectAllBookmakersOptions = {}) {
  const bookmaker = BOOKMAKER_COLLECTORS.find((collector) => collector.slug === slug);
  if (!bookmaker) throw new Error(`Bookmaker "${slug}" não encontrada ou desabilitada.`);

  return collectBookmakers([bookmaker], { ...options, concurrency: 1 });
}

export async function collectBrowserBookmakers(options: CollectAllBookmakersOptions = {}) {
  const browserCollectors = BOOKMAKER_COLLECTORS.filter((bookmaker) => BROWSER_COLLECTOR_SLUGS.has(bookmaker.slug));
  if ((options.logProgress ?? true) && browserCollectors.length) {
    console.log("[sync] Casas com Chrome real iniciadas em raias independentes.");
  }

  return collectBookmakers(browserCollectors, { ...options, concurrency: Math.max(browserCollectors.length, 1) });
}


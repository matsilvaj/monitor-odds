import pMap from "p-map";
import { BOOKMAKERS } from "../config/bookmakers.js";
import { createAltenarCollector } from "../services/altenar-collector.js";
import { createBetanoCollector } from "../services/betano-collector.js";
import { createBetesporteCollector } from "../services/betesporte-collector.js";
import { createBetfairCollector } from "../services/betfair-collector.js";
import { createBetmgmCollector } from "../services/betmgm-collector.js";
import { createBetnacionalCollector } from "../services/betnacional-collector.js";
import { createCasaDeApostasCollector } from "../services/casadeapostas-collector.js";
import { createNovibetCollector } from "../services/novibet-collector.js";
import { createSportingbetCollector } from "../services/sportingbet-collector.js";
import { createSportybetCollector } from "../services/sportybet-collector.js";
import { createSuperbetCollector } from "../services/superbet-collector.js";
import { createVaidebetCollector } from "../services/vaidebet-collector.js";
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

  return {
    slug: bookmaker.slug,
    name: bookmaker.name,
    collect: createVaidebetCollector(bookmaker)
  };
});

export type CollectAllBookmakersOptions = {
  concurrency?: number;
  logProgress?: boolean;
};

export async function collectAllBookmakers(options: CollectAllBookmakersOptions = {}) {
  const concurrency = options.concurrency ?? 2;
  const logProgress = options.logProgress ?? true;

  return pMap(
    BOOKMAKER_COLLECTORS,
    async (bookmaker) => {
      const start = performance.now();
      if (logProgress) {
        console.log(`[sync] coletando ${bookmaker.slug}...`);
      }

      try {
        const summary = await bookmaker.collect();
        const durationMs = Math.round(performance.now() - start);

        if (logProgress) {
          console.log(`[sync] ${bookmaker.slug} concluida em ${durationMs}ms`);
        }

        return { bookmaker: bookmaker.slug, summary, durationMs } satisfies BookmakerCollectorResult;
      } catch (error) {
        const durationMs = Math.round(performance.now() - start);
        console.error(`[sync] ${bookmaker.slug} falhou apos ${durationMs}ms:`, error);
        return { bookmaker: bookmaker.slug, summary: null, error: errorMessage(error), durationMs } satisfies BookmakerCollectorResult;
      }
    },
    { concurrency }
  );
}

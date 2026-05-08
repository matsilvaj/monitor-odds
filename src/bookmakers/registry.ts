import { BOOKMAKERS } from "../config/bookmakers.js";
import { createAltenarCollector } from "../services/altenar-collector.js";
import { createSportingbetCollector } from "../services/sportingbet-collector.js";
import { createSportybetCollector } from "../services/sportybet-collector.js";
import { createSuperbetCollector } from "../services/superbet-collector.js";
import { createVaidebetCollector } from "../services/vaidebet-collector.js";
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

  return {
    slug: bookmaker.slug,
    name: bookmaker.name,
    collect: createVaidebetCollector(bookmaker)
  };
});

export async function collectAllBookmakers() {
  const results: BookmakerCollectorResult[] = [];

  for (const bookmaker of BOOKMAKER_COLLECTORS) {
    const summary = await bookmaker.collect();
    results.push({ bookmaker: bookmaker.slug, summary });
  }

  return results;
}

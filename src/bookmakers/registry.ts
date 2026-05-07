import { collectEsportiva } from "../services/esportiva-collector.js";
import type { BookmakerCollector, BookmakerCollectorResult } from "./types.js";

export const BOOKMAKER_COLLECTORS: BookmakerCollector[] = [
  {
    slug: "esportiva",
    name: "Esportiva",
    collect: collectEsportiva
  }
];

export async function collectAllBookmakers() {
  const results: BookmakerCollectorResult[] = [];

  for (const bookmaker of BOOKMAKER_COLLECTORS) {
    const summary = await bookmaker.collect();
    results.push({ bookmaker: bookmaker.slug, summary });
  }

  return results;
}

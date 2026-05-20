import { supabase } from "./supabase.js";
import { errorMessage } from "../utils/errors.js";

const DEFAULT_BATCH_SIZE = 50;
const DELETE_FIXTURE_BATCH_SIZE = 10;
const DB_RETRY_ATTEMPTS = 3;
const DB_RETRY_BASE_DELAY_MS = 500;

export type BookmakerLinkRow = {
  bookmaker_slug: string;
  external_event_id: string | number;
  fixture_id: string;
  bookmaker_event_name: string;
  bookmaker_home_team: string | null;
  bookmaker_away_team: string | null;
  normalized_bookmaker_home_team: string | null;
  normalized_bookmaker_away_team: string | null;
  starts_at: string;
  match_confidence_score: number;
  source_url: string | null;
  raw: unknown;
  updated_at: string;
};

export type OddRow = {
  fixture_id: string;
  bookmaker_slug: string;
  market_code: string;
  market_name: string;
  selection: string;
  price: number;
  pa_category: string;
  confidence_score: number;
  raw_market_name: string | null;
  raw_label: string | null;
  raw_odd_type: string | null;
  source_odd_id: string | number;
  raw: unknown;
  updated_at: string;
};

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStatementTimeout(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "57014" || /statement timeout/i.test(errorMessage(error));
}

async function withStatementTimeoutRetry(label: string, operation: () => Promise<{ error: unknown }>) {
  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt += 1) {
    const { error } = await operation();
    if (!error) return;

    if (!isStatementTimeout(error) || attempt === DB_RETRY_ATTEMPTS) {
      throw error;
    }

    const delayMs = DB_RETRY_BASE_DELAY_MS * attempt;
    console.warn(`[db] ${label} cancelado por timeout; tentando novamente (${attempt + 1}/${DB_RETRY_ATTEMPTS})...`);
    await sleep(delayMs);
  }
}

export class OddsRepository {
  static async saveAll(
    bookmakerSlug: string,
    links: BookmakerLinkRow[],
    odds: OddRow[],
    options: { marketCodes?: string[]; cleanupFixtureIds?: string[] } = {}
  ) {
    const saveStartedAt = new Date().toISOString();
    const fixtureIds = [...new Set(options.cleanupFixtureIds?.length ? options.cleanupFixtureIds : links.map((link) => link.fixture_id))];
    const marketCodes = options.marketCodes?.length ? options.marketCodes : ["1X2"];
    const linksToSave = links.map((link) => ({ ...link, updated_at: saveStartedAt }));
    const oddsToSave = odds.map((odd) => ({ ...odd, updated_at: saveStartedAt }));

    for (const linkBatch of chunks(linksToSave, DEFAULT_BATCH_SIZE)) {
      await withStatementTimeoutRetry("upsert de links de eventos", async () =>
        await supabase.from("bookmaker_event_links").upsert(linkBatch, {
          onConflict: "bookmaker_slug,external_event_id"
        })
      );
    }

    const uniqueOdds = [
      ...new Map(
        oddsToSave.map((row) => [`${row.fixture_id}:${row.bookmaker_slug}:${row.market_code}:${row.selection}:${row.pa_category}:${row.source_odd_id}`, row])
      ).values()
    ];

    for (const oddBatch of chunks(uniqueOdds, DEFAULT_BATCH_SIZE)) {
      await withStatementTimeoutRetry("upsert de odds", async () =>
        await supabase.from("odds").upsert(oddBatch, {
          onConflict: "fixture_id,bookmaker_slug,market_code,selection,pa_category,source_odd_id"
        })
      );
    }

    if (fixtureIds.length) {
      for (const fixtureIdBatch of chunks(fixtureIds, DELETE_FIXTURE_BATCH_SIZE)) {
        await withStatementTimeoutRetry("limpeza de odds antigas", async () =>
          await supabase
            .from("odds")
            .delete()
            .eq("bookmaker_slug", bookmakerSlug)
            .in("market_code", marketCodes)
            .in("fixture_id", fixtureIdBatch)
            .lt("updated_at", saveStartedAt)
        );

        await withStatementTimeoutRetry("limpeza de links antigos", async () =>
          await supabase
            .from("bookmaker_event_links")
            .delete()
            .eq("bookmaker_slug", bookmakerSlug)
            .in("fixture_id", fixtureIdBatch)
            .lt("updated_at", saveStartedAt)
        );
      }
    }

    return uniqueOdds.length;
  }
}

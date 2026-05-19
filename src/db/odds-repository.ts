import { supabase } from "./supabase.js";

const DEFAULT_BATCH_SIZE = 200;
const DELETE_FIXTURE_BATCH_SIZE = 50;

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
      const { error: linksError } = await supabase.from("bookmaker_event_links").upsert(linkBatch, {
        onConflict: "bookmaker_slug,external_event_id"
      });

      if (linksError) throw linksError;
    }

    const uniqueOdds = [
      ...new Map(
        oddsToSave.map((row) => [`${row.fixture_id}:${row.bookmaker_slug}:${row.market_code}:${row.selection}:${row.pa_category}:${row.source_odd_id}`, row])
      ).values()
    ];

    for (const oddBatch of chunks(uniqueOdds, DEFAULT_BATCH_SIZE)) {
      const { error: oddsError } = await supabase.from("odds").upsert(oddBatch, {
        onConflict: "fixture_id,bookmaker_slug,market_code,selection,pa_category,source_odd_id"
      });

      if (oddsError) throw oddsError;
    }

    if (fixtureIds.length) {
      for (const fixtureIdBatch of chunks(fixtureIds, DELETE_FIXTURE_BATCH_SIZE)) {
        const { error: deleteOddsError } = await supabase
          .from("odds")
          .delete()
          .eq("bookmaker_slug", bookmakerSlug)
          .in("market_code", marketCodes)
          .in("fixture_id", fixtureIdBatch)
          .lt("updated_at", saveStartedAt);

        if (deleteOddsError) throw deleteOddsError;

        const { error: deleteLinksError } = await supabase
          .from("bookmaker_event_links")
          .delete()
          .eq("bookmaker_slug", bookmakerSlug)
          .in("fixture_id", fixtureIdBatch)
          .lt("updated_at", saveStartedAt);
        if (deleteLinksError) throw deleteLinksError;
      }
    }

    return uniqueOdds.length;
  }
}

import { supabase } from "./supabase.js";

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
  source_url: string;
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

export class OddsRepository {
  static async saveAll(
    bookmakerSlug: string,
    links: BookmakerLinkRow[],
    odds: OddRow[],
    options: { marketCodes?: string[]; cleanupFixtureIds?: string[] } = {}
  ) {
    const fixtureIds = [...new Set(options.cleanupFixtureIds?.length ? options.cleanupFixtureIds : links.map((link) => link.fixture_id))];
    const marketCodes = options.marketCodes?.length ? options.marketCodes : ["1X2"];

    if (fixtureIds.length) {
      const { error: deleteOddsError } = await supabase
        .from("odds")
        .delete()
        .eq("bookmaker_slug", bookmakerSlug)
        .in("market_code", marketCodes)
        .in("fixture_id", fixtureIds);

      if (deleteOddsError) throw deleteOddsError;

      const { error: deleteLinksError } = await supabase.from("bookmaker_event_links").delete().eq("bookmaker_slug", bookmakerSlug).in("fixture_id", fixtureIds);
      if (deleteLinksError) throw deleteLinksError;
    }

    if (!links.length) return 0;

    const { error: linksError } = await supabase.from("bookmaker_event_links").upsert(links, {
      onConflict: "bookmaker_slug,external_event_id"
    });

    if (linksError) throw linksError;

    if (!odds.length) return 0;

    const uniqueOdds = [
      ...new Map(
        odds.map((row) => [`${row.fixture_id}:${row.bookmaker_slug}:${row.market_code}:${row.selection}:${row.pa_category}:${row.source_odd_id}`, row])
      ).values()
    ];

    const { error: oddsError } = await supabase.from("odds").upsert(uniqueOdds, {
      onConflict: "fixture_id,bookmaker_slug,market_code,selection,pa_category,source_odd_id"
    });

    if (oddsError) throw oddsError;
    return uniqueOdds.length;
  }
}

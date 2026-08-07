import { supabase } from "../db/supabase.js";

const BATCH_SIZE = 500;

export type SavedBookmakerEventLink = {
  fixture_id: string;
  external_event_id: string | number;
  source_url: string | null;
  bookmaker_home_team: string | null;
  bookmaker_away_team: string | null;
  starts_at: string | null;
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

export async function getSavedBookmakerEventLinks(bookmakerSlug: string, fixtureIds: string[]) {
  const linksByFixtureId = new Map<string, SavedBookmakerEventLink>();
  const uniqueFixtureIds = [...new Set(fixtureIds)].filter(Boolean);

  for (const fixtureIdBatch of chunks(uniqueFixtureIds, BATCH_SIZE)) {
    const { data, error } = await supabase
      .from("links_eventos")
      .select("fixture_id,external_event_id,source_url,bookmaker_home_team,bookmaker_away_team,starts_at,raw,updated_at")
      .eq("bookmaker_slug", bookmakerSlug)
      .in("fixture_id", fixtureIdBatch)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    for (const row of (data ?? []) as SavedBookmakerEventLink[]) {
      if (!linksByFixtureId.has(row.fixture_id)) linksByFixtureId.set(row.fixture_id, row);
    }
  }

  return linksByFixtureId;
}

export async function saveDiscoveredEventLink(
  bookmakerSlug: string,
  fixtureId: string,
  sourceUrl: string,
  bookmakerHomeTeam: string,
  bookmakerAwayTeam: string,
  startsAt: string
): Promise<void> {
  const externalEventId = sourceUrl.match(/\/E(\d+)\//i)?.[1] ?? "0";
  const { error } = await supabase
    .from("links_eventos")
    .upsert(
      {
        bookmaker_slug: bookmakerSlug,
        fixture_id: fixtureId,
        external_event_id: externalEventId,
        source_url: sourceUrl,
        bookmaker_home_team: bookmakerHomeTeam,
        bookmaker_away_team: bookmakerAwayTeam,
        starts_at: startsAt,
        raw: { collectionUrl: sourceUrl },
        updated_at: new Date().toISOString()
      },
      { onConflict: "bookmaker_slug,fixture_id" }
    );
  if (error) throw error;
}

export function objectRaw(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function relativePathFromUrl(sourceUrl: string | null | undefined, baseUrl: string) {
  if (!sourceUrl) return null;

  try {
    const parsed = new URL(sourceUrl, baseUrl);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

import { supabase } from "../db/supabase.js";

const BATCH_SIZE = 500;

export type SavedBookmakerEventLink = {
  fixture_id: string;
  external_event_id: string | number;
  source_url: string | null;
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
      .from("bookmaker_event_links")
      .select("fixture_id,external_event_id,source_url,raw,updated_at")
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

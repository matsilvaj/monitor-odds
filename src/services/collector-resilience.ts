import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import { supabase } from "../db/supabase.js";

type FixtureLike = {
  id: string;
};

type FixtureWithStart = FixtureLike & {
  starts_at: string;
};

type LinkLike = {
  fixture_id: string;
};

const MINUTE_MS = 60 * 1000;
const MIN_PREMATCH_MS = 10 * MINUTE_MS;

function timestamp(value: string | number | Date) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function refreshIntervalMsForStart(startsAt: string | number | Date, now = new Date()) {
  const minutes = (timestamp(startsAt) - now.getTime()) / MINUTE_MS;
  if (minutes <= 30) return 5 * MINUTE_MS;
  if (minutes <= 60) return 15 * MINUTE_MS;
  if (minutes <= 6 * 60) return 60 * MINUTE_MS;
  if (minutes <= 24 * 60) return 3 * 60 * MINUTE_MS;
  return 6 * 60 * MINUTE_MS;
}

export function isFixturePrematchForOddsRefresh(startsAt: string | number | Date, now = new Date()) {
  return timestamp(startsAt) >= now.getTime() + MIN_PREMATCH_MS;
}

export function shouldUseFixtureRefreshCadence(options: BookmakerCollectOptions = {}) {
  return options.trigger === "watch" && !options.force;
}

async function getLastOddsUpdatedByFixture(bookmakerSlug: string, fixtureIds: string[]) {
  const updatedByFixtureId = new Map<string, string>();
  for (let index = 0; index < fixtureIds.length; index += 500) {
    const chunk = fixtureIds.slice(index, index + 500);
    if (!chunk.length) continue;

    const { data, error } = await supabase
      .from("odds")
      .select("fixture_id,updated_at")
      .eq("bookmaker_slug", bookmakerSlug)
      .in("fixture_id", chunk)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    for (const row of (data ?? []) as Array<{ fixture_id: string; updated_at: string }>) {
      if (!updatedByFixtureId.has(row.fixture_id)) updatedByFixtureId.set(row.fixture_id, row.updated_at);
    }
  }

  return updatedByFixtureId;
}

export type FixtureRefreshPlan<TFixture extends FixtureWithStart> = {
  fixtures: TFixture[];
  fixturesAvailable: number;
  fixturesTargeted: number;
  skippedFresh: number;
  skippedStarted: number;
};

export async function filterFixturesDueForOddsRefresh<TFixture extends FixtureWithStart>(
  bookmakerSlug: string,
  fixtures: TFixture[],
  options: BookmakerCollectOptions = {}
): Promise<FixtureRefreshPlan<TFixture>> {
  const now = new Date();
  const prematchFixtures = fixtures.filter((fixture) => isFixturePrematchForOddsRefresh(fixture.starts_at, now));
  const skippedStarted = fixtures.length - prematchFixtures.length;

  if (!shouldUseFixtureRefreshCadence(options)) {
    return {
      fixtures: prematchFixtures,
      fixturesAvailable: fixtures.length,
      fixturesTargeted: prematchFixtures.length,
      skippedFresh: 0,
      skippedStarted
    };
  }

  const lastUpdatedByFixtureId = await getLastOddsUpdatedByFixture(
    bookmakerSlug,
    prematchFixtures.map((fixture) => fixture.id)
  );
  const dueFixtures = prematchFixtures.filter((fixture) => {
    const lastUpdatedAt = lastUpdatedByFixtureId.get(fixture.id);
    if (!lastUpdatedAt) return true;

    const refreshMs = refreshIntervalMsForStart(fixture.starts_at, now);
    const ageMs = now.getTime() - new Date(lastUpdatedAt).getTime();
    return !Number.isFinite(ageMs) || ageMs < 0 || ageMs >= refreshMs;
  });

  return {
    fixtures: dueFixtures,
    fixturesAvailable: fixtures.length,
    fixturesTargeted: dueFixtures.length,
    skippedFresh: prematchFixtures.length - dueFixtures.length,
    skippedStarted
  };
}

export function applyFixtureRefreshPlan(summary: Record<string, unknown>, plan: FixtureRefreshPlan<FixtureWithStart>) {
  summary.fixturesAvailable = plan.fixturesAvailable;
  summary.fixturesTargeted = plan.fixturesTargeted;
  summary.eventsSkippedFresh = plan.skippedFresh;
  summary.eventsSkippedStarted = plan.skippedStarted;
}

export function cleanupFixtureIdsForRun(fixtures: FixtureLike[], links: LinkLike[], errors: number) {
  if (errors <= 0) return fixtures.map((fixture) => fixture.id);
  return [...new Set(links.map((link) => link.fixture_id))];
}

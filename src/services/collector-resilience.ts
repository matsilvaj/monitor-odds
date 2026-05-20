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
const MIN_PREMATCH_MS = 2 * MINUTE_MS;

function timestamp(value: string | number | Date) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function isFixturePrematchForOddsRefresh(startsAt: string | number | Date, now = new Date()) {
  return timestamp(startsAt) >= now.getTime() + MIN_PREMATCH_MS;
}

export type FixtureRefreshPlan<TFixture extends FixtureWithStart> = {
  fixtures: TFixture[];
  fixturesAvailable: number;
  fixturesTargeted: number;
  skippedStarted: number;
};

export async function filterFixturesDueForOddsRefresh<TFixture extends FixtureWithStart>(fixtures: TFixture[]): Promise<FixtureRefreshPlan<TFixture>> {
  const now = new Date();
  const prematchFixtures = fixtures.filter((fixture) => isFixturePrematchForOddsRefresh(fixture.starts_at, now));

  return {
    fixtures: prematchFixtures,
    fixturesAvailable: fixtures.length,
    fixturesTargeted: prematchFixtures.length,
    skippedStarted: fixtures.length - prematchFixtures.length
  };
}

export function applyFixtureRefreshPlan(summary: Record<string, unknown>, plan: FixtureRefreshPlan<FixtureWithStart>) {
  summary.fixturesAvailable = plan.fixturesAvailable;
  summary.fixturesTargeted = plan.fixturesTargeted;
  summary.eventsSkippedStarted = plan.skippedStarted;
}

export function cleanupFixtureIdsForRun(fixtures: FixtureLike[], links: LinkLike[], errors: number) {
  if (errors <= 0) return fixtures.map((fixture) => fixture.id);
  return [...new Set(links.map((link) => link.fixture_id))];
}

type FixtureLike = {
  id: string;
};

type LinkLike = {
  fixture_id: string;
};

export function cleanupFixtureIdsForRun(fixtures: FixtureLike[], links: LinkLike[], errors: number) {
  if (errors <= 0) return fixtures.map((fixture) => fixture.id);
  return [...new Set(links.map((link) => link.fixture_id))];
}

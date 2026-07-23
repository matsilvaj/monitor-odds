type FixtureLike = {
  id?: string | number | null;
};

export function restrictFixturesToRequested<T extends FixtureLike>(
  fixtures: T[],
  fixtureIds: string[] | undefined
) {
  if (!fixtureIds?.length) return fixtures;
  const requested = new Set(fixtureIds.map(String));
  return fixtures.filter((fixture) => fixture.id !== undefined && fixture.id !== null && requested.has(String(fixture.id)));
}

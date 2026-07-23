export function groundedKickoffMatches(
  startsAt: string | number | Date,
  groundedKickoff: string | null | undefined
) {
  if (!groundedKickoff?.trim()) return false;
  const expected = new Date(startsAt);
  if (!Number.isFinite(expected.getTime())) return false;

  const parsed = new Date(groundedKickoff);
  if (Number.isFinite(parsed.getTime()) && /[T ]\d{1,2}:\d{2}/.test(groundedKickoff)) {
    return Math.abs(parsed.getTime() - expected.getTime()) <= 6 * 60 * 60 * 1000;
  }

  const dateOnly = /\b(\d{4}-\d{2}-\d{2})\b/.exec(groundedKickoff)?.[1];
  if (!dateOnly) return false;
  const expectedDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(expected);
  return dateOnly === expectedDate;
}

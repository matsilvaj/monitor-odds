export function normalizeName(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\b(fc|cf|sc|ec|ac|ca|cd|sd|ud|club|clube|de|do|da|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSet(value: unknown) {
  return new Set(normalizeName(value).split(" ").filter(Boolean));
}

export function nameSimilarity(left: unknown, right: unknown) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }

  return intersection / Math.max(a.size, b.size);
}

import { nationalTeamAliases } from "./team-aliases.js";

const STOP_WORDS = new Set(["fc", "cf", "sc", "ec", "ac", "ca", "cd", "sd", "ud", "club", "clube", "de", "do", "da", "the"]);

export function normalizeForMatching(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchingTokens(value: unknown) {
  return normalizeForMatching(value)
    .split(" ")
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

export function significantTokenSet(value: unknown) {
  return new Set(matchingTokens(value).filter((token) => token.length > 2));
}

export function jaroWinkler(leftValue: unknown, rightValue: unknown) {
  const left = normalizeForMatching(leftValue).replace(/\s+/g, "");
  const right = normalizeForMatching(rightValue).replace(/\s+/g, "");

  if (left === right) return left.length ? 1 : 0;
  if (!left.length || !right.length) return 0;

  const matchDistance = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0);
  const leftMatches = Array.from({ length: left.length }, () => false);
  const rightMatches = Array.from({ length: right.length }, () => false);

  let matches = 0;
  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, right.length);

    for (let j = start; j < end; j += 1) {
      if (rightMatches[j] || left[i] !== right[j]) continue;

      leftMatches[i] = true;
      rightMatches[j] = true;
      matches += 1;
      break;
    }
  }

  if (!matches) return 0;

  let transpositions = 0;
  let rightIndex = 0;

  for (let i = 0; i < left.length; i += 1) {
    if (!leftMatches[i]) continue;
    while (!rightMatches[rightIndex]) rightIndex += 1;
    if (left[i] !== right[rightIndex]) transpositions += 1;
    rightIndex += 1;
  }

  const jaro = (matches / left.length + matches / right.length + (matches - transpositions / 2) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, left.length, right.length); i += 1) {
    if (left[i] !== right[i]) break;
    prefix += 1;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

export function tokenSetSimilarity(leftValue: unknown, rightValue: unknown) {
  const left = matchingTokens(leftValue);
  const right = matchingTokens(rightValue);
  if (!left.length || !right.length) return 0;

  const scores = left.map((leftToken) => Math.max(...right.map((rightToken) => jaroWinkler(leftToken, rightToken))));
  const reverseScores = right.map((rightToken) => Math.max(...left.map((leftToken) => jaroWinkler(leftToken, rightToken))));
  const leftAverage = scores.reduce((sum, score) => sum + score, 0) / left.length;
  const rightAverage = reverseScores.reduce((sum, score) => sum + score, 0) / right.length;

  return (leftAverage + rightAverage) / 2;
}

export function orderedTokenSimilarity(leftValue: unknown, rightValue: unknown) {
  const left = matchingTokens(leftValue);
  const right = matchingTokens(rightValue);
  if (!left.length || !right.length) return 0;

  const limit = Math.max(left.length, right.length);
  let total = 0;

  for (let i = 0; i < limit; i += 1) {
    const leftToken = left[i];
    const rightToken = right[i];
    if (!leftToken || !rightToken) continue;
    total += jaroWinkler(leftToken, rightToken);
  }

  return total / limit;
}

function baseTeamNameSimilarity(leftValue: unknown, rightValue: unknown) {
  return Math.max(jaroWinkler(leftValue, rightValue), tokenSetSimilarity(leftValue, rightValue), orderedTokenSimilarity(leftValue, rightValue));
}

export function teamNameSimilarity(leftValue: unknown, rightValue: unknown) {
  const leftAliases = nationalTeamAliases(leftValue);
  const rightAliases = nationalTeamAliases(rightValue);
  let best = 0;

  for (const leftAlias of leftAliases) {
    for (const rightAlias of rightAliases) {
      best = Math.max(best, baseTeamNameSimilarity(leftAlias, rightAlias));
    }
  }

  return best;
}

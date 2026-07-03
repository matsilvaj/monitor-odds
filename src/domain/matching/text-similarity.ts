import { nationalTeamAliases } from "./team-aliases.js";

const STOP_WORDS = new Set(["fc", "cf", "sc", "ec", "ac", "ca", "cd", "sd", "ud", "club", "clube", "de", "do", "da", "of", "the", "and", "e"]);
const SAFE_SHORT_TOKENS = new Set(["u17", "u18", "u19", "u20", "u21", "u22", "u23", "usa", "eua", "uae", "dr", "rd", "us"]);

type TeamNameProfile = {
  raw: string;
  normalized: string;
  tokens: string[];
  tokenKey: string;
  compact: string;
};

export function normalizeForMatching(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeInitialTokens(tokens: string[]) {
  const merged: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length !== 1 || !/^[a-z]$/.test(token)) {
      merged.push(token);
      continue;
    }

    let initials = token;
    let cursor = index + 1;
    while (cursor < tokens.length && tokens[cursor].length === 1 && /^[a-z]$/.test(tokens[cursor])) {
      initials += tokens[cursor];
      cursor += 1;
    }

    merged.push(initials);
    index = cursor - 1;
  }

  return merged;
}

export function matchingTokens(value: unknown) {
  return mergeInitialTokens(
    normalizeForMatching(value)
    .replace(/\bsub\s*(\d{2})\b/g, "u$1")
    .split(" ")
  )
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

function uniqueValues<T>(values: T[]) {
  return [...new Set(values)];
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenRegexSource(value: string) {
  const accentGroups: Record<string, string> = {
    a: "aA\u00E0\u00C0\u00E1\u00C1\u00E2\u00C2\u00E3\u00C3\u00E4\u00C4\u00E5\u00C5",
    c: "cC\u00E7\u00C7",
    e: "eE\u00E8\u00C8\u00E9\u00C9\u00EA\u00CA\u00EB\u00CB",
    i: "iI\u00EC\u00CC\u00ED\u00CD\u00EE\u00CE\u00EF\u00CF",
    n: "nN\u00F1\u00D1",
    o: "oO\u00F2\u00D2\u00F3\u00D3\u00F4\u00D4\u00F5\u00D5\u00F6\u00D6\u00F8\u00D8",
    u: "uU\u00F9\u00D9\u00FA\u00DA\u00FB\u00DB\u00FC\u00DC",
    y: "yY\u00FD\u00DD\u00FF"
  };

  const source = [...value]
    .map((char) => {
      const group = accentGroups[char.toLowerCase()];
      return group ? `[${escapeRegex(group)}]` : escapeRegex(char);
    })
    .join("");

  if (/^[a-z]{2,4}$/.test(value) && (value.length <= 3 || SAFE_SHORT_TOKENS.has(value))) {
    return [...value]
      .map((char) => {
        const group = accentGroups[char.toLowerCase()];
        return group ? `[${escapeRegex(group)}]` : escapeRegex(char);
      })
      .join("[^A-Za-z0-9\\u00C0-\\u024F]{0,3}");
  }

  return source;
}

function profileTokens(value: unknown) {
  return mergeInitialTokens(
    normalizeForMatching(value)
    .replace(/\bsub\s*(\d{2})\b/g, "u$1")
    .split(" ")
  )
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
    .filter((token) => token.length >= 2 || SAFE_SHORT_TOKENS.has(token));
}

function teamNameProfile(value: unknown): TeamNameProfile {
  const raw = String(value ?? "");
  const normalized = normalizeForMatching(raw);
  const tokens = uniqueValues(profileTokens(raw));
  const tokenKey = [...tokens].sort().join(" ");
  const compact = tokens.join("");

  return { raw, normalized, tokens, tokenKey, compact };
}

function allTokensContained(left: string[], right: string[]) {
  if (left.length < 2) return false;
  const rightTokens = new Set(right);
  return left.every((token) => rightTokens.has(token));
}

function profileIdentityScore(left: TeamNameProfile, right: TeamNameProfile) {
  if (!left.tokens.length || !right.tokens.length) return 0;
  if (left.normalized === right.normalized) return 1;
  if (left.compact && left.compact === right.compact) return 0.995;
  if (left.tokenKey && left.tokenKey === right.tokenKey) return 0.985;
  if (allTokensContained(left.tokens, right.tokens) || allTokensContained(right.tokens, left.tokens)) return 0.94;

  return 0;
}

function distinguishingTokenKeys(tokens: string[]) {
  const keys = new Set<string>();
  const tokenSet = new Set(tokens);

  for (const token of tokens) {
    if (/^u\d{2}$/.test(token)) keys.add(`age:${token}`);
    if (token === "dpr") keys.add("direction:north");
    if (tokenSet.has("korea") && token === "republic") keys.add("direction:south");
    if (token === "dr" || token === "rd" || token === "democratic" || token === "democratica" || token === "democratico") keys.add("state:democratic-republic");
    if (token === "kinshasa") keys.add("state:democratic-republic");
    if (token === "brazzaville") keys.add("state:republic");
    if (token === "north" || token === "norte") keys.add("direction:north");
    if (token === "south" || token === "sul") keys.add("direction:south");
    if (token === "east" || token === "oriental") keys.add("direction:east");
    if (token === "west" || token === "oeste") keys.add("direction:west");
    if (token === "w" || token === "women" || token === "woman" || token === "f" || token === "fem" || token === "feminino" || token === "feminina") keys.add("gender:women");
    if (token === "b" || token === "ii" || token === "iii" || token === "iv" || token === "reserve" || token === "reserves" || token === "reserva") keys.add(`squad:${token}`);
  }

  return keys;
}

function hasDistinguishingMismatch(left: TeamNameProfile, right: TeamNameProfile) {
  const leftKeys = distinguishingTokenKeys(left.tokens);
  const rightKeys = distinguishingTokenKeys(right.tokens);
  const allKeys = new Set([...leftKeys, ...rightKeys]);

  for (const key of allKeys) {
    if (leftKeys.has(key) !== rightKeys.has(key)) return true;
  }

  return false;
}

function capDistinguishingMismatch(score: number, left: TeamNameProfile, right: TeamNameProfile) {
  return hasDistinguishingMismatch(left, right) ? Math.min(score, 0.61) : score;
}

export function teamIdentityScore(leftValue: unknown, rightValue: unknown) {
  const leftAliases = nationalTeamAliases(leftValue);
  const rightAliases = nationalTeamAliases(rightValue);
  let best = 0;

  for (const leftAlias of leftAliases) {
    const leftProfile = teamNameProfile(leftAlias);
    for (const rightAlias of rightAliases) {
      const rightProfile = teamNameProfile(rightAlias);
      const rawScore = Math.max(profileIdentityScore(leftProfile, rightProfile), baseTeamNameSimilarity(leftAlias, rightAlias));
      best = Math.max(best, capDistinguishingMismatch(rawScore, leftProfile, rightProfile));
    }
  }

  return best;
}

export function teamNameSimilarity(leftValue: unknown, rightValue: unknown) {
  return teamIdentityScore(leftValue, rightValue);
}

export function teamNameSearchPatterns(value: unknown) {
  const patterns = nationalTeamAliases(value)
    .map((alias) => profileTokens(alias))
    .filter((tokens) => tokens.length > 0)
    .map((tokens) =>
      tokens
        .map((token) => {
          const source = tokenRegexSource(token);
          return token.length <= 3 ? `(?:^|[^A-Za-z0-9\\u00C0-\\u024F])${source}(?=$|[^A-Za-z0-9\\u00C0-\\u024F])` : source;
        })
        .join("[\\s\\S]{0,30}?")
    );

  return uniqueValues(patterns).map((pattern) => new RegExp(pattern, "i"));
}

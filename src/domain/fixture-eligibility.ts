import type { LeagueConfig } from "../config/leagues.js";
import { normalizeName } from "./text.js";

export type FixtureEligibilityInput = {
  leagueName?: string | null;
  round?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
};

export type FixtureEligibilityDecision = {
  eligible: boolean;
  reason: string;
};

const SENIOR_INTERNATIONAL_REJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bu\s*(?:17|18|19|20|21|22|23)\b/, reason: "youth-age-category" },
  { pattern: /\bsub\s*(?:17|18|19|20|21|22|23)\b/, reason: "youth-age-category" },
  { pattern: /\bunder\s*(?:17|18|19|20|21|22|23)\b/, reason: "youth-age-category" },
  { pattern: /\b(women|woman|female|feminino|feminina|femenino|femenina|feminil|fem|w)\b/, reason: "women-category" },
  { pattern: /\b(youth|junior|juniors|academy|olympic|olimpico|olimpica|olimpicos|olimpicas)\b/, reason: "non-senior-category" },
  { pattern: /\b(reserve|reserves|reserva|reservas|b)\b/, reason: "reserve-category" }
];

function normalizedEligibilityText(input: FixtureEligibilityInput) {
  return normalizeName([input.leagueName, input.round, input.homeTeam, input.awayTeam].filter(Boolean).join(" "));
}

function seniorInternationalDecision(input: FixtureEligibilityInput): FixtureEligibilityDecision {
  const text = normalizedEligibilityText(input);

  for (const { pattern, reason } of SENIOR_INTERNATIONAL_REJECTION_PATTERNS) {
    if (pattern.test(text)) return { eligible: false, reason };
  }

  return { eligible: true, reason: "senior-international" };
}

export function fixtureEligibilityDecision(league: LeagueConfig | null | undefined, input: FixtureEligibilityInput): FixtureEligibilityDecision {
  if (league?.eligibility === "SENIOR_INTERNATIONAL_ONLY") {
    return seniorInternationalDecision(input);
  }

  return { eligible: true, reason: "default" };
}

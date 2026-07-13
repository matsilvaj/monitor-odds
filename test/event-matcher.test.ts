import assert from "node:assert/strict";
import test from "node:test";
import { findBestCanonicalEventMatch, matchEvents } from "../src/domain/matching/event-matcher.js";

const startsAt = "2026-07-14T18:45:00.000Z";

const falseMatches = [
  ["Clyde", "Airdrie United", "FC United of Manchester", "Rochdale FC"],
  ["Brechin", "Livingston", "Leamington FC", "Brackley Town"],
  ["Linlithgow Rose", "ST Johnstone", "Spartans", "Stirling Albion"],
  ["Spartans", "Stirling Albion", "Bedfont Sports FC", "St Albans City"]
] as const;

test("rejects unrelated events even at the exact same kickoff", () => {
  for (const [homeTeam, awayTeam, bookmakerHome, bookmakerAway] of falseMatches) {
    const result = matchEvents(
      { startsAt, homeTeam, awayTeam, leagueName: "Scottish League Cup" },
      { startsAt, homeTeam: bookmakerHome, awayTeam: bookmakerAway, leagueName: "Scottish League Cup" },
      { context: "league-scoped", trustedLeagueScope: true }
    );

    assert.equal(result.matched, false, `${homeTeam} x ${awayTeam} matched ${bookmakerHome} x ${bookmakerAway}`);
  }
});

test("a single saved candidate is not automatically a trusted league scope", () => {
  const result = findBestCanonicalEventMatch(
    [{ id: "fixture", starts_at: startsAt, home_team: "Brechin", away_team: "Livingston", league_name: null }],
    { startsAt, homeTeam: "Leamington FC", awayTeam: "Brackley Town", leagueName: null },
    { context: "league-scoped" }
  );

  assert.equal(result, null);
});

test("keeps legitimate aliases and expanded club names", () => {
  const accepted = [
    ["KuPS", "Inter Turku", "Kuopion Palloseura", "FC Inter Turku"],
    ["Manchester United", "Arsenal", "Man Utd", "Arsenal FC"],
    ["CRB", "Nautico", "Clube de Regatas Brasil", "Nautico Recife"],
    ["Gyori ETO FC", "Vikingur Reykjavik", "Gyor ETO FC", "Vikingur Reykjavik"],
    ["KuPS", "Vardar Skopje", "KuPS Kuopio", "FK Vardar"]
  ] as const;

  for (const [homeTeam, awayTeam, bookmakerHome, bookmakerAway] of accepted) {
    const result = matchEvents(
      { startsAt, homeTeam, awayTeam },
      { startsAt, homeTeam: bookmakerHome, awayTeam: bookmakerAway }
    );
    assert.equal(result.matched, true, `${homeTeam} x ${awayTeam} did not match ${bookmakerHome} x ${bookmakerAway}`);
  }
});

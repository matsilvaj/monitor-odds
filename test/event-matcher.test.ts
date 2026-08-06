import assert from "node:assert/strict";
import test from "node:test";
import { findBestCanonicalEventMatch, matchEvents, selectionForCanonicalOrientation } from "../src/domain/matching/event-matcher.js";
import { parseBet365LeaguePageEvents } from "../src/services/bet365-collector.js";
import { canonicalNameFromAlias, linkOrientation } from "../src/services/bookmaker-match-memory.js";

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

test("matches Meridian display order when home and away are inverted", () => {
  const result = findBestCanonicalEventMatch(
    [{ id: "fixture", starts_at: startsAt, home_team: "Celtic", away_team: "Aberdeen", league_name: "Premiership" }],
    { startsAt, homeTeam: "Aberdeen", awayTeam: "Celtic", leagueName: "Premiership" },
    { context: "league-scoped", trustedLeagueScope: true }
  );

  assert.ok(result);
  assert.equal(result.orientation, "INVERTED");
  assert.equal(selectionForCanonicalOrientation("HOME", result.orientation), "AWAY");
  assert.equal(selectionForCanonicalOrientation("DRAW", result.orientation), "DRAW");
  assert.equal(selectionForCanonicalOrientation("AWAY", result.orientation), "HOME");
});

test("discovers Bet365 D0/D1 events without using league-row odds", () => {
  const rawText = [
    "Qua 05 Ago", "1", "X", "2",
    "19:00", "Boca Juniors", "Estudiantes", "8", "2.15", "2.87", "4.00",
    "21:15", "Tigre", "Belgrano", "8", "2.55", "2.75", "3.40"
  ].join("\n");

  const events = parseBet365LeaguePageEvents(rawText, ["2026-08-05"]);

  assert.equal(events.length, 2);
  assert.equal(events[0]?.homeTeam, "Boca Juniors");
  assert.equal(events[0]?.awayTeam, "Estudiantes");
  assert.equal(events[1]?.homeTeam, "Tigre");
  assert.equal(events[1]?.awayTeam, "Belgrano");
});
test("reuses only persisted valid event orientations", () => {
  assert.equal(linkOrientation({ orientation: "NORMAL" }), "NORMAL");
  assert.equal(linkOrientation({ orientation: "INVERTED" }), "INVERTED");
  assert.equal(linkOrientation({ orientation: "UNKNOWN" }), null);
  assert.equal(linkOrientation(null), null);
});

test("resolves a learned bookmaker alias to the canonical team name", () => {
  const aliases = new Map([
    ["estudiantes la plata", { teamId: "team-1", canonicalName: "Estudiantes L.P." }]
  ]);
  assert.equal(canonicalNameFromAlias(aliases, "Estudiantes de La Plata"), "Estudiantes L.P.");
  assert.equal(canonicalNameFromAlias(aliases, "Boca Juniors"), "Boca Juniors");
});
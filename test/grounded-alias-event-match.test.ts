import assert from "node:assert/strict";
import test from "node:test";
import { findBestCanonicalEventMatch } from "../src/domain/matching/event-matcher.js";

test("connects the official Zalgiris identity discovered from the VMFD alias", () => {
  const match = findBestCanonicalEventMatch(
    [
      {
        id: "fixture-zalgiris",
        starts_at: "2026-07-23T17:00:00.000Z",
        home_team: "Dinamo Tbilisi",
        away_team: "FK Zalgiris Vilnius",
        league_name: "Conference League"
      }
    ],
    {
      id: "bookmaker-event",
      startsAt: "2026-07-23T17:00:00.000Z",
      homeTeam: "FC Dinamo Tbilisi",
      awayTeam: "FK ?algiris",
      leagueName: "UEFA Conference League"
    },
    { context: "league-scoped" }
  );

  assert.ok(match);
  assert.equal(match.fixture.id, "fixture-zalgiris");
  assert.equal(match.orientation, "NORMAL");
  assert.ok(match.score > 0.95);
});

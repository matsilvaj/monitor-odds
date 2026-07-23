import assert from "node:assert/strict";
import test from "node:test";
import { groundedKickoffMatches } from "../src/domain/matching/grounded-identity.js";

const kickoff = "2026-07-23T17:00:00.000Z";

test("accepts the grounded kickoff for the canonical event", () => {
  assert.equal(groundedKickoffMatches(kickoff, "2026-07-23T14:00:00-03:00"), true);
});

test("accepts a grounded date-only answer on the canonical Sao Paulo date", () => {
  assert.equal(groundedKickoffMatches(kickoff, "2026-07-23"), true);
});

test("rejects another date even when the team pair could repeat", () => {
  assert.equal(groundedKickoffMatches(kickoff, "2026-07-30T14:00:00-03:00"), false);
});

test("rejects missing or unparseable grounded kickoff evidence", () => {
  assert.equal(groundedKickoffMatches(kickoff, null), false);
  assert.equal(groundedKickoffMatches(kickoff, "amanha a tarde"), false);
});

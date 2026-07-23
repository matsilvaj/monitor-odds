import assert from "node:assert/strict";
import test from "node:test";
import { restrictFixturesToRequested } from "../src/services/collector-fixture-scope.js";
import {
  discardStagedResidualIdentities,
  enqueueResidualIdentity,
  markResidualIdentityMatched,
  residualEventHash,
  stagedResidualIdentityCount
} from "../src/services/residual-identity-worker.js";

const question = {
  bookmakerSlug: "meridianbet",
  eventKey: "raw-event-1",
  homeTeam: "VMFD Zalgiris",
  awayTeam: "Dinamo Tbilisi",
  leagueName: "Conference League",
  startsAt: "2026-07-23T17:00:00.000Z"
};

const candidates = [
  {
    id: "fixture-1",
    homeTeam: "FK Zalgiris Vilnius",
    awayTeam: "Dinamo Tbilisi",
    startsAt: "2026-07-23T17:00:00.000Z"
  },
  {
    id: "fixture-2",
    homeTeam: "Kauno Zalgiris",
    awayTeam: "Suduva",
    startsAt: "2026-07-23T17:00:00.000Z"
  }
];

test("keeps a residual identity stable when candidate order changes", () => {
  assert.equal(residualEventHash(question, candidates), residualEventHash(question, [...candidates].reverse()));
});

test("opens a new residual identity generation when canonical candidates change", () => {
  const changed = candidates.map((candidate, index) =>
    index === 0 ? { ...candidate, id: "fixture-new", startsAt: "2026-07-30T17:00:00.000Z" } : candidate
  );
  assert.notEqual(residualEventHash(question, candidates), residualEventHash(question, changed));
});

test("restricts the recovery pass to explicitly resolved fixtures", () => {
  const fixtures = [{ id: "fixture-1" }, { id: "fixture-2" }, { id: "fixture-3" }];
  assert.deepEqual(restrictFixturesToRequested(fixtures, ["fixture-2"]), [{ id: "fixture-2" }]);
  assert.equal(restrictFixturesToRequested(fixtures, undefined), fixtures);
});

test("drops temporary comparisons when the normal loop later finds the event", async () => {
  const bookmakerSlug = "staging-test";
  const stagedQuestion = {
    ...question,
    bookmakerSlug,
    eventKey: "bookmaker-event-1"
  };

  try {
    await enqueueResidualIdentity(stagedQuestion, [candidates[0]], {
      bookmakerSlug,
      context: "league-scoped",
      trustedLeagueScope: true
    });
    assert.equal(stagedResidualIdentityCount(bookmakerSlug), 1);

    markResidualIdentityMatched(bookmakerSlug, stagedQuestion.eventKey, "fixture-1");
    assert.equal(stagedResidualIdentityCount(bookmakerSlug), 0);
  } finally {
    discardStagedResidualIdentities(bookmakerSlug);
  }
});

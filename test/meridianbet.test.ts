import assert from "node:assert/strict";
import test from "node:test";
import {
  isExpectedMeridianEvent,
  parseVisibleEventCandidate,
  meridianEventDisplayOrder,
  type MeridianFixtureTarget
} from "../src/providers/meridianbet.js";

const fixture: MeridianFixtureTarget = {
  id: "alloa-falkirk",
  homeTeam: "Alloa Athletic",
  awayTeam: "Falkirk",
  leagueName: "Scottish League Cup",
  leagueCountry: "Scotland",
  startsAt: "2026-07-21T18:45:00.000Z"
};

function eventPage(header: string) {
  return `${header}\nPRINCIPAL\nGOLS\nRESULTADOS FINAIS\nGG-NG\nINICIO\nRESULTADO FINAL - PAGAMENTO ANTECIPADO\n1\n1.94\nX\n3.55\n2\n3.31\nRESULTADO FINAL\n1\n1.96\nX\n3.47\n2\n3.38`;
}

test("rejects the cached Falkirk v St Mirren event for Alloa v Falkirk", () => {
  const rawText = eventPage("Premiership\n154 01.08 11:00\nFalkirk FC\n-\nSt Mirren FC");
  const sourceUrl = "https://meridianbet.example/falkirk-fc-st-mirren-fc/12345";

  assert.equal(isExpectedMeridianEvent(rawText, sourceUrl, fixture, new Date("2026-07-20T15:00:00.000Z")), false);
});

test("rejects the same teams when the Meridian date or kickoff is different", () => {
  const rawText = eventPage("League Cup\n2519 01.08 11:00\nAlloa Athletic FC\n-\nFalkirk FC");
  const sourceUrl = "https://meridianbet.example/alloa-athletic-fc-falkirk-fc/2519";

  assert.equal(isExpectedMeridianEvent(rawText, sourceUrl, fixture, new Date("2026-07-20T15:00:00.000Z")), false);
});

test("uses the visible event header to detect inverted home and away order", () => {
  const rawText = eventPage("League Cup\n2519 Amanha 15:45\nFalkirk FC\n-\nAlloa Athletic FC");
  const sourceUrl = "https://meridianbet.example/alloa-athletic-fc-falkirk-fc/2519";

  assert.equal(isExpectedMeridianEvent(rawText, sourceUrl, fixture, new Date("2026-07-20T15:00:00.000Z")), true);
  assert.deepEqual(meridianEventDisplayOrder(rawText, sourceUrl, fixture), {
    orientation: "INVERTED",
    bookmakerHomeTeam: "Falkirk",
    bookmakerAwayTeam: "Alloa Athletic"
  });
});
test("does not invert teams that share a generic FC prefix", () => {
  const zimbruFixture: MeridianFixtureTarget = {
    id: "zimbru-noah",
    homeTeam: "Zimbru",
    awayTeam: "FC Noah",
    leagueName: "Conference League",
    leagueCountry: "World",
    startsAt: "2026-07-23T17:00:00.000Z"
  };
  const rawText = eventPage("Conferencia Liga Europa\n1415 Amanha 14:00\nFC Zimbru Chisinau\n-\nFC Noah Yerevan");
  const sourceUrl = "https://meridianbet.example/fc-zimbru-chisinau-fc-noah-yerevan/1415";

  assert.equal(isExpectedMeridianEvent(rawText, sourceUrl, zimbruFixture, new Date("2026-07-22T15:00:00.000Z")), true);
  assert.deepEqual(meridianEventDisplayOrder(rawText, sourceUrl, zimbruFixture), {
    orientation: "NORMAL",
    bookmakerHomeTeam: "Zimbru",
    bookmakerAwayTeam: "FC Noah"
  });
});
test("keeps Dinamo Tbilisi and FK Zalgiris in the visible Meridian order", () => {
  const dinamoFixture: MeridianFixtureTarget = {
    id: "dinamo-zalgiris",
    homeTeam: "Dinamo Tbilisi",
    awayTeam: "FK Zalgiris Vilnius",
    leagueName: "Conference League",
    leagueCountry: "World",
    startsAt: "2026-07-23T17:00:00.000Z"
  };
  const rawText = eventPage("Conferencia Liga Europa\n1400 Amanha 14:00\nFC Dinamo Tbilisi\n-\nFK Zalgiris Vilnius");
  const sourceUrl = "https://meridianbet.example/fc-dinamo-tbilisi-fk-zalgiris-vilnius/1400";

  assert.equal(isExpectedMeridianEvent(rawText, sourceUrl, dinamoFixture, new Date("2026-07-22T15:00:00.000Z")), true);
  assert.deepEqual(meridianEventDisplayOrder(rawText, sourceUrl, dinamoFixture), {
    orientation: "NORMAL",
    bookmakerHomeTeam: "Dinamo Tbilisi",
    bookmakerAwayTeam: "FK Zalgiris Vilnius"
  });
});
test("rejects an event when only one team is recognized even at the exact kickoff", () => {
  const fixtureWithDifferentName: MeridianFixtureTarget = {
    ...fixture,
    homeTeam: "The Wasps"
  };
  const rawText = eventPage("League Cup\n2519 Amanha 15:45\nAlloa Athletic FC\n-\nFalkirk FC");
  const sourceUrl = "https://meridianbet.example/alloa-athletic-fc-falkirk-fc/2519";

  assert.equal(isExpectedMeridianEvent(rawText, sourceUrl, fixtureWithDifferentName, new Date("2026-07-20T15:00:00.000Z")), false);
});

test("rejects an inverted event when only one team name is recognized", () => {
  const fixtureWithDifferentName: MeridianFixtureTarget = {
    ...fixture,
    homeTeam: "The Wasps"
  };
  const rawText = eventPage("League Cup\n2519 Amanha 15:45\nFalkirk FC\n-\nAlloa Athletic FC");
  const sourceUrl = "https://meridianbet.example/falkirk-fc-alloa-athletic-fc/2519";

  assert.equal(isExpectedMeridianEvent(rawText, sourceUrl, fixtureWithDifferentName, new Date("2026-07-20T15:00:00.000Z")), false);
});
test("finds the event header even with promotional content before the Principal tab", () => {
  const promotions = Array.from({ length: 30 }, (_, index) => `Oferta promocional ${index + 1}`).join("\n");
  const rawText = eventPage(`League Cup\n0069 Amanha 14:00\nAGF Aarhus\n-\nKKS Lech Poznan\n${promotions}`);
  const aarhusFixture: MeridianFixtureTarget = {
    ...fixture,
    id: "aarhus-lech",
    homeTeam: "Aarhus",
    awayTeam: "Lech Poznan",
    startsAt: "2026-07-21T17:00:00.000Z"
  };

  assert.equal(isExpectedMeridianEvent(rawText, "https://meridianbet.example/agf-aarhus-kks-lech-poznan/69", aarhusFixture, new Date("2026-07-20T15:00:00.000Z")), true);
});

test("extracts both unknown bookmaker names from a visible Meridian event", () => {
  const event = parseVisibleEventCandidate(
    ["14:00", "Amanha", "FC Dinamo Tbilisi", "VMFD Zalgiris", "+2"].join("\n"),
    "https://meridianbet.example/fc-dinamo-tbilisi-vmfd-zalgiris/1400",
    0
  );

  assert.ok(event);
  assert.equal(event.homeTeam, "FC Dinamo Tbilisi");
  assert.equal(event.awayTeam, "VMFD Zalgiris");
  assert.equal(event.timeLabel, "14:00");
  assert.equal(event.dateLabel, "Amanha");
});
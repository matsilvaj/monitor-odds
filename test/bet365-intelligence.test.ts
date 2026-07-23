import assert from "node:assert/strict";
import test from "node:test";
import { parseVisibleFixtureCandidate } from "../src/providers/bet365/network-client.js";
import { applyCanonicalBet365EventOrientation } from "../src/services/bet365-collector.js";
import type { Bet365Event } from "../src/providers/bet365/types.js";

test("extracts both bookmaker team names from a visible Bet365 fixture", () => {
  const event = parseVisibleFixtureCandidate(
    ["13:00", "Amanhã", "FC Dinamo Tbilisi", "VMFD Zalgiris", "2.10", "3.25", "3.38"].join("\n"),
    "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E135679867/G40/",
    0
  );

  assert.ok(event);
  assert.equal(event.homeTeam, "FC Dinamo Tbilisi");
  assert.equal(event.awayTeam, "VMFD Zalgiris");
  assert.equal(event.timeLabel, "13:00");
  assert.equal(event.dateLabel, "Amanhã");
});

test("maps an inverted Bet365 display to canonical 1X2 selections", () => {
  const event: Bet365Event = {
    externalEventId: 1,
    sourceUrl: "https://www.bet365.bet.br/#/AC/B1/C1/D1002/E1/F2/",
    eventName: "Bookmaker Away x Bookmaker Home",
    bookmakerHomeTeam: "Bookmaker Away",
    bookmakerAwayTeam: "Bookmaker Home",
    rawText: "",
    markets: [
      {
        marketName: "MoneyLine",
        paCategory: "SEM_PA",
        confidence: 1,
        rawText: "",
        index: 0,
        selections: [
          { selection: "HOME", label: "Bookmaker Away", price: 4.22, index: 0 },
          { selection: "DRAW", label: "Empate", price: 3.75, index: 1 },
          { selection: "AWAY", label: "Bookmaker Home", price: 1.67, index: 2 }
        ]
      }
    ]
  };

  const corrected = applyCanonicalBet365EventOrientation(event, "INVERTED");
  assert.deepEqual(
    corrected.markets[0].selections.map(({ selection, price }) => ({ selection, price })),
    [
      { selection: "AWAY", price: 4.22 },
      { selection: "DRAW", price: 3.75 },
      { selection: "HOME", price: 1.67 }
    ]
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseFixtureRowMoneylineMarket } from "../src/providers/bet365/network-client.js";

test("reads 1X2 prices from a Bet365 league fixture row", () => {
  const market = parseFixtureRowMoneylineMarket(
    ["13:00", "Paide Linnameeskond", "(1)", "FC Hegelmann", "(1)", "10>", "1.72", "3.30", "4.33"].join("\n"),
    { homeTeam: "Paide", awayTeam: "Hegelmann Litauen" },
    true
  );

  assert.ok(market);
  assert.equal(market.paCategory, "COM_PA");
  assert.deepEqual(
    market.selections.map(({ price }) => price),
    [1.72, 3.3, 4.33]
  );
});

test("rejects a container contaminated with prices from adjacent fixtures", () => {
  const market = parseFixtureRowMoneylineMarket(
    ["FC Milsami", "Velez Mostar", "2.20", "3.20", "2.80", "Santa Coloma", "Penybont", "1.60", "3.50", "5.00"].join("\n"),
    { homeTeam: "Milsami Orhei", awayTeam: "Velez" },
    true
  );

  assert.equal(market, null);
});

test("accepts Bet365 aliases that omit canonical location and sponsor suffixes", () => {
  const market = parseFixtureRowMoneylineMarket(
    ["FC Milsami", "Velez Mostar", "2.20", "3.20", "2.80"].join("\n"),
    { homeTeam: "Milsami Orhei", awayTeam: "Vele\u017e" },
    true
  );

  assert.ok(market);
  assert.deepEqual(
    market.selections.map(({ price }) => price),
    [2.2, 3.2, 2.8]
  );
});

test("reads St. Louis City SC v Kansas City from the MLS league row", () => {
  const market = parseFixtureRowMoneylineMarket(
    ["21:30", "St. Louis City SC", "Kansas City", "1.41", "5.00", "6.00"].join("\n"),
    { homeTeam: "St. Louis City", awayTeam: "Sporting Kansas City" },
    true
  );

  assert.ok(market);
  assert.equal(market.paCategory, "COM_PA");
  assert.deepEqual(
    market.selections.map(({ price }) => price),
    [1.41, 5, 6]
  );
});

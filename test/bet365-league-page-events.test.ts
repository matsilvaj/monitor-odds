import assert from "node:assert/strict";
import test from "node:test";
import { parseBet365LeaguePageEvents, bet365ListingEventKey } from "../src/services/bet365-collector.js";

test("extrai todos os eventos D0/D1 da pagina sem depender das fixtures canonicas", () => {
  const text = `
Dom 02 Ago
14:30
Aldosivi
Gimnasia LP
3.30
2.80
2.55
Seg 03 Ago
16:45
Sarmiento
Independiente Rivadavia
3.60
2.90
2.35
21:15
Central Cordoba SdE
San Lorenzo
3.40
2.80
2.50
Ter 04 Ago
20:00
Time Fora
Outro Fora
2.00
3.00
4.00`;
  const events = parseBet365LeaguePageEvents(text, ["2026-08-02", "2026-08-03"]);
  assert.deepEqual(events.map((event) => [event.homeTeam, event.awayTeam, event.dateKey]), [
    ["Aldosivi", "Gimnasia LP", "2026-08-02"],
    ["Sarmiento", "Independiente Rivadavia", "2026-08-03"],
    ["Central Cordoba SdE", "San Lorenzo", "2026-08-03"]
  ]);
});

test("não confunde times com nomes similares", () => {
  const key1 = bet365ListingEventKey("2026-08-08", "Independiente", "Platense");
  const key2 = bet365ListingEventKey("2026-08-08", "Independiente Rivadavia", "Platense");

  assert.notEqual(key1, key2, "Independiente e Independiente Rivadavia devem gerar chaves diferentes");
});

test("rejeita eventos D2+ mesmo com lastValidDateKey fallback", () => {
  const text = `
Dom 02 Ago
14:30
Time A
Time B
Seg 03 Ago
16:45
Time C
Time D
Ter 04 Ago
20:00
Time E
Time F
Qua 05 Ago
19:00
Time G
Time H`;
  const events = parseBet365LeaguePageEvents(text, ["2026-08-02", "2026-08-03"]);
  const eventPairs = events.map((event) => [event.homeTeam, event.awayTeam, event.dateKey]);
  const rejectedDates = eventPairs.filter((pair) => pair[2] !== "2026-08-02" && pair[2] !== "2026-08-03");
  assert.equal(rejectedDates.length, 0, `Encontrou ${rejectedDates.length} eventos fora do escopo: ${JSON.stringify(rejectedDates)}`);
});

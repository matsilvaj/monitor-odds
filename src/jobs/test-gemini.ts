import "dotenv/config";
import { verifyTeamsSameClub } from "../services/gemini-team-verifier.js";

const cases = [
  { a: "Estrela Vermelha",  b: "FK Crvena Zvezda",        expected: true,  league: "UEFA Champions League" },
  { a: "FC Cincinnati",     b: "Deportes Tolima",          expected: false, league: "Copa Libertadores" },
  { a: "Desportos Tolima",  b: "Deportes Tolima",          expected: true,  league: "Copa Libertadores" },
  { a: "Clachnacuddin FC",  b: "Leighton Town FC",         expected: false, league: "Scottish Challenge Cup" },
];

console.log("Testando Gemini com Google Search...\n");

for (const c of cases) {
  process.stdout.write(`"${c.a}" = "${c.b}"? `);
  const result = await verifyTeamsSameClub(c.a, c.b, c.league);
  const ok = result === c.expected;
  console.log(`${result === null ? "null (erro)" : result ? "SIM" : "NÃO"} ${ok ? "✓" : `✗ (esperado: ${c.expected})`}`);
}

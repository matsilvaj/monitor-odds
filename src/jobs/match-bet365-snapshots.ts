import { matchBet365Snapshots } from "../services/bet365-snapshot-matcher.js";

const date = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const summary = await matchBet365Snapshots({ date });
console.log(`[bet365] Matching externo: ${summary.matched} encontrados | ${summary.unmatched} pendentes | ${summary.invalid} invalidos ignorados | ${summary.oddsUpserted} odds salvas.`);

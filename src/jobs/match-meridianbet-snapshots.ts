import { matchMeridianbetSnapshots } from "../services/meridianbet-snapshot-matcher.js";

const date = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const summary = await matchMeridianbetSnapshots({ date });
console.log(`[meridianbet] Matching externo: ${summary.matched} encontrados | ${summary.unmatched} pendentes | ${summary.invalid} inválidos | ${summary.oddsUpserted} odds salvas.`);

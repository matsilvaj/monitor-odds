import { collectAllBookmakers } from "../bookmakers/registry.js";
import { cleanupOldLogs } from "../services/log-retention.js";
import { captureBet365Session } from "./bet365-session.js";

try {
  await cleanupOldLogs();
  console.log("[sync] atualizando sessao Bet365...");
  await captureBet365Session();
  console.log("[sync] sessao Bet365 atualizada.");
  const bookmakers = await collectAllBookmakers();
  console.log(JSON.stringify({ bookmakers }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

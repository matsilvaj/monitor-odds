import { collectAllBookmakers } from "../bookmakers/registry.js";
import { cleanupOldLogs } from "../services/log-retention.js";

try {
  await cleanupOldLogs();
  await collectAllBookmakers();
  console.log("[sync] sync:odds finalizado.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

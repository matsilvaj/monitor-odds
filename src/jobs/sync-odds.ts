import { collectAllBookmakers } from "../bookmakers/registry.js";
import { cleanupOldLogs } from "../services/log-retention.js";

try {
  await cleanupOldLogs();
  const bookmakers = await collectAllBookmakers();
  console.log(JSON.stringify({ bookmakers }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

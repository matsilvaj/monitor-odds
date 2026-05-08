import { syncApiFootballFixtures } from "../services/api-football-sync.js";
import { collectAllBookmakers } from "../bookmakers/registry.js";
import { cleanupOldLogs } from "../services/log-retention.js";

try {
  await cleanupOldLogs();
  const fixtures = await syncApiFootballFixtures();
  const odds = await collectAllBookmakers();
  console.log(JSON.stringify({ fixtures, odds }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

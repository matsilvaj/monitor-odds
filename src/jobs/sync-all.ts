import { syncApiFootballFixtures } from "../services/api-football-sync.js";
import { collectAllBookmakers } from "../bookmakers/registry.js";
import { formatFixtureSyncSummary } from "../services/sync-report.js";

try {
  console.log("[sync] Sincronizando jogos via API-Football...");
  const fixtures = await syncApiFootballFixtures();
  console.log(formatFixtureSyncSummary(fixtures));
  await collectAllBookmakers();
  console.log("[sync] sync:all finalizado.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

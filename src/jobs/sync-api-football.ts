import { syncApiFootballFixtures } from "../services/api-football-sync.js";
import { formatFixtureSyncSummary } from "../services/sync-report.js";

try {
  console.log("[sync] Sincronizando jogos via API-Football...");
  const summary = await syncApiFootballFixtures();
  console.log(formatFixtureSyncSummary(summary));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

import { syncApiFootballFixtures } from "../services/api-football-sync.js";

try {
  const summary = await syncApiFootballFixtures();
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

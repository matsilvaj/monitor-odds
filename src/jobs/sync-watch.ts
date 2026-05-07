import { collectAllBookmakers } from "../bookmakers/registry.js";
import { supabase } from "../db/supabase.js";
import { syncApiFootballFixtures } from "../services/api-football-sync.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function nextIntervalMs(minutesToNextFixture: number | null) {
  if (minutesToNextFixture === null) return 60 * 60 * 1000;
  if (minutesToNextFixture <= 3 * 60) return 60 * 1000;
  if (minutesToNextFixture <= 6 * 60) return 15 * 60 * 1000;
  if (minutesToNextFixture <= 24 * 60) return 30 * 60 * 1000;
  return 60 * 60 * 1000;
}

function formatMs(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return `${minutes}m`;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function getMinutesToNextFixture() {
  const { data, error } = await supabase
    .from("fixtures")
    .select("starts_at")
    .gt("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.starts_at) return null;

  return Math.max(0, (new Date(data.starts_at).getTime() - Date.now()) / 60000);
}

console.log("sync:watch iniciado. Ctrl+C para parar.");
let lastFixtureSyncDate: string | null = null;

while (true) {
  const startedAt = new Date();
  const todayKey = localDateKey(startedAt);
  console.log(`[${startedAt.toISOString()}] sincronizando odds${lastFixtureSyncDate === todayKey ? "" : " e fixtures"}...`);

  const fixtures = lastFixtureSyncDate === todayKey ? { skippedByWatchDate: true } : await syncApiFootballFixtures();
  lastFixtureSyncDate = todayKey;
  const bookmakers = await collectAllBookmakers();
  const minutesToNext = await getMinutesToNextFixture();
  const waitMs = nextIntervalMs(minutesToNext);

  console.log(
    JSON.stringify(
      {
        fixtures,
        bookmakers,
        nextFixtureInMinutes: minutesToNext === null ? null : Math.round(minutesToNext),
        nextRunIn: formatMs(waitMs)
      },
      null,
      2
    )
  );

  await sleep(waitMs);
}

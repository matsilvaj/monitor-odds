import { collectBrowserBookmakers, collectFastBookmakers } from "../bookmakers/registry.js";
import { cleanupOldLogs } from "../services/log-retention.js";
import { syncApiFootballFixtures, type SyncApiFootballFixturesOptions } from "../services/api-football-sync.js";
import { formatFixtureSyncSummary } from "../services/sync-report.js";

const LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MIN_MIDNIGHT_SYNC_DELAY_MS = 1000;

function nextLocalMidnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

function tomorrowLocalDate(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

let fixtureSyncInFlight: Promise<void> | null = null;

async function runFixtureSync(label: string, options: SyncApiFootballFixturesOptions = {}) {
  if (fixtureSyncInFlight) {
    console.log(`[sync] API-Football ja esta sincronizando; aguardando para ${label}.`);
    await fixtureSyncInFlight;
  }

  const syncPromise = (async () => {
    console.log(`[sync] Sincronizando jogos via API-Football (${label})...`);
    const fixtures = await syncApiFootballFixtures(options);
    console.log(formatFixtureSyncSummary(fixtures));
  })();

  fixtureSyncInFlight = syncPromise;

  try {
    await syncPromise;
  } finally {
    if (fixtureSyncInFlight === syncPromise) fixtureSyncInFlight = null;
  }
}

function scheduleMidnightFixtureSync() {
  const nextMidnight = nextLocalMidnight();
  const delayMs = Math.max(MIN_MIDNIGHT_SYNC_DELAY_MS, nextMidnight.getTime() - Date.now());
  console.log(`[sync] API-Football: proxima atualizacao de amanha em ${nextMidnight.toLocaleString("pt-BR")}.`);

  setTimeout(() => {
    void runFixtureSync("virada do dia", {
      dates: [tomorrowLocalDate()],
      cleanupStarted: false,
      force: true
    })
      .catch((error) => {
        console.error("[sync] Falha na atualizacao de amanha pela API-Football.", error);
      })
      .finally(scheduleMidnightFixtureSync);
  }, delayMs);
}

console.log("sync:watch iniciado. Ctrl+C para parar.");
let lastLogCleanupAt = 0;

await runFixtureSync("inicial");
scheduleMidnightFixtureSync();

async function runFastBookmakerLoop() {
  while (true) {
    const startedAt = new Date();
    console.log(`[sync] Ciclo das casas rapidas iniciado as ${startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`);

    if (startedAt.getTime() - lastLogCleanupAt >= LOG_CLEANUP_INTERVAL_MS) {
      console.log("[sync] Limpando logs antigos...");
      await cleanupOldLogs();
      lastLogCleanupAt = startedAt.getTime();
    }

    await collectFastBookmakers({ concurrency: 3, logProgress: true, trigger: "watch", force: true });
    console.log("[sync] Ciclo das casas rapidas finalizado. Reiniciando imediatamente.");
  }
}

async function runBrowserBookmakerLoop() {
  while (true) {
    const startedAt = new Date();
    console.log(`[sync] Ciclo das casas com navegador iniciado as ${startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`);
    await collectBrowserBookmakers({ logProgress: true, trigger: "watch", force: true, cleanupStarted: false });
    console.log("[sync] Ciclo das casas com navegador finalizado. Reiniciando imediatamente.");
  }
}

await Promise.all([runFastBookmakerLoop(), runBrowserBookmakerLoop()]);

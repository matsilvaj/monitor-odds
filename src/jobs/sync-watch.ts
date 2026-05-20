import { collectBookmakerBySlug, collectFastBookmakers } from "../bookmakers/registry.js";
import { syncApiFootballFixtures, type SyncApiFootballFixturesOptions } from "../services/api-football-sync.js";
import { formatFixtureSyncSummary } from "../services/sync-report.js";

const MIN_MIDNIGHT_SYNC_DELAY_MS = 1000;
const WATCH_LOOP_PAUSE_MS = 2000;
const BROWSER_BOOKMAKER_LOOPS = [
  { slug: "bet365", name: "bet365" },
  { slug: "meridianbet", name: "Meridian" }
] as const;

function nextLocalMidnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

function tomorrowLocalDate(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

await runFixtureSync("inicial");
scheduleMidnightFixtureSync();

async function runFastBookmakerLoop() {
  while (true) {
    const startedAt = new Date();
    console.log(`[sync] Ciclo das casas rapidas iniciado as ${startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`);

    await collectFastBookmakers({ concurrency: 3, logProgress: true, trigger: "watch" });
    console.log("[sync] Ciclo das casas rapidas finalizado. Proximo ciclo em 2s.");
    await sleep(WATCH_LOOP_PAUSE_MS);
  }
}

async function runBrowserBookmakerLoop(bookmaker: (typeof BROWSER_BOOKMAKER_LOOPS)[number]) {
  while (true) {
    const startedAt = new Date();
    console.log(
      `[sync] Ciclo da ${bookmaker.name} iniciado as ${startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`
    );
    await collectBookmakerBySlug(bookmaker.slug, { logProgress: true, trigger: "watch", cleanupStarted: false });
    console.log(`[sync] Ciclo da ${bookmaker.name} finalizado. Proximo ciclo em 2s.`);
    await sleep(WATCH_LOOP_PAUSE_MS);
  }
}

await Promise.all([runFastBookmakerLoop(), ...BROWSER_BOOKMAKER_LOOPS.map((bookmaker) => runBrowserBookmakerLoop(bookmaker))]);

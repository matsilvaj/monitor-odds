import { installProcessErrorHandlers } from "../utils/process-errors.js";
import { collectBookmakerBySlug, collectFastBookmakers } from "../bookmakers/registry.js";
import { syncApiFootballFixtures, type SyncApiFootballFixturesOptions } from "../services/api-football-sync.js";
import { formatFixtureSyncSummary } from "../services/sync-report.js";

installProcessErrorHandlers();

const MIN_MIDNIGHT_SYNC_DELAY_MS = 1000;
const WATCH_LOOP_PAUSE_MS = 2000;
const BROWSER_BOOKMAKER_LOOPS = [
  { slug: "bet365", name: "bet365" },
  { slug: "meridianbet", name: "Meridian" }
] as const;

let shutdownRequested = false;
let resolveShutdown: (() => void) | null = null;
let midnightFixtureSyncTimer: ReturnType<typeof setTimeout> | null = null;
const shutdownPromise = new Promise<void>((resolve) => {
  resolveShutdown = resolve;
});

function requestShutdown(source: string) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  if (midnightFixtureSyncTimer) clearTimeout(midnightFixtureSyncTimer);
  console.log(`[sync] Encerramento solicitado por ${source}. Finalizando com segurança...`);
  resolveShutdown?.();
}

function nextLocalMidnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

function tomorrowLocalDate(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

function sleep(ms: number) {
  if (shutdownRequested) return Promise.resolve();
  return Promise.race([new Promise((resolve) => setTimeout(resolve, ms)), shutdownPromise]);
}

let fixtureSyncInFlight: Promise<void> | null = null;

async function runFixtureSync(label: string, options: SyncApiFootballFixturesOptions = {}) {
  if (fixtureSyncInFlight) {
    console.log(`[sync] API-Football já está sincronizando; aguardando para ${label}.`);
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
  if (shutdownRequested) return;

  const nextMidnight = nextLocalMidnight();
  const delayMs = Math.max(MIN_MIDNIGHT_SYNC_DELAY_MS, nextMidnight.getTime() - Date.now());
  console.log(`[sync] API-Football: próxima atualização de amanhã em ${nextMidnight.toLocaleString("pt-BR")}.`);

  midnightFixtureSyncTimer = setTimeout(() => {
    midnightFixtureSyncTimer = null;
    if (shutdownRequested) return;

    void runFixtureSync("virada do dia", {
      dates: [tomorrowLocalDate()],
      cleanupStarted: false,
      force: true
    })
      .catch((error) => {
        console.error("[sync] Falha na atualização de amanhã pela API-Football.", error);
      })
      .finally(scheduleMidnightFixtureSync);
  }, delayMs);
}

process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "type" in message && message.type === "shutdown") {
    requestShutdown("aplicativo");
  }
});
process.once("SIGINT", () => requestShutdown("Ctrl+C"));
process.once("SIGTERM", () => requestShutdown("sistema"));

console.log("sync:watch iniciado. Ctrl+C para parar.");

await runFixtureSync("inicial").catch((error) => {
  console.error("[sync] Falha na sincronizacao inicial da API-Football.", error);
});
scheduleMidnightFixtureSync();

async function runFastBookmakerLoop() {
  while (!shutdownRequested) {
    const startedAt = new Date();
    console.log(`[sync] Ciclo das casas rápidas iniciado às ${startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`);

    try {
      await collectFastBookmakers({ concurrency: 3, logProgress: true, trigger: "watch" });
    } catch (error) {
      console.error("[sync] Falha no ciclo das casas rapidas.", error);
    }

    if (shutdownRequested) break;

    console.log("[sync] Ciclo das casas rápidas finalizado. Próximo ciclo em 2s.");
    await sleep(WATCH_LOOP_PAUSE_MS);
  }
}

async function runBrowserBookmakerLoop(bookmaker: (typeof BROWSER_BOOKMAKER_LOOPS)[number]) {
  while (!shutdownRequested) {
    const startedAt = new Date();
    console.log(
      `[sync] Ciclo da ${bookmaker.name} iniciado às ${startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`
    );
    try {
      await collectBookmakerBySlug(bookmaker.slug, { logProgress: true, trigger: "watch", cleanupStarted: false });
    } catch (error) {
      console.error(`[sync] Falha no ciclo da ${bookmaker.name}.`, error);
    }

    if (shutdownRequested) break;

    console.log(`[sync] Ciclo da ${bookmaker.name} finalizado. Próximo ciclo em 2s.`);
    await sleep(WATCH_LOOP_PAUSE_MS);
  }
}

await Promise.all([runFastBookmakerLoop(), ...BROWSER_BOOKMAKER_LOOPS.map((bookmaker) => runBrowserBookmakerLoop(bookmaker))]);
console.log("[sync] Monitor encerrado com segurança.");

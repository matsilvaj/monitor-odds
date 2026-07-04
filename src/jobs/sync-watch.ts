import { BOOKMAKER_COLLECTORS, collectBookmakerBySlug, collectFastBookmakers } from "../bookmakers/registry.js";
import { syncApiFootballFixtures, type SyncApiFootballFixturesOptions } from "../services/api-football-sync.js";
import { formatFixtureSyncSummary } from "../services/sync-report.js";
import { installProcessErrorHandlers } from "../utils/process-errors.js";

installProcessErrorHandlers();

const MIN_MIDNIGHT_SYNC_DELAY_MS = 1000;
const WATCH_LOOP_PAUSE_MS = 2000;

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

type WatchLoop = {
  label: string;
  collect: () => Promise<unknown>;
};

function hasEnabledBookmaker(slug: string) {
  return BOOKMAKER_COLLECTORS.some((bookmaker) => bookmaker.slug === slug);
}

async function runBookmakerLoop(loop: WatchLoop) {
  while (!shutdownRequested) {
    const startedAt = new Date();
    console.log(
      `[sync:${loop.label}] Ciclo iniciado as ${startedAt.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })}.`
    );

    try {
      await loop.collect();
    } catch (error) {
      console.error(`[sync:${loop.label}] Falha no ciclo.`, error);
    }

    if (shutdownRequested) break;

    console.log(`[sync:${loop.label}] Ciclo finalizado. Proximo ciclo em 2s.`);
    await sleep(WATCH_LOOP_PAUSE_MS);
  }
}

const watchLoops: WatchLoop[] = [
  {
    label: "rapidas",
    collect: () => collectFastBookmakers({ concurrency: 3, logProgress: true, trigger: "watch" })
  }
];

if (hasEnabledBookmaker("bet365")) {
  watchLoops.push({
    label: "bet365",
    collect: () => collectBookmakerBySlug("bet365", { concurrency: 1, logProgress: true, trigger: "watch" })
  });
} else {
  console.log("[sync:bet365] Casa desabilitada; loop nao iniciado.");
}

if (hasEnabledBookmaker("meridianbet")) {
  watchLoops.push({
    label: "meridianbet",
    collect: () => collectBookmakerBySlug("meridianbet", { concurrency: 1, logProgress: true, trigger: "watch" })
  });
} else {
  console.log("[sync:meridianbet] Casa desabilitada; loop nao iniciado.");
}

console.log(`[sync] Loops independentes iniciados: ${watchLoops.map((loop) => loop.label).join(", ")}.`);
await Promise.all(watchLoops.map((loop) => runBookmakerLoop(loop)));
console.log("[sync] Monitor encerrado com segurança.");

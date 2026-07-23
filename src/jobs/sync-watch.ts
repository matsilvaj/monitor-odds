import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOKMAKER_COLLECTORS } from "../bookmakers/registry.js";
import { supabase } from "../db/supabase.js";
import { syncApiFootballFixtures, type SyncApiFootballFixturesOptions } from "../services/api-football-sync.js";
import { formatFixtureSyncSummary } from "../services/sync-report.js";
import { errorMessage } from "../utils/errors.js";
import { installProcessErrorHandlers } from "../utils/process-errors.js";
import { parseSyncWatchEventLine, type SyncWatchWorkerEvent, type WatchLane } from "./sync-watch-events.js";

installProcessErrorHandlers();

const MIN_MIDNIGHT_SYNC_DELAY_MS = 1000;
const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const runningFromSource = currentFile.endsWith(".ts") || currentFile.includes(`${path.sep}src${path.sep}`);

function numberEnv(name: string, fallback: number, min: number) {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.trunc(parsed));
}

function booleanEnv(name: string) {
  const value = process.env[name];
  return value === "1" || value === "true";
}

const SMOKE_MODE = booleanEnv("SYNC_WATCH_SMOKE_MODE");
const SKIP_FIXTURE_SYNC = booleanEnv("SYNC_WATCH_SKIP_FIXTURE_SYNC") || SMOKE_MODE;
const SMOKE_EXIT_AFTER_MS = SMOKE_MODE ? numberEnv("SYNC_WATCH_SMOKE_EXIT_AFTER_MS", 0, 0) : 0;
const WATCH_LOOP_PAUSE_MS = numberEnv("SYNC_WATCH_LOOP_PAUSE_MS", 15_000, 1_000);
const WORKER_HEARTBEAT_MS = numberEnv("WATCHDOG_WORKER_HEARTBEAT_MS", 15_000, 1_000);
const WATCHDOG_CHECK_MS = numberEnv("WATCHDOG_CHECK_MS", 15_000, 1_000);
const HEARTBEAT_STALE_MS = numberEnv("WATCHDOG_HEARTBEAT_STALE_MS", Math.max(WORKER_HEARTBEAT_MS * 4, 90_000), 10_000);
const WORKER_SHUTDOWN_TIMEOUT_MS = numberEnv("WATCHDOG_WORKER_SHUTDOWN_TIMEOUT_MS", 10_000, 1_000);
const RESTART_COOLDOWN_MS = numberEnv("WATCHDOG_RESTART_COOLDOWN_MS", 5_000, 1_000);
const RESTART_WINDOW_MS = numberEnv("WATCHDOG_RESTART_WINDOW_MS", 30 * 60_000, 60_000);
const MAX_RESTARTS_PER_WINDOW = numberEnv("WATCHDOG_MAX_RESTARTS_PER_WINDOW", 5, 1);

type LaneConfig = {
  lane: WatchLane;
  label: string;
  enabled: boolean;
  cycleTimeoutMs: number;
};

type WorkerState = {
  config: LaneConfig;
  process: ChildProcess | null;
  status: "stopped" | "starting" | "running" | "restarting" | "paused";
  startedAt: number | null;
  lastHeartbeatAt: number | null;
  lastCycleFinishedAt: number | null;
  cycleStartedAt: number | null;
  currentCycle: number;
  stopRequested: boolean;
  restartInProgress: boolean;
  restartHistory: number[];
  pausedUntil: number | null;
};

let shutdownRequested = false;
let resolveShutdown: (() => void) | null = null;
let midnightFixtureSyncTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
const shutdownPromise = new Promise<void>((resolve) => {
  resolveShutdown = resolve;
});

let fixtureSyncInFlight: Promise<void> | null = null;

function requestShutdown(source: string) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  if (midnightFixtureSyncTimer) clearTimeout(midnightFixtureSyncTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  console.log(`[sync] Encerramento solicitado por ${source}. Finalizando com segurança...`);
  resolveShutdown?.();
}

function sleep(ms: number) {
  if (shutdownRequested) return Promise.resolve();
  return Promise.race([new Promise((resolve) => setTimeout(resolve, ms)), shutdownPromise]);
}

function nextLocalMidnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

function tomorrowLocalDate(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

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

function hasEnabledBookmaker(slug: string) {
  return BOOKMAKER_COLLECTORS.some((bookmaker) => bookmaker.slug === slug);
}

const laneConfigs: LaneConfig[] = [
  {
    lane: "fast",
    label: "rapidas",
    enabled: true,
    cycleTimeoutMs: numberEnv("WATCHDOG_FAST_CYCLE_TIMEOUT_MS", 25 * 60_000, 60_000)
  },
  {
    lane: "meridianbet",
    label: "meridianbet",
    enabled: SMOKE_MODE || hasEnabledBookmaker("meridianbet"),
    cycleTimeoutMs: numberEnv("WATCHDOG_MERIDIAN_CYCLE_TIMEOUT_MS", 45 * 60_000, 60_000)
  },
  {
    lane: "bet365",
    label: "bet365",
    enabled: SMOKE_MODE || hasEnabledBookmaker("bet365"),
    cycleTimeoutMs: numberEnv("WATCHDOG_BET365_CYCLE_TIMEOUT_MS", 45 * 60_000, 60_000)
  }
];

const workerStates = laneConfigs.map(
  (config): WorkerState => ({
    config,
    process: null,
    status: config.enabled ? "stopped" : "paused",
    startedAt: null,
    lastHeartbeatAt: null,
    lastCycleFinishedAt: null,
    cycleStartedAt: null,
    currentCycle: 0,
    stopRequested: false,
    restartInProgress: false,
    restartHistory: [],
    pausedUntil: null
  })
);

function workerRunConfig(lane: WatchLane) {
  if (runningFromSource) {
    return {
      command: process.execPath,
      args: ["--import", "tsx", path.join(currentDir, "sync-watch-worker.ts"), `--lane=${lane}`],
      usesIpc: true
    };
  }

  return {
    command: process.execPath,
    args: [path.join(currentDir, "sync-watch-worker.js"), `--lane=${lane}`],
    usesIpc: true
  };
}

function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes}m${String(remainingSeconds).padStart(2, "0")}s` : `${minutes}m`;
}

function restartWindowText() {
  return formatDuration(RESTART_WINDOW_MS);
}

function attachWorkerOutput(state: WorkerState, stream: NodeJS.ReadableStream | null, isError: boolean) {
  if (!stream) return;
  let buffer = "";

  const flushLine = (line: string) => {
    const event = parseSyncWatchEventLine(line);
    if (event) {
      handleWorkerEvent(state, event);
      return;
    }

    if (!line.trim()) return;
    const method = isError ? console.error : console.log;
    method(line);
  };

  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) flushLine(line);
  });

  stream.on("close", () => {
    if (buffer.trim()) flushLine(buffer);
    buffer = "";
  });
}

function handleWorkerEvent(state: WorkerState, event: SyncWatchWorkerEvent) {
  if (event.lane !== state.config.lane) return;

  const now = Date.now();

  if (event.type === "worker-started") {
    state.status = "running";
    state.startedAt = now;
    state.lastHeartbeatAt = now;
    console.log(`[sync:${state.config.label}] Worker pronto (pid ${event.pid}).`);
    return;
  }

  if (event.type === "worker-disabled") {
    state.status = "stopped";
    state.cycleStartedAt = null;
    console.log(`[sync:${state.config.label}] Worker encerrado porque a casa está desabilitada.`);
    return;
  }

  if (event.type === "heartbeat") {
    state.lastHeartbeatAt = now;
    if (typeof event.cycle === "number") state.currentCycle = event.cycle;
    return;
  }

  if (event.type === "cycle-started") {
    state.status = "running";
    state.lastHeartbeatAt = now;
    state.cycleStartedAt = now;
    state.currentCycle = event.cycle ?? state.currentCycle;
    console.log(`[sync:${state.config.label}] Ciclo ${state.currentCycle} iniciado.`);
    return;
  }

  if (event.type === "cycle-finished") {
    state.status = "running";
    state.lastHeartbeatAt = now;
    state.lastCycleFinishedAt = now;
    state.cycleStartedAt = null;
    state.currentCycle = event.cycle ?? state.currentCycle;

    const duration = typeof event.durationMs === "number" ? formatDuration(event.durationMs) : "tempo indefinido";
    if (event.ok === false) {
      console.warn(`[sync:${state.config.label}] Ciclo ${state.currentCycle} finalizado com erro em ${duration}: ${event.error ?? "erro desconhecido"}.`);
    } else {
      console.log(`[sync:${state.config.label}] Ciclo ${state.currentCycle} finalizado em ${duration}. Próximo ciclo em ${formatDuration(WATCH_LOOP_PAUSE_MS)}.`);
    }
    return;
  }

  if (event.type === "shutdown-requested") {
    console.log(`[sync:${state.config.label}] Shutdown solicitado ao worker por ${event.source ?? "supervisor"}.`);
    return;
  }

  if (event.type === "worker-stopped") {
    state.status = state.stopRequested || shutdownRequested ? "stopped" : state.status;
    state.cycleStartedAt = null;
  }
}

function startWorker(state: WorkerState) {
  if (shutdownRequested || !state.config.enabled || state.process) return;

  const run = workerRunConfig(state.config.lane);
  const stdio: StdioOptions = run.usesIpc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"];
  const child = spawn(run.command, run.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SYNC_WATCH_WORKER_HEARTBEAT_MS: String(WORKER_HEARTBEAT_MS),
      SYNC_WATCH_EVENT_STDOUT: run.usesIpc ? "0" : "1"
    },
    windowsHide: true,
    stdio
  });

  state.process = child;
  state.status = "starting";
  state.startedAt = Date.now();
  state.lastHeartbeatAt = Date.now();
  state.lastCycleFinishedAt = null;
  state.cycleStartedAt = null;
  state.currentCycle = 0;
  state.stopRequested = false;

  console.log(`[sync:${state.config.label}] Worker iniciado (pid ${child.pid ?? "?"}).`);

  attachWorkerOutput(state, child.stdout, false);
  attachWorkerOutput(state, child.stderr, true);

  child.on("message", (message) => {
    if (message && typeof message === "object" && "type" in message) {
      handleWorkerEvent(state, message as SyncWatchWorkerEvent);
    }
  });

  child.on("error", (error) => {
    console.error(`[sync:${state.config.label}] Falha ao iniciar worker: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    const expectedExit = shutdownRequested || state.stopRequested;
    const exitText = signal ? `sinal ${signal}` : `código ${code ?? "desconhecido"}`;
    state.process = null;
    state.cycleStartedAt = null;
    state.lastHeartbeatAt = null;
    state.status = expectedExit ? "stopped" : "stopped";

    if (expectedExit) {
      console.log(`[sync:${state.config.label}] Worker encerrado (${exitText}).`);
      return;
    }

    console.warn(`[sync:${state.config.label}] Worker saiu inesperadamente (${exitText}).`);
    void restartWorker(state, `worker saiu inesperadamente (${exitText})`);
  });
}

function requestWorkerShutdown(child: ChildProcess) {
  if (typeof child.send === "function" && child.connected) {
    try {
      child.send({ type: "shutdown" });
      return true;
    } catch {
      return false;
    }
  }

  if (process.platform === "win32") {
    return false;
  }

  try {
    child.kill("SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => cleanup(false), timeoutMs);
    const cleanup = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(exited);
    };
    const onExit = () => cleanup(true);
    const onError = () => cleanup(true);

    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function killProcessTree(child: ChildProcess) {
  if (!child.pid) return;

  if (process.platform !== "win32") {
    child.kill("SIGKILL");
    return;
  }

  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => resolve());
    killer.on("exit", () => resolve());
  });
}

async function resetLaneCollectionState(lane: WatchLane) {
  if (lane === "fast" || SMOKE_MODE) return;

  const { error } = await supabase
    .from("bookmaker_collection_state")
    .update({
      status: "idle",
      lease_until: null,
      updated_at: new Date().toISOString()
    })
    .eq("bookmaker_slug", lane);

  if (error) {
    console.warn(`[sync:${lane}] Não consegui limpar o estado da coleta após restart: ${error.message}`);
  }
}

async function resetBrowserCollectionStates() {
  await Promise.all(laneConfigs.filter((config) => config.lane !== "fast" && config.enabled).map((config) => resetLaneCollectionState(config.lane)));
}

async function stopWorker(state: WorkerState, source: string) {
  const child = state.process;
  if (!child) {
    state.status = state.pausedUntil ? "paused" : "stopped";
    state.cycleStartedAt = null;
    return;
  }

  state.stopRequested = true;
  const gracefulRequested = requestWorkerShutdown(child);
  const exited = gracefulRequested ? await waitForProcessExit(child, WORKER_SHUTDOWN_TIMEOUT_MS) : false;

  if (!exited) {
    console.warn(`[watchdog:${state.config.label}] Worker não encerrou após ${formatDuration(WORKER_SHUTDOWN_TIMEOUT_MS)}; encerrando árvore do processo (${source}).`);
    await killProcessTree(child);
    await waitForProcessExit(child, 2_000);
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
  if (typeof child.disconnect === "function" && child.connected) {
    child.disconnect();
  }
  child.removeAllListeners();
  state.process = null;
  state.cycleStartedAt = null;
  state.lastHeartbeatAt = null;
  state.status = state.pausedUntil ? "paused" : "stopped";
}

function pruneRestartHistory(state: WorkerState, now: number) {
  state.restartHistory = state.restartHistory.filter((timestamp) => now - timestamp <= RESTART_WINDOW_MS);
}

async function restartWorker(state: WorkerState, reason: string) {
  if (shutdownRequested || state.restartInProgress || !state.config.enabled) return;

  state.restartInProgress = true;
  state.status = "restarting";

  const now = Date.now();
  pruneRestartHistory(state, now);

  if (state.restartHistory.length >= MAX_RESTARTS_PER_WINDOW) {
    state.pausedUntil = now + RESTART_WINDOW_MS;
    console.error(
      `[watchdog:${state.config.label}] ${reason}. Limite de ${MAX_RESTARTS_PER_WINDOW} reinícios em ${restartWindowText()} atingido; raia pausada até ${new Date(
        state.pausedUntil
      ).toLocaleTimeString("pt-BR")}.`
    );
    await stopWorker(state, "limite de reinícios");
    await resetLaneCollectionState(state.config.lane);
    state.restartInProgress = false;
    state.status = "paused";
    return;
  }

  state.restartHistory.push(now);
  const cooldownMs = RESTART_COOLDOWN_MS * Math.min(state.restartHistory.length, 6);
  console.warn(`[watchdog:${state.config.label}] ${reason}. Reiniciando raia em ${formatDuration(cooldownMs)}.`);

  await stopWorker(state, "watchdog");
  await resetLaneCollectionState(state.config.lane);
  await sleep(cooldownMs);

  state.restartInProgress = false;
  if (!shutdownRequested) startWorker(state);
}

function checkWorkers() {
  if (shutdownRequested) return;
  const now = Date.now();

  for (const state of workerStates) {
    if (!state.config.enabled) continue;

    if (state.pausedUntil) {
      if (now < state.pausedUntil) continue;
      state.pausedUntil = null;
      state.status = "stopped";
      console.log(`[watchdog:${state.config.label}] Janela de pausa encerrada; tentando subir a raia novamente.`);
    }

    if (!state.process) {
      if (!state.restartInProgress) startWorker(state);
      continue;
    }

    if (state.restartInProgress || state.stopRequested) continue;

    if (state.lastHeartbeatAt && now - state.lastHeartbeatAt > HEARTBEAT_STALE_MS) {
      void restartWorker(state, `sem heartbeat há ${formatDuration(now - state.lastHeartbeatAt)}`);
      continue;
    }

    if (state.cycleStartedAt && now - state.cycleStartedAt > state.config.cycleTimeoutMs) {
      void restartWorker(state, `ciclo ${state.currentCycle || "atual"} travado há ${formatDuration(now - state.cycleStartedAt)}`);
    }
  }
}

process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "type" in message && message.type === "shutdown") {
    requestShutdown("aplicativo");
  }
});
process.once("SIGINT", () => requestShutdown("Ctrl+C"));
process.once("SIGTERM", () => requestShutdown("sistema"));

console.log("sync:watch iniciado. Ctrl+C para parar.");

if (SKIP_FIXTURE_SYNC) {
  console.log("[sync] Sincronização API-Football pulada por modo de teste.");
} else {
  await runFixtureSync("inicial").catch((error) => {
    console.error("[sync] Falha na sincronizacao inicial da API-Football.", error);
  });
  scheduleMidnightFixtureSync();
}

if (SMOKE_EXIT_AFTER_MS > 0) {
  setTimeout(() => requestShutdown("smoke test"), SMOKE_EXIT_AFTER_MS);
}

await resetBrowserCollectionStates().catch((error) => {
  console.warn(`[sync] Não consegui limpar o estado inicial das coletas de navegador: ${errorMessage(error)}`);
});

for (const config of laneConfigs) {
  if (!config.enabled) console.log(`[sync:${config.label}] Casa desabilitada; worker não iniciado.`);
}

const enabledStates = workerStates.filter((state) => state.config.enabled);
for (const state of enabledStates) startWorker(state);

console.log(`[sync] Workers supervisionados iniciados: ${enabledStates.map((state) => state.config.label).join(", ")}.`);
console.log(
  `[watchdog] Heartbeat limite: ${formatDuration(HEARTBEAT_STALE_MS)} | timeouts: ${laneConfigs
    .filter((config) => config.enabled)
    .map((config) => `${config.label}=${formatDuration(config.cycleTimeoutMs)}`)
    .join(", ")}.`
);

watchdogTimer = setInterval(checkWorkers, WATCHDOG_CHECK_MS);

await shutdownPromise;

await Promise.all(workerStates.map((state) => stopWorker(state, "shutdown")));
await resetBrowserCollectionStates().catch((error) => {
  console.warn(`[sync] Não consegui limpar o estado final das coletas de navegador: ${errorMessage(error)}`);
});

console.log("[sync] Monitor encerrado com segurança.");

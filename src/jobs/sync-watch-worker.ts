import { BOOKMAKER_COLLECTORS, collectBookmakerBySlug, collectFastBookmakers } from "../bookmakers/registry.js";
import { errorMessage } from "../utils/errors.js";
import { installProcessErrorHandlers } from "../utils/process-errors.js";
import { isWatchLane, serializeSyncWatchEvent, type SyncWatchWorkerEvent, type WatchLane } from "./sync-watch-events.js";

installProcessErrorHandlers();

const WATCH_LOOP_PAUSE_MS = numberEnv("SYNC_WATCH_LOOP_PAUSE_MS", 15_000, 1_000);
const STARTED_FIXTURE_CLEANUP_INTERVAL_MS = numberEnv("SYNC_WATCH_CLEANUP_INTERVAL_MS", 60_000, 15_000);

let shutdownRequested = false;
let lastStartedFixtureCleanupAt = 0;
let resolveShutdown: (() => void) | null = null;
const shutdownPromise = new Promise<void>((resolve) => {
  resolveShutdown = resolve;
});

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

function parseLane() {
  for (const arg of process.argv.slice(2)) {
    const value = arg.startsWith("--lane=") ? arg.slice("--lane=".length) : arg;
    if (isWatchLane(value)) return value;
  }

  console.error("Informe a raia do worker: --lane=fast, --lane=meridianbet ou --lane=bet365.");
  process.exit(1);
}

const lane = parseLane();
const smokeMode = booleanEnv("SYNC_WATCH_SMOKE_MODE");
const heartbeatMs = numberEnv("SYNC_WATCH_WORKER_HEARTBEAT_MS", 15_000, 1_000);
const smokeWorkMs = numberEnv("SYNC_WATCH_SMOKE_WORK_MS", 250, 0);

function emitWorkerEvent(event: Omit<SyncWatchWorkerEvent, "at" | "lane" | "pid">) {
  const payload = {
    ...event,
    lane,
    pid: process.pid,
    at: new Date().toISOString()
  } satisfies SyncWatchWorkerEvent;

  if (typeof process.send === "function") {
    process.send(payload);
  }

  if (process.env.SYNC_WATCH_EVENT_STDOUT !== "0") {
    console.log(serializeSyncWatchEvent(payload));
  }
}

function requestShutdown(source: string) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  emitWorkerEvent({ type: "shutdown-requested", source });
  resolveShutdown?.();
}

function sleep(ms: number) {
  if (shutdownRequested) return Promise.resolve();
  return Promise.race([new Promise((resolve) => setTimeout(resolve, ms)), shutdownPromise]);
}

function hasEnabledBookmaker(slug: string) {
  return BOOKMAKER_COLLECTORS.some((bookmaker) => bookmaker.slug === slug);
}

async function collectLane(targetLane: WatchLane) {
  if (smokeMode) {
    console.log(`[sync:${targetLane}] Smoke cycle executado.`);
    await sleep(smokeWorkMs);
    return { smoke: true, lane: targetLane };
  }

  if (targetLane === "fast") {
    const now = Date.now();
    const cleanupStarted = now - lastStartedFixtureCleanupAt >= STARTED_FIXTURE_CLEANUP_INTERVAL_MS;
    if (cleanupStarted) lastStartedFixtureCleanupAt = now;
    return collectFastBookmakers({ concurrency: 3, logProgress: true, trigger: "watch", cleanupStarted });
  }

  return collectBookmakerBySlug(targetLane, { concurrency: 1, logProgress: true, trigger: "watch", cleanupStarted: false });
}

process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "type" in message && message.type === "shutdown") {
    requestShutdown("supervisor");
  }
});
process.once("SIGINT", () => requestShutdown("Ctrl+C"));
process.once("SIGTERM", () => requestShutdown("sistema"));

async function runWorker() {
  if (lane !== "fast" && !hasEnabledBookmaker(lane)) {
    console.log(`[sync:${lane}] Casa desabilitada; worker encerrado.`);
    emitWorkerEvent({ type: "worker-disabled" });
    return;
  }

  let cycle = 0;
  let running = false;

  emitWorkerEvent({ type: "worker-started", heartbeatMs });

  const heartbeatTimer = setInterval(() => {
    emitWorkerEvent({ type: "heartbeat", cycle, running });
  }, heartbeatMs);

  try {
    while (!shutdownRequested) {
      cycle += 1;
      running = true;
      const startedAt = performance.now();
      emitWorkerEvent({ type: "cycle-started", cycle, running });

      try {
        await collectLane(lane);
        emitWorkerEvent({ type: "cycle-finished", cycle, running: false, ok: true, durationMs: Math.round(performance.now() - startedAt) });
      } catch (error) {
        console.error(`[sync:${lane}] Falha no ciclo.`, error);
        emitWorkerEvent({
          type: "cycle-finished",
          cycle,
          running: false,
          ok: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: errorMessage(error)
        });
      } finally {
        running = false;
      }

      if (shutdownRequested) break;
      await sleep(WATCH_LOOP_PAUSE_MS);
    }
  } finally {
    clearInterval(heartbeatTimer);
    emitWorkerEvent({ type: "worker-stopped", cycle, running: false });
    if (typeof process.disconnect === "function" && process.connected) {
      process.disconnect();
    }
  }
}

await runWorker().catch((error) => {
  console.error(`[sync:${lane}] Worker encerrou com erro fatal.`, error);
  process.exitCode = 1;
});

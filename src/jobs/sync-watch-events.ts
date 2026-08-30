export const SYNC_WATCH_EVENT_PREFIX = "__SYNC_WATCH_EVENT__ ";

// "sportingbet" tem raia propria, igual bet365/meridianbet: foi a primeira casa rapida
// confirmada travando sob contencao das ~22 outras no mesmo processo — ficava congelada
// por horas mesmo com a API dela respondendo bem quando testada isolada.
//
// "fast-1"/"fast-2"/"fast-3" dividem as 21 casas rapidas restantes em 3 processos, para
// reduzir essa mesma contencao de CPU sem isolar casa por casa — ver
// FAST_LANE_PROVIDER_GROUPS em registry.ts para a composicao de cada grupo.
export const WATCH_LANES = ["fast-1", "fast-2", "fast-3", "meridianbet", "bet365", "sportingbet"] as const;

export type WatchLane = (typeof WATCH_LANES)[number];

export type SyncWatchWorkerEvent = {
  type:
    | "worker-started"
    | "worker-disabled"
    | "heartbeat"
    | "cycle-started"
    | "cycle-finished"
    | "bookmaker-result"
    | "shutdown-requested"
    | "worker-stopped";
  lane: WatchLane;
  pid: number;
  at: string;
  cycle?: number;
  running?: boolean;
  durationMs?: number;
  ok?: boolean;
  heartbeatMs?: number;
  source?: string;
  error?: string;
  bookmakerSlug?: string;
  today?: number;
  tomorrow?: number;
};

export function isWatchLane(value: unknown): value is WatchLane {
  return typeof value === "string" && WATCH_LANES.includes(value as WatchLane);
}

export function serializeSyncWatchEvent(event: SyncWatchWorkerEvent) {
  return `${SYNC_WATCH_EVENT_PREFIX}${JSON.stringify(event)}`;
}

export function parseSyncWatchEventLine(line: string): SyncWatchWorkerEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(SYNC_WATCH_EVENT_PREFIX)) return null;

  try {
    const event = JSON.parse(trimmed.slice(SYNC_WATCH_EVENT_PREFIX.length)) as Partial<SyncWatchWorkerEvent>;
    if (!event || typeof event !== "object") return null;
    if (typeof event.type !== "string" || !isWatchLane(event.lane) || typeof event.pid !== "number" || typeof event.at !== "string") return null;
    return event as SyncWatchWorkerEvent;
  } catch {
    return null;
  }
}

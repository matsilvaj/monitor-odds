export const SYNC_WATCH_EVENT_PREFIX = "__SYNC_WATCH_EVENT__ ";

export const WATCH_LANES = ["fast", "meridianbet", "bet365"] as const;

export type WatchLane = (typeof WATCH_LANES)[number];

export type SyncWatchWorkerEvent = {
  type:
    | "worker-started"
    | "worker-disabled"
    | "heartbeat"
    | "cycle-started"
    | "cycle-finished"
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

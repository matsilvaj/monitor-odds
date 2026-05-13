export type BookmakerCollectorResult = {
  bookmaker: string;
  summary: unknown;
  durationMs?: number;
  error?: unknown;
};

export type BookmakerCollectOptions = {
  date?: "today" | "tomorrow" | string;
  logToConsole?: boolean;
  manualFallback?: boolean;
  force?: boolean;
  trigger?: "manual" | "sync" | "watch";
};

export type BookmakerCollector = {
  slug: string;
  name: string;
  collect: (options?: BookmakerCollectOptions) => Promise<unknown>;
};

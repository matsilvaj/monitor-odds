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
  trigger?: "manual" | "sync" | "watch" | "recovery";
  fixtureIds?: string[];
  identityRecovery?: boolean;
};

export type BookmakerCollector = {
  slug: string;
  name: string;
  collect: (options?: BookmakerCollectOptions) => Promise<unknown>;
};

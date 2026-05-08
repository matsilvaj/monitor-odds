export type BookmakerCollectorResult = {
  bookmaker: string;
  summary: unknown;
  durationMs?: number;
  error?: unknown;
};

export type BookmakerCollector = {
  slug: string;
  name: string;
  collect: () => Promise<unknown>;
};

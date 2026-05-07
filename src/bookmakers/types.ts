export type BookmakerCollectorResult = {
  bookmaker: string;
  summary: unknown;
};

export type BookmakerCollector = {
  slug: string;
  name: string;
  collect: () => Promise<unknown>;
};

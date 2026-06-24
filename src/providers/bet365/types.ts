import type { PaCategory, Selection } from "../../domain/normalize.js";

export type Bet365FixtureTarget = {
  id: string;
  homeTeam: string | null;
  awayTeam: string | null;
  startsAt: string;
};

export type Bet365Selection = {
  selection: Selection;
  label: string;
  price: number;
  index: number;
};

export type Bet365Market = {
  marketName: string;
  paCategory: PaCategory;
  confidence: number;
  rawText: string;
  index: number;
  selections: Bet365Selection[];
};

export type Bet365Event = {
  externalEventId: number;
  sourceUrl: string;
  eventName: string;
  bookmakerHomeTeam: string | null;
  bookmakerAwayTeam: string | null;
  markets: Bet365Market[];
  rawText: string;
};

export type Bet365Page = {
  rawText: string;
  sourceUrl: string;
};

export type DiscoveryResult =
  | { found: true; page: Bet365Page }
  | { found: false; reason: string };

export type CollectResult =
  | { ok: true; page: Bet365Page }
  | { ok: false; reason: "nav-error" | "parse-error" | "timeout" };

export type Logger = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => Promise<void>;


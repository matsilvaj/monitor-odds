import type { BookmakerCollectorResult } from "../bookmakers/types.js";
import { supabase } from "../db/supabase.js";

export type SyncDateBucket = {
  key: string;
  label: "Hoje" | "Amanhã";
};

export type FixtureReport = {
  buckets: SyncDateBucket[];
  total: number;
  byDate: Map<string, { fixtures: number; fixtureIds: string[] }>;
  fixtureDateById: Map<string, string>;
};

export type BookmakerOddsReport = {
  totalGames: number;
  totalOdds: number;
  byDate: Map<string, { games: number; odds: number }>;
};

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultSyncDateBuckets(now = new Date()): SyncDateBucket[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  return [
    { key: localDateKey(today), label: "Hoje" },
    { key: localDateKey(tomorrow), label: "Amanhã" }
  ];
}

function countText(value: number, singular: string, plural: string) {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function formatDuration(ms: number | undefined) {
  if (!Number.isFinite(ms)) return "0s";
  const safeMs = Math.max(0, Math.round(ms ?? 0));
  const seconds = Math.round(safeMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatDateTime(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return null;

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }

  return 0;
}

function reasonText(reason: unknown) {
  switch (reason) {
    case "cadence-not-due":
      return "aguardando próxima janela";
    case "already-running":
      return "outra coleta ainda está em andamento";
    case "no-active-leagues":
      return "nenhuma liga ativa encontrada";
    case "no-future-fixtures":
      return "nenhum jogo futuro no banco";
    case "no-target-leagues-with-fixtures":
      return "nenhuma liga ativa com jogos nas datas alvo";
    default:
      return typeof reason === "string" && reason ? reason : "sem jogos para coletar agora";
  }
}

export async function getFixtureReport(buckets = defaultSyncDateBuckets()): Promise<FixtureReport> {
  const byDate = new Map<string, { fixtures: number; fixtureIds: string[] }>();
  const fixtureDateById = new Map<string, string>();
  for (const bucket of buckets) byDate.set(bucket.key, { fixtures: 0, fixtureIds: [] });

  const { data, error } = await supabase.from("fixtures").select("id,date_key").in(
    "date_key",
    buckets.map((bucket) => bucket.key)
  );

  if (error) throw error;

  for (const row of (data ?? []) as Array<{ id: string; date_key: string }>) {
    const key = String(row.date_key);
    const bucket = byDate.get(key);
    if (!bucket) continue;

    bucket.fixtures += 1;
    bucket.fixtureIds.push(row.id);
    fixtureDateById.set(row.id, key);
  }

  return {
    buckets,
    total: [...byDate.values()].reduce((total, item) => total + item.fixtures, 0),
    byDate,
    fixtureDateById
  };
}

export async function getBookmakerOddsReport(bookmakerSlug: string, fixtureReport: FixtureReport): Promise<BookmakerOddsReport> {
  const byDate = new Map<string, { games: number; odds: number }>();
  const gameIdsByDate = new Map<string, Set<string>>();
  for (const bucket of fixtureReport.buckets) {
    byDate.set(bucket.key, { games: 0, odds: 0 });
    gameIdsByDate.set(bucket.key, new Set<string>());
  }

  const fixtureIds = [...fixtureReport.fixtureDateById.keys()];
  if (!fixtureIds.length) {
    return { totalGames: 0, totalOdds: 0, byDate };
  }

  const { data, error } = await supabase
    .from("odds")
    .select("fixture_id")
    .eq("bookmaker_slug", bookmakerSlug)
    .eq("market_code", "1X2")
    .in("fixture_id", fixtureIds);

  if (error) throw error;

  for (const row of (data ?? []) as Array<{ fixture_id: string }>) {
    const dateKey = fixtureReport.fixtureDateById.get(row.fixture_id);
    if (!dateKey) continue;

    const bucket = byDate.get(dateKey);
    const gameIds = gameIdsByDate.get(dateKey);
    if (!bucket || !gameIds) continue;

    bucket.odds += 1;
    gameIds.add(row.fixture_id);
  }

  for (const [dateKey, gameIds] of gameIdsByDate) {
    const bucket = byDate.get(dateKey);
    if (bucket) bucket.games = gameIds.size;
  }

  return {
    totalGames: [...byDate.values()].reduce((total, item) => total + item.games, 0),
    totalOdds: [...byDate.values()].reduce((total, item) => total + item.odds, 0),
    byDate
  };
}

export function formatFixtureReportLines(report: FixtureReport, prefix = "[sync]") {
  return [
    `${prefix} Jogos no banco de dados: ${countText(report.total, "jogo", "jogos")}`,
    ...report.buckets.map((bucket) => {
      const item = report.byDate.get(bucket.key);
      return `${prefix} ${bucket.label}: ${countText(item?.fixtures ?? 0, "jogo", "jogos")}`;
    })
  ];
}

export function formatBookmakerStartLine(bookmakerSlug: string, fixtureReport: FixtureReport) {
  const byDate = fixtureReport.buckets
    .map((bucket) => {
      const item = fixtureReport.byDate.get(bucket.key);
      return `${bucket.label}: ${item?.fixtures ?? 0}`;
    })
    .join(" | ");

  return `[${bookmakerSlug}] Iniciando coleta. Jogos alvo: ${fixtureReport.total} (${byDate}).`;
}

export function formatBookmakerResultLines(result: BookmakerCollectorResult, report: BookmakerOddsReport) {
  const summary = asRecord(result.summary);
  const skipped = summary.skipped === true;
  const errors = numberField(summary, ["errors"]);
  const collected = numberField(summary, ["eventsCollected", "eventsMatched", "fixturesCollected"]);
  const oddsSaved = numberField(summary, ["oddsUpserted"]);
  const skippedItems =
    numberField(summary, ["eventsSkippedFresh"]) + numberField(summary, ["eventsSkippedStarted"]) + numberField(summary, ["leaguesSkipped"]);
  const nextRunAt = formatDateTime(summary.nextRunAt);

  const status = result.error
    ? `falhou em ${formatDuration(result.durationMs)}`
    : skipped
      ? `pulada em ${formatDuration(result.durationMs)}`
      : `finalizada em ${formatDuration(result.durationMs)}`;

  const lines = [
    `[${result.bookmaker}] Coleta ${status}.`,
    `[${result.bookmaker}] Jogos encontrados no banco: ${countText(report.totalGames, "jogo", "jogos")}`,
    ...[...report.byDate.entries()].map(([dateKey, item]) => {
      const bucket = defaultSyncDateBuckets().find((candidate) => candidate.key === dateKey);
      return `[${result.bookmaker}] ${bucket?.label ?? dateKey}: ${item.games} jogos | ${item.odds} odds`;
    })
  ];

  if (skipped) {
    lines.push(`[${result.bookmaker}] Motivo: ${reasonText(summary.skipReason)}${nextRunAt ? ` | Próxima coleta: ${nextRunAt}` : ""}.`);
  } else {
    lines.push(`[${result.bookmaker}] Nesta execução: ${collected} jogos coletados | ${oddsSaved} odds salvas | ${skippedItems} pulados | ${errors} erros.`);
  }

  if (result.error) {
    lines.push(`[${result.bookmaker}] Erro: ${String(result.error)}`);
  } else if (errors > 0 && typeof summary.lastError === "string" && summary.lastError) {
    lines.push(`[${result.bookmaker}] Último erro: ${summary.lastError}`);
  }

  return lines;
}

export function formatFixtureSyncSummary(summary: unknown) {
  const record = asRecord(summary);
  if (record.skippedByWatchDate) return "[sync] API-Football: já sincronizada hoje; pulando.";

  const seen = numberField(record, ["fixturesSeen"]);
  const kept = numberField(record, ["fixturesKept"]);
  const deleted = numberField(record, ["fixturesDeleted"]);
  const startedDeleted = numberField(record, ["startedFixturesDeleted"]);
  const snapshotsDeleted = numberField(record, ["startedSnapshotsDeleted"]);
  const errors = numberField(record, ["errors"]);
  const apiCalls = numberField(record, ["apiCalls"]);

  return `[sync] API-Football: ${countText(seen, "jogo lido", "jogos lidos")} | ${kept} salvos | ${deleted} removidos pela API | ${startedDeleted} iniciados removidos | ${snapshotsDeleted} snapshots removidos | ${apiCalls} chamadas | ${errors} erros.`;
}

import { supabase } from "./supabase.js";
import { errorMessage } from "../utils/errors.js";

const DEFAULT_BATCH_SIZE = 50;
const SELECT_BATCH_SIZE = 500;
const DELETE_ROW_BATCH_SIZE = 200;
const DB_RETRY_ATTEMPTS = 3;
const DB_RETRY_BASE_DELAY_MS = 500;
const MIN_1X2_IMPLIED_PROBABILITY = 0.9;
const MAX_1X2_IMPLIED_PROBABILITY = 1.35;

export type BookmakerLinkRow = {
  bookmaker_slug: string;
  external_event_id: string | number;
  fixture_id: string;
  bookmaker_event_name: string;
  bookmaker_home_team: string | null;
  bookmaker_away_team: string | null;
  normalized_bookmaker_home_team: string | null;
  normalized_bookmaker_away_team: string | null;
  starts_at: string;
  match_confidence_score: number;
  source_url: string | null;
  raw: unknown;
  updated_at: string;
};

export type OddRow = {
  fixture_id: string;
  bookmaker_slug: string;
  market_code: string;
  market_name: string;
  selection: string;
  price: number;
  pa_category: string;
  confidence_score: number;
  raw_market_name: string | null;
  raw_label: string | null;
  raw_odd_type: string | null;
  source_odd_id: string | number;
  raw: unknown;
  updated_at: string;
};

type ExistingBookmakerLinkRow = BookmakerLinkRow & {
  id: string;
};

type ExistingOddRow = Omit<OddRow, "source_odd_id"> & {
  id: string;
  source_odd_id: string | number | null;
};

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStatementTimeout(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "57014" || /statement timeout/i.test(errorMessage(error));
}

async function withStatementTimeoutRetry(label: string, operation: () => Promise<{ error: unknown }>) {
  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt += 1) {
    const { error } = await operation();
    if (!error) return;

    if (!isStatementTimeout(error) || attempt === DB_RETRY_ATTEMPTS) {
      throw error;
    }

    const delayMs = DB_RETRY_BASE_DELAY_MS * attempt;
    console.warn(`[db] ${label} cancelado por timeout; tentando novamente (${attempt + 1}/${DB_RETRY_ATTEMPTS})...`);
    await sleep(delayMs);
  }
}

function keyValue(value: string | number | null | undefined) {
  return value == null ? "" : String(value);
}

function numericValue(value: unknown, precision: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue.toFixed(precision) : String(value ?? "");
}

function timestampValue(value: unknown) {
  if (value == null) return "";
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time) ? String(time) : String(value);
}

function oddKey(row: Pick<OddRow, "fixture_id" | "bookmaker_slug" | "market_code" | "selection" | "pa_category"> & { source_odd_id?: string | number | null }) {
  return [
    row.fixture_id,
    row.bookmaker_slug,
    row.market_code,
    row.selection,
    row.pa_category,
    keyValue(row.source_odd_id)
  ].join(":");
}

function oddGroupKey(row: Pick<OddRow, "fixture_id" | "bookmaker_slug" | "market_code" | "pa_category">) {
  return [row.fixture_id, row.bookmaker_slug, row.market_code, row.pa_category].join(":");
}

function linkKey(row: Pick<BookmakerLinkRow, "bookmaker_slug"> & { external_event_id: string | number | null }) {
  return `${row.bookmaker_slug}:${keyValue(row.external_event_id)}`;
}

function sameOdd(existing: ExistingOddRow, next: OddRow) {
  return (
    existing.market_name === next.market_name &&
    existing.raw_market_name === next.raw_market_name &&
    existing.raw_label === next.raw_label &&
    existing.raw_odd_type === next.raw_odd_type &&
    numericValue(existing.price, 4) === numericValue(next.price, 4) &&
    numericValue(existing.confidence_score, 3) === numericValue(next.confidence_score, 3)
  );
}

function sameLink(existing: ExistingBookmakerLinkRow, next: BookmakerLinkRow) {
  return (
    existing.fixture_id === next.fixture_id &&
    existing.bookmaker_event_name === next.bookmaker_event_name &&
    existing.bookmaker_home_team === next.bookmaker_home_team &&
    existing.bookmaker_away_team === next.bookmaker_away_team &&
    existing.normalized_bookmaker_home_team === next.normalized_bookmaker_home_team &&
    existing.normalized_bookmaker_away_team === next.normalized_bookmaker_away_team &&
    timestampValue(existing.starts_at) === timestampValue(next.starts_at) &&
    numericValue(existing.match_confidence_score, 3) === numericValue(next.match_confidence_score, 3) &&
    existing.source_url === next.source_url
  );
}

function impliedProbability(rows: OddRow[]) {
  return rows.reduce((total, row) => total + 1 / row.price, 0);
}

function filterInvalidMoneylineGroups(rows: OddRow[]) {
  const invalidRows = new Set<OddRow>();
  const groups = new Map<string, OddRow[]>();

  for (const row of rows) {
    if (row.market_code !== "1X2") continue;

    const groupRows = groups.get(oddGroupKey(row)) ?? [];
    groupRows.push(row);
    groups.set(oddGroupKey(row), groupRows);
  }

  for (const [key, groupRows] of groups) {
    const bySelection = new Map(groupRows.map((row) => [row.selection, row]));
    const completeRows = ["HOME", "DRAW", "AWAY"].map((selection) => bySelection.get(selection));
    const complete = completeRows.every((row): row is OddRow => Boolean(row));
    const hasOnlyExpectedRows = groupRows.every((row) => row.selection === "HOME" || row.selection === "DRAW" || row.selection === "AWAY");

    if (!complete || !hasOnlyExpectedRows || groupRows.length !== 3) {
      for (const row of groupRows) invalidRows.add(row);
      console.warn(`[odds] grupo 1X2 incompleto ou duplicado ignorado: ${key}`);
      continue;
    }

    const totalProbability = impliedProbability(completeRows);
    if (totalProbability < MIN_1X2_IMPLIED_PROBABILITY || totalProbability > MAX_1X2_IMPLIED_PROBABILITY) {
      for (const row of groupRows) invalidRows.add(row);
      console.warn(
        `[odds] grupo 1X2 com probabilidade implicita suspeita ignorado: ${key} (${totalProbability.toFixed(3)})`
      );
    }
  }

  return rows.filter((row) => !invalidRows.has(row));
}

async function fetchExistingLinks(bookmakerSlug: string, fixtureIds: string[]) {
  const rows: ExistingBookmakerLinkRow[] = [];

  for (const fixtureIdBatch of chunks(fixtureIds, SELECT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from("bookmaker_event_links")
      .select(
        "id,bookmaker_slug,external_event_id,fixture_id,bookmaker_event_name,bookmaker_home_team,bookmaker_away_team,normalized_bookmaker_home_team,normalized_bookmaker_away_team,starts_at,match_confidence_score,source_url,raw,updated_at"
      )
      .eq("bookmaker_slug", bookmakerSlug)
      .in("fixture_id", fixtureIdBatch);

    if (error) throw error;
    rows.push(...((data ?? []) as unknown as ExistingBookmakerLinkRow[]));
  }

  return rows;
}

async function fetchExistingOdds(bookmakerSlug: string, fixtureIds: string[], marketCodes: string[]) {
  const rows: ExistingOddRow[] = [];

  for (const fixtureIdBatch of chunks(fixtureIds, SELECT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from("odds")
      .select(
        "id,fixture_id,bookmaker_slug,market_code,market_name,selection,price,pa_category,confidence_score,raw_market_name,raw_label,raw_odd_type,source_odd_id,raw,updated_at"
      )
      .eq("bookmaker_slug", bookmakerSlug)
      .in("market_code", marketCodes)
      .in("fixture_id", fixtureIdBatch);

    if (error) throw error;
    rows.push(...((data ?? []) as unknown as ExistingOddRow[]));
  }

  return rows;
}

async function deleteRowsById(table: "bookmaker_event_links" | "odds", label: string, ids: string[]) {
  for (const idBatch of chunks(ids, DELETE_ROW_BATCH_SIZE)) {
    await withStatementTimeoutRetry(label, async () => await supabase.from(table).delete().in("id", idBatch));
  }
}

export class OddsRepository {
  static async saveAll(
    bookmakerSlug: string,
    links: BookmakerLinkRow[],
    odds: OddRow[],
    options: { marketCodes?: string[]; cleanupFixtureIds?: string[] } = {}
  ) {
    const saveStartedAt = new Date().toISOString();
    const fixtureIds = [...new Set(options.cleanupFixtureIds?.length ? options.cleanupFixtureIds : links.map((link) => link.fixture_id))];
    const marketCodes = options.marketCodes?.length ? options.marketCodes : ["1X2"];
    const linksToSave = [
      ...new Map(links.map((link) => [linkKey(link), { ...link, updated_at: saveStartedAt }])).values()
    ];
    const oddsToSave = odds.map((odd) => ({ ...odd, updated_at: saveStartedAt }));

    const existingLinks = fixtureIds.length ? await fetchExistingLinks(bookmakerSlug, fixtureIds) : [];
    const existingLinksByKey = new Map(existingLinks.map((row) => [linkKey(row), row]));
    const currentLinkKeys = new Set(linksToSave.map(linkKey));
    const changedLinks = linksToSave.filter((link) => {
      const existing = existingLinksByKey.get(linkKey(link));
      return !existing || !sameLink(existing, link);
    });
    const staleLinkIds = existingLinks.filter((link) => !currentLinkKeys.has(linkKey(link))).map((link) => link.id);

    for (const linkBatch of chunks(changedLinks, DEFAULT_BATCH_SIZE)) {
      await withStatementTimeoutRetry("upsert de links de eventos", async () =>
        await supabase.from("bookmaker_event_links").upsert(linkBatch, {
          onConflict: "bookmaker_slug,external_event_id"
        })
      );
    }

    const uniqueOdds = filterInvalidMoneylineGroups([
      ...new Map(
        oddsToSave.map((row) => [`${row.fixture_id}:${row.bookmaker_slug}:${row.market_code}:${row.selection}:${row.pa_category}:${row.source_odd_id}`, row])
      ).values()
    ]);

    const existingOdds = fixtureIds.length ? await fetchExistingOdds(bookmakerSlug, fixtureIds, marketCodes) : [];
    const existingOddsByKey = new Map(existingOdds.map((row) => [oddKey(row), row]));
    const currentOddKeys = new Set(uniqueOdds.map(oddKey));
    const changedOdds = uniqueOdds.filter((odd) => {
      const existing = existingOddsByKey.get(oddKey(odd));
      return !existing || !sameOdd(existing, odd);
    });
    const staleOddIds = existingOdds.filter((odd) => !currentOddKeys.has(oddKey(odd))).map((odd) => odd.id);

    for (const oddBatch of chunks(changedOdds, DEFAULT_BATCH_SIZE)) {
      await withStatementTimeoutRetry("upsert de odds", async () =>
        await supabase.from("odds").upsert(oddBatch, {
          onConflict: "fixture_id,bookmaker_slug,market_code,selection,pa_category,source_odd_id"
        })
      );
    }

    if (fixtureIds.length) {
      await deleteRowsById("odds", "limpeza de odds antigas", staleOddIds);
      await deleteRowsById("bookmaker_event_links", "limpeza de links antigos", staleLinkIds);
    }

    return changedOdds.length;
  }
}

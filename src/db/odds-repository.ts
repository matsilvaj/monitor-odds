import { supabase } from "./supabase.js";
import { errorMessage } from "../utils/errors.js";
import { fetchOddsBlocks } from "../services/odds-consistency.js";
import { fetchAllPages } from "./paginate.js";

const DEFAULT_BATCH_SIZE = 50;
const SELECT_BATCH_SIZE = 500;
const DELETE_ROW_BATCH_SIZE = 200;
const DB_RETRY_ATTEMPTS = 3;
const DB_RETRY_BASE_DELAY_MS = 500;
const MIN_1X2_IMPLIED_PROBABILITY = 0.9;
const MAX_1X2_IMPLIED_PROBABILITY = 1.35;
// Odd sem mudanca de preco so renova last_seen_at depois deste intervalo. A limpeza
// de odds nao vistas usa 2h (registry.ts), entao 10 min deixa folga de sobra.
const SEEN_TOUCH_INTERVAL_MS = 10 * 60 * 1000;
// raw de link que so difere em dado volatil (precos de outros mercados) e regravado
// no maximo neste intervalo: os coletores so leem identidade do evento dele.
const LINK_RAW_REFRESH_MS = 10 * 60 * 1000;
// Ninguem le cotacoes.raw. O evento inteiro repetido em cada odd era a maior parte
// da tabela e era reenviado a cada ciclo, entao valores grandes ficam de fora.
const ODD_RAW_MAX_VALUE_CHARS = 1000;

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
  last_seen_at?: string;
};

type ExistingBookmakerLinkRow = BookmakerLinkRow & {
  id: string;
};

type ExistingOddRow = Omit<OddRow, "source_odd_id" | "raw"> & {
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

async function withStatementTimeoutRetry<T extends { error: unknown }>(label: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt += 1) {
    const result = await operation();
    if (!result.error) return result;

    if (!isStatementTimeout(result.error) || attempt === DB_RETRY_ATTEMPTS) {
      throw result.error;
    }

    const delayMs = DB_RETRY_BASE_DELAY_MS * attempt;
    console.warn(`[db] ${label} cancelado por timeout; tentando novamente (${attempt + 1}/${DB_RETRY_ATTEMPTS})...`);
    await sleep(delayMs);
  }

  throw new Error(`[db] ${label} excedeu o limite de tentativas.`);
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

function ageMs(value: unknown) {
  const time = new Date(String(value ?? "")).getTime();
  return Number.isFinite(time) ? Date.now() - time : Number.POSITIVE_INFINITY;
}

// jsonb devolve as chaves em outra ordem, entao comparar com JSON.stringify direto
// nunca batia e todo link era regravado a cada ciclo.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function compactOddRaw(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw ?? {};

  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "event" || value === undefined) continue;
    const serialized = JSON.stringify(value);
    if (serialized !== undefined && serialized.length <= ODD_RAW_MAX_VALUE_CHARS) compact[key] = value;
  }

  return compact;
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

function conflictingFixtureIdsByBookmaker(links: BookmakerLinkRow[]) {
  const eventsByFixture = new Map<string, Map<string, BookmakerLinkRow>>();

  for (const link of links) {
    const fixtureKey = `${link.bookmaker_slug}:${link.fixture_id}`;
    const eventKey = keyValue(link.external_event_id);
    const events = eventsByFixture.get(fixtureKey) ?? new Map<string, BookmakerLinkRow>();
    events.set(eventKey, link);
    eventsByFixture.set(fixtureKey, events);
  }

  const conflictingFixtureIds = new Set<string>();
  for (const events of eventsByFixture.values()) {
    if (events.size <= 1) continue;
    const first = events.values().next().value;
    if (first) conflictingFixtureIds.add(first.fixture_id);
  }

  return conflictingFixtureIds;
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

function sameLinkFields(existing: ExistingBookmakerLinkRow, next: BookmakerLinkRow) {
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

function sameLinkRaw(existing: ExistingBookmakerLinkRow, next: BookmakerLinkRow) {
  return stableStringify(existing.raw ?? null) === stableStringify(next.raw ?? null);
}

function impliedProbability(rows: OddRow[]) {
  return rows.reduce((total, row) => total + 1 / row.price, 0);
}

function filterInvalidMoneylineGroups(rows: OddRow[]) {
  const invalidRows = new Set<OddRow>();
  const selectedRows = new Set<OddRow>();
  const groups = new Map<string, OddRow[]>();

  for (const row of rows) {
    if (row.market_code !== "1X2") continue;

    const groupRows = groups.get(oddGroupKey(row)) ?? [];
    groupRows.push(row);
    groups.set(oddGroupKey(row), groupRows);
  }

  for (const [key, groupRows] of groups) {
    const bySelection = new Map<string, OddRow>();
    for (const row of groupRows) {
      const current = bySelection.get(row.selection);
      if (!current || row.price > current.price) bySelection.set(row.selection, row);
    }

    const completeRows = ["HOME", "DRAW", "AWAY"].map((selection) => bySelection.get(selection));
    const complete = completeRows.every((row): row is OddRow => Boolean(row));
    const homeEarlyPayoutRow = bySelection.get("HOME");
    const awayEarlyPayoutRow = bySelection.get("AWAY");
    const twoWayEarlyPayoutRows = [homeEarlyPayoutRow, awayEarlyPayoutRow].filter((row): row is OddRow => Boolean(row));
    const isTwoWayEarlyPayout =
      groupRows.every((row) => row.pa_category === "COM_PA") &&
      Boolean(homeEarlyPayoutRow) &&
      Boolean(awayEarlyPayoutRow) &&
      !bySelection.get("DRAW");
    const hasOnlyExpectedRows = groupRows.every((row) => row.selection === "HOME" || row.selection === "DRAW" || row.selection === "AWAY");

    if ((!complete && !isTwoWayEarlyPayout) || !hasOnlyExpectedRows) {
      for (const row of groupRows) invalidRows.add(row);
      console.warn(`[odds] grupo 1X2 incompleto ou duplicado ignorado: ${key}`);
      continue;
    }

    if (isTwoWayEarlyPayout) {
      for (const row of twoWayEarlyPayoutRows) {
        if (row) selectedRows.add(row);
      }
      continue;
    }

    const validCompleteRows = completeRows.filter((row): row is OddRow => Boolean(row));
    const totalProbability = impliedProbability(validCompleteRows);
    if (totalProbability < MIN_1X2_IMPLIED_PROBABILITY || totalProbability > MAX_1X2_IMPLIED_PROBABILITY) {
      for (const row of groupRows) invalidRows.add(row);
      console.warn(
        `[odds] grupo 1X2 com probabilidade implicita suspeita ignorado: ${key} (${totalProbability.toFixed(3)})`
      );
      continue;
    }

    for (const row of validCompleteRows) selectedRows.add(row);
  }

  return rows.filter((row) => row.market_code !== "1X2" || selectedRows.has(row)).filter((row) => !invalidRows.has(row));
}

async function fetchExistingLinks(bookmakerSlug: string, fixtureIds: string[]) {
  const rows: ExistingBookmakerLinkRow[] = [];

  for (const fixtureIdBatch of chunks(fixtureIds, SELECT_BATCH_SIZE)) {
    const page = await fetchAllPages<ExistingBookmakerLinkRow>((from, to) =>
      supabase
        .from("links_eventos")
        .select(
          "id,bookmaker_slug,external_event_id,fixture_id,bookmaker_event_name,bookmaker_home_team,bookmaker_away_team,normalized_bookmaker_home_team,normalized_bookmaker_away_team,starts_at,match_confidence_score,source_url,raw,updated_at"
        )
        .eq("bookmaker_slug", bookmakerSlug)
        .in("fixture_id", fixtureIdBatch)
        .order("id", { ascending: true })
        .range(from, to)
    );

    rows.push(...page);
  }

  return rows;
}

async function fetchExistingLinksByEventIds(bookmakerSlug: string, externalEventIds: Array<string | number>) {
  const rows: ExistingBookmakerLinkRow[] = [];
  const eventIds = [
    ...new Map(
      externalEventIds
        .filter((eventId) => keyValue(eventId))
        .map((eventId) => [keyValue(eventId), eventId])
    ).values()
  ];

  for (const eventIdBatch of chunks(eventIds, SELECT_BATCH_SIZE)) {
    const page = await fetchAllPages<ExistingBookmakerLinkRow>((from, to) =>
      supabase
        .from("links_eventos")
        .select(
          "id,bookmaker_slug,external_event_id,fixture_id,bookmaker_event_name,bookmaker_home_team,bookmaker_away_team,normalized_bookmaker_home_team,normalized_bookmaker_away_team,starts_at,match_confidence_score,source_url,raw,updated_at"
        )
        .eq("bookmaker_slug", bookmakerSlug)
        .in("external_event_id", eventIdBatch)
        .order("id", { ascending: true })
        .range(from, to)
    );

    rows.push(...page);
  }

  return rows;
}

async function fetchExistingOdds(bookmakerSlug: string, fixtureIds: string[], marketCodes: string[]) {
  const rows: ExistingOddRow[] = [];

  for (const fixtureIdBatch of chunks(fixtureIds, SELECT_BATCH_SIZE)) {
    const page = await fetchAllPages<ExistingOddRow>((from, to) =>
      supabase
        .from("cotacoes")
        .select(
          "id,fixture_id,bookmaker_slug,market_code,market_name,selection,price,pa_category,confidence_score,raw_market_name,raw_label,raw_odd_type,source_odd_id,updated_at,last_seen_at"
        )
        .eq("bookmaker_slug", bookmakerSlug)
        .in("market_code", marketCodes)
        .in("fixture_id", fixtureIdBatch)
        .order("id", { ascending: true })
        .range(from, to)
    );

    rows.push(...page);
  }

  return rows;
}

async function deleteRowsById(table: "links_eventos" | "cotacoes", label: string, ids: string[]) {
  for (const idBatch of chunks(ids, DELETE_ROW_BATCH_SIZE)) {
    await withStatementTimeoutRetry(label, async () => await supabase.from(table).delete().in("id", idBatch));
  }
}

async function deleteExistingOdds(bookmakerSlug: string, fixtureIds: string[], marketCodes: string[], paCategories?: string[]) {
  for (const fixtureIdBatch of chunks(fixtureIds, SELECT_BATCH_SIZE)) {
    await withStatementTimeoutRetry("substituicao de odds antigas", async () => {
      let query = supabase.from("cotacoes").delete().eq("bookmaker_slug", bookmakerSlug).in("fixture_id", fixtureIdBatch).in("market_code", marketCodes);
      if (paCategories?.length) query = query.in("pa_category", paCategories);
      return await query;
    });
  }
}

/**
 * Remove links e odds ja reprovados pela varredura de consistencia.
 * - EVENTO bloqueado: nada daquela casa volta para o jogo.
 * - EVENTO em tentativa: o evento externo ja rejeitado nao pode ser relinkado.
 * - PARCIAL: apenas o pa_category defeituoso e descartado.
 */
async function applyOddsBlocks(bookmakerSlug: string, links: BookmakerLinkRow[], odds: OddRow[]) {
  const blocks = await fetchOddsBlocks(bookmakerSlug).catch((error) => {
    console.warn(`[odds] ${bookmakerSlug} nao conseguiu carregar bloqueios de consistencia: ${errorMessage(error)}`);
    return [];
  });

  if (!blocks.length) return { links, odds };

  const blockedFixtureIds = new Set<string>();
  const rejectedEventIdsByFixture = new Map<string, Set<string>>();
  const blockedPaCategoriesByFixture = new Map<string, Set<string>>();

  for (const block of blocks) {
    if (block.scope === "PARCIAL") {
      const categories = blockedPaCategoriesByFixture.get(block.fixture_id) ?? new Set<string>();
      categories.add(block.pa_category);
      blockedPaCategoriesByFixture.set(block.fixture_id, categories);
      continue;
    }

    if (block.blocked) {
      blockedFixtureIds.add(block.fixture_id);
      continue;
    }

    rejectedEventIdsByFixture.set(block.fixture_id, new Set(block.rejected_event_ids ?? []));
  }

  const filteredLinks = links.filter((link) => {
    if (blockedFixtureIds.has(link.fixture_id)) return false;
    return !rejectedEventIdsByFixture.get(link.fixture_id)?.has(keyValue(link.external_event_id));
  });

  const droppedFixtureIds = new Set(
    links.filter((link) => !filteredLinks.includes(link)).map((link) => link.fixture_id)
  );

  const filteredOdds = odds.filter((odd) => {
    if (blockedFixtureIds.has(odd.fixture_id) || droppedFixtureIds.has(odd.fixture_id)) return false;
    return !blockedPaCategoriesByFixture.get(odd.fixture_id)?.has(odd.pa_category);
  });

  const removedLinks = links.length - filteredLinks.length;
  const removedOdds = odds.length - filteredOdds.length;
  if (removedLinks || removedOdds) {
    console.log(`[odds] ${bookmakerSlug} descartou ${removedLinks} link(s) e ${removedOdds} odd(s) por bloqueio de consistencia.`);
  }

  return { links: filteredLinks, odds: filteredOdds };
}

async function touchSeenOdds(ids: string[], seenAt: string) {
  for (const idBatch of chunks(ids, DELETE_ROW_BATCH_SIZE)) {
    await withStatementTimeoutRetry("atualizacao de last_seen_at das odds", async () =>
      await supabase.from("cotacoes").update({ last_seen_at: seenAt }).in("id", idBatch)
    );
  }
}

export class OddsRepository {
  static async deleteStaleByBookmaker(bookmakerSlug: string, seenBefore: string) {
    const seenBeforeTimestamp = new Date(seenBefore);
    if (!Number.isFinite(seenBeforeTimestamp.getTime())) {
      throw new Error(`Data de inicio invalida para limpeza de odds: ${seenBefore}`);
    }

    const result = await withStatementTimeoutRetry("limpeza de odds obsoletas do bookmaker", async () =>
      await supabase
        .from("cotacoes")
        .delete({ count: "exact" })
        .eq("bookmaker_slug", bookmakerSlug)
        .lt("last_seen_at", seenBeforeTimestamp.toISOString())
    );

    return result.count ?? 0;
  }

  static async deleteStaleSeenBefore(
    bookmakerSlug: string,
    fixtureIds: string[],
    seenBefore: string,
    options: { marketCodes?: string[] } = {}
  ) {
    const uniqueFixtureIds = [...new Set(fixtureIds.filter(Boolean))];
    if (!uniqueFixtureIds.length) return 0;

    const seenBeforeTimestamp = new Date(seenBefore);
    if (!Number.isFinite(seenBeforeTimestamp.getTime())) {
      throw new Error(`Data de inicio invalida para limpeza de odds: ${seenBefore}`);
    }

    const marketCodes = options.marketCodes?.length ? [...new Set(options.marketCodes)] : ["1X2"];
    let deleted = 0;

    for (const fixtureIdBatch of chunks(uniqueFixtureIds, SELECT_BATCH_SIZE)) {
      const result = await withStatementTimeoutRetry("limpeza de odds nao vistas no ciclo", async () =>
        await supabase
          .from("cotacoes")
          .delete({ count: "exact" })
          .eq("bookmaker_slug", bookmakerSlug)
          .in("fixture_id", fixtureIdBatch)
          .in("market_code", marketCodes)
          .lt("last_seen_at", seenBeforeTimestamp.toISOString())
      );
      deleted += result.count ?? 0;
    }

    return deleted;
  }

  static async saveAll(
    bookmakerSlug: string,
    links: BookmakerLinkRow[],
    odds: OddRow[],
    options: {
      marketCodes?: string[];
      cleanupFixtureIds?: string[];
      replaceExistingOdds?: boolean;
      cleanupPaCategories?: string[];
      replaceExistingLinks?: boolean;
      // Casa que limpa odds pelo inicio do ciclo (bet365) precisa renovar last_seen_at sempre.
      touchSeenEverySave?: boolean;
      // Casa que guarda estado no raw do link (falhas, orientacao) nao pode atrasar a gravacao dele.
      persistLinkRawEverySave?: boolean;
    } = {}
  ) {
    const saveStartedAt = new Date().toISOString();
    const marketCodes = options.marketCodes?.length ? options.marketCodes : ["1X2"];
    const allowed = await applyOddsBlocks(bookmakerSlug, links, odds);
    links = allowed.links;
    odds = allowed.odds;
    const uniqueLinksToSave = [
      ...new Map(links.map((link) => [linkKey(link), { ...link, updated_at: saveStartedAt }])).values()
    ];
    const conflictingFixtureIds = conflictingFixtureIdsByBookmaker(uniqueLinksToSave);
    if (conflictingFixtureIds.size) {
      console.warn(
        `[odds] ${bookmakerSlug} ignorou ${conflictingFixtureIds.size} jogo(s) com eventos conflitantes no mesmo fixture: ${[...conflictingFixtureIds].join(", ")}`
      );
    }
    const linksToSave = conflictingFixtureIds.size
      ? uniqueLinksToSave.filter((link) => !conflictingFixtureIds.has(link.fixture_id))
      : uniqueLinksToSave;
    const oddsToSave = odds
      .filter((odd) => !conflictingFixtureIds.has(odd.fixture_id))
      .map((odd) => ({ ...odd, raw: compactOddRaw(odd.raw), updated_at: saveStartedAt, last_seen_at: saveStartedAt }));
    const existingLinksByEventId = linksToSave.length ? await fetchExistingLinksByEventIds(bookmakerSlug, linksToSave.map((link) => link.external_event_id)) : [];
    const linksToSaveByKey = new Map(linksToSave.map((link) => [linkKey(link), link]));
    const movedFixtureIds = existingLinksByEventId
      .filter((link) => {
        const nextLink = linksToSaveByKey.get(linkKey(link));
        return nextLink && nextLink.fixture_id !== link.fixture_id;
      })
      .map((link) => link.fixture_id);
    const fixtureIds = [
      ...new Set([
        ...(options.cleanupFixtureIds?.length ? options.cleanupFixtureIds : links.map((link) => link.fixture_id)),
        ...linksToSave.map((link) => link.fixture_id),
        ...oddsToSave.map((odd) => odd.fixture_id),
        ...movedFixtureIds
      ])
    ];

    const existingLinks = fixtureIds.length ? await fetchExistingLinks(bookmakerSlug, fixtureIds) : [];
    const existingLinksByKey = new Map(existingLinks.map((row) => [linkKey(row), row]));
    const currentLinkKeys = new Set(linksToSave.map(linkKey));
    const persistLinkRawEverySave = options.persistLinkRawEverySave ?? false;
    const changedLinks = linksToSave.filter((link) => {
      const existing = existingLinksByKey.get(linkKey(link));
      if (!existing || !sameLinkFields(existing, link)) return true;
      if (sameLinkRaw(existing, link)) return false;
      return persistLinkRawEverySave || ageMs(existing.updated_at) >= LINK_RAW_REFRESH_MS;
    });
    const replaceExistingLinks = options.replaceExistingLinks ?? true;
    const staleLinkIds = replaceExistingLinks
      ? existingLinks.filter((link) => !currentLinkKeys.has(linkKey(link))).map((link) => link.id)
      : [];

    for (const linkBatch of chunks(changedLinks, DEFAULT_BATCH_SIZE)) {
      await withStatementTimeoutRetry("upsert de links de eventos", async () =>
        await supabase.from("links_eventos").upsert(linkBatch, {
          onConflict: "bookmaker_slug,external_event_id"
        })
      );
    }

    const uniqueOdds = filterInvalidMoneylineGroups([
      ...new Map(
        oddsToSave.map((row) => [oddKey(row), row])
      ).values()
    ]);

    // Apagar e reinserir tudo a cada ciclo reescrevia a tabela inteira a cada poucos
    // minutos e esgotava a memoria do banco; o padrao agora grava so o que mudou.
    const replaceExistingOdds = options.replaceExistingOdds ?? false;

    if (replaceExistingOdds && fixtureIds.length) {
      await deleteExistingOdds(bookmakerSlug, fixtureIds, marketCodes, options.cleanupPaCategories);
    }

    if (replaceExistingOdds) {
      for (const oddBatch of chunks(uniqueOdds, DEFAULT_BATCH_SIZE)) {
        await withStatementTimeoutRetry("insert de odds", async () => await supabase.from("cotacoes").insert(oddBatch));
      }

      if (fixtureIds.length) {
        await deleteRowsById("links_eventos", "limpeza de links antigos", staleLinkIds);
      }

      return uniqueOdds.length;
    }

    const existingOdds = fixtureIds.length ? await fetchExistingOdds(bookmakerSlug, fixtureIds, marketCodes) : [];
    const existingOddsByKey = new Map<string, ExistingOddRow>();
    const duplicateOddIds: string[] = [];
    for (const row of existingOdds) {
      const key = oddKey(row);
      if (existingOddsByKey.has(key)) duplicateOddIds.push(row.id);
      else existingOddsByKey.set(key, row);
    }

    const currentOddKeys = new Set(uniqueOdds.map(oddKey));
    const touchSeenEverySave = options.touchSeenEverySave ?? false;
    const oddsToUpdate: Array<OddRow & { id: string }> = [];
    const oddsToInsert: OddRow[] = [];
    const seenUnchangedOddIds: string[] = [];
    for (const odd of uniqueOdds) {
      const existing = existingOddsByKey.get(oddKey(odd));
      if (!existing) oddsToInsert.push(odd);
      else if (!sameOdd(existing, odd)) oddsToUpdate.push({ ...odd, id: existing.id });
      else if (touchSeenEverySave || ageMs(existing.last_seen_at) >= SEEN_TOUCH_INTERVAL_MS) seenUnchangedOddIds.push(existing.id);
    }
    const staleOddIds = [
      ...new Set([...existingOdds.filter((odd) => !currentOddKeys.has(oddKey(odd))).map((odd) => odd.id), ...duplicateOddIds])
    ];

    // Odd que ja existe e atualizada pelo id: a chave unica inclui source_odd_id, que
    // pode ser nulo, e com nulo o upsert pela chave inseria uma duplicata.
    for (const oddBatch of chunks(oddsToUpdate, DEFAULT_BATCH_SIZE)) {
      await withStatementTimeoutRetry("atualizacao de odds alteradas", async () =>
        await supabase.from("cotacoes").upsert(oddBatch, { onConflict: "id" })
      );
    }

    for (const oddBatch of chunks(oddsToInsert, DEFAULT_BATCH_SIZE)) {
      await withStatementTimeoutRetry("upsert de odds", async () =>
        await supabase.from("cotacoes").upsert(oddBatch, {
          onConflict: "fixture_id,bookmaker_slug,market_code,selection,pa_category,source_odd_id"
        })
      );
    }

    await touchSeenOdds(seenUnchangedOddIds, saveStartedAt);

    if (fixtureIds.length) {
      await deleteRowsById("cotacoes", "limpeza de odds antigas", staleOddIds);
      await deleteRowsById("links_eventos", "limpeza de links antigos", staleLinkIds);
    }

    // Conta as odds confirmadas no ciclo, como no modo de substituicao: sync-report e a
    // guarda de limpeza (registry.ts) leem isto como "a casa coletou", nao como "mudou".
    return uniqueOdds.length;
  }
}

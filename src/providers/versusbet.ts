import type { VersusbetBookmakerConfig } from "../config/bookmakers.js";

type VisionRow = Record<string, unknown>;
type VisionStore = Record<string, VisionRow[]>;

type LzmaExports = WebAssembly.Exports & {
  reset: () => void;
  newU8Array: (length: number) => number;
  decode: (pointer: number) => number;
};

type VisionMeta = {
  repositoryId: number;
  fullIndex: number;
  partialIndex: number;
  upd2fullIndex: number;
  fullPartitions: number;
  cultures: string[];
};

type VisionColumn = {
  name: string;
  type: number;
  count: number;
  itemsOffset: number;
};

export type VersusbetFeed = {
  meta: VisionMeta;
  store: VisionStore;
  events: VersusbetEvent[];
};

export type VersusbetEvent = {
  id: number;
  startsAt: string;
  homeTeam: string | null;
  awayTeam: string | null;
  leagueName: string | null;
  raw: VisionRow;
};

export type VersusbetMarket = {
  nodeId: number;
  eventId: number;
  marketTypeId: number;
  name: string;
  isActive: boolean;
  isDisplayed: boolean;
  additionalValues: Array<{ key: string; value: string }>;
  results: VersusbetResult[];
  raw: VisionRow;
};

export type VersusbetResult = {
  nodeId: number;
  marketId: number;
  name: string;
  oddMapId: number;
  price: number | null;
  raw: VisionRow;
};

const STRING_TYPE = 10;
const LZMA_ARRAY_OFFSET = 24;

function uint16(buffer: Buffer, offset: number) {
  return buffer[offset] | (buffer[offset + 1] << 8);
}

function int32(buffer: Buffer, offset: number) {
  return (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) | 0;
}

function uint32(buffer: Buffer, offset: number) {
  return buffer[offset] + 256 * buffer[offset + 1] + 65536 * buffer[offset + 2] + 16777216 * buffer[offset + 3];
}

function readVisionString(buffer: Buffer, offset: number) {
  const length = uint16(buffer, offset);
  return buffer.subarray(offset + 2, offset + 2 + length).toString("utf8");
}

function columnItemSize(type: number) {
  if (type === 0) return 1;
  if (type === 1) return 0;
  if ([2, 3, 12, 13].includes(type)) return 2;
  if ([4, 5, 6, STRING_TYPE, 14, 15, 16].includes(type)) return 4;
  if ([7, 17].includes(type)) return 8;
  throw new Error(`VersusBet Vision column type not supported: ${type}`);
}

function readColumnValue(buffer: Buffer, column: VisionColumn, index: number) {
  if (column.type === 1) {
    return Boolean((buffer[column.itemsOffset + Math.floor(index / 8)] >>> index % 8) & 1);
  }

  const offset = column.itemsOffset + index * columnItemSize(column.type);

  if (column.type === 0) return buffer[offset];
  if (column.type === 2) {
    const value = uint16(buffer, offset);
    return value > 32767 ? value - 65536 : value;
  }
  if (column.type === 3) return uint16(buffer, offset);
  if (column.type === 4 || column.type === 6) return int32(buffer, offset);
  if (column.type === 5) return uint32(buffer, offset);
  if (column.type === 7) return Number(buffer.readBigUInt64LE(offset));
  if (column.type === STRING_TYPE) return readVisionString(buffer, int32(buffer, offset));

  return null;
}

function parseTable(buffer: Buffer, offset: number) {
  if (buffer[offset] !== 203 || buffer[offset + 9] !== 204) {
    throw new Error(`Invalid VersusBet Vision table at offset ${offset}`);
  }

  const columnCount = uint16(buffer, offset + 7);
  const name = readVisionString(buffer, offset + 10 + 4 * columnCount);
  const columns: VisionColumn[] = [];

  for (let index = 0; index < columnCount; index += 1) {
    const columnOffset = int32(buffer, offset + 10 + 4 * index);
    if (buffer[columnOffset] !== 206 || buffer[columnOffset + 20] !== 207) {
      throw new Error(`Invalid VersusBet Vision column at offset ${columnOffset}`);
    }

    columns.push({
      name: readVisionString(buffer, columnOffset + 21),
      type: buffer[columnOffset + 15],
      count: int32(buffer, columnOffset + 11),
      itemsOffset: columnOffset + uint16(buffer, columnOffset + 5)
    });
  }

  return { name, columns };
}

function parseVisionMemory(buffer: Buffer): VisionStore {
  if (buffer[0] !== 201 || buffer[17] !== 202) {
    throw new Error("Invalid VersusBet Vision memory slice");
  }

  const tableCount = uint16(buffer, 11);
  const store: VisionStore = {};

  for (let index = 0; index < tableCount; index += 1) {
    const tableOffset = int32(buffer, 18 + 4 * index);
    if (!tableOffset) break;

    const table = parseTable(buffer, tableOffset);
    const rowCount = Math.max(...table.columns.map((column) => column.count), 0);
    const rows: VisionRow[] = [];

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      rows.push(Object.fromEntries(table.columns.map((column) => [column.name, readColumnValue(buffer, column, rowIndex)])));
    }

    store[table.name] = rows;
  }

  return store;
}

function appendStore(target: VisionStore, source: VisionStore) {
  for (const [tableName, rows] of Object.entries(source)) {
    target[tableName] = [...(target[tableName] ?? []), ...rows];
  }
}

function rowsOf<T extends VisionRow>(store: VisionStore, tableName: string) {
  return (store[tableName] ?? []) as T[];
}

function numeric(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value: unknown) {
  return value === true || value === 1;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function buildDictionary(stores: VisionStore[]) {
  const dictionary = new Map<number, string>();
  for (const store of stores) {
    for (const row of rowsOf<{ id: number; value: string }>(store, "DictionaryEntry")) {
      if (Number.isFinite(Number(row.id))) dictionary.set(Number(row.id), text(row.value));
    }
  }
  return dictionary;
}

function buildOddMaps(stores: VisionStore[]) {
  const oddMaps = new Map<number, { id: number; dec: number }>();
  for (const store of stores) {
    for (const row of rowsOf<{ id: number; dec: number }>(store, "OddMap")) {
      const id = numeric(row.id);
      const decimal = numeric(row.dec);
      if (id != null && decimal != null) oddMaps.set(id, { id, dec: decimal });
    }
  }
  return oddMaps;
}

function buildAdditionalValueKeys(stores: VisionStore[]) {
  const keys = new Map<number, string>();
  for (const store of stores) {
    for (const row of rowsOf<{ key_id: number; key: string }>(store, "AdditionalValueKey")) {
      const id = numeric(row.key_id);
      if (id != null) keys.set(id, text(row.key));
    }
  }
  return keys;
}

function buildStructureById(stores: VisionStore[]) {
  const structures = new Map<number, VisionRow>();
  for (const store of stores) {
    for (const row of rowsOf<VisionRow>(store, "Structure")) {
      const id = numeric(row.node_id);
      if (id != null) structures.set(id, row);
    }
  }
  return structures;
}

function buildLookups(...stores: VisionStore[]) {
  return {
    dictionary: buildDictionary(stores),
    oddMaps: buildOddMaps(stores),
    additionalValueKeys: buildAdditionalValueKeys(stores),
    structureById: buildStructureById(stores)
  };
}

function eventLeagueName(event: VisionRow, dictionary: Map<number, string>, structureById: Map<number, VisionRow>) {
  const parentId = numeric(event.parent_node_id);
  const parent = parentId == null ? null : structureById.get(parentId);
  const dictionaryId = parent ? numeric(parent.dictionary_id) : null;
  return dictionaryId == null ? null : dictionary.get(dictionaryId) ?? null;
}

function buildEvents(store: VisionStore) {
  const lookups = buildLookups(store);

  return rowsOf<VisionRow>(store, "Event")
    .filter((row) => booleanValue(row.is_active) && booleanValue(row.is_displayed))
    .map((row): VersusbetEvent | null => {
      const id = numeric(row.node_id);
      const startSeconds = numeric(row.start_date);
      const homeDictionaryId = numeric(row.participant_home_dictionary_id);
      const awayDictionaryId = numeric(row.participant_away_dictionary_id);

      if (id == null || startSeconds == null) return null;

      return {
        id,
        startsAt: new Date(startSeconds * 1000).toISOString(),
        homeTeam: homeDictionaryId == null ? null : lookups.dictionary.get(homeDictionaryId) ?? null,
        awayTeam: awayDictionaryId == null ? null : lookups.dictionary.get(awayDictionaryId) ?? null,
        leagueName: eventLeagueName(row, lookups.dictionary, lookups.structureById),
        raw: row
      };
    })
    .filter((event): event is VersusbetEvent => Boolean(event?.homeTeam && event.awayTeam));
}

function additionalValuesByNode(store: VisionStore, dictionary: Map<number, string>, additionalValueKeys: Map<number, string>) {
  const values = new Map<number, Array<{ key: string; value: string }>>();

  for (const row of rowsOf<VisionRow>(store, "AdditionalValue")) {
    const nodeId = numeric(row.node_id);
    const keyId = numeric(row.key_id);
    const dictionaryId = numeric(row.dictionary_id);
    if (nodeId == null || keyId == null || dictionaryId == null) continue;

    values.set(nodeId, [
      ...(values.get(nodeId) ?? []),
      {
        key: additionalValueKeys.get(keyId) ?? String(keyId),
        value: dictionary.get(dictionaryId) ?? ""
      }
    ]);
  }

  return values;
}

function resultsByMarket(store: VisionStore, dictionary: Map<number, string>, oddMaps: Map<number, { id: number; dec: number }>) {
  const results = new Map<number, VersusbetResult[]>();

  for (const row of rowsOf<VisionRow>(store, "Result")) {
    const marketId = numeric(row.parent_node_id);
    const nodeId = numeric(row.node_id);
    const dictionaryId = numeric(row.dictionary_id);
    const oddMapId = numeric(row.odd_map_id);
    if (marketId == null || nodeId == null || dictionaryId == null || oddMapId == null) continue;

    const oddMap = oddMaps.get(oddMapId);
    results.set(marketId, [
      ...(results.get(marketId) ?? []),
      {
        nodeId,
        marketId,
        name: dictionary.get(dictionaryId) ?? "",
        oddMapId,
        price: oddMap ? oddMap.dec / 1000 : null,
        raw: row
      }
    ]);
  }

  return results;
}

function buildMarkets(store: VisionStore, eventId: number, lookupStores: VisionStore[]) {
  const lookups = buildLookups(...lookupStores);
  const additionalValues = additionalValuesByNode(store, lookups.dictionary, lookups.additionalValueKeys);
  const marketResults = resultsByMarket(store, lookups.dictionary, lookups.oddMaps);

  return rowsOf<VisionRow>(store, "Market")
    .filter((row) => numeric(row.parent_node_id) === eventId && booleanValue(row.is_active) && booleanValue(row.is_displayed))
    .map((row): VersusbetMarket | null => {
      const nodeId = numeric(row.node_id);
      const marketTypeId = numeric(row.market_type_id);
      const dictionaryId = numeric(row.dictionary_id);
      if (nodeId == null || marketTypeId == null || dictionaryId == null) return null;

      return {
        nodeId,
        eventId,
        marketTypeId,
        name: lookups.dictionary.get(dictionaryId) ?? "",
        isActive: booleanValue(row.is_active),
        isDisplayed: booleanValue(row.is_displayed),
        additionalValues: additionalValues.get(nodeId) ?? [],
        results: marketResults.get(nodeId) ?? [],
        raw: row
      };
    })
    .filter((market): market is VersusbetMarket => Boolean(market));
}

export class VersusbetClient {
  private memory = new WebAssembly.Memory({ initial: 512 });
  private lzmaPromise: Promise<LzmaExports> | null = null;

  constructor(private readonly config: VersusbetBookmakerConfig) {}

  private headers() {
    return {
      accept: "*/*",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      referer: this.config.referer,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    };
  }

  private async fetchBytes(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(url, {
        headers: this.headers(),
        signal: controller.signal
      });

      if (!response.ok) throw new Error(`VersusBet HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  }

  async getMeta() {
    const response = await fetch(new URL("v2/getmeta", this.config.cdnBaseUrl), {
      headers: this.headers()
    });

    if (!response.ok) throw new Error(`VersusBet meta HTTP ${response.status}`);
    return (await response.json()) as VisionMeta;
  }

  private async lzma() {
    this.lzmaPromise ??= (async () => {
      const wasm = await this.fetchBytes(new URL("library/lzma.wasm", this.config.cdnBaseUrl).href);
      const result = await WebAssembly.instantiate(wasm, {
        env: {
          memory: this.memory,
          abort: () => undefined
        }
      });

      return result.instance.exports as LzmaExports;
    })();

    return this.lzmaPromise;
  }

  private async decodeSlice(compressed: Buffer) {
    const lzma = await this.lzma();
    lzma.reset();

    const pointer = lzma.newU8Array(compressed.length);
    new Uint8Array(this.memory.buffer, pointer + LZMA_ARRAY_OFFSET, compressed.length).set(compressed);

    const decodedPointer = lzma.decode(pointer);
    const result = new Uint32Array(this.memory.buffer, decodedPointer, 4);
    const [ok, , unpackedSize, dataPointer] = Array.from(result);

    if (!ok) throw new Error("VersusBet LZMA decode failed");
    return Buffer.from(new Uint8Array(this.memory.buffer, dataPointer + LZMA_ARRAY_OFFSET, unpackedSize));
  }

  async getFeed() {
    const meta = await this.getMeta();
    const store: VisionStore = {};

    for (let partition = 0; partition < meta.fullPartitions; partition += 1) {
      const url = new URL(`v2/getslice/${meta.repositoryId}_2_${this.config.language}_${meta.fullIndex}_${partition}`, this.config.cdnBaseUrl);
      const decoded = await this.decodeSlice(await this.fetchBytes(url.href));
      appendStore(store, parseVisionMemory(decoded));
    }

    return {
      meta,
      store,
      events: buildEvents(store)
    } satisfies VersusbetFeed;
  }

  async getEventMarkets(feed: VersusbetFeed, eventId: number) {
    try {
      const url = new URL(
        `content/getslice/event/full/${feed.meta.repositoryId}/${feed.meta.fullIndex}/${eventId}/${this.config.language}`,
        this.config.cdnBaseUrl
      );
      const detailStore = parseVisionMemory(await this.decodeSlice(await this.fetchBytes(url.href)));
      return buildMarkets(detailStore, eventId, [feed.store, detailStore]);
    } catch {
      return buildMarkets(feed.store, eventId, [feed.store]);
    }
  }
}

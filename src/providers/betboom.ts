import type { BetboomBookmakerConfig } from "../config/bookmakers.js";

type ProtoField =
  | { id: number; wire: 0; value: number }
  | { id: number; wire: 1; value: number }
  | { id: number; wire: 2; bytes: Buffer; string: string }
  | { id: number; wire: 5; value: number };

export type BetboomTournament = {
  tournamentId: number;
  categoryId: number | null;
  name: string;
  alias: string | null;
};

export type BetboomOdd = {
  id: string;
  eventId: number;
  name: string | null;
  shortName: string | null;
  side: number | null;
  price: number;
  marketName: string | null;
  groupName: string | null;
  marketKey: string | null;
};

export type BetboomEvent = {
  id: number;
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  tournamentId: number | null;
  categoryId: number | null;
  tournamentName: string | null;
  odds: BetboomOdd[];
};

function randomId() {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}

function encodeVarint(value: number) {
  const bytes: number[] = [];
  let current = BigInt(value);

  while (current >= 0x80n) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }

  bytes.push(Number(current));
  return Buffer.from(bytes);
}

function fieldKey(id: number, wire: number) {
  return encodeVarint((id << 3) | wire);
}

function varintField(id: number, value: number) {
  return Buffer.concat([fieldKey(id, 0), encodeVarint(value)]);
}

function stringField(id: number, value: string) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([fieldKey(id, 2), encodeVarint(bytes.length), bytes]);
}

function messageField(id: number, value: Buffer) {
  return Buffer.concat([fieldKey(id, 2), encodeVarint(value.length), value]);
}

function commandAll() {
  return messageField(3, Buffer.concat([stringField(1, randomId()), stringField(2, "all"), varintField(3, 2)]));
}

function commandRootFootball() {
  return messageField(4, Buffer.concat([stringField(1, randomId()), messageField(2, Buffer.from([0x08, 0x02]))]));
}

function commandFootballTree() {
  const node = Buffer.concat([stringField(1, randomId()), varintField(2, 2), varintField(3, 2)]);
  return messageField(6, Buffer.concat([stringField(1, randomId()), messageField(2, node)]));
}

function commandTournament(tournamentId: number) {
  const prematchNode = Buffer.concat([stringField(1, randomId()), varintField(2, 2), varintField(3, tournamentId)]);
  const marketNode = Buffer.concat([stringField(1, randomId()), varintField(2, 1), varintField(3, tournamentId)]);

  return messageField(8, Buffer.concat([stringField(1, randomId()), messageField(2, prematchNode), messageField(2, marketNode)]));
}

function readVarint(buf: Buffer, start: number): [number, number] {
  let value = 0n;
  let shift = 0n;
  let position = start;

  while (position < buf.length) {
    const byte = buf[position];
    position += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }

  return [Number(value), position];
}

function scanProto(buf: Buffer) {
  const fields: ProtoField[] = [];
  let position = 0;

  while (position < buf.length) {
    const [key, nextPosition] = readVarint(buf, position);
    position = nextPosition;

    const id = key >> 3;
    const wire = key & 7;
    if (id <= 0 || id > 10_000) break;

    if (wire === 0) {
      const [value, afterValue] = readVarint(buf, position);
      position = afterValue;
      fields.push({ id, wire, value });
      continue;
    }

    if (wire === 1) {
      if (position + 8 > buf.length) break;
      const value = buf.readDoubleLE(position);
      position += 8;
      fields.push({ id, wire, value });
      continue;
    }

    if (wire === 2) {
      const [length, afterLength] = readVarint(buf, position);
      position = afterLength;
      if (position + length > buf.length) break;

      const bytes = buf.subarray(position, position + length);
      position += length;
      fields.push({ id, wire, bytes, string: bytes.toString("utf8") });
      continue;
    }

    if (wire === 5) {
      if (position + 4 > buf.length) break;
      const value = buf.readFloatLE(position);
      position += 4;
      fields.push({ id, wire, value });
      continue;
    }

    break;
  }

  return fields;
}

function fieldsById(fields: ProtoField[], id: number) {
  return fields.filter((field) => field.id === id);
}

function firstField(fields: ProtoField[], id: number) {
  return fields.find((field) => field.id === id);
}

function fieldBytes(fields: ProtoField[], id: number) {
  const field = firstField(fields, id);
  return field?.wire === 2 ? field.bytes : null;
}

function fieldString(fields: ProtoField[], id: number) {
  const field = firstField(fields, id);
  return field?.wire === 2 ? field.string : null;
}

function fieldNumber(fields: ProtoField[], id: number) {
  const field = firstField(fields, id);
  return field && "value" in field ? field.value : null;
}

function parseTeam(buf: Buffer) {
  const fields = scanProto(buf);
  return {
    id: fieldNumber(fields, 1),
    externalId: fieldString(fields, 2),
    name: fieldString(fields, 3) ?? fieldString(fields, 4)
  };
}

function parseMatch(buf: Buffer) {
  const fields = scanProto(buf);
  const teams = fieldBytes(fields, 16);
  const teamFields = teams ? scanProto(teams) : [];
  const homeTeam = fieldBytes(teamFields, 1);
  const awayTeam = fieldBytes(teamFields, 3);

  return {
    id: fieldNumber(fields, 1),
    categoryId: fieldNumber(fields, 9),
    tournamentId: fieldNumber(fields, 10),
    startsAt: fieldString(fields, 13),
    homeTeam: homeTeam ? parseTeam(homeTeam).name : null,
    awayTeam: awayTeam ? parseTeam(awayTeam).name : null
  };
}

function parseOdd(buf: Buffer): BetboomOdd | null {
  const fields = scanProto(buf);
  const id = fieldString(fields, 1);
  const eventId = fieldNumber(fields, 2);
  const price = fieldNumber(fields, 10);

  if (!id || !Number.isFinite(eventId) || !Number.isFinite(price)) return null;

  return {
    id,
    eventId: eventId as number,
    name: fieldString(fields, 5),
    shortName: fieldString(fields, 6),
    side: fieldNumber(fields, 7),
    price: price as number,
    marketName: fieldString(fields, 14),
    groupName: fieldString(fields, 18),
    marketKey: fieldString(fields, 24)
  };
}

function parseEventGroup(buf: Buffer): BetboomEvent | null {
  const fields = scanProto(buf);
  const matchBytes = fieldBytes(fields, 1);
  if (!matchBytes) return null;

  const match = parseMatch(matchBytes);
  if (!match.id || !match.startsAt || !match.homeTeam || !match.awayTeam) return null;

  const odds = fieldsById(fields, 2)
    .map((field) => (field.wire === 2 ? parseOdd(field.bytes) : null))
    .filter((odd): odd is BetboomOdd => Boolean(odd));

  if (!odds.length) return null;

  return {
    id: match.id,
    startsAt: match.startsAt,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    categoryId: match.categoryId,
    tournamentId: match.tournamentId,
    tournamentName: null,
    odds
  };
}

function parseTournamentNode(buf: Buffer): BetboomTournament | null {
  const fields = scanProto(buf);
  const tournamentBytes = fieldBytes(fields, 1);
  if (!tournamentBytes) return null;

  const tournamentFields = scanProto(tournamentBytes);
  const tournamentId = fieldNumber(tournamentFields, 1);
  const categoryId = fieldNumber(tournamentFields, 3);
  const name = fieldString(tournamentFields, 4);

  if (!Number.isFinite(tournamentId) || !name) return null;

  return {
    tournamentId: tournamentId as number,
    categoryId: Number.isFinite(categoryId) ? (categoryId as number) : null,
    name,
    alias: fieldString(tournamentFields, 12)
  };
}

function walkProto<T>(buf: Buffer, parser: (buf: Buffer) => T | null, output: T[], depth = 0) {
  if (depth > 8 || buf.length < 5) return output;

  const parsed = parser(buf);
  if (parsed) output.push(parsed);

  for (const field of scanProto(buf)) {
    if (field.wire === 2 && field.bytes.length < 250_000) {
      walkProto(field.bytes, parser, output, depth + 1);
    }
  }

  return output;
}

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("BetBoom WebSocket connection failed")), { once: true });
  });
}

async function eventDataToBuffer(data: MessageEvent["data"]) {
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}

export class BetboomClient {
  private ws: WebSocket | null = null;
  private readonly buffers: Buffer[] = [];

  constructor(private readonly config: BetboomBookmakerConfig) {}

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.config.wsUrl);
    this.ws.addEventListener("message", async (event) => {
      this.buffers.push(await eventDataToBuffer(event.data));
    });

    await waitForOpen(this.ws);
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = null;
  }

  private send(command: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("BetBoom WebSocket is not open");
    this.ws.send(Uint8Array.from(command));
  }

  private async wait(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getFootballTournaments() {
    await this.connect();
    this.buffers.length = 0;

    this.send(commandAll());
    await this.wait(250);
    this.send(commandRootFootball());
    await this.wait(250);
    this.send(commandFootballTree());
    await this.wait(2500);

    const tournaments = this.buffers.flatMap((buffer) => walkProto(buffer, parseTournamentNode, [] as BetboomTournament[]));
    return [...new Map(tournaments.map((tournament) => [`${tournament.tournamentId}:${tournament.categoryId}`, tournament])).values()];
  }

  async getTournamentEvents(tournamentIds: number[]) {
    await this.connect();
    this.buffers.length = 0;

    for (const tournamentId of tournamentIds) {
      this.send(commandTournament(tournamentId));
      await this.wait(150);
    }

    await this.wait(2500);

    const events = this.buffers.flatMap((buffer) => walkProto(buffer, parseEventGroup, [] as BetboomEvent[]));
    return [...new Map(events.map((event) => [event.id, event])).values()];
  }
}

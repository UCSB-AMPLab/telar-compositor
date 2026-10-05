/**
 * The log codec, against a Map-backed storage fake.
 *
 * The fake implements `list` the way the backend does — filter by prefix and
 * bounds, order by UTF-8 byte comparison, reverse if asked, then limit — and
 * records every call, which is what lets the batching and no-await assertions
 * below be about issuance rather than about outcome. `localeCompare` is never
 * used: it orders by locale, and the backend orders by bytes.
 *
 * The fake is pinned to the real backend by `tests/workers/doc-log-storage.test.ts`,
 * which runs the same listing table against real Durable Object storage and
 * expects the same answers. The table in the two files is written to be read
 * side by side; a change to one belongs in the other.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  LogCorruptionError,
  MAX_PARTS,
  MAX_RECORD_BYTES,
  MAX_SEQ,
  PART_LIMIT,
  baseKey,
  crc32,
  deleteKeys,
  encodeBase,
  encodeHalt,
  encodeRecord,
  haltKey,
  highestSeq,
  logKey,
  logPrefix,
  parseKey,
  partKeys,
  readBase,
  readHalt,
  readRecord,
  replayLog,
  writeGroup,
  type LogListOptions,
  type LogStorage,
  type RecordHeader,
} from "../workers/doc-log";

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

interface Call {
  op: "get" | "list" | "put" | "delete";
  keys?: string[];
  options?: LogListOptions;
  /** True for the calls that take a key list, which the backend caps at 128. */
  batch?: boolean;
}

const encoder = new TextEncoder();

/** UTF-8 byte order, which is the order the backend lists in. */
function byteCompare(a: string, b: string): number {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function inBounds(key: string, options: LogListOptions): boolean {
  if (options.prefix !== undefined && !key.startsWith(options.prefix)) return false;
  if (options.start !== undefined && byteCompare(key, options.start) < 0) return false;
  if (options.startAfter !== undefined && byteCompare(key, options.startAfter) <= 0) return false;
  if (options.end !== undefined && byteCompare(key, options.end) >= 0) return false;
  return true;
}

class FakeStorage implements LogStorage {
  readonly kv = new Map<string, unknown>();
  readonly calls: Call[] = [];
  onPut?: (keys: string[], index: number) => Error | void;
  onDelete?: (keys: string[], index: number) => Error | void;
  private putCount = 0;
  private deleteCount = 0;

  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  get(keyOrKeys: string | string[]): Promise<any> {
    if (Array.isArray(keyOrKeys)) {
      this.calls.push({ op: "get", keys: keyOrKeys, batch: true });
      const found = new Map<string, unknown>();
      for (const key of keyOrKeys) {
        if (this.kv.has(key)) found.set(key, this.kv.get(key));
      }
      return Promise.resolve(found);
    }
    this.calls.push({ op: "get", keys: [keyOrKeys] });
    return Promise.resolve(this.kv.get(keyOrKeys));
  }

  list<T = unknown>(options: LogListOptions = {}): Promise<Map<string, T>> {
    // The real backend rejects `start` and `startAfter` together; the fake
    // has to refuse the combination too, or a caller could rely on behaviour
    // production storage does not have.
    if (options.start !== undefined && options.startAfter !== undefined) {
      throw new RangeError("list options cannot set both start and startAfter");
    }
    this.calls.push({ op: "list", options });
    let keys = [...this.kv.keys()].filter((key) => inBounds(key, options));
    keys.sort(byteCompare);
    if (options.reverse) keys.reverse();
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    const page = new Map<string, unknown>();
    for (const key of keys) page.set(key, this.kv.get(key));
    return Promise.resolve(page as unknown as Map<string, T>);
  }

  put(entries: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(entries);
    this.calls.push({ op: "put", keys, batch: true });
    const failure = this.onPut?.(keys, this.putCount++);
    if (failure) return Promise.reject(failure);
    for (const key of keys) this.kv.set(key, entries[key]);
    return Promise.resolve();
  }

  delete(keys: string[]): Promise<number> {
    this.calls.push({ op: "delete", keys, batch: true });
    const failure = this.onDelete?.(keys, this.deleteCount++);
    if (failure) return Promise.reject(failure);
    let removed = 0;
    for (const key of keys) {
      if (this.kv.delete(key)) removed++;
    }
    return Promise.resolve(removed);
  }

  batched(op: Call["op"]): Call[] {
    return this.calls.filter((call) => call.op === op && call.batch === true);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GEN = 7;

/** Deterministic bytes: a seeded linear congruential draw, not a constant fill. */
function bytesOf(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function partKeyOf(key: string, part: number): string {
  return `${key}:${String(part).padStart(4, "0")}`;
}

function headerOf(storage: FakeStorage, key: string): RecordHeader {
  return storage.kv.get(key) as RecordHeader;
}

/** Write a group straight into the fake, bypassing the batching under test. */
function seed(storage: FakeStorage, group: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(group)) storage.kv.set(key, value);
}

async function corruptionOf(run: () => Promise<unknown>): Promise<LogCorruptionError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof LogCorruptionError) return err;
    throw err;
  }
  throw new Error("expected a LogCorruptionError");
}

async function drain(entries: AsyncGenerator<{ seq: number; bytes: Uint8Array }>) {
  const out: { seq: number; bytes: Uint8Array }[] = [];
  for await (const entry of entries) out.push(entry);
  return out;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

describe("keys", () => {
  it("round-trips every kind", () => {
    expect(logKey(GEN, 42)).toBe("log:7:000000000000042");
    expect(parseKey(logKey(GEN, 42))).toEqual({ kind: "log", generation: GEN, seq: 42 });
    expect(parseKey(partKeyOf(logKey(GEN, 42), 3))).toEqual({
      kind: "log",
      generation: GEN,
      seq: 42,
      part: 3,
    });
    expect(parseKey(baseKey(GEN))).toEqual({ kind: "base", generation: GEN });
    expect(parseKey(partKeyOf(baseKey(GEN), 1))).toEqual({
      kind: "base",
      generation: GEN,
      part: 1,
    });
    expect(parseKey(haltKey(GEN))).toEqual({ kind: "halt", generation: GEN });
  });

  it("accepts generation 0 and refuses a leading zero or an unsafe generation", () => {
    expect(parseKey("log:0:000000000000001")).toEqual({ kind: "log", generation: 0, seq: 1 });
    expect(parseKey(baseKey(0))).toEqual({ kind: "base", generation: 0 });
    expect(parseKey("log:01:000000000000001")).toBeNull();
    expect(parseKey("base:00")).toBeNull();
    expect(parseKey("halt:007")).toBeNull();
    // 2^53, one above the largest safe integer.
    expect(parseKey("log:9007199254740992:000000000000001")).toBeNull();
    expect(() => logKey(1.5, 0)).toThrow(RangeError);
    expect(() => logKey(-1, 0)).toThrow(RangeError);
  });

  it("holds the sequence domain at its edges", () => {
    expect(logKey(GEN, MAX_SEQ)).toBe(`log:${GEN}:999999999999999`);
    expect(parseKey(logKey(GEN, MAX_SEQ))?.seq).toBe(MAX_SEQ);
    expect(() => logKey(GEN, MAX_SEQ + 1)).toThrow(RangeError);
    expect(() => logKey(GEN, -1)).toThrow(RangeError);
    expect(() => logKey(GEN, 1.5)).toThrow(RangeError);
  });

  it("refuses every malformed shape", () => {
    const malformed = [
      "",
      "log",
      "log:7",
      "log:7:",
      "log:7:1",
      "log:7:00000000000004", // fourteen digits
      "log:7:0000000000000042", // sixteen digits
      "log:7:00000000000004a",
      "log:7:000000000000042:", // empty part
      "log:7:000000000000042:0000", // part zero
      "log:7:000000000000042:1", // unpadded part
      "log:7:000000000000042:00001", // five digits
      "log:7:000000000000042:0001:0002",
      "base:7:0000",
      "base:7:",
      "base:",
      "halt:",
      "halt:7:0001",
      "LOG:7:000000000000042",
      "other:7:000000000000042",
      " log:7:000000000000042",
      "log:7:000000000000042 ",
    ];
    for (const key of malformed) expect([key, parseKey(key)]).toEqual([key, null]);
  });

  it("keeps generation 1 out of 10 and 11", () => {
    const prefix = logPrefix(1);
    expect(prefix).toBe("log:1:");
    expect(logKey(10, 1).startsWith(prefix)).toBe(false);
    expect(logKey(11, 1).startsWith(prefix)).toBe(false);
    expect(logKey(1, 1).startsWith(prefix)).toBe(true);
    // The base is read at its exact key, never listed, because `base:1` as a
    // prefix would match `base:10`.
    expect(baseKey(10).startsWith(baseKey(1))).toBe(true);
  });

  it("orders lexicographically exactly as it orders numerically", () => {
    const pairs: [number, number][] = [
      [0, 1],
      [9, 10],
      [99, 100],
      [999, 1000],
      [MAX_SEQ - 1, MAX_SEQ],
    ];
    for (let draw = 0; draw < 1000; draw++) {
      pairs.push([
        Math.floor(Math.random() * (MAX_SEQ + 1)),
        Math.floor(Math.random() * (MAX_SEQ + 1)),
      ]);
    }
    for (const [a, b] of pairs) {
      expect(Math.sign(byteCompare(logKey(GEN, a), logKey(GEN, b)))).toBe(Math.sign(a - b));
    }

    const partPairs: [number, number][] = [
      [1, 2],
      [9, 10],
      [99, 100],
      [MAX_PARTS - 1, MAX_PARTS],
    ];
    for (let draw = 0; draw < 1000; draw++) {
      partPairs.push([
        1 + Math.floor(Math.random() * MAX_PARTS),
        1 + Math.floor(Math.random() * MAX_PARTS),
      ]);
    }
    // The production part keys, not the test-local formatter: this is the
    // one place a regression in `partKeys`'s own padding would show up.
    const key = logKey(GEN, 5);
    const productionPartKey = (part: number): string =>
      partKeys(key, { v: 1, parts: part, length: 0, checksum: 0 })[part - 1];
    for (const [a, b] of partPairs) {
      expect(Math.sign(byteCompare(productionPartKey(a), productionPartKey(b)))).toBe(
        Math.sign(a - b),
      );
    }
  });

  it("lists a parted record's part keys in order", () => {
    const header: RecordHeader = { v: 1, parts: 3, length: 10, checksum: 0 };
    expect(partKeys(logKey(GEN, 1), header)).toEqual([
      "log:7:000000000000001:0001",
      "log:7:000000000000001:0002",
      "log:7:000000000000001:0003",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
  });

  it("answers zero for no bytes and an unsigned integer otherwise", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    const value = crc32(bytesOf(1024));
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe("encodeRecord", () => {
  it("stores a record of exactly the part limit inline and a larger one in parts", async () => {
    const storage = new FakeStorage();
    const key = logKey(GEN, 1);
    const inline = encodeRecord(key, bytesOf(PART_LIMIT));
    expect(Object.keys(inline)).toEqual([key]);
    expect(inline[key]).toBeInstanceOf(Uint8Array);

    const overKey = logKey(GEN, 2);
    const parted = encodeRecord(overKey, bytesOf(PART_LIMIT + 1));
    expect(Object.keys(parted).sort()).toEqual([
      overKey,
      partKeyOf(overKey, 1),
      partKeyOf(overKey, 2),
    ]);
    seed(storage, parted);
    expect(headerOf(storage, overKey).parts).toBe(2);
  });

  it("stores an empty log record inline as empty bytes", async () => {
    const storage = new FakeStorage();
    const key = logKey(GEN, 1);
    const group = encodeRecord(key, new Uint8Array(0));
    expect(Object.keys(group)).toEqual([key]);
    seed(storage, group);
    const read = await readRecord(storage, key);
    expect(read).toEqual(new Uint8Array(0));
  });

  it("writes a 300 KiB record as four parts and reads it back byte for byte", async () => {
    const storage = new FakeStorage();
    const key = logKey(GEN, 9);
    const bytes = bytesOf(300 * 1024, 3);
    const group = encodeRecord(key, bytes);
    await writeGroup(storage, group);

    const header = headerOf(storage, key);
    expect(header).toMatchObject({ v: 1, parts: 4, length: 300 * 1024 });
    expect(header.checksum).toBe(crc32(bytes));
    for (const partKey of partKeys(key, header)) {
      expect(storage.kv.get(partKey)).toBeInstanceOf(Uint8Array);
    }

    const read = await readRecord(storage, key);
    expect(read).toEqual(bytes);
  });

  it("copies a view rather than storing it over its backing buffer", () => {
    const backing = new ArrayBuffer(300 * 1024);
    const view = new Uint8Array(backing, 4096, PART_LIMIT);
    view.set(bytesOf(PART_LIMIT, 5));

    const key = logKey(GEN, 1);
    const inline = encodeRecord(key, view)[key] as Uint8Array;
    expect(inline.byteOffset).toBe(0);
    expect(inline.buffer.byteLength).toBe(inline.length);
    expect(inline).toEqual(view);

    const bigView = new Uint8Array(backing, 1024, PART_LIMIT + 10);
    const parted = encodeRecord(logKey(GEN, 2), bigView);
    const part = parted[partKeyOf(logKey(GEN, 2), 1)] as Uint8Array;
    expect(part.byteOffset).toBe(0);
    expect(part.buffer.byteLength).toBe(part.length);
  });

  it("refuses a record above the ceiling and one needing too many parts", () => {
    const key = logKey(GEN, 1);
    const atCeiling = encodeRecord(key, new Uint8Array(MAX_RECORD_BYTES));
    expect((atCeiling[key] as RecordHeader).parts).toBe(
      Math.ceil(MAX_RECORD_BYTES / PART_LIMIT),
    );
    expect(() => encodeRecord(key, new Uint8Array(MAX_RECORD_BYTES + 1))).toThrow(RangeError);
    // A part limit small enough to need more than 9999 parts.
    expect(() => encodeRecord(key, new Uint8Array(10_000), { partLimit: 1 })).toThrow(RangeError);
  });

  it("refuses a key that is not a canonical log header", () => {
    const bytes = bytesOf(4);
    const notALogHeader = [
      "log:7:1000000000000000", // sixteen digits, above the sequence domain
      "log:01:000000000000001", // leading zero, not a canonical generation
      baseKey(GEN),
      haltKey(GEN),
      partKeyOf(logKey(GEN, 1), 1),
    ];
    for (const key of notALogHeader) {
      expect(() => encodeRecord(key, bytes)).toThrow(RangeError);
    }
  });

  it("accepts a canonical log header key", () => {
    const key = logKey(GEN, 1);
    expect(Object.keys(encodeRecord(key, bytesOf(4)))).toEqual([key]);
  });
});

describe("encodeBase", () => {
  it("parts a base whatever its size and tags it with its generation and sequence", async () => {
    const storage = new FakeStorage();
    const bytes = bytesOf(32, 11);
    seed(storage, encodeBase(GEN, 12, bytes));

    const key = baseKey(GEN);
    expect(storage.kv.get(partKeyOf(key, 1))).toBeInstanceOf(Uint8Array);
    expect(storage.kv.get(key)).toMatchObject({
      v: 1,
      parts: 1,
      length: 32,
      generation: GEN,
      seq: 12,
    });
    expect(await readBase(storage, GEN)).toEqual({ generation: GEN, seq: 12, bytes });
  });

  it("stores an empty base as one part of zero bytes", async () => {
    const storage = new FakeStorage();
    seed(storage, encodeBase(GEN, 0, new Uint8Array(0)));
    const key = baseKey(GEN);
    expect(headerOf(storage, key).parts).toBe(1);
    expect(storage.kv.get(partKeyOf(key, 1))).toEqual(new Uint8Array(0));
    expect(await readBase(storage, GEN)).toEqual({
      generation: GEN,
      seq: 0,
      bytes: new Uint8Array(0),
    });
  });

  it("refuses a sequence or a generation outside its domain", () => {
    expect(() => encodeBase(GEN, MAX_SEQ + 1, new Uint8Array(1))).toThrow(RangeError);
    expect(() => encodeBase(-1, 0, new Uint8Array(1))).toThrow(RangeError);
    expect(() => encodeBase(GEN, 0, new Uint8Array(MAX_RECORD_BYTES + 1))).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

describe("writeGroup", () => {
  function group(size: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let index = 0; index < size; index++) out[logKey(GEN, index)] = bytesOf(4, index + 1);
    return out;
  }

  it("issues 300 keys as three puts with no await between them", async () => {
    const storage = new FakeStorage();
    const order: number[] = [];
    storage.onPut = () => {
      order.push(storage.calls.length);
    };
    // Queued before the write: if `writeGroup` awaited between batches, this
    // microtask would run in the gap and land between the puts.
    queueMicrotask(() => order.push(-1));

    const pending = writeGroup(storage, group(300));
    expect(storage.calls.filter((call) => call.op === "put").map((call) => call.keys?.length))
      .toEqual([128, 128, 44]);

    await pending;
    expect(order).toEqual([1, 2, 3, -1]);
    expect(storage.kv.size).toBe(300);
  });

  it("rejects when any batch rejects", async () => {
    const storage = new FakeStorage();
    storage.onPut = (_keys, index) => (index === 1 ? new Error("batch refused") : undefined);
    await expect(writeGroup(storage, group(300))).rejects.toThrow("batch refused");
  });

  it("throws synchronously when put throws synchronously", () => {
    const storage = new FakeStorage();
    storage.onPut = () => {
      throw new Error("storage gone");
    };
    expect(() => writeGroup(storage, group(300))).toThrow("storage gone");
  });

  it("accepts an empty group", async () => {
    const storage = new FakeStorage();
    await writeGroup(storage, {});
    expect(storage.calls).toEqual([]);
  });
});

describe("deleteKeys", () => {
  const keys = Array.from({ length: 300 }, (_value, index) => logKey(GEN, index));

  it("deletes 300 keys in three batches", async () => {
    const storage = new FakeStorage();
    for (const key of keys) storage.kv.set(key, new Uint8Array(1));
    expect(await deleteKeys(storage, keys)).toBe(300);
    expect(storage.calls.map((call) => call.keys?.length)).toEqual([128, 128, 44]);
    expect(storage.kv.size).toBe(0);
  });

  it("rejects on the first failing batch", async () => {
    const storage = new FakeStorage();
    storage.onDelete = (_keys, index) => (index === 1 ? new Error("delete refused") : undefined);
    await expect(deleteKeys(storage, keys)).rejects.toThrow("delete refused");
    expect(storage.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Batching on the read side
// ---------------------------------------------------------------------------

describe("a record of 129 parts", () => {
  const key = logKey(GEN, 4);
  const bytes = bytesOf(129 * 64, 7);

  function seededLarge(): FakeStorage {
    const storage = new FakeStorage();
    seed(storage, encodeRecord(key, bytes, { partLimit: 64 }));
    return storage;
  }

  it("writes in two put batches and reads back in two get batches", async () => {
    const storage = new FakeStorage();
    await writeGroup(storage, encodeRecord(key, bytes, { partLimit: 64 }));
    expect(headerOf(storage, key).parts).toBe(129);
    expect(storage.batched("put").map((call) => call.keys?.length)).toEqual([128, 2]);

    storage.calls.length = 0;
    expect(await readRecord(storage, key)).toEqual(bytes);
    expect(storage.batched("get").map((call) => call.keys?.length)).toEqual([128, 1]);
  });

  it("reports a missing last part", async () => {
    const storage = seededLarge();
    storage.kv.delete(partKeyOf(key, 129));
    expect((await corruptionOf(() => readRecord(storage, key))).reason).toBe("missing_part");
  });
});

// ---------------------------------------------------------------------------
// Corruption
// ---------------------------------------------------------------------------

describe("corruption", () => {
  const key = logKey(GEN, 3);

  function seededParted(): FakeStorage {
    const storage = new FakeStorage();
    seed(storage, encodeRecord(key, bytesOf(300, 2), { partLimit: 100 }));
    return storage;
  }

  it("reports a missing part", async () => {
    const storage = seededParted();
    storage.kv.delete(partKeyOf(key, 2));
    expect((await corruptionOf(() => readRecord(storage, key))).key).toBe(key);
    expect((await corruptionOf(() => readRecord(storage, key))).reason).toBe("missing_part");
  });

  it("reports a part that is not bytes", async () => {
    const storage = seededParted();
    storage.kv.set(partKeyOf(key, 2), "not bytes");
    expect((await corruptionOf(() => readRecord(storage, key))).reason).toBe("missing_part");
  });

  it("reports a short part and a long part alike", async () => {
    const short = seededParted();
    short.kv.set(partKeyOf(key, 2), new Uint8Array(50));
    expect((await corruptionOf(() => readRecord(short, key))).reason).toBe("short");

    const long = seededParted();
    long.kv.set(partKeyOf(key, 2), new Uint8Array(150));
    expect((await corruptionOf(() => readRecord(long, key))).reason).toBe("short");
  });

  it("reports a checksum mismatch", async () => {
    const storage = seededParted();
    const part = new Uint8Array(storage.kv.get(partKeyOf(key, 2)) as Uint8Array);
    part[0] = part[0] ^ 0xff;
    storage.kv.set(partKeyOf(key, 2), part);
    expect((await corruptionOf(() => readRecord(storage, key))).reason).toBe("checksum");
  });

  it("reports every bad header shape", async () => {
    const shapes: unknown[] = [
      null,
      "bytes",
      42,
      [],
      {},
      { v: 2, parts: 1, length: 1, checksum: 0 },
      { v: 1, parts: 0, length: 0, checksum: 0 },
      { v: 1, parts: 1.5, length: 1, checksum: 0 },
      { v: 1, parts: MAX_PARTS + 1, length: 1, checksum: 0 },
      { v: 1, parts: 1, length: -1, checksum: 0 },
      { v: 1, parts: 1, length: 1.5, checksum: 0 },
      { v: 1, parts: 1, length: PART_LIMIT + 1, checksum: 0 },
      { v: 1, parts: 1, length: MAX_RECORD_BYTES + 1, checksum: 0 },
      { v: 1, parts: 1, length: 1, checksum: -1 },
      { v: 1, parts: 1, length: 1, checksum: 0x1_0000_0000 },
      { v: 1, parts: 1, length: 1, checksum: 1.5 },
      { v: 1, parts: 1, length: 1 },
    ];
    for (const shape of shapes) {
      const storage = new FakeStorage();
      storage.kv.set(key, shape);
      const error = await corruptionOf(() => readRecord(storage, key));
      expect([shape, error.reason]).toEqual([shape, "bad_header"]);
    }
  });

  it("refuses a length above the ceiling before allocating, and accepts one at it", async () => {
    const parts = Math.ceil(MAX_RECORD_BYTES / PART_LIMIT);
    const storage = new FakeStorage();

    storage.kv.set(key, { v: 1, parts, length: MAX_RECORD_BYTES + 1, checksum: 0 });
    expect((await corruptionOf(() => readRecord(storage, key))).reason).toBe("bad_header");
    // Nothing beyond the header itself is fetched when the header is refused.
    expect(storage.batched("get")).toEqual([]);

    // The same header at the ceiling passes validation and fails on its parts.
    storage.kv.set(key, { v: 1, parts, length: MAX_RECORD_BYTES, checksum: 0 });
    expect((await corruptionOf(() => readRecord(storage, key))).reason).toBe("missing_part");
  });

  function seededPartedBase(): FakeStorage {
    const storage = new FakeStorage();
    seed(storage, encodeBase(GEN, 12, bytesOf(300, 6), { partLimit: 100 }));
    return storage;
  }

  it("reports a missing part for a base", async () => {
    const storage = seededPartedBase();
    storage.kv.delete(partKeyOf(baseKey(GEN), 2));
    expect((await corruptionOf(() => readBase(storage, GEN))).reason).toBe("missing_part");
  });

  it("reports a short part and a long part alike for a base", async () => {
    const short = seededPartedBase();
    short.kv.set(partKeyOf(baseKey(GEN), 2), new Uint8Array(50));
    expect((await corruptionOf(() => readBase(short, GEN))).reason).toBe("short");

    const long = seededPartedBase();
    long.kv.set(partKeyOf(baseKey(GEN), 2), new Uint8Array(150));
    expect((await corruptionOf(() => readBase(long, GEN))).reason).toBe("short");
  });

  it("reports a checksum mismatch for a base", async () => {
    const storage = seededPartedBase();
    const part = new Uint8Array(storage.kv.get(partKeyOf(baseKey(GEN), 2)) as Uint8Array);
    part[0] = part[0] ^ 0xff;
    storage.kv.set(partKeyOf(baseKey(GEN), 2), part);
    expect((await corruptionOf(() => readBase(storage, GEN))).reason).toBe("checksum");
  });

  it("reports every bad header shape for a base, including zero parts", async () => {
    const shapes: unknown[] = [
      null,
      "bytes",
      42,
      [],
      {},
      { v: 2, parts: 1, length: 1, checksum: 0, generation: GEN, seq: 1 },
      { v: 1, parts: 0, length: 0, checksum: 0, generation: GEN, seq: 1 },
      { v: 1, parts: 1.5, length: 1, checksum: 0, generation: GEN, seq: 1 },
      { v: 1, parts: MAX_PARTS + 1, length: 1, checksum: 0, generation: GEN, seq: 1 },
      { v: 1, parts: 1, length: -1, checksum: 0, generation: GEN, seq: 1 },
      { v: 1, parts: 1, length: 1.5, checksum: 0, generation: GEN, seq: 1 },
      { v: 1, parts: 1, length: PART_LIMIT + 1, checksum: 0, generation: GEN, seq: 1 },
      { v: 1, parts: 1, length: MAX_RECORD_BYTES + 1, checksum: 0, generation: GEN, seq: 1 },
      { v: 1, parts: 1, length: 1, checksum: -1, generation: GEN, seq: 1 },
      { v: 1, parts: 1, length: 1, checksum: 0x1_0000_0000, generation: GEN, seq: 1 },
      { v: 1, parts: 1, length: 1, checksum: 1.5, generation: GEN, seq: 1 },
      { v: 1, parts: 1, length: 1, generation: GEN, seq: 1 },
    ];
    for (const shape of shapes) {
      const storage = new FakeStorage();
      storage.kv.set(baseKey(GEN), shape);
      const error = await corruptionOf(() => readBase(storage, GEN));
      expect([shape, error.reason]).toEqual([shape, "bad_header"]);
    }
  });

  it("refuses bytes at a base key and a base header missing its pair", async () => {
    const inline = new FakeStorage();
    inline.kv.set(baseKey(GEN), new Uint8Array(4));
    expect((await corruptionOf(() => readBase(inline, GEN))).reason).toBe("bad_header");
    expect((await corruptionOf(() => readRecord(inline, baseKey(GEN)))).reason).toBe("bad_header");

    const shapes: unknown[] = [
      { v: 1, parts: 1, length: 1, checksum: 0 },
      { v: 1, parts: 1, length: 1, checksum: 0, generation: GEN },
      { v: 1, parts: 1, length: 1, checksum: 0, seq: 1 },
      { v: 1, parts: 1, length: 1, checksum: 0, generation: GEN, seq: -1 },
      { v: 1, parts: 1, length: 1, checksum: 0, generation: GEN, seq: MAX_SEQ + 1 },
      { v: 1, parts: 1, length: 1, checksum: 0, generation: GEN + 1, seq: 1 },
      { v: 1, parts: 1, length: 1, checksum: 0, generation: "7", seq: 1 },
    ];
    for (const shape of shapes) {
      const storage = new FakeStorage();
      storage.kv.set(baseKey(GEN), shape);
      const error = await corruptionOf(() => readBase(storage, GEN));
      expect([shape, error.reason]).toEqual([shape, "bad_header"]);
    }
  });

  it("answers null for an absent record and for orphan parts", async () => {
    const storage = new FakeStorage();
    expect(await readRecord(storage, key)).toBeNull();
    expect(await readBase(storage, GEN)).toBeNull();

    storage.kv.set(partKeyOf(key, 1), new Uint8Array(4));
    storage.kv.set(partKeyOf(baseKey(GEN), 1), new Uint8Array(4));
    expect(await readRecord(storage, key)).toBeNull();
    expect(await readBase(storage, GEN)).toBeNull();
  });

  it("refuses a key it does not own", async () => {
    const storage = new FakeStorage();
    await expect(readRecord(storage, "log:7:bad")).rejects.toThrow(RangeError);
    await expect(readRecord(storage, haltKey(GEN))).rejects.toThrow(RangeError);
    await expect(readRecord(storage, partKeyOf(logKey(GEN, 1), 1))).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// The halt marker
// ---------------------------------------------------------------------------

describe("halt marker", () => {
  it("answers null when the key is absent and round-trips a written marker", async () => {
    const storage = new FakeStorage();
    expect(await readHalt(storage, GEN)).toBeNull();

    const before = Date.now();
    await writeGroup(storage, encodeHalt(GEN, "enforcement_failed"));
    const marker = await readHalt(storage, GEN);
    expect(marker?.v).toBe(1);
    expect(marker?.reason).toBe("enforcement_failed");
    expect(marker?.at).toBeGreaterThanOrEqual(before);
    expect(Number.isInteger(marker?.at)).toBe(true);
  });

  it("throws rather than reading damage as not halted", async () => {
    const shapes: unknown[] = [
      null,
      "halted",
      0,
      [],
      {},
      { v: 2, reason: "apply_failed", at: 1 },
      { v: 1, reason: "", at: 1 },
      { v: 1, reason: "Apply Failed", at: 1 },
      { v: 1, reason: "a".repeat(33), at: 1 },
      { v: 1, reason: "apply_failed" },
      { v: 1, reason: "apply_failed", at: -1 },
      { v: 1, reason: "apply_failed", at: 1.5 },
      { v: 1, reason: "apply_failed", at: "1" },
    ];
    for (const shape of shapes) {
      const storage = new FakeStorage();
      storage.kv.set(haltKey(GEN), shape);
      const error = await corruptionOf(() => readHalt(storage, GEN));
      expect([shape, error.reason]).toEqual([shape, "bad_halt"]);
    }
  });

  it("refuses a reason outside its domain before writing", () => {
    for (const reason of ["", "Apply", "apply failed", "apply-failed", "a".repeat(33), "a1"]) {
      expect(() => encodeHalt(GEN, reason)).toThrow(RangeError);
    }
    expect(Object.keys(encodeHalt(GEN, "reset"))).toEqual([haltKey(GEN)]);
  });

  it("propagates a rejected put through writeGroup", async () => {
    const storage = new FakeStorage();
    storage.onPut = () => new Error("halt put refused");
    await expect(writeGroup(storage, encodeHalt(GEN, "reset"))).rejects.toThrow(
      "halt put refused",
    );
    expect(await readHalt(storage, GEN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe("replayLog", () => {
  const TOTAL = 2500;

  function seededLog(): FakeStorage {
    const storage = new FakeStorage();
    for (let seq = 1; seq <= TOTAL; seq++) {
      seed(storage, encodeRecord(logKey(GEN, seq), bytesOf(8, seq)));
    }
    return storage;
  }

  it("yields every record in order, in pages of 64", async () => {
    const storage = seededLog();
    const entries = await drain(replayLog(storage, GEN, 0));
    expect(entries).toHaveLength(TOTAL);
    expect(entries.map((entry) => entry.seq)).toEqual(
      Array.from({ length: TOTAL }, (_value, index) => index + 1),
    );
    expect(entries[41].bytes).toEqual(bytesOf(8, 42));

    const lists = storage.calls.filter((call) => call.op === "list");
    expect(lists.every((call) => call.options?.limit === 64)).toBe(true);
    expect(lists.length).toBeGreaterThanOrEqual(Math.ceil(TOTAL / 64));
  });

  it("skips everything at or below the starting sequence", async () => {
    const storage = seededLog();
    const entries = await drain(replayLog(storage, GEN, 1000));
    expect(entries).toHaveLength(TOTAL - 1000);
    expect(entries[0].seq).toBe(1001);
  });

  it("reports foreign keys, steps over orphan parts, and reads a parted record", async () => {
    const storage = new FakeStorage();
    seed(storage, encodeRecord(logKey(GEN, 1), bytesOf(16, 1)));
    // A small part limit gives this one record more parts than fit in a
    // single listed page (its header plus parts outnumber `REPLAY_PAGE`), so
    // assembling it forces the outer listing to page more than once.
    const bigPartLimit = 1024;
    const big = bytesOf(bigPartLimit * 70 - 100, 4);
    seed(storage, encodeRecord(logKey(GEN, 2), big, { partLimit: bigPartLimit }));
    expect(headerOf(storage, logKey(GEN, 2)).parts).toBeGreaterThan(64);
    seed(storage, encodeRecord(logKey(GEN, 3), bytesOf(16, 3)));
    // An orphan part with no header of its own, and two keys this codec does
    // not own, all under the same prefix.
    storage.kv.set(partKeyOf(logKey(GEN, 4), 1), new Uint8Array(4));
    storage.kv.set(`${logPrefix(GEN)}marker`, "foreign");
    storage.kv.set(`${logPrefix(GEN)}00000000000000x`, "foreign");
    // A neighbouring generation, which the exact prefix keeps out.
    seed(storage, encodeRecord(logKey(GEN * 10, 1), bytesOf(16, 9)));

    const skipped: string[] = [];
    const entries = await drain(replayLog(storage, GEN, 0, { onSkipped: (key) => skipped.push(key) }));

    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries[1].bytes).toEqual(big);
    expect(skipped).toEqual([`${logPrefix(GEN)}00000000000000x`, `${logPrefix(GEN)}marker`]);
    // The record's own header and parts alone outnumber one page, so this
    // could not have been satisfied by a single `list` call.
    const lists = storage.calls.filter((call) => call.op === "list");
    expect(lists.length).toBeGreaterThan(1);
  });

  it("answers nothing for an empty prefix", async () => {
    const storage = new FakeStorage();
    expect(await drain(replayLog(storage, GEN, 0))).toEqual([]);
  });

  it("caps a requested page size at the page bound", async () => {
    const storage = seededLog();
    const entries = await drain(replayLog(storage, GEN, 0, { pageSize: 10_000 }));
    expect(entries).toHaveLength(TOTAL);
    const lists = storage.calls.filter((call) => call.op === "list");
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((call) => call.options?.limit === 64)).toBe(true);
  });

  it("refuses a page size that is not a positive integer", async () => {
    const storage = seededLog();
    for (const pageSize of [0, -1, 1.5]) {
      await expect(drain(replayLog(storage, GEN, 0, { pageSize }))).rejects.toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// The highest sequence
// ---------------------------------------------------------------------------

describe("highestSeq", () => {
  it("answers null for an empty prefix and for orphan parts alone", async () => {
    const storage = new FakeStorage();
    expect(await highestSeq(storage, GEN)).toBeNull();

    storage.kv.set(partKeyOf(logKey(GEN, 5), 1), new Uint8Array(4));
    storage.kv.set(partKeyOf(logKey(GEN, 6), 1), new Uint8Array(4));
    expect(await highestSeq(storage, GEN)).toBeNull();
  });

  it("finds the highest inline record", async () => {
    const storage = new FakeStorage();
    for (const seq of [1, 2, 5]) seed(storage, encodeRecord(logKey(GEN, seq), bytesOf(8, seq)));
    expect(await highestSeq(storage, GEN)).toBe(5);
  });

  it("finds a parted record whose parts sort above its header", async () => {
    const storage = new FakeStorage();
    seed(storage, encodeRecord(logKey(GEN, 1), bytesOf(8, 1)));
    seed(storage, encodeRecord(logKey(GEN, 5), bytesOf(300, 5), { partLimit: 100 }));
    expect(await highestSeq(storage, GEN)).toBe(5);
  });

  it("steps over trailing orphan parts above the highest header", async () => {
    const storage = new FakeStorage();
    seed(storage, encodeRecord(logKey(GEN, 5), bytesOf(8, 5)));
    for (let part = 1; part <= 3; part++) {
      storage.kv.set(partKeyOf(logKey(GEN, 9), part), new Uint8Array(4));
    }
    expect(await highestSeq(storage, GEN)).toBe(5);
  });

  it("reports trailing malformed keys spread across more than one reverse page", async () => {
    const storage = new FakeStorage();
    seed(storage, encodeRecord(logKey(GEN, 5), bytesOf(8, 5)));
    const foreign: string[] = [];
    for (let index = 0; index < 20; index++) {
      const key = `${logPrefix(GEN)}zz${String(index).padStart(2, "0")}`;
      foreign.push(key);
      storage.kv.set(key, "foreign");
    }

    const skipped: string[] = [];
    expect(await highestSeq(storage, GEN, { onSkipped: (key) => skipped.push(key) })).toBe(5);
    expect(skipped.sort()).toEqual(foreign.sort());

    const lists = storage.calls.filter((call) => call.op === "list");
    expect(lists.length).toBeGreaterThan(1);
    expect(lists.every((call) => call.options?.reverse === true)).toBe(true);
    // Paging downward uses `end`, which is exclusive; `startAfter` stays a
    // lower bound when a listing is reversed and cannot page it.
    expect(lists[0].options?.end).toBeUndefined();
    expect(lists[1].options?.end).toBe(foreign[4]);
  });

  it("keeps a neighbouring generation out of the answer", async () => {
    const storage = new FakeStorage();
    seed(storage, encodeRecord(logKey(1, 3), bytesOf(8, 3)));
    seed(storage, encodeRecord(logKey(10, 99), bytesOf(8, 99)));
    seed(storage, encodeRecord(logKey(11, 98), bytesOf(8, 98)));
    expect(await highestSeq(storage, 1)).toBe(3);
    expect(await highestSeq(storage, 10)).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Listing semantics, pinned against the backend
// ---------------------------------------------------------------------------

// A fullwidth tilde, U+FF5E: three UTF-8 bytes starting 0xEF, and a single
// UTF-16 code unit (0xFF5E).
const NON_ASCII_TILDE = "～";
// A grinning-face emoji, U+1F600, outside the basic multilingual plane: four
// UTF-8 bytes starting 0xF0, above the tilde's 0xEF, but a UTF-16 surrogate
// pair starting 0xD83D, below the tilde's single code unit — so comparing by
// UTF-8 bytes and comparing by UTF-16 code unit order these two oppositely,
// which is what makes the pair a discriminating test of `byteCompare`.
const NON_ASCII_EMOJI = "\u{1F600}";

/**
 * The listing table `tests/workers/doc-log-storage.test.ts` runs against real
 * Durable Object storage. Both files state the expectations as sequence labels
 * rather than as literal keys, so the same table reads the same in each while
 * the generation differs.
 */
export const LIST_SCENARIO = {
  seqs: [1, 2, 3, 10, 11],
  partOf: 3,
  nonAsciiSuffixes: [NON_ASCII_TILDE, NON_ASCII_EMOJI],
  queries: [
    {
      name: "whole prefix",
      options: {},
      expect: ["1", "2", "3", "3:0001", "10", "11", NON_ASCII_TILDE, NON_ASCII_EMOJI],
    },
    {
      name: "startAfter a header",
      options: { after: 3 },
      expect: ["3:0001", "10", "11", NON_ASCII_TILDE, NON_ASCII_EMOJI],
    },
    { name: "end below a header", options: { end: 10 }, expect: ["1", "2", "3", "3:0001"] },
    {
      name: "start at a header",
      options: { start: 3 },
      expect: ["3", "3:0001", "10", "11", NON_ASCII_TILDE, NON_ASCII_EMOJI],
    },
    { name: "limit", options: { limit: 2 }, expect: ["1", "2"] },
    {
      name: "reverse with a limit",
      options: { reverse: true, limit: 2 },
      expect: [NON_ASCII_EMOJI, NON_ASCII_TILDE],
    },
    {
      name: "reverse below an end",
      options: { reverse: true, end: 10 },
      expect: ["3:0001", "3", "2", "1"],
    },
    {
      name: "reverse with startAfter",
      options: { reverse: true, after: 3 },
      expect: [NON_ASCII_EMOJI, NON_ASCII_TILDE, "11", "10", "3:0001"],
    },
  ],
} as const;

describe("listing semantics", () => {
  it("refuses start and startAfter together", () => {
    const storage = new FakeStorage();
    expect(() =>
      storage.list({ start: logKey(GEN, 1), startAfter: logKey(GEN, 1) }),
    ).toThrow(RangeError);
  });

  it("matches the table the workers project runs against real storage", async () => {
    const storage = new FakeStorage();
    for (const seq of LIST_SCENARIO.seqs) storage.kv.set(logKey(GEN, seq), new Uint8Array(1));
    storage.kv.set(partKeyOf(logKey(GEN, LIST_SCENARIO.partOf), 1), new Uint8Array(1));
    for (const suffix of LIST_SCENARIO.nonAsciiSuffixes) {
      storage.kv.set(`${logPrefix(GEN)}${suffix}`, new Uint8Array(1));
    }
    // A generation whose decimal form starts with this one's: the trailing
    // colon in the prefix is the whole defence.
    storage.kv.set(logKey(GEN * 10, 1), new Uint8Array(1));

    for (const query of LIST_SCENARIO.queries) {
      const options: LogListOptions = { prefix: logPrefix(GEN) };
      const source = query.options as {
        after?: number;
        start?: number;
        end?: number;
        limit?: number;
        reverse?: boolean;
      };
      if (source.after !== undefined) options.startAfter = logKey(GEN, source.after);
      if (source.start !== undefined) options.start = logKey(GEN, source.start);
      if (source.end !== undefined) options.end = logKey(GEN, source.end);
      if (source.limit !== undefined) options.limit = source.limit;
      if (source.reverse !== undefined) options.reverse = source.reverse;

      const page = await storage.list(options);
      const labels = [...page.keys()].map((key) => key.slice(logPrefix(GEN).length).replace(/^0+/, ""));
      expect([query.name, labels]).toEqual([query.name, [...query.expect]]);
    }
  });
});

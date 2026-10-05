/**
 * The log codec against real Durable Object storage inside workerd.
 *
 * The unit suite runs the codec over a Map-backed fake, which can assert what
 * the codec issues but not what the backend accepts. This file exercises what
 * only real storage can show: that a write issued without an `await` survives
 * an eviction, that a group spanning more than one put batch reads back
 * whole, and that `startAfter`, `end`, `reverse` and `limit` behave exactly as
 * the fake assumes — its listing table is the same one `tests/doc-log.test.ts`
 * runs against the fake, the two stating their expectations as sequence
 * labels rather than as literal keys so they read side by side while the
 * generation differs. The local harness does not enforce the backend's
 * 128 KiB per-value limit, so it cannot show whether an uncopied view would
 * be refused; that constraint is pinned in the unit project instead (see the
 * nonzero-offset view test below).
 *
 * Storage is shared across this project's files, so every test addresses a
 * Durable Object of its own and mints its own generation: no test can read a
 * key another test wrote.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import {
  PART_LIMIT,
  encodeRecord,
  logKey,
  logPrefix,
  readRecord,
  writeGroup,
  type LogListOptions,
  type LogStorage,
} from "../../workers/doc-log";
import { hibernate } from "./helpers/hibernate";

let stubCounter = 0;
let generationCounter = 0;

function freshStub(label: string): DurableObjectStub {
  stubCounter += 1;
  const name = `doc-log-${label}-${Date.now()}-${stubCounter}-${Math.floor(Math.random() * 1e6)}`;
  return env.COLLABORATION.get(env.COLLABORATION.idFromName(name));
}

/** A generation of this test's own, small enough that ten times it stays safe. */
function freshGeneration(): number {
  generationCounter += 1;
  return generationCounter * 1000 + Math.floor(Math.random() * 1000);
}

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

function readBack(stub: DurableObjectStub, key: string): Promise<Uint8Array | null> {
  return runInDurableObject(stub, (_instance, state) => {
    const storage: LogStorage = state.storage;
    return readRecord(storage, key);
  });
}

describe("the log codec against real Durable Object storage", () => {
  it("keeps a 300 KiB record issued without an await across an eviction", async () => {
    const stub = freshStub("evict");
    const key = logKey(freshGeneration(), 1);
    const bytes = bytesOf(300 * 1024, 3);

    await runInDurableObject(stub, (_instance, state) => {
      const storage: LogStorage = state.storage;
      // Not awaited, which is what the message path does: the output gate is
      // what makes the write durable before anything leaves the object. An
      // eviction after it proves the write completed and survived; no harness
      // can interrupt a commit half way, and this does not claim to.
      void writeGroup(storage, encodeRecord(key, bytes));
    });

    await hibernate(stub);

    expect(await readBack(stub, key)).toEqual(bytes);
  });

  it("reads back a group that spans more than one put batch", async () => {
    const stub = freshStub("batches");
    const key = logKey(freshGeneration(), 1);
    // 129 parts plus a header: 130 keys, above the backend's 128-key multi-put.
    const bytes = bytesOf(129 * 64, 7);

    await runInDurableObject(stub, async (_instance, state) => {
      const storage: LogStorage = state.storage;
      await writeGroup(storage, encodeRecord(key, bytes, { partLimit: 64 }));
    });

    expect(await readBack(stub, key)).toEqual(bytes);
  });

  it("stores a nonzero-offset view as its own bytes, inline and in parts", async () => {
    const stub = freshStub("view");
    const generation = freshGeneration();
    const backing = new ArrayBuffer(300 * 1024);
    const source = bytesOf(PART_LIMIT + 10, 5);
    new Uint8Array(backing, 4096, source.length).set(source);

    // A 96 KiB view into a 300 KiB buffer. Stored as the view, V8 would
    // serialise the whole buffer and the backend would refuse the value.
    const inlineKey = logKey(generation, 1);
    const inlineView = new Uint8Array(backing, 4096, PART_LIMIT);
    const partedKey = logKey(generation, 2);
    const partedView = new Uint8Array(backing, 4096, PART_LIMIT + 10);

    await runInDurableObject(stub, async (_instance, state) => {
      const storage: LogStorage = state.storage;
      await writeGroup(storage, encodeRecord(inlineKey, inlineView));
      await writeGroup(storage, encodeRecord(partedKey, partedView));
    });

    expect(await readBack(stub, inlineKey)).toEqual(new Uint8Array(inlineView));
    expect(await readBack(stub, partedKey)).toEqual(new Uint8Array(partedView));

    // The local harness does not enforce the backend's 128 KiB per-value
    // limit, so it cannot show whether an uncopied view — which would
    // serialise with its whole backing buffer — would be refused; and a
    // value read back has already been through the deserialiser, so it
    // carries a buffer of its own regardless of what was stored. The copy is
    // pinned where it can be observed instead, in the unit project, on the
    // stored value's `byteOffset` and buffer length before any
    // serialisation. The guarantee this test can state is narrower: only
    // that the round trip is exact.
  });

  it("lists exactly as the unit project's fake lists", async () => {
    const stub = freshStub("list");
    const generation = freshGeneration();
    const prefix = logPrefix(generation);

    await runInDurableObject(stub, async (_instance, state) => {
      const storage: LogStorage = state.storage;
      const group: Record<string, unknown> = {};
      for (const seq of SEQS) group[logKey(generation, seq)] = new Uint8Array(1);
      group[`${logKey(generation, PART_OF)}:0001`] = new Uint8Array(1);
      for (const suffix of NON_ASCII_SUFFIXES) group[`${prefix}${suffix}`] = new Uint8Array(1);
      // A generation whose decimal form starts with this one's: the trailing
      // colon in the prefix is the whole defence.
      group[logKey(generation * 10, 1)] = new Uint8Array(1);
      await writeGroup(storage, group);
    });

    const pages = await runInDurableObject(stub, async (_instance, state) => {
      const storage: LogStorage = state.storage;
      const out: string[][] = [];
      for (const query of QUERIES) {
        const page = await storage.list<unknown>(optionsFor(generation, query.options));
        out.push([...page.keys()].map((key) => key.slice(prefix.length).replace(/^0+/, "")));
      }
      return out;
    });

    QUERIES.forEach((query, index) => {
      expect([query.name, pages[index]]).toEqual([query.name, [...query.expect]]);
    });
  });
});

// ---------------------------------------------------------------------------
// The listing table, stated as in `tests/doc-log.test.ts`
// ---------------------------------------------------------------------------

const SEQS = [1, 2, 3, 10, 11];
const PART_OF = 3;

// A fullwidth tilde, U+FF5E: three UTF-8 bytes starting 0xEF, and a single
// UTF-16 code unit (0xFF5E).
const NON_ASCII_TILDE = "～";
// A grinning-face emoji, U+1F600, outside the basic multilingual plane: four
// UTF-8 bytes starting 0xF0, above the tilde's 0xEF, but a UTF-16 surrogate
// pair starting 0xD83D, below the tilde's single code unit — so comparing by
// UTF-8 bytes and comparing by UTF-16 code unit order these two oppositely,
// which is what makes the pair a discriminating test of the backend's order.
const NON_ASCII_EMOJI = "\u{1F600}";
const NON_ASCII_SUFFIXES = [NON_ASCII_TILDE, NON_ASCII_EMOJI];

interface QueryOptions {
  after?: number;
  start?: number;
  end?: number;
  limit?: number;
  reverse?: boolean;
}

const QUERIES: { name: string; options: QueryOptions; expect: string[] }[] = [
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
];

function optionsFor(generation: number, query: QueryOptions): LogListOptions {
  const options: LogListOptions = { prefix: logPrefix(generation) };
  if (query.after !== undefined) options.startAfter = logKey(generation, query.after);
  if (query.start !== undefined) options.start = logKey(generation, query.start);
  if (query.end !== undefined) options.end = logKey(generation, query.end);
  if (query.limit !== undefined) options.limit = query.limit;
  if (query.reverse !== undefined) options.reverse = query.reverse;
  return options;
}

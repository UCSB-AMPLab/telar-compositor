/**
 * An objects array holding an entry the server cannot read at all does not
 * keep an object the document has removed.
 *
 * The snapshot sweeps D1 rows no entry claims, and an entry it cannot read
 * turns the sweep off for the whole table, since the entry may be the claim on
 * a live row. A removal delivered while such an entry sits in the array then
 * never reaches D1. An entry that carries no identity (a bare value, an array,
 * `null`, an object with no `_id`, `_temp_id` or `object_id`) claims no row and
 * holds nothing the snapshot would have written, so the snapshot drops it and
 * the sweep runs. An entry that does carry identity may be the claim on a live
 * row; the sweep stays off for it, as before.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { ProjectCollaborationDO } from "../workers/collaboration";
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

const TEST_PROJECT_ID = 42;
const REMOVED_ROW = 55;

interface BindCall {
  sql: string;
  args: unknown[];
}

function makeDO(rowProvider: (sql: string) => unknown[]) {
  const binds: BindCall[] = [];
  const stmt = (sql: string) => ({
    bind(...args: unknown[]) {
      checkD1Bind(sql, args);
      binds.push({ sql, args });
      return {
        async run() {
          return { meta: { last_row_id: 100, changes: 1 } };
        },
        async all<T>() {
          return { results: rowProvider(sql) as T[] };
        },
        async first<T>() {
          return (rowProvider(sql)[0] ?? null) as T | null;
        },
      };
    },
  });
  const DB = {
    prepare: (sql: string) => stmt(sql),
    async batch() {
      return [];
    },
  };
  const env = { DB, SESSION_SECRET: "s", COLLABORATION: {} } as unknown;
  const ctx = {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  markLoaded(doInstance);
  return { doInstance, binds };
}


function removedRowStillInD1(sql: string): unknown[] {
  if (/SELECT id, object_id FROM objects WHERE project_id/.test(sql)) {
    return [{ id: REMOVED_ROW, object_id: "bell" }];
  }
  return [];
}

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

function deletedIds(binds: BindCall[], table: string): unknown[] {
  return binds
    .filter((b) => new RegExp(`DELETE FROM ${table}\\b`).test(b.sql))
    .flatMap((b) => b.args);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ["a plain empty object", () => JSON.parse("{}") as unknown],
  ["an object with no identity", () => JSON.parse('{"title": "x"}') as unknown],
  ["a string", () => "bell"],
  ["a number", () => 0],
  ["null", () => null],
  ["a plain array", () => JSON.parse("[]") as unknown],
])("an objects array holding %s beside a removed object", (_label, makeEntry) => {
  it("drops the entry, deletes the removed object's row, and leaves the array readable", async () => {
    const { doInstance, binds } = makeDO(removedRowStillInD1);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      ydoc.getArray<unknown>("objects").push([makeEntry()]);
    }, null);

    await snapshot(doInstance);

    expect(deletedIds(binds, "objects")).toContain(REMOVED_ROW);
    expect(ydoc.getArray<unknown>("objects").length).toBe(0);
  });
});

describe("an objects array holding an entry that carries identity", () => {
  it.each([
    ['{"_id": 55}'],
    ['{"object_id": "bell"}'],
    ['{"_temp_id": "t-1"}'],
  ])("keeps %s and the row it may claim", async (json) => {
    const { doInstance, binds } = makeDO(removedRowStillInD1);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      ydoc.getArray<unknown>("objects").push([JSON.parse(json) as unknown]);
    }, null);

    await snapshot(doInstance);

    expect(deletedIds(binds, "objects")).not.toContain(REMOVED_ROW);
    expect(ydoc.getArray<unknown>("objects").length).toBe(1);
  });
});

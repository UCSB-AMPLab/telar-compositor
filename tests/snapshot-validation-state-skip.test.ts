/**
 * R4: `_validation_state` must not let a client park a row outside
 * reconciliation.
 *
 * The objects pipeline skips a row whose `_validation_state` is `"pending"`, so
 * an IIIF manifest that has not been validated yet is never INSERTed. That is
 * the whole legitimate purpose, and it only ever applies to a row the client
 * has just created: `createObjectYMap` sets `_validation_state: "pending"`
 * together with `_id: null`, and the validator flips it to `"valid"`/`"error"`
 * once — nothing in the client ever writes `"pending"` back onto a row that
 * already has a D1 id.
 *
 * `_validation_state` is client-writable, though, and the skip withholds a row
 * from BOTH its UPDATE and the orphan sweep. On a row that already has an
 * `_id`, that is a parking space: set the field and the row stops tracking the
 * document — its edits stop reaching D1 and its deletion stops reaching D1.
 *
 * The narrowing under test: the skip requires `_id` to be absent as well.
 * A persisted row stays in reconciliation whatever a client writes into
 * `_validation_state`. The skip is NOT widened to `"error"` — those rows
 * already persist today, and this file pins that they continue to.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

/**
 * A D1 stub that answers the objects SELECT from `d1ObjectIds` and records
 * every write, so a test can ask whether a given row got an UPDATE, an INSERT,
 * or a DELETE.
 */
function makeDb(d1ObjectIds: Array<{ id: number; object_id: string }>) {
  const runs: RecordedStatement[] = [];
  const batched: RecordedStatement[] = [];
  let lastRowId = 900;

  function prepare(sql: string) {
    const stmt = {
      sql,
      binds: [] as unknown[],
      bind(...args: unknown[]) {
        checkD1Bind(sql, args);
        stmt.binds = args;
        return stmt;
      },
      async run() {
        runs.push({ sql, binds: stmt.binds });
        return { meta: { last_row_id: (lastRowId += 1), changes: 1 }, success: true as const };
      },
      async all<T = unknown>() {
        if (/FROM objects WHERE project_id/.test(sql)) {
          return { results: d1ObjectIds as unknown as T[], success: true as const };
        }
        return { results: [] as T[], success: true as const };
      },
      async first<T = unknown>() {
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) {
          return { id: 1 } as T;
        }
        return null as T | null;
      },
    };
    return stmt;
  }

  return {
    runs,
    batched,
    DB: {
      prepare,
      async batch(statements: Array<{ sql: string; binds: unknown[] }>) {
        for (const s of statements) batched.push({ sql: s.sql, binds: s.binds });
        return statements.map(() => ({ success: true }));
      },
    },
  };
}

function makeDo(d1ObjectIds: Array<{ id: number; object_id: string }>) {
  const db = makeDb(d1ObjectIds);
  const ctx = {
    getWebSockets: () => [],
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
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
  const env = { DB: db.DB as unknown, SESSION_SECRET: "test", COLLABORATION: {} as unknown };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  markLoaded(doInstance);
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  ydoc.transact(() => {
    const config = ydoc.getMap<unknown>("config");
    config.set("title", new Y.Text("Demo"));
    config.set("lang", "en");
  }, null);
  return { doInstance, db, ydoc };
}

function pushObject(ydoc: Y.Doc, fields: Record<string, unknown>) {
  ydoc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set("_id", fields._id ?? null);
    m.set("object_id", fields.object_id ?? "obj-x");
    m.set("title", new Y.Text((fields.title as string) ?? ""));
    if (fields._validation_state !== undefined) {
      m.set("_validation_state", fields._validation_state);
    }
    ydoc.getArray<Y.Map<unknown>>("objects").push([m]);
  }, null);
}

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

function objectUpdates(db: ReturnType<typeof makeDb>): RecordedStatement[] {
  return db.batched.filter((s) => /UPDATE objects SET/.test(s.sql));
}

function objectDeletes(db: ReturnType<typeof makeDb>): RecordedStatement[] {
  return db.batched.filter((s) => /DELETE FROM objects/.test(s.sql));
}

function objectInserts(db: ReturnType<typeof makeDb>): RecordedStatement[] {
  return db.runs.filter((s) => /INSERT INTO objects/.test(s.sql));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("objects snapshot skip — the unvalidated-IIIF case it exists for", () => {
  it("skips a freshly created pending row (no _id) so an unvalidated manifest never persists", async () => {
    const { doInstance, db, ydoc } = makeDo([]);
    pushObject(ydoc, { _id: null, object_id: "obj-iiif", _validation_state: "pending" });

    await snapshot(doInstance);

    expect(objectInserts(db)).toHaveLength(0);
    expect(objectUpdates(db)).toHaveLength(0);
  });

  it("persists a freshly created row once validation flips it to valid", async () => {
    const { doInstance, db, ydoc } = makeDo([]);
    pushObject(ydoc, { _id: null, object_id: "obj-iiif", _validation_state: "valid" });

    await snapshot(doInstance);

    expect(objectInserts(db)).toHaveLength(1);
  });

  it("persists a freshly created row in the error state (the skip is not widened)", async () => {
    const { doInstance, db, ydoc } = makeDo([]);
    pushObject(ydoc, { _id: null, object_id: "obj-iiif", _validation_state: "error" });

    await snapshot(doInstance);

    expect(objectInserts(db)).toHaveLength(1);
  });
});

describe("objects snapshot skip — a client cannot park a persisted row", () => {
  it("UPDATEs a persisted row whose _validation_state a client set back to pending", async () => {
    const { doInstance, db, ydoc } = makeDo([{ id: 77, object_id: "obj-77" }]);
    pushObject(ydoc, {
      _id: 77,
      object_id: "obj-77",
      title: "Edited after parking",
      _validation_state: "pending",
    });

    await snapshot(doInstance);

    const upd = objectUpdates(db);
    expect(upd).toHaveLength(1);
    expect(upd[0].binds[upd[0].binds.length - 1]).toBe(77);
    expect(upd[0].binds).toContain("Edited after parking");
  });

  it("orphan-DELETEs a D1 row a client parked and then removed from the document", async () => {
    // The row exists in D1 and is gone from the Y.Doc. The parked sibling must
    // not shield it: the sweep runs over the same orphan set either way.
    const { doInstance, db, ydoc } = makeDo([
      { id: 77, object_id: "obj-77" },
      { id: 78, object_id: "obj-78" },
    ]);
    pushObject(ydoc, { _id: 77, object_id: "obj-77", _validation_state: "pending" });

    await snapshot(doInstance);

    expect(objectDeletes(db).map((s) => s.binds[0])).toEqual([78]);
  });

  it("orphan-DELETEs the parked row itself once it leaves the document", async () => {
    const { doInstance, db } = makeDo([{ id: 77, object_id: "obj-77" }]);
    // Nothing pushed: D1 row 77 has no counterpart in the document at all.

    await snapshot(doInstance);

    expect(objectDeletes(db).map((s) => s.binds[0])).toEqual([77]);
  });
});

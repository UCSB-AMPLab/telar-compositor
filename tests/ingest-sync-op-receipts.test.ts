/**
 * `/ingest-sync` operation receipts and removal identity.
 *
 * An operation that reached the document and lost its answer is sent again by
 * whatever completes it. The receipt, kept in the collaboration object's own
 * storage under the operation's id, names each object the operation has
 * already settled, so a second delivery applies none of them again, even when
 * an object it registered has since been deleted from the document:
 * skip-if-present alone would bring that object back. An object is receipted
 * only once the ingest's flush has put it in D1, so an insert D1 refused, or
 * one the ingest refused, is applied again rather than answered as done. A
 * receipt is kept exactly as long as its operation's `pending_object_ops` row
 * exists, however old it is and however many others there are.
 *
 * A removal names the object's D1 id as well as its key, so an object deleted
 * and re-created under the same key is left alone; and the answer tells a
 * removal applied from an object already gone, one that is someone else now,
 * and a course item the ingest refuses.
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
import { signInternalMarker } from "../workers/auth";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { PROJECT_ID, SECRET, buildDoc, seedProject } from "./helpers/collaboration-fixture";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import {
  completePendingObjectOps,
  markPendingObjectOpCommitted,
  preparePendingObjectOp,
} from "~/lib/pending-object-ops.server";

const RECEIPT_PREFIX = "ingestReceipt:";
const DAY_MS = 24 * 60 * 60 * 1000;

let memory: MemoryD1;
let storage: Map<string, unknown>;
let doInstance: ProjectCollaborationDO;

function makeCtx() {
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : storage.get(key)),
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        const entries = typeof key === "string" ? { [key]: value } : key;
        for (const [k, v] of Object.entries(entries)) storage.set(k, structuredClone(v));
      },
      list: async (options?: { prefix?: string }) =>
        new Map([...storage].filter(([key]) => key.startsWith(options?.prefix ?? ""))),
      delete: async (keys: string | string[]) => {
        let n = 0;
        for (const key of Array.isArray(keys) ? keys : [keys]) if (storage.delete(key)) n += 1;
        return n;
      },
    },
    acceptWebSocket: vi.fn(),
  };
}

async function load(): Promise<void> {
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(buildDoc(true), PROJECT_ID);
  doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
}

function ydoc(): Y.Doc {
  return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
}

function docObjects(): Array<{ objectId: string; id: unknown }> {
  return ydoc()
    .getArray<Y.Map<unknown>>("objects")
    .toArray()
    .map((m) => ({ objectId: String(m.get("object_id")), id: m.get("_id") }));
}

function d1ObjectIds(): string[] {
  return (memory.raw.prepare("SELECT object_id FROM objects ORDER BY object_id").all() as Array<{
    object_id: string;
  }>).map((r) => r.object_id);
}

async function ingest(body: unknown): Promise<Response> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, SECRET, "ingest-sync");
  return doInstance.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

function insertOf(objectId: string) {
  return { object_id: objectId, title: `Title ${objectId}`, created_by: 1, image_available: false };
}

function receiptKeys(): string[] {
  return [...storage.keys()].filter((key) => key.startsWith(RECEIPT_PREFIX));
}

/** A pending operation's row, which is what keeps its receipt. */
function pendingRow(id: number): void {
  memory.raw
    .prepare(
      "INSERT INTO pending_object_ops (id, project_id, kind, state, payload, created_at) VALUES (?, ?, 'register', 'committed', '[]', 'x')",
    )
    .run(id, PROJECT_ID);
}

/** D1 refuses every INSERT of this object, as a constraint or a lost write would. */
function refuseInsertsOf(objectId: string): void {
  memory.raw.exec(
    `CREATE TRIGGER refuse_${objectId} BEFORE INSERT ON objects WHEN NEW.object_id = '${objectId}' ` +
      "BEGIN SELECT RAISE(ABORT, 'refused'); END",
  );
}

function allowInsertsOf(objectId: string): void {
  memory.raw.exec(`DROP TRIGGER refuse_${objectId}`);
}

function deleteFromDoc(objectId: string): void {
  const array = ydoc().getArray<Y.Map<unknown>>("objects");
  const at = array.toArray().findIndex((m) => m.get("object_id") === objectId);
  ydoc().transact(() => array.delete(at, 1), null);
}

beforeEach(async () => {
  memory = createMemoryD1();
  seedProject(memory, "text");
  storage = new Map();
  await load();
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

describe("an operation settles each object once", () => {
  it("answers a repeat as already applied and applies nothing, even after the object was deleted", async () => {
    pendingRow(7);
    const first = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ applied: { objectInsert: 1 } });
    expect(d1ObjectIds()).toContain("bell");

    deleteFromDoc("bell");
    const second = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ alreadyApplied: true });
    expect(docObjects().map((o) => o.objectId)).not.toContain("bell");
  });

  it("applies a different operation id, and still refuses the first one again", async () => {
    pendingRow(7);
    pendingRow(8);
    await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    deleteFromDoc("bell");
    const other = await ingest({ opId: 8, objects: { insert: [insertOf("bell")] } });
    expect(await other.json()).not.toHaveProperty("alreadyApplied");
    expect(docObjects().map((o) => o.objectId)).toContain("bell");

    deleteFromDoc("bell");
    const again = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(await again.json()).toMatchObject({ alreadyApplied: true });
    expect(docObjects().map((o) => o.objectId)).not.toContain("bell");
  });

  it("keeps no receipt for an ingest without an operation id, and does for one with", async () => {
    await ingest({ objects: { insert: [insertOf("bell")] } });
    expect(receiptKeys()).toEqual([]);
    deleteFromDoc("bell");
    const again = await ingest({ objects: { insert: [insertOf("bell")] } });
    expect(await again.json()).toMatchObject({ applied: { objectInsert: 1 } });
    expect(docObjects().map((o) => o.objectId)).toContain("bell");

    pendingRow(7);
    await ingest({ opId: 7, objects: { insert: [insertOf("drum")] } });
    deleteFromDoc("drum");
    const receipted = await ingest({ opId: 7, objects: { insert: [insertOf("drum")] } });
    expect(await receipted.json()).toMatchObject({ alreadyApplied: true });
  });

  // What this checks is narrower than the cases around it: a delivery whose flush
  // never ran settles nothing, and a later one settles only the object D1
  // took. It does not tell this rule from the earlier one; the two tests
  // below do.
  it("settles nothing from a flush that never ran, and only what D1 took from one that did", async () => {
    pendingRow(7);
    const internals = doInstance as unknown as { flushSnapshotNow: () => Promise<boolean> };
    const real = internals.flushSnapshotNow.bind(doInstance);
    internals.flushSnapshotNow = async () => false;
    const blocked = await ingest({ opId: 7, objects: { insert: [insertOf("bell"), insertOf("drum")] } });
    expect(blocked.status).toBe(503);
    expect(receiptKeys()).toEqual([]);

    internals.flushSnapshotNow = real;
    refuseInsertsOf("drum");
    const retried = await ingest({ opId: 7, objects: { insert: [insertOf("bell"), insertOf("drum")] } });
    // drum is intended and unsettled, so the request fails.
    expect(retried.status).toBe(503);
    expect(d1ObjectIds()).toContain("bell");
    expect(d1ObjectIds()).not.toContain("drum");

    deleteFromDoc("bell");
    allowInsertsOf("drum");
    const replay = await ingest({ opId: 7, objects: { insert: [insertOf("bell"), insertOf("drum")] } });
    expect(replay.status).toBe(200);
    expect(await replay.json()).not.toHaveProperty("alreadyApplied");
    expect(docObjects().map((o) => o.objectId)).not.toContain("bell");
    expect(d1ObjectIds()).toContain("drum");
  });

  // Round 2, finding 1: the object's row persisted, and the project-blob write
  // after it failed. The request fails, but the object is in D1, so it is
  // settled.
  it("receipts an object D1 took even when the flush then fails", async () => {
    pendingRow(7);
    memory.raw.exec(
      "CREATE TRIGGER refuse_blob BEFORE UPDATE OF yjs_state ON projects " +
        "BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const failed = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(failed.status).toBe(503);
    expect(d1ObjectIds()).toContain("bell");
    memory.raw.exec("DROP TRIGGER refuse_blob");

    deleteFromDoc("bell");
    const retried = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(await retried.json()).toMatchObject({ alreadyApplied: true });
    expect(docObjects().map((o) => o.objectId)).not.toContain("bell");
  });

  // Round 2, finding 2: a Y.Map restored after its row was deleted still
  // carries the old id. The ingest takes it as present; D1 does not hold it,
  // so it is not settled, and the retry reaches the document again.
  it("does not receipt an object whose map carries an id D1 no longer holds", async () => {
    pendingRow(7);
    const restored = new Y.Map<unknown>();
    ydoc().transact(() => {
      restored.set("_id", 99);
      restored.set("object_id", "bell");
      restored.set("title", new Y.Text("Bell"));
      restored.set("_validation_state", "valid");
      ydoc().getArray<Y.Map<unknown>>("objects").push([restored]);
    }, null);
    refuseInsertsOf("bell");
    const first = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    // Intended, not settled, not refused by the ingest: the request fails.
    expect(first.status).toBe(503);
    expect(receiptKeys()).toEqual([]);
    expect(d1ObjectIds()).not.toContain("bell");

    allowInsertsOf("bell");
    const retried = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(await retried.json()).not.toHaveProperty("alreadyApplied");
    expect(docObjects().map((o) => o.objectId)).toContain("bell");
  });

  // Round 3, finding 1, end to end: a committed record whose object D1 keeps
  // refusing is never answered as done, so completion fails and keeps it.
  it("keeps the pending record when D1 refuses the reinsert of a stale-id map", async () => {
    const orm = drizzle(asD1(memory), { schema });
    const opId = await preparePendingObjectOp(orm, {
      projectId: PROJECT_ID, kind: "register",
      objects: [{ object_id: "bell", title: "Bell", featured: false, creator: null, description: null,
        source_url: null, period: null, year: null, object_type: null, subjects: null, source: null,
        credit: null, thumbnail: null, image_available: false }],
      parentSha: "h", actorId: 1,
    });
    await markPendingObjectOpCommitted(orm, opId, "c");
    const restored = new Y.Map<unknown>();
    ydoc().transact(() => {
      restored.set("_id", 99);
      restored.set("object_id", "bell");
      restored.set("title", new Y.Text("Bell"));
      restored.set("_validation_state", "valid");
      ydoc().getArray<Y.Map<unknown>>("objects").push([restored]);
    }, null);
    refuseInsertsOf("bell");

    const env = {
      SESSION_SECRET: SECRET,
      COLLABORATION: { idFromName: (n: string) => n, get: () => doInstance },
    } as unknown as Env;
    const result = await completePendingObjectOps(env, orm, PROJECT_ID, { kind: "absent" });
    expect(result).toMatchObject({ ok: false, failedOp: opId });
    expect(memory.raw.prepare("SELECT id FROM pending_object_ops").all()).toEqual([{ id: opId }]);
    expect(d1ObjectIds()).not.toContain("bell");
  });

  // Round 3, finding 2: the INSERT committed and the `_id` backfill threw, so
  // the map holds no id. The id the INSERT returned is the identity.
  it("receipts an object whose INSERT committed though its _id backfill threw", async () => {
    pendingRow(7);
    const internals = doInstance as unknown as { buildObjectYMap: (...args: unknown[]) => Y.Map<unknown> };
    const build = internals.buildObjectYMap.bind(doInstance);
    internals.buildObjectYMap = (...args: unknown[]) => {
      const objMap = build(...args);
      const set = objMap.set.bind(objMap);
      (objMap as unknown as { set: (k: string, v: unknown) => unknown }).set = (k, v) => {
        if (k === "_id" && typeof v === "number") throw new Error("backfill exploded");
        return set(k, v);
      };
      return objMap;
    };
    const first = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(first.status).toBe(200);
    const receipt = storage.get(`${RECEIPT_PREFIX}7`) as { inserted: string[] } | undefined;
    expect(receipt?.inserted).toEqual(["bell"]);

    internals.buildObjectYMap = build;
    const retried = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(await retried.json()).toMatchObject({ alreadyApplied: true });
    expect(d1ObjectIds().filter((id) => id === "bell")).toHaveLength(1);
  });

  // A row under the same key with another id — left by an earlier failed
  // flush — is not this delivery's object, and earns it nothing.
  it("does not receipt an insert D1 refused on the strength of a same-key orphan row", async () => {
    pendingRow(7);
    memory.raw
      .prepare("INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (50, ?, 'bell', 'a00009', 'Old')")
      .run(PROJECT_ID);
    memory.raw.exec(
      "CREATE TRIGGER keep_orphan BEFORE DELETE ON objects WHEN OLD.id = 50 BEGIN SELECT RAISE(IGNORE); END",
    );
    refuseInsertsOf("bell");
    const res = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(memory.raw.prepare("SELECT id FROM objects WHERE object_id = 'bell'").all()).toEqual([{ id: 50 }]);
    expect(res.status).toBe(503);
    const receipt = storage.get(`${RECEIPT_PREFIX}7`) as { inserted: string[] } | undefined;
    expect(receipt?.inserted ?? []).not.toContain("bell");
  });

  it("receipts nothing and fails when D1 cannot be read after the flush", async () => {
    pendingRow(7);
    const internals = doInstance as unknown as { readPersistedObjects: () => Promise<unknown> };
    internals.readPersistedObjects = async () => {
      throw new Error("D1 unavailable");
    };
    const res = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(res.status).toBe(503);
    expect(receiptKeys()).toEqual([]);
  });

  // B1: an operation whose inserts partly persisted. The object D1 took is
  // settled; the one it refused is not, and only that one is tried again.
  it("receipts the objects D1 took and not the one it refused, so a retry registers only the refused one", async () => {
    pendingRow(7);
    refuseInsertsOf("drum");
    const first = await ingest({ opId: 7, objects: { insert: [insertOf("bell"), insertOf("drum")] } });
    expect(first.status).toBe(503);
    expect(d1ObjectIds()).toContain("bell");
    expect(d1ObjectIds()).not.toContain("drum");

    deleteFromDoc("bell");
    allowInsertsOf("drum");
    const retried = await ingest({ opId: 7, objects: { insert: [insertOf("bell"), insertOf("drum")] } });
    const body = await retried.json();
    expect(body).not.toHaveProperty("alreadyApplied");
    expect(body).toMatchObject({ receipted: { objectInsert: ["bell"] } });
    expect(docObjects().map((o) => o.objectId)).not.toContain("bell");
    expect(docObjects().map((o) => o.objectId)).toContain("drum");
    expect(d1ObjectIds()).toContain("drum");

    const settled = await ingest({ opId: 7, objects: { insert: [insertOf("bell"), insertOf("drum")] } });
    expect(await settled.json()).toMatchObject({ alreadyApplied: true });
  });

  // B3: an insert the ingest refuses for a field out of domain never reached
  // the document or D1, so it is not settled.
  it("does not receipt an insert the ingest refused", async () => {
    pendingRow(7);
    const refused = await ingest({ opId: 7, objects: { insert: [{ ...insertOf("bell"), title: 5 }] } });
    expect(await refused.json()).toMatchObject({ refused: { objectInsert: [0] } });
    expect(d1ObjectIds()).not.toContain("bell");

    // The same refused delivery again is refused again, never answered as done.
    const repeat = await ingest({ opId: 7, objects: { insert: [{ ...insertOf("bell"), title: 5 }] } });
    const repeated = await repeat.json();
    expect(repeated).not.toHaveProperty("alreadyApplied");
    expect(repeated).toMatchObject({ refused: { objectInsert: [0] } });

    const again = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(await again.json()).not.toHaveProperty("alreadyApplied");
    expect(d1ObjectIds()).toContain("bell");
  });

  // B2: nothing but the operation's row going away forgets its receipt.
  it("keeps a receipt while its operation's row exists, however old and however many others", async () => {
    pendingRow(7);
    await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    deleteFromDoc("bell");
    for (let op = 1000; op < 1700; op += 1) storage.set(`${RECEIPT_PREFIX}${op}`, { inserted: ["x"], removed: [] });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 400 * DAY_MS);
      pendingRow(8);
      await ingest({ opId: 8, objects: { insert: [insertOf("drum")] } });
      const replay = await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
      expect(await replay.json()).toMatchObject({ alreadyApplied: true });
      expect(docObjects().map((o) => o.objectId)).not.toContain("bell");
    } finally {
      vi.useRealTimers();
    }
    // The receipts whose rows are gone were pruned; the two whose rows stand were not.
    expect(receiptKeys().sort()).toEqual([`${RECEIPT_PREFIX}7`, `${RECEIPT_PREFIX}8`]);
  });

  it("prunes nothing below the threshold, and prunes above it", async () => {
    pendingRow(7);
    for (let op = 1000; op < 1100; op += 1) storage.set(`${RECEIPT_PREFIX}${op}`, { inserted: ["x"], removed: [] });
    await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(receiptKeys()).toHaveLength(101);

    for (let op = 1100; op < 1300; op += 1) storage.set(`${RECEIPT_PREFIX}${op}`, { inserted: ["x"], removed: [] });
    await ingest({ opId: 7, objects: { insert: [insertOf("drum")] } });
    expect(receiptKeys()).toEqual([`${RECEIPT_PREFIX}7`]);
  });

  it("prunes nothing when the rows cannot be read", async () => {
    pendingRow(7);
    for (let op = 1000; op < 1300; op += 1) storage.set(`${RECEIPT_PREFIX}${op}`, { inserted: ["x"], removed: [] });
    const ddl = (memory.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_object_ops'")
      .get() as { sql: string }).sql;
    memory.raw.exec("DROP TABLE pending_object_ops");
    await ingest({ opId: 7, objects: { insert: [insertOf("bell")] } });
    expect(receiptKeys()).toHaveLength(301);

    // The same receipts, once the rows can be read, are pruned.
    memory.raw.exec(ddl);
    pendingRow(7);
    await ingest({ opId: 7, objects: { insert: [insertOf("drum")] } });
    expect(receiptKeys()).toEqual([`${RECEIPT_PREFIX}7`]);
  });

  // A removal is settled by its D1 id being gone. A course item the ingest
  // refuses to remove is still there, so it is not.
  it("does not receipt a removal whose object D1 still holds", async () => {
    pendingRow(9);
    const object = ydoc().getArray<Y.Map<unknown>>("objects").get(0);
    ydoc().transact(() => object.set("course_project_id", 3), null);
    const first = await ingest({ opId: 9, objects: { remove: [{ objectId: "o1", docId: 1 }] } });
    expect(await first.json()).toMatchObject({ removals: { course: ["o1"] } });
    expect(d1ObjectIds()).toContain("o1");
    const receipt = storage.get(`${RECEIPT_PREFIX}9`) as { removed: string[] } | undefined;
    expect(receipt?.removed ?? []).not.toContain("o1");
  });

  it("settles each removal on its own", async () => {
    pendingRow(9);
    const first = await ingest({ opId: 9, objects: { remove: [{ objectId: "o1", docId: 1 }] } });
    expect(await first.json()).toMatchObject({ removals: { applied: ["o1"] } });

    // The same map comes back (an undo, say); a replay of the operation does
    // not remove it a second time.
    const back = new Y.Map<unknown>();
    ydoc().transact(() => {
      back.set("_id", 1);
      back.set("object_id", "o1");
      ydoc().getArray<Y.Map<unknown>>("objects").push([back]);
    }, null);
    const replay = await ingest({ opId: 9, objects: { remove: [{ objectId: "o1", docId: 1 }] } });
    expect(await replay.json()).toMatchObject({ alreadyApplied: true });
    expect(docObjects().map((o) => o.objectId)).toEqual(["o1"]);

    // A later delivery naming a further object removes that one only.
    const later = await ingest({
      opId: 9,
      objects: { remove: [{ objectId: "o1", docId: 1 }, { objectId: "gone", docId: 4 }] },
    });
    expect(await later.json()).toMatchObject({
      receipted: { objectRemove: ["o1"] },
      removals: { applied: [], absent: ["gone"] },
    });
    expect(docObjects().map((o) => o.objectId)).toEqual(["o1"]);
  });

  it.each([["a string", "7"], ["zero", 0], ["a fraction", 1.5], ["negative", -3]])(
    "refuses an operation id that is %s",
    async (_name, opId) => {
      const res = await ingest({ opId, objects: { insert: [insertOf("bell")] } });
      expect(res.status).toBe(400);
      expect(docObjects().map((o) => o.objectId)).not.toContain("bell");
    },
  );

  it.each([
    ["config", { config: [] }],
    ["objects.update", { objects: { update: [] } }],
    ["stories", { stories: { update: [], insert: [] } }],
    ["glossary", { glossary: { update: [], insert: [] } }],
    ["pages", { pages: { insert: [] } }],
    ["telarVersion", { telarVersion: "1.0.0" }],
  ])("refuses an operation id beside the %s arm, which it cannot settle", async (_name, extra) => {
    const res = await ingest({ opId: 7, ...extra, objects: { insert: [insertOf("bell")], ...(extra as { objects?: object }).objects } });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Removal identity
// ---------------------------------------------------------------------------

describe("a removal names the object it means", () => {
  it("removes the object when its key and D1 id both match", async () => {
    const res = await ingest({ objects: { remove: [{ objectId: "o1", docId: 1 }] } });
    expect(await res.json()).toMatchObject({
      applied: { objectRemove: 1 },
      removals: { applied: ["o1"], absent: [], superseded: [], course: [] },
    });
    expect(docObjects()).toEqual([]);
  });

  it("leaves an object that carries another D1 id, and says so", async () => {
    const res = await ingest({ objects: { remove: [{ objectId: "o1", docId: 99 }] } });
    expect(await res.json()).toMatchObject({
      applied: { objectRemove: 0 },
      removals: { applied: [], superseded: ["o1"] },
    });
    expect(docObjects().map((o) => o.objectId)).toEqual(["o1"]);
  });

  it("answers an object already gone as absent", async () => {
    const res = await ingest({ objects: { remove: [{ objectId: "gone", docId: 5 }] } });
    expect(await res.json()).toMatchObject({ removals: { absent: ["gone"] } });
  });

  it("refuses a course item and names it apart", async () => {
    const object = ydoc().getArray<Y.Map<unknown>>("objects").get(0);
    ydoc().transact(() => object.set("course_project_id", 3), null);
    const res = await ingest({ objects: { remove: [{ objectId: "o1", docId: 1 }] } });
    expect(await res.json()).toMatchObject({
      applied: { objectRemove: 0 },
      removals: { applied: [], course: ["o1"] },
    });
    expect(docObjects().map((o) => o.objectId)).toEqual(["o1"]);
  });

  it("still takes a bare object id", async () => {
    const res = await ingest({ objects: { remove: ["o1"] } });
    expect(await res.json()).toMatchObject({
      applied: { objectRemove: 1 },
      removals: { applied: ["o1"] },
    });
    expect(docObjects()).toEqual([]);
  });

  it("refuses by position an entry whose D1 id is not a positive integer", async () => {
    const res = await ingest({
      objects: { remove: [{ objectId: "o1", docId: "1" }, { objectId: "o1" }, ["o1"]] },
    });
    expect(await res.json()).toMatchObject({
      applied: { objectRemove: 0 },
      refused: { objectRemove: [0, 1, 2] },
    });
    expect(docObjects().map((o) => o.objectId)).toEqual(["o1"]);
  });
});

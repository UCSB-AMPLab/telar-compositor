/**
 * A snapshot that could not land an entity must not answer as one that did.
 *
 * `insertRow` swallows a refused INSERT and returns id 0 — deliberately, since
 * a snapshot cannot abort mid-flush — and nothing above it carried the refusal
 * out. `snapshotFlatEntity` returned only its backfill flag, `doSnapshot`
 * carried on through the blob and the batch, and `/snapshot` answered 200. The
 * publish action reads that 200 as "D1 is authoritative" and ships an
 * `objects.csv` built from D1 alone, so the object the INSERT lost is simply
 * absent from the published site under a success banner.
 *
 * Reporting is not aborting: every other entity is still written, and the
 * failure surfaces after the flush completes.
 *
 * Two hazards sit in the same lifecycle, and both matter because `objects`
 * carries no UNIQUE (project_id, object_id) — a bad retry writes a second row
 * rather than being refused:
 *
 *   - The INSERT and the `_id` backfill shared one catch, so a committed row
 *     whose backfill threw was reported as a row that was never written. The
 *     remedy for the first (issue it again) writes a duplicate when applied to
 *     the second.
 *   - A re-registration of an entity the document already holds was classified
 *     `skipped` — "already there" — even when its `_id` was still null, so a
 *     second failed INSERT had no receipt to be reported through.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
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
import { markLoaded } from "./helpers/claimed-document";
import { plantHalt } from "./helpers/halted-document";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const TEST_SECRET = "test-session-secret";

/**
 * A D1 fake for the `objects` table. `refuse` names the object_ids whose
 * INSERT throws — production reaches the same catch on any D1 error, and
 * objects have no UNIQUE human key of their own to lose to.
 */
function makeDb(refuse: Set<string> = new Set()) {
  const objectRows = new Map<number, string>();
  let nextId = 7000;

  function resolve(sql: string): unknown[] {
    if (/FROM objects WHERE project_id/.test(sql)) {
      return [...objectRows].map(([id, object_id]) => ({ id, object_id }));
    }
    return [];
  }

  function apply(sql: string, binds: unknown[]): number | null {
    const insertObject = /^INSERT INTO objects \(([^)]*)\)/.exec(sql);
    if (insertObject) {
      const cols = insertObject[1].split(",").map((c) => c.trim().replace(/"/g, ""));
      const objectId = String(binds[cols.indexOf("object_id")] ?? "");
      if (refuse.has(objectId)) {
        throw new Error("D1_ERROR: objects INSERT refused");
      }
      const idCol = cols.indexOf("id");
      const id = idCol >= 0 ? Number(binds[idCol]) : (nextId += 1);
      objectRows.set(id, objectId);
      return id;
    }
    if (/^DELETE FROM objects/.test(sql)) {
      objectRows.delete(Number(binds[0]));
      return null;
    }
    return null;
  }

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() {
        return bound;
      },
      bind(...args: unknown[]) {
        checkD1Bind(sql, args);
        bound = args;
        return stmt;
      },
      async run() {
        const id = apply(sql, bound);
        return { meta: { last_row_id: id ?? (nextId += 1), changes: 1 }, success: true as const };
      },
      async all<T = unknown>() {
        return { results: resolve(sql) as T[], success: true as const };
      },
      async first<T = unknown>() {
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) {
          return { id: 1 } as T;
        }
        // The base row: no blob and no tags, which is the cold build.
        if (/^SELECT yjs_state/.test(sql)) {
          return { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 } as T;
        }
        return ((resolve(sql) as T[])[0] ?? null) as T | null;
      },
    };
    return stmt;
  }

  return {
    DB: {
      prepare,
      async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
        for (const s of statements) apply(s.sql, s.boundArgs);
        return statements.map(() => ({ success: true }));
      },
    },
    liveObjectIds: () => [...objectRows.values()].sort(),
  };
}

function makeCtx() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const running = chain.then(() => fn());
      chain = running.catch(() => {});
      return running;
    },
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
}

type Internals = {
  projectId: number | null;
  docLoaded: boolean;
  isSnapshotting: boolean;
  persistenceHalted: unknown;
  ydoc: Y.Doc;
};

function makeDo(refuse: Set<string> = new Set()) {
  const db = makeDb(refuse);
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: db.DB, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} } as unknown as Env,
  );
  const internals = doInstance as unknown as Internals;
  internals.projectId = PROJECT_ID;
  markLoaded(internals);
  return { doInstance, db, internals };
}

/** An object the document holds and D1 has never seen. */
function seedObject(ydoc: Y.Doc, objectId: string): Y.Map<unknown> {
  const objects = ydoc.getArray<Y.Map<unknown>>("objects");
  let objMap!: Y.Map<unknown>;
  ydoc.transact(() => {
    objMap = new Y.Map<unknown>();
    objMap.set("_id", null);
    objMap.set("object_id", objectId);
    objMap.set("title", new Y.Text(objectId));
    objects.push([objMap]);
  }, null);
  return objMap;
}

async function postSnapshot(doInstance: ProjectCollaborationDO): Promise<Response> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, TEST_SECRET, "snapshot");
  return doInstance.fetch(
    new Request("https://internal/snapshot", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
      },
    }),
  );
}

async function postIngest(doInstance: ProjectCollaborationDO, body: unknown): Promise<Response> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, TEST_SECRET, "ingest-sync");
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

// ---------------------------------------------------------------------------
// The channel itself
// ---------------------------------------------------------------------------

describe("POST /snapshot reports an entity that did not land", () => {
  it("does not answer 200 when an object INSERT was refused", async () => {
    const { doInstance, internals } = makeDo(new Set(["lost-object"]));
    seedObject(internals.ydoc, "lost-object");

    const res = await postSnapshot(doInstance);

    expect(res.status).not.toBe(200);
    expect(await res.text()).toBe("snapshot_incomplete");
  });

  it("still writes every other entity — reporting is not aborting", async () => {
    const { doInstance, db, internals } = makeDo(new Set(["lost-object"]));
    seedObject(internals.ydoc, "kept-object-a");
    seedObject(internals.ydoc, "lost-object");
    seedObject(internals.ydoc, "kept-object-b");

    const res = await postSnapshot(doInstance);

    expect(res.status).toBe(500);
    expect(db.liveObjectIds()).toEqual(["kept-object-a", "kept-object-b"]);
  });

  it("answers 200 for an ordinary snapshot in which every INSERT landed", async () => {
    const { doInstance, db, internals } = makeDo();
    seedObject(internals.ydoc, "kept-object");

    const res = await postSnapshot(doInstance);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(db.liveObjectIds()).toEqual(["kept-object"]);
  });

  it("does not carry a previous pass's failure into a later clean snapshot", async () => {
    const refuse = new Set(["lost-object"]);
    const { doInstance, internals } = makeDo(refuse);
    seedObject(internals.ydoc, "lost-object");

    expect((await postSnapshot(doInstance)).status).toBe(500);
    refuse.delete("lost-object");

    const res = await postSnapshot(doInstance);
    expect(res.status).toBe(200);
  });

  it("names the halt when the flush did not run at all", async () => {
    const { doInstance, internals } = makeDo(new Set(["lost-object"]));
    seedObject(internals.ydoc, "lost-object");
    plantHalt(internals);

    const res = await postSnapshot(doInstance);

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("persistence_halted");
  });
});

// ---------------------------------------------------------------------------
// Hazard 1 — a failed backfill is not a failed insert
// ---------------------------------------------------------------------------

/**
 * The backfill's only work is `objMap.set("_id", id)` inside a transaction, so
 * a `set` that throws on that key is a backfill that threw over a row D1 has
 * already committed — the id never reaches the document.
 */
function poisonIdBackfill(objMap: Y.Map<unknown>): void {
  const set = objMap.set.bind(objMap);
  (objMap as unknown as { set: (key: string, value: unknown) => unknown }).set = (key, value) => {
    if (key === "_id" && typeof value === "number") throw new Error("backfill exploded");
    return set(key, value);
  };
}

describe("a committed row whose _id backfill threw is reported differently", () => {
  it("does not report it to the ingest caller as an insert to issue again", async () => {
    const { doInstance, db } = makeDo();
    // The route builds the Y.Map, so the poison is installed on the way past.
    const internalsWithBuilder = doInstance as unknown as {
      buildObjectYMap: (...args: unknown[]) => Y.Map<unknown>;
    };
    const build = internalsWithBuilder.buildObjectYMap.bind(doInstance);
    internalsWithBuilder.buildObjectYMap = (...args: unknown[]) => {
      const objMap = build(...args);
      poisonIdBackfill(objMap);
      return objMap;
    };

    const res = await postIngest(doInstance, {
      objects: { insert: [{ object_id: "committed-object", title: "Committed" }] },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: { objectInsert: number };
      failed?: { objectInsert?: string[] };
    };
    expect(db.liveObjectIds()).toEqual(["committed-object"]);
    expect(body.failed?.objectInsert ?? []).toEqual([]);
    expect(body.applied.objectInsert).toBe(1);
  });

  it("lets /snapshot answer 200, where a refused INSERT answers 500", async () => {
    const { doInstance, db, internals } = makeDo();
    poisonIdBackfill(seedObject(internals.ydoc, "committed-object"));

    const res = await postSnapshot(doInstance);

    // D1 holds the row, so a publish taken on this answer ships the object.
    // Only the document's knowledge of the id was lost.
    expect(res.status).toBe(200);
    expect(db.liveObjectIds()).toEqual(["committed-object"]);
  });
});

// ---------------------------------------------------------------------------
// Hazard 2 — a retry can report a second failure
// ---------------------------------------------------------------------------

describe("a re-registration whose INSERT fails again is reported, not swallowed", () => {
  it("reports the second refusal instead of calling the entity already present", async () => {
    const { doInstance, db } = makeDo(new Set(["lost-object"]));
    const insert = { objects: { insert: [{ object_id: "lost-object", title: "Lost" }] } };

    const first = (await (await postIngest(doInstance, insert)).json()) as {
      failed?: { objectInsert?: string[] };
    };
    expect(first.failed?.objectInsert).toEqual(["lost-object"]);

    // The document now holds the object with a null `_id`. That is not
    // "already in D1": D1 has no row, and the retry's INSERT is refused again.
    const retry = (await (await postIngest(doInstance, insert)).json()) as {
      applied: { objectInsert: number };
      skipped: { objectInsert: string[] };
      failed?: { objectInsert?: string[] };
    };

    expect(retry.failed?.objectInsert).toEqual(["lost-object"]);
    expect(retry.skipped.objectInsert).toEqual([]);
    expect(retry.applied.objectInsert).toBe(0);
    expect(db.liveObjectIds()).toEqual([]);
  });

  it("reports success once the retry's INSERT lands", async () => {
    const refuse = new Set(["lost-object"]);
    const { doInstance, db } = makeDo(refuse);
    const insert = { objects: { insert: [{ object_id: "lost-object", title: "Lost" }] } };

    await postIngest(doInstance, insert);
    refuse.delete("lost-object");

    const retry = (await (await postIngest(doInstance, insert)).json()) as {
      applied: { objectInsert: number };
      failed?: { objectInsert?: string[] };
    };

    expect(retry.failed?.objectInsert ?? []).toEqual([]);
    expect(retry.applied.objectInsert).toBe(1);
    expect(db.liveObjectIds()).toEqual(["lost-object"]);
  });

  it("counts an object_id repeated inside one payload once", async () => {
    // The second arm finds the map the first just pushed, which has no id yet
    // because the snapshot runs after the whole diff. That is a duplicate of
    // this call's own work, not a registration D1 lost.
    const { doInstance, db } = makeDo();

    const body = (await (
      await postIngest(doInstance, {
        objects: {
          insert: [
            { object_id: "twice", title: "First" },
            { object_id: "twice", title: "Second" },
          ],
        },
      })
    ).json()) as {
      applied: { objectInsert: number };
      skipped: { objectInsert: string[] };
      failed?: { objectInsert?: string[] };
    };

    expect(body.applied.objectInsert).toBe(1);
    expect(body.skipped.objectInsert).toEqual(["twice"]);
    expect(body.failed?.objectInsert ?? []).toEqual([]);
    expect(db.liveObjectIds()).toEqual(["twice"]);
  });

  it("still calls an object D1 already holds already present", async () => {
    const { doInstance } = makeDo();
    const insert = { objects: { insert: [{ object_id: "landed-object", title: "Landed" }] } };

    await postIngest(doInstance, insert);
    const retry = (await (await postIngest(doInstance, insert)).json()) as {
      applied: { objectInsert: number };
      skipped: { objectInsert: string[] };
    };

    expect(retry.skipped.objectInsert).toEqual(["landed-object"]);
    expect(retry.applied.objectInsert).toBe(0);
  });
});

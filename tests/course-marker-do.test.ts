/**
 * The course marker (`objects.course_project_id`) as the Durable Object handles
 * it: how it arrives, how it survives a cold rebuild, what it forbids, and how
 * it is cleared.
 *
 * The marker's whole value is that it cannot be lost and cannot be faked. Four
 * properties carry that, and each has a way of failing silently:
 *
 *   - ARRIVAL   — the ingest carries the marker, created_by and origin onto the
 *                 Y.Map, and leaves the marker key ABSENT (never null) on an
 *                 object that has none.
 *   - COLD BUILD— a rebuild from D1 restores a marked object's key and leaves an
 *                 unmarked one key-less. Miss it and every cold start strips the
 *                 delete protection.
 *   - REFUSAL   — the ingest remove path will not delete a marked object, so a
 *                 routine full sync cannot take the whole preloaded collection
 *                 with it.
 *   - CLEARING  — the dedicated route removes the marker from the document and
 *                 flushes a snapshot BEFORE it answers, so D1 is consistent by
 *                 the time a leave or a course deletion proceeds.
 *
 * The DO is exercised directly with a stubbed ctx/env and the bind-recording
 * fake D1 established by created-by-persist.test.ts and
 * snapshot-preserve-d1-columns.test.ts.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

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
import { makeObjectYMap } from "~/lib/object-ymap";
import { markLoaded } from "./helpers/claimed-document";
import { updateSetColumns } from "./helpers/sql-set-list";
import { checkD1Bind } from "./helpers/d1-memory";

const TEST_PROJECT_ID = 42;
const TEST_SECRET = "test-session-secret";
const COURSE_ID = 900;
const OTHER_COURSE_ID = 901;

interface BindCall {
  sql: string;
  args: unknown[];
}

/**
 * The fake D1. `gateBatch` holds `DB.batch()` open until released, which is how
 * the ordering test proves the route cannot answer before its flush completes.
 */
function makeFakeDB(rowProvider: (sql: string) => unknown[], gateBatch = false) {
  const binds: BindCall[] = [];
  let releaseBatch: () => void = () => {};
  const batchGate = gateBatch
    ? new Promise<void>((resolve) => {
        releaseBatch = resolve;
      })
    : Promise.resolve();
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
  return {
    binds,
    releaseBatch: () => releaseBatch(),
    DB: {
      prepare: (sql: string) => stmt(sql),
      async batch() {
        await batchGate;
        return [];
      },
    },
  };
}

function makeCtx(onGateExit?: (entries: number) => void) {
  let entries = 0;
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      entries += 1;
      const result = await fn();
      onGateExit?.(entries);
      return result;
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

function makeDO(
  rowProvider: (sql: string) => unknown[] = () => [],
  opts: { gateBatch?: boolean; onGateExit?: (entries: number) => void; parent?: number | null } = {},
) {
  // The site is attached to COURSE_ID unless a case says otherwise: a site
  // holds only its own course's markers, and the object reads its
  // parent to tell.
  const parent = opts.parent === undefined ? COURSE_ID : opts.parent;
  const { DB, binds, releaseBatch } = makeFakeDB(
    (sql) => (sql.startsWith("SELECT parent_project_id FROM projects") ? [{ parent_project_id: parent }] : rowProvider(sql)),
    opts.gateBatch,
  );
  const env = { DB, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} } as unknown;
  const doInstance = new ProjectCollaborationDO(
    makeCtx(opts.onGateExit) as unknown as DurableObjectState,
    env as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  markLoaded(doInstance);
  return { doInstance, binds, releaseBatch };
}

/**
 * Take control of the DO's snapshot lock. The real flag is set and cleared by
 * snapshotToD1 itself; scripting it is how a test stages the one condition the
 * flush guarantee exists for — an alarm snapshot holding the lock when the
 * route wants to write.
 */
function holdSnapshotLock(doInstance: ProjectCollaborationDO): { release: () => void } {
  let held = true;
  Object.defineProperty(doInstance, "isSnapshotting", {
    get: () => held,
    set: () => {}, // snapshotToD1's own bookkeeping is inert while scripted
    configurable: true,
  });
  return { release: () => { held = false; } };
}

function ydocOf(doInstance: ProjectCollaborationDO): Y.Doc {
  return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
}

function objectsOf(doInstance: ProjectCollaborationDO): Y.Array<Y.Map<unknown>> {
  return ydocOf(doInstance).getArray<Y.Map<unknown>>("objects");
}

async function post(
  doInstance: ProjectCollaborationDO,
  path: string,
  op: string,
  body: unknown,
  projectId = TEST_PROJECT_ID,
): Promise<Response> {
  const { sigHex, timestamp } = await signInternalMarker(projectId, TEST_SECRET, op);
  return doInstance.fetch(
    new Request(`https://internal/${path}`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(projectId),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

/** A minimal preload-shaped ingest: objects.insert and nothing else. */
function preloadPayload(inserts: Array<Record<string, unknown>>) {
  return { objects: { insert: inserts } };
}

/** Seed one object Y.Map directly, as a live document would already hold it. */
function seedObject(
  doInstance: ProjectCollaborationDO,
  spec: { id: number | null; objectId: string; courseProjectId?: number },
) {
  const ydoc = ydocOf(doInstance);
  ydoc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set("_id", spec.id);
    m.set("_validation_state", "valid");
    m.set("object_id", spec.objectId);
    m.set("title", new Y.Text("Seeded"));
    m.set("created_by", null);
    if (spec.courseProjectId !== undefined) {
      m.set("course_project_id", spec.courseProjectId);
    }
    ydoc.getArray<Y.Map<unknown>>("objects").push([m]);
  }, null);
}

/** The recorded objects UPDATE, split into its SET columns and bound args. */
function objectUpdate(binds: BindCall[]): { cols: string[]; args: unknown[] } | null {
  const call = binds.find((b) => b.sql.startsWith("UPDATE objects SET"));
  if (!call) return null;
  return { cols: updateSetColumns(call.sql), args: call.args };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ARRIVAL — the ingest shape
// ---------------------------------------------------------------------------

describe("ingest arrival — the preload's fields reach the object Y.Map", () => {
  it("carries the marker, created_by and origin, and forces nothing else", async () => {
    const { doInstance } = makeDO();
    const res = await post(doInstance, "ingest-sync", "ingest-sync", preloadPayload([
      {
        object_id: "obj-course",
        title: "A course object",
        source_url: "https://example.org/manifest.json",
        thumbnail: "https://example.org/thumb.jpg",
        image_available: true,
        featured: false,
        origin: "compositor",
        created_by: 7,
        course_project_id: COURSE_ID,
      },
    ]));
    expect(res.status).toBe(200);

    const m = objectsOf(doInstance).get(0);
    expect(m.get("course_project_id")).toBe(COURSE_ID);
    expect(m.get("created_by")).toBe(7);
    expect(m.get("origin")).toBe("compositor");
    // Carried verbatim — the parent's values for literally the same URL.
    expect(m.get("source_url")).toBe("https://example.org/manifest.json");
    expect(m.get("thumbnail")).toBe("https://example.org/thumb.jpg");
    expect(m.get("image_available")).toBe(true);
    expect(m.get("featured")).toBe(false);
  });

  it("leaves the marker key ABSENT — not null — on an unmarked insert", async () => {
    const { doInstance } = makeDO();
    await post(doInstance, "ingest-sync", "ingest-sync", preloadPayload([
      { object_id: "obj-plain", title: "An ordinary object", created_by: null },
    ]));

    const m = objectsOf(doInstance).get(0);
    expect(m.has("course_project_id")).toBe(false);
    expect(m.get("origin")).toBeUndefined(); // left to the INSERT's own default
  });

  it("binds the marker into the objects INSERT, and NULL when there is none", async () => {
    const marked = makeDO();
    await post(marked.doInstance, "ingest-sync", "ingest-sync", preloadPayload([
      { object_id: "obj-course", created_by: null, course_project_id: COURSE_ID },
    ]));
    const markedInsert = marked.binds.find((b) => b.sql.startsWith("INSERT INTO objects"));
    expect(markedInsert).toBeDefined();
    const cols = markedInsert!.sql.match(/INSERT INTO objects \(([^)]+)\)/)![1]
      .split(",")
      .map((c) => c.trim());
    expect(markedInsert!.args[cols.indexOf("course_project_id")]).toBe(COURSE_ID);
    expect(markedInsert!.args[cols.indexOf("origin")]).toBe("iiif");

    const plain = makeDO();
    await post(plain.doInstance, "ingest-sync", "ingest-sync", preloadPayload([
      { object_id: "obj-plain", created_by: null },
    ]));
    const plainInsert = plain.binds.find((b) => b.sql.startsWith("INSERT INTO objects"))!;
    expect(plainInsert.args[cols.indexOf("course_project_id")]).toBeNull();
  });

  it("carries a repo-sync origin to the Y.Map and the INSERT", async () => {
    const { doInstance, binds } = makeDO();
    await post(doInstance, "ingest-sync", "ingest-sync", preloadPayload([
      { object_id: "obj-repo", created_by: null, origin: "repo" },
    ]));

    expect(objectsOf(doInstance).get(0).get("origin")).toBe("repo");
    const insert = binds.find((b) => b.sql.startsWith("INSERT INTO objects"))!;
    const cols = insert.sql.match(/INSERT INTO objects \(([^)]+)\)/)![1]
      .split(",")
      .map((c) => c.trim());
    expect(insert.args[cols.indexOf("origin")]).toBe("repo");
  });

  it("ignores an origin other than compositor and repo, leaving the iiif default", async () => {
    // IngestObjectInsert.origin names the two values, but a cast or a hand-built
    // JSON body reaches the DO the same way, so the reader refuses the rest.
    const { doInstance, binds } = makeDO();
    await post(doInstance, "ingest-sync", "ingest-sync", preloadPayload([
      { object_id: "obj-other", created_by: null, origin: "bogus" as never },
    ]));

    expect(objectsOf(doInstance).get(0).has("origin")).toBe(false);
    const insert = binds.find((b) => b.sql.startsWith("INSERT INTO objects"))!;
    const cols = insert.sql.match(/INSERT INTO objects \(([^)]+)\)/)![1]
      .split(",")
      .map((c) => c.trim());
    expect(insert.args[cols.indexOf("origin")]).toBe("iiif");
  });

  it("the ingest's stated origin reaches the INSERT instead of the iiif default", async () => {
    const { doInstance, binds } = makeDO();
    await post(doInstance, "ingest-sync", "ingest-sync", preloadPayload([
      { object_id: "obj-course", created_by: null, origin: "compositor" },
    ]));
    const insert = binds.find((b) => b.sql.startsWith("INSERT INTO objects"))!;
    const cols = insert.sql.match(/INSERT INTO objects \(([^)]+)\)/)![1]
      .split(",")
      .map((c) => c.trim());
    expect(insert.args[cols.indexOf("origin")]).toBe("compositor");
  });
});

// ---------------------------------------------------------------------------
// COLD BUILD — the marker survives an eviction
// ---------------------------------------------------------------------------

describe("cold rebuild — buildFromD1Rows restores the marker faithfully", () => {
  function coldDO(rows: Array<Record<string, unknown>>) {
    return makeDO((sql) => {
      if (sql.includes("FROM objects")) return rows;
      return [];
    });
  }

  const baseRow = {
    object_id: "obj",
    title: null,
    creator: null,
    description: null,
    alt_text: null,
    source_url: null,
    period: null,
    year: null,
    object_type: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    dimensions: null,
    extra_columns: null,
    featured: 0,
    image_available: 0,
    created_by: null,
  };

  it("a marked row rebuilds with its marker; an unmarked row rebuilds key-less", async () => {
    const { doInstance } = coldDO([
      { ...baseRow, id: 1, object_id: "obj-course", course_project_id: COURSE_ID },
      { ...baseRow, id: 2, object_id: "obj-plain", course_project_id: null },
    ]);
    await (doInstance as unknown as { buildFromD1Rows: () => Promise<void> }).buildFromD1Rows();

    const arr = objectsOf(doInstance);
    expect(arr.get(0).get("course_project_id")).toBe(COURSE_ID);
    expect(arr.get(1).has("course_project_id")).toBe(false);
  });

  it("the cold-build SELECT actually reads the column (not a defaulted undefined)", async () => {
    const { doInstance, binds } = coldDO([]);
    await (doInstance as unknown as { buildFromD1Rows: () => Promise<void> }).buildFromD1Rows();
    const select = binds.find((b) => /SELECT id, object_id.*FROM objects/s.test(b.sql));
    expect(select?.sql).toContain("course_project_id");
  });
});

// ---------------------------------------------------------------------------
// REFUSAL — a marked object is not removable through the ingest
// ---------------------------------------------------------------------------

describe("ingest remove path — course items are exempt", () => {
  it("refuses a marked object and reports it as skipped", async () => {
    const { doInstance } = makeDO();
    seedObject(doInstance, { id: 801, objectId: "obj-course", courseProjectId: COURSE_ID });

    const res = await post(doInstance, "ingest-sync", "ingest-sync", {
      objects: { insert: [], update: [], remove: ["obj-course"] },
    });
    const body = (await res.json()) as {
      applied: { objectRemove: number };
      skipped: { objectRemove: string[] };
    };

    expect(body.applied.objectRemove).toBe(0);
    expect(body.skipped.objectRemove).toContain("obj-course");
    expect(objectsOf(doInstance).length).toBe(1);
  });

  it("still removes an ordinary site object", async () => {
    const { doInstance } = makeDO();
    seedObject(doInstance, { id: 802, objectId: "obj-plain" });

    const res = await post(doInstance, "ingest-sync", "ingest-sync", {
      objects: { insert: [], update: [], remove: ["obj-plain"] },
    });
    const body = (await res.json()) as { applied: { objectRemove: number } };

    expect(body.applied.objectRemove).toBe(1);
    expect(objectsOf(doInstance).length).toBe(0);
  });

  it("the ingest's object-field allowlist cannot set the marker", async () => {
    const { doInstance } = makeDO();
    seedObject(doInstance, { id: 803, objectId: "obj-plain" });

    await post(doInstance, "ingest-sync", "ingest-sync", {
      objects: {
        insert: [],
        update: [{ objectId: "obj-plain", fields: { course_project_id: COURSE_ID } }],
        remove: [],
      },
    });

    expect(objectsOf(doInstance).get(0).has("course_project_id")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLEARING — the dedicated route
// ---------------------------------------------------------------------------

describe("POST /clear-course-markers", () => {
  it("refuses an unsigned request", async () => {
    const { doInstance } = makeDO();
    const res = await doInstance.fetch(
      new Request("https://internal/clear-course-markers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseProjectId: COURSE_ID }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("refuses a marker signed for a different operation", async () => {
    const { doInstance } = makeDO();
    // A /reset marker replayed against this route: same three headers, wrong op.
    const res = await post(doInstance, "clear-course-markers", "reset", {
      courseProjectId: COURSE_ID,
    });
    expect(res.status).toBe(401);
  });

  it("refuses a missing or malformed course id", async () => {
    const { doInstance } = makeDO();
    const bad = [{}, { courseProjectId: 0 }, { courseProjectId: -1 }, { courseProjectId: 1.5 }, { courseProjectId: "nope" }, { courseProjectId: null }];
    for (const body of bad) {
      const res = await post(doInstance, "clear-course-markers", "clear-course-markers", body);
      expect(res.status, `body ${JSON.stringify(body)} was accepted`).toBe(400);
    }
  });

  it("clears only the named course's markers, leaving other courses untouched", async () => {
    // Attached to the other course, whose markers are the site's own: the
    // clear is for a course it is leaving, and must reach no other.
    const { doInstance } = makeDO(undefined, { parent: OTHER_COURSE_ID });
    seedObject(doInstance, { id: 1, objectId: "ours-a", courseProjectId: COURSE_ID });
    seedObject(doInstance, { id: 2, objectId: "theirs", courseProjectId: OTHER_COURSE_ID });
    seedObject(doInstance, { id: 3, objectId: "plain" });
    seedObject(doInstance, { id: 4, objectId: "ours-b", courseProjectId: COURSE_ID });

    const res = await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 2 });

    const arr = objectsOf(doInstance);
    expect(arr.get(0).has("course_project_id")).toBe(false);
    expect(arr.get(1).get("course_project_id")).toBe(OTHER_COURSE_ID);
    expect(arr.get(2).has("course_project_id")).toBe(false);
    expect(arr.get(3).has("course_project_id")).toBe(false);
  });

  it("deletes the key rather than nulling it — the objects stay behind as ordinary ones", async () => {
    const { doInstance } = makeDO();
    seedObject(doInstance, { id: 1, objectId: "ours", courseProjectId: COURSE_ID });

    await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });

    const m = objectsOf(doInstance).get(0);
    expect(m.has("course_project_id")).toBe(false);
    expect(m.get("object_id")).toBe("ours"); // the object itself survives
    expect(objectsOf(doInstance).length).toBe(1);
  });

  it("flushes the snapshot BEFORE answering, so D1 already reads NULL", async () => {
    // The listing SELECT returns the row's id, so the object takes the UPDATE
    // branch and the cleared marker is bound as NULL.
    const { doInstance, binds } = makeDO((sql) =>
      /SELECT id, object_id FROM objects WHERE project_id/.test(sql)
        ? [{ id: 1, object_id: "ours" }]
        : [],
    );
    seedObject(doInstance, { id: 1, objectId: "ours", courseProjectId: COURSE_ID });

    const res = await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });
    expect(res.status).toBe(200);

    // Asserted on the binds recorded by the time the response resolved: a
    // caller that proceeds to a cascade the moment this answers must not race
    // an unflushed document.
    const update = objectUpdate(binds);
    expect(update, "no objects UPDATE was issued before the route answered").not.toBeNull();
    expect(update!.args[update!.cols.indexOf("course_project_id")]).toBeNull();
  });

  it("cannot answer before the flush has landed in D1", async () => {
    // Ordering, not co-occurrence: the D1 batch is held open, and the route's
    // promise must still be unsettled while it is. A response constructed
    // before the write completes would hand the leave cascade a guarantee the
    // database has not yet honoured.
    const { doInstance, releaseBatch } = makeDO(
      (sql) =>
        /SELECT id, object_id FROM objects WHERE project_id/.test(sql)
          ? [{ id: 1, object_id: "ours" }]
          : [],
      { gateBatch: true },
    );
    seedObject(doInstance, { id: 1, objectId: "ours", courseProjectId: COURSE_ID });

    let settled = false;
    const pending = post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    }).then((r) => {
      settled = true;
      return r;
    });

    // Give the route every chance to run ahead to (and past) the batch.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
    expect(settled, "the route answered while its D1 write was still in flight").toBe(false);

    releaseBatch();
    const res = await pending;
    expect(res.status).toBe(200);
  });

  it("retries the flush when a snapshot held the lock, then answers 200", async () => {
    const { doInstance } = makeDO(
      (sql) =>
        /SELECT id, object_id FROM objects WHERE project_id/.test(sql)
          ? [{ id: 1, object_id: "ours" }]
          : [],
      // Release the lock once the first gated attempt has come and gone, so
      // the second attempt finds it clear.
      { onGateExit: (entries) => { if (entries === 1) lock.release(); } },
    );
    const lock = holdSnapshotLock(doInstance);
    seedObject(doInstance, { id: 1, objectId: "ours", courseProjectId: COURSE_ID });

    const res = await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 1 });
  });

  it("counts the clearing once across retries", async () => {
    const { doInstance } = makeDO(() => [], {
      onGateExit: (entries) => { if (entries === 1) lock.release(); },
    });
    const lock = holdSnapshotLock(doInstance);
    seedObject(doInstance, { id: 1, objectId: "a", courseProjectId: COURSE_ID });
    seedObject(doInstance, { id: 2, objectId: "b", courseProjectId: COURSE_ID });

    const res = await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });

    // The document is mutated once; only the flush is retried. A count that
    // grew per attempt would mean the transaction ran again on a clean doc.
    expect(await res.json()).toEqual({ cleared: 2 });
  });

  it("refuses with 503 rather than reporting success on an unflushed document", async () => {
    const { doInstance, binds } = makeDO();
    holdSnapshotLock(doInstance); // never released
    seedObject(doInstance, { id: 1, objectId: "ours", courseProjectId: COURSE_ID });

    const res = await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });

    expect(res.status).toBe(503);
    expect(binds.some((b) => b.sql.startsWith("UPDATE objects SET"))).toBe(false);
  });

  it("a retry after a refusal still flushes, even though nothing is left to clear", async () => {
    // The failure mode a cleared === 0 shortcut would create: the first call
    // emptied the document, so a retry counts nothing — while D1 still holds
    // the markers that call failed to write away.
    const { doInstance, binds } = makeDO((sql) =>
      /SELECT id, object_id FROM objects WHERE project_id/.test(sql)
        ? [{ id: 1, object_id: "ours" }]
        : [],
    );
    const lock = holdSnapshotLock(doInstance);
    seedObject(doInstance, { id: 1, objectId: "ours", courseProjectId: COURSE_ID });

    const first = await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });
    expect(first.status).toBe(503);

    lock.release();
    const second = await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ cleared: 0 });
    const update = objectUpdate(binds);
    expect(update, "the retry answered 200 without flushing anything").not.toBeNull();
    expect(update!.args[update!.cols.indexOf("course_project_id")]).toBeNull();
  });

  it("is idempotent — a second clear finds nothing left to do", async () => {
    const { doInstance } = makeDO();
    seedObject(doInstance, { id: 1, objectId: "ours", courseProjectId: COURSE_ID });

    await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });
    const second = await post(doInstance, "clear-course-markers", "clear-course-markers", {
      courseProjectId: COURSE_ID,
    });
    expect(await second.json()).toEqual({ cleared: 0 });
  });
});

// ---------------------------------------------------------------------------
// The client factory stays out of it
// ---------------------------------------------------------------------------

describe("makeObjectYMap — a site-made object is unmarked", () => {
  it("never sets the marker key", () => {
    const map = makeObjectYMap({
      objectId: "site-made",
      validationState: "valid",
      origin: "compositor",
      orderKey: "a01",
    });
    // Attach to a doc so keys() reflects the real Y.Map state.
    new Y.Doc().getArray<Y.Map<unknown>>("scratch").push([map]);
    expect([...map.keys()]).not.toContain("course_project_id");
  });
});

// ---------------------------------------------------------------------------
// A site's document holds only its own course's markers
// ---------------------------------------------------------------------------

type Internals = {
  flushSnapshotNow(): Promise<boolean>;
  runPostLoadRepairs(): Promise<void>;
  markerBroadcastOwed: boolean;
  env: { DB: { batch: (...args: unknown[]) => Promise<unknown> } };
};
const internals = (doInstance: ProjectCollaborationDO) => doInstance as unknown as Internals;

describe("a site's document holds only its own course's markers", () => {
  const courseObject = (objectId: string, course: number) => ({
    object_id: objectId,
    title: "A course object",
    source_url: "https://example.org/manifest.json",
    featured: false,
    origin: "compositor",
    course_project_id: course,
  });

  it("refuses an insert marked for another course, and counts it, beside one that lands", async () => {
    const { doInstance } = makeDO();
    const res = await post(doInstance, "ingest-sync", "ingest-sync", preloadPayload([
      courseObject("ours", COURSE_ID),
      courseObject("theirs", OTHER_COURSE_ID),
      { object_id: "plain", title: "Plain", featured: false },
    ]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { courseRefused: { objectInsert: string[] } };
    expect(body.courseRefused.objectInsert).toEqual(["theirs"]);
    expect(objectsOf(doInstance).toArray().map((m) => m.get("object_id"))).toEqual(["ours", "plain"]);
  });

  it("refuses every marked insert once the site is in no course", async () => {
    const { doInstance } = makeDO(undefined, { parent: null });
    const res = await post(doInstance, "ingest-sync", "ingest-sync", preloadPayload([
      courseObject("late", COURSE_ID),
    ]));
    const body = (await res.json()) as { courseRefused: { objectInsert: string[] } };
    expect(body.courseRefused.objectInsert).toEqual(["late"]);
    expect(objectsOf(doInstance).length).toBe(0);
  });

  it("drops a stranded marker before a snapshot writes, and writes the row without it", async () => {
    const { doInstance, binds } = makeDO(undefined, { parent: null });
    seedObject(doInstance, { id: 1, objectId: "stranded", courseProjectId: COURSE_ID });
    expect(await internals(doInstance).flushSnapshotNow()).toBe(true);

    expect(objectsOf(doInstance).get(0).has("course_project_id")).toBe(false);
    // Whatever statement writes the row (an INSERT here: the fake D1 holds
    // none), no objects statement binds the stranded course.
    const objectWrites = binds.filter((b) => /^(INSERT INTO|UPDATE) objects/.test(b.sql));
    expect(objectWrites.length).toBeGreaterThan(0);
    expect(objectWrites.some((b) => b.args.includes(COURSE_ID))).toBe(false);
    expect(internals(doInstance).markerBroadcastOwed).toBe(false);
  });

  it("keeps the marker of the course the site is attached to", async () => {
    const { doInstance } = makeDO();
    seedObject(doInstance, { id: 1, objectId: "ours", courseProjectId: COURSE_ID });
    await internals(doInstance).flushSnapshotNow();
    expect(objectsOf(doInstance).get(0).get("course_project_id")).toBe(COURSE_ID);
  });

  it("still owes the peers the drop when the snapshot that made it fails", async () => {
    const { doInstance } = makeDO(undefined, { parent: null });
    seedObject(doInstance, { id: 1, objectId: "stranded", courseProjectId: COURSE_ID });
    // A transient D1 failure after the drop: the config read that follows it
    // fails once.
    const db = internals(doInstance).env.DB as unknown as { prepare: (sql: string) => unknown };
    const prepare = db.prepare;
    let failOnce = true;
    db.prepare = (sql: string) => {
      if (failOnce && sql.startsWith("SELECT id FROM project_config")) {
        failOnce = false;
        return {
          bind: (...args: unknown[]) => {
            checkD1Bind(sql, args);
            return { first: async () => { throw new Error("D1 unavailable"); } };
          },
        };
      }
      return prepare(sql);
    };
    const first = await internals(doInstance).flushSnapshotNow().catch(() => "threw");
    expect(first).toBe("threw");
    expect(objectsOf(doInstance).get(0).has("course_project_id")).toBe(false);
    expect(internals(doInstance).markerBroadcastOwed).toBe(true);

    expect(await internals(doInstance).flushSnapshotNow()).toBe(true);
    expect(internals(doInstance).markerBroadcastOwed).toBe(false);
  });

  it("sends a connected peer the drop on the retry, when the attempt that made it failed", async () => {
    const { doInstance } = makeDO(undefined, { parent: null });
    seedObject(doInstance, { id: 1, objectId: "stranded", courseProjectId: COURSE_ID });
    // A peer that holds the marker, and receives whatever the object sends.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydocOf(doInstance)));
    const sent: Uint8Array[] = [];
    (doInstance as unknown as { ctx: { getWebSockets: () => unknown[] } }).ctx.getWebSockets = () => [
      { send: (frame: Uint8Array) => sent.push(frame) },
    ];
    const db = internals(doInstance).env.DB as unknown as { prepare: (sql: string) => unknown };
    const prepare = db.prepare;
    let failOnce = true;
    db.prepare = (sql: string) => {
      if (failOnce && sql.startsWith("SELECT id FROM project_config")) {
        failOnce = false;
        return {
          bind: (...args: unknown[]) => {
            checkD1Bind(sql, args);
            return { first: async () => { throw new Error("D1 unavailable"); } };
          },
        };
      }
      return prepare(sql);
    };
    await internals(doInstance).flushSnapshotNow().catch(() => false);
    expect(sent).toEqual([]);

    expect(await internals(doInstance).flushSnapshotNow()).toBe(true);
    expect(sent.length).toBe(1);
    const decoder = decoding.createDecoder(sent[0]);
    decoding.readVarUint(decoder); // the sync message type
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), peer, null);
    expect(peer.getArray<Y.Map<unknown>>("objects").get(0).has("course_project_id")).toBe(false);
  });

  it("drops a stranded marker when the document loads", async () => {
    const { doInstance } = makeDO(undefined, { parent: OTHER_COURSE_ID });
    seedObject(doInstance, { id: 1, objectId: "stranded", courseProjectId: COURSE_ID });
    seedObject(doInstance, { id: 2, objectId: "ours", courseProjectId: OTHER_COURSE_ID });
    await internals(doInstance).runPostLoadRepairs();
    expect(objectsOf(doInstance).toArray().map((m) => m.get("course_project_id") ?? null)).toEqual([null, OTHER_COURSE_ID]);
  });

  it("strips nothing when the parent cannot be read, and the snapshot fails", async () => {
    const { doInstance } = makeDO((sql) => {
      if (sql.startsWith("SELECT parent_project_id")) throw new Error("D1 unavailable");
      return [];
    });
    // makeDO answers the parent itself; replace that answer with a failure.
    (internals(doInstance).env.DB as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => ({
      bind: (...args: unknown[]) => {
        checkD1Bind(sql, args);
        return {
          first: async () => {
            if (sql.startsWith("SELECT parent_project_id")) throw new Error("D1 unavailable");
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { last_row_id: 100, changes: 1 } }),
        };
      },
    });
    seedObject(doInstance, { id: 1, objectId: "ours", courseProjectId: COURSE_ID });
    const outcome = await internals(doInstance).flushSnapshotNow().catch(() => "threw");
    expect(outcome).not.toBe(true);
    expect(objectsOf(doInstance).get(0).get("course_project_id")).toBe(COURSE_ID);
  });
});

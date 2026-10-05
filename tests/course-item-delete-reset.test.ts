/**
 * Course-item protection at the Durable Object level: it has to survive
 * `/reset`, and it has to leave the document in a state the DO's own
 * pre-snapshot dedupe cannot turn back into a substitution.
 *
 * The DO's `afterTransaction` handlers close over the Y.Doc they were bound
 * to, and `/reset` replaces the document. `attachDocHandlers` re-binds them,
 * so the course pass is enforced on the replacement doc — this pins that for
 * the marker rule specifically, not just the collaborator rule.
 *
 * The marked object is written into the post-reset document directly (a
 * DO-internal, null-origin transaction) rather than through a cold rebuild:
 * carrying the marker through `buildFromD1Rows` belongs to the preload
 * workstream, and the enforcement pass must hold regardless of how the marker
 * arrived in the document.
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
import { signInternalMarker } from "../workers/auth";
import { checkD1Bind } from "./helpers/d1-memory";

/**
 * Durable Object key-value storage. The DO reads the document generation from
 * it on every socket upgrade and writes it on `/reset`, so a stub that only
 * answers the alarm calls leaves the reset unable to arm its guard. Each
 * harness gets its own store.
 */
function makeStorageStub(extra: Record<string, unknown> = {}) {
  const kv = new Map<string, unknown>();
  return {
    getAlarm: async () => null,
    setAlarm: async () => {},
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => { kv.set(key, value); },
    // A load lists the log prefix before it tags an untagged blob or builds one.
    list: async () => new Map(),
    // The snapshot and the reset retire a storage base header by deleting it.
    delete: async (keys: string[]) => keys.filter((key) => kv.delete(key)).length,
    ...extra,
  };
}


const TEST_SECRET = "test-session-secret";
const TEST_PROJECT_ID = 42;
const CONVENOR = 1;
const COURSE_PROJECT_ID = 900;

function fakeSocket(userId: number, role: "convenor" | "collaborator" | "instructor") {
  const attachment = { userId, projectId: TEST_PROJECT_ID, role };
  return {
    attachment,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

/** D1 stub for a cold project: no blob, no rows. */
function makeDb() {
  return {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          checkD1Bind(sql, args);
          return {
            // The base row a load and a reset both read: no blob, no tags, no
            // claim yet, which is the cold build.
            first: async () =>
              /^SELECT yjs_state|^SELECT yjs_generation/.test(sql)
                ? { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 }
                : null,
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { last_row_id: 1, changes: 1 }, success: true as const }),
          };
        },
      };
    },
  };
}

async function makeDO(sockets: ReturnType<typeof fakeSocket>[]) {
  const ctx = {
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: makeStorageStub(),
    acceptWebSocket: vi.fn(),
  };
  const env = { DB: makeDb(), SESSION_SECRET: TEST_SECRET, COLLABORATION: {} };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  await new Promise((r) => setTimeout(r, 0));
  return doInstance;
}

async function resetRequest(): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(TEST_PROJECT_ID, TEST_SECRET, "reset");
  return new Request("https://internal/reset", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(TEST_PROJECT_ID),
    },
  });
}

function liveDoc(doInstance: ProjectCollaborationDO): Y.Doc {
  return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
}

function seedMarkedObject(
  ydoc: Y.Doc,
  objectId: string,
  marker: number | null,
  rowId: number | null = null,
  tempId: string = objectId,
): void {
  ydoc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("_id", rowId);
    map.set("_temp_id", tempId);
    map.set("created_by", CONVENOR);
    map.set("object_id", objectId);
    if (marker !== null) map.set("course_project_id", marker);
    ydoc.getArray<Y.Map<unknown>>("objects").push([map]);
  }, null);
}

function objectIds(ydoc: Y.Doc): unknown[] {
  return ydoc
    .getArray<Y.Map<unknown>>("objects")
    .toArray()
    .map((m) => m.get("object_id"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => { /* silence the revert log */ });
});

describe("collaboration DO — course-item protection after /reset", () => {
  it("reverts a convenor's delete of a marked object on the post-reset doc", async () => {
    const convenor = fakeSocket(CONVENOR, "convenor");
    const doInstance = await makeDO([convenor]);
    expect((await doInstance.fetch(await resetRequest())).status).toBe(200);

    const ydoc = liveDoc(doInstance);
    seedMarkedObject(ydoc, "course-object", COURSE_PROJECT_ID);

    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    }, convenor);

    expect(objectIds(ydoc)).toEqual(["course-object"]);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("course_project_id"))
      .toBe(COURSE_PROJECT_ID);
  });

  it("still lets the convenor delete an unmarked object on the post-reset doc", async () => {
    const convenor = fakeSocket(CONVENOR, "convenor");
    const doInstance = await makeDO([convenor]);
    await doInstance.fetch(await resetRequest());

    const ydoc = liveDoc(doInstance);
    seedMarkedObject(ydoc, "plain-object", null);

    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    }, convenor);

    expect(objectIds(ydoc)).toEqual([]);
  });
});

describe("collaboration DO — a spoofed course item does not survive the dedupe", () => {
  it("leaves the restored original as the sole survivor of deduplicateYArray", async () => {
    // End-to-end: the attacker deletes a marked object and inserts a
    // replacement at a LOWER index carrying the victim's `_id` and
    // `object_id` under a different `_temp_id`. The revert must remove the
    // replacement — because `deduplicateYArray` runs null-origin, exempt
    // from enforcement, collapses exact `_id` duplicates and keeps the first
    // occurrence, so a surviving replacement would have the DO itself delete
    // the restored original.
    const convenor = fakeSocket(CONVENOR, "convenor");
    const doInstance = await makeDO([convenor]);
    await doInstance.fetch(await resetRequest());

    const ydoc = liveDoc(doInstance);
    seedMarkedObject(ydoc, "course-obj", COURSE_PROJECT_ID, 100);

    ydoc.transact(() => {
      const arr = ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      const replacement = new Y.Map<unknown>();
      replacement.set("_id", 100);
      replacement.set("_temp_id", "attacker");
      replacement.set("object_id", "course-obj");
      replacement.set("created_by", 999);
      replacement.set("source_url", "https://attacker.example/manifest.json");
      arr.insert(0, [replacement]);
    }, convenor);

    // The DO's own pre-snapshot pass, exactly as snapshotToD1 invokes it.
    (doInstance as unknown as {
      deduplicateYArray: (name: string, key: string) => boolean;
    }).deduplicateYArray("objects", "object_id");

    const arr = ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_temp_id")).toBe("course-obj");
    expect(arr.get(0).get("created_by")).toBe(CONVENOR);
    expect(arr.get(0).get("course_project_id")).toBe(COURSE_PROJECT_ID);
    expect(arr.get(0).get("source_url")).toBeUndefined();
  });
});

describe("collaboration DO — reverting a course item leaves persisted neighbours alone", () => {
  it("keeps a pre-existing persisted same-slug row, and the dedupe re-keys the unsaved copy", async () => {
    // The victim is still inside its pre-first-snapshot `_id: null` window and
    // shares a slug with a persisted row the transaction never touched. The
    // revert must not sweep that row away: doing so would have the next
    // snapshot DELETE D1 row 300 and INSERT a fresh one in its place.
    const convenor = fakeSocket(CONVENOR, "convenor");
    const doInstance = await makeDO([convenor]);
    await doInstance.fetch(await resetRequest());

    const ydoc = liveDoc(doInstance);
    seedMarkedObject(ydoc, "shared-slug", null, 300, "persisted");
    seedMarkedObject(ydoc, "shared-slug", COURSE_PROJECT_ID, null, "victim");

    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").delete(1, 1);
    }, convenor);

    // Enforcement's own end state: the persisted row untouched, victim back.
    const afterRevert = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(afterRevert.length).toBe(2);
    expect(afterRevert.map((m) => m.get("_id"))).toEqual([300, null]);

    (doInstance as unknown as {
      deduplicateYArray: (name: string, key: string) => boolean;
    }).deduplicateYArray("objects", "object_id");

    // The DO's own rule then gives the slug to the persisted row over the
    // unsaved copy — its documented non-null-`_id` preference, which is what
    // keeps D1 row 300 out of the orphan sweep. The restored victim loses the
    // slug, not its content: an unsaved entity is work in progress, so it is
    // re-keyed rather than dropped (R2-2).
    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors.length).toBe(2);
    const persisted = survivors.find((m) => m.get("_id") === 300)!;
    expect(persisted.get("_temp_id")).toBe("persisted");
    expect(persisted.get("object_id")).toBe("shared-slug");
    const victim = survivors.find((m) => m.get("_id") === null)!;
    expect(victim.get("_temp_id")).toBe("victim");
    expect(victim.get("object_id")).not.toBe("shared-slug");
  });
});

describe("collaboration DO — a twin planted before the delete does not survive the dedupe", () => {
  /** Plant a competitor as its own client transaction, ahead of the delete. */
  function plantTwin(
    ydoc: Y.Doc,
    ws: ReturnType<typeof fakeSocket>,
    fields: Record<string, unknown>,
  ): void {
    ydoc.transact(() => {
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(fields)) map.set(key, value);
      ydoc.getArray<Y.Map<unknown>>("objects").insert(0, [map]);
    }, ws);
  }

  function runDedupe(doInstance: ProjectCollaborationDO): void {
    (doInstance as unknown as {
      deduplicateYArray: (name: string, key: string) => boolean;
    }).deduplicateYArray("objects", "object_id");
  }

  it("E3a: a twin copying the victim's _id is swept, leaving the victim after dedupe", async () => {
    const attacker = fakeSocket(2, "collaborator");
    const doInstance = await makeDO([attacker]);
    await doInstance.fetch(await resetRequest());

    const ydoc = liveDoc(doInstance);
    seedMarkedObject(ydoc, "course-obj", COURSE_PROJECT_ID, 100, "victim");

    plantTwin(ydoc, attacker, {
      _id: 100, _temp_id: "TWIN", object_id: "course-obj", created_by: 2,
      source_url: "https://attacker.example/manifest.json",
    });
    ydoc.transact(() => {
      const arr = ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(arr.length - 1, 1);
    }, attacker);

    runDedupe(doInstance);

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors.length).toBe(1);
    expect(survivors[0].get("_temp_id")).toBe("victim");
    expect(survivors[0].get("course_project_id")).toBe(COURSE_PROJECT_ID);
    expect(survivors[0].get("source_url")).toBeUndefined();
  });

  it("E3b: a twin with a different non-null _id but the victim's slug is swept", async () => {
    const attacker = fakeSocket(2, "collaborator");
    const doInstance = await makeDO([attacker]);
    await doInstance.fetch(await resetRequest());

    const ydoc = liveDoc(doInstance);
    seedMarkedObject(ydoc, "course-obj", COURSE_PROJECT_ID, 100, "victim");

    plantTwin(ydoc, attacker, {
      _id: 777, _temp_id: "TWIN", object_id: "course-obj", created_by: 2,
    });
    ydoc.transact(() => {
      const arr = ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(arr.length - 1, 1);
    }, attacker);

    runDedupe(doInstance);

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors.length).toBe(1);
    expect(survivors[0].get("_id")).toBe(100);
    expect(survivors[0].get("course_project_id")).toBe(COURSE_PROJECT_ID);
  });
});

describe("collaboration DO — clearing a course item's _id does not open the substitution", () => {
  it("X2: the three-step attack leaves the marked victim as the dedupe survivor", async () => {
    // Every discriminator the sweep and the dedupe use resolves through
    // `_id`, so the attacker's move is to clear it first: tx1 strip, tx2
    // plant a non-null-`_id` twin under the victim's slug, tx3 delete. With
    // `_id` DO-owned on marked objects, tx1 is reverted and the chain never
    // starts.
    const attacker = fakeSocket(2, "collaborator");
    const doInstance = await makeDO([attacker]);
    await doInstance.fetch(await resetRequest());

    const ydoc = liveDoc(doInstance);
    seedMarkedObject(ydoc, "course-obj", COURSE_PROJECT_ID, 100, "victim");
    const victim = ydoc.getArray<Y.Map<unknown>>("objects").get(0);

    ydoc.transact(() => { victim.set("_id", null); }, attacker);
    expect(victim.get("_id")).toBe(100);

    ydoc.transact(() => {
      const twin = new Y.Map<unknown>();
      twin.set("_id", 777);
      twin.set("_temp_id", "TWIN");
      twin.set("object_id", "course-obj");
      twin.set("created_by", 2);
      ydoc.getArray<Y.Map<unknown>>("objects").insert(0, [twin]);
    }, attacker);

    ydoc.transact(() => {
      const arr = ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(arr.length - 1, 1);
    }, attacker);

    (doInstance as unknown as {
      deduplicateYArray: (name: string, key: string) => boolean;
    }).deduplicateYArray("objects", "object_id");

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors.length).toBe(1);
    expect(survivors[0].get("_temp_id")).toBe("victim");
    expect(survivors[0].get("_id")).toBe(100);
    expect(survivors[0].get("course_project_id")).toBe(COURSE_PROJECT_ID);
  });
});

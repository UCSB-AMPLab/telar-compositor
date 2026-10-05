/**
 * The snapshot enforcement window: a client transaction must never reach the
 * document while a snapshot holds `isSnapshotting`, because every enforcement
 * pass in `workers/can-delete.ts` skips a transaction taken under that flag.
 *
 * The hole is one of DELIVERY, not of the guard. `snapshotToD1` is a series of
 * D1 awaits; a snapshot started outside `blockConcurrencyWhile` leaves the DO's
 * input gate open across them, so a socket-origin delete is applied and silently
 * unenforced — no revert, no strike. The fix closes the gate at the three outer
 * call sites (`alarm`, `forceSnapshot`, the last-disconnect snapshot in
 * `webSocketClose`), matching what `/snapshot` has always done.
 *
 * HARNESS LIMITATION, stated plainly. Vitest runs the DO against a stubbed
 * `ctx`, so the workerd input gate does not exist here: nothing in this process
 * can defer a function call the test itself makes. The stub therefore MODELS the
 * documented gate contract — while a `blockConcurrencyWhile` callback is
 * running, an event delivered through `deliver()` is queued and runs when the
 * gate opens — and the tests exercise the DO through it. What that proves: the
 * call site opts into the gate, and under the gate's documented semantics the
 * delete is enforced rather than skipped. What it does not prove: that workerd
 * implements those semantics. The characterisation test in the second block
 * pins the raw hazard the gate exists to prevent, with the model bypassed.
 *
 * The gate model also serves as the deadlock canary: `maxGateDepth` must stay
 * at 1. `/clear-course-markers` calls `flushSnapshotNow` from INSIDE a gate, so
 * a gate moved into `snapshotToD1` or `doSnapshot` would nest — which Cloudflare
 * does not support and which would hang the DO on every course leave.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
import { trackBaseRow } from "./helpers/base-row";

const TEST_PROJECT_ID = 42;
const TEST_SECRET = "test-session-secret";
const COURSE_ID = 900;
const CONVENOR = 1;

type Role = "convenor" | "collaborator" | "instructor";

function fakeSocket(userId: number, role: Role) {
  const attachment = { userId, projectId: TEST_PROJECT_ID, role };
  return {
    attachment,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

/** A fake D1 whose `batch()` can be held open, so a snapshot stays in flight. */
function makeFakeDB(failBatch = false) {
  let releaseBatch: () => void = () => {};
  let batchEntered: () => void = () => {};
  const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
  const batchReached = new Promise<void>((resolve) => { batchEntered = resolve; });
  const row = trackBaseRow();
  const stmt = (sql: string) => ({
    bind: () => ({
      async run() { row.note(sql); return { meta: { last_row_id: 100, changes: 1 } }; },
      async all<T>() { return { results: [] as T[] }; },
      // The site is attached to COURSE_ID, whose markers it holds.
      async first<T>() {
        if (sql.startsWith("SELECT parent_project_id FROM projects")) return { parent_project_id: COURSE_ID } as T;
        return (row.read(sql) ?? null) as T | null;
      },
    }),
  });
  return {
    releaseBatch: () => releaseBatch(),
    batchReached,
    DB: {
      prepare: (sql: string) => stmt(sql),
      async batch() {
        batchEntered();
        await batchGate;
        if (failBatch) throw new Error("D1_BATCH_FAILED");
        return [];
      },
    },
  };
}

/**
 * A `ctx` stub that models the input gate: work handed to `deliver()` while a
 * `blockConcurrencyWhile` callback is running is queued until the gate opens.
 */
function makeGateModel(sockets: unknown[]) {
  let depth = 0;
  let maxDepth = 0;
  let faults = 0;
  const queue: Array<() => void> = [];
  const ctx = {
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      try {
        return await fn();
      } catch (err) {
        // Cloudflare terminates and resets the DO here. The count is what the
        // tests assert on; the rejection is still propagated.
        faults += 1;
        throw err;
      } finally {
        depth -= 1;
        if (depth === 0) for (const run of queue.splice(0)) run();
      }
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
  return {
    ctx,
    deliver: (fn: () => void) => { if (depth > 0) queue.push(fn); else fn(); },
    maxGateDepth: () => maxDepth,
    gateFaults: () => faults,
  };
}

function makeHarness(opts: { failBatch?: boolean } = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const gate = makeGateModel(sockets);
  const db = makeFakeDB(opts.failBatch);
  const doInstance = new ProjectCollaborationDO(
    gate.ctx as unknown as DurableObjectState,
    { DB: db.DB, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  markLoaded(doInstance);
  return { doInstance, sockets, db, ...gate };
}

function ydocOf(doInstance: ProjectCollaborationDO): Y.Doc {
  return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
}

function objectsOf(doInstance: ProjectCollaborationDO): Y.Array<Y.Map<unknown>> {
  return ydocOf(doInstance).getArray<Y.Map<unknown>>("objects");
}

function objectIds(doInstance: ProjectCollaborationDO): unknown[] {
  return objectsOf(doInstance).toArray().map((m) => m.get("object_id"));
}

function isSnapshotting(doInstance: ProjectCollaborationDO): boolean {
  return (doInstance as unknown as { isSnapshotting: boolean }).isSnapshotting;
}

/** Seed an object Y.Map DO-internally (null origin), as a preload would leave it. */
function seedObject(
  doInstance: ProjectCollaborationDO,
  spec: { objectId: string; id?: number | null; courseProjectId?: number },
): void {
  const ydoc = ydocOf(doInstance);
  ydoc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set("_id", spec.id ?? null);
    m.set("_temp_id", spec.objectId);
    m.set("_validation_state", "valid");
    m.set("object_id", spec.objectId);
    m.set("title", new Y.Text("Seeded"));
    m.set("created_by", CONVENOR);
    if (spec.courseProjectId !== undefined) {
      m.set("course_project_id", spec.courseProjectId);
    }
    ydoc.getArray<Y.Map<unknown>>("objects").push([m]);
  }, null);
}

/** The forbidden move: a client socket deleting a course-marked object. */
function deleteFirstObject(doInstance: ProjectCollaborationDO, ws: unknown): void {
  const ydoc = ydocOf(doInstance);
  ydoc.transact(() => {
    ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
  }, ws);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => { /* silence the revert log */ });
});

// ---------------------------------------------------------------------------

/** What the guard has asked the message handler to close, and has not sent. */
function stagedCloses(
  doInstance: unknown,
): Array<{ ws: unknown; code: number; reason: string }> {
  return (doInstance as {
    stagedEffects: { closes: Array<{ ws: unknown; code: number; reason: string }> };
  }).stagedEffects.closes;
}

describe("snapshot enforcement window — the periodic alarm", () => {
  it("defers a forbidden delete until the snapshot ends, and enforces it", async () => {
    const h = makeHarness();
    const convenor = fakeSocket(CONVENOR, "convenor");
    h.sockets.push(convenor);
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });

    const alarmDone = h.doInstance.alarm();
    await h.db.batchReached;
    expect(isSnapshotting(h.doInstance)).toBe(true);

    let applied = false;
    h.deliver(() => { applied = true; deleteFirstObject(h.doInstance, convenor); });
    // The gate is what closes the window: the transaction must not reach the
    // document while the snapshot's D1 awaits are outstanding.
    expect(applied).toBe(false);

    h.db.releaseBatch();
    await alarmDone;
    await tick();

    expect(applied).toBe(true);
    expect(objectIds(h.doInstance)).toEqual(["course-obj"]);
    expect(objectsOf(h.doInstance).get(0).get("course_project_id")).toBe(COURSE_ID);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reverted 1 unauthorised delete(s)"),
    );
    expect(h.maxGateDepth()).toBe(1);
  });

  it("closes the socket on the third deferred attempt", async () => {
    const h = makeHarness();
    const convenor = fakeSocket(CONVENOR, "convenor");
    h.sockets.push(convenor);
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });

    const alarmDone = h.doInstance.alarm();
    await h.db.batchReached;
    for (let i = 0; i < 3; i++) {
      h.deliver(() => deleteFirstObject(h.doInstance, convenor));
    }
    h.db.releaseBatch();
    await alarmDone;
    await tick();

    expect(objectIds(h.doInstance)).toEqual(["course-obj"]);
    // The close is STAGED: it belongs behind the write that records what the
    // document holds, and the message handler's drain issues it. These
    // deliveries drive the document directly, so the queue is where it shows.
    expect(stagedCloses(h.doInstance)).toContainEqual({
      ws: convenor,
      code: 1008,
      reason: expect.any(String),
    });
  });

  it("leaves the DO's own snapshot-time dedupe delete standing", async () => {
    // The dedupe runs null-origin inside doSnapshot; the gate must not turn the
    // DO's own writes into reverted client deletes.
    const h = makeHarness();
    h.sockets.push(fakeSocket(CONVENOR, "convenor"));
    seedObject(h.doInstance, { objectId: "dupe", id: 100, courseProjectId: COURSE_ID });
    seedObject(h.doInstance, { objectId: "dupe", id: 100, courseProjectId: COURSE_ID });
    expect(objectsOf(h.doInstance).length).toBe(2);

    const alarmDone = h.doInstance.alarm();
    await h.db.batchReached;
    h.db.releaseBatch();
    await alarmDone;
    await tick();

    expect(objectsOf(h.doInstance).length).toBe(1);
  });
});

describe("snapshot enforcement window — the hazard the gate prevents", () => {
  it("characterisation: a transaction that DOES reach the doc mid-snapshot is skipped", async () => {
    // The gate model is bypassed deliberately. This is the defect as it stands
    // without delivery blocking, and it is why the fix cannot be a change to the
    // `isSnapshotting` guards in can-delete.ts: by the time the guard runs, the
    // deletion has already been applied to the document.
    const h = makeHarness();
    const convenor = fakeSocket(CONVENOR, "convenor");
    h.sockets.push(convenor);
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });

    const alarmDone = h.doInstance.alarm();
    await h.db.batchReached;
    deleteFirstObject(h.doInstance, convenor); // not via deliver()

    expect(objectIds(h.doInstance)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    h.db.releaseBatch();
    await alarmDone;
  });

  it("regression: the same delete outside any snapshot is enforced", async () => {
    const h = makeHarness();
    const convenor = fakeSocket(CONVENOR, "convenor");
    h.sockets.push(convenor);
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });

    expect(isSnapshotting(h.doInstance)).toBe(false);
    deleteFirstObject(h.doInstance, convenor);

    expect(objectIds(h.doInstance)).toEqual(["course-obj"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reverted 1 unauthorised delete(s)"),
    );
  });
});

describe("snapshot enforcement window — forceSnapshot", () => {
  it("defers a forbidden delete until the forced snapshot ends, and enforces it", async () => {
    const h = makeHarness();
    const convenor = fakeSocket(CONVENOR, "convenor");
    h.sockets.push(convenor);
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });

    const forced = h.doInstance.forceSnapshot();
    await h.db.batchReached;

    let applied = false;
    h.deliver(() => { applied = true; deleteFirstObject(h.doInstance, convenor); });
    expect(applied).toBe(false);

    h.db.releaseBatch();
    await forced;
    await tick();

    expect(applied).toBe(true);
    expect(objectIds(h.doInstance)).toEqual(["course-obj"]);
    expect(h.maxGateDepth()).toBe(1);
  });
});

describe("snapshot enforcement window — the last-disconnect snapshot", () => {
  it("defers a delete from a socket that connects during the snapshot", async () => {
    // Zero sockets at the moment the snapshot starts is not zero sockets for its
    // duration: a reconnect lands mid-snapshot, and its first transaction would
    // be applied unenforced.
    const h = makeHarness();
    const leaving = fakeSocket(CONVENOR, "convenor");
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });

    const closed = h.doInstance.webSocketClose(leaving as unknown as WebSocket, 1000);
    await h.db.batchReached;

    const arriving = fakeSocket(CONVENOR, "convenor");
    h.sockets.push(arriving);
    let applied = false;
    h.deliver(() => { applied = true; deleteFirstObject(h.doInstance, arriving); });
    expect(applied).toBe(false);

    h.db.releaseBatch();
    await closed;
    await tick();

    expect(applied).toBe(true);
    expect(objectIds(h.doInstance)).toEqual(["course-obj"]);
    expect(h.maxGateDepth()).toBe(1);
  });
});

describe("snapshot enforcement window — a failed snapshot must not reset the DO", () => {
  // Cloudflare terminates and resets a Durable Object whose
  // blockConcurrencyWhile callback throws, so a D1 batch failure — an ordinary,
  // retried condition — must never propagate out of the callback. It is carried
  // across the gate boundary and rethrown outside, where the caller sees it
  // exactly as it did before the gate existed.

  it("alarm: the callback completes, the failure still reaches the runtime", async () => {
    const h = makeHarness({ failBatch: true });
    h.sockets.push(fakeSocket(CONVENOR, "convenor"));
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });

    const alarmDone = h.doInstance.alarm();
    await h.db.batchReached;
    h.db.releaseBatch();

    await expect(alarmDone).rejects.toThrow("D1_BATCH_FAILED");
    expect(h.gateFaults()).toBe(0);
  });

  it("forceSnapshot: the callback completes, the failure still reaches the caller", async () => {
    const h = makeHarness({ failBatch: true });
    h.sockets.push(fakeSocket(CONVENOR, "convenor"));
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });

    const forced = h.doInstance.forceSnapshot();
    await h.db.batchReached;
    h.db.releaseBatch();

    await expect(forced).rejects.toThrow("D1_BATCH_FAILED");
    expect(h.gateFaults()).toBe(0);
  });

  it("last-disconnect: the failure is swallowed and logged, as it always was", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => { /* silence */ });
    const h = makeHarness({ failBatch: true });
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });

    const closed = h.doInstance.webSocketClose(
      fakeSocket(CONVENOR, "convenor") as unknown as WebSocket, 1000,
    );
    await h.db.batchReached;
    h.db.releaseBatch();

    await expect(closed).resolves.toBeUndefined();
    expect(h.gateFaults()).toBe(0);
    expect(error).toHaveBeenCalledWith(
      "[snapshot] last-disconnect snapshot failed",
      expect.any(Error),
    );
  });
});

describe("snapshot enforcement window — deadlock canary", () => {
  it("/clear-course-markers flushes and answers without nesting the gate", async () => {
    // flushSnapshotNow is called from inside blockConcurrencyWhile here. A gate
    // pushed down into snapshotToD1/doSnapshot would nest — maxGateDepth 2 —
    // and hang the DO on every course leave.
    const h = makeHarness();
    seedObject(h.doInstance, { objectId: "course-obj", id: 100, courseProjectId: COURSE_ID });
    h.db.releaseBatch(); // no snapshot needs holding open here

    const { sigHex, timestamp } = await signInternalMarker(
      TEST_PROJECT_ID, TEST_SECRET, "clear-course-markers",
    );
    const res = await h.doInstance.fetch(new Request(
      "https://internal/clear-course-markers",
      {
        method: "POST",
        headers: {
          "X-Internal-Auth": sigHex,
          "X-Internal-Timestamp": String(timestamp),
          "X-Internal-Project": String(TEST_PROJECT_ID),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ courseProjectId: COURSE_ID }),
      },
    ));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 1 });
    expect(objectsOf(h.doInstance).get(0).get("course_project_id")).toBeUndefined();
    expect(h.maxGateDepth()).toBe(1);
  });
});

describe("the gate is entered before any await", () => {
  // The production window is closed only because nothing awaits ahead of
  // blockConcurrencyWhile at these three sites: an await there would let an
  // event be delivered before the gate is held, and every other test in this
  // file would still pass, because the stub only defers once the gate is up.
  // This reads the source rather than the behaviour, which is the only way to
  // pin an ordering the harness cannot exercise.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "workers", "collaboration.ts"),
    "utf-8",
  );

  /** Source between a signature and its gate, comments stripped. */
  function bodyBeforeGate(signature: string): string {
    const start = source.indexOf(signature);
    expect(start, `${signature} not found`).toBeGreaterThan(-1);
    const gate = source.indexOf("blockConcurrencyWhile", start);
    expect(gate, `no gate after ${signature}`).toBeGreaterThan(start);
    return source
      .slice(start + signature.length, gate)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      // Drop the gate's own `await this.ctx.` — the thing being asserted is
      // that nothing else awaits ahead of it.
      .replace(/await\s+this\.ctx\.\s*$/, "");
  }

  it.each([
    ["async alarm(alarmInfo?: AlarmInfo): Promise<void> {"],
    ["async forceSnapshot(): Promise<void> {"],
  ])("%s reaches its gate with no await before it", (signature) => {
    expect(bodyBeforeGate(signature)).not.toMatch(/\bawait\b/);
  });

  it("webSocketClose reaches its snapshot gate with no await before it", () => {
    // Its pre-gate work (attachment read, awareness cleanup, encoders, close)
    // must stay synchronous for the same reason.
    expect(bodyBeforeGate("async webSocketClose(")).not.toMatch(/\bawait\b/);
  });
});

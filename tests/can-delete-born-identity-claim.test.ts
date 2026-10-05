/**
 * A map born in a client transaction may not claim the row id of a map that
 * was already in the same protected array and is still there afterwards.
 *
 * The attack this pins issues NO delete. A collaborator inserts an unmarked
 * Y.Map ahead of the victim copying its `_id` and its human key. Identity
 * enforcement does not reach a map born inside the transaction, so nothing is
 * reverted; then the DO's pre-snapshot `deduplicateYArray` sees two maps
 * claiming one persisted row, collapses the exact-`_id` pair by keeping the
 * first, and the genuine map — course marker and all — is the one deleted.
 * No delete was issued, so no revert ran and the replacement sweep was never
 * reached.
 *
 * Scope is `_id` and nothing else, and that is the whole argument for the
 * rule's safety: `_id` is minted by the Durable Object, exactly one live map
 * per row, so a born map carrying a live map's row id has no honest author.
 * A colliding HUMAN key does — two people naming an object from the same file
 * on the same afternoon — and `deduplicateYArray` answers that one by
 * re-keying rather than deleting, so there is nothing destructive to prevent
 * and a rule reaching it would delete honest work.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: unknown; env: unknown; constructor(c: unknown, e: unknown) { this.ctx = c; this.env = e; } },
}));

import { makeCanDeleteHandler, makeViolationCounter } from "../workers/can-delete";
import { ProjectCollaborationDO } from "../workers/collaboration";

type Role = "convenor" | "collaborator" | "instructor";

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: Role };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(userId: number, role: Role): FakeWS {
  return {
    deserializeAttachment: () => ({ userId, role }),
    send: vi.fn(),
    close: vi.fn(),
  };
}

function makeHarness() {
  const ydoc = new Y.Doc();
  const state = { reverting: false, snapshotting: false };
  const warns: string[] = [];
  const violations: FakeWS[] = [];
  const halts: Array<{ userId: number; failures: readonly string[] }> = [];
  const counter = makeViolationCounter();

  const handler = makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => state.snapshotting,
    isReverting: () => state.reverting,
    setReverting: (v: boolean) => { state.reverting = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => {},
    recordViolation: (ws: WebSocket) => { violations.push(ws as unknown as FakeWS); return counter(ws); },
    warn: (msg: string) => { warns.push(msg); },
    onEnforcementFailure: (d) => { halts.push(d); },
  });
  ydoc.on("afterTransaction", handler);

  return { ydoc, warns, violations, halts };
}

/** Seed a Y.Map into a root array with a DO-internal (null) origin. */
function seed(ydoc: Y.Doc, root: string, fields: Record<string, unknown>): Y.Map<unknown> {
  const arr = ydoc.getArray<Y.Map<unknown>>(root);
  let m!: Y.Map<unknown>;
  ydoc.transact(() => {
    m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    arr.push([m]);
  }, null);
  return m;
}

function makeMap(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  return m;
}

function ids(arr: Y.Array<Y.Map<unknown>>): unknown[] {
  return arr.toArray().map((m) => m.get("_id"));
}

// ---------------------------------------------------------------------------
// The attack
// ---------------------------------------------------------------------------

describe("R3-1 — an inserted forgery claiming a live row id", () => {
  it("removes the born map and leaves the genuine one, with a strike", () => {
    const h = makeHarness();
    seed(h.ydoc, "objects", {
      _id: 42,
      object_id: "vasija",
      created_by: 1,
      course_project_id: 9,
    });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");
    const attacker = fakeSocket(2, "collaborator");

    h.ydoc.transact(() => {
      objects.insert(0, [makeMap({ _id: 42, object_id: "vasija", created_by: 2 })]);
    }, attacker);

    expect(objects.length).toBe(1);
    expect(objects.get(0).get("created_by")).toBe(1);
    expect(objects.get(0).get("course_project_id")).toBe(9);
    expect(h.violations.length).toBe(1);
    expect(h.halts).toEqual([]);
  });

  it("the DO's own dedupe then has nothing to collapse, so the course item survives", () => {
    // Without the rule this is the destructive step: `deduplicateYArray` keeps
    // the first of an exact-`_id` pair and deletes the second — the genuine,
    // marked object — and the next snapshot writes the forgery over its row.
    const h = makeHarness();
    seed(h.ydoc, "objects", {
      _id: 42,
      object_id: "vasija",
      created_by: 1,
      course_project_id: 9,
    });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      objects.insert(0, [makeMap({ _id: 42, object_id: "vasija", created_by: 2 })]);
    }, fakeSocket(2, "collaborator"));

    const dedupe = makeDedupe(h.ydoc);
    dedupe("objects", "object_id", new Map([["vasija", 42]]));

    expect(objects.length).toBe(1);
    expect(objects.get(0).get("created_by")).toBe(1);
    expect(objects.get(0).get("course_project_id")).toBe(9);
  });

  it("catches the same shape on a nested steps array", () => {
    const h = makeHarness();
    const story = seed(h.ydoc, "stories", { _id: 1, story_id: "s", created_by: 1 });
    let steps!: Y.Array<Y.Map<unknown>>;
    h.ydoc.transact(() => {
      steps = new Y.Array<Y.Map<unknown>>();
      steps.push([makeMap({ _id: 77, created_by: 1 })]);
      story.set("steps", steps);
    }, null);

    h.ydoc.transact(() => {
      steps.insert(0, [makeMap({ _id: 77, created_by: 2 })]);
    }, fakeSocket(2, "collaborator"));

    expect(steps.length).toBe(1);
    expect(steps.get(0).get("created_by")).toBe(1);
    expect(h.violations.length).toBe(1);
  });

  it("catches a convenor doing it, where no snapshot is taken", () => {
    const h = makeHarness();
    seed(h.ydoc, "objects", { _id: 42, object_id: "vasija", created_by: 1 });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      objects.insert(0, [makeMap({ _id: 42, object_id: "vasija", created_by: 3 })]);
    }, fakeSocket(3, "convenor"));

    expect(objects.length).toBe(1);
    expect(objects.get(0).get("created_by")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The legitimate shapes the rule must not touch
// ---------------------------------------------------------------------------

describe("legitimate inserts stay legitimate", () => {
  it("an ordinary new object (_id null) is untouched", () => {
    const h = makeHarness();
    seed(h.ydoc, "objects", { _id: 42, object_id: "vasija", created_by: 1 });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      objects.push([makeMap({ _id: null, _temp_id: "uuid-new", object_id: "nuevo", created_by: 2 })]);
    }, fakeSocket(2, "collaborator"));

    expect(objects.length).toBe(2);
    expect(h.violations).toEqual([]);
  });

  it("two unsaved maps sharing a human key are left for the dedupe to re-key", () => {
    // Honest concurrent creation. `deduplicateYArray` re-keys the loser; it
    // never deletes on a human-key collision, so there is nothing to prevent.
    const h = makeHarness();
    seed(h.ydoc, "objects", { _id: null, object_id: "vasija", created_by: 1 });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      objects.push([makeMap({ _id: null, object_id: "vasija", created_by: 2 })]);
    }, fakeSocket(2, "collaborator"));

    expect(objects.length).toBe(2);
    expect(h.violations).toEqual([]);
  });

  it("a born map may carry a human key a live saved map holds", () => {
    const h = makeHarness();
    seed(h.ydoc, "objects", { _id: 42, object_id: "vasija", created_by: 1 });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      objects.push([makeMap({ _id: null, object_id: "vasija", created_by: 2 })]);
    }, fakeSocket(2, "collaborator"));

    expect(objects.length).toBe(2);
    expect(h.violations).toEqual([]);
  });

  it("a faithful reorder built with a clone is untouched — the twin is deleted here", () => {
    const h = makeHarness();
    seed(h.ydoc, "objects", { _id: 42, object_id: "one", created_by: 7 });
    seed(h.ydoc, "objects", { _id: 43, object_id: "two", created_by: 7 });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      const clone = makeMap({ _id: 43, object_id: "two", created_by: 7 });
      objects.delete(1, 1);
      objects.insert(0, [clone]);
    }, fakeSocket(7, "collaborator"));

    expect(ids(objects)).toEqual([43, 42]);
    expect(h.violations).toEqual([]);
  });

  it("an undo of a delete restores a map carrying its original _id", () => {
    const h = makeHarness();
    const client = new Y.Doc();
    const undo = new Y.UndoManager([client.getArray("objects")], {
      captureTimeout: 0,
      trackedOrigins: new Set([null]),
    });
    const ws = fakeSocket(7, "collaborator");
    const pump = (from: Y.Doc, to: Y.Doc, origin: unknown) =>
      Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), origin);

    client.transact(() => {
      client.getArray<Y.Map<unknown>>("objects").push([
        makeMap({ _id: null, _temp_id: "uuid-1", object_id: "mine", created_by: 7 }),
      ]);
    }, null);
    pump(client, h.ydoc, ws);

    h.ydoc.transact(() => { h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).set("_id", 42); }, null);
    pump(h.ydoc, client, "provider");

    client.transact(() => { client.getArray("objects").delete(0, 1); }, null);
    pump(client, h.ydoc, ws);
    expect(h.ydoc.getArray("objects").length).toBe(0);

    undo.undo();
    pump(client, h.ydoc, ws);

    const restored = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(restored.length).toBe(1);
    expect(restored.get(0).get("_id")).toBe(42);
    expect(h.violations).toEqual([]);
  });

  it("a restore-from-orphans insert carrying a row id no live map holds is untouched", () => {
    const h = makeHarness();
    seed(h.ydoc, "objects", { _id: 42, object_id: "vasija", created_by: 1 });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      objects.push([makeMap({ _id: 99, object_id: "recuperado", created_by: 2 })]);
    }, fakeSocket(2, "collaborator"));

    expect(objects.length).toBe(2);
    expect(h.violations).toEqual([]);
  });

  it("the DO's own null-origin inserts are exempt", () => {
    const h = makeHarness();
    seed(h.ydoc, "objects", { _id: 42, object_id: "vasija", created_by: 1 });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      objects.insert(0, [makeMap({ _id: 42, object_id: "vasija", created_by: 1 })]);
    }, null);

    expect(objects.length).toBe(2);
    expect(h.violations).toEqual([]);
  });

  it("an insert into an unprotected array is untouched", () => {
    const h = makeHarness();
    const nav = h.ydoc.getArray<Y.Map<unknown>>("nav");
    h.ydoc.transact(() => { nav.push([makeMap({ _id: 42 })]); }, null);

    h.ydoc.transact(() => {
      nav.insert(0, [makeMap({ _id: 42 })]);
    }, fakeSocket(2, "collaborator"));

    expect(nav.length).toBe(2);
    expect(h.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Harness for the DO's own dedupe
// ---------------------------------------------------------------------------

function makeDedupe(ydoc: Y.Doc) {
  const ctx = {
    getWebSockets: () => [],
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
  const env = { DB: {} as unknown, SESSION_SECRET: "s", COLLABORATION: {} as unknown };
  const d = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  ) as unknown as {
    ydoc: Y.Doc;
    deduplicateYArray: (
      arrayName: string,
      entityKey: string,
      d1KeyToId?: ReadonlyMap<string, number>,
    ) => boolean;
  };
  d.ydoc = ydoc;
  return d.deduplicateYArray.bind(d);
}

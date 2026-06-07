/**
 * Pins the server-side deduplication of nested `steps` (and `layers`) arrays
 * inside each story's Y.Map.
 *
 * Background: `reorderInPlace` on the client is clone-delete-insert, which
 * is not CRDT-safe. Two collaborators reordering the same step concurrently
 * can leave two Y.Maps sharing the same `_id` in the story's `steps` array.
 * `deduplicateNestedStepArrays` heals this on every snapshot, mirroring the
 * top-level `deduplicateYArray` calls for stories/objects/glossary/pages.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

// Mock cloudflare:workers so the DO class loads in Node.
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

// ---------------------------------------------------------------------------
// Minimal DO harness (no D1, no sockets needed)
// ---------------------------------------------------------------------------

function makeMinimalDO() {
  const ctx = {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    acceptWebSocket: vi.fn(),
  };
  const env = {
    DB: {} as unknown,
    SESSION_SECRET: "test-secret",
    COLLABORATION: {} as unknown,
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  return { doInstance, ydoc };
}

/** Call the private deduplicateNestedStepArrays via type-cast. */
function runDedup(doInstance: ProjectCollaborationDO): void {
  (
    doInstance as unknown as {
      deduplicateNestedStepArrays: () => void;
    }
  ).deduplicateNestedStepArrays();
}

/** Build a step Y.Map with the given _id (or null for a pending step). */
function makeStepMap(id: number | null): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", id);
  m.set("layers", new Y.Array<Y.Map<unknown>>());
  return m;
}

/** Build a layer Y.Map with the given _id. */
function makeLayerMap(id: number | null): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", id);
  return m;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deduplicateNestedStepArrays — step deduplication", () => {
  it("removes the duplicate step when two steps share the same _id", () => {
    const { doInstance, ydoc } = makeMinimalDO();
    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const storyMap = new Y.Map<unknown>();
      const stepsArr = new Y.Array<Y.Map<unknown>>();
      // Two steps with the same _id:5 (simulates concurrent reorder clash)
      stepsArr.push([makeStepMap(5), makeStepMap(5), makeStepMap(7)]);
      storyMap.set("_id", 1);
      storyMap.set("steps", stepsArr);
      storiesArr.push([storyMap]);
    });

    // Pre-fix: expects two steps with _id:5 → test should fail before fix
    const stepsBeforeDedup = (
      storiesArr.get(0).get("steps") as Y.Array<Y.Map<unknown>>
    );
    expect(stepsBeforeDedup.length).toBe(3);

    runDedup(doInstance);

    const stepsAfter = (
      storiesArr.get(0).get("steps") as Y.Array<Y.Map<unknown>>
    );
    expect(stepsAfter.length).toBe(2);

    // The remaining _id values must be [5, 7] in that order (first occurrence wins)
    const ids = Array.from({ length: stepsAfter.length }, (_, i) =>
      stepsAfter.get(i).get("_id"),
    );
    expect(ids).toEqual([5, 7]);
  });

  it("does NOT remove steps that have no _id (pending new steps must survive)", () => {
    const { doInstance, ydoc } = makeMinimalDO();
    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const storyMap = new Y.Map<unknown>();
      const stepsArr = new Y.Array<Y.Map<unknown>>();
      // Two null-_id steps (distinct pending inserts) plus one with an id
      stepsArr.push([makeStepMap(null), makeStepMap(null), makeStepMap(3)]);
      storyMap.set("_id", 1);
      storyMap.set("steps", stepsArr);
      storiesArr.push([storyMap]);
    });

    runDedup(doInstance);

    const stepsAfter = (
      storiesArr.get(0).get("steps") as Y.Array<Y.Map<unknown>>
    );
    // Both null-_id steps must remain; only real _id duplication is healed
    expect(stepsAfter.length).toBe(3);
  });

  it("leaves a story untouched when there are no duplicate step _ids", () => {
    const { doInstance, ydoc } = makeMinimalDO();
    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const storyMap = new Y.Map<unknown>();
      const stepsArr = new Y.Array<Y.Map<unknown>>();
      stepsArr.push([makeStepMap(1), makeStepMap(2), makeStepMap(3)]);
      storyMap.set("_id", 10);
      storyMap.set("steps", stepsArr);
      storiesArr.push([storyMap]);
    });

    runDedup(doInstance);

    const stepsAfter = (
      storiesArr.get(0).get("steps") as Y.Array<Y.Map<unknown>>
    );
    expect(stepsAfter.length).toBe(3);
  });

  it("handles multiple stories independently", () => {
    const { doInstance, ydoc } = makeMinimalDO();
    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      // Story A: has a duplicate step _id:2
      const storyA = new Y.Map<unknown>();
      const stepsA = new Y.Array<Y.Map<unknown>>();
      stepsA.push([makeStepMap(2), makeStepMap(2), makeStepMap(4)]);
      storyA.set("_id", 1);
      storyA.set("steps", stepsA);

      // Story B: clean — no duplicates
      const storyB = new Y.Map<unknown>();
      const stepsB = new Y.Array<Y.Map<unknown>>();
      stepsB.push([makeStepMap(10), makeStepMap(11)]);
      storyB.set("_id", 2);
      storyB.set("steps", stepsB);

      storiesArr.push([storyA, storyB]);
    });

    runDedup(doInstance);

    const stepsA = storiesArr.get(0).get("steps") as Y.Array<Y.Map<unknown>>;
    const stepsB = storiesArr.get(1).get("steps") as Y.Array<Y.Map<unknown>>;

    // Story A: duplicate healed
    expect(stepsA.length).toBe(2);
    const idsA = Array.from({ length: stepsA.length }, (_, i) => stepsA.get(i).get("_id"));
    expect(idsA).toEqual([2, 4]);

    // Story B: untouched
    expect(stepsB.length).toBe(2);
  });
});

describe("deduplicateNestedStepArrays — layer deduplication", () => {
  it("removes the duplicate layer when two layers in a step share the same _id", () => {
    const { doInstance, ydoc } = makeMinimalDO();
    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const storyMap = new Y.Map<unknown>();
      const stepsArr = new Y.Array<Y.Map<unknown>>();

      const stepMap = new Y.Map<unknown>();
      stepMap.set("_id", 1);
      const layersArr = new Y.Array<Y.Map<unknown>>();
      // Two layers with duplicate _id:20, plus a distinct _id:21
      layersArr.push([makeLayerMap(20), makeLayerMap(20), makeLayerMap(21)]);
      stepMap.set("layers", layersArr);

      stepsArr.push([stepMap]);
      storyMap.set("_id", 1);
      storyMap.set("steps", stepsArr);
      storiesArr.push([storyMap]);
    });

    runDedup(doInstance);

    const step = (
      storiesArr.get(0).get("steps") as Y.Array<Y.Map<unknown>>
    ).get(0);
    const layersAfter = step.get("layers") as Y.Array<Y.Map<unknown>>;

    expect(layersAfter.length).toBe(2);
    const ids = Array.from({ length: layersAfter.length }, (_, i) =>
      layersAfter.get(i).get("_id"),
    );
    expect(ids).toEqual([20, 21]);
  });

  it("does NOT remove layers that have no _id (pending new layers must survive)", () => {
    const { doInstance, ydoc } = makeMinimalDO();
    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const storyMap = new Y.Map<unknown>();
      const stepsArr = new Y.Array<Y.Map<unknown>>();

      const stepMap = new Y.Map<unknown>();
      stepMap.set("_id", 1);
      const layersArr = new Y.Array<Y.Map<unknown>>();
      // Two null-_id layers — both must survive
      layersArr.push([makeLayerMap(null), makeLayerMap(null), makeLayerMap(5)]);
      stepMap.set("layers", layersArr);

      stepsArr.push([stepMap]);
      storyMap.set("_id", 1);
      storyMap.set("steps", stepsArr);
      storiesArr.push([storyMap]);
    });

    runDedup(doInstance);

    const layersAfter = (
      (storiesArr.get(0).get("steps") as Y.Array<Y.Map<unknown>>)
        .get(0)
        .get("layers") as Y.Array<Y.Map<unknown>>
    );
    expect(layersAfter.length).toBe(3);
  });
});

/**
 * collaboration-can-delete.test.ts — server-side canDelete enforcement.
 *
 * Tests the `makeCanDeleteHandler` factory from `workers/can-delete.ts`
 * against the cases mandated by the test plan and verification rules:
 *
 *   1. Collaborator cannot delete convenor's story
 *   2. Collaborator can delete their own story (legitimate self-delete)
 *   3. Convenor can delete any story (convenor bypass)
 *   4. Reorder is not classified as unauthorised delete
 *   5. Cascade delete (story -> steps -> layers) is single-authorised
 *   6. Nested-array deletion (layer inside step inside story) is enforced
 *   7. Unauthorised delete on every protected root is reverted
 *   8. DO-internal transactions (null/string origin) are not classified
 *   9. Reverting transaction does not recurse on its own afterTransaction fire
 *  10. Three unauthorised deletes within 60s close the socket cleanly
 *
 * The handler runs against a real Y.Doc with synthetic WebSocket origins
 * (objects exposing `deserializeAttachment`). No DurableObject runtime is
 * required. This mirrors the harness pattern in
 * tests/snapshot-insert-delete.test.ts (A2 verification test).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  getUserContext,
  identityKeyFor,
  isProtectedParentArray,
  classifyParentArray,
  makeCanDeleteHandler,
  makeViolationCounter,
  extractUnauthorisedDeletes,
  readKeyAtSnapshot,
  PROTECTED_ROOT_NAMES,
} from "../workers/can-delete";

// ---------------------------------------------------------------------------
// Harness — synthetic WebSocket origins, doc bootstrapping, dispatch helpers
// ---------------------------------------------------------------------------

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: "convenor" | "collaborator" };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(userId: number, role: "convenor" | "collaborator"): FakeWS {
  return {
    deserializeAttachment: () => ({ userId, role }),
    send: vi.fn(),
    close: vi.fn(),
  };
}

interface Harness {
  ydoc: Y.Doc;
  sockets: FakeWS[];
  isReverting: { value: boolean };
  isSnapshotting: { value: boolean };
  warns: string[];
  installHandler: () => void;
  recordViolation: (ws: WebSocket) => boolean;
}

function makeHarness(): Harness {
  const ydoc = new Y.Doc();
  const sockets: FakeWS[] = [];
  const isReverting = { value: false };
  const isSnapshotting = { value: false };
  const warns: string[] = [];
  const recordViolation = makeViolationCounter();

  const installHandler = () => {
    const handler = makeCanDeleteHandler({
      ydoc,
      isSnapshotting: () => isSnapshotting.value,
      isReverting: () => isReverting.value,
      setReverting: (v: boolean) => { isReverting.value = v; },
      getSockets: () => sockets as unknown as Iterable<WebSocket>,
      broadcastUpdate: (msg: Uint8Array) => {
        for (const ws of sockets) ws.send(msg);
      },
      recordViolation,
      warn: (msg: string) => { warns.push(msg); },
    });
    ydoc.on("afterTransaction", handler);
  };

  return { ydoc, sockets, isReverting, isSnapshotting, warns, installHandler, recordViolation };
}

/**
 * Seed a story Y.Map into the doc (origin: null, simulating server cold-start
 * or convenor bootstrapping). Returns the inserted Y.Map.
 */
function seedStory(ydoc: Y.Doc, opts: { createdBy: number; tempId: string; title?: string }): Y.Map<unknown> {
  const stories = ydoc.getArray<Y.Map<unknown>>("stories");
  let storyMap!: Y.Map<unknown>;
  ydoc.transact(() => {
    storyMap = new Y.Map<unknown>();
    storyMap.set("_id", null);
    storyMap.set("_temp_id", opts.tempId);
    storyMap.set("created_by", opts.createdBy);
    storyMap.set("title", new Y.Text(opts.title ?? `story-${opts.tempId}`));
    storyMap.set("steps", new Y.Array<Y.Map<unknown>>());
    stories.push([storyMap]);
  }, null);
  return storyMap;
}

/**
 * Seed a step inside a story's "steps" Y.Array.
 */
function seedStep(storyMap: Y.Map<unknown>, opts: { createdBy: number; tempId: string }): Y.Map<unknown> {
  const steps = storyMap.get("steps") as Y.Array<Y.Map<unknown>>;
  const ydoc = storyMap.doc!;
  let stepMap!: Y.Map<unknown>;
  ydoc.transact(() => {
    stepMap = new Y.Map<unknown>();
    stepMap.set("_id", null);
    stepMap.set("_temp_id", opts.tempId);
    stepMap.set("created_by", opts.createdBy);
    stepMap.set("layers", new Y.Array<Y.Map<unknown>>());
    steps.push([stepMap]);
  }, null);
  return stepMap;
}

/**
 * Seed a layer inside a step's "layers" Y.Array.
 */
function seedLayer(stepMap: Y.Map<unknown>, opts: { createdBy: number; tempId: string }): Y.Map<unknown> {
  const layers = stepMap.get("layers") as Y.Array<Y.Map<unknown>>;
  const ydoc = stepMap.doc!;
  let layerMap!: Y.Map<unknown>;
  ydoc.transact(() => {
    layerMap = new Y.Map<unknown>();
    layerMap.set("_id", null);
    layerMap.set("_temp_id", opts.tempId);
    layerMap.set("created_by", opts.createdBy);
    stepMap; // satisfy linter — closure ref
    layers.push([layerMap]);
  }, null);
  return layerMap;
}

/**
 * Run a transaction with a fake WebSocket as origin — mirrors what
 * y-protocols' readSyncMessage does internally when applying a client update.
 */
function asUser(ydoc: Y.Doc, ws: FakeWS, fn: () => void): void {
  ydoc.transact(fn, ws);
}

// ---------------------------------------------------------------------------
// Pure helper unit tests — sanity checks before the integration tests
// ---------------------------------------------------------------------------

describe("getUserContext", () => {
  it("returns null for a null origin", () => {
    expect(getUserContext(null)).toBeNull();
    expect(getUserContext(undefined)).toBeNull();
  });

  it("returns null for a non-object origin (string marker)", () => {
    expect(getUserContext("do-revert-unauthorised-delete")).toBeNull();
  });

  it("returns null for an origin without deserializeAttachment", () => {
    expect(getUserContext({})).toBeNull();
  });

  it("returns null when deserializeAttachment throws", () => {
    const ws = { deserializeAttachment: () => { throw new Error("boom"); } };
    expect(getUserContext(ws)).toBeNull();
  });

  it("returns userId + role for a valid attachment", () => {
    const ws = fakeSocket(7, "collaborator");
    expect(getUserContext(ws)).toEqual({ userId: 7, role: "collaborator" });
  });

  it("returns null for a malformed role", () => {
    const ws = { deserializeAttachment: () => ({ userId: 7, role: "owner" as unknown as "convenor" }) };
    expect(getUserContext(ws)).toBeNull();
  });
});

describe("identityKeyFor", () => {
  it("prefers _temp_id when present", () => {
    const m = new Y.Map<unknown>();
    new Y.Doc().getArray("x").push([m]);
    m.set("_temp_id", "abc");
    m.set("_id", 5);
    expect(identityKeyFor(m)).toBe("t:abc");
  });

  it("falls back to _id when _temp_id is missing", () => {
    const m = new Y.Map<unknown>();
    new Y.Doc().getArray("x").push([m]);
    m.set("_id", 5);
    expect(identityKeyFor(m)).toBe("i:5");
  });

  it("falls back to a content fingerprint when both are missing", () => {
    const m = new Y.Map<unknown>();
    new Y.Doc().getArray("x").push([m]);
    m.set("created_by", 9);
    expect(identityKeyFor(m).startsWith("c:9:")).toBe(true);
  });
});

describe("classifyParentArray + isProtectedParentArray", () => {
  it("classifies a root Y.Array by its registered name", () => {
    const ydoc = new Y.Doc();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    expect(classifyParentArray(stories, ydoc)).toEqual({ kind: "root", name: "stories" });
    expect(isProtectedParentArray(stories, ydoc)).toBe(true);
  });

  it("classifies a nested Y.Array by its parent-key", () => {
    const ydoc = new Y.Doc();
    const story = seedStory(ydoc, { createdBy: 1, tempId: "s1" });
    const steps = story.get("steps") as Y.Array<Y.Map<unknown>>;
    expect(classifyParentArray(steps, ydoc)).toEqual({ kind: "nested", key: "steps" });
    expect(isProtectedParentArray(steps, ydoc)).toBe(true);
  });

  it("returns false for a non-protected root", () => {
    const ydoc = new Y.Doc();
    const config = ydoc.getMap("config");
    config; // satisfy lint
    const navigation = ydoc.getArray("navigation"); // not in PROTECTED_ROOT_NAMES
    expect(isProtectedParentArray(navigation, ydoc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractUnauthorisedDeletes — pure analysis pass
// ---------------------------------------------------------------------------

describe("extractUnauthorisedDeletes", () => {
  it("returns empty for convenor regardless of created_by", () => {
    const ydoc = new Y.Doc();
    seedStory(ydoc, { createdBy: 99, tempId: "s1" });
    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 1, role: "convenor" });
    });
    const ws = fakeSocket(1, "convenor");
    asUser(ydoc, ws, () => {
      ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });
    expect(captured).toEqual([]);
  });

  it("returns empty for collaborator deleting their own item", () => {
    const ydoc = new Y.Doc();
    seedStory(ydoc, { createdBy: 5, tempId: "s1" });
    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 5, role: "collaborator" }, snap);
    });
    const ws = fakeSocket(5, "collaborator");
    asUser(ydoc, ws, () => {
      ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });
    expect(captured).toEqual([]);
  });

  it("returns one entry for collaborator deleting someone else's item", () => {
    const ydoc = new Y.Doc();
    seedStory(ydoc, { createdBy: 99, tempId: "s1" });
    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    let capturedCreatedBy: unknown = undefined;
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    // Yjs runs GC AFTER afterTransaction returns; reading the snapshot value
    // must therefore happen inside the callback, before the deferred GC pass
    // wipes the _map entries.
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 5, role: "collaborator" }, snap);
      if (captured.length > 0 && snap) {
        capturedCreatedBy = readKeyAtSnapshot(captured[0].deletedMap, "created_by", snap);
      }
    });
    const ws = fakeSocket(5, "collaborator");
    asUser(ydoc, ws, () => {
      ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });
    expect(captured.length).toBe(1);
    expect(capturedCreatedBy).toBe(99);
  });

  it("does not classify a reorder as unauthorised", () => {
    // Seed two convenor-owned stories. Collaborator reorders them via
    // delete+insert in the same transaction — must not trip enforcement.
    const ydoc = new Y.Doc();
    seedStory(ydoc, { createdBy: 99, tempId: "s1" });
    seedStory(ydoc, { createdBy: 99, tempId: "s2" });
    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 5, role: "collaborator" }, snap);
    });
    const ws = fakeSocket(5, "collaborator");
    asUser(ydoc, ws, () => {
      const stories = ydoc.getArray<Y.Map<unknown>>("stories");
      // Clone the first story, delete it, re-insert at position 1.
      const orig = stories.get(0);
      const clone = new Y.Map<unknown>();
      clone.set("_id", orig.get("_id"));
      clone.set("_temp_id", orig.get("_temp_id"));
      clone.set("created_by", orig.get("created_by"));
      clone.set("title", new Y.Text((orig.get("title") as Y.Text).toString()));
      clone.set("steps", new Y.Array<Y.Map<unknown>>());
      stories.delete(0, 1);
      stories.insert(0, [clone]);
    });
    expect(captured).toEqual([]);
  });

  it("reverts a delete-and-clone where the clone's created_by is forged", () => {
    // A malicious collaborator deletes a convenor-owned story and
    // inserts a new Y.Map with the SAME `_temp_id` but a DIFFERENT
    // `created_by` (the collaborator's own id). The current code path treats
    // this as a reorder because the inserted identity matches; the fix must
    // tighten the check to compare `created_by` between the deleted item
    // (snapshot read) and the inserted clone (live read).
    const ydoc = new Y.Doc();
    seedStory(ydoc, { createdBy: 99, tempId: "s1", title: "Original" });
    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    let capturedDeletedCreatedBy: unknown = undefined;
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 5, role: "collaborator" }, snap);
      if (captured.length > 0 && snap) {
        capturedDeletedCreatedBy = readKeyAtSnapshot(captured[0].deletedMap, "created_by", snap);
      }
    });
    const ws = fakeSocket(5, "collaborator");
    asUser(ydoc, ws, () => {
      const stories = ydoc.getArray<Y.Map<unknown>>("stories");
      // Forge a clone: same _temp_id, but created_by points at the attacker.
      const forged = new Y.Map<unknown>();
      forged.set("_id", null);
      forged.set("_temp_id", "s1");
      forged.set("created_by", 5); // forged — was 99
      forged.set("title", new Y.Text("Hijacked"));
      forged.set("steps", new Y.Array<Y.Map<unknown>>());
      stories.delete(0, 1);
      stories.insert(0, [forged]);
    });
    expect(captured.length).toBe(1);
    expect(capturedDeletedCreatedBy).toBe(99);
  });

  it("treats cascade child deletes as inheriting the parent's authorisation", () => {
    // Collaborator deletes their OWN story which contains a step created by
    // the convenor (collaborative editing). Cascade: the step is implicitly
    // deleted with its story. The handler should see ONE delete (the story)
    // and treat the cascade child as authorised by inheritance.
    const ydoc = new Y.Doc();
    const story = seedStory(ydoc, { createdBy: 5, tempId: "s1" });
    seedStep(story, { createdBy: 99, tempId: "step-1" }); // convenor-owned

    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 5, role: "collaborator" }, snap);
    });
    const ws = fakeSocket(5, "collaborator");
    asUser(ydoc, ws, () => {
      ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });
    expect(captured).toEqual([]); // story is collaborator's own; cascade inherits
  });
});

// ---------------------------------------------------------------------------
// makeCanDeleteHandler — integration tests with the full handler wired up
// ---------------------------------------------------------------------------

describe("makeCanDeleteHandler — mandatory cases", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
  });

  it("(1) reverts a collaborator's delete of a convenor-owned story", () => {
    const h = makeHarness();
    const conv = fakeSocket(1, "convenor");
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(conv, collab);
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-conv" });
    seedStory(h.ydoc, { createdBy: 2, tempId: "s-collab" });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });

    const stories = h.ydoc.getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(2);
    // The reinserted clone must carry the original created_by and _temp_id.
    expect(stories.get(0).get("created_by")).toBe(1);
    expect(stories.get(0).get("_temp_id")).toBe("s-conv");
    expect(stories.get(1).get("_temp_id")).toBe("s-collab");
    // Broadcast was sent to all connected sockets.
    expect(conv.send).toHaveBeenCalledTimes(1);
    expect(collab.send).toHaveBeenCalledTimes(1);
    expect(h.warns.length).toBe(1);
    expect(h.warns[0]).toMatch(/reverted 1 unauthorised/);
  });

  it("(2) allows a collaborator to delete their own story", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-conv" });
    seedStory(h.ydoc, { createdBy: 2, tempId: "s-collab" });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(1, 1);
    });

    expect(h.ydoc.getArray<Y.Map<unknown>>("stories").length).toBe(1);
    expect(h.ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("_temp_id")).toBe("s-conv");
    expect(collab.send).not.toHaveBeenCalled();
    expect(h.warns).toEqual([]);
  });

  it("(3) allows a convenor to delete any story (convenor bypass)", () => {
    const h = makeHarness();
    const conv = fakeSocket(1, "convenor");
    h.sockets.push(conv);
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-conv" });
    seedStory(h.ydoc, { createdBy: 2, tempId: "s-collab" });
    h.installHandler();

    asUser(h.ydoc, conv, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(1, 1);
    });

    expect(h.ydoc.getArray<Y.Map<unknown>>("stories").length).toBe(1);
    expect(h.ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("_temp_id")).toBe("s-conv");
    expect(conv.send).not.toHaveBeenCalled();
    expect(h.warns).toEqual([]);
  });
});

describe("makeCanDeleteHandler — additional cases", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
  });

  it("(4) reorder by collaborator on convenor-owned items is not classified as delete", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-a" });
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-b" });
    h.installHandler();

    // Reorder: take story at index 0, move it to index 1 via clone+delete+insert.
    asUser(h.ydoc, collab, () => {
      const stories = h.ydoc.getArray<Y.Map<unknown>>("stories");
      const orig = stories.get(0);
      const clone = new Y.Map<unknown>();
      clone.set("_id", orig.get("_id"));
      clone.set("_temp_id", orig.get("_temp_id"));
      clone.set("created_by", orig.get("created_by"));
      clone.set("title", new Y.Text((orig.get("title") as Y.Text).toString()));
      clone.set("steps", new Y.Array<Y.Map<unknown>>());
      stories.delete(0, 1);
      stories.insert(0, [clone]);
    });

    expect(h.ydoc.getArray<Y.Map<unknown>>("stories").length).toBe(2);
    expect(h.warns).toEqual([]);
    expect(collab.send).not.toHaveBeenCalled();
  });

  it("(5) cascade — collaborator deletes own story, convenor-owned children pass with parent", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    const story = seedStory(h.ydoc, { createdBy: 2, tempId: "s-collab" });
    seedStep(story, { createdBy: 1, tempId: "step-1" });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });

    expect(h.ydoc.getArray<Y.Map<unknown>>("stories").length).toBe(0);
    expect(h.warns).toEqual([]);
  });

  it("(6) reverts a collaborator's delete of a convenor-owned LAYER (nested array)", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    const story = seedStory(h.ydoc, { createdBy: 2, tempId: "s-collab" });
    const step = seedStep(story, { createdBy: 2, tempId: "step-1" });
    seedLayer(step, { createdBy: 1, tempId: "layer-1" }); // convenor-owned layer
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      const layers = step.get("layers") as Y.Array<Y.Map<unknown>>;
      layers.delete(0, 1);
    });

    const layers = step.get("layers") as Y.Array<Y.Map<unknown>>;
    expect(layers.length).toBe(1);
    expect(layers.get(0).get("created_by")).toBe(1);
    expect(layers.get(0).get("_temp_id")).toBe("layer-1");
    expect(h.warns.length).toBe(1);
  });

  it("(7) all six protected roots: stories, objects, glossary, pages each enforce", () => {
    // Parameterised over the four root-level protected names. Steps/layers
    // are covered by case (6) above (they are nested arrays).
    for (const rootName of PROTECTED_ROOT_NAMES) {
      const h = makeHarness();
      const collab = fakeSocket(2, "collaborator");
      h.sockets.push(collab);
      const root = h.ydoc.getArray<Y.Map<unknown>>(rootName);
      const m = new Y.Map<unknown>();
      m.set("_temp_id", `${rootName}-1`);
      m.set("created_by", 1); // owned by convenor
      h.ydoc.transact(() => { root.push([m]); }, null);
      h.installHandler();

      asUser(h.ydoc, collab, () => { root.delete(0, 1); });

      expect(root.length).toBe(1);
      expect(h.warns.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("(8) DO-internal transactions (null origin) do not trigger the handler", () => {
    const h = makeHarness();
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-conv" });
    h.installHandler();

    // Snapshot-driven cleanup uses null origin and should pass through.
    h.ydoc.transact(() => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    }, null);

    expect(h.ydoc.getArray<Y.Map<unknown>>("stories").length).toBe(0);
    expect(h.warns).toEqual([]);
  });

  it("(9) revert transaction does not re-trigger the handler (isReverting guard)", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-conv" });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });

    // Exactly one warn line — the revert transaction itself must not have
    // produced a second classification pass.
    expect(h.warns.length).toBe(1);
    expect(h.ydoc.getArray<Y.Map<unknown>>("stories").length).toBe(1);
  });

  it("(10) three unauthorised deletes within 60s close the socket cleanly with code 1008", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-1" });
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-2" });
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-3" });
    h.installHandler();

    // Three unauthorised deletes in rapid succession.
    for (let i = 0; i < 3; i++) {
      asUser(h.ydoc, collab, () => {
        h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
      });
    }

    expect(collab.close).toHaveBeenCalledWith(1008, "Repeated unauthorised delete attempts");
    expect(h.warns.length).toBe(3);
    expect(h.warns[2]).toMatch(/closing socket/);
  });

  it("first two violations within 60s do NOT close the socket", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-1" });
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-2" });
    h.installHandler();

    for (let i = 0; i < 2; i++) {
      asUser(h.ydoc, collab, () => {
        h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
      });
    }

    expect(collab.close).not.toHaveBeenCalled();
    expect(h.warns.length).toBe(2);
    expect(h.warns[0]).not.toMatch(/closing socket/);
    expect(h.warns[1]).not.toMatch(/closing socket/);
  });
});

describe("makeViolationCounter — sliding-window semantics", () => {
  it("returns false for the first VIOLATION_THRESHOLD-1 records", () => {
    const ws = fakeSocket(1, "collaborator") as unknown as WebSocket;
    const rec = makeViolationCounter(3, 60_000, () => 1000);
    expect(rec(ws)).toBe(false);
    expect(rec(ws)).toBe(false);
    expect(rec(ws)).toBe(true);
  });

  it("expires entries outside the window", () => {
    const ws = fakeSocket(1, "collaborator") as unknown as WebSocket;
    let now = 0;
    const rec = makeViolationCounter(3, 60_000, () => now);
    now = 0; rec(ws);
    now = 30_000; rec(ws);
    // Two records so far → not closing.
    now = 70_000; // first record (t=0) is 70s old, dropped.
    expect(rec(ws)).toBe(false);
    now = 71_000;
    // Now we have records at t=30_000, t=70_000, t=71_000 → 3 within last 60s.
    expect(rec(ws)).toBe(true);
  });
});

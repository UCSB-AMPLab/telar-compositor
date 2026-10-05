/**
 * This file pins server-side `canDelete` enforcement — the worker check
 * that decides which collaborators are allowed to remove which Yjs
 * structures from a project's shared doc.
 *
 * Tests the `makeCanDeleteHandler` factory from `workers/can-delete.ts`
 * against the cases mandated by the test plan and verification rules:
 *
 *   1. Collaborator cannot delete convenor's story
 *   2. Collaborator can delete their own story (legitimate self-delete)
 *   3. Convenor can delete any story (convenor bypass)
 *   4. A delete-and-reinsert IS classified as an unauthorised delete; exempting
 *      it as a possible reorder would be a hole (see the note below)
 *   5. Cascade delete (story -> steps -> layers) is single-authorised
 *   6. Nested-array deletion (layer inside step inside story) is enforced
 *   7. Unauthorised delete on every protected root is reverted
 *   8. DO-internal transactions (null/string origin) are not classified
 *   9. Reverting transaction does not recurse on its own afterTransaction fire
 *  10. Three unauthorised deletes within 60s close the socket cleanly
 *
 * Inverted tests. Several cases in this file asserted that a
 * delete-plus-same-identity-reinsert was NOT classified — the "was that
 * really a reorder?" exemption. They were pinning a defect: the exemption
 * decided on `_temp_id`, `created_by`, `object_id` and the course marker, all
 * client-writable, so a hollow replacement copying them was waved through.
 * Every list now reorders by writing an `order_key` field
 * (app/lib/field-order.ts), which removes nothing from any Y.Array, so there
 * is no honest reorder left for the rule to spare. Those tests now assert the
 * refusal, with the original expectation named where it stood.
 *
 * The handler runs against a real Y.Doc with synthetic WebSocket origins
 * (objects exposing `deserializeAttachment`). No DurableObject runtime is
 * required. This mirrors the harness pattern in
 * tests/snapshot-insert-delete.test.ts.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
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
  extractCourseItemDeletes,
  extractProtectedFieldMutations,
  docHasCourseItems,
  REVERT_ORIGIN,
  PROTECTED_ROOT_NAMES,
} from "../workers/can-delete";

// ---------------------------------------------------------------------------
// Harness — synthetic WebSocket origins, doc bootstrapping, dispatch helpers
// ---------------------------------------------------------------------------

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: "convenor" | "collaborator" | "instructor" };
  // Written out rather than left as the bare mock type: that type carries no
  // call signature, so `ws.send(...)` below would not typecheck.
  send: Mock<(message: Uint8Array) => void>;
  close: Mock<(code?: number, reason?: string) => void>;
}

function fakeSocket(userId: number, role: "convenor" | "collaborator" | "instructor"): FakeWS {
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

  it("returns userId + role for an instructor attachment", () => {
    const ws = fakeSocket(7, "instructor");
    expect(getUserContext(ws)).toEqual({ userId: 7, role: "instructor" });
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

  it("returns one entry for instructor deleting someone else's item", () => {
    const ydoc = new Y.Doc();
    seedStory(ydoc, { createdBy: 99, tempId: "s1" });
    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 5, role: "instructor" }, snap);
    });
    const ws = fakeSocket(5, "instructor");
    asUser(ydoc, ws, () => {
      ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });
    expect(captured.length).toBe(1);
  });

  it("returns empty for instructor deleting their own item", () => {
    const ydoc = new Y.Doc();
    seedStory(ydoc, { createdBy: 5, tempId: "s1" });
    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 5, role: "instructor" }, snap);
    });
    const ws = fakeSocket(5, "instructor");
    asUser(ydoc, ws, () => {
      ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });
    expect(captured).toEqual([]);
  });

  it("classifies a delete-and-reinsert as unauthorised (was: exempted as a reorder)", () => {
    // Seed two convenor-owned stories. A collaborator deletes one and inserts
    // a copy in the same transaction. This used to be exempted, because that
    // was how a drag was implemented; a drag is now a field write that deletes
    // nothing, so this shape is only ever an attempt to replace someone
    // else's content, and is refused.
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
    expect(captured).toHaveLength(1);
    // The revert needs the array and a slot to put the original back into.
    expect(captured[0].parentArray).toBe(ydoc.getArray("stories"));
    expect(captured[0].originalIndex).toBeGreaterThanOrEqual(0);
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

  it("(4) a collaborator's delete-and-reinsert of convenor-owned content is reverted (was: exempted)", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-a" });
    seedStory(h.ydoc, { createdBy: 1, tempId: "s-b" });
    h.installHandler();

    // Delete story 0 and insert a copy. This was the shape of a drag, and was
    // exempted for that reason; ordering is a field now, so it is classified.
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

    // The victim is restored and the copy the actor inserted is swept. Both
    // standing together would be two maps claiming one identity, which the DO's
    // pre-snapshot dedupe resolves in favour of whichever sits first — the
    // attacker's, since the attacker chooses the position.
    const storiesAfter = h.ydoc.getArray<Y.Map<unknown>>("stories");
    expect(storiesAfter.length).toBe(2);
    expect(storiesAfter.map((m) => m.get("_temp_id"))).toEqual(["s-a", "s-b"]);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatch(/reverted 1 unauthorised/);
    expect(collab.send).toHaveBeenCalledTimes(1);
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

// ---------------------------------------------------------------------------
// Course-item protection — its own pass, running for EVERY role
//
// `objects.course_project_id` marks an object preloaded from a course. While
// the marker is set nobody may delete the object: not a collaborator, not an
// instructor, not the convenor. The rule is marker-based and role-independent
// (design §6). These tests exercise the pass through the full handler, so a
// convenor pass only reaches the marker check if all three convenor
// short-circuits (snapshot capture, handler return, extract) let it through.
// ---------------------------------------------------------------------------

/** Seed an object Y.Map into the doc's `objects` root array. */
function seedObject(
  ydoc: Y.Doc,
  opts: {
    createdBy: number;
    tempId: string;
    courseProjectId?: number;
    id?: number;
    objectId?: string;
  },
): Y.Map<unknown> {
  const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
  let objMap!: Y.Map<unknown>;
  ydoc.transact(() => {
    objMap = new Y.Map<unknown>();
    objMap.set("_id", opts.id ?? null);
    objMap.set("_temp_id", opts.tempId);
    objMap.set("created_by", opts.createdBy);
    objMap.set("object_id", opts.objectId ?? opts.tempId);
    objMap.set("title", new Y.Text(`object-${opts.tempId}`));
    // Contract 1: the marker is absent — never null-valued — when unmarked.
    if (opts.courseProjectId !== undefined) {
      objMap.set("course_project_id", opts.courseProjectId);
    }
    objectsArray.push([objMap]);
  }, null);
  return objMap;
}

function objectIds(ydoc: Y.Doc): unknown[] {
  return ydoc
    .getArray<Y.Map<unknown>>("objects")
    .toArray()
    .map((m) => m.get("object_id"));
}

describe("extractCourseItemDeletes — pure pass", () => {
  it("classifies a deleted marked object as unauthorised for the convenor", () => {
    const ydoc = new Y.Doc();
    seedObject(ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    let captured: ReturnType<typeof extractCourseItemDeletes> = [];
    const snap = Y.snapshot(ydoc);
    ydoc.on("afterTransaction", (tr) => {
      captured = extractCourseItemDeletes(ydoc, tr, snap);
    });
    const ws = fakeSocket(1, "convenor");
    asUser(ydoc, ws, () => {
      ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].originalIndex).toBe(0);
  });

  it("ignores a deleted object with no marker", () => {
    const ydoc = new Y.Doc();
    seedObject(ydoc, { createdBy: 1, tempId: "o-plain" });
    let captured: ReturnType<typeof extractCourseItemDeletes> = [];
    const snap = Y.snapshot(ydoc);
    ydoc.on("afterTransaction", (tr) => {
      captured = extractCourseItemDeletes(ydoc, tr, snap);
    });
    const ws = fakeSocket(1, "convenor");
    asUser(ydoc, ws, () => {
      ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });
    expect(captured).toHaveLength(0);
  });
});

describe("docHasCourseItems", () => {
  it("is false for a document with no marked objects", () => {
    const ydoc = new Y.Doc();
    seedObject(ydoc, { createdBy: 1, tempId: "o-plain" });
    expect(docHasCourseItems(ydoc)).toBe(false);
  });

  it("is true once one object carries the marker", () => {
    const ydoc = new Y.Doc();
    seedObject(ydoc, { createdBy: 1, tempId: "o-plain" });
    seedObject(ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    expect(docHasCourseItems(ydoc)).toBe(true);
  });
});

describe("canDelete handler — course-item protection", () => {
  it("reverts a CONVENOR's delete of a marked object", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(objectIds(h.ydoc)).toEqual(["o-course"]);
    // The revert clone must carry the marker forward, or the next attempt
    // would succeed.
    expect(h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("course_project_id")).toBe(7);
    expect(h.warns.length).toBe(1);
  });

  it("reverts an INSTRUCTOR's delete of a marked object they created", () => {
    const h = makeHarness();
    const instructor = fakeSocket(3, "instructor");
    h.sockets.push(instructor);
    seedObject(h.ydoc, { createdBy: 3, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, instructor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(objectIds(h.ydoc)).toEqual(["o-course"]);
  });

  it("reverts a COLLABORATOR's delete of a marked object they created", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedObject(h.ydoc, { createdBy: 2, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(objectIds(h.ydoc)).toEqual(["o-course"]);
  });

  it("still lets the convenor delete an UNMARKED object", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 2, tempId: "o-plain" });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(objectIds(h.ydoc)).toEqual([]);
    expect(h.warns.length).toBe(0);
  });

  it("still lets a collaborator delete their OWN unmarked object", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedObject(h.ydoc, { createdBy: 2, tempId: "o-mine" });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(objectIds(h.ydoc)).toEqual([]);
  });

  it("reverts only the marked object when a convenor deletes a marked and an unmarked one together", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-plain" });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 2);
    });

    expect(objectIds(h.ydoc)).toEqual(["o-course"]);
  });

  it("reverts a marked item exactly once when both passes flag it", () => {
    // A collaborator deleting someone else's marked object trips the
    // own-content rule AND the course rule. The revert must insert one clone.
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(objectIds(h.ydoc)).toEqual(["o-course"]);
  });

  it("does not classify DO-internal transactions — the leave route must be able to clear and the orphan sweep to run", () => {
    const h = makeHarness();
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    h.ydoc.transact(() => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    }, null);

    expect(objectIds(h.ydoc)).toEqual([]);
    expect(h.warns.length).toBe(0);
  });

  it("does not classify string-origin transactions (the revert marker itself)", () => {
    const h = makeHarness();
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    h.ydoc.transact(() => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    }, REVERT_ORIGIN);

    expect(objectIds(h.ydoc)).toEqual([]);
  });

  it("skips enforcement while the DO is snapshotting", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();
    h.isSnapshotting.value = true;

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(objectIds(h.ydoc)).toEqual([]);
    expect(h.warns.length).toBe(0);
  });

  it("does not recurse — the revert transaction produces exactly one classification pass", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(h.warns.length).toBe(1);
    expect(h.ydoc.getArray<Y.Map<unknown>>("objects").length).toBe(1);
  });

  it("counts convenor course-item violations as strikes — three in a minute close the socket", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-1", courseProjectId: 7 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-2", courseProjectId: 7 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-3", courseProjectId: 7 });
    h.installHandler();

    for (let i = 0; i < 3; i++) {
      asUser(h.ydoc, convenor, () => {
        h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
      });
    }

    expect(convenor.close).toHaveBeenCalledWith(1008, "Repeated unauthorised delete attempts");
    expect(h.warns.length).toBe(3);
    expect(h.warns[2]).toMatch(/closing socket/);
  });

  it("broadcasts the post-revert sync step 2 to connected sockets", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(convenor.send).toHaveBeenCalled();
  });

  it("treats a delete-and-reinsert that STRIPS the marker as unauthorised", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      const laundered = new Y.Map<unknown>();
      laundered.set("_id", null);
      laundered.set("_temp_id", "o-course");
      laundered.set("created_by", 1);
      laundered.set("object_id", "o-course");
      arr.insert(0, [laundered]);
    });

    // The replacement is removed and the marked original restored in its
    // place. `objects.object_id` has no UNIQUE constraint, so leaving both
    // would put two "o-course" rows into D1 and into objects.csv, and make
    // every step -> object lookup on the published site ambiguous.
    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(objectIds(h.ydoc)).toEqual(["o-course"]);
    expect(arr.get(0).get("course_project_id")).toBe(7);
  });

  it("classifies a delete-and-reinsert that preserves the marker (was: exempted as a reorder)", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-other", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      const clone = new Y.Map<unknown>();
      clone.set("_id", null);
      clone.set("_temp_id", "o-course");
      clone.set("created_by", 1);
      clone.set("object_id", "o-course");
      clone.set("course_project_id", 7);
      arr.delete(0, 1);
      arr.insert(1, [clone]);
    });

    // A course item may not be deleted by anyone, and objects have never had
    // a reorder operation — so this exemption only ever protected an attack.
    expect(h.warns.length).toBe(1);
    expect(objectIds(h.ydoc)).toEqual(["o-course", "o-other"]);
  });
});

// ---------------------------------------------------------------------------
// Marker protection — the marker itself is not client-writable
//
// Gating deletion on `course_project_id` is worth nothing if a client can
// clear the marker first: tx1 strips it (no delete, so no classification),
// tx2 deletes an object that is now genuinely unmarked, and the next
// snapshot persists the cleared marker to D1, disarming both D1-direct
// gates as well. Any client-socket write to the key — set, clear or change
// — is therefore reverted for every role. DO-internal origins stay exempt:
// the ingest sets the marker and the leave route clears it.
// ---------------------------------------------------------------------------

function markerOf(ydoc: Y.Doc, index = 0): unknown {
  return ydoc.getArray<Y.Map<unknown>>("objects").get(index).get("course_project_id");
}

describe("extractProtectedFieldMutations — pure pass", () => {
  it("classifies a cleared marker, carrying the value to restore", () => {
    const ydoc = new Y.Doc();
    const obj = seedObject(ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    const snap = Y.snapshot(ydoc);
    let captured: ReturnType<typeof extractProtectedFieldMutations> = [];
    ydoc.on("afterTransaction", (tr) => {
      captured = extractProtectedFieldMutations(ydoc, tr, snap);
    });
    asUser(ydoc, fakeSocket(1, "convenor"), () => {
      obj.set("course_project_id", null);
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].key).toBe("course_project_id");
    expect(captured[0].previous).toBe(7);
  });

  it("ignores a transaction that leaves the marker alone", () => {
    const ydoc = new Y.Doc();
    const obj = seedObject(ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    const snap = Y.snapshot(ydoc);
    let captured: ReturnType<typeof extractProtectedFieldMutations> = [];
    ydoc.on("afterTransaction", (tr) => {
      captured = extractProtectedFieldMutations(ydoc, tr, snap);
    });
    asUser(ydoc, fakeSocket(1, "convenor"), () => {
      obj.set("title", new Y.Text("renamed"));
    });
    expect(captured).toHaveLength(0);
  });

  // ---- source_url, on marked objects only ----
  //
  // Ruled 2026-09-01: a course item whose image a child site can repoint is not
  // a course item. The delete gates make the row undeletable and the identity
  // keys make it unmistakable, but neither stops a member socket rewriting
  // where the image comes from, in place, with no delete involved.

  it("flags a source_url rewrite on a course item, carrying the address to restore", () => {
    const ydoc = new Y.Doc();
    const obj = seedObject(ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    ydoc.transact(() => { obj.set("source_url", "https://course.example/iiif/o1"); }, null);
    const snap = Y.snapshot(ydoc);
    let captured: ReturnType<typeof extractProtectedFieldMutations> = [];
    ydoc.on("afterTransaction", (tr) => {
      captured = extractProtectedFieldMutations(ydoc, tr, snap);
    });
    asUser(ydoc, fakeSocket(1, "convenor"), () => {
      obj.set("source_url", "https://elsewhere.example/mine.jpg");
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].key).toBe("source_url");
    expect(captured[0].previous).toBe("https://course.example/iiif/o1");
  });

  it("leaves source_url alone on an object that is not a course item", () => {
    // The scope is deliberate. On their own objects people repoint images as a
    // matter of course, and this pass has no business there.
    const ydoc = new Y.Doc();
    const obj = seedObject(ydoc, { createdBy: 1, tempId: "o1" });
    ydoc.transact(() => { obj.set("source_url", "https://mine.example/a.jpg"); }, null);
    const snap = Y.snapshot(ydoc);
    let captured: ReturnType<typeof extractProtectedFieldMutations> = [];
    ydoc.on("afterTransaction", (tr) => {
      captured = extractProtectedFieldMutations(ydoc, tr, snap);
    });
    asUser(ydoc, fakeSocket(1, "convenor"), () => {
      obj.set("source_url", "https://mine.example/b.jpg");
    });
    expect(captured).toHaveLength(0);
  });

  it("still lets a course item's cataloguing be edited", () => {
    // Design §6: the image belongs to the course, the group catalogues title,
    // creator and credit. Guarding the address must not freeze the record.
    const ydoc = new Y.Doc();
    const obj = seedObject(ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    ydoc.transact(() => { obj.set("source_url", "https://course.example/iiif/o1"); }, null);
    const snap = Y.snapshot(ydoc);
    let captured: ReturnType<typeof extractProtectedFieldMutations> = [];
    ydoc.on("afterTransaction", (tr) => {
      captured = extractProtectedFieldMutations(ydoc, tr, snap);
    });
    asUser(ydoc, fakeSocket(1, "collaborator"), () => {
      obj.set("creator", "Adelaida Ávila");
      obj.set("credit", "Colección particular");
    });
    expect(captured).toHaveLength(0);
  });
});

describe("canDelete handler — course-marker protection", () => {
  it("BLOCKING: two-transaction strip-then-delete does not defeat the rule (convenor)", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    // tx1 — strip the marker. No delete, so the delete passes see nothing.
    asUser(h.ydoc, convenor, () => {
      obj.set("course_project_id", null);
    });
    expect(markerOf(h.ydoc)).toBe(7);

    // tx2 — delete the (still marked) object.
    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });
    expect(objectIds(h.ydoc)).toEqual(["o1"]);
    expect(markerOf(h.ydoc)).toBe(7);
  });

  it("reverts a marker cleared by key deletion, not just set-to-null", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      obj.delete("course_project_id");
    });

    expect(markerOf(h.ydoc)).toBe(7);
  });

  it("reverts a collaborator stripping the marker from an object they created", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    const obj = seedObject(h.ydoc, { createdBy: 2, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      obj.set("course_project_id", null);
    });

    expect(markerOf(h.ydoc)).toBe(7);
  });

  it("reverts a collaborator repointing a course item's image", () => {
    // The whole point of the ruling: no delete is involved, so none of the
    // delete gates see anything. Left alone, that child site serves an image
    // the course never published while still presenting it as the course's.
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    const obj = seedObject(h.ydoc, { createdBy: 2, tempId: "o1", courseProjectId: 7 });
    h.ydoc.transact(() => { obj.set("source_url", "https://course.example/iiif/o1"); }, null);
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      obj.set("source_url", "https://elsewhere.example/mine.jpg");
    });

    expect(obj.get("source_url")).toBe("https://course.example/iiif/o1");
  });

  it("reverts an instructor stripping the marker", () => {
    const h = makeHarness();
    const instructor = fakeSocket(3, "instructor");
    h.sockets.push(instructor);
    const obj = seedObject(h.ydoc, { createdBy: 3, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, instructor, () => {
      obj.set("course_project_id", null);
    });

    expect(markerOf(h.ydoc)).toBe(7);
  });

  it("reverts a marker changed to a different course", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      obj.set("course_project_id", 9);
    });

    expect(markerOf(h.ydoc)).toBe(7);
  });

  it("strips a marker FORGED onto an existing unmarked object — no snapshot needed", () => {
    // The document holds no course item, so the convenor's beforeTransaction
    // takes the snapshot-free path. The pre-value is provably absent, which
    // is exactly what the revert restores.
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1" });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      obj.set("course_project_id", 99);
    });

    expect(markerOf(h.ydoc)).toBeUndefined();
  });

  it("strips a marker forged onto an object created in the same transaction", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      const forged = new Y.Map<unknown>();
      forged.set("_id", null);
      forged.set("_temp_id", "o-forged");
      forged.set("created_by", 2);
      forged.set("object_id", "o-forged");
      forged.set("course_project_id", 99);
      h.ydoc.getArray<Y.Map<unknown>>("objects").push([forged]);
    });

    expect(objectIds(h.ydoc)).toEqual(["o-forged"]);
    expect(markerOf(h.ydoc)).toBeUndefined();
  });

  it("lets a DO-internal transaction clear the marker — the leave route's job", () => {
    const h = makeHarness();
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    h.ydoc.transact(() => {
      obj.delete("course_project_id");
    }, null);

    expect(markerOf(h.ydoc)).toBeUndefined();
    expect(h.warns.length).toBe(0);
  });

  it("lets a DO-internal transaction set the marker — the preload ingest's job", () => {
    const h = makeHarness();
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1" });
    h.installHandler();

    h.ydoc.transact(() => {
      obj.set("course_project_id", 7);
    }, null);

    expect(markerOf(h.ydoc)).toBe(7);
    expect(h.warns.length).toBe(0);
  });

  it("lets a string-origin transaction write the marker", () => {
    const h = makeHarness();
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    h.ydoc.transact(() => {
      obj.set("course_project_id", null);
    }, REVERT_ORIGIN);

    expect(markerOf(h.ydoc)).toBeNull();
  });

  it("does not classify an ordinary edit to a marked object", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      obj.set("title", new Y.Text("a better title"));
    });

    expect(h.warns.length).toBe(0);
    expect(markerOf(h.ydoc)).toBe(7);
  });

  it("does not classify a marked sibling when another object is deleted from the same array", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-plain" });
    seedObject(h.ydoc, { createdBy: 1, tempId: "o-course", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(h.warns.length).toBe(0);
    expect(objectIds(h.ydoc)).toEqual(["o-course"]);
    expect(markerOf(h.ydoc)).toBe(7);
  });

  it("counts marker mutations as strikes — three in a minute close the socket", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    for (let i = 0; i < 3; i++) {
      asUser(h.ydoc, convenor, () => {
        obj.set("course_project_id", null);
      });
    }

    expect(convenor.close).toHaveBeenCalledWith(1008, "Repeated unauthorised delete attempts");
    expect(h.warns.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Identity-spoof substitution
//
// The reorder exemption originally trusted `_temp_id` plus the marker value.
// One transaction could then delete a course object and insert a replacement
// under the victim's `_temp_id` and marker, carrying a different `object_id`,
// `source_url` and `created_by` — same identity, same marker, so both passes
// waved it through. With no `_id`, the next snapshot DELETEs the real D1 row
// and INSERTs the attacker's: substitution with no revert and no strike.
//
// That round tightened the exemption to require `_id` and `object_id` as
// well as the marker. The exemption is now gone outright — a reorder writes
// a field and deletes nothing — so a delete-plus-reinsert of a course item is
// classified whatever the replacement carries. The two cases below that
// asserted a faithful clone was "still allowed" were pinning the exemption,
// and now assert the refusal.
// ---------------------------------------------------------------------------

/** Build an object Y.Map from explicit fields, for hand-rolled replacements. */
function buildObjectMap(fields: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(fields)) map.set(key, value);
  return map;
}

describe("canDelete handler — identity-spoof substitution", () => {
  it("BLOCKING: reverts a replacement sharing _temp_id and marker but not object_id", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7, id: 10 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _temp_id: "o1",                 // the victim's identity
        course_project_id: 7,           // the victim's marker
        object_id: "spoofed",           // but a different object
        source_url: "https://attacker.example/manifest.json",
        created_by: 1,
      })]);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("object_id")).toBe("o1");
    expect(arr.get(0).get("_id")).toBe(10);
    expect(arr.get(0).get("course_project_id")).toBe(7);
    expect(arr.get(0).get("source_url")).toBeUndefined();
    expect(h.warns.length).toBe(1);
    // The two passes must not both claim the replacement: the course pass
    // removes it, so the marker pass has to leave it alone or the revert
    // would write a key into a map it is about to tombstone.
    expect(h.warns[0]).toMatch(/1 unauthorised delete\(s\), 0 course-marker change\(s\) and 0 identity-key change\(s\)/);
  });

  it("reverts a replacement that copies object_id but drops _id", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7, id: 10 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _temp_id: "o1",
        course_project_id: 7,
        object_id: "o1",
        source_url: "https://attacker.example/manifest.json",
        created_by: 1,
      })]);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_id")).toBe(10);
    expect(arr.get(0).get("source_url")).toBeUndefined();
    expect(h.warns.length).toBe(1);
  });

  it("reverts a collaborator's spoof that also copies the victim's created_by", () => {
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedObject(h.ydoc, { createdBy: 2, tempId: "o1", courseProjectId: 7, id: 10 });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _temp_id: "o1",
        course_project_id: 7,
        object_id: "spoofed",
        created_by: 2,
      })]);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("object_id")).toBe("o1");
  });

  it("counts spoof attempts as strikes — three in a minute close the socket", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7, id: 10 });
    h.installHandler();

    for (let i = 0; i < 3; i++) {
      asUser(h.ydoc, convenor, () => {
        const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
        arr.delete(0, 1);
        arr.insert(0, [buildObjectMap({
          _temp_id: "o1",
          course_project_id: 7,
          object_id: `spoofed-${i}`,
          created_by: 1,
        })]);
      });
    }

    expect(convenor.close).toHaveBeenCalledWith(1008, "Repeated unauthorised delete attempts");
    expect(h.warns.length).toBe(3);
  });

  it("refuses a faithful clone of a marked object carrying a real _id (was: allowed as a reorder)", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7, id: 10 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "o2", courseProjectId: 7, id: 11 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      // Every key carried across — what the old clone-based reorder produced.
      const clone = buildObjectMap({
        _id: 10,
        _temp_id: "o1",
        created_by: 1,
        object_id: "o1",
        course_project_id: 7,
      });
      arr.delete(0, 1);
      arr.insert(1, [clone]);
    });

    // Faithful or not, the delete is refused: the marked original comes back
    // and the copy is swept, leaving one row per identity.
    expect(h.warns.length).toBe(1);
    expect(objectIds(h.ydoc)).toEqual(["o1", "o2"]);
  });

  it("refuses a faithful clone when the original was never snapshotted (_id null) (was: allowed)", () => {
    // `_id` null -> null carried no information, so `object_id` equality was
    // what let this case through. Nothing lets it through now.
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "o2", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      const clone = buildObjectMap({
        _id: null,
        _temp_id: "o1",
        created_by: 1,
        object_id: "o1",
        course_project_id: 7,
      });
      arr.delete(0, 1);
      arr.insert(1, [clone]);
    });

    expect(h.warns.length).toBe(1);
    expect(objectIds(h.ydoc)).toEqual(["o1", "o2"]);
  });

  it("reverts a substitution against a never-snapshotted original (_id null, different object_id)", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _id: null,
        _temp_id: "o1",
        created_by: 1,
        object_id: "spoofed",
        course_project_id: 7,
      })]);
    });

    expect(objectIds(h.ydoc)).toEqual(["o1"]);
    expect(h.warns.length).toBe(1);
  });
});

describe("canDelete handler — strip and delete inside one transaction", () => {
  it("restores the object WITH its marker when the strip precedes the delete", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7, id: 10 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      obj.set("course_project_id", null);
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(objectIds(h.ydoc)).toEqual(["o1"]);
    expect(markerOf(h.ydoc)).toBe(7);
  });

  it("restores the object WITH its marker when the delete precedes the strip", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7, id: 10 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
      obj.set("course_project_id", null);
    });

    expect(objectIds(h.ydoc)).toEqual(["o1"]);
    expect(markerOf(h.ydoc)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Durable-identity replacement removal
//
// Round 2 tightened the reorder EXEMPTION, so these spoofs are correctly
// classified and reverted with a strike. The evasion moved one level down,
// into the clone-REMOVAL lookup: `launderedClone` was found through
// `identityKeyFor`, which prefers `_temp_id`. A replacement that changes or
// omits `_temp_id` is never matched, so it survives beside the restored
// original — both carrying the same `_id` and `object_id`.
//
// The DO's pre-snapshot `deduplicateYArray` then finishes the job: it runs
// null-origin (exempt from every pass), collapses exact `_id` duplicates, and
// keeps the FIRST occurrence — so an attacker inserting at or before the
// victim's index has the DO delete the restored original for them.
// ---------------------------------------------------------------------------

describe("canDelete handler — replacement removal by durable identity", () => {
  it("R2: removes a replacement that changes _temp_id but keeps _id and object_id", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", courseProjectId: 7, id: 100 });
    // seedObject names object_id after tempId; the durable key is object_id.
    h.ydoc.transact(() => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).set("object_id", "course-obj");
    }, null);
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _id: 100,                    // the victim's persisted row
        _temp_id: "attacker",        // but NOT the victim's client identity
        object_id: "course-obj",
        created_by: 2,
        source_url: "https://attacker.example/manifest.json",
      })]);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_temp_id")).toBe("victim");
    expect(arr.get(0).get("course_project_id")).toBe(7);
    expect(arr.get(0).get("source_url")).toBeUndefined();
    expect(h.warns.length).toBe(1);
  });

  it("R2b: removes a replacement carrying no _temp_id at all", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", courseProjectId: 7, id: 100 });
    h.ydoc.transact(() => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).set("object_id", "course-obj");
    }, null);
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _id: 100,
        object_id: "course-obj",
        created_by: 2,
      })]);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_temp_id")).toBe("victim");
    expect(arr.get(0).get("course_project_id")).toBe(7);
  });

  it("R3b: removes a collaborator's replacement that preserves every gate key but forges created_by", () => {
    // The course pass exempts this one — identity genuinely IS preserved — so
    // the own-content pass is what classifies it, and the removal has to hook
    // onto the reverted delete rather than onto the course pass.
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", courseProjectId: 7, id: 100 });
    h.ydoc.transact(() => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).set("object_id", "course-obj");
    }, null);
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _id: 100,
        _temp_id: "victim",
        object_id: "course-obj",
        course_project_id: 7,
        created_by: 2,               // re-attributed to the attacker
      })]);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("created_by")).toBe(1);
    expect(arr.get(0).get("course_project_id")).toBe(7);
  });

  it("removes an UNMARKED object's forged-created_by clone too", () => {
    // The sweep covers ordinary content as well as course items. The forgery is
    // born inside the offending transaction and claims the victim's row id, and
    // that provenance is the only thing separating it from honest content —
    // by snapshot time D1 knows only that row 100 exists.
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", id: 100 });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _id: 100,
        _temp_id: "victim",
        object_id: "victim",
        created_by: 2,
      })]);
    });

    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(objects.length).toBe(1);
    expect(objects.get(0).get("created_by")).toBe(1);
  });

  it("removes a same-transaction insert that collides on object_id with a reverted course item", () => {
    // Accepted edge: an object_id collision with a protected item is
    // laundering by construction — object_id is the slug every step
    // reference, CSV row and published page resolves against.
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _id: null,
        _temp_id: "other",
        object_id: "victim",
        created_by: 1,
      })]);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_temp_id")).toBe("victim");
    expect(h.warns.length).toBe(1);
  });

  it("classifies a faithful clone and sweeps it, leaving one row (was: exempted before classification)", () => {
    // This pinned the ordering that kept reorders safe: `preservesIdentity`
    // exempted the clone inside each pass, so the removal sweep — which
    // iterates classified entries only — never saw it. With no exemption both
    // passes classify, and the sweep removes the copy so the restored
    // original is not left beside a twin for the DO's dedupe to resolve.
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    seedObject(h.ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7, id: 100 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "o2", courseProjectId: 7, id: 101 });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      const clone = buildObjectMap({
        _id: 100,
        _temp_id: "o1",
        created_by: 1,
        object_id: "o1",
        course_project_id: 7,
      });
      arr.delete(0, 1);
      arr.insert(1, [clone]);
    });

    expect(h.warns.length).toBe(1);
    expect(objectIds(h.ydoc)).toEqual(["o1", "o2"]);
    expect(h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("course_project_id")).toBe(7);
  });

  it("leaves an unrelated object alone while removing the replacement", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", courseProjectId: 7, id: 100 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "bystander", id: 101 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [buildObjectMap({
        _id: 100,
        _temp_id: "attacker",
        object_id: "victim",
        created_by: 2,
      })]);
    });

    expect(objectIds(h.ydoc).sort()).toEqual(["bystander", "victim"]);
  });
});

// ---------------------------------------------------------------------------
// The sweep touches only what the transaction inserted
//
// Scanning the whole parent array let the sweep remove maps the offending
// transaction never touched. The harmful shape: a marked object still inside
// its pre-first-snapshot `_id: null` window is deleted and reverted while a
// same-slug object carrying a REAL `_id` sits beside it. Removing the
// persisted map would have the next snapshot DELETE its D1 row and INSERT a
// fresh one for the restored null-`_id` victim — silent data loss during a
// restore, in exactly the case the DO's dedupe keeps a non-null-`_id`
// preference to avoid (collaboration.ts:1751-1756).
//
// Every attacker replacement is inserted by the offending transaction by
// construction, so restricting the sweep to in-transaction inserts costs
// nothing and bounds the blast radius to what the actor actually did.
// ---------------------------------------------------------------------------

describe("canDelete handler — the sweep spares maps the transaction never touched", () => {
  it("T2: a pre-existing persisted same-slug map survives the revert of a null-_id victim", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    // Index 0: persisted, untouched, shares the slug. Index 1: the marked
    // victim, never snapshotted, so its `_id` is still null.
    seedObject(h.ydoc, { createdBy: 1, tempId: "persisted", objectId: "shared-slug", id: 300 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", objectId: "shared-slug", courseProjectId: 7 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(1, 1);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(2);
    const rowIds = arr.toArray().map((m) => m.get("_id"));
    expect(rowIds).toContain(300);            // the persisted map is untouched
    expect(rowIds).toContain(null);           // the victim is restored
    expect(arr.toArray().some((m) => m.get("course_project_id") === 7)).toBe(true);
  });

  it("S10: a same-slug competitor IS swept when the victim is itself persisted", () => {
    // The other side of the discriminator. Both carry a non-null `_id`, so
    // the dedupe's non-null preference cannot separate them and it collapses
    // one of the pair on first-occurrence — an order the actor controls.
    // Since one of the two is going regardless, the marked one is the one to
    // keep, so a slug competitor is swept whenever it arrived.
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "persisted", objectId: "shared-slug", id: 300 });
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", objectId: "shared-slug", courseProjectId: 7, id: 100 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(1, 1);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_id")).toBe(100);
    expect(arr.get(0).get("course_project_id")).toBe(7);
  });

  it("S7: every in-transaction replacement is still swept, by _id and by object_id alike", () => {
    const h = makeHarness();
    const convenor = fakeSocket(1, "convenor");
    h.sockets.push(convenor);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100 });
    h.installHandler();

    asUser(h.ydoc, convenor, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(0, 1);
      arr.insert(0, [
        buildObjectMap({ _id: 100, _temp_id: "a", object_id: "other-slug", created_by: 2 }),
        buildObjectMap({ _id: null, _temp_id: "b", object_id: "course-obj", created_by: 2 }),
      ]);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_temp_id")).toBe("victim");
    expect(arr.get(0).get("course_project_id")).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Two-transaction substitution — the twin planted ahead of the delete
//
// Restricting the sweep to in-transaction inserts closed the data-loss case
// but reopened substitution in two steps: plant a twin in tx1 (a legal
// insert — nothing to classify, no strike), then delete the marked victim in
// tx2. The delete is reverted, but a twin planted earlier is not swept, and
// the DO's dedupe finishes the job — exact-`_id` collapse when the twin
// copies the victim's `_id`, or keeper-by-slug first-occurrence when it
// carries a different non-null `_id` (the non-null preference never engages,
// because both are non-null).
//
// The discriminator is the victim's own `_id`. A victim with a persisted row
// is swept regardless of when the competitor arrived; a victim still at
// `_id: null` sweeps only what this transaction inserted, because a persisted
// same-slug neighbour is real data whose removal would cost a live D1 row.
// ---------------------------------------------------------------------------

/** Plant a competitor in its own transaction, before the delete. */
function plantTwin(h: Harness, ws: FakeWS, fields: Record<string, unknown>): void {
  asUser(h.ydoc, ws, () => {
    h.ydoc.getArray<Y.Map<unknown>>("objects").insert(0, [buildObjectMap(fields)]);
  });
}

describe("canDelete handler — twins planted in an earlier transaction", () => {
  it("E3a: sweeps a twin that copied the victim's _id", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100 });
    h.installHandler();

    plantTwin(h, attacker, {
      _id: 100, _temp_id: "TWIN", object_id: "course-obj", created_by: 2,
    });
    // The plant is refused where it lands: a map born in a client transaction
    // may not claim a row id a live neighbour holds, so the twin never reaches
    // the second transaction. The delete below then falls on the victim.
    expect(h.warns.length).toBe(1);

    asUser(h.ydoc, attacker, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(arr.length - 1, 1);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_temp_id")).toBe("victim");
    expect(arr.get(0).get("course_project_id")).toBe(7);
    expect(h.warns.length).toBe(2);
  });

  it("E3b: sweeps a twin carrying a different non-null _id but the victim's slug", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100 });
    h.installHandler();

    plantTwin(h, attacker, {
      _id: 777, _temp_id: "TWIN", object_id: "course-obj", created_by: 2,
    });

    asUser(h.ydoc, attacker, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(arr.length - 1, 1);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_temp_id")).toBe("victim");
    expect(arr.get(0).get("course_project_id")).toBe(7);
  });

  it("E3d: sweeps a twin that copied the _id and forged the marker", () => {
    // The twin claims a live row id, so tx1 removes it outright; the forged
    // marker goes with it, and the marker pass reports nothing because a map
    // being removed is kept out of the field passes. Two strikes, and the
    // victim is the survivor either way.
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100 });
    h.installHandler();

    plantTwin(h, attacker, {
      _id: 100, _temp_id: "TWIN", object_id: "course-obj", created_by: 2, course_project_id: 7,
    });

    asUser(h.ydoc, attacker, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(arr.length - 1, 1);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_temp_id")).toBe("victim");
    expect(arr.get(0).get("created_by")).toBe(1);
    expect(arr.get(0).get("course_project_id")).toBe(7);
    expect(h.warns.length).toBe(2);
    expect(h.warns[0]).toMatch(/0 unauthorised delete\(s\), 0 course-marker change\(s\) and 0 identity-key change\(s\), and removed 1 forged insert\(s\)/);
    expect(h.warns[1]).toMatch(/1 unauthorised delete\(s\), 0 course-marker change\(s\) and 0 identity-key change\(s\), and removed 0 forged insert\(s\)/);
  });

  it("E3c: the victim survives a planted twin that never took an _id", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    seedObject(h.ydoc, { createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100 });
    h.installHandler();

    plantTwin(h, attacker, {
      _id: null, _temp_id: "TWIN", object_id: "course-obj", created_by: 2,
    });

    asUser(h.ydoc, attacker, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(arr.length - 1, 1);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    const victim = arr.toArray().find((m) => m.get("_temp_id") === "victim");
    expect(victim).toBeDefined();
    expect(victim!.get("course_project_id")).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// `_id` is DO-owned on marked objects
//
// Every discriminator built so far — the sweep's branch selector, the DO's
// own dedupe — rests on `_id`, and `_id` was client-writable: the passes only
// ever READ it. So the substitution came back in three steps: clear the
// victim's `_id` (no delete, no marker write, nothing fires), plant a
// non-null-`_id` twin carrying the victim's slug, then delete the victim.
// At the delete the snapshot-read `_id` is null, so the restrictive branch
// applies, the earlier twin is not swept, and the dedupe's non-null-`_id`
// preference keeps the twin and collapses the restored victim.
//
// The fix closes the class rather than adding a fourth discriminator: on a
// map that carries the marker at the snapshot, `_id` is reverted on any
// client write, exactly as the marker itself is. The legitimate writers are
// all DO-side and origin-less, so they stay exempt.
// ---------------------------------------------------------------------------

function rowIdOf(ydoc: Y.Doc, index = 0): unknown {
  return ydoc.getArray<Y.Map<unknown>>("objects").get(index).get("_id");
}

describe("canDelete handler — _id protection on marked objects", () => {
  it("X2 step 1: reverts a client clearing a marked object's _id, with a strike", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    const obj = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100,
    });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      obj.set("_id", null);
    });

    expect(rowIdOf(h.ydoc)).toBe(100);
    expect(h.warns.length).toBe(1);
  });

  it("reverts a marked object's _id changed to a different row", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    const obj = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100,
    });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      obj.set("_id", 777);
    });

    expect(rowIdOf(h.ydoc)).toBe(100);
  });

  it("reverts an _id FORGED onto a marked object that had none", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    const obj = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7,
    });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      obj.set("_id", 555);
    });

    expect(rowIdOf(h.ydoc)).toBeNull();
  });

  it("reverts an _id removed by key deletion on a marked object", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    const obj = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100,
    });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      obj.delete("_id");
    });

    expect(rowIdOf(h.ydoc)).toBe(100);
  });

  it("lets a DO-internal transaction assign _id on a marked object — the first snapshot's job", () => {
    // The preload creates a course item marked with `_id: null`; the first
    // snapshot INSERTs it and writes the real id back through a bare
    // `this.ydoc.transact(...)` with no origin (collaboration.ts:2490).
    const h = makeHarness();
    const obj = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7,
    });
    h.installHandler();

    h.ydoc.transact(() => {
      obj.set("_id", 100);
    }, null);

    expect(rowIdOf(h.ydoc)).toBe(100);
    expect(h.warns.length).toBe(0);
  });

  it("reverts an UNMARKED object's _id assignment too", () => {
    // `_id` is DO-owned on the `objects` root whatever the marker says: the
    // DO's dedupe and the orphan sweep both resolve identity through it, so a
    // client able to write it on a pre-existing map can aim either at content
    // it has no right to touch.
    const h = makeHarness();
    const collab = fakeSocket(2, "collaborator");
    h.sockets.push(collab);
    const obj = seedObject(h.ydoc, { createdBy: 2, tempId: "plain" });
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      obj.set("_id", 42);
    });

    expect(rowIdOf(h.ydoc)).toBe(null);
    expect(h.warns.length).toBe(1);
  });

  it("X2b: an _id clear in the same transaction as the delete stays blocked", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    const obj = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100,
    });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      obj.set("_id", null);
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    expect(objectIds(h.ydoc)).toEqual(["course-obj"]);
    expect(rowIdOf(h.ydoc)).toBe(100);
    expect(markerOf(h.ydoc)).toBe(7);
  });

  it("X2 end to end: the three-step substitution leaves the victim intact", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    const obj = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100,
    });
    h.installHandler();

    // tx1 — clear the victim's `_id` so the sweep would take the restrictive
    // branch at tx3. Reverted here, which is what breaks the chain.
    asUser(h.ydoc, attacker, () => { obj.set("_id", null); });
    // tx2 — plant the twin, a legal insert on its own.
    plantTwin(h, attacker, {
      _id: 777, _temp_id: "TWIN", object_id: "course-obj", created_by: 2,
    });
    // tx3 — delete the victim.
    asUser(h.ydoc, attacker, () => {
      const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
      arr.delete(arr.length - 1, 1);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_temp_id")).toBe("victim");
    expect(arr.get(0).get("_id")).toBe(100);
    expect(arr.get(0).get("course_project_id")).toBe(7);
  });
});

describe("canDelete handler — object_id protection on marked objects", () => {
  it("O1: reverts a client renaming a marked object's object_id, with a strike", () => {
    const h = makeHarness();
    const attacker = fakeSocket(1, "convenor");
    h.sockets.push(attacker);
    const victim = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100,
    });
    seedObject(h.ydoc, { createdBy: 9, tempId: "bystander", objectId: "someone-elses", id: 300 });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      victim.set("object_id", "someone-elses");
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.get(0).get("object_id")).toBe("course-obj");
    expect(arr.length).toBe(2);
    expect(h.warns.length).toBe(1);
  });

  it("O2: a collaborator cannot aim the sweep at another user's object", () => {
    // The escalation this guard exists for: rename a course item onto a
    // bystander's slug, delete the course item, and the replacement sweep
    // removes the bystander — content the collaborator could never delete
    // directly. The rename is refused, so the sweep is never mis-aimed.
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    const victim = seedObject(h.ydoc, {
      createdBy: 2, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100,
    });
    seedObject(h.ydoc, { createdBy: 9, tempId: "bystander", objectId: "someone-elses", id: 300 });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      victim.set("object_id", "someone-elses");
    });
    asUser(h.ydoc, attacker, () => {
      h.ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1);
    });

    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");
    const slugs = arr.toArray().map((m) => m.get("object_id"));
    expect(slugs).toContain("someone-elses");
    expect(arr.toArray().find((m) => m.get("_id") === 300)).toBeDefined();
  });

  it("O3: reverts a rename with no delete, so slug references cannot be redirected", () => {
    const h = makeHarness();
    const attacker = fakeSocket(1, "convenor");
    h.sockets.push(attacker);
    const victim = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100,
    });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      victim.set("object_id", "orphaned");
    });

    expect(h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("object_id")).toBe("course-obj");
  });

  it("reverts an unmarked object's object_id rename, convenor included", () => {
    // The attack shape: rename an object's slug in place onto another
    // object's, then let the DO's pre-snapshot dedupe delete the loser. No
    // client writes `object_id` on a pre-existing objects map — the only
    // writer is makeObjectYMap, at construction — so there is no rename
    // feature to preserve here, and the convenor is not exempt.
    const h = makeHarness();
    const attacker = fakeSocket(1, "convenor");
    h.sockets.push(attacker);
    const obj = seedObject(h.ydoc, { createdBy: 1, tempId: "plain", objectId: "plain-obj", id: 100 });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      obj.set("object_id", "renamed");
    });

    expect(h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("object_id")).toBe("plain-obj");
    expect(h.warns.length).toBe(1);
  });

  it("allows a DO-internal (null-origin) object_id write on a marked object", () => {
    const h = makeHarness();
    const obj = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7, id: 100,
    });
    h.installHandler();

    h.ydoc.transact(() => { obj.set("object_id", "renamed-by-do"); });

    expect(h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("object_id")).toBe("renamed-by-do");
    expect(h.warns.length).toBe(0);
  });

  it("reverts a string _id set onto a marked object whose _id was null", () => {
    // normalisedRowId maps every non-number to null, so a null -> "100"
    // write is invisible to a normalised comparison while deduplicateYArray
    // and insertObjectRow both read it as persisted. The mutation test
    // compares raw values for exactly this reason.
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    h.sockets.push(attacker);
    const obj = seedObject(h.ydoc, {
      createdBy: 1, tempId: "victim", objectId: "course-obj", courseProjectId: 7,
    });
    h.installHandler();

    asUser(h.ydoc, attacker, () => {
      obj.set("_id", "100");
    });

    expect(h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("_id")).toBe(null);
    expect(h.warns.length).toBe(1);
  });
});

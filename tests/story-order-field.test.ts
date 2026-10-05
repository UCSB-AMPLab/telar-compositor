/**
 * story-order-field.test.ts — story ordering as a field write rather than a
 * move between Y.Array positions.
 *
 * The defect this closes is structural, not incidental: the own-content
 * rule forbids deleting another member's content, and a clone-delete-insert
 * reorder is indistinguishable from a delete-and-replace, so the rule needs an
 * exemption keyed on fields any collaborator can write. Writing an `order_key`
 * field instead means an honest drag removes nothing from the array, so the
 * rule never fires and there is nothing to exempt.
 *
 * A literally empty `tr.deleteSet` is not attainable for ANY field write:
 * overwriting a Y.Map key tombstones the superseded value (measured against
 * yjs 13.6.30 — a single struct of length 1). What IS attainable, and what the
 * exemption actually turns on, is that no Y.Map is removed from a protected
 * Y.Array. Both are pinned below.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  collectDeletedProtectedMaps,
  extractUnauthorisedDeletes,
  makeCanDeleteHandler,
  makeViolationCounter,
} from "../workers/can-delete";
import {
  ORDER_KEY,
  backfillOrderKeys,
  nextOrderKeyAfterLast,
  orderedStoryMaps,
  readOrderKey,
  reorderByOrderKey,
} from "~/lib/story-order";
import { generateKeyBetween, isValidOrderKey } from "~/lib/order-key";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: "convenor" | "collaborator" | "instructor" };
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

/** Seed `n` stories owned by `createdBy`, keyed in array order. */
function seedStories(ydoc: Y.Doc, slugs: string[], createdBy = 1): void {
  const stories = ydoc.getArray<Y.Map<unknown>>("stories");
  ydoc.transact(() => {
    for (const slug of slugs) {
      const m = new Y.Map<unknown>();
      m.set("_id", null);
      m.set("_temp_id", `t-${slug}`);
      m.set("created_by", createdBy);
      m.set("story_id", slug);
      m.set("title", new Y.Text(slug));
      m.set(ORDER_KEY, nextOrderKeyAfterLast(stories));
      m.set("steps", new Y.Array<Y.Map<unknown>>());
      stories.push([m]);
    }
  }, null);
}

function slugsInOrder(ydoc: Y.Doc): string[] {
  return orderedStoryMaps(ydoc.getArray<Y.Map<unknown>>("stories")).map(
    (m) => m.get("story_id") as string,
  );
}

// ---------------------------------------------------------------------------
// 1. A reorder removes nothing from the Y.Array
// ---------------------------------------------------------------------------

describe("a field-based reorder issues no Y.Array delete", () => {
  it("deletes no protected Y.Map, and tombstones only the superseded key", () => {
    const ydoc = new Y.Doc();
    seedStories(ydoc, ["a", "b", "c"]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    const before = [stories.get(0), stories.get(1), stories.get(2)];

    let deletedMaps: unknown[] = [];
    let deletedStructTotal = 0;
    let deletedInStoriesArray = 0;
    ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      deletedMaps = collectDeletedProtectedMaps(ydoc, tr);
      Y.iterateDeletedStructs(tr, tr.deleteSet, (item) => {
        deletedStructTotal += 1;
        const parent = (item as unknown as { parent?: unknown }).parent;
        if (parent === stories) deletedInStoriesArray += 1;
      });
    });

    const socket = fakeSocket(2, "collaborator");
    ydoc.transact(() => reorderByOrderKey(stories, 0, 2), socket);

    // Nothing left the array: same three Y.Map objects, same positions.
    expect(stories.length).toBe(3);
    expect([stories.get(0), stories.get(1), stories.get(2)]).toEqual(before);
    // Nothing the delete rule could ever look at.
    expect(deletedMaps).toEqual([]);
    expect(deletedInStoriesArray).toBe(0);
    // The only tombstone is the superseded order_key value.
    expect(deletedStructTotal).toBe(1);
    // And the order actually changed.
    expect(slugsInOrder(ydoc)).toEqual(["b", "c", "a"]);
  });

  it("is not classified as an unauthorised delete for a collaborator moving a convenor's story", () => {
    const ydoc = new Y.Doc();
    seedStories(ydoc, ["a", "b", "c"], 1); // convenor-owned
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    const socket = fakeSocket(2, "collaborator");

    let found: unknown[] = [];
    ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      found = extractUnauthorisedDeletes(ydoc, tr, { userId: 2, role: "collaborator" }, null);
    });

    ydoc.transact(() => reorderByOrderKey(stories, 2, 0), socket);

    expect(found).toEqual([]);
    expect(slugsInOrder(ydoc)).toEqual(["c", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Dropping between two neighbours
// ---------------------------------------------------------------------------

describe("dropping a story between two others", () => {
  it("lands between them and keeps both neighbours' keys untouched", () => {
    const ydoc = new Y.Doc();
    seedStories(ydoc, ["a", "b", "c", "d"]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    const keyB = readOrderKey(stories.get(1))!;
    const keyC = readOrderKey(stories.get(2))!;

    // Move "d" (display index 3) to sit between "b" and "c" (display index 2).
    ydoc.transact(() => reorderByOrderKey(stories, 3, 2), fakeSocket(1, "convenor"));

    expect(slugsInOrder(ydoc)).toEqual(["a", "b", "d", "c"]);
    const keyD = readOrderKey(stories.get(3))!;
    expect(keyB < keyD).toBe(true);
    expect(keyD < keyC).toBe(true);
    // Neighbours were not renumbered — that is the whole point.
    expect(readOrderKey(stories.get(1))).toBe(keyB);
    expect(readOrderKey(stories.get(2))).toBe(keyC);
  });

  it("stays put across further reorders of other stories", () => {
    const ydoc = new Y.Doc();
    seedStories(ydoc, ["a", "b", "c", "d"]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    ydoc.transact(() => reorderByOrderKey(stories, 3, 1), null); // a d b c
    expect(slugsInOrder(ydoc)).toEqual(["a", "d", "b", "c"]);
    ydoc.transact(() => reorderByOrderKey(stories, 0, 3), null); // d b c a
    expect(slugsInOrder(ydoc)).toEqual(["d", "b", "c", "a"]);
    ydoc.transact(() => reorderByOrderKey(stories, 3, 0), null); // a d b c
    expect(slugsInOrder(ydoc)).toEqual(["a", "d", "b", "c"]);
  });

  it("is a no-op when the indices match or fall outside the list", () => {
    const ydoc = new Y.Doc();
    seedStories(ydoc, ["a", "b", "c"]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    const keys = orderedStoryMaps(stories).map(readOrderKey);
    ydoc.transact(() => {
      reorderByOrderKey(stories, 1, 1);
      reorderByOrderKey(stories, -1, 0);
      reorderByOrderKey(stories, 3, 0);
      reorderByOrderKey(stories, 0, 9);
    }, null);
    expect(orderedStoryMaps(stories).map(readOrderKey)).toEqual(keys);
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrent reorder
// ---------------------------------------------------------------------------

describe("two clients reordering the same story list concurrently", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
  });

  it("converges with no duplicate _id, no revert and no violation strike", () => {
    // Server doc with the delete rule installed, as the DO runs it.
    const server = new Y.Doc();
    seedStories(server, ["a", "b", "c"], 1); // all convenor-owned
    server.getArray<Y.Map<unknown>>("stories").forEach((m, i) => {
      server.transact(() => m.set("_id", 100 + i), null);
    });

    const sockets: FakeWS[] = [];
    const warns: string[] = [];
    const closes: number[] = [];
    const isReverting = { value: false };
    const recordViolation = makeViolationCounter();
    let violationCalls = 0;
    server.on(
      "afterTransaction",
      makeCanDeleteHandler({
        ydoc: server,
        isSnapshotting: () => false,
        isReverting: () => isReverting.value,
        setReverting: (v: boolean) => { isReverting.value = v; },
        getSockets: () => sockets as unknown as Iterable<WebSocket>,
        broadcastUpdate: () => { /* not asserted here */ },
        recordViolation: (ws: WebSocket) => {
          violationCalls += 1;
          return recordViolation(ws);
        },
        warn: (msg: string) => { warns.push(msg); },
      }),
    );

    // Two clients, both synced from the server's current state.
    const clientA = new Y.Doc();
    const clientB = new Y.Doc();
    const base = Y.encodeStateAsUpdate(server);
    Y.applyUpdate(clientA, base);
    Y.applyUpdate(clientB, base);

    const wsA = fakeSocket(2, "collaborator");
    const wsB = fakeSocket(3, "collaborator");
    sockets.push(wsA, wsB);
    wsA.close = vi.fn(() => { closes.push(2); });
    wsB.close = vi.fn(() => { closes.push(3); });

    // Concurrent drags, neither seeing the other.
    const beforeA = Y.encodeStateVector(clientA);
    const beforeB = Y.encodeStateVector(clientB);
    clientA.transact(() => reorderByOrderKey(clientA.getArray("stories"), 0, 2), null);
    clientB.transact(() => reorderByOrderKey(clientB.getArray("stories"), 2, 0), null);
    const updateA = Y.encodeStateAsUpdate(clientA, beforeA);
    const updateB = Y.encodeStateAsUpdate(clientB, beforeB);

    // The DO applies each with the originating socket as transaction origin.
    Y.applyUpdate(server, updateA, wsA);
    Y.applyUpdate(server, updateB, wsB);

    // Converged: everyone sees the same list.
    Y.applyUpdate(clientA, updateB);
    Y.applyUpdate(clientB, updateA);
    const serverOrder = slugsInOrder(server);
    expect(slugsInOrder(clientA)).toEqual(serverOrder);
    expect(slugsInOrder(clientB)).toEqual(serverOrder);

    // No duplicate maps, no duplicate row ids.
    const stories = server.getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(3);
    const ids = stories.map((m) => m.get("_id"));
    expect(new Set(ids).size).toBe(3);
    const slugs = stories.map((m) => m.get("story_id"));
    expect(new Set(slugs).size).toBe(3);

    // No revert, no warning, no strike, no closed socket.
    expect(warns).toEqual([]);
    expect(violationCalls).toBe(0);
    expect(closes).toEqual([]);
    expect(wsA.close).not.toHaveBeenCalled();
    expect(wsB.close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Backfill on load
// ---------------------------------------------------------------------------

describe("backfillOrderKeys — self-healing a document from the wild", () => {
  function legacyDoc(specs: Array<Record<string, unknown>>): Y.Doc {
    const ydoc = new Y.Doc();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    ydoc.transact(() => {
      for (const spec of specs) {
        const m = new Y.Map<unknown>();
        m.set("story_id", spec.story_id);
        if (spec.order !== undefined) m.set("order", spec.order);
        if (spec.order_key !== undefined) m.set(ORDER_KEY, spec.order_key);
        stories.push([m]);
      }
    }, null);
    return ydoc;
  }

  it("assigns keys in array order when every key is absent", () => {
    const ydoc = legacyDoc([
      { story_id: "one", order: 0 },
      { story_id: "two", order: 1 },
      { story_id: "three", order: 2 },
    ]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    const healed = ydoc.transact(() => backfillOrderKeys(stories), null);
    expect(healed).toBe(3);
    expect(slugsInOrder(ydoc)).toEqual(["one", "two", "three"]);
    for (let i = 0; i < stories.length; i++) {
      expect(isValidOrderKey(readOrderKey(stories.get(i)))).toBe(true);
    }
  });

  it("keeps the visual order of a doc whose `order` values are all zero", () => {
    const ydoc = legacyDoc([
      { story_id: "one", order: 0 },
      { story_id: "two", order: 0 },
      { story_id: "three", order: 0 },
    ]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    ydoc.transact(() => backfillOrderKeys(stories), null);
    expect(slugsInOrder(ydoc)).toEqual(["one", "two", "three"]);
  });

  it("keeps the visual order of a doc whose `order` values are duplicated", () => {
    const ydoc = legacyDoc([
      { story_id: "one", order: 3 },
      { story_id: "two", order: 3 },
      { story_id: "three", order: 1 },
    ]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    ydoc.transact(() => backfillOrderKeys(stories), null);
    // The integer column is not consulted: array order is the only order the
    // pre-conversion readers presented, so it is what self-heals.
    expect(slugsInOrder(ydoc)).toEqual(["one", "two", "three"]);
  });

  it("repairs duplicate order_key values without reshuffling the list", () => {
    const dup = generateKeyBetween(null, null);
    const ydoc = legacyDoc([
      { story_id: "one", order_key: dup },
      { story_id: "two", order_key: dup },
      { story_id: "three", order_key: generateKeyBetween(dup, null) },
    ]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    const healed = ydoc.transact(() => backfillOrderKeys(stories), null);
    expect(healed).toBeGreaterThan(0);
    expect(slugsInOrder(ydoc)).toEqual(["one", "two", "three"]);
    const keys = orderedStoryMaps(stories).map(readOrderKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("writes nothing to a healthy doc, including one already reordered", () => {
    const ydoc = new Y.Doc();
    seedStories(ydoc, ["a", "b", "c"]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    ydoc.transact(() => reorderByOrderKey(stories, 0, 2), null);
    const before = orderedStoryMaps(stories).map(readOrderKey);

    let updates = 0;
    ydoc.on("update", () => { updates += 1; });
    const healed = ydoc.transact(() => backfillOrderKeys(stories), null);

    expect(healed).toBe(0);
    expect(updates).toBe(0);
    // The reorder is NOT undone by a heal that mistakes array order for truth.
    expect(orderedStoryMaps(stories).map(readOrderKey)).toEqual(before);
    expect(slugsInOrder(ydoc)).toEqual(["b", "c", "a"]);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const ydoc = legacyDoc([
      { story_id: "one" }, { story_id: "two" }, { story_id: "three" },
    ]);
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    ydoc.transact(() => backfillOrderKeys(stories), null);
    const after = orderedStoryMaps(stories).map(readOrderKey);
    const healed = ydoc.transact(() => backfillOrderKeys(stories), null);
    expect(healed).toBe(0);
    expect(orderedStoryMaps(stories).map(readOrderKey)).toEqual(after);
  });
});

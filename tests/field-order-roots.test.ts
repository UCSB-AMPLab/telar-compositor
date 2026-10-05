/**
 * field-order-roots.test.ts — the five remaining collaborative lists ordered by
 * a field rather than by array position: steps, layers, objects, pages,
 * glossary.
 *
 * Stories went first (tests/story-order-field.test.ts). The defect is
 * structural: the own-content rule forbids deleting another member's content,
 * and a clone-delete-insert reorder is indistinguishable from a
 * delete-and-replace, so the rule carried an exemption keyed on `_temp_id` and
 * `created_by` — both client-writable. The exemption could not go while any
 * root still reordered that way. These are the roots that still did.
 *
 * A literally empty `tr.deleteSet` is not attainable for ANY field write:
 * overwriting a Y.Map key tombstones the superseded value (one struct of
 * length 1). What IS attainable, and what the exemption actually turned on, is
 * that no Y.Map is removed from a protected Y.Array. Both are pinned per root.
 *
 * Two of the five (objects, glossary) have no drag affordance today; layers
 * has none either. They are converted anyway, because the exemption is removed
 * for the whole document, not per root, and because their D1 rank and their
 * editor order both stop being an accident of the Y.Array once the key exists.
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
  orderedEntries,
  orderedMaps,
  readOrderKey,
  reorderByOrderKey,
} from "~/lib/field-order";
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

/**
 * The five roots, each described by how to reach its Y.Array in a document and
 * what its human key is called. `prepare` runs once per document and creates
 * whatever parent the array hangs off; `resolve` finds the array again in a
 * document that was synced from another one.
 */
interface RootSpec {
  root: string;
  keyField: string;
  /** Create the parents this array needs. Must be idempotent per document. */
  prepare: (ydoc: Y.Doc) => void;
  resolve: (ydoc: Y.Doc) => Y.Array<Y.Map<unknown>>;
  /** Fill an entry's non-ordering fields, as its production factory would. */
  fill: (m: Y.Map<unknown>, key: string) => void;
}

function nestedUnderStory(nested: "steps"): RootSpec["prepare"] {
  return (ydoc) => {
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    if (stories.length > 0) return;
    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_id", 900);
      story.set("_temp_id", "t-story");
      story.set("created_by", 1);
      story.set("story_id", "host-story");
      story.set(nested, new Y.Array<Y.Map<unknown>>());
      stories.push([story]);
    }, null);
  };
}

const SPECS: RootSpec[] = [
  {
    root: "steps",
    keyField: "object_id",
    prepare: nestedUnderStory("steps"),
    resolve: (ydoc) =>
      ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>,
    fill: (m, key) => {
      m.set("kind", "media");
      m.set("object_id", key);
      m.set("question", new Y.Text(key));
    },
  },
  {
    root: "layers",
    keyField: "button_label",
    prepare: (ydoc) => {
      const stories = ydoc.getArray<Y.Map<unknown>>("stories");
      if (stories.length > 0) return;
      ydoc.transact(() => {
        const story = new Y.Map<unknown>();
        story.set("_id", 900);
        story.set("_temp_id", "t-story");
        story.set("created_by", 1);
        story.set("story_id", "host-story");
        const steps = new Y.Array<Y.Map<unknown>>();
        const step = new Y.Map<unknown>();
        step.set("_id", 800);
        step.set("_temp_id", "t-step");
        step.set("created_by", 1);
        step.set(ORDER_KEY, generateKeyBetween(null, null));
        step.set("layers", new Y.Array<Y.Map<unknown>>());
        steps.push([step]);
        story.set("steps", steps);
        stories.push([story]);
      }, null);
    },
    resolve: (ydoc) => {
      const steps = ydoc
        .getArray<Y.Map<unknown>>("stories")
        .get(0)
        .get("steps") as Y.Array<Y.Map<unknown>>;
      return steps.get(0).get("layers") as Y.Array<Y.Map<unknown>>;
    },
    fill: (m, key) => {
      m.set("layer_number", 1);
      m.set("button_label", new Y.Text(key));
      m.set("content", new Y.Text(key));
    },
  },
  {
    root: "objects",
    keyField: "object_id",
    prepare: () => { /* root array, nothing to build */ },
    resolve: (ydoc) => ydoc.getArray<Y.Map<unknown>>("objects"),
    fill: (m, key) => {
      m.set("object_id", key);
      m.set("title", new Y.Text(key));
    },
  },
  {
    root: "pages",
    keyField: "slug",
    prepare: () => { /* root array */ },
    resolve: (ydoc) => ydoc.getArray<Y.Map<unknown>>("pages"),
    fill: (m, key) => {
      m.set("slug", key);
      m.set("title", new Y.Text(key));
      m.set("body", new Y.Text(""));
    },
  },
  {
    root: "glossary",
    keyField: "term_id",
    prepare: () => { /* root array */ },
    resolve: (ydoc) => ydoc.getArray<Y.Map<unknown>>("glossary"),
    fill: (m, key) => {
      m.set("term_id", key);
      m.set("title", new Y.Text(key));
      m.set("definition", new Y.Text(""));
    },
  },
];

/** Seed `keys.length` entries owned by `createdBy`, keyed in array order. */
function seed(spec: RootSpec, ydoc: Y.Doc, keys: string[], createdBy = 1): Y.Array<Y.Map<unknown>> {
  spec.prepare(ydoc);
  const arr = spec.resolve(ydoc);
  ydoc.transact(() => {
    for (const key of keys) {
      const m = new Y.Map<unknown>();
      m.set("_id", null);
      m.set("_temp_id", `t-${spec.root}-${key}`);
      m.set("created_by", createdBy);
      spec.fill(m, key);
      m.set(ORDER_KEY, nextOrderKeyAfterLast(arr));
      arr.push([m]);
    }
  }, null);
  return arr;
}

function keysInOrder(spec: RootSpec, ydoc: Y.Doc): string[] {
  return orderedMaps(spec.resolve(ydoc)).map((m) => String(m.get(spec.keyField) ?? ""));
}

// ---------------------------------------------------------------------------
// 1. A reorder removes nothing from the Y.Array
// ---------------------------------------------------------------------------

describe.each(SPECS)("$root — a field-based reorder issues no Y.Array delete", (spec) => {
  it("deletes no protected Y.Map, and tombstones only the superseded key", () => {
    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, ["a", "b", "c"]);
    const before = [arr.get(0), arr.get(1), arr.get(2)];

    let deletedMaps: unknown[] = [];
    let deletedStructTotal = 0;
    let deletedInArray = 0;
    ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      deletedMaps = collectDeletedProtectedMaps(ydoc, tr);
      Y.iterateDeletedStructs(tr, tr.deleteSet, (item) => {
        deletedStructTotal += 1;
        const parent = (item as unknown as { parent?: unknown }).parent;
        if (parent === arr) deletedInArray += 1;
      });
    });

    const socket = fakeSocket(2, "collaborator");
    ydoc.transact(() => reorderByOrderKey(arr, 0, 2), socket);

    // Nothing left the array: same three Y.Map objects, same positions.
    expect(arr.length).toBe(3);
    expect([arr.get(0), arr.get(1), arr.get(2)]).toEqual(before);
    // Nothing the delete rule could ever look at.
    expect(deletedMaps).toEqual([]);
    expect(deletedInArray).toBe(0);
    // The only tombstone is the superseded order_key value.
    expect(deletedStructTotal).toBe(1);
    // And the order actually changed.
    expect(keysInOrder(spec, ydoc)).toEqual(["b", "c", "a"]);
  });

  it("is not an unauthorised delete when a collaborator moves another member's entry", () => {
    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, ["a", "b", "c"], 1); // convenor-owned
    const socket = fakeSocket(2, "collaborator");

    let found: unknown[] = [];
    ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      found = extractUnauthorisedDeletes(ydoc, tr, { userId: 2, role: "collaborator" }, null);
    });

    ydoc.transact(() => reorderByOrderKey(arr, 2, 0), socket);

    expect(found).toEqual([]);
    expect(keysInOrder(spec, ydoc)).toEqual(["c", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Dropping between two neighbours
// ---------------------------------------------------------------------------

describe.each(SPECS)("$root — dropping an entry between two others", (spec) => {
  it("lands between them and leaves both neighbours' keys untouched", () => {
    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, ["a", "b", "c", "d"]);
    const keyB = readOrderKey(arr.get(1))!;
    const keyC = readOrderKey(arr.get(2))!;

    ydoc.transact(() => reorderByOrderKey(arr, 3, 2), fakeSocket(1, "convenor"));

    expect(keysInOrder(spec, ydoc)).toEqual(["a", "b", "d", "c"]);
    const keyD = readOrderKey(arr.get(3))!;
    expect(keyB < keyD).toBe(true);
    expect(keyD < keyC).toBe(true);
    expect(readOrderKey(arr.get(1))).toBe(keyB);
    expect(readOrderKey(arr.get(2))).toBe(keyC);
  });

  it("stays put across further reorders of other entries", () => {
    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, ["a", "b", "c", "d"]);
    ydoc.transact(() => reorderByOrderKey(arr, 3, 1), null);
    expect(keysInOrder(spec, ydoc)).toEqual(["a", "d", "b", "c"]);
    ydoc.transact(() => reorderByOrderKey(arr, 0, 3), null);
    expect(keysInOrder(spec, ydoc)).toEqual(["d", "b", "c", "a"]);
    ydoc.transact(() => reorderByOrderKey(arr, 3, 0), null);
    expect(keysInOrder(spec, ydoc)).toEqual(["a", "d", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrent reorder
// ---------------------------------------------------------------------------

describe.each(SPECS)("$root — two clients reordering concurrently", (spec) => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
  });

  it("converges with no duplicate _id, no revert and no violation strike", () => {
    const server = new Y.Doc();
    const serverArr = seed(spec, server, ["a", "b", "c"], 1);
    server.transact(() => {
      for (let i = 0; i < serverArr.length; i++) serverArr.get(i).set("_id", 100 + i);
    }, null);

    const sockets: FakeWS[] = [];
    const warns: string[] = [];
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

    const clientA = new Y.Doc();
    const clientB = new Y.Doc();
    const base = Y.encodeStateAsUpdate(server);
    Y.applyUpdate(clientA, base);
    Y.applyUpdate(clientB, base);

    const wsA = fakeSocket(2, "collaborator");
    const wsB = fakeSocket(3, "collaborator");
    sockets.push(wsA, wsB);

    const beforeA = Y.encodeStateVector(clientA);
    const beforeB = Y.encodeStateVector(clientB);
    clientA.transact(() => reorderByOrderKey(spec.resolve(clientA), 0, 2), null);
    clientB.transact(() => reorderByOrderKey(spec.resolve(clientB), 2, 0), null);
    const updateA = Y.encodeStateAsUpdate(clientA, beforeA);
    const updateB = Y.encodeStateAsUpdate(clientB, beforeB);

    Y.applyUpdate(server, updateA, wsA);
    Y.applyUpdate(server, updateB, wsB);

    Y.applyUpdate(clientA, updateB);
    Y.applyUpdate(clientB, updateA);
    const serverOrder = keysInOrder(spec, server);
    expect(keysInOrder(spec, clientA)).toEqual(serverOrder);
    expect(keysInOrder(spec, clientB)).toEqual(serverOrder);

    const arr = spec.resolve(server);
    expect(arr.length).toBe(3);
    expect(new Set(arr.map((m) => m.get("_id"))).size).toBe(3);

    expect(warns).toEqual([]);
    expect(violationCalls).toBe(0);
    expect(wsA.close).not.toHaveBeenCalled();
    expect(wsB.close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Backfill on load
// ---------------------------------------------------------------------------

describe.each(SPECS)("$root — backfillOrderKeys heals a document from the wild", (spec) => {
  /** A document as it existed before this change: array position, no keys. */
  function legacyDoc(entries: Array<{ key: string; order_key?: string }>): Y.Doc {
    const ydoc = new Y.Doc();
    spec.prepare(ydoc);
    const arr = spec.resolve(ydoc);
    ydoc.transact(() => {
      for (const entry of entries) {
        const m = new Y.Map<unknown>();
        spec.fill(m, entry.key);
        if (entry.order_key !== undefined) m.set(ORDER_KEY, entry.order_key);
        arr.push([m]);
      }
    }, null);
    return ydoc;
  }

  it("assigns keys in array order when every key is absent", () => {
    const ydoc = legacyDoc([{ key: "one" }, { key: "two" }, { key: "three" }]);
    const arr = spec.resolve(ydoc);
    const healed = ydoc.transact(() => backfillOrderKeys(arr), null);
    expect(healed).toBe(3);
    expect(keysInOrder(spec, ydoc)).toEqual(["one", "two", "three"]);
    for (let i = 0; i < arr.length; i++) {
      expect(isValidOrderKey(readOrderKey(arr.get(i)))).toBe(true);
    }
  });

  it("repairs duplicate keys without reshuffling the list", () => {
    const dup = generateKeyBetween(null, null);
    const ydoc = legacyDoc([
      { key: "one", order_key: dup },
      { key: "two", order_key: dup },
      { key: "three", order_key: generateKeyBetween(dup, null) },
    ]);
    const arr = spec.resolve(ydoc);
    const healed = ydoc.transact(() => backfillOrderKeys(arr), null);
    expect(healed).toBeGreaterThan(0);
    expect(keysInOrder(spec, ydoc)).toEqual(["one", "two", "three"]);
    expect(new Set(orderedMaps(arr).map(readOrderKey)).size).toBe(3);
  });

  it("writes nothing to a healthy list, including one already reordered", () => {
    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, ["a", "b", "c"]);
    ydoc.transact(() => reorderByOrderKey(arr, 0, 2), null);
    const before = orderedMaps(arr).map(readOrderKey);

    let updates = 0;
    ydoc.on("update", () => { updates += 1; });
    const healed = ydoc.transact(() => backfillOrderKeys(arr), null);

    expect(healed).toBe(0);
    expect(updates).toBe(0);
    expect(orderedMaps(arr).map(readOrderKey)).toEqual(before);
    expect(keysInOrder(spec, ydoc)).toEqual(["b", "c", "a"]);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const ydoc = legacyDoc([{ key: "one" }, { key: "two" }, { key: "three" }]);
    const arr = spec.resolve(ydoc);
    ydoc.transact(() => backfillOrderKeys(arr), null);
    const after = orderedMaps(arr).map(readOrderKey);
    const healed = ydoc.transact(() => backfillOrderKeys(arr), null);
    expect(healed).toBe(0);
    expect(orderedMaps(arr).map(readOrderKey)).toEqual(after);
  });

  it("is a no-op on an empty list", () => {
    const ydoc = legacyDoc([]);
    expect(ydoc.transact(() => backfillOrderKeys(spec.resolve(ydoc)), null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The clone-shaped reorder is gone from the client
// ---------------------------------------------------------------------------

describe("the clone-delete-insert reorder helper", () => {
  it("no longer exists — no list reorders by removing its Y.Map", async () => {
    const mod = await import("~/hooks/use-structural-ops");
    expect("reorderInPlace" in mod).toBe(false);
    expect(mod.__test__).not.toHaveProperty("reorderInPlace");
  });
});

/**
 * `orderedMaps` is the one traversal every reader of an entity list goes
 * through, on the server and in the client alike, and until now it assumed
 * both that it was handed a `Y.Array` and that every member of it was a
 * `Y.Map`. Neither holds: the container arrives from a client-writable key
 * (`storyMap.get("steps")`), and Yjs stores plain JSON at an array position as
 * readily as at a map key. `readOrderKey` then calls `.get()` on whatever is
 * there, which is a `TypeError` thrown inside whichever batch the caller is in.
 *
 * `orderedEntries` reports what it refused as well as what it read, because
 * dropping a member silently is the wrong repair on its own — see the
 * reconciler tests in snapshot-malformed-container-preserves-rows.test.ts for
 * what a caller must do with those positions.
 */
describe("orderedEntries is total over what a client can write", () => {
  it("returns nothing for a container that is not a Y.Array, rather than throwing", () => {
    for (const container of [undefined, null, {}, [], "steps", 0, JSON.parse('{"length":2}')]) {
      expect(() => orderedEntries(container)).not.toThrow();
      expect(orderedEntries(container)).toEqual({ maps: [], skipped: [] });
    }
  });

  it("reads the genuine maps and reports the positions of the rest", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray<unknown>("stories");
    const first = new Y.Map<unknown>();
    const second = new Y.Map<unknown>();
    ydoc.transact(() => {
      first.set(ORDER_KEY, "a1");
      second.set(ORDER_KEY, "a0");
      arr.push([first]);
      arr.push([JSON.parse('{"order_key": "a"}') as unknown]);
      arr.push([second]);
    });

    const { maps, skipped } = orderedEntries(arr);
    // Sorted by order key, so `second` comes first — the refused member takes
    // no place in the order at all.
    expect(maps).toEqual([second, first]);
    expect(skipped).toEqual([1]);
  });

  it("orderedMaps is the same read without the positions", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray<unknown>("stories");
    const real = new Y.Map<unknown>();
    ydoc.transact(() => {
      arr.push([JSON.parse("{}") as unknown]);
      arr.push([real]);
    });
    expect(orderedMaps(arr)).toEqual([real]);
  });
});

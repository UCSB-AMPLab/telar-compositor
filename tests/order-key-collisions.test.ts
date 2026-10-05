/**
 * order-key-collisions.test.ts — what the key algebra owes a list two people
 * are dragging at once.
 *
 * A fractional index only orders a collaborative list while its keys stay
 * distinct. Two clients cannot coordinate, so "between A and B" is computed
 * independently on each of them; if that computation is a pure function of
 * its bounds, both clients mint the same string and the list acquires a pair
 * of equal keys. Equal keys have nothing between them, so the next drop aimed
 * at that gap has no key to take and lands somewhere else entirely.
 *
 * This suite fixes both halves: independent mints into one gap must differ,
 * and a drop into a gap between equal keys must still land in that gap. The
 * honest single-client paths — first, middle and last, on every root — are
 * pinned alongside, because a reorder that misplaces an ordinary drag would
 * be far worse than the collision it was meant to cure.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";

import {
  ORDER_KEY,
  backfillOrderKeys,
  nextOrderKeyAfterLast,
  orderedMaps,
  readOrderKey,
  reorderByOrderKey,
} from "~/lib/field-order";
import {
  generateDistinctKeyBetween,
  generateKeyBetween,
  isValidOrderKey,
} from "~/lib/order-key";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The six lists, named by the array a document holds them in and by the field
 * a test reads back to say which entry it is looking at. Nested lists are
 * reached through the parent they hang off, exactly as the application reaches
 * them.
 */
interface ListSpec {
  root: string;
  keyField: string;
  prepare: (ydoc: Y.Doc) => void;
  resolve: (ydoc: Y.Doc) => Y.Array<Y.Map<unknown>>;
}

function rootList(root: string, keyField: string): ListSpec {
  return {
    root,
    keyField,
    prepare: () => {
      /* a root array needs no parent */
    },
    resolve: (ydoc) => ydoc.getArray<Y.Map<unknown>>(root),
  };
}

const SPECS: ListSpec[] = [
  rootList("stories", "story_id"),
  rootList("objects", "object_id"),
  rootList("pages", "slug"),
  rootList("glossary", "term_id"),
  {
    root: "steps",
    keyField: "object_id",
    prepare: (ydoc) => {
      const stories = ydoc.getArray<Y.Map<unknown>>("stories");
      if (stories.length > 0) return;
      ydoc.transact(() => {
        const story = new Y.Map<unknown>();
        story.set("_id", 900);
        story.set("story_id", "host");
        story.set("steps", new Y.Array<Y.Map<unknown>>());
        stories.push([story]);
      }, null);
    },
    resolve: (ydoc) =>
      ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<
        Y.Map<unknown>
      >,
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
        story.set("story_id", "host");
        const steps = new Y.Array<Y.Map<unknown>>();
        const step = new Y.Map<unknown>();
        step.set("_id", 800);
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
  },
];

/** Seed one entry per name, appended in the order given. */
function seed(spec: ListSpec, ydoc: Y.Doc, names: string[]): Y.Array<Y.Map<unknown>> {
  spec.prepare(ydoc);
  const arr = spec.resolve(ydoc);
  ydoc.transact(() => {
    for (const name of names) {
      const m = new Y.Map<unknown>();
      m.set("_id", null);
      m.set(spec.keyField, name);
      m.set(ORDER_KEY, nextOrderKeyAfterLast(arr));
      arr.push([m]);
    }
  }, null);
  return arr;
}

function namesInOrder(spec: ListSpec, ydoc: Y.Doc): string[] {
  return orderedMaps(spec.resolve(ydoc)).map((m) => String(m.get(spec.keyField) ?? ""));
}

function keysOf(arr: Y.Array<Y.Map<unknown>>): Array<string | null> {
  return orderedMaps(arr).map(readOrderKey);
}

/** Exchange every update each document is missing, both ways. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

/** What `arrayMove` would do — the order the caller asked for. */
function expectedOrder(names: string[], oldIndex: number, newIndex: number): string[] {
  const out = names.slice();
  out.splice(newIndex, 0, out.splice(oldIndex, 1)[0]);
  return out;
}

// ---------------------------------------------------------------------------
// 0. The jittered mint stays inside the interval it was asked for
// ---------------------------------------------------------------------------

describe("generateDistinctKeyBetween", () => {
  it("mints a canonical key strictly between its bounds", () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    for (let i = 0; i < 500; i++) {
      const mid = generateDistinctKeyBetween(a, b);
      expect(isValidOrderKey(mid)).toBe(true);
      expect(a < mid).toBe(true);
      expect(mid < b).toBe(true);
    }
  });

  it("stays below the upper bound when the midpoint is a prefix of it", () => {
    // Repeatedly inserting just below the same upper bound is what drives the
    // midpoint into being a prefix of that bound — the one case where an
    // unconstrained random tail would overshoot.
    let lo = generateKeyBetween(null, null);
    const hi = generateKeyBetween(lo, null);
    for (let i = 0; i < 300; i++) {
      const mid = generateDistinctKeyBetween(lo, hi);
      expect(isValidOrderKey(mid)).toBe(true);
      expect(lo < mid).toBe(true);
      expect(mid < hi).toBe(true);
      lo = mid;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives independent callers different keys for the same gap", () => {
    // The jitter is 62^4 * 61 suffixes, so 1000 unseeded draws collide about
    // once in two thousand runs. A fixed byte stream makes the outcome the
    // same on every run, and it still fails for any mint that repeats itself.
    let state = 0x2f6e2b1;
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        arr[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
      }
      return arr;
    }) as typeof crypto.getRandomValues);
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    const minted = new Set<string>();
    for (let i = 0; i < 1000; i++) minted.add(generateDistinctKeyBetween(a, b));
    expect(minted.size).toBe(1000);
  });

  it("handles the unbounded ends without growing without limit", () => {
    let k: string | null = null;
    for (let i = 0; i < 500; i++) {
      k = generateDistinctKeyBetween(k, null);
      expect(isValidOrderKey(k)).toBe(true);
    }
    // The integer part still carries the growth; only the jitter is added.
    expect(k!.length).toBeLessThanOrEqual(10);

    let j: string | null = null;
    for (let i = 0; i < 100; i++) {
      const next = generateDistinctKeyBetween(null, j);
      if (j !== null) expect(next < j).toBe(true);
      j = next;
    }
  });
});

// ---------------------------------------------------------------------------
// 1. Two clients minting into one gap
// ---------------------------------------------------------------------------

describe.each(SPECS)("$root — two clients drop into the same gap", (spec) => {
  it("mint distinct keys, so the merged list has no tie", () => {
    const clientA = new Y.Doc();
    seed(spec, clientA, ["one", "two", "three", "four"]);
    const clientB = new Y.Doc();
    Y.applyUpdate(clientB, Y.encodeStateAsUpdate(clientA));

    // Neither client can see the other's drag: both compute a key between
    // "one" and "two", from bounds that are identical on both replicas.
    clientA.transact(() => reorderByOrderKey(spec.resolve(clientA), 3, 1), null);
    clientB.transact(() => reorderByOrderKey(spec.resolve(clientB), 2, 1), null);

    sync(clientA, clientB);

    const keys = keysOf(spec.resolve(clientA));
    expect(keys.every(isValidOrderKey)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    // Both replicas agree, whatever the merged order turns out to be.
    expect(namesInOrder(spec, clientB)).toEqual(namesInOrder(spec, clientA));
  });
});

// ---------------------------------------------------------------------------
// 2. Dropping into a gap that already has a tie in it
// ---------------------------------------------------------------------------

describe.each(SPECS)("$root — a drop between two equal keys", (spec) => {
  /**
   * A list carrying the tie a pair of concurrent drags leaves behind:
   * "two" and "three" hold the same key, and "five" is about to be dropped
   * between them.
   */
  function tiedList(): { ydoc: Y.Doc; arr: Y.Array<Y.Map<unknown>> } {
    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, ["one", "two", "three", "four", "five"]);
    ydoc.transact(() => {
      const ordered = orderedMaps(arr);
      ordered[2].set(ORDER_KEY, readOrderKey(ordered[1]));
    }, null);
    expect(namesInOrder(spec, ydoc)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
    ]);
    return { ydoc, arr };
  }

  it("lands the entry in the gap the user dropped it into", () => {
    const { ydoc, arr } = tiedList();
    ydoc.transact(() => reorderByOrderKey(arr, 4, 2), null);
    expect(namesInOrder(spec, ydoc)).toEqual([
      "one",
      "two",
      "five",
      "three",
      "four",
    ]);
  });

  it("leaves the list with no duplicate key behind", () => {
    const { ydoc, arr } = tiedList();
    ydoc.transact(() => reorderByOrderKey(arr, 4, 2), null);
    const keys = keysOf(arr);
    expect(keys.every(isValidOrderKey)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("repairs the tie in place, without reshuffling anything else", () => {
    const { ydoc, arr } = tiedList();
    // A drag that does not touch the tied pair still leaves the list ordered
    // and distinct: healing is order-preserving.
    ydoc.transact(() => reorderByOrderKey(arr, 0, 3), null);
    expect(namesInOrder(spec, ydoc)).toEqual([
      "two",
      "three",
      "four",
      "one",
      "five",
    ]);
    expect(new Set(keysOf(arr)).size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 3. The honest paths — an ordinary single-client drag
// ---------------------------------------------------------------------------

describe.each(SPECS)("$root — an ordinary drag", (spec) => {
  const NAMES = ["one", "two", "three", "four", "five"];

  it.each([
    ["to the front", 3, 0],
    ["to the middle", 0, 2],
    ["to the end", 1, 4],
    ["one place up", 2, 1],
    ["one place down", 2, 3],
    ["front to back", 0, 4],
    ["back to front", 4, 0],
  ])("moves an entry %s", (_label, oldIndex, newIndex) => {
    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, NAMES);
    ydoc.transact(() => reorderByOrderKey(arr, oldIndex, newIndex), null);
    expect(namesInOrder(spec, ydoc)).toEqual(
      expectedOrder(NAMES, oldIndex, newIndex),
    );
    expect(new Set(keysOf(arr)).size).toBe(NAMES.length);
    expect(keysOf(arr).every(isValidOrderKey)).toBe(true);
  });

  it("survives 200 random drags with the order asked for every time", () => {
    // Deterministic PRNG so a failure is reproducible.
    let seedValue = 0x51f3a7c;
    const rand = () => {
      seedValue ^= seedValue << 13;
      seedValue >>>= 0;
      seedValue ^= seedValue >> 17;
      seedValue ^= seedValue << 5;
      seedValue >>>= 0;
      return seedValue / 0x100000000;
    };

    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, NAMES);
    let expectedNames = NAMES.slice();
    for (let i = 0; i < 200; i++) {
      const oldIndex = Math.floor(rand() * expectedNames.length);
      const newIndex = Math.floor(rand() * expectedNames.length);
      ydoc.transact(() => reorderByOrderKey(arr, oldIndex, newIndex), null);
      expectedNames = expectedOrder(expectedNames, oldIndex, newIndex);
      expect(namesInOrder(spec, ydoc)).toEqual(expectedNames);
    }
    expect(new Set(keysOf(arr)).size).toBe(NAMES.length);
  });

  it("appends after the last entry, never onto it", () => {
    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, NAMES);
    const appended = nextOrderKeyAfterLast(arr);
    const keys = keysOf(arr).map((k) => k ?? "");
    expect(appended > keys[keys.length - 1]).toBe(true);
    expect(isValidOrderKey(appended)).toBe(true);
  });

  it("writes nothing when a healthy list is dragged nowhere", () => {
    const ydoc = new Y.Doc();
    const arr = seed(spec, ydoc, NAMES);
    let updates = 0;
    ydoc.on("update", () => {
      updates += 1;
    });
    ydoc.transact(() => reorderByOrderKey(arr, 2, 2), null);
    ydoc.transact(() => backfillOrderKeys(arr), null);
    expect(updates).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Two clients appending at the same moment
// ---------------------------------------------------------------------------

describe.each(SPECS)("$root — two clients appending at once", (spec) => {
  it("give their new entries distinct keys", () => {
    const clientA = new Y.Doc();
    seed(spec, clientA, ["one", "two"]);
    const clientB = new Y.Doc();
    Y.applyUpdate(clientB, Y.encodeStateAsUpdate(clientA));

    seed(spec, clientA, ["from-a"]);
    seed(spec, clientB, ["from-b"]);
    sync(clientA, clientB);

    const keys = keysOf(spec.resolve(clientA));
    expect(new Set(keys).size).toBe(4);
    expect(namesInOrder(spec, clientB)).toEqual(namesInOrder(spec, clientA));
  });
});

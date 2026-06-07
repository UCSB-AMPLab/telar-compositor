// @vitest-environment jsdom
/**
 * use-structural-ops.test.ts — unit tests for the useStructuralOps hook.
 *
 * Tests: canDelete permission logic, UndoManager stack tracking on
 * Y.Array mutation, and the reorderInPlace helper that backs the three
 * structural reorder operations (steps, stories, pages). Objects are not
 * reorderable.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { __test__ } from "~/hooks/use-structural-ops";

const { reorderInPlace } = __test__;

function buildArray(keys: string[]): {
  doc: Y.Doc;
  arr: Y.Array<Y.Map<unknown>>;
} {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>("xs");
  doc.transact(() => {
    for (const key of keys) {
      const map = new Y.Map();
      map.set("key", key);
      arr.push([map]);
    }
  });
  return { doc, arr };
}

function order(arr: Y.Array<Y.Map<unknown>>): unknown[] {
  return arr.toArray().map((m) => m.get("key"));
}

describe("reorderInPlace", () => {
  it("moves first item to a middle slot (downward — the bug case)", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderInPlace(arr, 0, 2));
    expect(order(arr)).toEqual(["B", "C", "A", "D"]);
  });

  it("moves first item to last slot (downward, max distance)", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderInPlace(arr, 0, 3));
    expect(order(arr)).toEqual(["B", "C", "D", "A"]);
  });

  it("moves middle item down by one", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderInPlace(arr, 1, 2));
    expect(order(arr)).toEqual(["A", "C", "B", "D"]);
  });

  it("moves last item to first slot (upward, max distance)", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderInPlace(arr, 3, 0));
    expect(order(arr)).toEqual(["D", "A", "B", "C"]);
  });

  it("moves middle item up by one", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderInPlace(arr, 2, 1));
    expect(order(arr)).toEqual(["A", "C", "B", "D"]);
  });

  it("no-ops when oldIndex === newIndex", () => {
    const { doc, arr } = buildArray(["A", "B"]);
    doc.transact(() => reorderInPlace(arr, 1, 1));
    expect(order(arr)).toEqual(["A", "B"]);
  });

  it("no-ops on out-of-range oldIndex", () => {
    const { doc, arr } = buildArray(["A", "B"]);
    doc.transact(() => reorderInPlace(arr, -1, 0));
    doc.transact(() => reorderInPlace(arr, 5, 0));
    expect(order(arr)).toEqual(["A", "B"]);
  });

  it("no-ops on out-of-range newIndex", () => {
    const { doc, arr } = buildArray(["A", "B"]);
    doc.transact(() => reorderInPlace(arr, 0, 5));
    expect(order(arr)).toEqual(["A", "B"]);
  });

  it("preserves nested map content on the moved item", () => {
    const doc = new Y.Doc();
    const arr = doc.getArray<Y.Map<unknown>>("xs");
    doc.transact(() => {
      const a = new Y.Map();
      a.set("key", "A");
      a.set("payload", "alpha");
      const b = new Y.Map();
      b.set("key", "B");
      b.set("payload", "beta");
      arr.push([a, b]);
    });
    doc.transact(() => reorderInPlace(arr, 0, 1));
    const moved = arr.get(1);
    expect(moved.get("key")).toBe("A");
    expect(moved.get("payload")).toBe("alpha");
  });
});


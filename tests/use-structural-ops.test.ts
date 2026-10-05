// @vitest-environment jsdom
/**
 * use-structural-ops.test.ts — unit tests for the useStructuralOps hook.
 *
 * Tests: canDelete permission logic, UndoManager stack tracking on
 * Y.Array mutation, and the field-write reorder that backs the structural
 * reorder operations (stories, steps, pages). Objects are not reorderable.
 *
 * The `reorderInPlace` block below used to pin a clone-delete-insert helper:
 * deep-clone the Y.Map, delete the original, insert the clone. Those tests
 * were pinning the defect. On the wire that transaction is exactly what
 * "delete a colleague's entity and put a hollow one carrying their identity in
 * its place" looks like, which is why the server's delete rule had to carry an
 * exemption decided on client-writable fields. The helper is gone;
 * the same index permutations are asserted here against `reorderByOrderKey`,
 * which changes the list's order without removing anything from the array.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { canDeleteYMap, isCourseItemYMap } from "~/hooks/use-structural-ops";
import { ORDER_KEY, orderedMaps, reorderByOrderKey } from "~/lib/field-order";
import { generateKeyBetween } from "~/lib/order-key";

function buildArray(keys: string[]): {
  doc: Y.Doc;
  arr: Y.Array<Y.Map<unknown>>;
} {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>("xs");
  doc.transact(() => {
    let previous: string | null = null;
    for (const key of keys) {
      const map = new Y.Map();
      map.set("key", key);
      previous = generateKeyBetween(previous, null);
      map.set(ORDER_KEY, previous);
      arr.push([map]);
    }
  });
  return { doc, arr };
}

/** The list as the user sees it — key order, not array position. */
function order(arr: Y.Array<Y.Map<unknown>>): unknown[] {
  return orderedMaps(arr).map((m) => m.get("key"));
}

describe("reorderByOrderKey — the same index permutations, without a delete", () => {
  it("moves first item to a middle slot (downward — the bug case)", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderByOrderKey(arr, 0, 2));
    expect(order(arr)).toEqual(["B", "C", "A", "D"]);
  });

  it("moves first item to last slot (downward, max distance)", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderByOrderKey(arr, 0, 3));
    expect(order(arr)).toEqual(["B", "C", "D", "A"]);
  });

  it("moves middle item down by one", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderByOrderKey(arr, 1, 2));
    expect(order(arr)).toEqual(["A", "C", "B", "D"]);
  });

  it("moves last item to first slot (upward, max distance)", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderByOrderKey(arr, 3, 0));
    expect(order(arr)).toEqual(["D", "A", "B", "C"]);
  });

  it("moves middle item up by one", () => {
    const { doc, arr } = buildArray(["A", "B", "C", "D"]);
    doc.transact(() => reorderByOrderKey(arr, 2, 1));
    expect(order(arr)).toEqual(["A", "C", "B", "D"]);
  });

  it("no-ops when oldIndex === newIndex", () => {
    const { doc, arr } = buildArray(["A", "B"]);
    doc.transact(() => reorderByOrderKey(arr, 1, 1));
    expect(order(arr)).toEqual(["A", "B"]);
  });

  it("no-ops on out-of-range oldIndex", () => {
    const { doc, arr } = buildArray(["A", "B"]);
    doc.transact(() => reorderByOrderKey(arr, -1, 0));
    doc.transact(() => reorderByOrderKey(arr, 5, 0));
    expect(order(arr)).toEqual(["A", "B"]);
  });

  it("no-ops on out-of-range newIndex", () => {
    const { doc, arr } = buildArray(["A", "B"]);
    doc.transact(() => reorderByOrderKey(arr, 0, 5));
    expect(order(arr)).toEqual(["A", "B"]);
  });

  it("moves the very same Y.Map, so nothing inside it is rebuilt", () => {
    // The clone helper this replaced copied every field into a fresh Y.Map,
    // which reset collaborative cursors in the moved item's text fields and
    // produced a delete the server had to be talked out of punishing. A field
    // write leaves the Y.Map — and its Y.Text children — untouched.
    const { doc, arr } = buildArray(["A", "B"]);
    const a = arr.get(0);
    doc.transact(() => a.set("payload", new Y.Text("alpha")));
    const payloadBefore = a.get("payload");

    doc.transact(() => reorderByOrderKey(arr, 0, 1));

    expect(order(arr)).toEqual(["B", "A"]);
    // Same object, same Y.Text instance — not a copy that happens to match.
    expect(orderedMaps(arr)[1]).toBe(a);
    expect(a.get("payload")).toBe(payloadBefore);
    expect((a.get("payload") as Y.Text).toString()).toBe("alpha");
  });

  it("removes nothing from the array — the whole reason the helper went", () => {
    const { doc, arr } = buildArray(["A", "B", "C"]);
    let deletedInArray = 0;
    doc.on("afterTransaction", (tr: Y.Transaction) => {
      Y.iterateDeletedStructs(tr, tr.deleteSet, (item) => {
        if ((item as unknown as { parent?: unknown }).parent === arr) deletedInArray += 1;
      });
    });
    doc.transact(() => reorderByOrderKey(arr, 0, 2));
    expect(deletedInArray).toBe(0);
    expect(arr.length).toBe(3);
  });
});


// ---------------------------------------------------------------------------
// canDelete — the client mirror of the DO's enforcement
//
// The course-item clause is checked before the role clause: a marked object
// is undeletable for everyone, convenor included, so the forbidden delete is
// refused in the UI rather than applied, reverted by the DO and — on the
// third attempt in a minute — punished with a closed socket (design §6).
// ---------------------------------------------------------------------------

function objectMap(fields: Record<string, unknown>): Y.Map<unknown> {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>("objects");
  const map = new Y.Map<unknown>();
  arr.push([map]);
  doc.transact(() => {
    for (const [k, v] of Object.entries(fields)) map.set(k, v);
  });
  return map;
}

describe("canDeleteYMap", () => {
  it("lets the convenor delete an unmarked item", () => {
    const m = objectMap({ created_by: 2 });
    expect(canDeleteYMap(m, "convenor", 1)).toBe(true);
  });

  it("lets a collaborator delete their own unmarked item", () => {
    const m = objectMap({ created_by: 2 });
    expect(canDeleteYMap(m, "collaborator", 2)).toBe(true);
  });

  it("refuses a collaborator someone else's unmarked item", () => {
    const m = objectMap({ created_by: 1 });
    expect(canDeleteYMap(m, "collaborator", 2)).toBe(false);
  });

  it("lets an instructor delete their own unmarked item and no one else's", () => {
    expect(canDeleteYMap(objectMap({ created_by: 3 }), "instructor", 3)).toBe(true);
    expect(canDeleteYMap(objectMap({ created_by: 1 }), "instructor", 3)).toBe(false);
  });

  it("refuses a marked course item to the convenor", () => {
    const m = objectMap({ created_by: 1, course_project_id: 7 });
    expect(canDeleteYMap(m, "convenor", 1)).toBe(false);
  });

  it("refuses a marked course item to an instructor who created it", () => {
    const m = objectMap({ created_by: 3, course_project_id: 7 });
    expect(canDeleteYMap(m, "instructor", 3)).toBe(false);
  });

  it("refuses a marked course item to the collaborator who created it", () => {
    const m = objectMap({ created_by: 2, course_project_id: 7 });
    expect(canDeleteYMap(m, "collaborator", 2)).toBe(false);
  });

  it("treats a null or absent marker as unmarked", () => {
    expect(canDeleteYMap(objectMap({ created_by: 1, course_project_id: null }), "convenor", 1)).toBe(true);
    expect(canDeleteYMap(objectMap({ created_by: 1 }), "convenor", 1)).toBe(true);
  });
});

describe("isCourseItemYMap", () => {
  it("is true only for an integer marker", () => {
    expect(isCourseItemYMap(objectMap({ course_project_id: 7 }))).toBe(true);
    expect(isCourseItemYMap(objectMap({ course_project_id: null }))).toBe(false);
    expect(isCourseItemYMap(objectMap({}))).toBe(false);
  });
});

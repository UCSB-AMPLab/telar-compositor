/**
 * `rekeyToOrder` and `orderKeyForSheetPlace`: the two ways a sync puts object
 * rows where GitHub's file has them.
 *
 * `rekeyToOrder` puts the rows a sync names in GitHub's order by writing their
 * `order_key`, moving the fewest rows and leaving every row it does not name in
 * its slot. `orderKeyForSheetPlace` gives a row a sync brings in a key between
 * the rows GitHub has either side of it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  ORDER_KEY,
  orderKeyForSheetPlace,
  orderedMaps,
  readOrderKey,
  rekeyToOrder,
} from "~/lib/field-order";

function docWith(entries: Array<[string, string | null, number?]>): { doc: Y.Doc; arr: Y.Array<Y.Map<unknown>> } {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>("objects");
  doc.transact(() => {
    for (const [objectId, key, id] of entries) {
      const m = new Y.Map<unknown>();
      m.set("object_id", objectId);
      if (key !== null) m.set(ORDER_KEY, key);
      m.set("_id", id ?? null);
      arr.push([m]);
    }
  });
  return { doc, arr };
}

function idsInOrder(arr: Y.Array<Y.Map<unknown>>): string[] {
  return orderedMaps(arr).map((m) => String(m.get("object_id")));
}

function byId(arr: Y.Array<Y.Map<unknown>>, objectId: string): Y.Map<unknown> {
  return arr.toArray().find((m) => m.get("object_id") === objectId)!;
}

describe("rekeyToOrder", () => {
  it("writes one key for a swap of two rows", () => {
    const { doc, arr } = docWith([["a", "a1"], ["b", "a2"], ["c", "a3"]]);
    let written = 0;
    doc.transact(() => {
      written = rekeyToOrder(orderedMaps(arr), [byId(arr, "b"), byId(arr, "a"), byId(arr, "c")]);
    });
    expect(idsInOrder(arr)).toEqual(["b", "a", "c"]);
    expect(written).toBe(1);
  });

  it("writes one key for a row moved from last to first", () => {
    const { doc, arr } = docWith([["a", "a1"], ["b", "a2"], ["c", "a3"], ["d", "a4"]]);
    let written = 0;
    doc.transact(() => {
      written = rekeyToOrder(orderedMaps(arr), ["d", "a", "b", "c"].map((id) => byId(arr, id)));
    });
    expect(idsInOrder(arr)).toEqual(["d", "a", "b", "c"]);
    expect(written).toBe(1);
  });

  it("leaves a row only the Compositor holds with its key and its neighbours", () => {
    // mine sits between b and c; GitHub moves a to the end.
    const { doc, arr } = docWith([["a", "a1"], ["b", "a2"], ["mine", "a3"], ["c", "a4"]]);
    doc.transact(() => {
      rekeyToOrder(orderedMaps(arr), ["b", "c", "a"].map((id) => byId(arr, id)));
    });
    // The wanted rows fill the slots a, b, c held (1st, 2nd, 4th), in GitHub's
    // order: b, c, then mine in its own slot, then a.
    expect(idsInOrder(arr)).toEqual(["b", "c", "mine", "a"]);
    expect(readOrderKey(byId(arr, "mine"))).toBe("a3");
  });

  it("writes nothing when the order already matches", () => {
    const { doc, arr } = docWith([["a", "a1"], ["b", "a2"]]);
    let written = -1;
    doc.transact(() => {
      written = rekeyToOrder(orderedMaps(arr), [byId(arr, "a"), byId(arr, "b")]);
    });
    expect(written).toBe(0);
    expect(readOrderKey(byId(arr, "a"))).toBe("a1");
    expect(readOrderKey(byId(arr, "b"))).toBe("a2");
  });

  it("heals a list with duplicate keys first, then orders it", () => {
    const { doc, arr } = docWith([["a", "a1"], ["b", "a1"], ["c", "a1"]]);
    doc.transact(() => {
      rekeyToOrder(orderedMaps(arr), ["c", "b", "a"].map((id) => byId(arr, id)));
    });
    expect(idsInOrder(arr)).toEqual(["c", "b", "a"]);
    const keys = orderedMaps(arr).map(readOrderKey);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("orderKeyForSheetPlace", () => {
  function heldBy(arr: Y.Array<Y.Map<unknown>>, extra: Map<string, Y.Map<unknown>> = new Map()) {
    return (entry: { objectId: string; docId?: number }): Y.Map<unknown> | null => {
      if (entry.docId === undefined) return extra.get(entry.objectId) ?? null;
      return arr.toArray().find((m) => m.get("object_id") === entry.objectId && m.get("_id") === entry.docId) ?? null;
    };
  }

  function place(arr: Y.Array<Y.Map<unknown>>, doc: Y.Doc, objectId: string, key: string): Y.Map<unknown> {
    const m = new Y.Map<unknown>();
    doc.transact(() => {
      m.set("object_id", objectId);
      m.set(ORDER_KEY, key);
      m.set("_id", null);
      arr.push([m]);
    });
    return m;
  }

  it("places a new row between two held neighbours found by D1 id", () => {
    const { doc, arr } = docWith([["a", "a1", 1], ["b", "a2", 2]]);
    const sheet = [{ objectId: "a", docId: 1 }, { objectId: "new" }, { objectId: "b", docId: 2 }];
    place(arr, doc, "new", orderKeyForSheetPlace(arr, sheet, 1, heldBy(arr)));
    expect(idsInOrder(arr)).toEqual(["a", "new", "b"]);
  });

  it("places a row at the head of the sheet before every held row", () => {
    const { doc, arr } = docWith([["a", "a1", 1], ["b", "a2", 2]]);
    const sheet = [{ objectId: "new" }, { objectId: "a", docId: 1 }, { objectId: "b", docId: 2 }];
    place(arr, doc, "new", orderKeyForSheetPlace(arr, sheet, 0, heldBy(arr)));
    expect(idsInOrder(arr)).toEqual(["new", "a", "b"]);
  });

  it("places a row at the tail of the sheet after the last held row", () => {
    const { doc, arr } = docWith([["a", "a1", 1], ["b", "a2", 2]]);
    const sheet = [{ objectId: "a", docId: 1 }, { objectId: "b", docId: 2 }, { objectId: "new" }];
    place(arr, doc, "new", orderKeyForSheetPlace(arr, sheet, 2, heldBy(arr)));
    expect(idsInOrder(arr)).toEqual(["a", "b", "new"]);
  });

  it("keeps GitHub's order for a run of three new rows placed in sheet order", () => {
    const { doc, arr } = docWith([["a", "a1", 1], ["b", "a2", 2]]);
    const sheet = [
      { objectId: "a", docId: 1 }, { objectId: "n1" }, { objectId: "n2" }, { objectId: "n3" }, { objectId: "b", docId: 2 },
    ];
    const inserted = new Map<string, Y.Map<unknown>>();
    for (const [at, id] of [[1, "n1"], [2, "n2"], [3, "n3"]] as const) {
      inserted.set(id, place(arr, doc, id, orderKeyForSheetPlace(arr, sheet, at, heldBy(arr, inserted))));
    }
    expect(idsInOrder(arr)).toEqual(["a", "n1", "n2", "n3", "b"]);
  });

  it("places a new map before a held map.jpg, and after it", () => {
    const before = docWith([["x", "a1", 1], ["map.jpg", "a2", 2]]);
    const sheetBefore = [{ objectId: "x", docId: 1 }, { objectId: "map" }, { objectId: "map.jpg", docId: 2 }];
    place(before.arr, before.doc, "map", orderKeyForSheetPlace(before.arr, sheetBefore, 1, heldBy(before.arr)));
    expect(idsInOrder(before.arr)).toEqual(["x", "map", "map.jpg"]);

    const after = docWith([["map.jpg", "a1", 2], ["x", "a2", 1]]);
    const sheetAfter = [{ objectId: "map.jpg", docId: 2 }, { objectId: "map" }, { objectId: "x", docId: 1 }];
    place(after.arr, after.doc, "map", orderKeyForSheetPlace(after.arr, sheetAfter, 1, heldBy(after.arr)));
    expect(idsInOrder(after.arr)).toEqual(["map.jpg", "map", "x"]);
  });

  it("appends when no neighbour on either side is held", () => {
    const { doc, arr } = docWith([["a", "a1", 1], ["b", "a2", 2]]);
    const sheet = [{ objectId: "new" }];
    place(arr, doc, "new", orderKeyForSheetPlace(arr, sheet, 0, heldBy(arr)));
    expect(idsInOrder(arr)).toEqual(["a", "b", "new"]);
  });

  it("takes a key after the lower bound when the bounds are out of order", () => {
    // GitHub: a, new, b. The document holds b before a, as if it changed after
    // the order was applied; the row lands right after a.
    const { doc, arr } = docWith([["b", "a1", 2], ["a", "a2", 1], ["c", "a3", 3]]);
    const sheet = [{ objectId: "a", docId: 1 }, { objectId: "new" }, { objectId: "b", docId: 2 }];
    place(arr, doc, "new", orderKeyForSheetPlace(arr, sheet, 1, heldBy(arr)));
    expect(idsInOrder(arr)).toEqual(["b", "a", "new", "c"]);
  });
});

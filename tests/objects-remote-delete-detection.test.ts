/**
 * objects-remote-delete-detection.test.ts — pins the keying contract behind
 * the Objects route's remote-delete toast.
 *
 * @version v1.4.1-beta
 *
 * The observer in `_app.objects.tsx` compares the previous and current
 * key sets of the Yjs object list; a key present in `prev` but missing from
 * `curr` is read as a remote deletion and fires a "deleted" toast. The key
 * comes from the shared `keyFor` helper.
 *
 * When `keyFor` keyed on the numeric D1 `id` first, a freshly-created object
 * (id 0 + UUID `_tempId`) had its key flip from the UUID to the numeric id the
 * moment snapshotToD1 backfilled the row id (~30s after creation). The observer
 * then saw the old key vanish and fired a false "object deleted" toast at the
 * creator and every connected peer. `keyFor` keys on `_tempId` first, so the
 * key is stable across the backfill and no false deletion is reported.
 *
 * These tests reproduce the observer's compare-prev/curr logic exactly (the
 * same `keyFor` + `title ?? object_id` map it builds) and assert that a
 * backfill is NOT mistaken for a deletion, while a genuine removal still is.
 */

import { describe, it, expect } from "vitest";
import { keyFor } from "~/lib/item-key";

interface ObjectRow {
  id: number;
  object_id: string;
  title?: string | null;
  _tempId?: string | null;
  _yIndex?: number;
}

/**
 * Faithful copy of the effect body in `_app.objects.tsx`: build the current
 * key -> label map, diff it against the previous map, and return both the
 * detected deletions (by label) and the map to carry forward as `prev`.
 */
function detectDeletions(
  prev: Map<string, string>,
  list: ObjectRow[],
): { deleted: string[]; next: Map<string, string> } {
  const curr = new Map<string, string>();
  for (const o of list) curr.set(String(keyFor(o)), o.title ?? o.object_id);
  const deleted: string[] = [];
  prev.forEach((title, key) => {
    if (!curr.has(key)) deleted.push(title);
  });
  return { deleted, next: curr };
}

describe("objects remote-delete detection", () => {
  it("keeps a stable key across the snapshotToD1 id backfill", () => {
    const beforeBackfill: ObjectRow = {
      id: 0,
      object_id: "mapa-01",
      title: "Mapa de Bogotá",
      _tempId: "uuid-A",
      _yIndex: 0,
    };
    const afterBackfill: ObjectRow = {
      ...beforeBackfill,
      id: 42, // snapshotToD1 backfilled the real D1 row id
    };
    const keyBefore = String(keyFor(beforeBackfill));
    const keyAfter = String(keyFor(afterBackfill));
    expect(keyBefore).toBe("uuid-A");
    expect(keyAfter).toBe("uuid-A");
    expect(keyBefore).toBe(keyAfter);
  });

  it("does NOT flag a deletion when a new object's id is backfilled", () => {
    // Snapshot the list just after creation (id 0, _tempId set)...
    const created: ObjectRow[] = [
      { id: 0, object_id: "mapa-01", title: "Mapa", _tempId: "uuid-A", _yIndex: 0 },
    ];
    const { next: prev } = detectDeletions(new Map(), created);

    // ...then snapshot it again after the backfill assigns a real id.
    const backfilled: ObjectRow[] = [
      { id: 42, object_id: "mapa-01", title: "Mapa", _tempId: "uuid-A", _yIndex: 0 },
    ];
    const { deleted } = detectDeletions(prev, backfilled);

    expect(deleted).toEqual([]);
  });

  it("does NOT flag deletions when several objects are backfilled at once", () => {
    const created: ObjectRow[] = [
      { id: 0, object_id: "a", title: "A", _tempId: "uuid-A", _yIndex: 0 },
      { id: 0, object_id: "b", title: "B", _tempId: "uuid-B", _yIndex: 1 },
    ];
    const { next: prev } = detectDeletions(new Map(), created);

    const backfilled: ObjectRow[] = [
      { id: 7, object_id: "a", title: "A", _tempId: "uuid-A", _yIndex: 0 },
      { id: 8, object_id: "b", title: "B", _tempId: "uuid-B", _yIndex: 1 },
    ];
    const { deleted } = detectDeletions(prev, backfilled);

    expect(deleted).toEqual([]);
  });

  it("still flags a genuine remote removal", () => {
    const before: ObjectRow[] = [
      { id: 7, object_id: "a", title: "A", _tempId: "uuid-A", _yIndex: 0 },
      { id: 8, object_id: "b", title: "B", _tempId: "uuid-B", _yIndex: 1 },
    ];
    const { next: prev } = detectDeletions(new Map(), before);

    // Object B is removed from the Y.Array by a remote peer.
    const after: ObjectRow[] = [
      { id: 7, object_id: "a", title: "A", _tempId: "uuid-A", _yIndex: 0 },
    ];
    const { deleted } = detectDeletions(prev, after);

    expect(deleted).toEqual(["B"]);
  });

  it("falls back to object_id as the toast label when title is missing", () => {
    const before: ObjectRow[] = [
      { id: 9, object_id: "untitled-01", title: null, _tempId: "uuid-C", _yIndex: 0 },
    ];
    const { next: prev } = detectDeletions(new Map(), before);
    const { deleted } = detectDeletions(prev, []);
    expect(deleted).toEqual(["untitled-01"]);
  });
});

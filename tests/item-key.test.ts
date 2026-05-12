/**
 * keyFor — stability of the React key across snapshotToD1's `_id` backfill.
 *
 * The original inline keyFor in `_app.pages.tsx` (and still in `_app.stories.tsx`
 * until 37-05) used `id > 0 ? id : _tempId ?? ...`, so a freshly-created item
 * had its key flip from a UUID to a numeric string when the snapshot cycle
 * backfilled the D1 row id. The deletion-detection observer that compares
 * prev/curr key sets then fired a false "deleted" toast.
 *
 * These tests pin the contract: `_tempId` always wins when present, so the key
 * stays constant from creation through backfill. Loaded-from-D1 items
 * (_tempId: null) fall back to the numeric id; unidentified items fall back
 * to a `_yIndex`-based string.
 */

import { describe, it, expect } from "vitest";
import { keyFor } from "~/lib/item-key";

describe("keyFor", () => {
  it("uses _tempId when present (pre-backfill state)", () => {
    expect(
      keyFor({ id: 0, _tempId: "uuid-A", _yIndex: 0 })
    ).toBe("uuid-A");
  });

  it("STILL uses _tempId after the _id backfill — key remains stable", () => {
    // Same logical item, before and after snapshotToD1 backfills the row id.
    // The whole point of the helper: the key MUST NOT change.
    const before = keyFor({ id: 0, _tempId: "uuid-A", _yIndex: 0 });
    const after = keyFor({ id: 12, _tempId: "uuid-A", _yIndex: 0 });
    expect(before).toBe("uuid-A");
    expect(after).toBe("uuid-A");
    expect(before).toBe(after);
  });

  it("falls back to numeric id for items loaded from D1 (no _tempId)", () => {
    expect(keyFor({ id: 11, _tempId: null, _yIndex: 0 })).toBe("11");
  });

  it("falls back to numeric id when _tempId is undefined", () => {
    expect(keyFor({ id: 11 })).toBe("11");
  });

  it("falls back to idx-N when neither id nor _tempId identifies the item", () => {
    expect(keyFor({ id: 0, _tempId: null, _yIndex: 3 })).toBe("idx-3");
  });

  it("uses idx-0 when _yIndex is undefined and the item has no id or _tempId", () => {
    expect(keyFor({ id: 0 })).toBe("idx-0");
  });

  it("ignores empty-string _tempId (treats as missing)", () => {
    // Defensive: an empty string would be falsy under the `_tempId ?? id`
    // check we replaced, but we still want id to win in that defensive case.
    expect(keyFor({ id: 7, _tempId: "" })).toBe("7");
  });

  it("returns string for all branches (no number leakage into React keys)", () => {
    // The previous stories keyFor returned `string | number`. Standardise on
    // `string` to avoid mixed-type comparison surprises in dnd-kit / React.
    expect(typeof keyFor({ id: 1 })).toBe("string");
    expect(typeof keyFor({ id: 0, _tempId: "u" })).toBe("string");
    expect(typeof keyFor({ id: 0, _yIndex: 5 })).toBe("string");
  });
});

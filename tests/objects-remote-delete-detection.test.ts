// @vitest-environment jsdom
/**
 * objects-remote-delete-detection.test.ts — pins the remote-delete toast
 * behaviour as wired at the Objects route's call site.
 *
 * @version v1.4.1-beta
 *
 * The Objects route feeds its Yjs object list into the shared
 * `useRemoteDeleteToast` hook with the label function `title ?? object_id`. The
 * hook compares the previous and current key sets of the list; a key present in
 * `prev` but missing from `curr` is read as a remote deletion and fires a
 * generic destructive toast. Keys come from the shared `keyFor` helper.
 *
 * When `keyFor` keyed on the numeric D1 `id` first, a freshly-created object
 * (id 0 + UUID `_tempId`) had its key flip from the UUID to the numeric id the
 * moment snapshotToD1 backfilled the row id (~30s after creation). The hook
 * would then see the old key vanish and fire a false "object deleted" toast at
 * the creator and every connected peer. `keyFor` keys on `_tempId` first, so
 * the key is stable across the backfill and no false deletion is reported.
 *
 * These tests drive the real hook with the Objects route's exact label function
 * and assert that a backfill is NOT mistaken for a deletion, that a genuine
 * removal still is, and that the `title ?? object_id` fallback names the toast.
 * The shared hook is also covered generically in tests/use-remote-delete-toast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const showToastMock = vi.fn();
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: showToastMock, dismissToast: () => {} }),
}));
const stableT = (key: string, vars?: Record<string, unknown>) =>
  `${key}:${JSON.stringify(vars ?? {})}`;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: stableT }),
}));

import { useRemoteDeleteToast } from "~/hooks/use-remote-delete-toast";
import { keyFor } from "~/lib/item-key";

interface ObjectRow {
  id: number;
  object_id: string;
  title?: string | null;
  _tempId?: string | null;
  _yIndex?: number;
}

// The Objects route's exact call-site label function.
const getLabel = (o: ObjectRow) => o.title ?? o.object_id;

/** Deleted-item labels reported across a prev -> curr list transition. */
function deletedLabels(prev: ObjectRow[], curr: ObjectRow[]): string[] {
  const { rerender } = renderHook(
    ({ items }) => useRemoteDeleteToast({ items, enabled: true, getLabel }),
    { initialProps: { items: prev } },
  );
  rerender({ items: curr });
  return showToastMock.mock.calls.map((c) => String(c[0].message));
}

describe("objects remote-delete detection", () => {
  beforeEach(() => {
    showToastMock.mockReset();
  });

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
    expect(keyFor(beforeBackfill)).toBe("uuid-A");
    expect(keyFor(afterBackfill)).toBe("uuid-A");
    expect(keyFor(beforeBackfill)).toBe(keyFor(afterBackfill));
  });

  it("does NOT flag a deletion when a new object's id is backfilled", () => {
    const created: ObjectRow[] = [
      { id: 0, object_id: "mapa-01", title: "Mapa", _tempId: "uuid-A", _yIndex: 0 },
    ];
    const backfilled: ObjectRow[] = [
      { id: 42, object_id: "mapa-01", title: "Mapa", _tempId: "uuid-A", _yIndex: 0 },
    ];
    expect(deletedLabels(created, backfilled)).toEqual([]);
  });

  it("does NOT flag deletions when several objects are backfilled at once", () => {
    const created: ObjectRow[] = [
      { id: 0, object_id: "a", title: "A", _tempId: "uuid-A", _yIndex: 0 },
      { id: 0, object_id: "b", title: "B", _tempId: "uuid-B", _yIndex: 1 },
    ];
    const backfilled: ObjectRow[] = [
      { id: 7, object_id: "a", title: "A", _tempId: "uuid-A", _yIndex: 0 },
      { id: 8, object_id: "b", title: "B", _tempId: "uuid-B", _yIndex: 1 },
    ];
    expect(deletedLabels(created, backfilled)).toEqual([]);
  });

  it("still flags a genuine remote removal, naming it via the generic key", () => {
    const before: ObjectRow[] = [
      { id: 7, object_id: "a", title: "A", _tempId: "uuid-A", _yIndex: 0 },
      { id: 8, object_id: "b", title: "B", _tempId: "uuid-B", _yIndex: 1 },
    ];
    // Object B is removed from the Y.Array by a remote peer.
    const after: ObjectRow[] = [
      { id: 7, object_id: "a", title: "A", _tempId: "uuid-A", _yIndex: 0 },
    ];
    const labels = deletedLabels(before, after);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("toast_item_deleted_generic");
    expect(labels[0]).toContain("B");
  });

  it("falls back to object_id as the toast label when title is missing", () => {
    const before: ObjectRow[] = [
      { id: 9, object_id: "untitled-01", title: null, _tempId: "uuid-C", _yIndex: 0 },
    ];
    const labels = deletedLabels(before, []);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("untitled-01");
  });
});

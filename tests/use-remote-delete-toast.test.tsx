// @vitest-environment jsdom
/**
 * use-remote-delete-toast.test.tsx — pins the remote-delete toast behaviour
 * shared by the Objects, Stories, and Pages list routes.
 *
 * The logic used to be inlined in three route modules that break vitest suite
 * collection when imported (server-only deps in their import graph). Extracting
 * it into `useRemoteDeleteToast` makes it render-testable in isolation: these
 * tests drive the real hook via renderHook and assert on the toast it fires.
 *
 * Covered cases:
 *   - an item disappearing fires one generic, destructive toast with its label
 *   - an id-0 -> real-id backfill (same _tempId) fires nothing (the false-
 *     deletion bug the shared keyFor helper exists to prevent)
 *   - a reorder-shaped change (same keys, new order, fresh object identities)
 *     fires nothing WITHOUT any suppression flag — the guard is not load-bearing
 *   - a set suppression flag (Stories' reorder guard) fires nothing
 *   - first mount with a populated list fires nothing (no prior keys to diff)
 *   - several simultaneous deletions fire one toast each
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const showToastMock = vi.fn();
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: showToastMock, dismissToast: () => {} }),
}));
// Stable `t` reference across renders — mirrors real useTranslation(), which
// returns the same `t` for the lifetime of a language. It echoes the key and
// interpolation vars so assertions can inspect both.
const stableT = (key: string, vars?: Record<string, unknown>) =>
  `${key}:${JSON.stringify(vars ?? {})}`;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: stableT }),
}));

import { useRemoteDeleteToast } from "~/hooks/use-remote-delete-toast";

interface Row {
  id: number;
  object_id: string;
  title: string;
  _tempId?: string | null;
  _yIndex?: number;
}

const getLabel = (r: Row) => r.title;

describe("useRemoteDeleteToast", () => {
  beforeEach(() => {
    showToastMock.mockReset();
  });

  it("fires one generic destructive toast when an item disappears", () => {
    const { rerender } = renderHook(
      ({ items }) => useRemoteDeleteToast({ items, enabled: true, getLabel }),
      {
        initialProps: {
          items: [
            { id: 1, object_id: "a", title: "A", _tempId: "uuid-A" },
            { id: 2, object_id: "b", title: "B", _tempId: "uuid-B" },
          ] as Row[],
        },
      },
    );
    // First render only seeds the previous-keys map — no toast yet.
    expect(showToastMock).not.toHaveBeenCalled();

    // B is removed by a remote peer.
    rerender({ items: [{ id: 1, object_id: "a", title: "A", _tempId: "uuid-A" }] });

    expect(showToastMock).toHaveBeenCalledOnce();
    const call = showToastMock.mock.calls[0][0];
    expect(call.type).toBe("destructive");
    expect(call.message).toContain("toast_item_deleted_generic");
    expect(call.message).toContain("B");
    // No action link — a remote delete has no local undo path.
    expect(call.action).toBeUndefined();
  });

  it("fires nothing when a new item's id is backfilled (stable _tempId key)", () => {
    const { rerender } = renderHook(
      ({ items }) => useRemoteDeleteToast({ items, enabled: true, getLabel }),
      {
        initialProps: {
          // Freshly created: id 0, UUID _tempId.
          items: [{ id: 0, object_id: "a", title: "A", _tempId: "uuid-A" }] as Row[],
        },
      },
    );
    // snapshotToD1 backfills the real D1 row id; _tempId is unchanged.
    rerender({ items: [{ id: 42, object_id: "a", title: "A", _tempId: "uuid-A" }] });

    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("fires nothing for a reorder-shaped change (same keys, new order) without a suppression flag", () => {
    const { rerender } = renderHook(
      ({ items }) => useRemoteDeleteToast({ items, enabled: true, getLabel }),
      {
        initialProps: {
          items: [
            { id: 1, object_id: "a", title: "A", _tempId: "uuid-A" },
            { id: 2, object_id: "b", title: "B", _tempId: "uuid-B" },
            { id: 3, object_id: "c", title: "C", _tempId: "uuid-C" },
          ] as Row[],
        },
      },
    );
    // A reorder swaps positions and — as cloneYMap does — hands back brand-new
    // object identities, but each carries the same _id and _tempId. keyFor keys
    // on _tempId, so the key set is unchanged and nothing reads as a deletion.
    // No suppressRef is passed: this pins that the guard is not load-bearing
    // under the shared tempId-first keying.
    rerender({
      items: [
        { id: 3, object_id: "c", title: "C", _tempId: "uuid-C" },
        { id: 1, object_id: "a", title: "A", _tempId: "uuid-A" },
        { id: 2, object_id: "b", title: "B", _tempId: "uuid-B" },
      ],
    });
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("fires nothing while the suppression flag is set", () => {
    const suppressRef = { current: true };
    const { rerender } = renderHook(
      ({ items }) =>
        useRemoteDeleteToast({ items, enabled: true, getLabel, suppressRef }),
      {
        initialProps: {
          items: [
            { id: 1, object_id: "a", title: "A", _tempId: "uuid-A" },
            { id: 2, object_id: "b", title: "B", _tempId: "uuid-B" },
          ] as Row[],
        },
      },
    );
    // B disappears (as a reorder clone would make it), but suppression is on.
    rerender({ items: [{ id: 1, object_id: "a", title: "A", _tempId: "uuid-A" }] });

    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("fires nothing on first mount with a populated list", () => {
    renderHook(() =>
      useRemoteDeleteToast({
        items: [
          { id: 1, object_id: "a", title: "A", _tempId: "uuid-A" },
          { id: 2, object_id: "b", title: "B", _tempId: "uuid-B" },
        ] as Row[],
        enabled: true,
        getLabel,
      }),
    );
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("fires one toast per item for several simultaneous deletions", () => {
    const { rerender } = renderHook(
      ({ items }) => useRemoteDeleteToast({ items, enabled: true, getLabel }),
      {
        initialProps: {
          items: [
            { id: 1, object_id: "a", title: "A", _tempId: "uuid-A" },
            { id: 2, object_id: "b", title: "B", _tempId: "uuid-B" },
            { id: 3, object_id: "c", title: "C", _tempId: "uuid-C" },
          ] as Row[],
        },
      },
    );
    // B and C both vanish in one update.
    rerender({ items: [{ id: 1, object_id: "a", title: "A", _tempId: "uuid-A" }] });

    expect(showToastMock).toHaveBeenCalledTimes(2);
    const labels = showToastMock.mock.calls.map((c) => c[0].message);
    expect(labels.some((m: string) => m.includes("B"))).toBe(true);
    expect(labels.some((m: string) => m.includes("C"))).toBe(true);
  });

  it("fires nothing when disabled, even as items change", () => {
    const { rerender } = renderHook(
      ({ items }) => useRemoteDeleteToast({ items, enabled: false, getLabel }),
      {
        initialProps: {
          items: [
            { id: 1, object_id: "a", title: "A", _tempId: "uuid-A" },
            { id: 2, object_id: "b", title: "B", _tempId: "uuid-B" },
          ] as Row[],
        },
      },
    );
    rerender({ items: [{ id: 1, object_id: "a", title: "A", _tempId: "uuid-A" }] });
    expect(showToastMock).not.toHaveBeenCalled();
  });
});

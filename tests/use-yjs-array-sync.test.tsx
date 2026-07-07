// @vitest-environment jsdom
/**
 * use-yjs-array-sync.test.tsx — unit tests for the useYjsArraySync hook.
 *
 * Drives a real Y.Doc/Y.Array (no mocks) through renderHook and asserts:
 *   - null yArray → null result (D1-fallback gate)
 *   - initial contents mirrored on mount
 *   - observeDeep recompute on push and on nested Y.Map field change
 *   - unobserveDeep on unmount (post-unmount mutation does not throw / restate)
 *   - a stale inline mapFn does not re-subscribe (subscribe-once semantics):
 *     mutating still recomputes with the latest mapFn.
 */

import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { useYjsArraySync } from "~/hooks/use-yjs-array-sync";

function makeArray(keys: string[]): {
  doc: Y.Doc;
  arr: Y.Array<Y.Map<unknown>>;
} {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>("xs");
  doc.transact(() => {
    for (const key of keys) {
      const m = new Y.Map();
      m.set("key", key);
      arr.push([m]);
    }
  });
  return { doc, arr };
}

const toKey = (m: Y.Map<unknown>, i: number) => `${i}:${m.get("key")}`;

describe("useYjsArraySync", () => {
  it("returns null when the array is null (D1-fallback path)", () => {
    const { result } = renderHook(() => useYjsArraySync(null, toKey));
    expect(result.current).toBeNull();
  });

  it("mirrors the array contents on mount", () => {
    const { arr } = makeArray(["a", "b"]);
    const { result } = renderHook(() => useYjsArraySync(arr, toKey));
    expect(result.current).toEqual(["0:a", "1:b"]);
  });

  it("recomputes when an item is pushed (observeDeep)", () => {
    const { doc, arr } = makeArray(["a"]);
    const { result } = renderHook(() => useYjsArraySync(arr, toKey));
    expect(result.current).toEqual(["0:a"]);

    act(() => {
      doc.transact(() => {
        const m = new Y.Map();
        m.set("key", "b");
        arr.push([m]);
      });
    });
    expect(result.current).toEqual(["0:a", "1:b"]);
  });

  it("recomputes on a nested Y.Map field change (deep observation)", () => {
    const { doc, arr } = makeArray(["a"]);
    const { result } = renderHook(() => useYjsArraySync(arr, toKey));
    expect(result.current).toEqual(["0:a"]);

    act(() => {
      doc.transact(() => {
        arr.get(0).set("key", "z");
      });
    });
    expect(result.current).toEqual(["0:z"]);
  });

  it("unsubscribes on unmount (later mutation does not throw)", () => {
    const { doc, arr } = makeArray(["a"]);
    const { unmount } = renderHook(() => useYjsArraySync(arr, toKey));
    unmount();
    expect(() =>
      doc.transact(() => {
        const m = new Y.Map();
        m.set("key", "b");
        arr.push([m]);
      }),
    ).not.toThrow();
  });

  it("uses the latest mapFn on recompute without re-subscribing", () => {
    const { doc, arr } = makeArray(["a"]);
    const first = vi.fn((m: Y.Map<unknown>) => `first:${m.get("key")}`);
    const second = vi.fn((m: Y.Map<unknown>) => `second:${m.get("key")}`);

    const { result, rerender } = renderHook(
      ({ fn }: { fn: (m: Y.Map<unknown>, i: number) => string }) =>
        useYjsArraySync(arr, fn),
      { initialProps: { fn: first } },
    );
    expect(result.current).toEqual(["first:a"]);

    // Re-render with a different mapFn (no array identity change).
    rerender({ fn: second });
    // A subsequent mutation recomputes with the NEW mapFn.
    act(() => {
      doc.transact(() => {
        const m = new Y.Map();
        m.set("key", "b");
        arr.push([m]);
      });
    });
    expect(result.current).toEqual(["second:a", "second:b"]);
  });
});

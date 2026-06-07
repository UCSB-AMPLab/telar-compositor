// @vitest-environment jsdom
/**
 * objects-create-dedupe.test.tsx — pins two code-review fixes on the
 * single-object create paths:
 *
 *   - addIiifObject / addExternalMediaObject MUST dedupe object_id
 *     against the live Y.Array. There is no UNIQUE constraint on
 *     objects.object_id, so two un-deduped adds would both persist,
 *     collapse in objects.csv, and make step→object lookups ambiguous
 *     on the published site.
 *   - both ops MUST return the created object's stable _temp_id so the
 *     caller can locate the exact object via findYMapByIdOrTempId,
 *     instead of a race-prone array.get(length - 1) read that a
 *     concurrent/remote insert can invalidate.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Y from "yjs";
import { renderHook } from "@testing-library/react";
import { findYMapByIdOrTempId } from "~/lib/yjs-helpers";

// useStructuralOps reads the active Y.Doc from the collaboration context.
// Back it with a real Y.Doc we control so the ops mutate a real Y.Array.
const collab: { ydoc: Y.Doc } = { ydoc: new Y.Doc() };
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: collab.ydoc }),
}));

import { useStructuralOps } from "~/hooks/use-structural-ops";

function objectIds(arr: Y.Array<Y.Map<unknown>>): string[] {
  return arr.toArray().map((m) => m.get("object_id") as string);
}

describe("objects create paths — dedupe + stable handle", () => {
  beforeEach(() => {
    collab.ydoc = new Y.Doc();
  });

  it("addIiifObject dedupes a colliding object_id with a -2 suffix", () => {
    const { result } = renderHook(() => useStructuralOps(1, "convenor"));
    result.current!.addIiifObject("mapa", "Mapa", "https://example.org/m1/manifest");
    result.current!.addIiifObject("mapa", "Mapa", "https://example.org/m2/manifest");
    const arr = collab.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(objectIds(arr)).toEqual(["mapa", "mapa-2"]);
  });

  it("addExternalMediaObject dedupes against an existing IIIF object_id", () => {
    const { result } = renderHook(() => useStructuralOps(1, "convenor"));
    result.current!.addIiifObject("video", "V", "https://example.org/iiif/manifest");
    result.current!.addExternalMediaObject("video", "V", "https://youtu.be/abcdefghijk");
    const arr = collab.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(objectIds(arr)).toEqual(["video", "video-2"]);
  });

  it("addIiifObject returns the created object's _temp_id", () => {
    const { result } = renderHook(() => useStructuralOps(1, "convenor"));
    const tempId = result.current!.addIiifObject("a", "A", "https://example.org/a/manifest");
    const arr = collab.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(typeof tempId).toBe("string");
    expect(tempId.length).toBeGreaterThan(0);
    expect(arr.get(0).get("_temp_id")).toBe(tempId);
  });

  it("the returned _temp_id locates the right object after a later (remote-style) insert", () => {
    const { result } = renderHook(() => useStructuralOps(1, "convenor"));
    const tempId = result.current!.addExternalMediaObject(
      "first",
      "First",
      "https://youtu.be/abcdefghijk",
    );
    // A second insert lands after the first — simulating a concurrent/remote
    // push between the op and the caller's locate step.
    result.current!.addIiifObject("second", "Second", "https://example.org/s/manifest");
    const arr = collab.ydoc.getArray<Y.Map<unknown>>("objects");
    const located = findYMapByIdOrTempId(arr, null, tempId);
    expect(located?.get("object_id")).toBe("first");
    // The old positional read would have grabbed the WRONG (last) object:
    expect(arr.get(arr.length - 1).get("object_id")).toBe("second");
  });
});

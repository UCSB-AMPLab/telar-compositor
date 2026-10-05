/**
 * The objects a story editor offers: the document's once it holds any, the
 * loader's before.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { makeObjectYMap } from "~/lib/object-ymap";
import { editorObjectFromYMap, liveEditorObjects } from "~/lib/story-editor-objects";

const LOADED = {
  object_id: "codex",
  title: "Codex",
  thumbnail: null,
  image_available: true,
  source_url: null,
  alt_text: null,
};

function docObjects(...specs: Array<{ id: string; key: string; state?: "pending" | "valid" }>) {
  const arr = new Y.Doc().getArray<Y.Map<unknown>>("objects");
  for (const s of specs) {
    arr.push([
      makeObjectYMap({ objectId: s.id, title: s.id.toUpperCase(), validationState: s.state ?? "valid", origin: "compositor", orderKey: s.key }),
    ]);
  }
  return Array.from({ length: arr.length }, (_, i) => editorObjectFromYMap(arr.get(i), i));
}

describe("liveEditorObjects", () => {
  it("offers the loader's objects before the document has synced", () => {
    expect(liveEditorObjects([LOADED], docObjects(), false)).toEqual([LOADED]);
    expect(liveEditorObjects([LOADED], null, true)).toEqual([LOADED]);
  });
  it("before sync, also offers an object the document holds and the loader never saw", () => {
    const out = liveEditorObjects([LOADED], docObjects({ id: "b", key: "a0" }), false);
    expect(out.map((o) => o.object_id)).toEqual(["codex", "b"]);
  });
  it("before sync, offers an object once, from the document, when both hold it", () => {
    const out = liveEditorObjects([LOADED], docObjects({ id: "codex", key: "a0" }), false);
    expect(out.map((o) => [o.object_id, o.title])).toEqual([["codex", "CODEX"]]);
  });
  it("offers nothing once the document has synced and holds no objects, though the loader listed one", () => {
    expect(liveEditorObjects([LOADED], docObjects(), true)).toEqual([]);
  });
  it("offers the document's objects, including one the loader never saw, in order_key order", () => {
    const out = liveEditorObjects([LOADED], docObjects({ id: "b", key: "a1" }, { id: "a", key: "a0" }), true);
    expect(out.map((o) => o.object_id)).toEqual(["a", "b"]);
  });
  it("drops an object the document no longer holds", () => {
    const out = liveEditorObjects([LOADED], docObjects({ id: "b", key: "a0" }), true);
    expect(out.map((o) => o.object_id)).toEqual(["b"]);
  });
  it("keeps a pending object", () => {
    const out = liveEditorObjects([], docObjects({ id: "p", key: "a0", state: "pending" }), true);
    expect(out.map((o) => o.object_id)).toEqual(["p"]);
  });
  it("leaves out an object whose manifest failed validation", () => {
    const arr = new Y.Doc().getArray<Y.Map<unknown>>("objects");
    const map = makeObjectYMap({ objectId: "bad", validationState: "pending", origin: "iiif", orderKey: "a0" });
    map.set("_validation_state", "error");
    arr.push([map]);
    expect(liveEditorObjects([], [editorObjectFromYMap(arr.get(0), 0)], true)).toEqual([]);
  });
});

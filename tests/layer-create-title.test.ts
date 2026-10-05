// @vitest-environment jsdom

/**
 * `ops.addLayer` over a real Y.Doc: a new panel has no title of its own, so
 * it is headed as the site heads an untitled panel (`panelHeading`), from a
 * button label the author can change, and a label changed later is not left
 * behind as a stale title.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import * as Y from "yjs";

const ydocRef: { current: Y.Doc | null } = { current: null };

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: ydocRef.current }),
}));

import { useStructuralOps } from "~/hooks/use-structural-ops";

function setup() {
  const doc = new Y.Doc();
  ydocRef.current = doc;
  const stepYMap = new Y.Map<unknown>();
  doc.transact(() => {
    stepYMap.set("layers", new Y.Array<Y.Map<unknown>>());
    doc.getArray<Y.Map<unknown>>("steps").push([stepYMap]);
  });
  const { result } = renderHook(() => useStructuralOps(1, "convenor"));
  return { doc, stepYMap, ops: result.current! };
}

describe("ops.addLayer", () => {
  it("stores an empty title and the given button label", () => {
    const { stepYMap, ops } = setup();
    ops.addLayer(stepYMap, 1, "Learn more");
    const layer = (stepYMap.get("layers") as Y.Array<Y.Map<unknown>>).get(0);
    expect(layer.get("title")).toBeInstanceOf(Y.Text);
    expect((layer.get("title") as Y.Text).toString()).toBe("");
    expect((layer.get("button_label") as Y.Text).toString()).toBe("Learn more");
  });

  it("reaches a peer with an empty title", () => {
    const { doc, stepYMap, ops } = setup();
    const peer = new Y.Doc();
    doc.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    ops.addLayer(stepYMap, 2, "Go deeper");
    const peerLayer = (peer.getArray<Y.Map<unknown>>("steps").get(0).get("layers") as Y.Array<Y.Map<unknown>>).get(0);
    expect((peerLayer.get("title") as Y.Text).toString()).toBe("");
    expect(peerLayer.get("layer_number")).toBe(2);
  });
});

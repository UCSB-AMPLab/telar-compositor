// @vitest-environment jsdom

/**
 * A new detail panel is held in the author's editor and written to the shared
 * document only on its first content (`usePendingLayers` with the real
 * `ops.addLayer` over a real Y.Doc). Its default title and default button
 * label are not content; once written, the panel stays when emptied.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";

const ydocRef: { current: Y.Doc | null } = { current: null };

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: ydocRef.current }),
}));

import { useStructuralOps } from "~/hooks/use-structural-ops";
import { usePendingLayers, pendingLayerHasContent } from "~/hooks/use-pending-layers";

function pendingSetup(stepKey = "step-a") {
  const doc = new Y.Doc();
  ydocRef.current = doc;
  const stepYMap = new Y.Map<unknown>();
  doc.transact(() => {
    stepYMap.set("layers", new Y.Array<Y.Map<unknown>>());
    doc.getArray<Y.Map<unknown>>("steps").push([stepYMap]);
  });
  const layers = () => stepYMap.get("layers") as Y.Array<Y.Map<unknown>>;
  const taken = () => layers().toArray().map((m) => m.get("layer_number") as number);
  const hook = renderHook(
    ({ key }) => {
      const ops = useStructuralOps(1, "convenor")!;
      return usePendingLayers(key, taken, (layer) =>
        ops.addLayer(stepYMap, layer.layer_number, layer.button_label, {
          tempId: layer.tempId,
          title: layer.title,
          content: layer.content,
        }),
      );
    },
    { initialProps: { key: stepKey } },
  );
  return { doc, layers, hook };
}

const heldText = (map: Y.Map<unknown>, key: string) => (map.get(key) as Y.Text).toString();

describe("a new detail panel", () => {
  it("is held in the editor and not written to the document when added", () => {
    const { layers, hook } = pendingSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    expect(layers().length).toBe(0);
    expect(hook.result.current.layers).toHaveLength(1);
    expect(hook.result.current.layers[0]).toMatchObject({ layer_number: 1, button_label: "Learn more", content: "" });
  });

  it("left without content when the step changes, leaves nothing in the document and is gone on return", () => {
    const { layers, hook } = pendingSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    hook.rerender({ key: "step-b" });
    expect(hook.result.current.layers).toHaveLength(0);
    hook.rerender({ key: "step-a" });
    expect(hook.result.current.layers).toHaveLength(0);
    expect(layers().length).toBe(0);
  });

  it("is written once on its first character, under the key it was held by", () => {
    const { layers, hook } = pendingSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    const tempId = hook.result.current.layers[0].tempId;
    act(() => hook.result.current.write(1, "content", "H"));
    expect(layers().length).toBe(1);
    const map = layers().get(0);
    expect(map.get("_temp_id")).toBe(tempId);
    expect(heldText(map, "content")).toBe("H");
    expect(heldText(map, "button_label")).toBe("Learn more");
    expect(heldText(map, "title")).toBe("");
    expect(hook.result.current.layers).toHaveLength(0);
    act(() => hook.result.current.write(1, "content", "He"));
    expect(layers().length).toBe(1);
  });

  it("stays in the document when its content is cleared afterwards", () => {
    const { doc, layers, hook } = pendingSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    act(() => hook.result.current.write(1, "content", "H"));
    const content = layers().get(0).get("content") as Y.Text;
    doc.transact(() => content.delete(0, content.length));
    hook.rerender({ key: "step-b" });
    expect(layers().length).toBe(1);
    expect(heldText(layers().get(0), "content")).toBe("");
  });

  it("is not written for the default button label, the default label as title, or blank content", () => {
    const { layers, hook } = pendingSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    act(() => hook.result.current.write(1, "button_label", "Learn more"));
    act(() => hook.result.current.write(1, "title", "Learn more"));
    act(() => hook.result.current.write(1, "title", ""));
    act(() => hook.result.current.write(1, "content", "  \n"));
    expect(layers().length).toBe(0);
    expect(hook.result.current.layers).toHaveLength(1);
  });

  it("is written by a title of the author's own, with the content held so far", () => {
    const { layers, hook } = pendingSetup();
    act(() => hook.result.current.create(2, "Go deeper"));
    act(() => hook.result.current.write(2, "title", "Sources"));
    expect(layers().length).toBe(1);
    expect(layers().get(0).get("layer_number")).toBe(2);
    expect(heldText(layers().get(0), "title")).toBe("Sources");
  });

  it("holds a button label of the author's own, and writes it with the panel's first content", () => {
    const { layers, hook } = pendingSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    act(() => hook.result.current.write(1, "button_label", "Read the letter"));
    expect(layers().length).toBe(0);
    act(() => hook.result.current.write(1, "content", "H"));
    expect(layers().length).toBe(1);
    expect(heldText(layers().get(0), "button_label")).toBe("Read the letter");
  });

  it("is dropped when discarded, leaving nothing in the document", () => {
    const { layers, hook } = pendingSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    act(() => hook.result.current.discard(1));
    expect(hook.result.current.layers).toHaveLength(0);
    act(() => hook.result.current.write(1, "content", "H"));
    expect(layers().length).toBe(0);
  });

  it("gives way to a panel a collaborator wrote first in the same place, and does not write a second", () => {
    const { doc, layers, hook } = pendingSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    const theirs = new Y.Map<unknown>();
    doc.transact(() => {
      theirs.set("layer_number", 1);
      theirs.set("content", new Y.Text("Theirs"));
      layers().push([theirs]);
    });
    hook.rerender({ key: "step-a" });
    expect(hook.result.current.layers).toHaveLength(0);
    act(() => hook.result.current.write(1, "content", "Mine"));
    expect(layers().length).toBe(1);
  });
});

describe("ops.addLayer with the panel's first content", () => {
  it("refuses a second panel where the step already has one", () => {
    const { layers } = pendingSetup();
    const ops = renderHook(() => useStructuralOps(1, "convenor")).result.current!;
    const stepYMap = ydocRef.current!.getArray<Y.Map<unknown>>("steps").get(0);
    expect(ops.addLayer(stepYMap, 1, "Learn more", { content: "One" })).toBe(true);
    expect(ops.addLayer(stepYMap, 1, "Learn more", { content: "Two" })).toBe(false);
    expect(layers().length).toBe(1);
  });
});

describe("pendingLayerHasContent", () => {
  const base = { tempId: "t", layer_number: 1 as const, defaultLabel: "Learn more", title: "", button_label: "Learn more", content: "" };
  it("counts content and an own title, and not the defaults or a label alone", () => {
    expect(pendingLayerHasContent(base)).toBe(false);
    expect(pendingLayerHasContent({ ...base, title: " Learn more " })).toBe(false);
    expect(pendingLayerHasContent({ ...base, content: "x" })).toBe(true);
    expect(pendingLayerHasContent({ ...base, title: "Sources" })).toBe(true);
    expect(pendingLayerHasContent({ ...base, button_label: "Read on" })).toBe(false);
  });
});

function publishSetup() {
  const doc = new Y.Doc();
  ydocRef.current = doc;
  const steps = doc.getArray<Y.Map<unknown>>("steps");
  doc.transact(() => {
    for (const key of ["step-a", "step-b"]) {
      const step = new Y.Map<unknown>();
      step.set("_temp_id", key);
      step.set("layers", new Y.Array<Y.Map<unknown>>());
      steps.push([step]);
    }
  });
  const publishStepNamed = (key: string | null) => steps.toArray().find((s) => s.get("_temp_id") === key);
  const layersOf = (key: string) => (publishStepNamed(key)?.get("layers") as Y.Array<Y.Map<unknown>>) ?? new Y.Array();
  const hook = renderHook(
    ({ key, frozen }) => {
      const ops = useStructuralOps(1, "convenor")!;
      return usePendingLayers(
        key,
        (heldKey) => layersOf(heldKey ?? "").toArray().map((m) => m.get("layer_number") as number),
        (layer, heldKey) => {
          const step = publishStepNamed(heldKey);
          return !!step && ops.addLayer(step, layer.layer_number, layer.button_label, { tempId: layer.tempId, title: layer.title, content: layer.content });
        },
        frozen,
      );
    },
    { initialProps: { key: "step-a", frozen: false } },
  );
  return { doc, steps, layersOf, hook };
}

describe("a held panel during a publish", () => {
  it("given content, survives a step change and is written to its own step when the publish ends", () => {
    const { layersOf, hook } = publishSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    hook.rerender({ key: "step-a", frozen: true });
    act(() => hook.result.current.write(1, "content", "Typed during the publish"));
    hook.rerender({ key: "step-b", frozen: true });
    expect(hook.result.current.layers).toHaveLength(0);
    hook.rerender({ key: "step-b", frozen: false });
    expect(layersOf("step-a").length).toBe(1);
    expect(heldText(layersOf("step-a").get(0), "content")).toBe("Typed during the publish");
    expect(layersOf("step-b").length).toBe(0);
  });

  it("given content, shows again when its step is selected again before the publish ends", () => {
    const { layersOf, hook } = publishSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    hook.rerender({ key: "step-a", frozen: true });
    act(() => hook.result.current.write(1, "content", "Typed during the publish"));
    hook.rerender({ key: "step-b", frozen: true });
    hook.rerender({ key: "step-a", frozen: true });
    expect(hook.result.current.layers).toHaveLength(1);
    expect(hook.result.current.layers[0].content).toBe("Typed during the publish");
    hook.rerender({ key: "step-a", frozen: false });
    expect(layersOf("step-a").length).toBe(1);
    expect(hook.result.current.layers).toHaveLength(0);
  });

  it("without content, is still dropped on a step change", () => {
    const { layersOf, hook } = publishSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    hook.rerender({ key: "step-a", frozen: true });
    hook.rerender({ key: "step-b", frozen: true });
    hook.rerender({ key: "step-b", frozen: false });
    hook.rerender({ key: "step-a", frozen: false });
    expect(hook.result.current.layers).toHaveLength(0);
    expect(layersOf("step-a").length).toBe(0);
  });

  it("given content, is written to its own step when the publish ends in the same render as the step change", () => {
    const { layersOf, hook } = publishSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    hook.rerender({ key: "step-a", frozen: true });
    act(() => hook.result.current.write(1, "content", "Typed during the publish"));
    hook.rerender({ key: "step-b", frozen: false });
    expect(layersOf("step-a").length).toBe(1);
    expect(heldText(layersOf("step-a").get(0), "content")).toBe("Typed during the publish");
    expect(layersOf("step-b").length).toBe(0);
  });

  it("is dropped when its step is deleted before the publish ends", () => {
    const { doc, steps, layersOf, hook } = publishSetup();
    act(() => hook.result.current.create(1, "Learn more"));
    hook.rerender({ key: "step-a", frozen: true });
    act(() => hook.result.current.write(1, "content", "Typed during the publish"));
    hook.rerender({ key: "step-b", frozen: true });
    doc.transact(() => steps.delete(0, 1));
    hook.rerender({ key: "step-b", frozen: false });
    expect(layersOf("step-b").length).toBe(0);
    expect(hook.result.current.layers).toHaveLength(0);
  });
});

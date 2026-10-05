// @vitest-environment jsdom

/**
 * `ops.addStep` with and without a seed.
 *
 * A seeded step must be an ordinary step from the instant it is written: peers
 * receive it with its object already set, and nothing beyond the five seeded
 * keys distinguishes it from a step the author filled in by hand. That is
 * asserted against the real hook over a real Y.Doc, and against a second doc
 * receiving the update, rather than against a copy of the transaction.
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
import type { StepSeed } from "~/hooks/use-structural-ops";

function setup() {
  const doc = new Y.Doc();
  ydocRef.current = doc;
  const storyYMap = new Y.Map<unknown>();
  const stepsArray = new Y.Array<Y.Map<unknown>>();
  doc.transact(() => {
    storyYMap.set("steps", stepsArray);
    doc.getArray<Y.Map<unknown>>("stories").push([storyYMap]);
  });
  const { result } = renderHook(() => useStructuralOps(1, "convenor"));
  return { doc, storyYMap, stepsArray, ops: result.current! };
}

const SEED: StepSeed = {
  object_id: "manuscript-01",
  page: "3",
  x: 0.25,
  y: 0.75,
  zoom: 2.5,
};

describe("ops.addStep", () => {
  it("writes an empty media step and returns its temp id without a seed", () => {
    const { stepsArray, ops } = setup();
    const tempId = ops.addStep(storyOf(stepsArray));
    expect(typeof tempId).toBe("string");

    const step = stepsArray.get(0);
    expect(step.get("_temp_id")).toBe(tempId);
    expect(step.get("kind")).toBe("media");
    expect(step.get("object_id")).toBe("");
    expect(step.get("page")).toBe("");
    expect(step.get("x")).toBeNull();
    expect(step.get("y")).toBeNull();
    expect(step.get("zoom")).toBeNull();
    expect(step.get("step_number")).toBe(1);
    expect(step.get("question")).toBeInstanceOf(Y.Text);
    expect(step.get("extra_columns")).toBe("");
    expect(step.get("layers")).toBeInstanceOf(Y.Array);
  });

  it("writes exactly the five seeded keys with the source's value types", () => {
    const { stepsArray, ops } = setup();
    ops.addStep(storyOf(stepsArray), SEED);

    const step = stepsArray.get(0);
    expect(step.get("object_id")).toBe("manuscript-01");
    expect(step.get("page")).toBe("3");
    expect(step.get("x")).toBe(0.25);
    expect(step.get("y")).toBe(0.75);
    expect(step.get("zoom")).toBe(2.5);

    // Everything else is what a fresh step carries: no clip values are inherited.
    expect(step.get("clip_start")).toBe("");
    expect(step.get("clip_end")).toBe("");
    expect(step.get("loop")).toBe("");
    // Nor are the kept cells of columns the Compositor does not map.
    expect(step.get("extra_columns")).toBe("");
    expect(step.get("kind")).toBe("media");
    expect(typeof step.get("order_key")).toBe("string");
    expect(new Set(Array.from(step.keys()))).toEqual(
      new Set([
        "_id", "_temp_id", "created_by", "step_number", "order_key", "kind",
        "object_id", "x", "y", "zoom", "page", "question", "answer", "alt_text",
        "clip_start", "clip_end", "loop", "extra_columns", "layers",
      ])
    );
  });

  it("carries a null page and null coordinates through unchanged", () => {
    const { stepsArray, ops } = setup();
    ops.addStep(storyOf(stepsArray), {
      object_id: "obj",
      page: null,
      x: null,
      y: null,
      zoom: null,
    });
    const step = stepsArray.get(0);
    expect(step.get("page")).toBeNull();
    expect(step.get("x")).toBeNull();
  });

  it("reaches a second document as an ordinary step with its object set", () => {
    const { doc, stepsArray, ops } = setup();
    const peer = new Y.Doc();
    doc.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));

    ops.addStep(storyOf(stepsArray), SEED);

    const peerStory = peer.getArray<Y.Map<unknown>>("stories").get(0);
    const peerSteps = peerStory.get("steps") as Y.Array<Y.Map<unknown>>;
    expect(peerSteps.length).toBe(1);
    expect(peerSteps.get(0).get("object_id")).toBe("manuscript-01");
    expect(peerSteps.get(0).get("page")).toBe("3");
  });

  it("returns null for a story whose steps are not an array", () => {
    const { doc, ops } = setup();
    const malformed = new Y.Map<unknown>();
    doc.transact(() => {
      doc.getArray<Y.Map<unknown>>("stories").push([malformed]);
      malformed.set("steps", "not-an-array");
    });
    expect(ops.addStep(malformed)).toBeNull();
  });
});

/** The story Y.Map that owns the given steps array. */
function storyOf(stepsArray: Y.Array<Y.Map<unknown>>): Y.Map<unknown> {
  return stepsArray.parent as Y.Map<unknown>;
}

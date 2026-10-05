// @vitest-environment jsdom
/**
 * The objects list's usage counts follow the shared document: a step given an
 * object, or taken off one, changes the count with no reload.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { useDocumentStepCounts } from "~/hooks/use-document-step-counts";
import { storyStepObjects, tallyStepObjects } from "~/lib/object-step-counts";

const documentStepObjects = (stories: Y.Array<Y.Map<unknown>>) => stories.toArray().flatMap(storyStepObjects);

function story(doc: Y.Doc, objectIds: Array<string | null>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  const steps = new Y.Array<Y.Map<unknown>>();
  doc.getArray<Y.Map<unknown>>("stories").push([map]);
  map.set("steps", steps);
  for (const id of objectIds) {
    const step = new Y.Map<unknown>();
    steps.push([step]);
    step.set("object_id", id);
  }
  return map;
}

const OBJECTS = [{ object_id: "map" }, { object_id: "bell" }];

describe("object usage counts from the shared document", () => {
  it("counts the steps each object is shown in, across stories", () => {
    const doc = new Y.Doc();
    story(doc, ["map", "bell", "map"]);
    story(doc, ["map", "", null, "nowhere"]);

    const counts = tallyStepObjects(documentStepObjects(doc.getArray("stories")), OBJECTS, null);

    expect(counts).toEqual({ map: 3, bell: 1 });
  });

  it("follows a step that is given an object after the page loaded", () => {
    const doc = new Y.Doc();
    const first = story(doc, [""]);
    const before = tallyStepObjects(documentStepObjects(doc.getArray("stories")), OBJECTS, null);

    ((first.get("steps") as Y.Array<Y.Map<unknown>>).get(0)).set("object_id", "bell");
    const after = tallyStepObjects(documentStepObjects(doc.getArray("stories")), OBJECTS, null);

    expect([before, after]).toEqual([{}, { bell: 1 }]);
  });
});

describe("useDocumentStepCounts", () => {
  it("is the loader's counts with no document", () => {
    const loader = { map: 4 };
    const { result } = renderHook(() => useDocumentStepCounts(null, null, loader));
    expect(result.current).toBe(loader);
  });

  it("recounts when a step in the document is given an object", () => {
    const doc = new Y.Doc();
    for (const { object_id } of OBJECTS) {
      const object = new Y.Map<unknown>();
      object.set("object_id", object_id);
      doc.getArray<Y.Map<unknown>>("objects").push([object]);
    }
    const first = story(doc, [""]);
    const { result } = renderHook(() => useDocumentStepCounts(doc, null, {}));
    expect(result.current).toEqual({});

    act(() => {
      (first.get("steps") as Y.Array<Y.Map<unknown>>).get(0).set("object_id", "bell");
    });

    expect(result.current).toEqual({ bell: 1 });
  });
});

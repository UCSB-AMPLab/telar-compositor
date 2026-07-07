// @vitest-environment jsdom
/**
 * story-create-subtitle-byline.test.tsx — pins that the story creation form's
 * subtitle and byline are not discarded.
 *
 * The Stories list's inline creation form collects title, subtitle, and byline
 * and passes all three to addStory. This test guards that addStory seeds the
 * new story's `subtitle` and `byline` Y.Text from those arguments (rather than
 * creating them empty and dropping the user's input), while an omitted value
 * still starts empty.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Y from "yjs";
import { renderHook } from "@testing-library/react";

// useStructuralOps reads the active Y.Doc from the collaboration context.
// Back it with a real Y.Doc we control so the ops mutate a real Y.Array.
const collab: { ydoc: Y.Doc } = { ydoc: new Y.Doc() };
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: collab.ydoc }),
}));

import { useStructuralOps } from "~/hooks/use-structural-ops";

function firstStory(): Y.Map<unknown> {
  return collab.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
}

function textOf(map: Y.Map<unknown>, key: string): string {
  const val = map.get(key);
  return val instanceof Y.Text ? val.toString() : "";
}

describe("addStory — subtitle and byline are carried through", () => {
  beforeEach(() => {
    collab.ydoc = new Y.Doc();
  });

  it("seeds subtitle and byline Y.Text from the submitted values", () => {
    const { result } = renderHook(() => useStructuralOps(1, "convenor"));
    result.current!.addStory("My title", "my-title-abcd", "A subtitle", "By someone");
    const story = firstStory();
    expect(textOf(story, "title")).toBe("My title");
    expect(textOf(story, "subtitle")).toBe("A subtitle");
    expect(textOf(story, "byline")).toBe("By someone");
    // subtitle/byline remain collaborative Y.Text, editable inline afterwards.
    expect(story.get("subtitle")).toBeInstanceOf(Y.Text);
    expect(story.get("byline")).toBeInstanceOf(Y.Text);
  });

  it("starts subtitle and byline empty when omitted", () => {
    const { result } = renderHook(() => useStructuralOps(1, "convenor"));
    result.current!.addStory("Solo title", "solo-title-abcd");
    const story = firstStory();
    expect(textOf(story, "subtitle")).toBe("");
    expect(textOf(story, "byline")).toBe("");
    expect(story.get("subtitle")).toBeInstanceOf(Y.Text);
    expect(story.get("byline")).toBeInstanceOf(Y.Text);
  });
});

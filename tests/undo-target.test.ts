import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  describeUndoneChange,
  routeToTarget,
  isOffScreen,
  type UndoTarget,
} from "~/lib/undo-target";

/* eslint-disable @typescript-eslint/no-explicit-any */
function captureChange(doc: Y.Doc, mutate: () => void): Map<Y.AbstractType<any>, Y.YEvent<any>[]> {
  let captured = new Map<Y.AbstractType<any>, Y.YEvent<any>[]>();
  const handler = (tx: Y.Transaction) => {
    captured = tx.changedParentTypes as typeof captured;
  };
  doc.on("afterTransaction", handler);
  doc.transact(mutate);
  doc.off("afterTransaction", handler);
  return captured;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function makeStory(doc: Y.Doc, storyId: string, title: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("story_id", storyId);
  m.set("title", new Y.Text(title));
  m.set("steps", new Y.Array());
  return m;
}

describe("routeToTarget", () => {
  test("story editor route → section + entityId", () => {
    expect(routeToTarget("/stories/my-story")).toEqual({ section: "stories", entityId: "my-story" });
  });
  test("object editor route → section + entityId", () => {
    expect(routeToTarget("/objects/vessel-1")).toEqual({ section: "objects", entityId: "vessel-1" });
  });
  test("glossary route → section, no entityId", () => {
    expect(routeToTarget("/glossary")).toEqual({ section: "glossary", entityId: null });
  });
  test("pages route → section, no entityId", () => {
    expect(routeToTarget("/pages")).toEqual({ section: "pages", entityId: null });
  });
  test("stories list route → section, no entityId", () => {
    expect(routeToTarget("/stories")).toEqual({ section: "stories", entityId: null });
  });
  test("non-entity route → null", () => {
    expect(routeToTarget("/dashboard")).toBeNull();
  });
});

describe("isOffScreen", () => {
  const tStory = (id: string | null): UndoTarget => ({ section: "stories", entityId: id, title: "x" });
  test("different section is off-screen", () => {
    expect(isOffScreen({ section: "glossary", entityId: null }, tStory("a"))).toBe(true);
  });
  test("no current route is off-screen", () => {
    expect(isOffScreen(null, tStory("a"))).toBe(true);
  });
  test("same story id is on-screen", () => {
    expect(isOffScreen({ section: "stories", entityId: "a" }, tStory("a"))).toBe(false);
  });
  test("different story id is off-screen", () => {
    expect(isOffScreen({ section: "stories", entityId: "b" }, tStory("a"))).toBe(true);
  });
  test("same section but current entity unknown (glossary) is on-screen", () => {
    expect(isOffScreen({ section: "stories", entityId: null }, tStory("a"))).toBe(false);
  });
});

describe("describeUndoneChange", () => {
  test("structural add (re-insert) yields the entity with slug + title", () => {
    const doc = new Y.Doc();
    const stories = doc.getArray<Y.Map<unknown>>("stories");
    const changed = captureChange(doc, () => stories.push([makeStory(doc, "s1", "First")]));
    const targets = describeUndoneChange(changed, doc);
    expect(targets).toEqual([{ section: "stories", entityId: "s1", title: "First" }]);
    doc.destroy();
  });

  test("a deep field edit yields exactly one target — no section-level poison", () => {
    const doc = new Y.Doc();
    const stories = doc.getArray<Y.Map<unknown>>("stories");
    const story = makeStory(doc, "s1", "First");
    doc.transact(() => stories.push([story]));
    const changed = captureChange(doc, () => (story.get("title") as Y.Text).insert(5, "!"));
    const targets = describeUndoneChange(changed, doc);
    expect(targets).toEqual([{ section: "stories", entityId: "s1", title: "First!" }]);
    doc.destroy();
  });

  test("glossary field edit resolves section + term", () => {
    const doc = new Y.Doc();
    const glossary = doc.getArray<Y.Map<unknown>>("glossary");
    const term = new Y.Map<unknown>();
    term.set("term_id", "telar");
    term.set("title", new Y.Text("Telar"));
    doc.transact(() => glossary.push([term]));
    const changed = captureChange(doc, () => (term.get("title") as Y.Text).insert(0, "El "));
    const targets = describeUndoneChange(changed, doc);
    expect(targets).toEqual([{ section: "glossary", entityId: "telar", title: "El Telar" }]);
    doc.destroy();
  });

  test("empty title falls back to null title", () => {
    const doc = new Y.Doc();
    const pages = doc.getArray<Y.Map<unknown>>("pages");
    const page = new Y.Map<unknown>();
    page.set("slug", "about");
    page.set("title", new Y.Text(""));
    const changed = captureChange(doc, () => pages.push([page]));
    const targets = describeUndoneChange(changed, doc);
    expect(targets).toEqual([{ section: "pages", entityId: "about", title: null }]);
    doc.destroy();
  });
});

/**
 * Unit tests for the afterTransaction field-path accumulator
 * (`makeAfterTransactionHandler` → `resolveFieldPaths` in
 * workers/collaboration-helpers.ts).
 *
 * These pin the exact behaviour that drives the activity feed: when an editor
 * edits a field, the handler must record a `collection:id:field` path into the
 * acting user's Set, so the snapshot/flush can emit one coarse activity row.
 *
 * Regression context: the editor stores every text field (title, subtitle,
 * byline, description, definition, page/layer body) as a `Y.Text` and edits it
 * character-by-character (InlineTextField / MarkdownEditor / yCollab). A
 * `Y.Text` content edit registers the change on the `Y.Text` type itself with a
 * `null` key — NOT a keyed change on the parent map. The original
 * `resolveFieldPaths` only emitted paths for non-null map keys, so it silently
 * dropped every Y.Text edit: the activity feed stayed empty for the most common
 * kind of edit. These tests lock in that Y.Text edits DO produce a field path.
 *
 * @version v1.3.2-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { makeAfterTransactionHandler } from "../workers/collaboration-helpers";

const ORIGIN = { userId: 7 }; // stand-in transaction origin
const getUserId = (origin: unknown): number | null =>
  origin && typeof origin === "object" && "userId" in origin
    ? (origin as { userId: number }).userId
    : null;

/** A Y.Doc with one story (numeric _id) whose text fields are Y.Text. */
function docWithStory(id: number) {
  const ydoc = new Y.Doc();
  const userFieldSets = new Map<number, Set<string>>();
  ydoc.on("afterTransaction", makeAfterTransactionHandler(ydoc, userFieldSets, getUserId));
  ydoc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("_id", id);
    story.set("story_id", "s1");
    story.set("title", new Y.Text("Story One"));
    story.set("byline", new Y.Text(""));
    story.set("draft", false);
    ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
  }, null); // null origin → not attributed (seed)
  return { ydoc, userFieldSets, story: () => ydoc.getArray<Y.Map<unknown>>("stories").get(0) };
}

describe("resolveFieldPaths — Y.Text (character-level) field edits", () => {
  it("records a path for a Y.Text title edit (the common editor case)", () => {
    const { ydoc, userFieldSets, story } = docWithStory(11);
    ydoc.transact(() => {
      (story().get("title") as Y.Text).insert(9, "!");
    }, ORIGIN);
    expect([...(userFieldSets.get(7) ?? [])]).toContain("stories:11:title");
  });

  it("records a path for a Y.Text byline edit", () => {
    const { ydoc, userFieldSets, story } = docWithStory(11);
    ydoc.transact(() => {
      (story().get("byline") as Y.Text).insert(0, "By Ada");
    }, ORIGIN);
    expect([...(userFieldSets.get(7) ?? [])]).toContain("stories:11:byline");
  });

  it("uses _temp_id when the entity has no numeric _id yet", () => {
    const ydoc = new Y.Doc();
    const userFieldSets = new Map<number, Set<string>>();
    ydoc.on("afterTransaction", makeAfterTransactionHandler(ydoc, userFieldSets, getUserId));
    const tempId = "550e8400-e29b-41d4-a716-446655440000";
    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_id", null);
      story.set("_temp_id", tempId);
      story.set("title", new Y.Text(""));
      ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
    }, null);
    ydoc.transact(() => {
      (ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text).insert(0, "New");
    }, ORIGIN);
    expect([...(userFieldSets.get(7) ?? [])]).toContain(`stories:${tempId}:title`);
  });

  it("still records keyed Y.Map scalar edits (e.g. draft) — unchanged behaviour", () => {
    const { ydoc, userFieldSets, story } = docWithStory(11);
    ydoc.transact(() => {
      story().set("draft", true);
    }, ORIGIN);
    expect([...(userFieldSets.get(7) ?? [])]).toContain("stories:11:draft");
  });

  it("records config Y.Text edits as config:<field>", () => {
    const ydoc = new Y.Doc();
    const userFieldSets = new Map<number, Set<string>>();
    ydoc.on("afterTransaction", makeAfterTransactionHandler(ydoc, userFieldSets, getUserId));
    ydoc.transact(() => {
      ydoc.getMap("config").set("title", new Y.Text("Site"));
    }, null);
    ydoc.transact(() => {
      (ydoc.getMap("config").get("title") as Y.Text).insert(4, "!");
    }, ORIGIN);
    expect([...(userFieldSets.get(7) ?? [])]).toContain("config:title");
  });
});

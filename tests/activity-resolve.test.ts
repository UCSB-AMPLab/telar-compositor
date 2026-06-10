/**
 * Unit tests for `resolveActivityEntity` (workers/collaboration-helpers.ts) — the
 * pure resolver that turns a buildActivityRows field-path id into the entity's
 * human slug + title for the Start-tab activity feed (Bug 2: the feed showed a
 * raw numeric id / temp UUID instead of the title).
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { resolveActivityEntity } from "../workers/collaboration-helpers";

function doc(setup: (d: Y.Doc) => void): Y.Doc {
  const d = new Y.Doc();
  setup(d);
  return d;
}

describe("resolveActivityEntity", () => {
  it("resolves an existing story by numeric _id to its slug + title", () => {
    const d = doc((dd) => {
      const m = new Y.Map<unknown>();
      m.set("_id", 452);
      m.set("story_id", "sondondo");
      m.set("title", new Y.Text("Sondondo Valley"));
      dd.getArray<Y.Map<unknown>>("stories").push([m]);
    });
    expect(resolveActivityEntity(d, "story", "452")).toEqual({
      entityId: "sondondo",
      entityLabel: "Sondondo Valley",
    });
  });

  it("resolves a freshly-added term by its retained _temp_id (the 'added <uuid>' case)", () => {
    const d = doc((dd) => {
      const m = new Y.Map<unknown>();
      m.set("_id", 5); // backfilled
      m.set("_temp_id", "228d2e35-6499-4c13-880b-1422fd8de355"); // retained after backfill
      m.set("term_id", "maize");
      m.set("title", new Y.Text("Maize"));
      dd.getArray<Y.Map<unknown>>("glossary").push([m]);
    });
    expect(
      resolveActivityEntity(d, "term", "228d2e35-6499-4c13-880b-1422fd8de355"),
    ).toEqual({ entityId: "maize", entityLabel: "Maize" });
  });

  it("binds the object_id slug (a plain string), not the numeric id", () => {
    const d = doc((dd) => {
      const m = new Y.Map<unknown>();
      m.set("_id", 9);
      m.set("object_id", "vasija-7");
      m.set("title", new Y.Text("Vasija"));
      dd.getArray<Y.Map<unknown>>("objects").push([m]);
    });
    expect(resolveActivityEntity(d, "object", "9")).toEqual({
      entityId: "vasija-7",
      entityLabel: "Vasija",
    });
  });

  it("maps config edits to the site title", () => {
    const d = doc((dd) => {
      dd.getMap<unknown>("config").set("title", new Y.Text("Mi Sitio"));
    });
    expect(resolveActivityEntity(d, "config", "title")).toEqual({
      entityId: null,
      entityLabel: "Mi Sitio",
    });
  });

  it("falls back to the raw id + null label when the entity is gone", () => {
    const d = doc(() => {});
    expect(resolveActivityEntity(d, "story", "999")).toEqual({
      entityId: "999",
      entityLabel: null,
    });
  });

  it("returns a null label for an untitled entity (slug still resolves)", () => {
    const d = doc((dd) => {
      const m = new Y.Map<unknown>();
      m.set("_id", 3);
      m.set("term_id", "untitled-abc");
      m.set("title", new Y.Text(""));
      dd.getArray<Y.Map<unknown>>("glossary").push([m]);
    });
    expect(resolveActivityEntity(d, "term", "3")).toEqual({
      entityId: "untitled-abc",
      entityLabel: null,
    });
  });
});

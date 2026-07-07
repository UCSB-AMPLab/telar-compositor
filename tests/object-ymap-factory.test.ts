/**
 * Pins the shared object Y.Map factory (makeObjectYMap) against the snapshot
 * writer's expectations.
 *
 * Root cause class (telar-compositor#23, #24, #25 follow-up): the DO snapshot's
 * pushObjectUpdate binds EVERY editable object column from the Y.Map, and
 * yTextToString(undefined) === "" — so any client-side Y.Map creation site that
 * omits a key silently ERASES that column in D1 on the next snapshot, and the
 * detail editor's getYText(map, key) returns null for absent keys so edits to
 * those fields go nowhere. Three creation sites (upload mirror, addIiifObject,
 * addExternalMediaObject) each hand-rolled their key sets and drifted.
 *
 * The factory is the single source of truth: these tests pin that it sets every
 * key the snapshot UPDATE reads (the canonical list below mirrors the bind list
 * in workers/collaboration.ts pushObjectUpdate), with Y.Text for
 * collaboratively-edited text fields and plain values for passthroughs.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { makeObjectYMap, OBJECT_YTEXT_KEYS, OBJECT_PLAIN_KEYS } from "~/lib/object-ymap";

/**
 * Canonical editable-column list — MUST stay in lockstep with the bind list of
 * pushObjectUpdate in workers/collaboration.ts:
 *   title, creator, description, alt_text, source_url, period, year,
 *   object_type, subjects, source, credit, thumbnail, dimensions,
 *   extra_columns, featured, image_available
 */
const SNAPSHOT_UPDATE_COLUMNS = [
  "title",
  "creator",
  "description",
  "alt_text",
  "source_url",
  "period",
  "year",
  "object_type",
  "subjects",
  "source",
  "credit",
  "thumbnail",
  "dimensions",
  "extra_columns",
  "featured",
  "image_available",
] as const;

function attach(map: Y.Map<unknown>): Y.Map<unknown> {
  // Y.Text values can only be read after the map is attached to a doc.
  const doc = new Y.Doc();
  doc.getArray<Y.Map<unknown>>("objects").push([map]);
  return map;
}

describe("makeObjectYMap", () => {
  it("sets every column the snapshot UPDATE binds (no key can be absent)", () => {
    const map = attach(
      makeObjectYMap({
        objectId: "test-object",
        validationState: "valid",
        origin: "compositor",
      })
    );
    for (const col of SNAPSHOT_UPDATE_COLUMNS) {
      expect(map.has(col), `factory must set "${col}" — an absent key is erased in D1 by the next snapshot`).toBe(true);
    }
  });

  it("exports key lists that exactly cover the snapshot UPDATE columns", () => {
    const covered = new Set<string>([...OBJECT_YTEXT_KEYS, ...OBJECT_PLAIN_KEYS]);
    for (const col of SNAPSHOT_UPDATE_COLUMNS) {
      expect(covered.has(col), `"${col}" missing from the factory's canonical key lists`).toBe(true);
    }
  });

  it("uses Y.Text for collaboratively-edited text fields so getYText() binds", () => {
    const map = attach(
      makeObjectYMap({
        objectId: "test-object",
        validationState: "valid",
        origin: "compositor",
        title: "A title",
        credit: "Courtesy of Neogranadina",
        source: "AGN",
        objectType: "map",
        subjects: "cartography",
        altText: "A described map",
      })
    );
    for (const key of OBJECT_YTEXT_KEYS) {
      expect(map.get(key), `"${key}" must be a Y.Text`).toBeInstanceOf(Y.Text);
    }
    expect((map.get("credit") as Y.Text).toString()).toBe("Courtesy of Neogranadina");
    expect((map.get("source") as Y.Text).toString()).toBe("AGN");
    expect((map.get("object_type") as Y.Text).toString()).toBe("map");
    expect((map.get("subjects") as Y.Text).toString()).toBe("cartography");
    expect((map.get("alt_text") as Y.Text).toString()).toBe("A described map");
  });

  it("alt_text carries the provided alt text, never silently the title", () => {
    const map = attach(
      makeObjectYMap({
        objectId: "x",
        validationState: "valid",
        origin: "repo",
        title: "Title",
        altText: "Real alt text",
      })
    );
    expect((map.get("alt_text") as Y.Text).toString()).toBe("Real alt text");
  });

  it("sets identity/bookkeeping keys (_id, _temp_id, created_by, _validation_state, missing_from_repo)", () => {
    const map = attach(
      makeObjectYMap({
        id: 42,
        tempId: "fixed-temp",
        createdBy: 7,
        objectId: "obj-1",
        validationState: "pending",
        origin: "iiif",
      })
    );
    expect(map.get("_id")).toBe(42);
    expect(map.get("_temp_id")).toBe("fixed-temp");
    expect(map.get("created_by")).toBe(7);
    expect(map.get("object_id")).toBe("obj-1");
    expect(map.get("_validation_state")).toBe("pending");
    expect(map.get("missing_from_repo")).toBe(false);
    expect(map.get("origin")).toBe("iiif");
  });

  it("defaults: null _id, generated _temp_id, empty strings, featured/image_available false", () => {
    const map = attach(
      makeObjectYMap({ objectId: "min", validationState: "valid", origin: "compositor" })
    );
    expect(map.get("_id")).toBeNull();
    expect(typeof map.get("_temp_id")).toBe("string");
    expect((map.get("_temp_id") as string).length).toBeGreaterThan(0);
    expect((map.get("title") as Y.Text).toString()).toBe("");
    expect(map.get("source_url")).toBe("");
    expect(map.get("thumbnail")).toBe("");
    expect(map.get("dimensions")).toBe("");
    expect(map.get("extra_columns")).toBe("");
    expect(map.get("featured")).toBe(false);
    expect(map.get("image_available")).toBe(false);
  });
});

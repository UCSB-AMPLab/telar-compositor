/**
 * A first publish of an imported site, compared with what the import read.
 *
 * A first publish has no snapshot. Without a baseline it names every entity it
 * writes as added, which is true of a site the Compositor created and not of
 * one it imported: there the entities were already in the repository. With
 * the import's hashes recorded, the first publish names only what changed
 * since the import. Everything else about a first publish stays: it is never
 * up to date and it writes every setting. A baseline in another hash format is
 * not compared, since every entity would read as changed.
 *
 * @version v1.5.6-beta
 */

import { describe, it, expect } from "vitest";
import {
  computeChangeSummary,
  importBaselineOf,
  ENTITY_HASHES_VERSION,
  type CurrentPublishState,
  type EntityHashes,
} from "~/lib/publish.server";

function hashes(overrides: Partial<EntityHashes> = {}): EntityHashes {
  return {
    version: ENTITY_HASHES_VERSION,
    pages: { about: "h-about" },
    stories: { s1: "h-s1" },
    objects: { a: "h-a", b: "h-b" },
    glossary: { t1: "h-t1" },
    navigation: "nav",
    landing: "landing",
    settings: "",
    objectOrder: '["a","b"]',
    ...overrides,
  };
}

function state(entityHashes: EntityHashes): CurrentPublishState {
  const ids = (record: Record<string, string>) => Object.keys(record);
  return {
    entityHashes,
    config: null,
    stories: ids(entityHashes.stories).map((story_id) => ({ story_id, title: story_id.toUpperCase() })),
    objects: ids(entityHashes.objects).map((object_id) => ({ object_id, title: object_id.toUpperCase() })),
    pages: ids(entityHashes.pages).map((slug) => ({ slug, title: slug })),
    glossary: ids(entityHashes.glossary).map((term_id) => ({ term_id, title: term_id })),
    allStoryIds: ids(entityHashes.stories),
  };
}

const idsOf = <T>(items: T[], idOf: (item: T) => string) => items.map(idOf);

describe("computeChangeSummary: a first publish after an import", () => {
  it("names every entity as added when there is no baseline", () => {
    const summary = computeChangeSummary(state(hashes()), null);
    expect(idsOf(summary.stories.new, (s) => s.story_id)).toEqual(["s1"]);
    expect(idsOf(summary.objects.new, (o) => o.object_id)).toEqual(["a", "b"]);
    expect(idsOf(summary.pages.new, (p) => p.slug)).toEqual(["about"]);
    expect(idsOf(summary.glossary.new, (g) => g.term_id)).toEqual(["t1"]);
  });

  it("names nothing when nothing changed since the import", () => {
    const summary = computeChangeSummary(state(hashes()), null, hashes());
    for (const bucket of [summary.stories, summary.objects, summary.pages, summary.glossary]) {
      expect(bucket).toEqual({ new: [], modified: [], deleted: [] });
    }
  });

  it("names only what the author added, changed and removed", () => {
    const now = hashes({
      stories: { s1: "h-s1", s2: "h-s2" },
      objects: { a: "h-a-edited", b: "h-b" },
      glossary: {},
    });
    const summary = computeChangeSummary(state(now), null, hashes());
    expect(idsOf(summary.stories.new, (s) => s.story_id)).toEqual(["s2"]);
    expect(summary.stories.modified).toEqual([]);
    expect(idsOf(summary.objects.modified, (o) => o.object_id)).toEqual(["a"]);
    expect(summary.objects.new).toEqual([]);
    expect(summary.glossary.deleted).toEqual([{ term_id: "t1", title: null }]);
    expect(summary.pages).toEqual({ new: [], modified: [], deleted: [] });
  });

  it("stays a first publish: not up to date, and every setting written", () => {
    const summary = computeChangeSummary(state(hashes()), null, hashes());
    expect(summary.isUpToDate).toBe(false);
    expect(summary.settings.changed).toEqual([{ key: "all", label: "All settings (first publish)" }]);
  });

  it("does not compare a baseline in another hash format", () => {
    const summary = computeChangeSummary(state(hashes()), null, hashes({ version: ENTITY_HASHES_VERSION + 1 }));
    expect(idsOf(summary.objects.new, (o) => o.object_id)).toEqual(["a", "b"]);
    expect(summary.objects.modified).toEqual([]);
  });
});

describe("importBaselineOf", () => {
  it("reads the stored JSON back", () => {
    expect(importBaselineOf(JSON.stringify(hashes()))).toEqual(hashes());
  });

  it("answers null for no baseline, for text that is not JSON and for JSON that is not an object", () => {
    expect(importBaselineOf(null)).toBeNull();
    expect(importBaselineOf("")).toBeNull();
    expect(importBaselineOf("{not json")).toBeNull();
    expect(importBaselineOf("null")).toBeNull();
    expect(importBaselineOf("3")).toBeNull();
  });
});

/**
 * Unit tests for aggregateSyncDiff — sums a FullSyncDiff into
 * {added, changed, removed} totals for the out-of-sync popover diff chips.
 * Pure logic, no React, no server runtime.
 */

import { describe, it, expect } from "vitest";
import { aggregateSyncDiff } from "~/components/features/site-status/site-status-diff";
import type { FullSyncDiff } from "~/lib/sync.server";

// ---------------------------------------------------------------------------
// Fixture builders — plain objects typed against the imported sub-shapes.
// We never import a runtime value from a .server module; FullSyncDiff is a
// type-only import, so these literals carry the shape.
// ---------------------------------------------------------------------------

/** An empty (no-divergence) FullSyncDiff. */
function emptyDiff(): FullSyncDiff {
  return {
    objects: {
      newObjects: [],
      changedObjects: [],
      missingObjects: [],
      unregisteredFiles: [],
    },
    stories: {
      newStories: [],
      changedStories: [],
      missingStories: [],
    },
    config: {
      changedFields: [],
      versionChange: null,
    },
    glossary: {
      added: [],
      changed: [],
      removed: [],
    },
    hasConflicts: false,
    classification: "two-way",
    suppressedEditorOnly: 0,
  };
}

/** Fills the three relevant arrays for one sub-shape with `n` dummy entries. */
function fill<T>(n: number): T[] {
  return Array.from({ length: n }, () => ({}) as T);
}

describe("aggregateSyncDiff", () => {
  it("returns {added:0, changed:0, removed:0} for an empty diff", () => {
    expect(aggregateSyncDiff(emptyDiff())).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
    });
  });

  it("sums added = new objects + new stories + glossary added", () => {
    const diff = emptyDiff();
    diff.objects.newObjects = fill(2);
    diff.stories.newStories = fill(3);
    diff.glossary.added = fill(4);
    expect(aggregateSyncDiff(diff).added).toBe(9);
  });

  it("sums changed = changed objects + changed stories + config changedFields + glossary changed", () => {
    const diff = emptyDiff();
    diff.objects.changedObjects = fill(1);
    diff.stories.changedStories = fill(2);
    diff.config.changedFields = fill(3);
    diff.glossary.changed = fill(4);
    expect(aggregateSyncDiff(diff).changed).toBe(10);
  });

  it("sums removed = missing objects + missing stories + glossary removed", () => {
    const diff = emptyDiff();
    diff.objects.missingObjects = fill(5);
    diff.stories.missingStories = fill(1);
    diff.glossary.removed = fill(2);
    expect(aggregateSyncDiff(diff).removed).toBe(8);
  });

  it("does NOT count unregisteredFiles, config versionChange, or hasConflicts toward any total", () => {
    const diff = emptyDiff();
    diff.objects.unregisteredFiles = fill(7);
    diff.config.versionChange = {
      direction: "behind",
      repoVersion: "1.2.0",
      d1Version: "1.1.0",
    };
    diff.hasConflicts = true;
    expect(aggregateSyncDiff(diff)).toEqual({ added: 0, changed: 0, removed: 0 });
  });

  it("computes all three buckets together on a mixed diff", () => {
    const diff = emptyDiff();
    diff.objects.newObjects = fill(1);
    diff.stories.newStories = fill(1);
    diff.glossary.added = fill(1); // added = 3
    diff.objects.changedObjects = fill(2);
    diff.config.changedFields = fill(1); // changed = 3
    diff.objects.missingObjects = fill(1);
    diff.glossary.removed = fill(1); // removed = 2
    expect(aggregateSyncDiff(diff)).toEqual({ added: 3, changed: 3, removed: 2 });
  });
});

// @vitest-environment jsdom
/**
 * Pins the three-way apply builder in SyncConfirmModal — the pure mapping from
 * a FullSyncDiff plus the user's conflict selections onto the FullSyncChanges
 * apply contract. Conflicts default to keep-mine; repo-only changes are
 * pre-accepted; deleted-here restores flow into the insert lists.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect } from "vitest";
import type { FullSyncDiff } from "~/lib/sync.server";
import { buildThreeWayChanges } from "~/components/features/dashboard/SyncConfirmModal";
import { emptyThreeWaySelections as emptySel } from "./sync-probe-fixtures";

function baseDiff(): FullSyncDiff {
  return {
    objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
    stories: { newStories: [], changedStories: [], missingStories: [] },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], removed: [], changed: [] },
    hasConflicts: false,
    classification: "three-way",
    suppressedEditorOnly: 0,
  };
}

describe("buildThreeWayChanges — objects", () => {
  it("a conflict field defaults to keep-mine ('d1'); a repo-only field of the same object stays 'repo'", () => {
    const diff = baseDiff();
    diff.objects.changedObjects = [
      {
        object_id: "obj-1",
        dbId: 1,
        title: "Obj",
        changedFields: ["title", "creator"],
        conflictFields: ["title"], // title is the conflict; creator is repo-only
        d1Values: { title: "mine", creator: "mine-c" },
        repoValues: { title: "repo", creator: "repo-c" },
      },
    ];

    const changes = buildThreeWayChanges(diff, emptySel());

    expect(changes.objects.changedObjectIds).toContain("obj-1");
    expect(changes.objects.fieldChoices["obj-1"].title).toBe("d1"); // keep mine
    expect(changes.objects.fieldChoices["obj-1"].creator).toBe("repo"); // pre-accepted
  });

  it("a conflict field set to use-repo emits 'repo'", () => {
    const diff = baseDiff();
    diff.objects.changedObjects = [
      {
        object_id: "obj-1",
        dbId: 1,
        title: "Obj",
        changedFields: ["title"],
        conflictFields: ["title"],
        d1Values: { title: "mine" },
        repoValues: { title: "repo" },
      },
    ];
    const sel = emptySel();
    sel.objectFieldChoices = { "obj-1": { title: "repo" } };

    const changes = buildThreeWayChanges(diff, sel);
    expect(changes.objects.fieldChoices["obj-1"].title).toBe("repo");
  });

  it("a deleted-here object is restored only when the user opts in", () => {
    const diff = baseDiff();
    diff.objects.newObjects = [
      { object_id: "del-1", title: null, creator: null, description: null, period: null, year: null, object_type: null, subjects: null, source: null, credit: null, thumbnail: null, featured: false, source_url: null, dimensions: null, image_available: false, deletedInCompositor: true },
      { object_id: "new-1", title: null, creator: null, description: null, period: null, year: null, object_type: null, subjects: null, source: null, credit: null, thumbnail: null, featured: false, source_url: null, dimensions: null, image_available: false },
    ];

    // Default (keep deleted): genuine new is inserted, deleted-here is not.
    let changes = buildThreeWayChanges(diff, emptySel());
    expect(changes.objects.newObjectIds).toContain("new-1");
    expect(changes.objects.newObjectIds).not.toContain("del-1");

    // Restore opt-in: deleted-here now included.
    const sel = emptySel();
    sel.objectRestore = { "del-1": true };
    changes = buildThreeWayChanges(diff, sel);
    expect(changes.objects.newObjectIds).toContain("del-1");
  });

  it("missing objects are pre-accepted for removal", () => {
    const diff = baseDiff();
    diff.objects.missingObjects = [{ object_id: "gone", dbId: 2, title: "Gone", usedByStories: [] }];
    const changes = buildThreeWayChanges(diff, emptySel());
    expect(changes.objects.removedObjectIds).toEqual(["gone"]);
  });

  it("a deleted-in-repo/edited-here object defaults to keep-mine; delete opt-in removes it", () => {
    const diff = baseDiff();
    diff.objects.missingObjects = [
      { object_id: "plain", dbId: 2, title: "Plain", usedByStories: [] },
      { object_id: "edited", dbId: 3, title: "Edited", usedByStories: [], editedInCompositor: true },
    ];

    // Default keep-mine: only the unflagged object is removed.
    let changes = buildThreeWayChanges(diff, emptySel());
    expect(changes.objects.removedObjectIds).toContain("plain");
    expect(changes.objects.removedObjectIds).not.toContain("edited");

    // Delete opt-in: the flagged object joins the removals.
    const sel = emptySel();
    sel.objectDelete = { edited: true };
    changes = buildThreeWayChanges(diff, sel);
    expect(changes.objects.removedObjectIds).toContain("edited");
  });
});

describe("buildThreeWayChanges — rows (stories, config, glossary)", () => {
  it("a story conflict defaults to reject; use-repo moves it to accept", () => {
    const diff = baseDiff();
    diff.stories.changedStories = [
      { story_id: "s1", title: "S1", changedFields: ["title"], conflict: true, d1Values: { title: "mine" }, repoValues: { title: "repo" } },
      { story_id: "s2", title: "S2", changedFields: ["title"], conflict: false, d1Values: {}, repoValues: {} },
    ];

    // Defaults: conflict s1 rejected, repo-only s2 accepted.
    let changes = buildThreeWayChanges(diff, emptySel());
    expect(changes.stories.reject).toContain("s1");
    expect(changes.stories.accept).toContain("s2");
    expect(changes.stories.accept).not.toContain("s1");

    // Opt to use GitHub's version for s1.
    const sel = emptySel();
    sel.storyChoices = { s1: "repo" };
    changes = buildThreeWayChanges(diff, sel);
    expect(changes.stories.accept).toContain("s1");
    expect(changes.stories.reject).not.toContain("s1");
  });

  it("new stories are pre-accepted for insert", () => {
    const diff = baseDiff();
    diff.stories.newStories = [
      { story_id: "n1", title: "N", subtitle: null, byline: null, order: 0, isPrivate: false, showSections: true },
    ];
    const changes = buildThreeWayChanges(diff, emptySel());
    expect(changes.stories.insertNew).toEqual(["n1"]);
  });

  it("a deleted-here (edited-there) story restores only on opt-in; genuine new still inserts", () => {
    const diff = baseDiff();
    diff.stories.newStories = [
      { story_id: "n1", title: "N", subtitle: null, byline: null, order: 0, isPrivate: false, showSections: true },
      { story_id: "del", title: "D", subtitle: null, byline: null, order: 0, isPrivate: false, showSections: true, deletedInCompositor: true },
    ];

    // Default keep-deleted: genuine new inserts, deleted-here does not.
    let changes = buildThreeWayChanges(diff, emptySel());
    expect(changes.stories.insertNew).toContain("n1");
    expect(changes.stories.insertNew).not.toContain("del");

    // Restore opt-in.
    const sel = emptySel();
    sel.storyRestore = { del: true };
    changes = buildThreeWayChanges(diff, sel);
    expect(changes.stories.insertNew).toContain("del");
  });

  it("a config conflict defaults to reject; a non-conflict config is accepted", () => {
    const diff = baseDiff();
    diff.config.changedFields = [
      { key: "title", d1Value: "mine", repoValue: "repo", conflict: true },
      { key: "author", d1Value: "a", repoValue: "b", conflict: false },
    ];
    const changes = buildThreeWayChanges(diff, emptySel());
    expect(changes.config.reject).toContain("title");
    expect(changes.config.accept).toContain("author");

    const sel = emptySel();
    sel.configChoices = { title: "repo" };
    expect(buildThreeWayChanges(diff, sel).config.accept).toContain("title");
  });

  it("glossary: changed conflict defaults to reject; deleted-here term restores on opt-in", () => {
    const diff = baseDiff();
    diff.glossary.changed = [
      { term_id: "t1", title: "T1", dbId: 1, d1Title: "mine", repoTitle: "repo", d1Definition: "", repoDefinition: "", d1RelatedTerms: "", repoRelatedTerms: "", conflict: true },
    ];
    diff.glossary.added = [
      { term_id: "add-1", title: "A", definition: "d", related_terms: "" },
      { term_id: "del-1", title: "D", definition: "d", related_terms: "", deletedInCompositor: true },
    ];

    let changes = buildThreeWayChanges(diff, emptySel());
    expect(changes.glossary.reject).toContain("t1");
    expect(changes.glossary.insertNew).toContain("add-1");
    expect(changes.glossary.insertNew).not.toContain("del-1");

    const sel = emptySel();
    sel.glossaryChangedChoices = { t1: "repo" };
    sel.glossaryRestore = { "del-1": true };
    changes = buildThreeWayChanges(diff, sel);
    expect(changes.glossary.accept).toContain("t1");
    expect(changes.glossary.insertNew).toContain("del-1");
  });
});

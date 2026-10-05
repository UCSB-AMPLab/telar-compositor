// @vitest-environment jsdom
/**
 * Pins the SyncConflictsBlock's completeness for a conflicted object that
 * ALSO carries repo-only changed fields. Those fields apply pre-accepted and
 * the object is excluded from the modal's category lists, so the conflict
 * card is the only place they can be disclosed: they must render in the
 * muted also-applying section (label + incoming GitHub value) WITHOUT a
 * choice control, while conflict fields keep their radios.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";

// Key-passthrough i18n so assertions key off translation keys, not copy.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { SyncConflictsBlock } from "~/components/features/dashboard/SyncConflictsBlock";
import type { ThreeWaySelections } from "~/components/features/dashboard/SyncConfirmModal";

const emptySelections: ThreeWaySelections = {
  storyContentChoices: {},
  pageContentChoices: {},
  objectFieldChoices: {},
  objectRestore: {},
  objectDelete: {},
  storyChoices: {},
  configChoices: {},
  glossaryChangedChoices: {},
  glossaryRestore: {},
  storyRestore: {},
};

const diff: FullSyncDiff = {
  objects: {
    newObjects: [],
    changedObjects: [
      {
        object_id: "obj-1",
        dbId: 1,
        title: "Obj one",
        changedFields: ["title", "creator"],
        conflictFields: ["creator"],
        d1Values: { title: "mine-title", creator: "mine-creator" },
        repoValues: { title: "repo-title", creator: "repo-creator" },
      },
    ],
    missingObjects: [],
    unregisteredFiles: [], reordered: null,
  },
  stories: { newStories: [], changedStories: [], missingStories: [] },
  config: { changedFields: [], versionChange: null },
  glossary: { added: [], removed: [], changed: [] },
  hasConflicts: true,
  classification: "three-way",
  suppressedEditorOnly: 0,
  unreadableFiles: [],
};

function renderBlock() {
  return render(
    <SyncConflictsBlock
      diff={diff}
      selections={emptySelections}
      onObjectFieldChoice={vi.fn()}
      onObjectRestore={vi.fn()}
      onRowChoice={vi.fn()}
      onGlossaryRestore={vi.fn()}
      onObjectDelete={vi.fn()}
      onStoryRestore={vi.fn()}
    />,
  );
}

describe("SyncConflictsBlock also-applying section", () => {
  it("lists repo-only fields of a conflicted object with the incoming value, no radios", () => {
    const { getByText, container } = renderBlock();

    getByText("sync_modal.conflict_also_applying");
    getByText("objects:sync_field.title");
    getByText("repo-title");

    // The conflict field keeps its radio pair; the repo-only field adds none.
    const radios = container.querySelectorAll('input[type="radio"]');
    expect(radios).toHaveLength(2);
    for (const r of radios) {
      expect((r as HTMLInputElement).name).toBe("obj-obj-1-creator");
    }

    // The repo-only field's value renders once (no ValuePair strikethrough pair).
    expect(container.textContent).not.toContain("mine-title");
  });

  it("omits the section when every changed field is a conflict", () => {
    diff.objects.changedObjects[0].changedFields = ["creator"];
    const { queryByText } = renderBlock();
    expect(queryByText("sync_modal.conflict_also_applying")).toBeNull();
    diff.objects.changedObjects[0].changedFields = ["title", "creator"];
  });
});

describe("SyncConflictsBlock with ids that name Object.prototype's own properties", () => {
  const blankNew = { title: null, creator: null, description: null, period: null, year: null, object_type: null, subjects: null, source: null, credit: null, thumbnail: null, featured: false, source_url: null, dimensions: null, image_available: false };

  /** The value of the checked radio in each group, by group name. */
  function checkedByGroup(container: HTMLElement): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of container.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')) out[r.name] = r.value;
    return out;
  }

  it.each(["constructor", "__proto__"])("%s: an untouched deleted-here or deleted-on-GitHub card shows the author's version chosen", (id) => {
    const idDiff: FullSyncDiff = {
      ...diff,
      objects: {
        ...diff.objects,
        changedObjects: [],
        newObjects: [{ object_id: id, ...blankNew, deletedInCompositor: true }],
        missingObjects: [{ object_id: id, dbId: 3, title: "Edited", usedByStories: [], editedInCompositor: true }],
      },
      glossary: { ...diff.glossary, added: [{ term_id: id, title: "D", definition: "d", related_terms: "", extra_columns: "", deletedInCompositor: true }] },
    };
    const { container } = render(
      <SyncConflictsBlock
        diff={idDiff}
        selections={emptySelections}
        onObjectFieldChoice={vi.fn()}
        onObjectRestore={vi.fn()}
        onRowChoice={vi.fn()}
        onGlossaryRestore={vi.fn()}
        onObjectDelete={vi.fn()}
        onStoryRestore={vi.fn()}
      />,
    );
    expect(checkedByGroup(container)).toEqual({
      [`del-obj-${id}`]: "d1",
      [`del-repo-obj-${id}`]: "d1",
      [`gloss-del-${id}`]: "d1",
    });
  });
});

describe("SyncConflictsBlock story and term conflict cards", () => {
  const rowDiff: FullSyncDiff = {
    ...diff,
    objects: { ...diff.objects, changedObjects: [] },
    stories: {
      newStories: [],
      changedStories: [{
        story_id: "s1", title: "Story", changedFields: ["title", "subtitle"], conflictFields: ["title"], conflict: true,
        d1Values: { title: "story-mine", subtitle: "sub-mine" }, repoValues: { title: "story-repo", subtitle: "sub-repo" },
      }],
      missingStories: [],
    },
    glossary: {
      added: [], removed: [],
      changed: [{
        term_id: "t1", title: "Term", dbId: 1, d1Title: "term-mine", repoTitle: "term-repo",
        d1Definition: "def-mine", repoDefinition: "def-repo", d1RelatedTerms: "rel-mine", repoRelatedTerms: "rel-mine",
        d1ExtraColumns: "", repoExtraColumns: "", changedFields: ["title", "definition"], conflictFields: ["definition"],
        conflict: true,
      }],
    },
  };

  it("shows each conflicting field under the row's choice and lists the GitHub-only ones as also applying", () => {
    const { getAllByText, container } = render(
      <SyncConflictsBlock
        diff={rowDiff}
        selections={emptySelections}
        onObjectFieldChoice={vi.fn()}
        onObjectRestore={vi.fn()}
        onRowChoice={vi.fn()}
        onGlossaryRestore={vi.fn()}
        onObjectDelete={vi.fn()}
        onStoryRestore={vi.fn()}
      />,
    );

    expect(getAllByText("sync_modal.conflict_also_applying")).toHaveLength(2);
    // Keep-mine strikes the conflicting field's GitHub value; a GitHub-only field shows GitHub's chosen.
    const struck = [...container.querySelectorAll(".line-through")].map((el) => el.textContent);
    expect(struck).toEqual(["story-repo", "sub-mine", "def-repo", "term-mine"]);
  });
});

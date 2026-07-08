// @vitest-environment jsdom
/**
 * Pins the SyncConflictsBlock's completeness for a conflicted object that
 * ALSO carries repo-only changed fields. Those fields apply pre-accepted and
 * the object is excluded from the modal's category lists, so the conflict
 * card is the only place they can be disclosed: they must render in the
 * muted also-applying section (label + incoming GitHub value) WITHOUT a
 * choice control, while conflict fields keep their radios.
 *
 * @version v1.4.1-beta
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
    unregisteredFiles: [],
  },
  stories: { newStories: [], changedStories: [], missingStories: [] },
  config: { changedFields: [], versionChange: null },
  glossary: { added: [], removed: [], changed: [] },
  hasConflicts: true,
  classification: "three-way",
  suppressedEditorOnly: 0,
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

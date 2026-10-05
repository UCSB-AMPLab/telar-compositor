// @vitest-environment jsdom
/**
 * The objects page's sync dialog on a three-way check: rows the full
 * sync treats as conflicts open on its defaults and say why, and the count of
 * Compositor changes the check left untouched is shown. A two-way check keeps
 * every row ticked and every field on the editor's value.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { SyncDiff, SyncField } from "~/lib/sync.server";
import { SyncDiffDialog } from "~/components/features/objects/SyncDiffDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === "string" ? fallback : key),
  }),
}));

afterEach(cleanup);

/** `suppressedEditorOnly` null is a two-way check, which carries no count. */
function threeWayDialogDiff(parts: Partial<SyncDiff>, suppressedEditorOnly: number | null = 0): SyncDiff {
  return {
    newObjects: [],
    changedObjects: [],
    missingObjects: [],
    unregisteredFiles: [],
    reordered: null,
    ...(suppressedEditorOnly !== null ? { suppressedEditorOnly } : {}),
    ...parts,
  };
}

function renderThreeWayDialog(diff: SyncDiff) {
  return render(
    <SyncDiffDialog open onClose={() => {}} diffData={diff} onApply={vi.fn()} isComputing={false} isApplying={false} />,
  ).baseElement;
}

const deletedHere = {
  object_id: "o3", title: "Third", creator: null, description: null, period: null, year: null,
  object_type: null, subjects: null, source: null, credit: null, thumbnail: null, featured: false,
  source_url: null, dimensions: null, image_available: false, deletedInCompositor: true as const,
};

describe("the objects page's sync dialog on a three-way check", () => {
  it("leaves an object deleted here unticked, says why, and raises no warning for it", () => {
    renderThreeWayDialog(threeWayDialogDiff({ newObjects: [deletedHere] }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("dashboard:sync_modal.conflict_deleted_here")).toBeTruthy();
    expect(screen.getByTestId("sync-new-hint").getAttribute("data-state")).toBe("hint");
  });

  it("leaves an object deleted on GitHub and edited here unticked, and says why", () => {
    renderThreeWayDialog(threeWayDialogDiff({
      missingObjects: [{ object_id: "o4", dbId: 4, title: "Fourth", usedByStories: [], editedInCompositor: true }],
    }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("dashboard:sync_modal.conflict_deleted_in_repo")).toBeTruthy();
  });

  it("shows the count of Compositor changes the check left untouched", () => {
    renderThreeWayDialog(threeWayDialogDiff({}, 2));
    expect(screen.getByTestId("sync-editor-only").textContent).toBe("dashboard:sync_modal.editor_only_note");
  });

  it("opens a field only GitHub moved on GitHub's value", () => {
    const container = renderThreeWayDialog(threeWayDialogDiff({
      changedObjects: [{
        object_id: "o5", dbId: 5, title: "Fifth", changedFields: ["creator" as SyncField], conflictFields: [],
        d1Values: { creator: "Ana" }, repoValues: { creator: "Ana on GitHub" },
      }],
    }));
    const repo = container.querySelector('input[type="radio"][name="o5-creator"][value="repo"]') as HTMLInputElement;
    expect(repo.checked).toBe(true);
  });
});

describe("a three-way check whose only listed change is a deletion conflict", () => {
  function applyDeletionConflictDefaults(diff: SyncDiff) {
    const onApply = vi.fn();
    render(
      <SyncDiffDialog open onClose={() => {}} diffData={diff} onApply={onApply} isComputing={false} isApplying={false} />,
    );
    const apply = screen.getByRole("button", { name: "sync_apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    return onApply.mock.calls[0][0];
  }

  it("can apply keeping an object deleted here, and posts the commit reviewed", () => {
    const posted = applyDeletionConflictDefaults(threeWayDialogDiff({ newObjects: [deletedHere], headSha: "h".repeat(40) }));
    expect(posted).toMatchObject({ newObjectIds: [], removedObjectIds: [], headSha: "h".repeat(40) });
  });

  it("can apply keeping an object edited here and deleted on GitHub", () => {
    const posted = applyDeletionConflictDefaults(threeWayDialogDiff({
      missingObjects: [{ object_id: "o4", dbId: 4, title: "Fourth", usedByStories: [], editedInCompositor: true }],
      headSha: "h".repeat(40),
    }));
    expect(posted).toMatchObject({ newObjectIds: [], removedObjectIds: [], headSha: "h".repeat(40) });
  });
});

describe("the objects page's sync dialog on a two-way check", () => {
  it("ticks every row, keeps the editor's value, and shows no count", () => {
    const container = renderThreeWayDialog(threeWayDialogDiff({
      changedObjects: [{
        object_id: "o5", dbId: 5, title: "Fifth", changedFields: ["creator" as SyncField], conflictFields: [],
        d1Values: { creator: "Ana" }, repoValues: { creator: "Ana on GitHub" },
      }],
      missingObjects: [{ object_id: "o4", dbId: 4, title: "Fourth", usedByStories: [] }],
    }, null));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, true]);
    const mine = container.querySelector('input[type="radio"][name="o5-creator"][value="d1"]') as HTMLInputElement;
    expect(mine.checked).toBe(true);
    expect(screen.queryByTestId("sync-editor-only")).toBeNull();
  });
});

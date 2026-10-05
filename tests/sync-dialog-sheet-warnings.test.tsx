// @vitest-environment jsdom
/**
 * Both sync dialogs show the warnings the check found in the repository's
 * sheets, above the changes: the objects page's dialog, and the
 * full sync dialog on its conflict and diffReady steps. A check with nothing
 * to apply still shows them, since what they describe is lost at the next
 * publish whether or not anything is synced.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import type { FullSyncDiff, SyncDiff } from "~/lib/sync.server";
import type { SheetWarning } from "~/lib/sheet-warnings";

const fetcherData: { current: unknown } = { current: undefined };
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ submit: vi.fn(), state: "idle", data: fetcherData.current }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

import { SyncDiffDialog } from "~/components/features/objects/SyncDiffDialog";
import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";

const WARNINGS: SheetWarning[] = [
  { code: "ragged_row", row: { label: "obj-002" }, sheet: "objects.csv" },
  { code: "tree_truncated" },
];

function objectsDiff(extra: Partial<SyncDiff> = {}): SyncDiff {
  return { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null, ...extra };
}

function fullDiff(extra: Partial<FullSyncDiff> = {}): FullSyncDiff {
  return {
    objects: objectsDiff(),
    stories: { newStories: [], changedStories: [], missingStories: [], content: { conclusive: true, changes: [], suppressedEditorOnly: 0 } },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], changed: [], removed: [] },
    hasConflicts: false,
    classification: "three-way",
    suppressedEditorOnly: 0,
    unreadableFiles: [],
    headSha: "0123456789abcdef0123456789abcdef01234567",
    ...extra,
  };
}

function shownWarnings(): string[] {
  return screen
    .queryAllByRole("listitem")
    .map((li) => li.textContent ?? "")
    .filter((text) => text.startsWith("sheet_warnings."));
}

beforeEach(() => {
  fetcherData.current = undefined;
});

describe("the objects page's sync dialog", () => {
  function renderDialog(diff: SyncDiff) {
    render(
      <SyncDiffDialog open onClose={() => {}} diffData={diff} onApply={() => {}} isComputing={false} isApplying={false} />,
    );
  }

  it("shows the check's warnings", () => {
    renderDialog(objectsDiff({ warnings: WARNINGS, newObjects: [{ object_id: "obj-001", title: "First" } as SyncDiff["newObjects"][number]] }));
    expect(shownWarnings()).toEqual([
      'sheet_warnings.ragged_row.named {"row":"obj-002","sheet":"objects.csv"}',
      "sheet_warnings.tree_truncated",
    ]);
  });

  it("shows them when there is nothing to apply", () => {
    renderDialog(objectsDiff({ warnings: WARNINGS }));
    expect(shownWarnings()).toHaveLength(2);
  });

  it("shows nothing for a check without warnings", () => {
    renderDialog(objectsDiff());
    expect(shownWarnings()).toEqual([]);
  });
});

describe("the full sync dialog", () => {
  function renderWithDiff(diff: FullSyncDiff, unpublishedCount = 0) {
    const view = render(<SyncConfirmModal open unpublishedCount={unpublishedCount} onClose={() => {}} />);
    fireEvent.click(screen.getByText("sync_modal.check_changes"));
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
    view.rerender(<SyncConfirmModal open unpublishedCount={unpublishedCount} onClose={() => {}} />);
  }

  it("shows the check's warnings on the diffReady step", () => {
    renderWithDiff(fullDiff({ warnings: WARNINGS }));
    expect(shownWarnings()).toEqual([
      'sheet_warnings.ragged_row.named {"row":"obj-002","sheet":"objects.csv"}',
      "sheet_warnings.tree_truncated",
    ]);
  });

  it("shows them on the conflict step", () => {
    renderWithDiff(
      fullDiff({
        warnings: WARNINGS,
        classification: "two-way",
        config: { changedFields: [{ key: "title", d1Value: "A", repoValue: "B", conflict: false }], versionChange: null },
      }),
      2,
    );
    expect(screen.getByText("sync_modal.sync_anyway")).toBeTruthy();
    expect(shownWarnings()).toHaveLength(2);
  });

  it("shows nothing for a check without warnings", () => {
    renderWithDiff(fullDiff());
    expect(shownWarnings()).toEqual([]);
  });
});

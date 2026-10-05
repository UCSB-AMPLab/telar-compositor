// @vitest-environment jsdom
/**
 * What the two sync dialogs show for a reorder of objects on GitHub.
 *
 * A reorder has no choice: it is one line, applied with the sync. In the
 * objects page's dialog it follows the changed objects; in the full sync's it
 * is one item among the objects, counted in that section's number. A check
 * whose only change is a reorder has an enabled apply in both.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { FullSyncDiff, SyncDiff } from "~/lib/sync.server";

const submitSpy = vi.fn();
const fetcherData: { current: unknown } = { current: undefined };
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ submit: submitSpy, state: "idle", data: fetcherData.current }),
    useNavigate: () => vi.fn(),
    useRouteLoaderData: () => ({ activeProjectId: 7 }),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

import { SyncDiffDialog } from "~/components/features/objects/SyncDiffDialog";
import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";

const REORDER = { order: [{ objectId: "b", docId: 2 }, { objectId: "a", docId: 1 }] };
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function objectsDiff(reordered: SyncDiff["reordered"]): SyncDiff {
  return { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered, headSha: HEAD };
}

function fullDiff(reordered: SyncDiff["reordered"]): FullSyncDiff {
  return {
    objects: objectsDiff(reordered),
    stories: { newStories: [], changedStories: [], missingStories: [] },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], changed: [], removed: [] },
    hasConflicts: false,
    classification: "three-way",
    suppressedEditorOnly: 0,
    unreadableFiles: [],
    projectId: 7,
    baseSha: null,
    headSha: HEAD,
  };
}

beforeEach(() => {
  submitSpy.mockClear();
  fetcherData.current = undefined;
});

afterEach(() => {
  cleanup();
});

describe("the objects page's dialog", () => {
  function renderDialog(diffData: SyncDiff, onApply = vi.fn()) {
    render(
      <SyncDiffDialog open onClose={() => {}} diffData={diffData} onApply={onApply} isComputing={false} isApplying={false} />,
    );
    return onApply;
  }

  it("shows the line, and an enabled apply, for a check whose only change is a reorder", () => {
    const onApply = renderDialog(objectsDiff(REORDER));
    expect(screen.getByText("sync_order_changed")).toBeTruthy();
    expect(screen.queryByText("sync_no_changes")).toBeNull();
    const apply = screen.getByText("sync_apply").closest("button") as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ headSha: HEAD }));
  });

  it("shows no line without a reorder", () => {
    renderDialog(objectsDiff(null));
    expect(screen.queryByText("sync_order_changed")).toBeNull();
    expect(screen.getByText("sync_no_changes")).toBeTruthy();
  });
});

describe("the full sync's dialog", () => {
  function atDiffReady(diff: FullSyncDiff) {
    const view = render(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    fireEvent.click(view.getByText("sync_modal.check_changes"));
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    return view;
  }

  it("lists the reorder as one item among the objects, with an enabled apply", () => {
    atDiffReady(fullDiff(REORDER));
    // The section opens on a click, as every category section does.
    fireEvent.click(screen.getByText("sync_modal.objects_category (sync_modal.section_count:1)"));
    expect(screen.getByText("objects:sync_order_changed")).toBeTruthy();
    const apply = screen.getByText("sync_modal.apply_sync").closest("button") as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
  });

  it("lists no reorder without one", () => {
    atDiffReady(fullDiff(null));
    expect(screen.queryByText(/sync_modal\.objects_category/)).toBeNull();
    expect(screen.queryByText("objects:sync_order_changed")).toBeNull();
  });
});

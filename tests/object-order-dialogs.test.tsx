// @vitest-environment jsdom
/**
 * What the sync dialog shows for a reorder of objects on GitHub.
 *
 * A reorder has no choice: it is a notice, applied with the sync, and "When
 * you apply" speaks for it (`applySummaryOf`). A check whose only change is a
 * reorder has an enabled apply.
 *
 * @version v1.5.5-beta
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

describe("the full sync's dialog", () => {
  function atDiffReady(diff: FullSyncDiff) {
    const view = render(<SyncConfirmModal open onClose={() => {}} />);
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    return view;
  }

  it("shows the reorder as a notice with no choice, said in When you apply, with an enabled apply", () => {
    atDiffReady(fullDiff(REORDER));
    expect(screen.getByText("objects:sync_order_changed")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByTestId("when-you-apply").textContent).toContain("sync_modal.review.compositor_does");
    const apply = screen.getByText("sync_modal.review.apply").closest("button") as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
  });

  it("lists no reorder without one", () => {
    atDiffReady(fullDiff(null));
    expect(screen.queryByTestId("sync-notices")).toBeNull();
    expect(screen.queryByText("objects:sync_order_changed")).toBeNull();
  });
});

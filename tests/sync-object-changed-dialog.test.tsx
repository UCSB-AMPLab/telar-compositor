// @vitest-environment jsdom
/**
 * The full sync's dialog when the accept left an object field edited in the
 * Compositor since the check: the list is checked again, and the
 * notice names the object, as it does for a story changed while reviewed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";

const objectChangedSubmit = vi.fn();
const objectChangedFetcher: { current: unknown } = { current: undefined };
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ submit: objectChangedSubmit, state: "idle", data: objectChangedFetcher.current }),
    useNavigate: () => vi.fn(),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";

const OBJECT_CHANGED_HEAD = "0123456789abcdef0123456789abcdef01234567";

function objectChangedDiff(): FullSyncDiff {
  return {
    objects: {
      newObjects: [],
      changedObjects: [{
        object_id: "o1", dbId: 1, title: "Map of the coast", changedFields: ["title"], conflictFields: [],
        d1Values: { title: "Map" }, repoValues: { title: "Map of the coast" },
      }],
      missingObjects: [],
      unregisteredFiles: [],
      reordered: null,
    },
    stories: { newStories: [], changedStories: [], missingStories: [] },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], changed: [], removed: [] },
    hasConflicts: false,
    classification: "three-way",
    suppressedEditorOnly: 0,
    unreadableFiles: [],
    headSha: OBJECT_CHANGED_HEAD,
  } as FullSyncDiff;
}

function renderObjectChangedModal() {
  const view = render(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
  fireEvent.click(screen.getByText("sync_modal.check_changes"));
  objectChangedFetcher.current = { ok: true, intent: "compute-full-sync-diff", diff: objectChangedDiff() };
  view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
  return view;
}

describe("an accept that left an object field edited since the check", () => {
  it("posts the value the check read, then checks again and names the object", () => {
    const view = renderObjectChangedModal();
    fireEvent.click(screen.getByText(/^sync_modal\.apply_(sync|other_changes)$/));
    const call = objectChangedSubmit.mock.calls.find(([body]) => (body as { intent?: string }).intent === "apply-full-sync");
    expect(JSON.parse((call![0] as { changes: string }).changes).objects.fieldsSeen).toEqual({ o1: { title: "Map" } });

    objectChangedSubmit.mockClear();
    objectChangedFetcher.current = {
      ok: false, intent: "apply-full-sync", error: "object_changed_since_review", objectIds: ["o1"],
    };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(objectChangedSubmit).toHaveBeenCalledWith({ intent: "compute-full-sync-diff" }, expect.anything());

    objectChangedFetcher.current = { ok: true, intent: "compute-full-sync-diff", diff: objectChangedDiff() };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(screen.getByText(/sync_modal\.object_changed_none_applied/).textContent).toContain("Map of the coast");
  });
});

// @vitest-environment jsdom
/**
 * The sync modal's failed step names a sheet the sync refused for its
 * colliding columns, whether the refusal came from computing the diff or from
 * applying it, and shows the general sync failure message, never the server's text, for any other failure.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";

// The diff fetcher is the keyed one; the apply fetcher has no key. Data is
// read live from this object on every render — nothing here auto-advances
// it, so a test that wants a submission answered has to set it and force a
// render, the same way react-router only updates fetcher.data once a real
// response lands.
const fetcherData: { diff: unknown; apply: unknown } = { diff: undefined, apply: undefined };
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: (opts?: { key?: string }) => ({
      submit: vi.fn(),
      state: "idle",
      data: opts?.key ? fetcherData.diff : fetcherData.apply,
    }),
    useNavigate: () => vi.fn(),
  };
});

// The key and its options, so assertions read what the message is built from.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";

const COLLIDING = { sheet: "project.csv", canonicalName: "subtitle", headers: ["subtitle", "subtítulo"] };
const EXPECTED =
  'sync_modal.error_colliding_columns {"sheet":"project.csv","columns":"\\"subtitle\\", \\"subtítulo\\""}';

const SUCCESS_DIFF: FullSyncDiff = {
  objects: {
    newObjects: [{ object_id: "o1" } as never],
    changedObjects: [],
    missingObjects: [],
    unregisteredFiles: [],
  } as never,
  stories: { newStories: [], changedStories: [], missingStories: [] } as never,
  config: { changedFields: [], versionChange: null } as never,
  glossary: { added: [], changed: [], removed: [] } as never,
  hasConflicts: false,
  classification: "two-way",
  suppressedEditorOnly: 0,
  unreadableFiles: [],
};

function renderModal() {
  return render(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
}

describe("SyncConfirmModal — a sheet the sync refuses", () => {
  beforeEach(() => {
    fetcherData.diff = undefined;
    fetcherData.apply = undefined;
  });

  it("names the sheet and the columns when computing the diff is refused", () => {
    const { getByText, rerender } = renderModal();
    fireEvent.click(getByText("sync_modal.check_changes"));
    fetcherData.diff = {
      ok: false,
      intent: "compute-full-sync-diff",
      error: "colliding_columns",
      collidingColumns: COLLIDING,
    };
    rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(getByText(EXPECTED)).toBeTruthy();
  });

  it("acts on the fresh response to a retried check, not the previous failure", () => {
    const { getByText, queryByText, rerender } = renderModal();

    // First check fails.
    fireEvent.click(getByText("sync_modal.check_changes"));
    fetcherData.diff = {
      ok: false,
      intent: "compute-full-sync-diff",
      error: "colliding_columns",
      collidingColumns: COLLIDING,
    };
    rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(getByText(EXPECTED)).toBeTruthy();

    // Retry, then check again. React Router keeps the previous (failed)
    // response in fetcher.data while the new request is in flight — the
    // mock mirrors that by leaving fetcherData.diff on the old failure
    // across this second submission.
    fireEvent.click(getByText("sync_modal.retry"));
    fireEvent.click(getByText("sync_modal.check_changes"));
    rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(queryByText(EXPECTED)).toBeNull();

    // The fresh response lands — a success this time.
    fetcherData.diff = {
      ok: true,
      intent: "compute-full-sync-diff",
      diff: SUCCESS_DIFF,
    };
    rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(getByText("sync_modal.apply_sync")).toBeTruthy();
    expect(queryByText(EXPECTED)).toBeNull();
  });

  it("names the sheet and the columns when applying is refused", () => {
    fetcherData.apply = {
      ok: false,
      intent: "apply-full-sync",
      error: "colliding_columns",
      collidingColumns: COLLIDING,
    };
    const { getByText } = renderModal();
    expect(getByText(EXPECTED)).toBeTruthy();
  });

  it.each([
    ["compute-full-sync-diff", "diff"],
    ["apply-full-sync", "apply"],
  ] as const)("names a sheet %s could not read, and says nothing was synced", (intent, fetcher) => {
    const answer = { ok: false, intent, error: "sheet_unreadable", sheet: "glossary.csv" };
    if (fetcher === "apply") fetcherData.apply = answer;
    const { getByText, rerender } = renderModal();
    if (fetcher === "diff") {
      fireEvent.click(getByText("sync_modal.check_changes"));
      fetcherData.diff = answer;
      rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    }
    expect(getByText('sync_modal.error_sheet_unreadable {"sheet":"glossary.csv"}')).toBeTruthy();
    expect(getByText("sync_modal.retry")).toBeTruthy();
  });

  it("names a file other than a sheet that the sync could not read", () => {
    fetcherData.apply = { ok: false, intent: "apply-full-sync", error: "file_unreadable", file: "_config.yml" };
    const { getByText } = renderModal();
    expect(getByText('sync_modal.error_file_unreadable {"file":"_config.yml"}')).toBeTruthy();
  });

  it("shows the general sync failure message, not the server's text, for any other failure", () => {
    fetcherData.apply = {
      ok: false,
      intent: "apply-full-sync",
      error: "apply_failed",
      message: "ingest-sync failed: DO returned 500",
    };
    const { getByText, queryByText } = renderModal();
    expect(getByText("objects:sync_error_toast")).toBeTruthy();
    expect(queryByText("ingest-sync failed: DO returned 500")).toBeNull();
  });
});

describe("SyncConfirmModal — a check that failed in transit", () => {
  beforeEach(() => {
    fetcherData.diff = undefined;
    fetcherData.apply = undefined;
  });

  it("reaches the failed step, with its retry, rather than staying on the spinner", () => {
    const { getByText, rerender } = renderModal();
    fireEvent.click(getByText("sync_modal.check_changes"));
    fetcherData.diff = { ok: false, reason: "unreachable", intent: "compute-full-sync-diff" };
    rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(getByText("sync_modal.retry")).toBeTruthy();
    expect(getByText("unknown_error")).toBeTruthy();
  });
});

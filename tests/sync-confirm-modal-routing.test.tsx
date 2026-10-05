// @vitest-environment jsdom
/**
 * Pins SyncConfirmModal's cross-route fetcher targeting. The modal mounts
 * on the Objects page but its three intents (compute-full-sync-diff,
 * apply-full-sync, accept-divergence) are handled by the /dashboard action
 * — the app's shared global endpoint. Every submit must therefore carry
 * `action: "/dashboard"` explicitly: a bare POST would hit the hosting
 * route's own action, which does not handle these intents and would 400.
 * That bare-POST regression is exactly how the sync review flow silently
 * broke when the dashboard page was retired — these tests keep it pinned.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";

// Capture every fetcher.submit; drive fetcher.data per-test to steer the
// modal's state machine (diff data present -> diffReady step).
const submitSpy = vi.fn();
const fetcherData: { current: unknown } = { current: undefined };
const loaderData: { current: unknown } = { current: { activeProjectId: 7 } };
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({
      submit: submitSpy,
      state: "idle",
      data: fetcherData.current,
    }),
    useNavigate: () => vi.fn(),
    // The project the page is showing, which the session can switch under it.
    useRouteLoaderData: () => loaderData.current,
  };
});

// Key-passthrough i18n so assertions key off translation keys, not copy.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";

/** The head_sha the check compared against, and the one a later check did. */
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const NEW_BASE = "3333333333333333333333333333333333333333";

// Minimal diff with changes so diffReady renders the apply / keep buttons.
const diffWithChanges: FullSyncDiff = {
  objects: {
    newObjects: [{ object_id: "o1" } as never],
    changedObjects: [],
    missingObjects: [],
    unregisteredFiles: [],
  } as never,
  stories: {
    newStories: [],
    changedStories: [{ story_id: "s1", changedFields: ["title"], conflictFields: [] } as never],
    missingStories: [],
  } as never,
  config: { changedFields: [{ key: "title" } as never], versionChange: null } as never,
  glossary: { added: [], changed: [], removed: [] } as never,
  hasConflicts: false,
  classification: "two-way",
  suppressedEditorOnly: 0,
  unreadableFiles: [],
  projectId: 7,
  baseSha: BASE,
  headSha: "0123456789abcdef0123456789abcdef01234567",
};

function renderModal() {
  return render(
    <SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />,
  );
}

describe("SyncConfirmModal fetcher routing", () => {
  beforeEach(() => {
    submitSpy.mockClear();
    fetcherData.current = undefined;
  });

  it("compute-full-sync-diff posts explicitly to /dashboard", () => {
    const { getByText } = renderModal();
    fireEvent.click(getByText("sync_modal.check_changes"));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [body, opts] = submitSpy.mock.calls[0];
    expect(body).toEqual({ intent: "compute-full-sync-diff" });
    expect(opts).toMatchObject({ method: "post", action: "/dashboard" });
  });

  it("apply-full-sync posts explicitly to /dashboard", () => {
    const { getByText, rerender } = renderModal();
    // Drive through the computing step so the diff-result effect fires (it only
    // acts while step === "computing"). The response is delivered only after
    // the click, via a forced rerender — matching how fetcher.data actually
    // updates once a real response lands.
    fireEvent.click(getByText("sync_modal.check_changes"));
    fetcherData.current = {
      ok: true,
      intent: "compute-full-sync-diff",
      diff: diffWithChanges,
    };
    rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    fireEvent.click(getByText("sync_modal.apply_sync"));
    const applyCall = submitSpy.mock.calls.find(
      ([body]) => (body as { intent?: string }).intent === "apply-full-sync",
    );
    expect(applyCall).toBeDefined();
    expect(applyCall![1]).toMatchObject({ method: "post", action: "/dashboard" });
  });

  it("accept-divergence posts explicitly to /dashboard", () => {
    const { getByText, rerender } = renderModal();
    // Same two-step delivery as above.
    fireEvent.click(getByText("sync_modal.check_changes"));
    fetcherData.current = {
      ok: true,
      intent: "compute-full-sync-diff",
      diff: diffWithChanges,
    };
    rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    fireEvent.click(getByText("sync_modal.use_compositor_version"));
    const acceptCall = submitSpy.mock.calls.find(
      ([body]) => (body as { intent?: string }).intent === "accept-divergence",
    );
    expect(acceptCall).toBeDefined();
    expect(acceptCall![1]).toMatchObject({ method: "post", action: "/dashboard" });
  });
});

describe("SyncConfirmModal Keep my version", () => {
  beforeEach(() => {
    submitSpy.mockClear();
    fetcherData.current = undefined;
    loaderData.current = { activeProjectId: 7 };
  });

  /** The dialog at diffReady for `diff`, as the check delivered it. */
  function atDiffReady(diff: FullSyncDiff) {
    const view = renderModal();
    fireEvent.click(view.getByText("sync_modal.check_changes"));
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    return view;
  }

  it("posts the commit the check showed", () => {
    const view = atDiffReady(diffWithChanges);
    fireEvent.click(view.getByText("sync_modal.use_compositor_version"));
    const acceptCall = submitSpy.mock.calls.find(
      ([body]) => (body as { intent?: string }).intent === "accept-divergence",
    );
    expect(acceptCall![0]).toEqual({ intent: "accept-divergence", projectId: "7", baseSha: BASE, headSha: diffWithChanges.headSha });
  });

  it("on a stale answer, checks again and says why above the new result", () => {
    const view = atDiffReady(diffWithChanges);
    fireEvent.click(view.getByText("sync_modal.use_compositor_version"));
    submitSpy.mockClear();
    fetcherData.current = { ok: false, intent: "accept-divergence", error: "accept_divergence_stale" };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(submitSpy).toHaveBeenCalledWith({ intent: "compute-full-sync-diff" }, expect.anything());

    const FRESH = "89abcdef0123456789abcdef0123456789abcdef";
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: { ...diffWithChanges, baseSha: NEW_BASE, headSha: FRESH } };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(screen.getByText("sync_modal.accept_divergence_stale")).toBeTruthy();

    // Keeping again sends the commit the new check read.
    submitSpy.mockClear();
    fireEvent.click(view.getByText("sync_modal.use_compositor_version"));
    const acceptCall = submitSpy.mock.calls.find(
      ([body]) => (body as { intent?: string }).intent === "accept-divergence",
    );
    expect(acceptCall![0]).toEqual({ intent: "accept-divergence", projectId: "7", baseSha: NEW_BASE, headSha: FRESH });
  });

  it("on a two-way check with unpublished changes, says why on the conflict step the re-check lands on", () => {
    const modal = () => <SyncConfirmModal open unpublishedCount={3} onClose={() => {}} />;
    const view = render(modal());
    fireEvent.click(view.getByText("sync_modal.check_changes"));
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: diffWithChanges };
    view.rerender(modal());
    // The first check lands on the conflict step; the author goes on to the list.
    expect(view.getByText("sync_modal.sync_anyway")).toBeTruthy();
    fireEvent.click(view.getByText("sync_modal.sync_anyway"));
    fireEvent.click(view.getByText("sync_modal.use_compositor_version"));
    fetcherData.current = { ok: false, intent: "accept-divergence", error: "accept_divergence_stale" };
    view.rerender(modal());
    const FRESH = "89abcdef0123456789abcdef0123456789abcdef";
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: { ...diffWithChanges, headSha: FRESH } };
    view.rerender(modal());
    // The re-check lands on the conflict step again, and says why it is there.
    expect(view.getByText("sync_modal.sync_anyway")).toBeTruthy();
    expect(screen.getByText("sync_modal.accept_divergence_stale")).toBeTruthy();
    // And still above the list once the author goes on.
    fireEvent.click(view.getByText("sync_modal.sync_anyway"));
    expect(screen.getByText("sync_modal.accept_divergence_stale")).toBeTruthy();
  });

  it("posts the diff's own project when the session switches while the check runs", () => {
    // The check starts for project 7; the session switches to 9 in another
    // tab, and the page's data follows before the diff for 7 arrives.
    const view = renderModal();
    fireEvent.click(view.getByText("sync_modal.check_changes"));
    loaderData.current = { activeProjectId: 9 };
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: diffWithChanges };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    fireEvent.click(view.getByText("sync_modal.use_compositor_version"));
    const acceptCall = submitSpy.mock.calls.find(
      ([body]) => (body as { intent?: string }).intent === "accept-divergence",
    );
    expect(acceptCall![0]).toMatchObject({ projectId: "7", baseSha: BASE });
  });

  it("on a sync refused for a moved base, checks again and says why above the new result", () => {
    const view = atDiffReady(diffWithChanges);
    fireEvent.click(view.getByText("sync_modal.apply_sync"));
    submitSpy.mockClear();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "sync_base_stale" };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(submitSpy).toHaveBeenCalledWith({ intent: "compute-full-sync-diff" }, expect.anything());
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: { ...diffWithChanges, baseSha: NEW_BASE } };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(screen.getByText("sync_modal.accept_divergence_stale")).toBeTruthy();
  });

  it("shows no stale notice on a first check", () => {
    atDiffReady(diffWithChanges);
    expect(screen.queryByText("sync_modal.accept_divergence_stale")).toBeNull();
  });
});

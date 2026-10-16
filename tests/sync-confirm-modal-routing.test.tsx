// @vitest-environment jsdom
/**
 * Tests for `SyncConfirmModal`'s fetcher routing and its outcomes. The modal
 * is mounted by the app layout on every page, but its two intents
 * (compute-full-sync-diff, apply-full-sync) are handled by the /dashboard
 * action, the app's shared endpoint. Every submit therefore carries
 * `action: "/dashboard"` explicitly: a bare POST would reach the hosting
 * route's own action, which does not handle these intents and answers 400.
 *
 * The file also pins what follows an apply. A sync refused because the base
 * moved is checked again, with the reason shown above the new result, and a
 * first check shows no such notice. An apply that lands shows the success
 * line, calls `onApplied` so the route data is read again, and closes the
 * modal after a moment without reloading the page. A change to only
 * GitHub's Telar version still offers Apply.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// Minimal diff with changes so diffReady renders the apply button.
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
    <SyncConfirmModal open onClose={() => {}} />,
  );
}

describe("SyncConfirmModal fetcher routing", () => {
  beforeEach(() => {
    submitSpy.mockClear();
    fetcherData.current = undefined;
  });

  it("compute-full-sync-diff posts explicitly to /dashboard", () => {
    const { getByText } = renderModal();
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
    fetcherData.current = {
      ok: true,
      intent: "compute-full-sync-diff",
      diff: diffWithChanges,
    };
    rerender(<SyncConfirmModal open onClose={() => {}} />);
    // A two-way check has no defaults: every change takes GitHub's version first.
    fireEvent.click(getByText("sync_modal.review.set_all_gh"));
    fireEvent.click(getByText("sync_modal.review.apply"));
    const applyCall = submitSpy.mock.calls.find(
      ([body]) => (body as { intent?: string }).intent === "apply-full-sync",
    );
    expect(applyCall).toBeDefined();
    expect(applyCall![1]).toMatchObject({ method: "post", action: "/dashboard" });
  });
});

describe("SyncConfirmModal after a refused apply", () => {
  beforeEach(() => {
    submitSpy.mockClear();
    fetcherData.current = undefined;
    loaderData.current = { activeProjectId: 7 };
  });

  /** The dialog at diffReady for `diff`, as the check delivered it. */
  function atDiffReady(diff: FullSyncDiff) {
    const view = renderModal();
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    return view;
  }

  it("on a sync refused for a moved base, checks again and says why above the new result", () => {
    const view = atDiffReady(diffWithChanges);
    fireEvent.click(view.getByText("sync_modal.review.set_all_gh"));
    fireEvent.click(view.getByText("sync_modal.review.apply"));
    submitSpy.mockClear();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "sync_base_stale" };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(submitSpy).toHaveBeenCalledWith({ intent: "compute-full-sync-diff" }, expect.anything());
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: { ...diffWithChanges, baseSha: NEW_BASE } };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(screen.getByText("sync_modal.accept_divergence_stale")).toBeTruthy();
  });

  it("shows no stale notice on a first check", () => {
    atDiffReady(diffWithChanges);
    expect(screen.queryByText("sync_modal.accept_divergence_stale")).toBeNull();
  });
});

describe("SyncConfirmModal once an apply lands", () => {
  beforeEach(() => {
    submitSpy.mockClear();
    fetcherData.current = undefined;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the route data again and closes, never reloading the page", () => {
    const reload = vi.fn();
    const location = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...location, reload } });
    try {
      const onApplied = vi.fn();
      const onClose = vi.fn();
      const modal = () => <SyncConfirmModal open onClose={onClose} onApplied={onApplied} />;
      const view = render(modal());
      fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: diffWithChanges };
      view.rerender(modal());
      fireEvent.click(view.getByText("sync_modal.review.set_all_gh"));
      fireEvent.click(view.getByText("sync_modal.review.apply"));
      fetcherData.current = { ok: true, intent: "apply-full-sync", newHeadSha: diffWithChanges.headSha };
      view.rerender(modal());
      expect(view.getByText("sync_modal.success")).toBeTruthy();
      expect(onApplied).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1500);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: location });
    }
  });
});

describe("SyncConfirmModal offers no whole-site Keep", () => {
  beforeEach(() => {
    submitSpy.mockClear();
    fetcherData.current = undefined;
  });

  it("has no Keep my version button beside Apply", () => {
    const view = renderModal();
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: diffWithChanges };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(view.getByText("sync_modal.review.apply")).toBeTruthy();
    expect(view.queryByText("sync_modal.use_compositor_version")).toBeNull();
  });
});

describe("SyncConfirmModal with only GitHub's Telar version changed", () => {
  beforeEach(() => {
    submitSpy.mockClear();
    fetcherData.current = undefined;
  });

  it("offers Apply under the version notice, not Nothing to sync", () => {
    const versionOnly = {
      ...diffWithChanges,
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null },
      stories: { newStories: [], changedStories: [], missingStories: [] },
      config: { changedFields: [], versionChange: { direction: "ahead", repoVersion: "1.2.0", d1Version: "1.1.0" } },
    } as FullSyncDiff;
    const view = renderModal();
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: versionOnly };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(view.getByText("sync_modal.review.notice_version")).toBeTruthy();
    expect(view.queryByText("sync_modal.no_changes")).toBeNull();
    fireEvent.click(view.getByText("sync_modal.review.apply"));
    expect(submitSpy.mock.calls.some(([body]) => (body as { intent?: string }).intent === "apply-full-sync")).toBe(true);
  });
});

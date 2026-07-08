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
 * @version v1.4.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";

// Capture every fetcher.submit; drive fetcher.data per-test to steer the
// modal's state machine (diff data present -> diffReady step).
const submitSpy = vi.fn();
const fetcherData: { current: unknown } = { current: undefined };
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
  };
});

// Key-passthrough i18n so assertions key off translation keys, not copy.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";

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
    changedStories: [{ story_id: "s1" } as never],
    missingStories: [],
  } as never,
  config: { changedFields: [{ key: "title" } as never], versionChange: null } as never,
  glossary: { added: [], changed: [], removed: [] } as never,
  hasConflicts: false,
  classification: "two-way",
  suppressedEditorOnly: 0,
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
    fetcherData.current = {
      ok: true,
      intent: "compute-full-sync-diff",
      diff: diffWithChanges,
    };
    const { getByText } = renderModal();
    // Drive through the computing step so the diff-result effect fires (it only
    // acts while step === "computing").
    fireEvent.click(getByText("sync_modal.check_changes"));
    fireEvent.click(getByText("sync_modal.apply_sync"));
    const applyCall = submitSpy.mock.calls.find(
      ([body]) => (body as { intent?: string }).intent === "apply-full-sync",
    );
    expect(applyCall).toBeDefined();
    expect(applyCall![1]).toMatchObject({ method: "post", action: "/dashboard" });
  });

  it("accept-divergence posts explicitly to /dashboard", () => {
    fetcherData.current = {
      ok: true,
      intent: "compute-full-sync-diff",
      diff: diffWithChanges,
    };
    const { getByText } = renderModal();
    // Drive through the computing step so the diff-result effect fires (it only
    // acts while step === "computing").
    fireEvent.click(getByText("sync_modal.check_changes"));
    fireEvent.click(getByText("sync_modal.use_compositor_version"));
    const acceptCall = submitSpy.mock.calls.find(
      ([body]) => (body as { intent?: string }).intent === "accept-divergence",
    );
    expect(acceptCall).toBeDefined();
    expect(acceptCall![1]).toMatchObject({ method: "post", action: "/dashboard" });
  });
});

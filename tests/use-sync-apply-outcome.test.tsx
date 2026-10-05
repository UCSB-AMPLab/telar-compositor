// @vitest-environment jsdom
/**
 * use-sync-apply-outcome.test.tsx — pins the objects page's sync-apply
 * handling: it acts on a successful `sync-apply` fetcher response exactly
 * once, by the identity of the `data` object React Router hands back, for the
 * project the apply ran against, and it writes nothing to the document.
 *
 * The apply changes the document on the server, so the hook only
 * closes the dialog and opens the commit window for the objects left to
 * commit. It takes no document and no structural ops, and a response that
 * still names removed objects is not read for them.
 *
 * Covered cases:
 *   - a success is handled once: rerendering with the same data object (and
 *     new callbacks) does not close again or open the commit modal again
 *   - it acts with no document at all
 *   - a second, new success data object is handled
 *   - failure and compute-sync-diff data are ignored
 *   - a response for a project the author has switched away from opens
 *     nothing and stays inert on a later rerender
 *   - accepted GitHub rows the apply could not add are reported once, and
 *     open no commit window when nothing is pending
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSyncApplyOutcome, type SyncApplyOutcomeData } from "~/hooks/use-sync-apply-outcome";
import type { PendingObject } from "~/lib/sync.server";

function pendingObject(object_id: string): PendingObject {
  return {
    object_id,
    title: null,
    featured: false,
    creator: null,
    description: null,
    source_url: null,
    period: null,
    year: null,
    object_type: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    image_available: false,
  };
}

const PROJECT_ID = 1;

describe("useSyncApplyOutcome", () => {
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let onApplied: ReturnType<typeof vi.fn<(pendingObjects: PendingObject[]) => void>>;
  let onNotAdded: ReturnType<typeof vi.fn<(objectIds: string[]) => void>>;

  beforeEach(() => {
    onClose = vi.fn();
    onApplied = vi.fn();
    onNotAdded = vi.fn();
  });

  it("handles a success once: a rerender with the same data and new callbacks does nothing again", () => {
    const data: SyncApplyOutcomeData = { ok: true, intent: "sync-apply", pendingObjects: [pendingObject("obj-2")] };

    const { rerender } = renderHook(
      ({ close }: { close: () => void }) =>
        useSyncApplyOutcome({ data, projectId: PROJECT_ID, onClose: close, onApplied, onNotAdded }),
      { initialProps: { close: onClose } },
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith([pendingObject("obj-2")]);

    // A new callback identity forces the effect to re-run against the same,
    // already-handled data.
    const later = vi.fn();
    rerender({ close: later });

    expect(later).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("acts with no document, and reads nothing a response says was removed", () => {
    const data = {
      ok: true,
      intent: "sync-apply",
      removedObjectIds: ["obj-1"],
      pendingObjects: [],
    } as SyncApplyOutcomeData;

    renderHook(() => useSyncApplyOutcome({ data, projectId: PROJECT_ID, onClose, onApplied, onNotAdded }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("handles a second, new success data object", () => {
    const dataA: SyncApplyOutcomeData = { ok: true, intent: "sync-apply", pendingObjects: [] };
    const dataB: SyncApplyOutcomeData = { ok: true, intent: "sync-apply", pendingObjects: [pendingObject("obj-3")] };

    const { rerender } = renderHook(
      ({ data }: { data: SyncApplyOutcomeData }) =>
        useSyncApplyOutcome({ data, projectId: PROJECT_ID, onClose, onApplied, onNotAdded }),
      { initialProps: { data: dataA } },
    );
    expect(onApplied).not.toHaveBeenCalled();

    rerender({ data: dataB });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onApplied).toHaveBeenCalledWith([pendingObject("obj-3")]);
  });

  it("says when the commit applied was not recorded as read", () => {
    const onReadNotRecorded = vi.fn();
    const data: SyncApplyOutcomeData = { ok: true, intent: "sync-apply", pendingObjects: [], readNotRecorded: true };

    renderHook(() => useSyncApplyOutcome({ data, projectId: PROJECT_ID, onClose, onApplied, onNotAdded, onReadNotRecorded }));

    expect(onReadNotRecorded).toHaveBeenCalledTimes(1);
  });

  it("says which objects were left because they were edited since the check", () => {
    const onChangedSinceReview = vi.fn();
    const data: SyncApplyOutcomeData = { ok: true, intent: "sync-apply", pendingObjects: [], changedSinceReview: ["o1"] };

    renderHook(() => useSyncApplyOutcome({ data, projectId: PROJECT_ID, onClose, onApplied, onNotAdded, onChangedSinceReview }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChangedSinceReview).toHaveBeenCalledWith(["o1"]);
  });

  it.each([
    ["a failure", { ok: false, intent: "sync-apply" }],
    ["a compute-sync-diff response", { ok: true, intent: "compute-sync-diff" }],
  ])("ignores %s", (_label, data) => {
    renderHook(() => useSyncApplyOutcome({ data: data as SyncApplyOutcomeData, projectId: PROJECT_ID, onClose, onApplied, onNotAdded }));

    expect(onClose).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("ignores a response for a project the author has switched away from, and stays inert on rerender", () => {
    const data: SyncApplyOutcomeData = {
      ok: true,
      intent: "sync-apply",
      projectId: 1,
      pendingObjects: [pendingObject("obj-2")],
    };

    const { rerender } = renderHook(
      ({ close }: { close: () => void }) => useSyncApplyOutcome({ data, projectId: 2, onClose: close, onApplied, onNotAdded }),
      { initialProps: { close: onClose } },
    );
    rerender({ close: vi.fn() });

    expect(onClose).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("reports the rows it could not add once, and opens no commit window when nothing is pending", () => {
    const data: SyncApplyOutcomeData = { ok: true, intent: "sync-apply", pendingObjects: [], notAdded: ["obj-4"] };

    const { rerender } = renderHook(
      ({ close }: { close: () => void }) =>
        useSyncApplyOutcome({ data, projectId: PROJECT_ID, onClose: close, onApplied, onNotAdded }),
      { initialProps: { close: onClose } },
    );
    rerender({ close: vi.fn() });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNotAdded).toHaveBeenCalledTimes(1);
    expect(onNotAdded).toHaveBeenCalledWith(["obj-4"]);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("reports nothing when every accepted row was added", () => {
    const data: SyncApplyOutcomeData = { ok: true, intent: "sync-apply", pendingObjects: [pendingObject("loose")], notAdded: [] };

    renderHook(() => useSyncApplyOutcome({ data, projectId: PROJECT_ID, onClose, onApplied, onNotAdded }));

    expect(onNotAdded).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledWith([pendingObject("loose")]);
  });
});

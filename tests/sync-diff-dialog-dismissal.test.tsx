// @vitest-environment jsdom
/**
 * SyncDiffDialog — dismissal is disabled while an apply is in flight.
 *
 * The dialog's Cancel button is already disabled during `isApplying`, but the
 * shared Dialog primitive also dismisses on Escape and an overlay click. Left
 * unguarded, either would close the dialog out from under a submitted apply:
 * the response's removals and commit window would then have nowhere to
 * surface when it arrives. SyncDiffDialog guards its own `onClose` passed to
 * `Dialog` instead of changing the shared primitive.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import type { SyncDiff } from "~/lib/sync.server";
import { SyncDiffDialog } from "~/components/features/objects/SyncDiffDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      typeof fallback === "string" ? fallback : key,
  }),
}));

function emptyDiff(): SyncDiff {
  return { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null };
}

function renderDialog(isApplying: boolean) {
  const onClose = vi.fn<() => void>();
  const { baseElement: container } = render(
    <SyncDiffDialog
      open
      onClose={onClose}
      diffData={emptyDiff()}
      onApply={() => {}}
      isComputing={false}
      isApplying={isApplying}
    />,
  );
  return { onClose, container };
}

/** The Dialog primitive's overlay — the outermost fixed, full-viewport div. */
function overlay(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".fixed.inset-0.z-50");
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe("SyncDiffDialog dismissal while isApplying", () => {
  it("ignores Escape while an apply is in flight", () => {
    const { onClose } = renderDialog(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores an overlay click while an apply is in flight", () => {
    const { onClose, container } = renderDialog(true);
    fireEvent.click(overlay(container));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape once no apply is running", () => {
    const { onClose } = renderDialog(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on an overlay click once no apply is running", () => {
    const { onClose, container } = renderDialog(false);
    fireEvent.click(overlay(container));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

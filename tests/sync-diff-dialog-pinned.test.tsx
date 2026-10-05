// @vitest-environment jsdom
/**
 * The objects-tab sync dialog submits the commit its check was read at, and
 * says why its list changed when an apply was refused.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { SyncDiff } from "~/lib/sync.server";
import {
  SyncDiffDialog,
  type SyncApplyPayload,
} from "~/components/features/objects/SyncDiffDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const CHECKED = "a".repeat(40);

function diff(): SyncDiff {
  return {
    newObjects: [],
    changedObjects: [
      {
        object_id: "o1",
        dbId: 1,
        title: "Title of o1",
        changedFields: ["title"],
        conflictFields: [],
        d1Values: { title: "mine" },
        repoValues: { title: "repo" },
      },
    ],
    missingObjects: [],
    unregisteredFiles: [], reordered: null,
    headSha: CHECKED,
  };
}

function renderDialog(notice?: string | null) {
  const onApply = vi.fn<(payload: SyncApplyPayload) => void>();
  render(
    <SyncDiffDialog
      open
      onClose={() => {}}
      diffData={diff()}
      onApply={onApply}
      isComputing={false}
      isApplying={false}
      notice={notice}
    />,
  );
  return { onApply };
}

afterEach(cleanup);

describe("SyncDiffDialog — the checked commit", () => {
  it("submits the commit the diff it shows was read at", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].headSha).toBe(CHECKED);
  });
});

describe("SyncDiffDialog — the notice", () => {
  it("shows a notice above the list", () => {
    renderDialog("GitHub changed.");
    const notice = screen.getByText("GitHub changed.");
    const listEntry = screen.getByText("Title of o1");
    expect(notice.compareDocumentPosition(listEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows none without one", () => {
    renderDialog(null);
    expect(screen.queryByText("GitHub changed.")).toBeNull();
  });
});

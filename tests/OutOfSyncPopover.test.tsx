// @vitest-environment jsdom
/**
 * Pins the `OutOfSyncPopover` body: the title, the body and one "Review
 * changes" button that opens the review the app layout mounts, for the
 * convenor; for anyone else, the state and the name of the person who
 * chooses, with no button.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && Object.keys(opts).length > 0 ? `${key} ${JSON.stringify(opts)}` : key,
  }),
}));

import { OutOfSyncPopover } from "~/components/features/site-status/popovers/OutOfSyncPopover";
import { SyncReviewContext, type SyncReview } from "~/components/features/dashboard/SyncReviewProvider";

function renderAs(review: Partial<SyncReview>, onReview?: () => void) {
  const value: SyncReview = { openReview: vi.fn(), canReview: true, coordinatorName: "Ana Pérez", ...review };
  const view = render(
    <SyncReviewContext.Provider value={value}>
      <OutOfSyncPopover onReview={onReview} />
    </SyncReviewContext.Provider>,
  );
  return { ...view, value };
}

describe("OutOfSyncPopover for the convenor", () => {
  it("says what happened and opens the review in place, closing the popover", () => {
    const onReview = vi.fn();
    const { getByText, getAllByRole, value } = renderAs({}, onReview);
    expect(getByText("out_of_sync.title")).toBeTruthy();
    expect(getByText("out_of_sync.body")).toBeTruthy();
    const buttons = getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["out_of_sync.review"]);
    fireEvent.click(buttons[0]);
    expect(value.openReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("links nowhere: the review opens on the page the author is on", () => {
    const { container } = renderAs({});
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("OutOfSyncPopover for a collaborator or instructor", () => {
  it("names the person who coordinates the site, with no button", () => {
    const { getByText, queryAllByRole, queryByText } = renderAs({ canReview: false });
    expect(getByText('out_of_sync.collab_body {"name":"Ana Pérez"}')).toBeTruthy();
    expect(queryByText("out_of_sync.body")).toBeNull();
    expect(queryAllByRole("button")).toEqual([]);
  });

  it("names no one when no name is stored", () => {
    const { getByText } = renderAs({ canReview: false, coordinatorName: null });
    expect(getByText("out_of_sync.collab_body_unnamed")).toBeTruthy();
  });
});

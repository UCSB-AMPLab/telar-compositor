// @vitest-environment jsdom
/**
 * The review of the changes on GitHub, mounted once by the app layout: any
 * component opens it through `useSyncReview().openReview`; it is mounted for
 * the convenor alone, who alone can apply it; an apply that lands reads the
 * route data again rather than reloading the page; and the version-change
 * toast reads the check's answer here, on whatever page the review opened.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

const revalidate = vi.fn();
const fetcherData: { current: unknown } = { current: undefined };
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useRevalidator: () => ({ revalidate, state: "idle" }),
    useFetcher: () => ({ submit: vi.fn(), state: "idle", data: fetcherData.current }),
  };
});

const toastData = vi.fn();
vi.mock("~/hooks/use-version-change-toast", () => ({
  useVersionChangeToast: (data: unknown) => toastData(data),
}));

const modal: { props: { open: boolean; onClose: () => void; onApplied?: () => void } | null } = { props: null };
vi.mock("~/components/features/dashboard/SyncConfirmModal", () => ({
  SYNC_DIFF_FETCHER_KEY: "dashboard-sync-diff",
  SyncConfirmModal: (props: { open: boolean; onClose: () => void; onApplied?: () => void }) => {
    modal.props = props;
    return props.open ? <div data-testid="review-dialog" /> : null;
  },
}));

import { SyncReviewProvider, useSyncReview } from "~/components/features/dashboard/SyncReviewProvider";

function Opener() {
  const { openReview, canReview, coordinatorName } = useSyncReview();
  return (
    <button type="button" onClick={openReview} data-can={String(canReview)} data-name={coordinatorName ?? ""}>
      open
    </button>
  );
}

function renderAs(canReview: boolean, coordinatorName: string | null = "Ana Pérez") {
  return render(
    <SyncReviewProvider canReview={canReview} coordinatorName={coordinatorName}>
      <Opener />
    </SyncReviewProvider>,
  );
}

beforeEach(() => {
  revalidate.mockClear();
  toastData.mockClear();
  fetcherData.current = undefined;
  modal.props = null;
});

describe("SyncReviewProvider for the convenor", () => {
  it("opens the one dialog from any component under it, and closes it", () => {
    renderAs(true);
    expect(screen.queryByTestId("review-dialog")).toBeNull();
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("review-dialog")).toBeTruthy();
    act(() => modal.props!.onClose());
    expect(screen.queryByTestId("review-dialog")).toBeNull();
  });

  it("reads the route data again once an apply lands", () => {
    renderAs(true);
    fireEvent.click(screen.getByText("open"));
    act(() => modal.props!.onApplied!());
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("hands the check's answer to the version-change toast", () => {
    const answer = { ok: true, diff: { config: { versionChange: { direction: "ahead", repoVersion: "1.2.0", d1Version: "1.1.0" } } } };
    fetcherData.current = answer;
    renderAs(true);
    expect(toastData).toHaveBeenCalledWith(answer);
  });
});

describe("SyncReviewProvider for anyone else", () => {
  it("mounts no dialog, opens nothing, and says who coordinates", () => {
    renderAs(false);
    const opener = screen.getByText("open");
    expect(opener.getAttribute("data-can")).toBe("false");
    expect(opener.getAttribute("data-name")).toBe("Ana Pérez");
    fireEvent.click(opener);
    expect(modal.props).toBeNull();
    expect(screen.queryByTestId("review-dialog")).toBeNull();
  });
});

describe("reviewerLine", () => {
  const keys = { convenor: "c", named: "n", unnamed: "u" };

  it("gives the convenor's key, with no values, to whoever can review", async () => {
    const { reviewerLine } = await import("~/components/features/dashboard/SyncReviewProvider");
    expect(reviewerLine(keys, true, "Ana")).toEqual(["c", {}]);
  });

  it("gives everyone else the coordinator's line, named when a name is stored", async () => {
    const { reviewerLine } = await import("~/components/features/dashboard/SyncReviewProvider");
    expect(reviewerLine(keys, false, "Ana")).toEqual(["n", { name: "Ana" }]);
    expect(reviewerLine(keys, false, null)).toEqual(["u", {}]);
  });
});

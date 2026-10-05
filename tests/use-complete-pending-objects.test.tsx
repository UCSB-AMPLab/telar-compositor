// @vitest-environment jsdom
/**
 * The Objects page asks the server to finish pending objects operations once
 * per load, for someone who can publish, when there are any, and
 * never while one such request is in flight.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const submit = vi.fn();
let fetcherState: "idle" | "submitting" = "idle";
vi.mock("react-router", () => ({
  useFetcher: () => ({ state: fetcherState, submit }),
}));

import { useCompletePendingObjects } from "~/hooks/use-complete-pending-objects";

beforeEach(() => {
  submit.mockClear();
  fetcherState = "idle";
});

describe("useCompletePendingObjects", () => {
  it("posts once for a publisher with pending records, however often the page re-renders", () => {
    const { rerender } = renderHook(({ count }: { count: number }) => useCompletePendingObjects(count, true), {
      initialProps: { count: 2 },
    });
    rerender({ count: 2 });
    rerender({ count: 1 });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ intent: "complete-pending-objects" }, { method: "post" });
  });

  it("does not post again when the answer revalidates the page and records remain", () => {
    const { rerender } = renderHook(({ count }: { count: number }) => useCompletePendingObjects(count, true), {
      initialProps: { count: 2 },
    });
    fetcherState = "submitting";
    rerender({ count: 2 });
    fetcherState = "idle";
    rerender({ count: 2 });

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("does not post while a request is in flight", () => {
    fetcherState = "submitting";
    renderHook(() => useCompletePendingObjects(2, true));

    expect(submit).not.toHaveBeenCalled();
  });

  it("does not post with nothing pending", () => {
    renderHook(() => useCompletePendingObjects(0, true));
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not post for someone who cannot publish", () => {
    renderHook(() => useCompletePendingObjects(3, false));
    expect(submit).not.toHaveBeenCalled();
  });
});

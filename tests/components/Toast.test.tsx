// @vitest-environment jsdom

/**
 * This file pins the Toast extension contract:
 *
 *   - `critical: true`         → ToastItem renders role="alert" instead
 *                                of the default role="status"
 *                                (assertive a11y announcement for the
 *                                WS-disconnect destructive toast).
 *   - `autoDismissMs: null`    → no auto-dismiss timer is scheduled; the
 *                                toast sticks until the user dismisses
 *                                manually (sticky destructive toast).
 *   - `autoDismissMs: 1000`    → toast disappears after 1s (existing
 *                                positive-number behaviour).
 *   - `autoDismissMs: undefined` → falls back to DEFAULT_AUTO_DISMISS_MS
 *                                  (5000ms) — back-compat for every
 *                                  existing caller.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "~/hooks/use-toast";

function Trigger({
  toast,
}: {
  toast: Parameters<ReturnType<typeof useToast>["showToast"]>[0];
}) {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(toast)}>
      fire
    </button>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Toast — critical + autoDismissMs extension", () => {
  it("back-compat: existing toasts (no critical, no autoDismissMs) render with role='status'", () => {
    render(
      <ToastProvider>
        <Trigger toast={{ message: "hi", type: "info" }} />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("fire").click();
    });
    const item = screen.getByText("hi").closest("[role]");
    expect(item?.getAttribute("role")).toBe("status");
  });

  it("toast with critical: true renders with role='alert' (override of default role='status')", () => {
    render(
      <ToastProvider>
        <Trigger
          toast={{
            message: "critical msg",
            type: "destructive",
            critical: true,
          }}
        />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("fire").click();
    });
    const item = screen.getByText("critical msg").closest("[role]");
    expect(item?.getAttribute("role")).toBe("alert");
  });

  it("toast with autoDismissMs: null does NOT auto-dismiss (advance fake timers by 30s; toast still in DOM)", () => {
    render(
      <ToastProvider>
        <Trigger
          toast={{
            message: "sticky",
            type: "destructive",
            autoDismissMs: null,
          }}
        />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("fire").click();
    });
    expect(screen.queryByText("sticky")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.queryByText("sticky")).toBeTruthy();
  });

  it("toast with autoDismissMs: 1000 dismisses after 1s (advance timers by 1100ms)", () => {
    render(
      <ToastProvider>
        <Trigger
          toast={{
            message: "fast",
            type: "info",
            autoDismissMs: 1000,
          }}
        />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("fire").click();
    });
    expect(screen.queryByText("fast")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByText("fast")).toBeNull();
  });

  it("toast with autoDismissMs: undefined uses DEFAULT_AUTO_DISMISS_MS (5000) — no regression", () => {
    render(
      <ToastProvider>
        <Trigger toast={{ message: "default", type: "info" }} />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("fire").click();
    });
    // Still present at 4500ms
    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.queryByText("default")).toBeTruthy();
    // Gone by 5500ms
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("default")).toBeNull();
  });
});

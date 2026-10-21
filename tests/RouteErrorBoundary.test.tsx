// @vitest-environment jsdom
/**
 * This file pins the route-level `ErrorBoundary` contract: render the
 * crash UI, surface a Reload action that calls `window.location.reload`,
 * surface a Report-this-crash action that opens the post-crash bug-report
 * panel, record the crash exactly once via `recordError`, and pin the
 * post-crash toast that fires after the user submits. A 404 (an address
 * with no route, or a route's 404 response) renders the not-found screen
 * instead, with no report action and nothing recorded.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ErrorBoundary } from "../app/root";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        return Object.entries(opts).reduce(
          (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
          key,
        );
      }
      return key;
    },
    i18n: { language: "en" },
  }),
}));

const recordErrorSpy = vi.fn();
vi.mock("~/lib/error-capture", () => ({
  recordError: (...args: unknown[]) => recordErrorSpy(...args),
  getRecentErrors: () => [
    {
      type: "boundary",
      message: "TypeError: Cannot read properties of undefined",
      stack: "  at handleSubmit (story-editor.tsx:142)",
      timestamp: "2026-05-10T14:32:00.000Z",
      route: "/projects/abc",
    },
  ],
  attachListeners: vi.fn(),
  clearErrors: vi.fn(),
  __resetForTests: vi.fn(),
}));

// Fix B from revision 2026-05-10: do NOT mock `~/hooks/use-toast`. The boundary
// host wraps <BugReportPanel> with a fresh <ToastProvider>; this test asserts
// that a real toast renders in the DOM after a post-crash submit.

beforeEach(() => {
  recordErrorSpy.mockClear();
});

function ThrowingRoute(): React.ReactNode {
  throw new Error("kaboom");
}

describe("Route ErrorBoundary", () => {
  it("renders crash_title + reload/report buttons when a route throws", async () => {
    const Stub = createRoutesStub([
      { path: "/", Component: ThrowingRoute, ErrorBoundary },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/"]} />);
    expect(await screen.findByText("crash_title")).not.toBeNull();
    expect(screen.queryByText("crash_intro")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "crash_reload" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "crash_report" }),
    ).not.toBeNull();
    errSpy.mockRestore();
  });

  it("clicking 'Reload the page' calls window.location.reload", () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    const Stub = createRoutesStub([
      { path: "/", Component: ThrowingRoute, ErrorBoundary },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/"]} />);
    fireEvent.click(screen.getByRole("button", { name: "crash_reload" }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("clicking 'Report this crash' opens the panel with crash_panel_intro", async () => {
    const Stub = createRoutesStub([
      { path: "/", Component: ThrowingRoute, ErrorBoundary },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/"]} />);
    fireEvent.click(screen.getByRole("button", { name: "crash_report" }));
    expect(await screen.findByText("crash_panel_intro")).not.toBeNull();
    expect(screen.queryByText("crash_field_what_label")).not.toBeNull();
    errSpy.mockRestore();
  });

  it("pinned post-crash error has no remove button", async () => {
    const Stub = createRoutesStub([
      { path: "/", Component: ThrowingRoute, ErrorBoundary },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<Stub initialEntries={["/"]} />);
    fireEvent.click(screen.getByRole("button", { name: "crash_report" }));
    // Wait for panel to render
    await screen.findByText("crash_panel_intro");
    // Open the disclosure (jsdom doesn't toggle on summary click).
    const details = container.querySelector("details");
    if (details) details.open = true;

    const recentErrorLabels = screen.getAllByText("attach_item_recent_error");
    expect(recentErrorLabels.length).toBeGreaterThanOrEqual(1);
    // The pinned slot has NO × button. Total recent_error rows minus the
    // remove buttons rendered for them should be ≥ 1 (one pinned, no ×).
    const removeBtns = container.querySelectorAll(
      'button[aria-label="attach_remove_aria"]',
    );
    // There are 6 standard env rows + 1 buffer recent_error + 1 pinned recent_error,
    // = 8 items, but only 7 should have remove buttons (pinned omitted).
    expect(removeBtns.length).toBeLessThan(
      container.querySelectorAll('details > div > div').length,
    );
    errSpy.mockRestore();
  });

  it("calls recordError(error, 'boundary') once", async () => {
    const Stub = createRoutesStub([
      { path: "/", Component: ThrowingRoute, ErrorBoundary },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/"]} />);
    await waitFor(() => {
      expect(recordErrorSpy).toHaveBeenCalledTimes(1);
    });
    const [errArg, typeArg] = recordErrorSpy.mock.calls[0];
    expect(typeArg).toBe("boundary");
    expect(errArg).toBeDefined();
    errSpy.mockRestore();
  });

  it("post-crash submit renders a real toast (post-crash flow)", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as Window | null);
    const Stub = createRoutesStub([
      { path: "/", Component: ThrowingRoute, ErrorBoundary },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/"]} />);
    fireEvent.click(screen.getByRole("button", { name: "crash_report" }));
    const textarea = await screen.findByLabelText("crash_field_what_label");
    fireEvent.change(textarea, {
      target: { value: "the page crashed when I clicked publish" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit_button/ }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("submit_toast")).not.toBeNull();
    openSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("an address with no route renders the not-found screen, records nothing and offers no report", async () => {
    const Stub = createRoutesStub([
      { path: "/", ErrorBoundary, children: [{ path: "config", Component: () => null }] },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/settings"]} />);
    expect(await screen.findByText("not_found.title")).not.toBeNull();
    expect(screen.getByRole("link", { name: "not_found.start" }).getAttribute("href")).toBe("/");
    expect(screen.queryByText("crash_title")).toBeNull();
    expect(screen.queryByRole("button", { name: "crash_report" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordErrorSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a route's 404 response renders the not-found screen and records nothing", async () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        loader: () => {
          throw new Response("Not found", { status: 404 });
        },
        Component: () => null,
        ErrorBoundary,
      },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/"]} />);
    expect(await screen.findByText("not_found.title")).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordErrorSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a route's non-404 response still renders the crash screen and records it", async () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        loader: () => {
          throw new Response("Server error", { status: 500 });
        },
        Component: () => null,
        ErrorBoundary,
      },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/"]} />);
    expect(await screen.findByText("crash_title")).not.toBeNull();
    await waitFor(() => expect(recordErrorSpy).toHaveBeenCalledTimes(1));
    errSpy.mockRestore();
  });
});

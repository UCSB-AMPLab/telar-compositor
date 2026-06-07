// @vitest-environment jsdom
/**
 * Pins the Story Editor route-level ErrorBoundary: a 404 from the loader
 * (story present in Yjs but not yet snapshotted to D1) renders an in-shell
 * recoverable card with a Back-to-stories link and a retry action — NOT the
 * full-app root crash screen, and is NOT reported as a crash (it is an
 * expected transient state). A non-404 error renders a generic in-shell card
 * AND is still reported via recordError(error, "boundary") — the same path the
 * root boundary uses — so genuine 500s/crashes on this route never go silent.
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  createRoutesStub,
  UNSAFE_ErrorResponseImpl as ErrorResponseImpl,
} from "react-router";
import { ErrorBoundary } from "../app/routes/_app.stories.$storyId";

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

// Mirror RouteErrorBoundary.test.tsx: stub the error-capture singleton so we can
// assert the boundary reports non-404 errors through the SAME path root uses.
const recordErrorSpy = vi.fn();
vi.mock("~/lib/error-capture", () => ({
  recordError: (...args: unknown[]) => recordErrorSpy(...args),
}));

beforeEach(() => {
  recordErrorSpy.mockClear();
});

// The real editor loader throws `new Response("Not Found", { status: 404 })`
// on a D1 miss (_app.stories.$storyId.tsx). React Router wraps a Response thrown
// from a LOADER into an ErrorResponse, so useRouteError() yields an object for
// which isRouteErrorResponse() is true with status 404 — the production path.
// We reproduce that wrapped shape directly with UNSAFE_ErrorResponseImpl (the
// exact class isRouteErrorResponse checks for) and throw it from the component,
// so the test stays inside createRoutesStub's loader-free harness (mirroring
// RouteErrorBoundary.test.tsx). Throwing a raw Response from a component is NOT
// auto-wrapped by React Router, so it would not satisfy isRouteErrorResponse —
// hence the explicit ErrorResponse here.
function NotFoundRoute(): React.ReactNode {
  throw new ErrorResponseImpl(404, "Not Found", "Not Found");
}
function CrashRoute(): React.ReactNode {
  throw new Error("kaboom");
}

describe("Story Editor ErrorBoundary", () => {
  it("404 renders the recoverable card (not the root crash) with a Stories link + retry, and is NOT reported", async () => {
    const Stub = createRoutesStub([
      { path: "/stories/:storyId", Component: NotFoundRoute, ErrorBoundary },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/stories/ghost"]} />);

    expect(screen.queryByText("error.not_available_title")).not.toBeNull();
    // Back-to-stories is a real link to /stories
    const back = screen.getByRole("link", { name: "error.back_to_stories" });
    expect(back.getAttribute("href")).toBe("/stories");
    // Retry affordance present
    expect(
      screen.queryByRole("button", { name: "error.retry" }),
    ).not.toBeNull();
    // NOT the full-app root crash
    expect(screen.queryByText("crash_title")).toBeNull();
    // A 404 is an expected transient state — it must NOT be reported as a crash.
    // Wait a tick so any (incorrect) effect-driven report would have fired.
    await waitFor(() => {
      expect(screen.queryByText("error.not_available_title")).not.toBeNull();
    });
    expect(recordErrorSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("non-404 renders the generic in-shell card (not the 404 card, not the root crash) AND reports the error", async () => {
    const Stub = createRoutesStub([
      { path: "/stories/:storyId", Component: CrashRoute, ErrorBoundary },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Stub initialEntries={["/stories/boom"]} />);

    expect(screen.queryByText("error.generic_title")).not.toBeNull();
    expect(screen.queryByText("error.not_available_title")).toBeNull();
    expect(screen.queryByText("crash_title")).toBeNull();
    // Genuine error must still be reported via the same path root uses.
    await waitFor(() => {
      expect(recordErrorSpy).toHaveBeenCalledTimes(1);
    });
    const [errArg, typeArg] = recordErrorSpy.mock.calls[0];
    expect(typeArg).toBe("boundary");
    expect(errArg).toBeDefined();
    errSpy.mockRestore();
  });
});

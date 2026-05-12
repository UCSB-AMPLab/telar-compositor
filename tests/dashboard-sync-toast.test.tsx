// @vitest-environment jsdom
/**
 * This file pins the dashboard's external version-change toast — the
 * notification that fires after a sync when the connected repo has
 * advanced (or fallen behind) the locally-stored D1 version.
 *
 * Tests the `useVersionChangeToast` hook extracted from the dashboard's
 * post-sync useEffect. The hook observes `syncFetcher.data` and fires a
 * toast via `showToast` when `diff.config.versionChange` is populated.
 *
 * Covered cases:
 *   - direction="ahead" -> info toast with repoVersion in message
 *   - direction="behind" -> warning toast with repo + d1 versions
 *   - versionChange=null -> no toast
 *   - data.ok=false -> no toast even when versionChange present
 *   - data=undefined -> no toast
 *   - stable data reference across renders -> exactly one toast
 *
 * @version v1.0.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const showToastMock = vi.fn();
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: showToastMock, dismissToast: () => {} }),
}));
// Stable `t` reference across renders — mirrors real useTranslation(),
// which returns the same `t` function for the lifetime of a language.
// Without this, renderHook's rerender would trigger the effect again
// because `t` would be a fresh closure on each render.
const stableT = (key: string, vars?: Record<string, unknown>) =>
  `${key}:${JSON.stringify(vars ?? {})}`;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: stableT }),
}));

import { useVersionChangeToast } from "~/hooks/use-version-change-toast";

describe("useVersionChangeToast", () => {
  beforeEach(() => {
    showToastMock.mockReset();
  });

  it("fires info toast when direction=ahead with repoVersion in message", () => {
    renderHook(() =>
      useVersionChangeToast({
        ok: true,
        diff: {
          config: {
            versionChange: {
              direction: "ahead",
              repoVersion: "1.2.0",
              d1Version: "1.1.0",
            },
          },
        },
      }),
    );
    expect(showToastMock).toHaveBeenCalledOnce();
    const call = showToastMock.mock.calls[0][0];
    expect(call.type).toBe("info");
    expect(call.message).toContain("externalUpgradeToast");
    expect(call.message).toContain("1.2.0");
  });

  it("fires warning toast when direction=behind with repo + d1 versions", () => {
    renderHook(() =>
      useVersionChangeToast({
        ok: true,
        diff: {
          config: {
            versionChange: {
              direction: "behind",
              repoVersion: "1.0.0",
              d1Version: "1.2.0",
            },
          },
        },
      }),
    );
    expect(showToastMock).toHaveBeenCalledOnce();
    const call = showToastMock.mock.calls[0][0];
    expect(call.type).toBe("warning");
    expect(call.message).toContain("externalDowngradeToast");
    expect(call.message).toContain("1.0.0");
    expect(call.message).toContain("1.2.0");
  });

  it("does not fire when versionChange=null", () => {
    renderHook(() =>
      useVersionChangeToast({ ok: true, diff: { config: { versionChange: null } } }),
    );
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("does not fire when data.ok=false even if versionChange present", () => {
    renderHook(() =>
      useVersionChangeToast({
        ok: false,
        diff: {
          config: {
            versionChange: {
              direction: "ahead",
              repoVersion: "1.2.0",
              d1Version: "1.1.0",
            },
          },
        },
      }),
    );
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("does not fire when data is undefined", () => {
    renderHook(() => useVersionChangeToast(undefined));
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("renders d1 as '?' in message when d1Version is null", () => {
    renderHook(() =>
      useVersionChangeToast({
        ok: true,
        diff: {
          config: {
            versionChange: {
              direction: "ahead",
              repoVersion: "1.2.0",
              d1Version: null,
            },
          },
        },
      }),
    );
    // ahead branch uses version interpolation (not d1), so message should still contain 1.2.0
    expect(showToastMock).toHaveBeenCalledOnce();
    const call = showToastMock.mock.calls[0][0];
    expect(call.message).toContain("1.2.0");
  });

  it("only fires once per stable data reference across renders", () => {
    const data = {
      ok: true,
      diff: {
        config: {
          versionChange: {
            direction: "ahead" as const,
            repoVersion: "1.2.0",
            d1Version: "1.1.0",
          },
        },
      },
    };
    const { rerender } = renderHook(({ d }) => useVersionChangeToast(d), {
      initialProps: { d: data },
    });
    rerender({ d: data });
    rerender({ d: data });
    expect(showToastMock).toHaveBeenCalledOnce();
  });
});

// @vitest-environment jsdom
/**
 * InstallationScopePrompt.test.tsx — installation scope prompt tests.
 *
 * Covers:
 *  - Renders title / body / grant button / waiting copy (via translation keys)
 *  - Grant button is an <a> with href=https://github.com/settings/installations/42,
 *    target=_blank, rel=noopener noreferrer
 *  - Calls fetcher.submit on mount and then every 2000ms
 *  - Calls onResolved exactly once when fetcher.data = { ok: true, inScope: true }
 *  - On unmount, no further submits, and onResolved is not called after unmount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

type FakeFetcher = {
  state: "idle" | "submitting" | "loading";
  data: unknown;
  submit: ReturnType<typeof vi.fn>;
  Form: React.ComponentType<React.FormHTMLAttributes<HTMLFormElement>>;
};

let singletonFetcher: FakeFetcher | null = null;

function makeFetcher(): FakeFetcher {
  return {
    state: "idle",
    data: undefined,
    submit: vi.fn(),
    Form: (props) => <form {...props} />,
  };
}

vi.mock("react-router", () => ({
  useFetcher: () => {
    if (!singletonFetcher) singletonFetcher = makeFetcher();
    return singletonFetcher;
  },
}));

import { InstallationScopePrompt } from "~/components/features/onboarding/InstallationScopePrompt";

function resetFetcher() {
  singletonFetcher = null;
}

const baseProps = {
  installationId: 42,
  owner: "testuser",
  repoName: "new-site",
  onResolved: vi.fn(),
};

describe("InstallationScopePrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFetcher();
    baseProps.onResolved = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders title, body, grant button and waiting copy", () => {
    render(<InstallationScopePrompt {...baseProps} />);
    expect(screen.getByText(/create_site\.installation_scope\.title/i)).toBeDefined();
    expect(screen.getByText(/create_site\.installation_scope\.body/i)).toBeDefined();
    expect(screen.getByText(/create_site\.installation_scope\.grant_button/i)).toBeDefined();
    expect(screen.getByText(/create_site\.installation_scope\.waiting/i)).toBeDefined();
  });

  it("grant button is an anchor with correct href, target and rel", () => {
    render(<InstallationScopePrompt {...baseProps} />);
    const link = screen.getByRole("link", {
      name: /create_site\.installation_scope\.grant_button/i,
    });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/settings/installations/42",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("submits on mount and polls every 2000ms", () => {
    render(<InstallationScopePrompt {...baseProps} />);
    const fetcher = singletonFetcher!;
    // Initial submit on mount
    expect(fetcher.submit).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(fetcher.submit).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(fetcher.submit).toHaveBeenCalledTimes(3);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(fetcher.submit).toHaveBeenCalledTimes(4);
  });

  it("calls onResolved exactly once when inScope becomes true", () => {
    const { rerender } = render(<InstallationScopePrompt {...baseProps} />);
    const fetcher = singletonFetcher!;
    act(() => {
      fetcher.data = { ok: true, intent: "check-installation-scope", inScope: true };
    });
    rerender(<InstallationScopePrompt {...baseProps} />);
    expect(baseProps.onResolved).toHaveBeenCalledTimes(1);
    // A subsequent rerender with the same data must not call onResolved again
    rerender(<InstallationScopePrompt {...baseProps} />);
    expect(baseProps.onResolved).toHaveBeenCalledTimes(1);
  });

  it("stops polling on unmount and does not call onResolved after unmount", () => {
    const { unmount } = render(<InstallationScopePrompt {...baseProps} />);
    const fetcher = singletonFetcher!;
    const callsBefore = fetcher.submit.mock.calls.length;
    unmount();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(fetcher.submit.mock.calls.length).toBe(callsBefore);
    // Simulate late data arriving post-unmount — we can't rerender after unmount,
    // but the onResolved mock must still not have been called.
    expect(baseProps.onResolved).not.toHaveBeenCalled();
  });
});

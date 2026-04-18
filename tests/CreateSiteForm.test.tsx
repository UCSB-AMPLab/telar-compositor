// @vitest-environment jsdom
/**
 * CreateSiteForm.test.tsx — component tests.
 *
 * Covers cases:
 *  1. renders with empty field, submit disabled
 *  2. invalid name → immediate invalid_format, no availability fetch
 *  3. valid name → debounced availability check → checking → available
 *  4. stale response from earlier keystroke ignored
 *  5. submit transitions to progress view
 *  6. name_exists renders inline error (never err.message)
 *  7. permission_denied renders blocking error with target=_blank rel=noopener noreferrer
 *  8. repo_not_ready renders still_setting_up with Reload button
 *  9. Back link calls onBack prop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

// Mock react-i18next: return key as value
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

// Controllable fetcher mock. Rotate through 3 singleton fetchers matching
// CreateSiteForm's 3 useFetcher calls (availability[0], create[1], scope[2]).
// Each render rotates through the same 3 objects.
type FakeFetcher = {
  state: "idle" | "submitting" | "loading";
  data: unknown;
  submit: ReturnType<typeof vi.fn>;
  Form: React.ComponentType<React.FormHTMLAttributes<HTMLFormElement>>;
};

const fetcherRegistry: FakeFetcher[] = [];
let fetcherCallIdx = 0;

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
    const slot = fetcherCallIdx % 3;
    fetcherCallIdx += 1;
    if (!fetcherRegistry[slot]) fetcherRegistry[slot] = makeFetcher();
    return fetcherRegistry[slot];
  },
}));

import { CreateSiteForm } from "~/components/features/onboarding/CreateSiteForm";

function resetFetchers() {
  fetcherRegistry.length = 0;
  fetcherCallIdx = 0;
}

const baseProps = {
  owner: "testuser",
  installationId: 42,
  onSelect: vi.fn(),
  onBack: vi.fn(),
};

describe("CreateSiteForm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFetchers();
    baseProps.onSelect = vi.fn();
    baseProps.onBack = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders with empty field and submit disabled", () => {
    render(<CreateSiteForm {...baseProps} />);
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    expect(input.value).toBe("");
    const submit = screen.getByRole("button", { name: /create_site\.form\.submit/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("invalid name shows invalid_format immediately without network call", () => {
    render(<CreateSiteForm {...baseProps} />);
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: ".bad!!name" } });
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText(/create_site\.errors\.invalid_name/i)).toBeDefined();
    const availability = fetcherRegistry[0];
    expect(availability.submit).not.toHaveBeenCalled();
  });

  it("valid name triggers debounced availability check and enables submit when available", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "valid-name" } });
      vi.advanceTimersByTime(400);
    });
    const availability = fetcherRegistry[0];
    expect(availability.submit).toHaveBeenCalled();
    act(() => {
      availability.data = { ok: true, intent: "check-repo-name", available: true, name: "valid-name" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    const submit = screen.getByRole("button", { name: /create_site\.form\.submit/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("ignores stale availability responses from earlier keystrokes", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "first-name" } });
      vi.advanceTimersByTime(400);
    });
    act(() => {
      fireEvent.change(input, { target: { value: "second-name" } });
      vi.advanceTimersByTime(400);
    });
    const availability = fetcherRegistry[0];
    // Stale response arrives late, for an earlier (no-longer-current) name
    act(() => {
      availability.data = { ok: false, intent: "check-repo-name", error: "name_exists", name: "first-name" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    expect(screen.queryByText(/create_site\.errors\.name_exists/i)).toBeNull();
  });

  it("submit transitions to progress view", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "valid-name" } });
      vi.advanceTimersByTime(400);
    });
    const availability = fetcherRegistry[0];
    act(() => {
      availability.data = { ok: true, intent: "check-repo-name", available: true, name: "valid-name" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    const submit = screen.getByRole("button", { name: /create_site\.form\.submit/i }) as HTMLButtonElement;
    act(() => {
      fireEvent.click(submit);
    });
    expect(screen.getByText(/create_site\.progress\.creating/i)).toBeDefined();
  });

  it("renders inline name_exists error (not raw err.message)", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "taken-name" } });
      vi.advanceTimersByTime(400);
    });
    const availability = fetcherRegistry[0];
    act(() => {
      availability.data = { ok: false, intent: "check-repo-name", error: "name_exists", name: "taken-name" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    expect(screen.getByText(/create_site\.errors\.name_exists/i)).toBeDefined();
  });

  it("permission_denied renders blocking error with target=_blank rel=noopener noreferrer", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "valid-name" } });
      vi.advanceTimersByTime(400);
    });
    const availability = fetcherRegistry[0];
    act(() => {
      availability.data = { ok: true, intent: "check-repo-name", available: true, name: "valid-name" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.submit/i }));
    });
    const createFetcher = fetcherRegistry[1];
    act(() => {
      createFetcher.data = { ok: false, intent: "create-site", error: "permission_denied" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    const link = screen.getByRole("link", { name: /create_site\.errors\.permission_denied/i });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("href")).toContain("/settings/installations/42");
  });

  it("repo_not_ready renders still_setting_up with Reload button", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "valid-name" } });
      vi.advanceTimersByTime(400);
    });
    const availability = fetcherRegistry[0];
    act(() => {
      availability.data = { ok: true, intent: "check-repo-name", available: true, name: "valid-name" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.submit/i }));
    });
    const createFetcher = fetcherRegistry[1];
    act(() => {
      createFetcher.data = { ok: false, intent: "create-site", error: "repo_not_ready" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    expect(screen.getByText(/create_site\.progress\.still_setting_up/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /reload/i })).toBeDefined();
  });

  it("Back link calls onBack prop", () => {
    render(<CreateSiteForm {...baseProps} />);
    const back = screen.getByRole("button", { name: /back/i });
    fireEvent.click(back);
    expect(baseProps.onBack).toHaveBeenCalled();
  });
});

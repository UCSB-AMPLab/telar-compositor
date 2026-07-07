// @vitest-environment jsdom
/**
 * CreateSiteForm.test.tsx — component tests for the create-site form.
 *
 * Covers:
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
    i18n: { language: "en" },
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

  it("sanitizes the repo name on input — spaces and invalid chars can't be typed", () => {
    render(<CreateSiteForm {...baseProps} />);
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "My Cool Site!" } });
    });
    // Lowercased, spaces + '!' stripped; dots/underscores/hyphens are preserved.
    expect(input.value).toBe("mycoolsite");
    act(() => {
      fireEvent.change(input, { target: { value: "my_repo.v2-final name" } });
    });
    expect(input.value).toBe("my_repo.v2-finalname");
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
    expect(screen.getByText(/create_site\.progress\.heading/i)).toBeDefined();
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
    // The reload button must use an i18n key, not a hardcoded "Reload" string.
    expect(
      screen.getByRole("button", { name: /create_site\.errors\.reload/i }),
    ).toBeDefined();
  });

  // Drive the form to a create-site error state for the recovery-copy tests.
  function driveToCreateError(
    rerender: (ui: React.ReactElement) => void,
    error: string,
  ) {
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "valid-name" } });
      vi.advanceTimersByTime(400);
    });
    act(() => {
      fetcherRegistry[0].data = {
        ok: true,
        intent: "check-repo-name",
        available: true,
        name: "valid-name",
      };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.submit/i }));
    });
    act(() => {
      fetcherRegistry[1].data = { ok: false, intent: "create-site", error };
    });
    rerender(<CreateSiteForm {...baseProps} />);
  }

  it("repo_name_taken recovery button uses a 'choose another name' label, not the form heading", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    driveToCreateError(rerender, "repo_name_taken");
    // The recovery button must carry its own retry label, not reuse the section
    // heading `create_site.form.title` ("Create a new Telar site").
    expect(
      screen.getByRole("button", { name: /create_site\.errors\.repo_name_taken_retry/i }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /create_site\.form\.title/i }),
    ).toBeNull();
  });

  it("repo_name_taken recovery returns focus to the name field", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    driveToCreateError(rerender, "repo_name_taken");
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: /create_site\.errors\.repo_name_taken_retry/i }),
      );
    });
    const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });

  it("github_error recovery button uses a generic retry label, not the form heading", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    driveToCreateError(rerender, "github_error");
    expect(
      screen.getByRole("button", { name: /create_site\.errors\.try_again/i }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /create_site\.form\.title/i }),
    ).toBeNull();
  });

  it("Back link calls onBack prop", () => {
    render(<CreateSiteForm {...baseProps} />);
    const back = screen.getByRole("button", { name: /back/i });
    fireEvent.click(back);
    expect(baseProps.onBack).toHaveBeenCalled();
  });

  // --- Screen 1 identity fields --------------------------------------------

  it("prefills the title from the humanized slug", () => {
    render(<CreateSiteForm {...baseProps} />);
    const name = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(name, { target: { value: "my-cool-site" } });
    });
    const title = screen.getByLabelText(/create_site\.form\.title_label/i) as HTMLInputElement;
    expect(title.value).toBe("My Cool Site");
  });

  it("stops tracking the slug once the title is edited by hand", () => {
    render(<CreateSiteForm {...baseProps} />);
    const name = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    const title = screen.getByLabelText(/create_site\.form\.title_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(name, { target: { value: "first-name" } });
    });
    act(() => {
      fireEvent.change(title, { target: { value: "Custom Title" } });
    });
    act(() => {
      fireEvent.change(name, { target: { value: "second-name" } });
    });
    expect(title.value).toBe("Custom Title");
  });

  it("re-tracks the slug after the title is cleared", () => {
    render(<CreateSiteForm {...baseProps} />);
    const name = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    const title = screen.getByLabelText(/create_site\.form\.title_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(name, { target: { value: "first-name" } });
    });
    act(() => {
      fireEvent.change(title, { target: { value: "Custom Title" } });
    });
    // Clear the title → tracking re-enables.
    act(() => {
      fireEvent.change(title, { target: { value: "" } });
    });
    act(() => {
      fireEvent.change(name, { target: { value: "second-name" } });
    });
    expect(title.value).toBe("Second Name");
  });

  it("defaults the language to the UI locale (en)", () => {
    render(<CreateSiteForm {...baseProps} />);
    const en = screen.getByRole("button", { name: /create_site\.form\.language_en/i });
    expect(en.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a degraded note when born-clean did not fully succeed", () => {
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
      createFetcher.data = {
        ok: true,
        intent: "create-site",
        owner: "testuser",
        name: "valid-name",
        bornCleanOk: false,
      };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    // The "Setting up your site" row must not read as a clean success — it
    // surfaces a degraded note instead of a green check.
    expect(screen.getByText(/create_site\.progress\.setting_up_degraded/i)).toBeDefined();
  });

  it("shows a scope-grant message (not the generic degraded note) when born-clean needs repo access", () => {
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
      createFetcher.data = {
        ok: true,
        intent: "create-site",
        owner: "testuser",
        name: "valid-name",
        bornCleanOk: false,
        bornCleanError: "scope",
      };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    // Out-of-scope is an actionable "grant access" state, not a "we'll finish it
    // for you" degrade — show the scope message, never the generic degraded note.
    expect(screen.getByText(/create_site\.progress\.setting_up_scope/i)).toBeDefined();
    expect(screen.queryByText(/create_site\.progress\.setting_up_degraded/i)).toBeNull();
  });

  it("fails open to handoff when the scope check errors", () => {
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
      createFetcher.data = {
        ok: true,
        intent: "create-site",
        owner: "testuser",
        name: "valid-name",
        bornCleanOk: true,
      };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    const scopeFetcher = fetcherRegistry[2];
    act(() => {
      scopeFetcher.data = { ok: false, intent: "check-installation-scope", error: "github_error" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    // A transient scope-check error must not dead-end — proceed to handoff,
    // mirroring WizardShell's fail-open. The downstream repair flow catches
    // any real scope/config problem.
    expect(baseProps.onSelect).toHaveBeenCalled();
  });

  it("submits the collected identity fields", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    const name = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(name, { target: { value: "valid-name" } });
      vi.advanceTimersByTime(400);
    });
    const availability = fetcherRegistry[0];
    act(() => {
      availability.data = { ok: true, intent: "check-repo-name", available: true, name: "valid-name" };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    // Pick the Santa Barbara theme to prove the selection is submitted.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Santa Barbara" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.submit/i }));
    });
    const createFetcher = fetcherRegistry[1];
    expect(createFetcher.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "create-site",
        owner: "testuser",
        name: "valid-name",
        title: "Valid Name",
        language: "en",
        theme: "santa-barbara",
        author: "testuser",
      }),
      expect.anything(),
    );
  });
});

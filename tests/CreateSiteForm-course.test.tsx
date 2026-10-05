// @vitest-environment jsdom
/**
 * CreateSiteForm-course.test.tsx — the two course fields on the create-site
 * form: what is being created, and the class code that joins the new site to
 * a course.
 *
 * A course is a kind choice in this wizard rather than a creation path of its
 * own, so both fields travel on the repo handed to `onSelect`, the same
 * channel `origin` already uses. Neither belongs in the `create-site` intent:
 * that intent provisions the GitHub repo, and a course's settings are a D1
 * write at import, not a commit.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

type FakeFetcher = {
  state: "idle" | "submitting" | "loading";
  data: unknown;
  submit: ReturnType<typeof vi.fn>;
  Form: React.ComponentType<React.FormHTMLAttributes<HTMLFormElement>>;
};

const fetcherRegistry: FakeFetcher[] = [];
let fetcherCallIdx = 0;

function makeFetcher(): FakeFetcher {
  return { state: "idle", data: undefined, submit: vi.fn(), Form: (props) => <form {...props} /> };
}

// Three useFetcher calls per render: availability[0], create[1], scope[2].
vi.mock("react-router", () => ({
  useFetcher: () => {
    const slot = fetcherCallIdx % 3;
    fetcherCallIdx += 1;
    if (!fetcherRegistry[slot]) fetcherRegistry[slot] = makeFetcher();
    return fetcherRegistry[slot];
  },
}));

// The real prompt polls GitHub. Stand in for it with a button that fires the
// same `onResolved`, so the second handoff can be exercised.
vi.mock("~/components/features/onboarding/InstallationScopePrompt", () => ({
  InstallationScopePrompt: ({ onResolved }: { onResolved: () => void }) => (
    <button type="button" data-testid="scope-prompt-resolve" onClick={onResolved} />
  ),
}));

import { CreateSiteForm } from "~/components/features/onboarding/CreateSiteForm";

const baseProps = {
  owner: "student",
  installationId: 42,
  onSelect: vi.fn(),
  onBack: vi.fn(),
  // These tests exercise the course choice, which is only offered to a
  // session that has answered the course password.
  kind: "site" as const,
};

function resetFetchers() {
  fetcherRegistry.length = 0;
  fetcherCallIdx = 0;
}

type Opts = { name?: string; kind?: "site" | "course" };

/** Fill in an available repo name so the form can be submitted. */
function nameIsAvailable(rerender: (ui: React.ReactElement) => void, opts: Opts = {}) {
  const { name = "group-a", kind = "site" } = opts;
  const input = screen.getByLabelText(/create_site\.form\.name_label/i) as HTMLInputElement;
  act(() => {
    fireEvent.change(input, { target: { value: name } });
    vi.advanceTimersByTime(400);
  });
  act(() => {
    fetcherRegistry[0].data = { ok: true, intent: "check-repo-name", available: true, name };
  });
  rerender(<CreateSiteForm {...baseProps} kind={kind} />);
}

/** Drive create + scope through to the handoff that calls `onSelect`. */
function completeCreation(rerender: (ui: React.ReactElement) => void, opts: Opts = {}) {
  const { name = "group-a", kind = "site" } = opts;
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.submit/i }));
  });
  act(() => {
    fetcherRegistry[1].data = {
      ok: true,
      intent: "create-site",
      repoUrl: `https://github.com/student/${name}`,
      defaultBranch: "main",
      owner: "student",
      name,
      bornCleanOk: true,
    };
  });
  rerender(<CreateSiteForm {...baseProps} kind={kind} />);
  act(() => {
    fetcherRegistry[2].data = { ok: true, intent: "check-installation-scope", inScope: true };
  });
  rerender(<CreateSiteForm {...baseProps} kind={kind} />);
}

function handedOffRepo(): Record<string, unknown> {
  expect(baseProps.onSelect).toHaveBeenCalled();
  return vi.mocked(baseProps.onSelect).mock.calls[0][0] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFetchers();
  baseProps.onSelect = vi.fn();
  baseProps.onBack = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CreateSiteForm — what is being created", () => {
  /**
   * The kind arrives as a prop. It is chosen on the screen before this one,
   * where the two entry points are offered — which is what lets a session
   * without course access be shown nothing about courses at all, rather than
   * being shown a choice it cannot make or a locked door telling it the
   * choice exists.
   */
  it("hands off the kind it was given", () => {
    for (const kind of ["site", "course"] as const) {
      const { rerender, unmount } = render(<CreateSiteForm {...baseProps} kind={kind} />);
      nameIsAvailable(rerender, { kind });
      completeCreation(rerender, { kind });
      expect(handedOffRepo()).toMatchObject({ kind });
      unmount();
      resetFetchers();
      baseProps.onSelect = vi.fn();
    }
  });

  it("offers no way to change it — the decision was made upstream", () => {
    render(<CreateSiteForm {...baseProps} kind="course" />);
    expect(screen.queryByRole("button", { name: /create_site\.form\.kind_course$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /create_site\.form\.kind_site$/i })).toBeNull();
  });

  it("keeps the kind out of the create-site intent — the repo is provisioned the same way", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} kind="course" />);
    nameIsAvailable(rerender, { kind: "course" });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.submit/i }));
    });
    const payload = vi.mocked(fetcherRegistry[1].submit).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.intent).toBe("create-site");
    expect(payload.kind).toBeUndefined();
    expect(payload.course_code).toBeUndefined();
  });
});

describe("CreateSiteForm — the copy names what is being created", () => {
  /**
   * The kind selector used to sit on this form and say what was being made.
   * Moving the choice upstream left the heading and the button as the only
   * signal, and both said "site" for a course too — the one screen where
   * someone can still tell they picked the wrong entry point.
   */
  it("says course in the heading and on the button when a course is being created", () => {
    render(<CreateSiteForm {...baseProps} kind="course" />);
    expect(screen.getByRole("heading", { name: "create_site.form.title_course" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "create_site.form.submit_course" })).toBeTruthy();
  });

  it("says site for a site, the two kinds never sharing a string", () => {
    render(<CreateSiteForm {...baseProps} kind="site" />);
    expect(screen.getByRole("heading", { name: "create_site.form.title" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "create_site.form.submit" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "create_site.form.title_course" })).toBeNull();
    expect(screen.queryByRole("button", { name: "create_site.form.submit_course" })).toBeNull();
  });
});

describe("CreateSiteForm — the class code", () => {
  it("offers the code field when a site is being created", () => {
    render(<CreateSiteForm {...baseProps} kind="site" />);
    expect(screen.getByLabelText(/create_site\.form\.course_code_label/i)).toBeDefined();
  });

  it("withdraws the code field when a course is being created — a course cannot join a course", () => {
    render(<CreateSiteForm {...baseProps} kind="course" />);
    expect(screen.queryByLabelText(/create_site\.form\.course_code_label/i)).toBeNull();
  });

  it("hands off no code from a course form, there being no field to type one into", () => {
    // The old form let the kind be switched after a code had been typed, and
    // dropped it on the switch. The switch is gone; the invariant it protected
    // is not, so it is asserted directly.
    const { rerender } = render(<CreateSiteForm {...baseProps} kind="course" />);
    nameIsAvailable(rerender, { kind: "course" });
    completeCreation(rerender, { kind: "course" });
    const repo = handedOffRepo();
    expect(repo.kind).toBe("course");
    expect(repo.courseCode).toBeUndefined();
  });

  it("hands off the entered code", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} kind="site" />);
    act(() => {
      fireEvent.change(screen.getByLabelText(/create_site\.form\.course_code_label/i), {
        target: { value: "ABCDEF2345" },
      });
    });
    nameIsAvailable(rerender);
    completeCreation(rerender);
    expect(handedOffRepo()).toMatchObject({ courseCode: "ABCDEF2345" });
  });

  it("hands off no code when the field was left empty", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} kind="site" />);
    nameIsAvailable(rerender);
    completeCreation(rerender);
    expect(handedOffRepo().courseCode).toBeUndefined();
  });

  it("carries the code through the grant-access handoff too", () => {
    const { rerender } = render(<CreateSiteForm {...baseProps} />);
    act(() => {
      fireEvent.change(screen.getByLabelText(/create_site\.form\.course_code_label/i), {
        target: { value: "ABCDEF2345" },
      });
    });
    nameIsAvailable(rerender);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.submit/i }));
    });
    act(() => {
      fetcherRegistry[1].data = {
        ok: true,
        intent: "create-site",
        repoUrl: "https://github.com/student/group-a",
        defaultBranch: "main",
        owner: "student",
        name: "group-a",
        bornCleanOk: false,
        bornCleanError: "scope",
      };
    });
    rerender(<CreateSiteForm {...baseProps} />);
    act(() => {
      fetcherRegistry[2].data = { ok: true, intent: "check-installation-scope", inScope: false };
    });
    rerender(<CreateSiteForm {...baseProps} />);

    // The scope prompt resolves once the user grants access on GitHub; the
    // handoff it fires is a second, separate one and must carry the same
    // course fields as the first.
    const prompt = screen.getByTestId("scope-prompt-resolve");
    act(() => {
      fireEvent.click(prompt);
    });
    expect(handedOffRepo()).toMatchObject({ kind: "site", courseCode: "ABCDEF2345" });
  });
});

// @vitest-environment jsdom
/**
 * WizardShell-course.test.tsx — that the create form's two project-level
 * answers survive the hop into the import submission, and that the join
 * outcome the action reports back is shown.
 *
 * `kind` and `course_code` reach the server only if the shell forwards
 * them: the create form hands them off on the repo, and this is the only
 * code that turns a repo into an import submission. A silent drop would
 * leave a course being created as a site, with nothing to see.
 *
 * Fetcher slot map, matching WizardShell's five `useFetcher` calls
 * (modulo 5): 0 import, 1 config check, 2 config fix, 3 complete, 4 scope.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
  }),
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

vi.mock("react-router", () => ({
  useFetcher: () => {
    const slot = fetcherCallIdx % 5;
    fetcherCallIdx += 1;
    if (!fetcherRegistry[slot]) fetcherRegistry[slot] = makeFetcher();
    return fetcherRegistry[slot];
  },
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Form: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
  Link: (props: { to: string; children: React.ReactNode }) => <a href={String(props.to)}>{props.children}</a>,
}));

vi.mock("~/components/features/onboarding/InstallationScopePrompt", () => ({
  InstallationScopePrompt: () => <div data-testid="scope-prompt">prompt</div>,
}));

/** The repo the create form hands off for a course. */
const COURSE_REPO = {
  id: 0,
  name: "hist-101",
  full_name: "teacher/hist-101",
  owner: { login: "teacher", avatar_url: "" },
  private: false,
  description: null,
  installationId: 42,
  createdThisRun: true,
  bornClean: true,
  kind: "course" as const,
};

/** The repo the create form hands off for a site joining a course. */
const JOINING_REPO = { ...COURSE_REPO, name: "group-a", full_name: "student/group-a", kind: "site" as const, courseCode: "ABCDEF2345" };

/** A plain connect-an-existing-repo selection: neither field is set. */
const PLAIN_REPO = {
  id: 1,
  name: "repo-a",
  full_name: "tester/repo-a",
  owner: { login: "tester", avatar_url: "" },
  private: false,
  description: null,
  installationId: 42,
};

vi.mock("~/components/features/onboarding/StepConnect", () => ({
  StepConnect: (props: { onSelect: (repo: unknown) => void }) => (
    <div data-testid="step-connect">
      <button type="button" data-testid="select-course" onClick={() => props.onSelect(COURSE_REPO)} />
      <button type="button" data-testid="select-joining" onClick={() => props.onSelect(JOINING_REPO)} />
      <button type="button" data-testid="select-plain" onClick={() => props.onSelect(PLAIN_REPO)} />
    </div>
  ),
}));

vi.mock("~/components/features/onboarding/StepSync", () => ({
  StepSync: (props: { onRetryWithUrl: (url: string) => void }) => (
    <div data-testid="step-sync">
      <button type="button" data-testid="retry-url" onClick={() => props.onRetryWithUrl("https://sheet")} />
    </div>
  ),
}));
vi.mock("~/components/features/onboarding/StepReview", () => ({
  StepReview: () => <div data-testid="step-review">review</div>,
}));
vi.mock("~/components/features/onboarding/StepDone", () => ({
  StepDone: () => <div data-testid="step-done">done</div>,
}));
vi.mock("~/components/features/onboarding/SiteConfigConfirmation", () => ({
  SiteConfigConfirmation: () => <div data-testid="site-config">site-config</div>,
}));
vi.mock("~/components/features/onboarding/ProgressBar", () => ({
  ProgressBar: () => <div data-testid="progress-bar">progress</div>,
}));

import { WizardShell } from "~/components/features/onboarding/WizardShell";

const baseProps = {
  repos: [],
  installations: [],
  connectedProjects: [],
  user: {
    github_id: 1,
    github_login: "tester",
    github_name: "Tester",
    github_email: "t@example.com",
  },
  hasInstallations: true,
  githubAppSlug: "telar-compositor",
  // These tests exercise the course choice itself, so the session has
  // answered the password.
  courseGateOpen: true,
};

/** Select a repo and let the scope pre-check clear, reaching the import. */
function selectAndClearScope(testId: string, rerender: (ui: React.ReactElement) => void) {
  act(() => {
    fireEvent.click(screen.getByTestId(testId));
  });
  act(() => {
    fetcherRegistry[4].data = { ok: true, intent: "check-installation-scope", inScope: true };
  });
  rerender(<WizardShell {...baseProps} />);
}

/** The FormData the import fetcher was last given. */
function importSubmission(): FormData {
  const calls = vi.mocked(fetcherRegistry[0].submit).mock.calls;
  return calls[calls.length - 1][0] as FormData;
}

beforeEach(() => {
  fetcherRegistry.length = 0;
  fetcherCallIdx = 0;
});

describe("WizardShell — forwarding the create form's answers", () => {
  it("forwards the kind on a course", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    selectAndClearScope("select-course", rerender);
    const form = importSubmission();
    expect(form.get("kind")).toBe("course");
    expect(form.get("course_code")).toBeNull();
  });

  it("forwards the class code on a site that is joining one", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    selectAndClearScope("select-joining", rerender);
    const form = importSubmission();
    expect(form.get("kind")).toBe("site");
    expect(form.get("course_code")).toBe("ABCDEF2345");
  });

  it("adds neither field on a plain connect-an-existing-repo import", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    selectAndClearScope("select-plain", rerender);
    const form = importSubmission();
    expect(form.get("kind")).toBeNull();
    expect(form.get("course_code")).toBeNull();
  });

  it("carries both through the Sheets-URL retry, which is the same creation again", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    selectAndClearScope("select-joining", rerender);
    act(() => {
      fireEvent.click(screen.getByTestId("retry-url"));
    });
    const form = importSubmission();
    expect(form.get("intent")).toBe("import_with_url");
    expect(form.get("kind")).toBe("site");
    expect(form.get("course_code")).toBe("ABCDEF2345");
  });
});

describe("WizardShell — showing the join outcome", () => {
  const IMPORTED = {
    valid: true,
    projectId: 42,
    project: { imported: true, storiesFound: 0 },
    objects: { imported: 0, skipped: 0, warnings: [] },
    stories: { imported: 0, warnings: [] },
    glossary: { imported: 0 },
    pages: { imported: 0 },
    themes: { imported: 0, list: [] },
    sheetsEnabled: false,
    sheetsDisabled: false,
    iiifObjectIds: [],
    audioObjectIds: [],
    videoObjectCount: 0,
    configFields: {},
    orphanStoryIds: [],
  };

  it("names the course once the action reports the join", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    selectAndClearScope("select-joining", rerender);
    act(() => {
      fetcherRegistry[0].data = {
        ...IMPORTED,
        courseJoin: {
          state: "ok",
          courseProjectId: 9,
          courseName: "History 101",
          alreadyAttached: false,
        },
      };
    });
    rerender(<WizardShell {...baseProps} />);
    expect(screen.getByText(/course_join\.joined:History 101/)).toBeDefined();
  });

  it("reports a refused code without claiming the site failed", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    selectAndClearScope("select-joining", rerender);
    act(() => {
      fetcherRegistry[0].data = { ...IMPORTED, courseJoin: { state: "revoked" } };
    });
    rerender(<WizardShell {...baseProps} />);
    expect(screen.getByText("team:code_error_revoked")).toBeDefined();
    expect(screen.getByTestId("step-sync")).toBeDefined();
  });

  it("shows nothing when the import reported no join", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    selectAndClearScope("select-plain", rerender);
    act(() => {
      fetcherRegistry[0].data = IMPORTED;
    });
    rerender(<WizardShell {...baseProps} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

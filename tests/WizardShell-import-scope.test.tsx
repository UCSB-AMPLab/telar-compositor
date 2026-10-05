// @vitest-environment jsdom
/**
 * The wizard's answer to an import the server refused because the
 * installation does not reach the repository.
 *
 * The action answers `{ scopeBlocked: true, blockedIntent }` once the author
 * has already left the connect step, and the installation prompt renders only
 * there, so the shell goes back to it with the selected repository blocked. It
 * remembers the submission the server refused — its intent and its fields, a
 * corrected Sheets URL or the branch fix among them — and when the author
 * grants access, the prompt's retry submits that again rather than a plain
 * import.
 *
 * Fetcher slot map, as in `WizardShell.test.tsx` (modulo 5): 0 import,
 * 1 configCheck, 2 configFix, 3 complete, 4 scope pre-check.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

type FakeFetcher = {
  state: "idle" | "submitting" | "loading";
  data: unknown;
  submit: ReturnType<typeof vi.fn>;
};

const fetcherRegistry: FakeFetcher[] = [];
let fetcherCallIdx = 0;

vi.mock("react-router", () => ({
  useFetcher: () => {
    const slot = fetcherCallIdx % 5;
    fetcherCallIdx += 1;
    if (!fetcherRegistry[slot]) fetcherRegistry[slot] = { state: "idle", data: undefined, submit: vi.fn() };
    return fetcherRegistry[slot];
  },
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

interface TestRepo {
  full_name: string;
}

// The connect step shows the blocked repository and exposes the prompt's
// resolution as a button, as the real prompt calls `onScopeResolved` once the
// author has granted access.
vi.mock("~/components/features/onboarding/StepConnect", () => ({
  StepConnect: (props: {
    onSelect: (repo: unknown) => void;
    scopeBlocked?: TestRepo | null;
    onScopeResolved?: (repo: TestRepo) => void;
  }) => (
    <div data-testid="step-connect">
      {props.scopeBlocked ? (
        <>
          <div data-testid="scope-prompt">{props.scopeBlocked.full_name}</div>
          <button type="button" data-testid="grant" onClick={() => props.onScopeResolved?.(props.scopeBlocked!)}>
            grant
          </button>
        </>
      ) : null}
      <button
        type="button"
        data-testid="select-repo"
        onClick={() =>
          props.onSelect({
            id: 1,
            name: "repo-a",
            full_name: "tester/repo-a",
            owner: { login: "tester", avatar_url: "" },
            private: false,
            description: null,
            installationId: 42,
            createdThisRun: true,
            kind: "site",
            courseCode: "ABCDEF2345",
          })
        }
      >
        select
      </button>
    </div>
  ),
}));

vi.mock("~/components/features/onboarding/StepSync", () => ({
  StepSync: (props: { onFixDefaultBranch: () => void; onRetryWithUrl: (url: string) => void }) => (
    <div data-testid="step-sync">
      <button type="button" data-testid="fix-default-branch" onClick={props.onFixDefaultBranch}>
        fix
      </button>
      <button type="button" data-testid="retry-with-url" onClick={() => props.onRetryWithUrl("https://sheets.example/new")}>
        retry
      </button>
    </div>
  ),
}));
vi.mock("~/components/features/onboarding/StepReview", () => ({ StepReview: () => <div data-testid="step-review" /> }));
vi.mock("~/components/features/onboarding/StepDone", () => ({ StepDone: () => <div data-testid="step-done" /> }));
vi.mock("~/components/features/onboarding/SiteConfigConfirmation", () => ({
  SiteConfigConfirmation: () => <div data-testid="site-config" />,
}));
vi.mock("~/components/features/onboarding/ProgressBar", () => ({ ProgressBar: () => <div /> }));
vi.mock("~/components/features/onboarding/CourseJoinNotice", () => ({ CourseJoinNotice: () => <div /> }));

import { WizardShell } from "~/components/features/onboarding/WizardShell";

const props = {
  repos: [],
  installations: [],
  connectedProjects: [],
  user: { github_id: 1, github_login: "tester", github_name: "Tester", github_email: "t@example.com" },
  hasInstallations: true,
  orphanRepoNames: [],
  githubAppSlug: "telar-compositor",
  courseGateOpen: true,
};

function fields(body: FormData): Record<string, string> {
  return Object.fromEntries([...body.entries()].map(([k, v]) => [k, String(v)]));
}

/** Selects the repository and lets the pre-check pass, so the first import is submitted. */
function startImport() {
  const view = render(<WizardShell {...props} />);
  act(() => {
    fireEvent.click(screen.getByTestId("select-repo"));
  });
  act(() => {
    fetcherRegistry[4].data = { ok: true, intent: "check-installation-scope", inScope: true };
  });
  view.rerender(<WizardShell {...props} />);
  expect(fetcherRegistry[0].submit).toHaveBeenCalledTimes(1);
  return view;
}

/** The server's answer to the latest submission on the import fetcher. */
function answer(view: ReturnType<typeof render>, data: unknown) {
  act(() => {
    fetcherRegistry[0].data = data;
  });
  view.rerender(<WizardShell {...props} />);
}

function lastImportSubmission(): Record<string, string> {
  const calls = fetcherRegistry[0].submit.mock.calls;
  return fields(calls[calls.length - 1][0] as FormData);
}

const SHEETS_REFUSED = {
  valid: false,
  sheetsAccessError: true,
  sheetsPublishedUrl: "https://sheets.example/old",
};

const NO_MAIN = { valid: false, validationError: "no_main_branch", defaultBranch: "master", mainBranch: "absent" };

beforeEach(() => {
  fetcherRegistry.length = 0;
  fetcherCallIdx = 0;
});

describe("WizardShell — an import the server refused as out of scope", () => {
  it("goes back to the connect step and shows the installation prompt for the selected repository", () => {
    const view = startImport();
    expect(screen.getByTestId("step-sync")).toBeDefined();

    answer(view, { scopeBlocked: true, blockedIntent: "import" });

    expect(screen.queryByTestId("step-sync")).toBeNull();
    expect(screen.getByTestId("step-connect")).toBeDefined();
    expect(screen.getByTestId("scope-prompt").textContent).toBe("tester/repo-a");
  });

  it("granting access submits the refused import again, with the same fields", () => {
    const view = startImport();
    const first = lastImportSubmission();
    answer(view, { scopeBlocked: true, blockedIntent: "import" });

    act(() => {
      fireEvent.click(screen.getByTestId("grant"));
    });

    expect(fetcherRegistry[0].submit).toHaveBeenCalledTimes(2);
    expect(lastImportSubmission()).toEqual(first);
    expect(first).toMatchObject({ intent: "import", origin: "created", kind: "site", course_code: "ABCDEF2345" });
    expect(screen.getByTestId("step-sync")).toBeDefined();
  });

  it("a blocked import_with_url shows the prompt on the connect step, and granting access resubmits it with its Sheets URL", () => {
    const view = startImport();
    answer(view, SHEETS_REFUSED);
    act(() => {
      fireEvent.click(screen.getByTestId("retry-with-url"));
    });
    const refused = lastImportSubmission();
    expect(refused).toMatchObject({ intent: "import_with_url", sheets_url: "https://sheets.example/new" });

    answer(view, { scopeBlocked: true, blockedIntent: "import_with_url" });
    expect(screen.getByTestId("scope-prompt").textContent).toBe("tester/repo-a");

    act(() => {
      fireEvent.click(screen.getByTestId("grant"));
    });

    expect(fetcherRegistry[0].submit).toHaveBeenCalledTimes(3);
    expect(lastImportSubmission()).toEqual(refused);
  });

  it("a blocked fix_default_branch shows the prompt on the connect step, and granting access resubmits the branch fix", () => {
    const view = startImport();
    answer(view, NO_MAIN);
    act(() => {
      fireEvent.click(screen.getByTestId("fix-default-branch"));
    });
    const refused = lastImportSubmission();
    expect(refused).toMatchObject({ intent: "fix_default_branch", installation_id: "42", repo_full_name: "tester/repo-a" });

    answer(view, { scopeBlocked: true, blockedIntent: "fix_default_branch" });
    expect(screen.getByTestId("scope-prompt").textContent).toBe("tester/repo-a");

    act(() => {
      fireEvent.click(screen.getByTestId("grant"));
    });

    expect(fetcherRegistry[0].submit).toHaveBeenCalledTimes(3);
    expect(lastImportSubmission()).toEqual(refused);
  });

  it("choosing a repository again forgets the refused submission", () => {
    const view = startImport();
    answer(view, NO_MAIN);
    act(() => {
      fireEvent.click(screen.getByTestId("fix-default-branch"));
    });
    answer(view, { scopeBlocked: true, blockedIntent: "fix_default_branch" });

    act(() => {
      fireEvent.click(screen.getByTestId("select-repo"));
    });
    act(() => {
      fetcherRegistry[4].data = { ok: true, intent: "check-installation-scope", inScope: false };
    });
    view.rerender(<WizardShell {...props} />);
    act(() => {
      fireEvent.click(screen.getByTestId("grant"));
    });

    expect(lastImportSubmission()).toMatchObject({ intent: "import" });
  });

  it("the prompt raised by the client's own pre-check still starts a plain import", () => {
    const view = render(<WizardShell {...props} />);
    act(() => {
      fireEvent.click(screen.getByTestId("select-repo"));
    });
    act(() => {
      fetcherRegistry[4].data = { ok: true, intent: "check-installation-scope", inScope: false };
    });
    view.rerender(<WizardShell {...props} />);
    expect(fetcherRegistry[0].submit).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByTestId("grant"));
    });

    expect(fetcherRegistry[0].submit).toHaveBeenCalledTimes(1);
    expect(lastImportSubmission()).toMatchObject({ intent: "import", repo_full_name: "tester/repo-a" });
  });
});

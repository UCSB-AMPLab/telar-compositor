// @vitest-environment jsdom
/**
 * This file pins orchestration tests for the onboarding `WizardShell` —
 * specifically the scope pre-check wiring that decides whether a user
 * needs to re-grant the GitHub App access to a newly-selected repo before
 * the import action can fire.
 *
 * Cases:
 *  A. In-scope happy path → `fetcher.submit` fires with `intent=import`.
 *  B. Out-of-scope path → `setScopeBlocked` flips, the (mocked)
 *     `InstallationScopePrompt` renders inside `StepConnect`, and
 *     `intent=import` does NOT fire.
 *  C. Non-scope error (fail-open) → `console.error` logged once
 *     and `intent=import` fires anyway.
 *  D. Resume flow (`?resume=N`) bypasses `handleSelectRepo` entirely.
 *  E. Stale-prompt guard: a second `handleSelectRepo` clears
 *     `scopeBlocked` BEFORE the second submit fires.
 *
 * Copy note: the connect-existing-repo path uses its own
 * `step_connect.installation_scope.*` key set (the create-site copy
 * speaks of "your new repository", which misreads the connect-existing
 * situation). `InstallationScopePrompt` accepts an optional
 * `i18nKeyPrefix` prop so each entry point can supply its own keys.
 *
 * Fetcher slot map (matches the order of `useFetcher` calls in WizardShell;
 * modulo 5):
 *   slot 0: fetcher (import)
 *   slot 1: configCheckFetcher
 *   slot 2: configFixFetcher
 *   slot 3: completeFetcher
 *   slot 4: scopeFetcher
 *
 * StepConnect is mocked to expose a test-driver button that calls
 * `onSelect(testRepo)` synchronously; this isolates WizardShell orchestration
 * from the (separately tested) StepConnect surface.
 *
 * @version v1.2.0-beta
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

// Rotating singleton fetcher registry — 5 slots matching WizardShell's 5
// useFetcher calls AFTER plan 38-03-02 lands.
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

let searchParamsMock: URLSearchParams = new URLSearchParams();

vi.mock("react-router", () => ({
  useFetcher: () => {
    const slot = fetcherCallIdx % 5;
    fetcherCallIdx += 1;
    if (!fetcherRegistry[slot]) fetcherRegistry[slot] = makeFetcher();
    return fetcherRegistry[slot];
  },
  useSearchParams: () => [searchParamsMock, vi.fn()],
  Form: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
  Link: (props: { to: string; children: React.ReactNode }) => (
    <a href={String(props.to)}>{props.children}</a>
  ),
}));

// Mock InstallationScopePrompt so we can assert render without polling.
vi.mock("~/components/features/onboarding/InstallationScopePrompt", () => ({
  InstallationScopePrompt: () => <div data-testid="scope-prompt">prompt</div>,
}));

// Mock StepConnect — expose a test-driver button that synchronously calls
// `onSelect(testRepo)` so we can drive `handleSelectRepo` from the test.
// Also render the InstallationScopePrompt mock when `scopeBlocked` is set,
// mirroring the real component's render slot.
vi.mock("~/components/features/onboarding/StepConnect", () => ({
  StepConnect: (props: {
    onSelect: (repo: unknown) => void;
    scopeBlocked?: unknown;
    isCheckingScope?: boolean;
  }) => (
    <div data-testid="step-connect">
      {props.scopeBlocked ? <div data-testid="scope-prompt">prompt</div> : null}
      <span data-testid="checking-scope">{String(props.isCheckingScope ?? false)}</span>
      <button
        type="button"
        data-testid="select-repo-a"
        onClick={() =>
          props.onSelect({
            id: 1,
            name: "repo-a",
            full_name: "tester/repo-a",
            owner: { login: "tester", avatar_url: "" },
            private: false,
            description: null,
            installationId: 42,
          })
        }
      >
        select-a
      </button>
      <button
        type="button"
        data-testid="select-repo-b"
        onClick={() =>
          props.onSelect({
            id: 2,
            name: "repo-b",
            full_name: "tester/repo-b",
            owner: { login: "tester", avatar_url: "" },
            private: false,
            description: null,
            installationId: 42,
          })
        }
      >
        select-b
      </button>
    </div>
  ),
}));

// Stub the other step components so we don't need to render real markup.
vi.mock("~/components/features/onboarding/StepSync", () => ({
  StepSync: () => <div data-testid="step-sync">sync</div>,
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

function resetFetchers() {
  fetcherRegistry.length = 0;
  fetcherCallIdx = 0;
}

const baseProps = {
  repos: [],
  installations: [],
  connectedProjects: [],
  user: {
    github_id: 1,
    github_login: "tester",
    github_name: "Tester",
    github_email: "tester@example.com",
    github_plan: "free",
  },
  hasInstallations: true,
  orphanRepoNames: [],
  githubAppSlug: "telar-compositor-dev",
};

describe("WizardShell — scope pre-check orchestration", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetFetchers();
    searchParamsMock = new URLSearchParams();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("Case A — in-scope: scopeFetcher submits the pre-check, then fetcher submits intent=import", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    const selectBtn = screen.getByTestId("select-repo-a");
    act(() => {
      fireEvent.click(selectBtn);
    });
    const importFetcher = fetcherRegistry[0];
    const scopeFetcher = fetcherRegistry[4];
    // After selection, the scope pre-check has fired but import has NOT.
    expect(scopeFetcher).toBeDefined();
    expect(scopeFetcher.submit).toHaveBeenCalledTimes(1);
    const scopeCall = scopeFetcher.submit.mock.calls[0];
    expect((scopeCall[0] as Record<string, string>).intent).toBe(
      "check-installation-scope",
    );
    expect(importFetcher.submit).not.toHaveBeenCalled();
    // Now arrive at the in-scope response and re-render.
    act(() => {
      scopeFetcher.data = {
        ok: true,
        intent: "check-installation-scope",
        inScope: true,
      };
    });
    rerender(<WizardShell {...baseProps} />);
    expect(importFetcher.submit).toHaveBeenCalledTimes(1);
    const importCall = importFetcher.submit.mock.calls[0];
    const importBody = importCall[0] as FormData;
    expect(importBody.get("intent")).toBe("import");
  });

  it("Case B — out-of-scope: InstallationScopePrompt renders, fetcher.submit is NOT called", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    act(() => {
      fireEvent.click(screen.getByTestId("select-repo-a"));
    });
    const importFetcher = fetcherRegistry[0];
    const scopeFetcher = fetcherRegistry[4];
    act(() => {
      scopeFetcher.data = {
        ok: true,
        intent: "check-installation-scope",
        inScope: false,
      };
    });
    rerender(<WizardShell {...baseProps} />);
    expect(screen.getByTestId("scope-prompt")).toBeDefined();
    expect(importFetcher.submit).not.toHaveBeenCalled();
  });

  it("Case C — fail-open on non-scope error: console.error + intent=import fires anyway", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    act(() => {
      fireEvent.click(screen.getByTestId("select-repo-a"));
    });
    const importFetcher = fetcherRegistry[0];
    const scopeFetcher = fetcherRegistry[4];
    act(() => {
      scopeFetcher.data = {
        ok: false,
        intent: "check-installation-scope",
        error: "github_error",
        message: "boom",
      };
    });
    rerender(<WizardShell {...baseProps} />);
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errMsg = consoleErrorSpy.mock.calls
      .map((c) => c.join(" "))
      .join("\n");
    expect(errMsg).toMatch(/check-installation-scope/);
    expect(importFetcher.submit).toHaveBeenCalledTimes(1);
    const importBody = importFetcher.submit.mock.calls[0][0] as FormData;
    expect(importBody.get("intent")).toBe("import");
  });

  it("Case D — resume flow (?resume=N) bypasses scope pre-check", () => {
    searchParamsMock = new URLSearchParams("resume=99");
    const propsWithResume = {
      ...baseProps,
      connectedProjects: [
        { id: 99, github_repo_full_name: "tester/old-repo", onboarding_completed: null },
      ],
    };
    render(<WizardShell {...propsWithResume} />);
    // Resume path fires configCheckFetcher (slot 1), NEVER scopeFetcher (slot 4).
    // After mount, no scope submit; check the slot-1 fetcher was used.
    const scopeFetcher = fetcherRegistry[4];
    if (scopeFetcher) {
      expect(scopeFetcher.submit).not.toHaveBeenCalled();
    }
    // No selection click is made — handleSelectRepo never fires.
    const configCheck = fetcherRegistry[1];
    expect(configCheck.submit).toHaveBeenCalled();
    const resumeCall = configCheck.submit.mock.calls[0];
    expect((resumeCall[0] as Record<string, string>).intent).toBe(
      "check-site-config",
    );
  });

  it("Case E — stale-prompt guard: selecting a second repo clears scopeBlocked before re-submit", () => {
    const { rerender } = render(<WizardShell {...baseProps} />);
    // First selection — out-of-scope, prompt appears.
    act(() => {
      fireEvent.click(screen.getByTestId("select-repo-a"));
    });
    const scopeFetcher = fetcherRegistry[4];
    act(() => {
      scopeFetcher.data = {
        ok: true,
        intent: "check-installation-scope",
        inScope: false,
      };
    });
    rerender(<WizardShell {...baseProps} />);
    expect(screen.getByTestId("scope-prompt")).toBeDefined();
    // Now select a DIFFERENT repo — handleSelectRepo must clear scopeBlocked
    // BEFORE issuing the new submit. Until the new scopeFetcher.data arrives,
    // the prompt is gone.
    act(() => {
      fireEvent.click(screen.getByTestId("select-repo-b"));
    });
    rerender(<WizardShell {...baseProps} />);
    expect(screen.queryByTestId("scope-prompt")).toBeNull();
    // Second submit fires (a fresh check-installation-scope call).
    expect(scopeFetcher.submit).toHaveBeenCalledTimes(2);
  });
});

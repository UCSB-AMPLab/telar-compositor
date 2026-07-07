// @vitest-environment jsdom
/**
 * This file pins the `StepConnect` private-repo warning truth-table.
 *
 * Four cases:
 *  A. private repo + githubPlan="free"  → warning visible, Continue disabled
 *  B. private repo + githubPlan=null     → warning visible, Continue disabled (defensive)
 *  C. private repo + githubPlan="pro"   → warning hidden, Continue enabled
 *  D. public repo  + githubPlan=null     → warning hidden, Continue enabled
 *
 * Mirrors tests/CreateSiteForm.test.tsx fetcher-registry pattern; StepConnect
 * calls useFetcher exactly once (unlinkFetcher), so the modulo is 1.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import React from "react";

// Mock react-i18next: return the key as-is so assertions can match the key string.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    // CreateSiteForm (rendered when the create view opens) reads i18n.language.
    i18n: { language: "en" },
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
  return {
    state: "idle",
    data: undefined,
    submit: vi.fn(),
    Form: (props) => <form {...props} />,
  };
}

vi.mock("react-router", () => ({
  useFetcher: () => {
    const slot = fetcherCallIdx % 1; // StepConnect: one useFetcher (unlinkFetcher)
    fetcherCallIdx += 1;
    if (!fetcherRegistry[slot]) fetcherRegistry[slot] = makeFetcher();
    return fetcherRegistry[slot];
  },
  Form: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={String(to)}>{children}</a>
  ),
  // AccountModal (rendered when the account modal opens) uses useRevalidator.
  useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
}));

import { StepConnect } from "~/components/features/onboarding/StepConnect";
import type { RepoWithInstallation } from "~/routes/onboarding";

function resetFetchers() {
  fetcherRegistry.length = 0;
  fetcherCallIdx = 0;
}

// A private repo selected by default in baseProps. Case D overrides .private = false.
const privateRepo: RepoWithInstallation = {
  id: 1,
  name: "private-repo",
  full_name: "octocat/private-repo",
  private: true,
  description: null,
  owner: { login: "octocat" },
  installationId: 42,
} as unknown as RepoWithInstallation;

// baseProps covers the minimal surface StepConnect needs to render its list +
// Continue + (when triggered) private-repo warning. `selected` is set via
// useState inside the component, so we render the list with a single repo and
// rely on the test driving selection through the button click. To keep the
// test focused on the warning logic, we put the same repo in `repos` so the
// component renders one selectable row; clicking selects it.
function makeBaseProps(overrides: Partial<{
  repos: RepoWithInstallation[];
  githubPlan: string | null | undefined;
  installations: Array<{ id: number; target_type: "User" | "Organization"; account: { login: string; avatar_url: string } }>;
}> = {}) {
  return {
    repos: overrides.repos ?? [privateRepo],
    installations: overrides.installations ?? [
      {
        id: 42,
        target_type: "User" as const,
        account: { login: "octocat", avatar_url: "https://example.test/octocat.png" },
      },
    ],
    userLogin: "octocat",
    connectedProjects: [],
    orphanRepoNames: [],
    onSelect: vi.fn(),
    githubPlan: overrides.githubPlan,
    hasInstallations: true,
    githubAppSlug: "telar-compositor",
  } as Parameters<typeof StepConnect>[0];
}

// Helper: render, then click the only repo row to set `selected`, then return
// the Continue button. This isolates the warning/disabled checks to the
// post-selection state, which is the surface this test set cares about.
function renderAndSelect(props: Parameters<typeof StepConnect>[0]) {
  const utils = render(<StepConnect {...props} />);
  // The repo row is a <button> whose accessible name includes the repo's
  // full_name. Click it to set the internal `selected` state. fireEvent
  // inside act() ensures React flushes the state update before assertions.
  const repoRow = screen.getByRole("button", { name: /octocat\// });
  act(() => {
    fireEvent.click(repoRow);
  });
  return utils;
}

describe("StepConnect — private-repo warning", () => {
  beforeEach(() => {
    resetFetchers();
  });

  it("renders warning and disables Continue when private repo + free plan", () => {
    renderAndSelect(makeBaseProps({ githubPlan: "free" }));
    expect(screen.getByText(/step_connect\.private_repo_warning_title/)).toBeDefined();
    const continueBtn = screen.getByRole("button", {
      name: /step_connect\.continue/i,
    }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);
  });

  it("renders warning and disables Continue when private repo + null plan (defensive)", () => {
    renderAndSelect(makeBaseProps({ githubPlan: null }));
    expect(screen.getByText(/step_connect\.private_repo_warning_title/)).toBeDefined();
    const continueBtn = screen.getByRole("button", {
      name: /step_connect\.continue/i,
    }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);
  });

  it("hides warning and enables Continue when private repo + paid plan", () => {
    renderAndSelect(makeBaseProps({ githubPlan: "pro" }));
    expect(screen.queryByText(/step_connect\.private_repo_warning_title/)).toBeNull();
    const continueBtn = screen.getByRole("button", {
      name: /step_connect\.continue/i,
    }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(false);
  });

  it("hides warning and enables Continue when public repo, regardless of plan", () => {
    const publicRepo: RepoWithInstallation = {
      ...(privateRepo as unknown as Record<string, unknown>),
      id: 2,
      name: "public-repo",
      full_name: "octocat/public-repo",
      private: false,
    } as unknown as RepoWithInstallation;
    renderAndSelect(makeBaseProps({ repos: [publicRepo], githubPlan: null }));
    expect(screen.queryByText(/step_connect\.private_repo_warning_title/)).toBeNull();
    const continueBtn = screen.getByRole("button", {
      name: /step_connect\.continue/i,
    }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(false);
  });
});

describe("StepConnect — create-in-org install path", () => {
  beforeEach(() => {
    resetFetchers();
  });

  it("always offers the account 'Change' trigger in the create view, even with a single account", () => {
    // A user with the app installed only on their personal account must still be
    // able to open the account modal — it's the in-flow path to install on an org.
    render(<StepConnect {...makeBaseProps({ githubPlan: "pro" })} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.title/i }));
    });
    expect(screen.getByText(/create_site\.account_picker\.change/)).toBeDefined();
  });

  it("opening the account modal surfaces the install-on-another-org CTA", () => {
    render(<StepConnect {...makeBaseProps({ githubPlan: "pro" })} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.title/i }));
    });
    act(() => {
      fireEvent.click(screen.getByText(/create_site\.account_picker\.change/));
    });
    const cta = screen.getByText(/create_site\.account_modal\.install_elsewhere_cta/);
    const link = cta.closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/apps/telar-compositor/installations/new");
  });

  it("selecting an org row re-targets the create flow to that organization", () => {
    const props = makeBaseProps({
      githubPlan: "pro",
      installations: [
        { id: 42, target_type: "User", account: { login: "octocat", avatar_url: "" } },
        { id: 77, target_type: "Organization", account: { login: "acme-org", avatar_url: "" } },
      ],
    });
    render(<StepConnect {...props} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.title/i }));
    });
    // Defaults to the personal account.
    expect(screen.getByText("octocat")).toBeDefined();
    // Open the modal and pick the org.
    act(() => {
      fireEvent.click(screen.getByText(/create_site\.account_picker\.change/));
    });
    act(() => {
      fireEvent.click(screen.getByText("acme-org"));
    });
    // The account-picker line now targets the org (modal closed, owner switched).
    expect(screen.queryByText(/create_site\.account_modal\.title/)).toBeNull();
    const pickerOwners = screen.getAllByText("acme-org");
    expect(pickerOwners.length).toBeGreaterThan(0);
    // And the personal-account "(your account)" annotation is no longer shown.
    expect(screen.queryByText(/create_site\.account_picker\.your_account/)).toBeNull();

    // installationId (not just owner) re-targeted: reopen the modal and confirm
    // the ACTIVE marker — driven by activeInstallationId === installationId, a
    // different code path than the owner label — is on the org row, not octocat.
    act(() => {
      fireEvent.click(screen.getByText(/create_site\.account_picker\.change/));
    });
    const dialog = within(screen.getByRole("dialog"));
    const orgRow = dialog.getByText("acme-org").closest("button") as HTMLElement;
    const personalRow = dialog.getByText("octocat").closest("button") as HTMLElement;
    expect(orgRow.className).toMatch(/border-terracotta/);
    expect(personalRow.className).not.toMatch(/border-terracotta/);
  });
});

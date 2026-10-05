// @vitest-environment jsdom
/**
 * This file pins the `StepConnect` private-repo notice truth-table.
 *
 * The notice asks to be acknowledged and then stops asking. It reads a
 * repository's visibility and nothing else: the account's GitHub plan decides
 * whether Pages will serve the site, and the Compositor cannot see it, because
 * `GET /user` returns `plan` only to a token holding the `user` scope and
 * sign-in does not request it. A truth-table with a plan column in it would be
 * pinning a value that is always null.
 *
 * Four cases:
 *  A. private repo, not acknowledged  → notice visible, Continue disabled
 *  B. private repo, acknowledged      → notice hidden, Continue enabled
 *  C. public repo                     → notice hidden, Continue enabled
 *  D. acknowledging one repo does not acknowledge the next one selected
 *
 * Mirrors tests/CreateSiteForm.test.tsx fetcher-registry pattern; StepConnect
 * calls useFetcher exactly once (unlinkFetcher), so the modulo is 1.
 *
 * @version v1.5.0-beta
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
  // The gate's door: StepConnect reads `?course=1` to decide whether to offer
  // the unlock prompt at all.
  useSearchParams: () => [new URLSearchParams(window.location.search), vi.fn()],
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

// A private repo selected by default in baseProps. Case C overrides .private = false.
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
  courseGateOpen?: boolean;
  installations?: Array<{ id: number; target_type: "User" | "Organization"; account: { login: string; avatar_url: string } }>;
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
    hasInstallations: true,
    githubAppSlug: "telar-compositor",
    courseGateOpen: overrides.courseGateOpen ?? true,
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

describe("StepConnect — private-repo notice", () => {
  beforeEach(() => {
    resetFetchers();
  });

  function continueButton() {
    return screen.getByRole("button", {
      name: /step_connect\.continue/i,
    }) as HTMLButtonElement;
  }

  function acknowledge() {
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: /step_connect\.private_repo_warning_ack/i }),
      );
    });
  }

  it("shows the notice and holds Continue until it is acknowledged", () => {
    renderAndSelect(makeBaseProps());
    expect(screen.getByText(/step_connect\.private_repo_warning_title/)).toBeDefined();
    expect(continueButton().disabled).toBe(true);
  });

  it("clears the notice and releases Continue once acknowledged", () => {
    renderAndSelect(makeBaseProps());
    acknowledge();
    expect(screen.queryByText(/step_connect\.private_repo_warning_title/)).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });

  it("never shows the notice for a public repo", () => {
    const publicRepo: RepoWithInstallation = {
      ...(privateRepo as unknown as Record<string, unknown>),
      id: 2,
      name: "public-repo",
      full_name: "octocat/public-repo",
      private: false,
    } as unknown as RepoWithInstallation;
    renderAndSelect(makeBaseProps({ repos: [publicRepo] }));
    expect(screen.queryByText(/step_connect\.private_repo_warning_title/)).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });

  it("does not carry one repository's acknowledgement to another", () => {
    // The acknowledgement is held as a repository's full name rather than as a
    // flag precisely so this cannot happen. Holding it as a boolean passes
    // every case above and fails only here.
    const second: RepoWithInstallation = {
      ...(privateRepo as unknown as Record<string, unknown>),
      id: 3,
      name: "other-private",
      full_name: "octocat/other-private",
      private: true,
    } as unknown as RepoWithInstallation;

    render(<StepConnect {...makeBaseProps({ repos: [privateRepo, second] })} />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /octocat\/private-repo/ }));
    });
    acknowledge();
    expect(continueButton().disabled).toBe(false);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /octocat\/other-private/ }));
    });
    expect(screen.getByText(/step_connect\.private_repo_warning_title/)).toBeDefined();
    expect(continueButton().disabled).toBe(true);
  });
});

describe("StepConnect — create-in-org install path", () => {
  beforeEach(() => {
    resetFetchers();
  });

  it("always offers the account 'Change' trigger in the create view, even with a single account", () => {
    // A user with the app installed only on their personal account must still be
    // able to open the account modal — it's the in-flow path to install on an org.
    render(<StepConnect {...makeBaseProps()} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.kind_site/i }));
    });
    expect(screen.getByText(/create_site\.account_picker\.change/)).toBeDefined();
  });

  it("opening the account modal surfaces the install-on-another-org CTA", () => {
    render(<StepConnect {...makeBaseProps()} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.kind_site/i }));
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
      installations: [
        { id: 42, target_type: "User", account: { login: "octocat", avatar_url: "" } },
        { id: 77, target_type: "Organization", account: { login: "acme-org", avatar_url: "" } },
      ],
    });
    render(<StepConnect {...props} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.kind_site/i }));
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


/**
 * Which kinds a session is offered, and what it learns from the ones it is not.
 *
 * The choice used to live inside the create form, which meant the form had to
 * announce that courses exist — to every session, including the ones that
 * could not have them — in order to offer the choice to the ones that could.
 * A locked session saw an invitation, opened a dialog, and read that courses
 * were in testing for a small group it was not in.
 *
 * Here a session without course access is offered one card and told nothing —
 * and there is no door to find, because access is no longer something a
 * session can answer for. It is granted to a person on `users.course_access`,
 * from the backend, and the screen only reads it.
 */
describe("StepConnect — what a session is offered to create", () => {
  it("offers both kinds, with their descriptions, to a session with course access", () => {
    render(<StepConnect {...makeBaseProps({ courseGateOpen: true })} />);
    expect(screen.getByRole("button", { name: /create_site\.form\.kind_site/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /create_site\.form\.kind_course/i })).toBeTruthy();
    expect(screen.getByText("create_site.form.kind_course_hint")).toBeTruthy();
  });

  it("offers only a site to a session without it, and no hint that courses exist", () => {
    render(<StepConnect {...makeBaseProps({ courseGateOpen: false })} />);
    expect(screen.getByRole("button", { name: /create_site\.form\.kind_site/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create_site\.form\.kind_course/i })).toBeNull();
    expect(screen.queryByText("create_site.form.kind_course_hint")).toBeNull();
    // Not the invitation either — that was the whole complaint.
    expect(screen.queryByText("course:gate_locked_cta")).toBeNull();
  });

  it("opens the create form on the kind whose card was clicked", () => {
    // The card IS the decision now, so it has to carry it. Read off the class
    // code field, which the form withdraws for a course and only for a course:
    // a course cannot join a course.
    const { unmount } = render(<StepConnect {...makeBaseProps({ courseGateOpen: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.kind_course/i }));
    expect(screen.queryByLabelText(/create_site\.form\.course_code_label/i)).toBeNull();
    unmount();

    render(<StepConnect {...makeBaseProps({ courseGateOpen: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /create_site\.form\.kind_site/i }));
    expect(screen.getByLabelText(/create_site\.form\.course_code_label/i)).toBeTruthy();
  });

});

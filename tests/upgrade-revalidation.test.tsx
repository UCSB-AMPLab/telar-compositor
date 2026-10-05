// @vitest-environment jsdom
/**
 * The Upgrade page's loader redirects away as soon as the repository's version
 * is current, and every action the page submits triggers a revalidation. Those
 * two facts meet the moment the upgrade commit lands: the version the loader
 * reads is now the new one, so the next revalidation sends the owner to
 * /objects — taking the build tracking, the failure report and the retry with
 * it, mid-flight.
 *
 * `shouldRevalidate` holds the loader while a flow the page owns is running.
 * This file drives the whole flow through the real loader and the real action
 * on React Router's routes stub — commit, build, failure, rebuild — and asserts
 * the owner stays on the page. The control at the end registers the same route
 * without the hold and shows the redirect firing, so the assertion above is a
 * claim about the hold rather than about the fixtures.
 *
 * @version v1.5.0-beta
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";

// ---------------------------------------------------------------------------
// Mocks — everything the loader and action reach for, and nothing of the router
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) =>
    `${i18nKey} ${JSON.stringify(values ?? {})}`,
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true, useIsPublisher: () => true, useRole: () => "convenor" }));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ provider: null }),
}));

/** Flipped by the commit, so the loader would redirect from then on. */
let repoVersion = "1.6.1";

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => undefined }) }),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: async () => "user-token" }));
vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ telar_version: "1.6.1" }] }) }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
}));
vi.mock("~/lib/membership.server", () => ({
  requirePublishingRole: async () => undefined,
  resolveActiveProject: async () => null,
}));
vi.mock("~/lib/active-project.server", () => {
  const resolved = {
    project: {
      id: 1,
      installation_id: 42,
      github_repo_full_name: "student/my-site",
      github_pages_url: "https://student.github.io/my-site",
    },
    userRole: "convenor",
  };
  return {
    resolveActiveProjectFromRequest: async () => resolved,
    // This harness renders the route directly, not the layout that mounts
    // PageSiteProvider, so the page's fetcher never attaches a siteId. Every
    // write submitted here comes from a form that showed this same project,
    // so admitting every request keeps the scenario these tests exercise.
    resolvePageProject: async () => ({ kind: "ok" as const, ...resolved }),
    siteChangedAnswer: (intent: string, currentSiteName: string) => ({
      ok: false as const,
      intent,
      error: "site_changed",
      currentSiteName,
    }),
  };
});
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: async () => "install-token",
  resolveProjectToken: async () => "install-token",
}));
vi.mock("~/lib/github-status.server", () => ({
  bumpProjectHeadFrom: async () => true,
  // The commit checks its prepared target against the latest release.
  readLatestTag: async () => ({ ok: true, tag: "v1.6.2" }),
}));
vi.mock("~/lib/manifest-runner.server", () => ({
  applyManifestChain: (_chain: unknown, files: Map<string, string>) => ({
    files,
    deletions: [],
    manualSteps: { en: [], es: [] },
  }),
}));
vi.mock("~/lib/v130-ingest.server", async () => ({
  ...(await vi.importActual<typeof import("~/lib/v130-ingest.server")>("~/lib/v130-ingest.server")),
  applyV130Transforms: async (files: Map<string, string>) => ({ files, changes: [] }),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: async () => ({ tree: [], truncated: false }),
  getRepoHead: async () => "head-oid",
  getFileContent: async (_t: string, _o: string, _r: string, path: string) =>
    path === "_config.yml" ? `telar:\n  version: "${repoVersion}"\n` : null,
  // Prepare's reads, at the head it listed.
  getFileAtRef: async (_t: string, _o: string, _r: string, path: string) =>
    path === "_config.yml"
      ? { status: "ok" as const, content: `telar:\n  version: "${repoVersion}"\n` }
      : { status: "absent" as const },
  GitHubTransientError: class GitHubTransientError extends Error {},
}));
vi.mock("~/lib/commit.server", () => ({
  StaleHeadError: class StaleHeadError extends Error {},
  commitFilesToRepo: async () => {
    repoVersion = "1.6.2";
    return { newHeadSha: "upgrade-sha" };
  },
  dispatchWorkflow: async () => ({
    runId: 900,
    runUrl: "",
    htmlUrl: "https://github.com/student/my-site/actions/runs/900",
  }),
  getWorkflowRun: async () => ({
    id: 900,
    name: "Build and deploy Telar site",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/student/my-site/actions/runs/900",
    head_sha: "advanced-sha",
  }),
  listWorkflowRunsBySha: async () => [
    {
      id: 111,
      name: "Build and deploy Telar site",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/student/my-site/actions/runs/111",
      head_sha: "upgrade-sha",
    },
  ],
  getJobSteps: async () => [],
  mapStepsToBuildPhases: () => [],
}));
vi.mock("~/lib/upgrade.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/upgrade.server")>(
    "~/lib/upgrade.server",
  );
  return {
    ...actual,
    fetchLatestRelease: async () => ({
      tagName: "v1.6.2",
      body: "Release notes",
      publishedAt: "2026-09-01T00:00:00Z",
    }),
    fetchAllReleases: async () => [],
    computeUpgradeDiff: async () => ({
      additions: [],
      deletions: [],
      summary: {
        layouts: 0,
        includes: 0,
        stylesheets: 0,
        scripts: 0,
        workflows: 0,
        dataFiles: 0,
        other: 0,
        deletions: 0,
        total: 0,
      },
    }),
    loadManifestChain: async () => [],
    updateTelarVersionInConfig: (content: string) => content,
  };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const context = {
  get: () => ({ id: 7, encrypted_access_token: "enc" }),
  cloudflare: {
    env: {
      ENCRYPTION_KEY: "key",
      SESSION_SECRET: "sess",
      GITHUB_APP_ID: "app",
      GITHUB_PRIVATE_KEY: "priv",
      DB: {},
    },
  },
} as never;

function ObjectsPage() {
  return <div data-testid="objects-page">objects</div>;
}

async function renderStub({ withHold }: { withHold: boolean }) {
  const route = (await import("~/routes/_app.upgrade")) as unknown as {
    default: React.ComponentType;
    loader: unknown;
    action: unknown;
    shouldRevalidate: unknown;
  };
  const Stub = createRoutesStub(
    [
      {
        path: "/upgrade",
        Component: route.default as never,
        loader: route.loader as never,
        action: route.action as never,
        ...(withHold ? { shouldRevalidate: route.shouldRevalidate as never } : {}),
      },
      // An action of its own, because a redirect mid-flow leaves the page's
      // poll to fire once more against whatever route it landed on.
      { path: "/objects", Component: ObjectsPage as never, action: async () => null },
    ],
    context,
  );
  return render(<Stub initialEntries={["/upgrade"]} />);
}

function stillOnUpgrade() {
  expect(screen.queryByTestId("objects-page")).toBeNull();
}

/**
 * Each step here waits on a real router round trip — loader, action, and the
 * revalidation behind them — so the default one-second window is a bet on how
 * busy the machine is rather than on the behaviour under test.
 */
const SETTLE = { timeout: 10000 };

beforeEach(() => {
  vi.clearAllMocks();
  repoVersion = "1.6.1";
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Upgrade page — the flow survives revalidation", () => {
  it("keeps the owner on the page through commit, build, failure and rebuild", async () => {
    await renderStub({ withHold: true });

    const upgrade = await screen.findByRole("button", { name: "upgradeButton" }, SETTLE);
    fireEvent.click(upgrade);

    // The commit lands and the repository's version is now current, so every
    // revalidation from here on would redirect if the loader were allowed to
    // run. The build tracking must still be the thing on screen.
    await waitFor(() => expect(screen.getByText("buildTracking")).toBeTruthy(), SETTLE);
    stillOnUpgrade();

    // The build fails; the failed screen carries the retry.
    await waitFor(() => expect(screen.getByText("upgradeFailed")).toBeTruthy(), SETTLE);
    stillOnUpgrade();

    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    // The rebuild's own action submission revalidates too.
    await waitFor(() => expect(screen.getByText("buildTracking")).toBeTruthy(), SETTLE);
    stillOnUpgrade();
  });

  it("control: without the hold the same commit redirects the owner away", async () => {
    await renderStub({ withHold: false });

    const upgrade = await screen.findByRole("button", { name: "upgradeButton" }, SETTLE);
    fireEvent.click(upgrade);

    await waitFor(() => expect(screen.getByTestId("objects-page")).toBeTruthy(), SETTLE);
  });
});

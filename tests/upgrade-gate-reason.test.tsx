// @vitest-environment jsdom
/**
 * Why a person is on /upgrade, and where they go when there is nothing to do
 * there.
 *
 * The Publish gate, the Upload tab's upgrade link and onboarding each send a
 * person here with `?from=`, and the page said nothing about why: it opened on
 * its generic title, with no sentence connecting where they were going to
 * where they are. It now says what the upgrade stands between them and — only
 * while the upgrade is still to be done, since `needsUpgrade` is loader data
 * and the loader is held for the whole flow, so a sentence keyed on it alone
 * would go on asking for an upgrade beside one that had finished.
 *
 * The same value was also the loader's redirect target when the site turned
 * out to be current, passed to `redirect()` as it arrived. That forwards to
 * any origin the query names. The cases at the end send an absolute and a
 * protocol-relative URL and require the person to land on Objects.
 *
 * Driven through the real loader and the real page on React Router's routes
 * stub, on the harness `upgrade-revalidation.test.tsx` established.
 *
 * @version v1.5.2-beta
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

function Destination({ name }: { name: string }) {
  return <div data-testid={`${name}-page`}>{name}</div>;
}

async function renderAt(entry: string) {
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
        shouldRevalidate: route.shouldRevalidate as never,
      },
      { path: "/objects", Component: (() => <Destination name="objects" />) as never, action: async () => null },
      { path: "/publish", Component: (() => <Destination name="publish" />) as never },
      { path: "/config", Component: (() => <Destination name="config" />) as never },
    ],
    context,
  );
  return render(<Stub initialEntries={[entry]} />);
}

/** Each step waits on a real router round trip. */
const SETTLE = { timeout: 10000 };

beforeEach(() => {
  vi.clearAllMocks();
  repoVersion = "1.6.1";
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("why the person is on /upgrade", () => {
  it("names publishing for someone the Publish gate sent", async () => {
    await renderAt("/upgrade?from=%2Fpublish");
    expect(await screen.findByText("gateReason_publish", {}, SETTLE)).toBeTruthy();
  });

  it("names uploading for someone the Upload tab sent", async () => {
    await renderAt("/upgrade?from=%2Fobjects");
    expect(await screen.findByText("gateReason_upload", {}, SETTLE)).toBeTruthy();
  });

  it("says nothing of the kind to someone who came on their own", async () => {
    await renderAt("/upgrade");
    await screen.findByRole("button", { name: "upgradeButton" }, SETTLE);
    expect(screen.queryByText(/^gateReason_/)).toBeNull();
  });

  it("names the site it acts on, whatever sent the person here", async () => {
    await renderAt("/upgrade?from=%2Fstart");
    expect(await screen.findByText('siteLine {"repo":"student/my-site"}', {}, SETTLE)).toBeTruthy();
  });

  it("names the setup for someone onboarding sent", async () => {
    // Completion redirects here in the same response that makes the new site
    // active, so the page is showing the site just set up.
    await renderAt("/upgrade?from=%2Fstart");
    expect(await screen.findByText("gateReason_import", {}, SETTLE)).toBeTruthy();
  });

  it("does not read a path that merely begins like a gated one", async () => {
    await renderAt("/upgrade?from=%2Fpublishing");
    await screen.findByRole("button", { name: "upgradeButton" }, SETTLE);
    expect(screen.queryByText(/^gateReason_/)).toBeNull();
  });

  it("stops asking for the upgrade once it is under way", async () => {
    await renderAt("/upgrade?from=%2Fpublish");
    await screen.findByText("gateReason_publish", {}, SETTLE);

    fireEvent.click(await screen.findByRole("button", { name: "upgradeButton" }, SETTLE));

    await waitFor(() => expect(screen.getByText("buildTracking")).toBeTruthy(), SETTLE);
    expect(screen.queryByText("gateReason_publish")).toBeNull();
  });
});

describe("a site that turns out to be current", () => {
  it("returns someone to where they were going", async () => {
    repoVersion = "1.6.2";
    await renderAt("/upgrade?from=%2Fpublish");
    expect(await screen.findByTestId("publish-page", {}, SETTLE)).toBeTruthy();
  });

  it("does not forward to an absolute URL named in the query", async () => {
    repoVersion = "1.6.2";
    await renderAt(`/upgrade?from=${encodeURIComponent("https://evil.example/")}`);
    expect(await screen.findByTestId("objects-page", {}, SETTLE)).toBeTruthy();
  });

  it("does not forward to a protocol-relative URL named in the query", async () => {
    repoVersion = "1.6.2";
    await renderAt(`/upgrade?from=${encodeURIComponent("//evil.example/")}`);
    expect(await screen.findByTestId("objects-page", {}, SETTLE)).toBeTruthy();
  });
});

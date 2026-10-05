// @vitest-environment jsdom
/**
 * An upgrade delivers the framework's frontmatter to the built-in pages
 *, end to end.
 *
 * The merge has its own suite; this one is about the wiring. It drives an
 * upgrade through the real loader and action on React Router's routes stub,
 * on the harness `upgrade-revalidation.test.tsx` established, with a site
 * whose glossary page predates `title_key`, and reads back what was
 * committed: the page with the key added and the author's body intact.
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

/** A glossary page from before title_key, with an author's own body. */
const SITE_GLOSSARY =
  "---\nlayout: glossary-index\ntitle: Glossary\npermalink: /glossary/\n---\n\nNuestro glosario.\n";
/** The same page as the release ships it. */
const RELEASE_GLOSSARY =
  "---\nlayout: glossary-index\ntitle: Glossary\ntitle_key: navigation.glossary\npermalink: /glossary/\n---\n\nbody\n";
/** Every call to commitFilesToRepo, as its arguments. */
const committed: unknown[][] = [];

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
      : path === "pages/glossary.md"
        ? { status: "ok" as const, content: SITE_GLOSSARY }
        : { status: "absent" as const },
  GitHubTransientError: class GitHubTransientError extends Error {},
}));
vi.mock("~/lib/commit.server", () => ({
  StaleHeadError: class StaleHeadError extends Error {},
  commitFilesToRepo: async (...args: unknown[]) => {
    committed.push(args);
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
    fetchFrameworkFile: async (_t: string, path: string) =>
      path === "pages/glossary.md"
        ? { kind: "found", content: RELEASE_GLOSSARY }
        : { kind: "absent" },
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

const SETTLE = { timeout: 10000 };

beforeEach(() => {
  vi.clearAllMocks();
  repoVersion = "1.6.1";
  committed.length = 0;
});

/** The files an upgrade commit carried, by path. */
function committedFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const args of committed) {
    for (const arg of args) {
      const list = Array.isArray(arg) ? arg : (arg as { files?: unknown })?.files;
      if (!Array.isArray(list)) continue;
      for (const f of list as Array<{ path?: string; content?: string }>) {
        if (f?.path && typeof f.content === "string") out.set(f.path, f.content);
      }
    }
  }
  return out;
}

describe("an upgrade", () => {
  it("commits the glossary page with title_key added and the author's body kept", async () => {
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
        { path: "/objects", Component: (() => <div>objects</div>) as never, action: async () => null },
      ],
      context,
    );
    render(<Stub initialEntries={["/upgrade"]} />);

    fireEvent.click(await screen.findByRole("button", { name: "upgradeButton" }, SETTLE));
    await waitFor(() => expect(committed.length).toBeGreaterThan(0), SETTLE);

    const glossary = committedFiles().get("pages/glossary.md");
    expect(glossary).toBeDefined();
    expect(glossary).toContain("title_key: navigation.glossary");
    expect(glossary).toContain("Nuestro glosario.");
  });
});

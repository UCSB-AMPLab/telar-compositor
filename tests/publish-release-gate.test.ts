/**
 * The publish action's release gate.
 *
 * The page's gate is the `_app` loader, which reads the version when the page
 * loads; a page opened before a release is published can submit after it. So
 * the publish intent reads the site's standing again, before its lease and
 * outside the block that turns a throw into a failure: behind the latest
 * release it redirects as the loader would, and with a release that cannot
 * be read it refuses with nothing taken or written. The build-workflow repair
 * writes no content and stays open.
 *
 * The gate runs for real; the release read and the site version are the
 * inputs each case sets.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

const { site } = vi.hoisted(() => ({
  site: { telarVersion: "1.0.0" as string | null },
}));

// Answers by the columns each selection asks for, never by call order. Only
// the gate's own read selects `telar_version` alone.
function rowsFor(columns?: Record<string, unknown>): unknown[] {
  if (!columns) return [];
  const keys = Object.keys(columns);
  if (keys.length === 1 && keys[0] === "telar_version") {
    return site.telarVersion === null ? [] : [{ telar_version: site.telarVersion }];
  }
  return [];
}

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: (columns?: Record<string, unknown>) => {
      const rows = rowsFor(columns);
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.limit = () => Promise.resolve(rows);
      return chain;
    },
  })),
}));

vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/membership.server", () => ({ requirePublishingRole: vi.fn(async () => {}) }));

const { project, resolveActiveProjectFromRequest } = vi.hoisted(() => {
  const project = {
    role: "convenor" as "convenor" | "collaborator",
    workflowsWriteMissing: null as number | null,
  };
  return {
    project,
    resolveActiveProjectFromRequest: vi.fn(async () => ({
      project: {
        id: 7,
        github_repo_full_name: "owner/repo",
        head_sha: "recorded-head",
        installation_id: 42,
        publish_snapshot: null,
        gh_workflows_write_missing: project.workflowsWriteMissing,
      },
      userRole: project.role,
    })),
  };
});
// `resolvePageProject` and `siteChangedAnswer` are re-implemented here against
// the same mocked `resolveActiveProjectFromRequest`, matching the real
// module's own logic (app/lib/active-project.server.ts), because this file
// mocks the whole module rather than importing its original.
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest,
  resolvePageProject: vi.fn(async (request: Request, env: unknown, userId: number, formData: FormData) => {
    const resolved = await resolveActiveProjectFromRequest();
    if (!resolved) return { kind: "no_project" };
    if (formData.get("siteId") !== String(resolved.project.id)) {
      return { kind: "site_changed", currentSiteName: resolved.project.github_repo_full_name };
    }
    return { kind: "ok", ...resolved };
  }),
  siteChangedAnswer: vi.fn((intent: string, currentSiteName: string) => ({
    ok: false,
    intent,
    error: "site_changed",
    currentSiteName,
  })),
}));

vi.mock("~/lib/github-status.server", () => ({
  readLatestTag: vi.fn(async () => ({ ok: true, tag: "v1.8.0" })),
  getCachedLatestTag: vi.fn(async () => "v1.8.0"),
  bumpProjectHeadFrom: vi.fn(async () => true),
}));

vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "refused"),
  newFreezeOperationId: vi.fn(() => "op-1"),
}));

vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })),
  listWorkflowRunsBySha: vi.fn(),
  isRepoPrivate: vi.fn(async () => null),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  getInstallationInfo: vi.fn(),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));

const { repairBuildWorkflow } = vi.hoisted(() => ({
  repairBuildWorkflow: vi.fn(async () => ({ kind: "repaired", newHeadSha: "new-sha", recorded: true })),
}));
vi.mock("~/lib/build-workflow.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, repairBuildWorkflow };
});

vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));

import { action } from "~/routes/_app.publish";
import { readLatestTag } from "~/lib/github-status.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { commitFilesToRepo } from "~/lib/commit.server";

function buildContext() {
  const doFetch = vi.fn();
  return {
    doFetch,
    context: {
      get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
      cloudflare: {
        env: {
          DB: {},
          SESSION_SECRET: "s",
          ENCRYPTION_KEY: "k",
          GITHUB_APP_ID: "app-id",
          GITHUB_PRIVATE_KEY: "private-key",
          COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: doFetch })) },
        },
      },
    } as unknown as Parameters<typeof action>[0]["context"],
  };
}

async function post(intent: string) {
  const form = new FormData();
  form.set("intent", intent);
  form.set("commitMessage", "Publish site");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  const { context, doFetch } = buildContext();
  let thrown: unknown;
  let result: unknown;
  try {
    result = await action({
      request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);
  } catch (err) {
    thrown = err;
  }
  return { result: result as Record<string, unknown> | undefined, thrown, doFetch };
}

function nothingTakenOrWritten(doFetch: ReturnType<typeof vi.fn>) {
  expect(controlFreezeLease).not.toHaveBeenCalled();
  expect(commitFilesToRepo).not.toHaveBeenCalled();
  expect(doFetch).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  site.telarVersion = "1.0.0";
  project.role = "convenor";
  project.workflowsWriteMissing = null;
  vi.mocked(readLatestTag).mockResolvedValue({ ok: true, tag: "v1.8.0" });
  vi.mocked(controlFreezeLease).mockResolvedValue("refused");
});

describe("publish on a release that cannot be read", () => {
  it("refuses in the shape the page clears its publishing state on, without the lease or a write", async () => {
    vi.mocked(readLatestTag).mockResolvedValue({ ok: false });

    const { result, thrown, doFetch } = await post("publish");

    expect(thrown).toBeUndefined();
    expect(result).toEqual({ ok: false, intent: "publish", error: "release_unknown", projectId: 7 });
    nothingTakenOrWritten(doFetch);
  });

  it("publishes a site with no recorded version, which reads as current", async () => {
    vi.mocked(readLatestTag).mockResolvedValue({ ok: false });
    site.telarVersion = null;

    const { result } = await post("publish");

    expect(controlFreezeLease).toHaveBeenCalledTimes(1);
    expect(result?.error).toBe("operation_in_progress");
  });
});

describe("publish on a site behind the latest release", () => {
  it("redirects to the upgrade, with the page to come back to", async () => {
    const { thrown, doFetch } = await post("publish");

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/upgrade?from=${encodeURIComponent("/publish")}`);
    nothingTakenOrWritten(doFetch);
  });

  it("sends a collaborator whose upgrade only the convenor can complete back to Objects", async () => {
    project.role = "collaborator";
    project.workflowsWriteMissing = 1;

    const { thrown, doFetch } = await post("publish");

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/objects");
    nothingTakenOrWritten(doFetch);
  });

  it("sends the convenor to the upgrade even when the permission is missing", async () => {
    project.workflowsWriteMissing = 1;

    const { thrown } = await post("publish");

    expect((thrown as Response).headers.get("Location")).toBe(`/upgrade?from=${encodeURIComponent("/publish")}`);
  });
});

describe("publish on a current site", () => {
  it("proceeds to the lease", async () => {
    site.telarVersion = "1.8.0";

    const { result, thrown } = await post("publish");

    expect(thrown).toBeUndefined();
    expect(controlFreezeLease).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, intent: "publish", error: "operation_in_progress" });
  });
});

describe("the build-workflow repair", () => {
  it("still runs when the latest release cannot be read", async () => {
    vi.mocked(readLatestTag).mockResolvedValue({ ok: false });

    const { result, thrown } = await post("repair-build-workflow");

    expect(thrown).toBeUndefined();
    expect(repairBuildWorkflow).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, intent: "repair-build-workflow" });
  });
});

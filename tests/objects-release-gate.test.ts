/**
 * Committing objects refuses on a site behind the latest release, or when the
 * latest release cannot be read.
 *
 * The commit rewrites objects.csv and dispatches the site's build, so it is
 * gated as publishing is. The refusal comes before the operation lease and
 * before any read of the repository, so a refused commit takes nothing and
 * writes nothing. The gate runs for real; the site version and the release
 * read are each case's inputs.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 42) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({ resolveActiveProject: vi.fn() }));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "refused"),
  newFreezeOperationId: vi.fn(() => "op-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "head-sha"),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(async () => null),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/github-status.server", () => ({
  bumpProjectHeadFrom: vi.fn(async () => true),
  readLatestTag: vi.fn(async () => ({ ok: true, tag: "v1.8.0" })),
}));
vi.mock("~/lib/sync.server", () => ({ computeSyncDiff: vi.fn(), applySyncChanges: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn(),
  verifySiteUrl: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
}));
vi.mock("~/lib/register-objects.server", () => ({ registerCommittedObjects: vi.fn() }));
vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn(async () => "applied") }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), findYMapByIdOrTempId: vi.fn() }));

import { action } from "~/routes/_app.objects";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { readLatestTag } from "~/lib/github-status.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { commitFilesToRepo, dispatchWorkflow } from "~/lib/commit.server";
import { getRepoHead } from "~/lib/github.server";
import { uploadNotice } from "~/lib/upload-notice";

let siteVersion: string | null = "1.0.0";
const updates: unknown[] = [];

function makeDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => []),
          limit: vi.fn(async () => (siteVersion === null ? [] : [{ telar_version: siteVersion }])),
        })),
      })),
    })),
    update: vi.fn(() => {
      updates.push("update");
      return { set: vi.fn(() => ({ where: vi.fn(async () => {}) })) };
    }),
  };
}

function asRole(role: "convenor" | "collaborator", workflowsWriteMissing: number | null = null) {
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: {
      id: 42,
      github_repo_full_name: "owner/repo",
      installation_id: 5,
      gh_workflows_write_missing: workflowsWriteMissing,
    } as never,
    userRole: role,
  });
}

async function commitObjects() {
  const context = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: { env: { ENCRYPTION_KEY: "key", SESSION_SECRET: "s", DB: {}, GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "k" } },
  };
  const request = new Request("https://compositor.telar.org/objects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      intent: "commit-objects",
      siteId: "42",
      disableSheets: "false",
      pendingObjects: JSON.stringify([{ object_id: "a-title", title: "A Title" }]),
    }).toString(),
  });
  return (await action({ request, context, params: {} } as never)) as Record<string, unknown>;
}

function nothingTakenOrWritten() {
  expect(controlFreezeLease).not.toHaveBeenCalled();
  expect(getRepoHead).not.toHaveBeenCalled();
  expect(commitFilesToRepo).not.toHaveBeenCalled();
  expect(dispatchWorkflow).not.toHaveBeenCalled();
  expect(updates).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  siteVersion = "1.0.0";
  updates.length = 0;
  vi.mocked(getDb).mockReturnValue(makeDb() as never);
  vi.mocked(readLatestTag).mockResolvedValue({ ok: true, tag: "v1.8.0" });
  vi.mocked(controlFreezeLease).mockResolvedValue("refused");
  asRole("convenor");
});

describe("commit-objects", () => {
  it("refuses a site behind the latest release, without the lease or a write", async () => {
    expect(await commitObjects()).toEqual({ ok: false, intent: "commit-objects", error: "upgrade_required" });
    nothingTakenOrWritten();
  });

  it("names the convenor for a collaborator whose upgrade only the convenor can complete", async () => {
    asRole("collaborator", 1);

    expect(await commitObjects()).toEqual({ ok: false, intent: "commit-objects", error: "upgrade_awaits_convenor" });
    nothingTakenOrWritten();
  });

  it("sends a collaborator who can complete the upgrade to it", async () => {
    asRole("collaborator", 0);

    expect((await commitObjects()).error).toBe("upgrade_required");
  });

  it("refuses when the latest release cannot be read, without the lease or a write", async () => {
    vi.mocked(readLatestTag).mockResolvedValue({ ok: false });

    expect(await commitObjects()).toEqual({ ok: false, intent: "commit-objects", error: "release_unknown" });
    nothingTakenOrWritten();
  });

  it("proceeds to the lease on a current site", async () => {
    siteVersion = "1.8.0";

    const answer = await commitObjects();

    expect(controlFreezeLease).toHaveBeenCalled();
    expect(answer.error).toBe("operation_in_progress");
  });

  it("proceeds on a site with no recorded version, without a lookup", async () => {
    siteVersion = null;
    vi.mocked(readLatestTag).mockResolvedValue({ ok: false });

    await commitObjects();

    expect(readLatestTag).not.toHaveBeenCalled();
    expect(controlFreezeLease).toHaveBeenCalled();
  });
});

describe("the Upload tab's notice", () => {
  it("says the release cannot be read, with no link", () => {
    expect(uploadNotice({ releaseUnknown: true })).toEqual({
      reasonKey: "repo_write_release_unknown",
      action: null,
    });
  });

  it("keeps the upgrade notices ahead of it", () => {
    expect(uploadNotice({ needsUpgrade: true, releaseUnknown: true })?.reasonKey).toBe(
      "upload_disabled_upgrade_required",
    );
  });

  it("shows nothing on a current site", () => {
    expect(uploadNotice({ needsUpgrade: false, releaseUnknown: false })).toBeNull();
  });
});

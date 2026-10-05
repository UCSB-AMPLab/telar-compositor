/**
 * The objects page's pre-commit check keeps a failed read of `_config.yml`
 * apart from a site with Google Sheets off. The commit posts
 * `disableSheets` from this answer, so "off" from a read that failed would let
 * the build fetch Sheets over the committed objects.csv.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({ getSession: vi.fn(async () => ({ get: vi.fn(() => 42) })) })),
}));
vi.mock("~/lib/membership.server", () => ({ resolveActiveProject: vi.fn() }));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/freeze-lease.server", () => ({ controlFreezeLease: vi.fn(), newFreezeOperationId: vi.fn() }));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(),
  getFileOnDefaultBranch: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn(), readLatestTag: vi.fn() }));
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
vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn() }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), findYMapByIdOrTempId: vi.fn() }));

import { action } from "~/routes/_app.objects";
import { resolveActiveProject } from "~/lib/membership.server";
import { getFileOnDefaultBranch } from "~/lib/github.server";
import { isGoogleSheetsEnabled, verifySiteUrl } from "~/lib/commit.server";

async function postPreCommitCheckIntent() {
  const context = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: { env: { ENCRYPTION_KEY: "key", SESSION_SECRET: "s", DB: {}, GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "k" } },
  };
  const request = new Request("https://compositor.telar.org/objects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "pre-commit-check", siteId: "42" }).toString(),
  });
  return (await action({ request, context, params: {} } as never)) as Record<string, unknown>;
}

const PRE_COMMIT_UNREACHABLE_ANSWER = { ok: false, reason: "unreachable", intent: "pre-commit-check" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
    userRole: "convenor",
  });
  vi.mocked(verifySiteUrl).mockResolvedValue({ pagesEnabled: true, match: true, pagesUrl: "p", configUrl: "p" });
});

describe("pre-commit-check", () => {
  it("answers unreachable, not Sheets off, when the _config.yml read fails", async () => {
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "error" });

    expect(await postPreCommitCheckIntent()).toEqual(PRE_COMMIT_UNREACHABLE_ANSWER);
    expect(isGoogleSheetsEnabled).not.toHaveBeenCalled();
    expect(verifySiteUrl).not.toHaveBeenCalled();
  });

  it("answers unreachable when the read throws", async () => {
    vi.mocked(getFileOnDefaultBranch).mockRejectedValue(new TypeError("fetch failed"));

    expect(await postPreCommitCheckIntent()).toEqual(PRE_COMMIT_UNREACHABLE_ANSWER);
  });

  it("answers unreachable when the URL check throws after a good read", async () => {
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "ok", content: "url: x\n" });
    vi.mocked(verifySiteUrl).mockRejectedValue(new TypeError("fetch failed"));

    expect(await postPreCommitCheckIntent()).toEqual(PRE_COMMIT_UNREACHABLE_ANSWER);
  });

  it("answers unreachable when the Pages read failed, not a URL mismatch", async () => {
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "ok", content: "url: x\n" });
    vi.mocked(verifySiteUrl).mockResolvedValue({ pagesEnabled: false, match: false, pagesUrl: "", configUrl: "x", readFailed: true });

    expect(await postPreCommitCheckIntent()).toEqual(PRE_COMMIT_UNREACHABLE_ANSWER);
  });

  it.each([401, 403])("shows no URL mismatch, and asks nothing again, when the Pages read is refused (%i)", async () => {
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "ok", content: "google_sheets:\n  enabled: yes\n" });
    vi.mocked(isGoogleSheetsEnabled).mockReturnValue(true);
    vi.mocked(verifySiteUrl).mockResolvedValue({ pagesEnabled: false, match: false, pagesUrl: "", configUrl: "x", readRefused: true });

    const answer = await postPreCommitCheckIntent();

    expect(answer).toMatchObject({ ok: true, intent: "pre-commit-check", sheetsEnabled: true, urlCheck: { match: true, pagesUrl: "" } });
  });

  it("shows no URL mismatch when Pages is off (404), since there is no Pages URL to compare", async () => {
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "ok", content: "url: x\n" });
    vi.mocked(verifySiteUrl).mockResolvedValue({ pagesEnabled: false, match: false, pagesUrl: "", configUrl: "x" });

    expect(await postPreCommitCheckIntent()).toMatchObject({ ok: true, urlCheck: { match: true, pagesUrl: "" } });
  });

  it("still passes a real mismatch through", async () => {
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "ok", content: "url: x\n" });
    vi.mocked(verifySiteUrl).mockResolvedValue({ pagesEnabled: true, match: false, pagesUrl: "p", configUrl: "x" });

    expect(await postPreCommitCheckIntent()).toMatchObject({ ok: true, urlCheck: { match: false, pagesUrl: "p" } });
  });

  it("names the objects sheet the site holds: objects.csv, else objetos.csv", async () => {
    vi.mocked(getFileOnDefaultBranch).mockImplementation(async (_t, _o, _r, path) =>
      path === "telar-content/spreadsheets/objetos.csv" ? { status: "ok", content: "object_id,title\n" } : path === "_config.yml" ? { status: "ok", content: "url: x\n" } : { status: "absent" },
    );
    expect(await postPreCommitCheckIntent()).toMatchObject({ ok: true, objectsFile: "objetos.csv" });

    vi.mocked(getFileOnDefaultBranch).mockImplementation(async (_t, _o, _r, path) =>
      path === "_config.yml" ? { status: "ok", content: "url: x\n" } : { status: "ok", content: "object_id,title\n" },
    );
    expect(await postPreCommitCheckIntent()).toMatchObject({ ok: true, objectsFile: "objects.csv" });
  });

  it("reports the flag from a file it read", async () => {
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "ok", content: "google_sheets:\n  enabled: yes\n" });
    vi.mocked(isGoogleSheetsEnabled).mockReturnValue(true);

    expect(await postPreCommitCheckIntent()).toMatchObject({ ok: true, intent: "pre-commit-check", sheetsEnabled: true });
  });

  it("answers Sheets off for a site with no _config.yml, which is an answer", async () => {
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "absent" });

    expect(await postPreCommitCheckIntent()).toMatchObject({ ok: true, sheetsEnabled: false });
  });
});

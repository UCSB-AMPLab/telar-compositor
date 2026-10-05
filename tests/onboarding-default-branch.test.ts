/**
 * The onboarding action's `fix_default_branch` intent: the author's
 * click on "Rename to main and import" or "Make main the default and import".
 *
 * The intent takes the installation and repository as `import` does, runs on
 * the author's own token, and decides what to change from GitHub alone: a
 * form that says which case the author was shown is not read, since the
 * repository can change between the message and the click. `import` itself
 * never changes a branch.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined), set: vi.fn() })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));

vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn((c: string) => c),
  verifySiteUrl: vi.fn(),
  enableGitHubPages: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(() => false),
}));

vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn(async () => "install-token") }));

// The installation reaches the repository; its check has its own suite.
vi.mock("~/lib/onboarding-create-site.server", () => ({
  handleCreateSiteIntents: vi.fn(),
  importScopeRefusal: vi.fn(async () => null),
}));

vi.mock("~/lib/import.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/import.server")>();
  return { ...actual, importRepo: vi.fn() };
});

vi.mock("~/lib/join-codes.server", () => ({ redeemForSite: vi.fn() }));

vi.mock("~/lib/course-membership.server", () => ({ applyRedemptionSideEffects: vi.fn() }));

import { action } from "~/routes/onboarding";
import { importRepo, refusedImportResult } from "~/lib/import.server";
import type { ImportResult } from "~/lib/import.server";
import { TELAR_CONFIG, installRepoFake, repoFake, writes, type GitHubRepoFake } from "./helpers/github-branch-fake";

const IMPORTED = { ...refusedImportResult({}), valid: true, projectId: 7 } as ImportResult;

function post(fields: Record<string, string>) {
  const form = new URLSearchParams(fields);
  return action({
    request: new Request("https://compositor.telar.org/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: {
      get: vi.fn(() => ({ id: 3, encrypted_access_token: "enc", course_access: false })),
      cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {} } },
    } as never,
    params: {},
  } as never) as Promise<unknown>;
}

const FIELDS = { installation_id: "11", repo_full_name: "owner/repo" };

let repo: GitHubRepoFake;
let importedOn: Array<string | null>;

beforeEach(() => {
  vi.clearAllMocks();
  repo = repoFake();
  repo.files.set("master-sha", { "_config.yml": TELAR_CONFIG });
  installRepoFake(repo);
  importedOn = [];
  vi.mocked(importRepo).mockImplementation(async () => {
    importedOn.push(repo.defaultBranch);
    return IMPORTED;
  });
});

describe("onboarding action — fix_default_branch", () => {
  it("renames the default to main with the author's token, then imports the repository on main", async () => {
    const result = (await post({ intent: "fix_default_branch", ...FIELDS })) as ImportResult;

    expect(result.valid).toBe(true);
    expect(writes(repo)).toEqual(["POST /branches/master/rename"]);
    expect(repo.log.every((entry) => entry.auth === "Bearer user-token")).toBe(true);
    expect(importedOn).toEqual(["main"]);
    expect(vi.mocked(importRepo).mock.calls[0][0]).toMatchObject({
      token: "user-token",
      installationId: 11,
      repoFullName: "owner/repo",
      userId: 3,
    });
  });

  it("decides from GitHub, not from the case the form names", async () => {
    repo.branches.set("main", "main-sha");
    repo.files.set("main-sha", { "_config.yml": 'title: "Other"\n' });

    const result = (await post({ intent: "fix_default_branch", ...FIELDS, main_branch: "absent", case: "rename" })) as ImportResult;

    expect(result).toMatchObject({ valid: false, validationError: "no_main_branch", mainBranch: "not_site" });
    expect(writes(repo)).toEqual([]);
    expect(importRepo).not.toHaveBeenCalled();
  });

  it("answers branch_admin_required on a 403, with no import", async () => {
    repo.renameStatuses.push(403);

    const result = (await post({ intent: "fix_default_branch", ...FIELDS })) as ImportResult;

    expect(result).toMatchObject({ valid: false, validationError: "branch_admin_required" });
    expect(importRepo).not.toHaveBeenCalled();
  });
});

describe("onboarding action — import never changes a branch", () => {
  it("passes a non-main default to the import untouched", async () => {
    vi.mocked(importRepo).mockResolvedValue(refusedImportResult({ validationError: "no_main_branch", defaultBranch: "master" }));

    await post({ intent: "import", ...FIELDS });

    expect(writes(repo)).toEqual([]);
  });
});

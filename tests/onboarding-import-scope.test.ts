/**
 * The onboarding action's three import intents — `import`, `import_with_url`
 * and `fix_default_branch` — check on the server that the installation named
 * in the form reaches the repository named in it, before anything reads or
 * changes the repository.
 *
 * The form is the author's browser, so the client's pre-check is no guarantee:
 * a submission made after the App lost access, or made directly, would import
 * the repository and record an installation every later commit fails under.
 * Out of scope answers `scopeBlocked`; a check that cannot be made answers the
 * import's `scope_check_failed` refusal. Neither imports, changes a branch or
 * writes D1.
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

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(),
  getInstallationAccount: vi.fn(),
}));

// The real onboarding-create-site module runs, so the check the action makes
// is the one `check-installation-scope` answers from; only its GitHub read is
// stubbed.
vi.mock("~/lib/create-site.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/create-site.server")>();
  return { ...actual, isRepoInInstallation: vi.fn() };
});

vi.mock("~/lib/import.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/import.server")>();
  return { ...actual, importRepo: vi.fn() };
});

vi.mock("~/lib/join-codes.server", () => ({ redeemForSite: vi.fn() }));

vi.mock("~/lib/course-membership.server", () => ({ applyRedemptionSideEffects: vi.fn() }));

import { action } from "~/routes/onboarding";
import { importRepo, refusedImportResult } from "~/lib/import.server";
import type { ImportResult } from "~/lib/import.server";
import { getDb } from "~/lib/db.server";
import { getInstallationToken } from "~/lib/github-app.server";
import { GitHubError, isRepoInInstallation } from "~/lib/create-site.server";
import { handleCreateSiteIntents } from "~/lib/onboarding-create-site.server";
import { TELAR_CONFIG, installRepoFake, repoFake, writes, type GitHubRepoFake } from "./helpers/github-branch-fake";

const IMPORTED = { ...refusedImportResult({}), valid: true, projectId: 7 } as ImportResult;

const ENV = {
  ENCRYPTION_KEY: "k",
  SESSION_SECRET: "s",
  DB: {},
  GITHUB_APP_ID: "app-id",
  GITHUB_PRIVATE_KEY: "private-key",
};

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
      cloudflare: { env: ENV },
    } as never,
    params: {},
  } as never) as Promise<unknown>;
}

const FIELDS = { installation_id: "11", repo_full_name: "owner/repo" };

const INTENTS: Array<{ intent: string; extra: Record<string, string> }> = [
  { intent: "import", extra: {} },
  { intent: "import_with_url", extra: { sheets_url: "https://docs.google.com/spreadsheets/d/e/x/pubhtml" } },
  { intent: "fix_default_branch", extra: {} },
];

let repo: GitHubRepoFake;

beforeEach(() => {
  vi.clearAllMocks();
  // A repository whose default branch is not `main`, so a `fix_default_branch`
  // that got past the check would rename it.
  repo = repoFake();
  repo.files.set("master-sha", { "_config.yml": TELAR_CONFIG });
  installRepoFake(repo);
  vi.mocked(getInstallationToken).mockResolvedValue("install-token");
  vi.mocked(isRepoInInstallation).mockResolvedValue(true);
  vi.mocked(importRepo).mockResolvedValue(IMPORTED);
});

describe("onboarding import intents — the repository outside the installation", () => {
  for (const { intent, extra } of INTENTS) {
    it(`${intent}: answers scopeBlocked, with no import, branch change or D1 write`, async () => {
      vi.mocked(isRepoInInstallation).mockResolvedValue(false);

      const result = await post({ intent, ...FIELDS, ...extra, course_code: "ABCDEF2345" });

      expect(result).toEqual({ scopeBlocked: true, blockedIntent: intent });
      expect(importRepo).not.toHaveBeenCalled();
      expect(writes(repo)).toEqual([]);
      expect(repo.log).toEqual([]);
      expect(getDb).not.toHaveBeenCalled();
    });
  }

  it("asks about the installation and repository the form names, on the installation's token", async () => {
    vi.mocked(isRepoInInstallation).mockResolvedValue(false);

    await post({ intent: "import", ...FIELDS });

    expect(getInstallationToken).toHaveBeenCalledWith("app-id", "private-key", 11);
    expect(isRepoInInstallation).toHaveBeenCalledWith("install-token", "owner", "repo");
  });
});

describe("onboarding import intents — the repository inside the installation", () => {
  it("import: imports as before", async () => {
    const result = (await post({ intent: "import", ...FIELDS })) as ImportResult;

    expect(result.valid).toBe(true);
    expect(importRepo).toHaveBeenCalledTimes(1);
    expect(vi.mocked(importRepo).mock.calls[0][0]).toMatchObject({
      token: "user-token",
      installationId: 11,
      repoFullName: "owner/repo",
      origin: "imported",
    });
  });

  it("import_with_url: imports with the corrected Sheets URL", async () => {
    const result = (await post({ intent: "import_with_url", ...FIELDS, ...INTENTS[1].extra })) as ImportResult;

    expect(result.valid).toBe(true);
    expect(vi.mocked(importRepo).mock.calls[0][0]).toMatchObject({
      overrideGoogleSheetsUrl: INTENTS[1].extra.sheets_url,
    });
  });

  it("fix_default_branch: moves the default to main, then imports", async () => {
    const result = (await post({ intent: "fix_default_branch", ...FIELDS })) as ImportResult;

    expect(result.valid).toBe(true);
    expect(writes(repo)).toEqual(["POST /branches/master/rename"]);
    expect(importRepo).toHaveBeenCalledTimes(1);
  });

  it("runs the check before the repository is read", async () => {
    const order: string[] = [];
    vi.mocked(isRepoInInstallation).mockImplementation(async () => {
      order.push(`check:${repo.log.length}`);
      return true;
    });

    await post({ intent: "fix_default_branch", ...FIELDS });

    expect(order).toEqual(["check:0"]);
  });
});

describe("onboarding import intents — a check that cannot be made", () => {
  for (const { intent, extra } of INTENTS) {
    it(`${intent}: a token that cannot be minted refuses with scope_check_failed and imports nothing`, async () => {
      vi.mocked(getInstallationToken).mockRejectedValue(new Error("Failed to get installation token: 404"));

      const result = (await post({ intent, ...FIELDS, ...extra })) as ImportResult;

      expect(result).toEqual(refusedImportResult({ validationError: "scope_check_failed" }));
      expect(isRepoInInstallation).not.toHaveBeenCalled();
      expect(importRepo).not.toHaveBeenCalled();
      expect(writes(repo)).toEqual([]);
      expect(getDb).not.toHaveBeenCalled();
    });

    it(`${intent}: a submission with no repository, or a malformed one, refuses with scope_check_failed`, async () => {
      for (const fields of [{ installation_id: "11" }, { ...FIELDS, repo_full_name: "owner" }, { ...FIELDS, repo_full_name: "a/b/c" }]) {
        const result = (await post({ intent, ...fields, ...extra })) as ImportResult;

        expect(result).toEqual(refusedImportResult({ validationError: "scope_check_failed" }));
      }
      expect(isRepoInInstallation).not.toHaveBeenCalled();
      expect(importRepo).not.toHaveBeenCalled();
      expect(writes(repo)).toEqual([]);
    });

    it(`${intent}: a GitHub 5xx on the installation's repositories refuses with scope_check_failed`, async () => {
      vi.mocked(isRepoInInstallation).mockRejectedValue(
        new GitHubError("isRepoInInstallation: unexpected status 502", 502),
      );

      const result = (await post({ intent, ...FIELDS, ...extra })) as ImportResult;

      expect(result).toEqual(refusedImportResult({ validationError: "scope_check_failed" }));
      expect(importRepo).not.toHaveBeenCalled();
      expect(writes(repo)).toEqual([]);
    });
  }
});

describe("check-installation-scope — its answers are unchanged", () => {
  it("in scope, out of scope and a failed check answer as before", async () => {
    const form = () => {
      const f = new FormData();
      f.set("installation_id", "11");
      f.set("owner", "owner");
      f.set("name", "repo");
      return f;
    };
    const env = ENV as unknown as Env;

    expect(await handleCreateSiteIntents("check-installation-scope", form(), "user-token", env)).toEqual({
      ok: true,
      intent: "check-installation-scope",
      inScope: true,
    });

    vi.mocked(isRepoInInstallation).mockResolvedValue(false);
    expect(await handleCreateSiteIntents("check-installation-scope", form(), "user-token", env)).toEqual({
      ok: true,
      intent: "check-installation-scope",
      inScope: false,
    });

    vi.mocked(getInstallationToken).mockRejectedValue(new Error("mint failed"));
    expect(await handleCreateSiteIntents("check-installation-scope", form(), "user-token", env)).toMatchObject({
      ok: false,
      intent: "check-installation-scope",
      error: "github_error",
      message: "mint failed",
    });
  });
});

/**
 * The `in-sync` payload of
 * `api.site-status.tsx` is member-level (gated only by `role !== null`,
 * see the loader), so a collaborator reaches it. It must resolve its
 * project-repo read through `resolveProjectToken` (installation token,
 * convenor-only fallback) rather than the polling member's own decrypted
 * token — a private repo the collaborator is not a GitHub collaborator on
 * would otherwise silently lose the commit
 * message for them alone. The `gh-status` payload's own routing is pinned
 * in tests/api-site-status-gh.test.ts.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  decryptMock: vi.fn(),
  resolveActiveProjectFromRequestMock: vi.fn(),
  getUserRoleMock: vi.fn(),
  resolveProjectTokenMock: vi.fn(async () => "installation-token"),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/db.server", () => ({ getDb: mocks.getDbMock }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: mocks.decryptMock }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(),
  getUserRole: mocks.getUserRoleMock,
}));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: mocks.resolveActiveProjectFromRequestMock,
}));
vi.mock("~/lib/github-status.server", () => ({
  isStale: vi.fn(),
  claimRefresh: vi.fn(),
  refreshGithubStatus: vi.fn(),
  deriveHeadDiverged: vi.fn(),
  getCachedLatestTag: vi.fn(),
}));
vi.mock("~/lib/telar-version", () => ({ compareTelarVersion: vi.fn() }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationInfo: vi.fn(),
  resolveProjectToken: mocks.resolveProjectTokenMock,
}));
vi.mock("~/lib/github.server", () => ({ githubHeaders: vi.fn(() => ({})) }));
vi.mock("~/lib/publish.server", () => ({
  computeChangeSummary: vi.fn(),
  buildEntityHashes: vi.fn(),
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: mocks.userContext }));

import { loader } from "~/routes/api.site-status";
import { resolveProjectToken } from "~/lib/github-app.server";
import { checkD1Bind } from "./helpers/d1-memory";

const USER = {
  id: 42,
  encrypted_access_token: "enc-tok",
};

const PROJECT = {
  id: 7,
  installation_id: 55,
  head_sha: "abc123",
  github_repo_full_name: "owner/repo",
  last_published_at: null,
  last_synced_at: null,
};

function buildContext(env: Record<string, unknown> = {}) {
  return {
    get: (key: unknown) => (key === mocks.userContext ? USER : undefined),
    cloudflare: {
      env: { SESSION_SECRET: "s", ENCRYPTION_KEY: "k", GITHUB_APP_ID: "app-id", GITHUB_PRIVATE_KEY: "pk", ...env },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActiveProjectFromRequestMock.mockResolvedValue({ project: PROJECT, userRole: "collaborator" });
  mocks.decryptMock.mockResolvedValue("collaborator-own-token");
  mocks.getDbMock.mockReturnValue({});
  mocks.resolveProjectTokenMock.mockResolvedValue("installation-token");
});

describe("in-sync payload — collaborator", () => {
  function request() {
    return new Request("https://compositor.telar.org/api/site-status?payload=in-sync");
  }

  function contextWithBlobBytes() {
    const DB = {
      prepare(sql: string) {
        const stmt = {
          bind(...args: unknown[]) {
            checkD1Bind(sql, args);
            return stmt;
          },
          first: async () => null,
        };
        return stmt;
      },
    };
    return buildContext({ DB });
  }

  it("resolveProjectToken is asked for the project's installation, non-convenor, and its result reaches the commit-message fetch", async () => {
    mocks.getUserRoleMock.mockResolvedValue("collaborator");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ commit: { message: "a commit" } }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await loader({ request: request(), context: contextWithBlobBytes() as never, params: {} } as never);

    expect(vi.mocked(resolveProjectToken)).toHaveBeenCalledWith(
      "app-id",
      "pk",
      PROJECT.installation_id,
      "collaborator-own-token",
      "collaborator",
    );
    const fetchUrl = fetchSpy.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("owner/repo");
    vi.unstubAllGlobals();
  });

  it("instructor: resolveProjectToken is asked with the instructor role, not a substituted one", async () => {
    mocks.getUserRoleMock.mockResolvedValue("instructor");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ commit: { message: "a commit" } }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await loader({ request: request(), context: contextWithBlobBytes() as never, params: {} } as never);

    expect(vi.mocked(resolveProjectToken)).toHaveBeenCalledWith(
      "app-id",
      "pk",
      PROJECT.installation_id,
      "collaborator-own-token",
      "instructor",
    );
    vi.unstubAllGlobals();
  });
});

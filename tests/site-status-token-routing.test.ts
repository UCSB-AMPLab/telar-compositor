/**
 * The `out-of-sync` and `in-sync` payloads of
 * `api.site-status.tsx` are member-level (gated only by `role !== null`,
 * see the loader), so a collaborator reaches both. Each must resolve its
 * project-repo read through `resolveProjectToken` (installation token,
 * convenor-only fallback) rather than the polling member's own decrypted
 * token — a private repo the collaborator is not a GitHub collaborator on
 * would otherwise silently degrade to an empty diff or a missing commit
 * message for them alone. The `gh-status` payload's own routing is pinned
 * in tests/api-site-status-gh.test.ts.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  decryptMock: vi.fn(),
  resolveActiveProjectFromRequestMock: vi.fn(),
  getUserRoleMock: vi.fn(),
  computeFullSyncDiffMock: vi.fn(),
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
vi.mock("~/lib/sync.server", () => ({ computeFullSyncDiff: mocks.computeFullSyncDiffMock }));
vi.mock("~/middleware/auth.server", () => ({ userContext: mocks.userContext }));
// The site's framework version, which the diff matches objects by.
vi.mock("~/lib/site-version.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  readSiteTelarVersion: vi.fn(async () => "1.8.0"),
}));

import { loader } from "~/routes/api.site-status";
import { resolveProjectToken } from "~/lib/github-app.server";
import { CollidingColumnsRefusal } from "~/lib/import.server";
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

describe("out-of-sync payload — collaborator", () => {
  function request() {
    return new Request("https://compositor.telar.org/api/site-status?payload=out-of-sync");
  }

  it("resolveProjectToken is asked for the project's installation, non-convenor, and its result reaches computeFullSyncDiff", async () => {
    mocks.getUserRoleMock.mockResolvedValue("collaborator");
    mocks.computeFullSyncDiffMock.mockResolvedValue({ ok: true });

    await loader({ request: request(), context: buildContext() as never, params: {} } as never);

    expect(vi.mocked(resolveProjectToken)).toHaveBeenCalledWith(
      "app-id",
      "pk",
      PROJECT.installation_id,
      "collaborator-own-token",
      "collaborator",
    );
    expect(mocks.computeFullSyncDiffMock).toHaveBeenCalledWith(
      PROJECT.id,
      "installation-token",
      "owner",
      "repo",
      expect.anything(),
      PROJECT.head_sha,
      { frameworkVersion: "1.8.0", legacyRef: PROJECT.head_sha },
    );
  });

  // Ids an earlier import stored stripped are paired, and so shown as
  // divergence, only until the project's first sync check repairs them.
  it("pairs stripped ids only while the project's ids are unrepaired", async () => {
    mocks.getUserRoleMock.mockResolvedValue("collaborator");
    mocks.computeFullSyncDiffMock.mockResolvedValue({ ok: true });
    mocks.resolveActiveProjectFromRequestMock.mockResolvedValue({
      project: { ...PROJECT, legacy_ids_repaired_at: "2026-09-30" }, userRole: "collaborator",
    });

    await loader({ request: request(), context: buildContext() as never, params: {} } as never);

    expect(mocks.computeFullSyncDiffMock.mock.calls[0][6]).toEqual({ frameworkVersion: "1.8.0", legacyRef: undefined });
  });

  it("convenor: resolveProjectToken is asked with the convenor fallback allowed", async () => {
    mocks.getUserRoleMock.mockResolvedValue("convenor");
    mocks.computeFullSyncDiffMock.mockResolvedValue({ ok: true });

    await loader({ request: request(), context: buildContext() as never, params: {} } as never);

    expect(vi.mocked(resolveProjectToken)).toHaveBeenCalledWith(
      "app-id",
      "pk",
      PROJECT.installation_id,
      "collaborator-own-token",
      "convenor",
    );
  });

  // The installation token belongs to publishing
  // roles. This payload carries no role gate beyond `role !== null`, so
  // which token an instructor's read travels on is settled entirely by the
  // role handed to resolveProjectToken (real implementation, see
  // tests/github-app.server.test.ts) — this file pins only that the real
  // role reaches it, never a substitute.
  it("instructor: resolveProjectToken is asked with the instructor role, not a substituted one", async () => {
    mocks.getUserRoleMock.mockResolvedValue("instructor");
    mocks.computeFullSyncDiffMock.mockResolvedValue({ ok: true });

    await loader({ request: request(), context: buildContext() as never, params: {} } as never);

    expect(vi.mocked(resolveProjectToken)).toHaveBeenCalledWith(
      "app-id",
      "pk",
      PROJECT.installation_id,
      "collaborator-own-token",
      "instructor",
    );
  });
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

// A sheet the sync refuses for its colliding columns reaches this payload as a
// diff that cannot be computed, and reads the same way: an empty diff, not a 500.
describe("out-of-sync payload — a sheet the sync refuses", () => {
  it("returns the empty diff rather than throwing", async () => {
    mocks.getUserRoleMock.mockResolvedValue("convenor");
    mocks.computeFullSyncDiffMock.mockRejectedValue(
      new CollidingColumnsRefusal("objects.csv", "medium_genre", ["medium", "object_type"]),
    );

    const res = (await loader({
      request: new Request("https://compositor.telar.org/api/site-status?payload=out-of-sync"),
      context: buildContext() as never,
      params: {},
    } as never)) as Response;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { objects: { newObjects: unknown[] }; hasConflicts: boolean };
    expect(body.objects.newObjects).toEqual([]);
    expect(body.hasConflicts).toBe(false);
  });
});

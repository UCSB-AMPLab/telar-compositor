/**
 * The `in-sync` payload's saved-state size, taken from a query of its own.
 *
 * What is asserted is the statement the route generated and the value it bound,
 * not a stubbed property answering whatever was asked for: the size has to be
 * SQLite's `length()` over `yjs_state`, so the megabytes never cross the
 * binding, and the id has to be the active project's, which membership has
 * already been verified for. Both fail-open exits of the branch carry the field
 * as well, since the pill renders the same body whichever one answered.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkD1Bind } from "./helpers/d1-memory";

const mocks = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  decryptMock: vi.fn(),
  resolveActiveProjectFromRequestMock: vi.fn(),
  getUserRoleMock: vi.fn(),
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
  resolveProjectToken: vi.fn(
    async (_appId: string, _key: string, _installationId: number, userToken: string) => userToken,
  ),
}));
vi.mock("~/lib/github.server", () => ({ githubHeaders: vi.fn(() => ({})) }));
vi.mock("~/lib/publish.server", () => ({
  computeChangeSummary: vi.fn(),
  buildEntityHashes: vi.fn(),
}));
vi.mock("~/lib/sync.server", () => ({ computeFullSyncDiff: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: mocks.userContext }));

import { loader } from "../app/routes/api.site-status";

const USER = {
  id: 42,
  github_id: 1,
  github_login: "tester",
  github_name: null,
  github_email: null,
  encrypted_access_token: "enc-tok",
  created_at: null,
};

const PROJECT = {
  id: 7,
  publish_snapshot: null,
  last_published_at: "2026-05-20T10:00:00Z",
  head_sha: null,
  last_synced_at: "2026-05-20T10:05:00Z",
  github_repo_full_name: "owner/repo",
};

/** Every statement the route prepared, with what it bound to each. */
interface Statement {
  sql: string;
  binds: unknown[];
}

function inSyncContext(sizeAnswer: unknown) {
  const statements: Statement[] = [];
  const DB = {
    prepare(sql: string) {
      const record: Statement = { sql, binds: [] };
      statements.push(record);
      const stmt = {
        bind(...args: unknown[]) {
          checkD1Bind(sql, args);
          record.binds = args;
          return stmt;
        },
        first: async () => sizeAnswer,
      };
      return stmt;
    },
  };
  mocks.getDbMock.mockReturnValue({});
  mocks.resolveActiveProjectFromRequestMock.mockResolvedValue({ project: PROJECT });
  mocks.getUserRoleMock.mockResolvedValue("convenor");
  const context = {
    get: (key: unknown) => (key === mocks.userContext ? USER : undefined),
    cloudflare: { env: { DB, SESSION_SECRET: "secret", ENCRYPTION_KEY: "key" } },
  };
  return { context, statements };
}

function inSyncRequest() {
  return new Request("https://compositor.telar.org/api/site-status?payload=in-sync");
}

async function loadInSync(sizeAnswer: unknown) {
  const { context, statements } = inSyncContext(sizeAnswer);
  const response = await loader({
    request: inSyncRequest(),
    context,
    params: {},
  } as never);
  return { body: (await (response as Response).json()) as Record<string, unknown>, statements };
}

describe("the in-sync payload carries the saved state's size", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks SQLite for the length alone, bound to the active project", async () => {
    const { body, statements } = await loadInSync({ bytes: 1_400_000 });

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toBe(
      "SELECT length(yjs_state) AS bytes FROM projects WHERE id = ?",
    );
    expect(statements[0].binds).toEqual([PROJECT.id]);
    expect(body.blobBytes).toBe(1_400_000);
  });

  it("answers null for a row whose blob is NULL", async () => {
    const { body } = await loadInSync({ bytes: null });

    expect(body.blobBytes).toBeNull();
  });

  it("answers null for a missing row", async () => {
    const { body } = await loadInSync(null);

    expect(body.blobBytes).toBeNull();
  });

  it("carries the field on the fail-open return with no head sha", async () => {
    const { body } = await loadInSync({ bytes: 2_000_001 });

    // No head_sha on the fixture, so the branch returns the stored timestamps
    // without reaching GitHub at all — and the size travels with them.
    expect(body).toMatchObject({
      last_published_at: PROJECT.last_published_at,
      last_synced_at: PROJECT.last_synced_at,
      commitMessage: null,
      blobBytes: 2_000_001,
    });
  });

  it("carries the field when the commit-message fetch fails open", async () => {
    const { context } = inSyncContext({ bytes: 3_000_000 });
    mocks.resolveActiveProjectFromRequestMock.mockResolvedValue({
      project: { ...PROJECT, head_sha: "abc1234" },
    });
    mocks.decryptMock.mockRejectedValue(new Error("no token"));

    const response = await loader({
      request: inSyncRequest(),
      context,
      params: {},
    } as never);
    const body = (await (response as Response).json()) as Record<string, unknown>;

    expect(body.commitMessage).toBeNull();
    expect(body.blobBytes).toBe(3_000_000);
  });
});

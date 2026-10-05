/**
 * Which token a publish commits on. A member whose stored access is
 * "access" commits on their own token; every other stage, and a member not yet
 * read, on the installation token; reads stay on the installation token. A
 * commit the member's token is refused (403) is made again once on the
 * installation token on the same expected head, and the member is marked for
 * a re-read. Any other failure is not retried.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  /** The caller's stored project_members.gh_access; undefined means no row. */
  access: undefined as string | null | undefined,
  /** The caller's stored gh_access_checked_at; null means it has not been read. */
  checked: "2026-10-02T09:00:00.000Z" as string | null,
  /** Every project_members `set` payload. */
  memberWrites: [] as Record<string, unknown>[],
}));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/db.server", async () => {
  const { project_members } = await import("~/db/schema");
  return {
    getDb: vi.fn(() => ({
      select: (columns?: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {};
        const rows =
          columns && "gh_access" in columns
            ? state.access === undefined ? [] : [{ gh_access: state.access, gh_access_checked_at: state.checked }]
            : columns && "slug" in columns ? [{ slug: "about", title: "About" }] : [];
        chain.from = () => chain;
        chain.innerJoin = () => chain;
        chain.where = () => Object.assign(Promise.resolve(rows), chain);
        chain.orderBy = function (this: unknown) { return this; };
        chain.limit = () => Promise.resolve(rows);
        return chain;
      },
      update: (table: unknown) => ({
        set: (payload: Record<string, unknown>) => {
          if (table === project_members) {
            state.memberWrites.push(payload);
            if ("gh_access_checked_at" in payload) state.checked = payload.gh_access_checked_at as string | null;
          }
          return { where: async () => undefined };
        },
      }),
    })),
  };
});

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({ getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })) })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "member-token") }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 7,
      github_repo_full_name: "owner/repo",
      installation_id: 55,
      publish_snapshot: null,
      head_sha: HEAD,
    },
    userRole: "collaborator",
  })),
  requirePublishingRole: vi.fn(async () => {}),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })) }));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const { getRepoHead, getFileAtRef } = vi.hoisted(() => ({
  getRepoHead: vi.fn(async (..._a: unknown[]) => "0123456789abcdef0123456789abcdef01234567"),
  getFileAtRef: vi.fn(async (..._a: unknown[]) => ({ status: "ok" as const, content: "title: \"x\"\n" })),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getRepoHead, getFileAtRef };
});
vi.mock("~/lib/upgrade.server", () => ({ healMissingFrameworkFiles: vi.fn(async () => []) }));

const { commitFilesToRepo, StaleHeadError } = vi.hoisted(() => {
  class StaleHeadError extends Error {}
  return { commitFilesToRepo: vi.fn(async (..._args: unknown[]) => ({ newHeadSha: "new-sha" })), StaleHeadError };
});
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo,
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError,
}));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet: vi.fn(async () => []) };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => true),
  newFreezeOperationId: () => "op-publish",
}));

import { action } from "~/routes/_app.publish";
import { GitHubPermissionError } from "~/lib/github.server";

function buildContext() {
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("OK")) })) },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function runPublish() {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Publish site");
  form.set("siteId", "7");
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: buildContext(),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as Record<string, unknown>;
}

const commitTokens = () => commitFilesToRepo.mock.calls.map((c) => c[0]);
const expectedHeads = () => commitFilesToRepo.mock.calls.map((c) => c[9]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.access = undefined;
  state.checked = "2026-10-02T09:00:00.000Z";
  state.memberWrites.length = 0;
  getRepoHead.mockResolvedValue(HEAD);
  commitFilesToRepo.mockImplementation(async () => ({ newHeadSha: "new-sha" }));
});

describe("the token a publish commits on", () => {
  it("is the member's own when their access is stored as access", async () => {
    state.access = "access";
    expect(await runPublish()).toMatchObject({ ok: true });
    expect(commitTokens()).toEqual(["member-token"]);
  });

  it("is the installation's when the access has not been read since it was stored", async () => {
    state.access = "access";
    state.checked = null;
    expect(await runPublish()).toMatchObject({ ok: true });
    expect(commitTokens()).toEqual(["install-token"]);
  });

  it.each(["pending", "lapsed", "none", null, undefined])(
    "is the installation's when the stored access is %s",
    async (access) => {
      state.access = access;
      expect(await runPublish()).toMatchObject({ ok: true });
      expect(commitTokens()).toEqual(["install-token"]);
    },
  );

  it("keeps every read the route makes on the installation token, and hands the commit helper the member's", async () => {
    state.access = "access";
    await runPublish();
    expect(commitTokens()).toEqual(["member-token"]);
    expect(getRepoHead.mock.calls.every((c) => c[0] === "install-token")).toBe(true);
    expect(getFileAtRef.mock.calls.every((c) => c[0] === "install-token")).toBe(true);
  });
});

describe("a commit the member's token is refused", () => {
  beforeEach(() => {
    state.access = "access";
  });

  it.each([401, 403, 404])("on %s lands on the installation token on the same expected head", async (status) => {
    commitFilesToRepo.mockRejectedValueOnce(new GitHubPermissionError("refused", status));
    expect(await runPublish()).toMatchObject({ ok: true, newHeadSha: "new-sha" });
    expect(commitTokens()).toEqual(["member-token", "install-token"]);
    expect(expectedHeads()).toEqual([HEAD, HEAD]);
  });

  it("marks only the time of the reading unread, leaving the stored access alone", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new GitHubPermissionError("refused", 403));
    await runPublish();
    expect(state.memberWrites).toEqual([{ gh_access_checked_at: null }]);
  });

  it("commits the next publish on the installation token until the access is read again", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new GitHubPermissionError("refused", 403));
    await runPublish();
    commitFilesToRepo.mockClear();
    await runPublish();
    expect(commitTokens()).toEqual(["install-token"]);
  });

  it("is not retried when the failure is another kind", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new Error("GitHub GraphQL error: 500"));
    expect(await runPublish()).toMatchObject({ ok: false, error: "publish_failed" });
    expect(commitTokens()).toEqual(["member-token"]);
    expect(state.memberWrites).toEqual([]);
  });

  it("is not retried more than once", async () => {
    commitFilesToRepo.mockRejectedValue(new GitHubPermissionError("refused", 403));
    expect(await runPublish()).toMatchObject({ ok: false, error: "github_permission" });
    expect(commitTokens()).toEqual(["member-token", "install-token"]);
  });
});

describe("a commit refused on the installation token", () => {
  it("is not retried", async () => {
    state.access = "pending";
    commitFilesToRepo.mockRejectedValue(new GitHubPermissionError("refused", 403));
    await runPublish();
    expect(commitTokens()).toEqual(["install-token"]);
    expect(state.memberWrites).toEqual([]);
  });
});

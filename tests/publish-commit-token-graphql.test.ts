/**
 * A commit GitHub refuses with HTTP 200 and a GraphQL `errors` entry of a
 * permission type is a refusal of the credential like a 403, so the publish's
 * fallback to the installation token covers it; any other GraphQL error is
 * not retried. The cases run the real commit helper and the real GraphQL
 * client against a stubbed fetch.
 *
 * @version v1.5.0-beta
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitFilesToRepo } from "~/lib/commit.server";
import { commitOnOwnToken } from "~/lib/publish-commit-token.server";
import { GitHubPermissionError, graphqlGitHub } from "~/lib/github.server";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function fakeDb(access: string) {
  const checked = "2026-10-02T09:00:00.000Z";
  const updates: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve([{ gh_access: access, gh_access_checked_at: checked }]);
  return {
    updates,
    db: {
      select: () => chain,
      update: () => ({ set: (v: Record<string, unknown>) => { updates.push(v); return { where: async () => undefined }; } }),
    } as never,
  };
}

/** GitHub's answer to each commit, in order, keyed by the bearer token that made it. */
function stubGitHub(answers: Record<string, unknown>) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).Authorization).replace("Bearer ", "");
    seen.push(token);
    return new Response(JSON.stringify(answers[token]), { status: 200 });
  }));
  return seen;
}

const refused = (type: string, message: string) => ({ data: null, errors: [{ type, message }] });
const landed = { data: { createCommitOnBranch: { commit: { oid: "new-sha" } } } };

function publish(db: never) {
  return commitOnOwnToken(db, { projectId: 7, userId: 1, userToken: "member", installToken: "install" }, (token) =>
    commitFilesToRepo(token, "o", "r", "main", [{ path: "a.md", content: "x" }], "m", undefined, undefined, undefined, HEAD),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("a GraphQL refusal of the member's token on a commit", () => {
  it.each([
    ["FORBIDDEN", "Resource not accessible by personal access token"],
    ["INSUFFICIENT_SCOPES", "Your token has not been granted the required scopes"],
  ])("of type %s lands on the installation token and marks the reading unread", async (type, message) => {
    const seen = stubGitHub({ member: refused(type, message), install: landed });
    const { db, updates } = fakeDb("access");
    await expect(publish(db)).resolves.toEqual({ newHeadSha: "new-sha" });
    expect(seen).toEqual(["member", "install"]);
    expect(updates).toEqual([{ gh_access_checked_at: null }]);
  });

  it("of another type is not retried", async () => {
    const seen = stubGitHub({ member: refused("UNPROCESSABLE", "Could not parse the file changes"), install: landed });
    const { db, updates } = fakeDb("access");
    await expect(publish(db)).rejects.toThrow("Could not parse");
    expect(seen).toEqual(["member"]);
    expect(updates).toEqual([]);
  });
});

describe("graphqlGitHub on an errors entry", () => {
  it("throws GitHubPermissionError for FORBIDDEN and a plain Error for the rest", async () => {
    stubGitHub({ a: refused("FORBIDDEN", "no"), b: refused("RATE_LIMITED", "slow down") });
    await expect(graphqlGitHub("a", "q", {})).rejects.toBeInstanceOf(GitHubPermissionError);
    const other = await graphqlGitHub("b", "q", {}).then(() => null, (e: unknown) => e);
    expect(other).toBeInstanceOf(Error);
    expect(other).not.toBeInstanceOf(GitHubPermissionError);
    await expect(graphqlGitHub("b", "q", {})).rejects.toThrow("slow down");
  });
});

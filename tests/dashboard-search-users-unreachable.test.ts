/**
 * The dashboard's `search-users` keeps a search GitHub did not githubSearchReply apart
 * from a search with no matches, and `searchGitHubUsers` throws on
 * a failed search instead of returning an empty list.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/membership.server", () => ({
  getUserProjects: vi.fn(async () => []),
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 1, github_repo_full_name: "owner/repo" },
    userRole: "convenor",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));
vi.mock("~/lib/sync.server", () => ({ checkRepairingLegacyIds: vi.fn(), computeFullSyncDiff: vi.fn(), applyFullSyncChanges: vi.fn() }));
vi.mock("~/lib/import.server", () => ({ scanRepoOrphanStoryIds: vi.fn(), parseCompositorIgnored: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({ commitFilesToRepo: vi.fn() }));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn() }));
vi.mock("~/lib/github.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/github.server")>()),
}));

import { action } from "~/routes/_app.dashboard";
import { searchGitHubUsers } from "~/lib/github.server";

function postSearchUsersIntent(query: string) {
  const request = new Request("https://compositor.telar.org/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "search-users", query, siteId: "1" }).toString(),
  });
  const context = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc" })),
    cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {} } },
  };
  return action({ request, context, params: {} } as never);
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

const githubSearchReply = (status: number, body: unknown = {}) =>
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("search-users", () => {
  it.each([503, 403, 429])("answers unreachable when GitHub's search answers %i", async (status) => {
    githubSearchReply(status);
    expect(await postSearchUsersIntent("ab")).toEqual({ ok: false, reason: "unreachable", intent: "search-users" });
  });

  it("answers unreachable when the request never completes", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    expect(await postSearchUsersIntent("ab")).toEqual({ ok: false, reason: "unreachable", intent: "search-users" });
  });

  it("answers ok with no users when nobody matches", async () => {
    githubSearchReply(200, { items: [] });
    expect(await postSearchUsersIntent("ab")).toEqual({ ok: true, intent: "search-users", users: [] });
  });

  it("answers ok with no users for a query too short to search, without asking GitHub", async () => {
    expect(await postSearchUsersIntent("a")).toEqual({ ok: true, intent: "search-users", users: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("searchGitHubUsers", () => {
  it("throws on a failed search and returns the matches otherwise", async () => {
    githubSearchReply(503);
    await expect(searchGitHubUsers("t", "ab")).rejects.toThrow(/503/);
    githubSearchReply(200, { items: [{ login: "ab", avatar_url: "u" }] });
    expect(await searchGitHubUsers("t", "ab")).toEqual([{ login: "ab", avatar_url: "u" }]);
  });
});

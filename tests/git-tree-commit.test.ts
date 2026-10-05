/**
 * The fenced Git Data commit: existing blobs placed by SHA, removed paths sent
 * as `sha: null`, text sent as content and cleaned, the parent the head the
 * caller read, and a moved branch refused as `StaleHeadError`.
 *
 * Everything runs against a mocked global fetch.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { commitTreeOnHead, type TreeCommitRequest } from "~/lib/git-tree-commit.server";
import { StaleHeadError } from "~/lib/commit.server";

function gitTreeReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A Git Data API that answers each call, and a ref update answered with `refStatus`. */
function gitTreeCommitApi(refStatus = 200) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/git/commits/")) return gitTreeReply({ tree: { sha: "parent-tree" } });
    if (method === "POST" && url.endsWith("/git/trees")) return gitTreeReply({ sha: "new-tree" });
    if (method === "POST" && url.endsWith("/git/commits")) return gitTreeReply({ sha: "new-commit" });
    if (method === "PATCH") return gitTreeReply({ object: { sha: "new-commit" } }, refStatus);
    return gitTreeReply({ message: "unexpected" }, 500);
  });
}

function gitTreeCallBody(fetchMock: ReturnType<typeof gitTreeCommitApi>, method: string, suffix: string) {
  const call = fetchMock.mock.calls.find(([url, init]) => (init?.method ?? "GET") === method && String(url).includes(suffix));
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}

const REQUEST: TreeCommitRequest = {
  token: "t",
  owner: "me",
  repo: "site",
  branch: "main",
  parentSha: "head-read",
  message: "Rename map to atlas via Telar Compositor [skip ci]",
  placements: [{ path: "telar-content/objects/atlas.jpg", sha: "blob-map", mode: "100644" }],
  texts: [{ path: "telar-content/spreadsheets/objects.csv", content: "object_id\natlas￾\n" }],
  deletions: [{ path: "telar-content/objects/map.jpg", mode: "100644" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("commitTreeOnHead", () => {
  it("builds the tree on the parent's, placing blobs by SHA and removing paths with sha null", async () => {
    const fetchMock = gitTreeCommitApi();
    vi.stubGlobal("fetch", fetchMock);

    await expect(commitTreeOnHead(REQUEST)).resolves.toEqual({ commitSha: "new-commit" });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/git/commits/head-read");
    expect(gitTreeCallBody(fetchMock, "POST", "/git/trees")).toEqual({
      base_tree: "parent-tree",
      tree: [
        { path: "telar-content/objects/atlas.jpg", mode: "100644", type: "blob", sha: "blob-map" },
        { path: "telar-content/spreadsheets/objects.csv", mode: "100644", type: "blob", content: "object_id\natlas\n" },
        { path: "telar-content/objects/map.jpg", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/git/blobs"))).toBe(false);
  });

  it("fences the commit to the head read: the parent, and a ref update that does not force", async () => {
    const fetchMock = gitTreeCommitApi();
    vi.stubGlobal("fetch", fetchMock);
    await commitTreeOnHead(REQUEST);

    expect(gitTreeCallBody(fetchMock, "POST", "/git/commits")).toEqual({
      message: REQUEST.message,
      tree: "new-tree",
      parents: ["head-read"],
    });
    expect(gitTreeCallBody(fetchMock, "PATCH", "/git/refs/heads/main")).toEqual({ sha: "new-commit", force: false });
  });

  it("answers a moved branch with StaleHeadError", async () => {
    vi.stubGlobal("fetch", gitTreeCommitApi(422));
    await expect(commitTreeOnHead(REQUEST)).rejects.toBeInstanceOf(StaleHeadError);
  });

  it("throws a plain error for any other failure", async () => {
    vi.stubGlobal("fetch", gitTreeCommitApi(500));
    const failure = commitTreeOnHead(REQUEST);
    await expect(failure).rejects.toThrow(/Updating the branch failed: 500/);
    await expect(failure).rejects.not.toBeInstanceOf(StaleHeadError);
  });
});

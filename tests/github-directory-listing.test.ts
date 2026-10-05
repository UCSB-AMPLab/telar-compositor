/**
 * The two reads the upgrade's sheet stage adds: one directory listed on its
 * own at a commit, for a repository whose recursive tree comes back truncated,
 * and a link's blob, which holds the path it points to.
 *
 * @version v1.5.0-beta
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getBlobText, listDirectoryEntries } from "~/lib/github.server";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jsonAnswer = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** A GraphQL answer placing `dir` at the one commit asked about. */
function subtree(at: unknown) {
  return jsonAnswer({ data: { repository: { c0: { __typename: "Commit" }, c0p0: at } } });
}

function routeFetch(routes: Record<string, () => Response>) {
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) throw new Error(`unexpected ${String(url)}`);
    return routes[key]();
  }) as unknown as typeof fetch;
}

describe("listDirectoryEntries", () => {
  it("lists the directory's own entries at the commit, not recursively, with full paths", async () => {
    routeFetch({
      "/graphql": () => subtree({ __typename: "Tree", oid: "tree-oid" }),
      "/git/trees/tree-oid": () =>
        jsonAnswer({
          truncated: false,
          tree: [
            { path: "story.csv", mode: "100644", type: "blob", sha: "a" },
            { path: "link.csv", mode: "120000", type: "blob", sha: "b" },
            { path: "old", mode: "040000", type: "tree", sha: "c" },
          ],
        }),
    });
    const entries = await listDirectoryEntries("t", "o", "r", "head", "telar-content/spreadsheets");
    expect(entries.map((e) => [e.path, e.mode])).toEqual([
      ["telar-content/spreadsheets/story.csv", "100644"],
      ["telar-content/spreadsheets/link.csv", "120000"],
      ["telar-content/spreadsheets/old", "040000"],
    ]);
    const treeCall = vi.mocked(globalThis.fetch).mock.calls.find((c) => String(c[0]).includes("/git/trees/"));
    expect(String(treeCall?.[0])).not.toContain("recursive");
  });

  it("answers no entries for a directory the commit does not have", async () => {
    routeFetch({ "/graphql": () => subtree(null) });
    expect(await listDirectoryEntries("t", "o", "r", "head", "telar-content/spreadsheets")).toEqual([]);
  });

  it.each([
    ["the directory lookup fails", { "/graphql": () => jsonAnswer({}, 500) }],
    ["the commit does not resolve", { "/graphql": () => jsonAnswer({ data: { repository: { c0: null, c0p0: null } } }) }],
    [
      "the listing fails",
      { "/graphql": () => subtree({ __typename: "Tree", oid: "x" }), "/git/trees/x": () => jsonAnswer({}, 502) },
    ],
    [
      "the listing is truncated",
      { "/graphql": () => subtree({ __typename: "Tree", oid: "x" }), "/git/trees/x": () => jsonAnswer({ truncated: true, tree: [] }) },
    ],
  ])("throws when %s", async (_label, routes) => {
    routeFetch(routes as Record<string, () => Response>);
    await expect(listDirectoryEntries("t", "o", "r", "head", "telar-content/spreadsheets")).rejects.toThrow();
  });
});

describe("getBlobText", () => {
  it("answers a blob's text", async () => {
    routeFetch({ "/git/blobs/abc": () => jsonAnswer({ content: Buffer.from("../data/x.csv").toString("base64"), encoding: "base64" }) });
    expect(await getBlobText("t", "o", "r", "abc")).toBe("../data/x.csv");
  });

  it("throws when the blob cannot be read", async () => {
    routeFetch({ "/git/blobs/abc": () => jsonAnswer({}, 500) });
    await expect(getBlobText("t", "o", "r", "abc")).rejects.toThrow();
  });
});

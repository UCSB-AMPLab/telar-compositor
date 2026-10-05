/**
 * The tile cache entries a rename clears: listed by key prefix across pages, a
 * refused listing answered as such, each entry deleted with a 404 counted as
 * deleted, and a deletion that keeps failing retried three times and logged
 * without throwing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { clearTileCacheEntries, listTileCacheEntries } from "~/lib/tile-cache.server";

const LIST_URL = "https://api.github.com/repos/me/site/actions/caches";

function tileCacheReply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

/** An Actions API holding `pages` of entries, answering each deletion by id from `deletes`. */
function cacheApi(pages: { id: number; key: string }[][], deletes: Record<number, number[]> = {}, listStatus = 200) {
  const tries: Record<number, number> = {};
  return vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "DELETE") {
      const id = Number(url.slice(url.lastIndexOf("/") + 1));
      const answers = deletes[id] ?? [204];
      const status = answers[Math.min(tries[id] ?? 0, answers.length - 1)];
      tries[id] = (tries[id] ?? 0) + 1;
      return tileCacheReply(null, status);
    }
    if (listStatus !== 200) return tileCacheReply({ message: "Resource not accessible by integration" }, listStatus);
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const link: Record<string, string> = page < pages.length ? { link: `<${LIST_URL}?key=iiif-tiles-&per_page=100&page=${page + 1}>; rel="next"` } : {};
    return tileCacheReply({ actions_caches: pages[page - 1] ?? [] }, 200, link);
  });
}

const deleteCalls = (fetchMock: ReturnType<typeof cacheApi>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => String(url));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listTileCacheEntries", () => {
  it("lists by the key prefix across pages, keeping only tile keys", async () => {
    const fetchMock = cacheApi([
      [{ id: 1, key: "iiif-tiles-abc" }, { id: 2, key: "audio-peaks-abc" }],
      [{ id: 3, key: "iiif-tiles-def" }],
    ]);
    vi.stubGlobal("fetch", fetchMock);
    await expect(listTileCacheEntries("t", "me", "site")).resolves.toEqual({ ok: true, ids: [1, 3] });
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${LIST_URL}?key=iiif-tiles-&per_page=100`);
  });

  it("answers not ok when the twentieth page still links to a next one", async () => {
    const pages = Array.from({ length: 21 }, (_, i) => [{ id: i + 1, key: "iiif-tiles-x" }]);
    const fetchMock = cacheApi(pages);
    vi.stubGlobal("fetch", fetchMock);
    await expect(listTileCacheEntries("t", "me", "site")).resolves.toMatchObject({ ok: false, truncated: true });
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("answers a refused listing with its status", async () => {
    vi.stubGlobal("fetch", cacheApi([], {}, 403));
    await expect(listTileCacheEntries("t", "me", "site")).resolves.toEqual({ ok: false, status: 403 });
  });
});

describe("clearTileCacheEntries", () => {
  it("lists again and deletes each entry, a 404 counted as deleted", async () => {
    const fetchMock = cacheApi([[{ id: 1, key: "iiif-tiles-a" }, { id: 2, key: "iiif-tiles-b" }]], { 2: [404] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(clearTileCacheEntries("t", "me", "site")).resolves.toEqual({ listed: true, deleted: [1, 2], failed: [] });
    expect(deleteCalls(fetchMock)).toEqual([`${LIST_URL}/1`, `${LIST_URL}/2`]);
  });

  it("retries a failing deletion three times, then logs it and goes on", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = cacheApi([[{ id: 7, key: "iiif-tiles-a" }, { id: 8, key: "iiif-tiles-b" }]], { 7: [500], 8: [500, 204] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(clearTileCacheEntries("t", "me", "site")).resolves.toEqual({ listed: true, deleted: [8], failed: [7] });
    expect(deleteCalls(fetchMock).filter((url) => url.endsWith("/7"))).toHaveLength(4);
    expect(deleteCalls(fetchMock).filter((url) => url.endsWith("/8"))).toHaveLength(2);
    expect(error).toHaveBeenCalled();
  });

  it("lists again after a listing past its page cap, so the entries beyond it are deleted too", async () => {
    let remaining = Array.from({ length: 2101 }, (_, i) => ({ id: i + 1, key: "iiif-tiles-x" }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        const id = Number(url.slice(url.lastIndexOf("/") + 1));
        remaining = remaining.filter((e) => e.id !== id);
        return tileCacheReply(null, 204);
      }
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const more = page * 100 < remaining.length;
      const link: Record<string, string> = more ? { link: `<${LIST_URL}?key=iiif-tiles-&per_page=100&page=${page + 1}>; rel="next"` } : {};
      return tileCacheReply({ actions_caches: remaining.slice((page - 1) * 100, page * 100) }, 200, link);
    });
    vi.stubGlobal("fetch", fetchMock);
    const cleared = await clearTileCacheEntries("t", "me", "site");
    expect(cleared.deleted).toHaveLength(2101);
    expect(remaining).toEqual([]);
  });

  it("answers a listing that fails after the commit without throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", cacheApi([], {}, 500));
    await expect(clearTileCacheEntries("t", "me", "site")).resolves.toEqual({ listed: false, deleted: [], failed: [] });
  });
});

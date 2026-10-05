/**
 * A self-hosted object is ready when its tile information file answers on the
 * deployed site: the probe asks the site for each object's `info.json` under
 * its site id, within a count and a deadline, and the page writes the objects
 * that answered into the shared document. A probe that fails proves nothing,
 * so it never marks an object not ready.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";
import { makeObjectYMap } from "~/lib/object-ymap";
import { TILE_PROBE_LIMIT, markTilesReady, tileProbeCandidates } from "~/lib/tile-readiness";
import { TILE_PROBE_DEADLINE_MS, probeTileStates } from "~/lib/tile-readiness.server";

const BASE = "https://example.org/site";

function answeringFor(ready: string[]) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: ready.includes(String(url)) ? 200 : 404 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeTileStates, ready", () => {
  it("asks the site for each object's info.json under its site id, and answers those that answered", async () => {
    const fetchMock = answeringFor([`${BASE}/iiif/objects/map/info.json`]);
    vi.stubGlobal("fetch", fetchMock);
    const ready = (await probeTileStates(BASE, ["map.jpg", "plan"], "1.7.0")).ready;
    expect(ready).toEqual(["map.jpg"]);
    expect(fetchMock.mock.calls.map((c) => String(c[0])).sort()).toEqual([
      `${BASE}/iiif/objects/map/info.json`,
      `${BASE}/iiif/objects/plan/info.json`,
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "HEAD" });
  });

  it("leaves out an object whose request failed or did not answer in time", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/lost/")) throw new DOMException("The operation timed out.", "TimeoutError");
      return new Response(null, { status: 200 });
    }));
    expect((await probeTileStates(BASE, ["lost", "found"], "1.7.0")).ready).toEqual(["found"]);
  });

  it("gives up on requests that have not answered by the deadline, and answers the rest", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
        if (!url.includes("/stalled/")) return Promise.resolve(new Response(null, { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }));
      const answer = probeTileStates(BASE, ["stalled", "quick"], "1.7.0").then((a) => a.ready);
      await vi.advanceTimersByTimeAsync(TILE_PROBE_DEADLINE_MS + 1);
      expect(await answer).toEqual(["quick"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`asks about at most ${TILE_PROBE_LIMIT} objects in one read`, async () => {
    const fetchMock = answeringFor([]);
    vi.stubGlobal("fetch", fetchMock);
    const many = Array.from({ length: TILE_PROBE_LIMIT + 5 }, (_, i) => `obj-${i}`);
    await probeTileStates(BASE, many, "1.7.0");
    expect(fetchMock).toHaveBeenCalledTimes(TILE_PROBE_LIMIT);
  });

  it("asks nothing of a site base that is not public https, or of an id the tiler refuses", async () => {
    const fetchMock = answeringFor([]);
    vi.stubGlobal("fetch", fetchMock);
    expect((await probeTileStates("http://example.org", ["map"], "1.7.0")).ready).toEqual([]);
    expect((await probeTileStates("https://127.0.0.1", ["map"], "1.7.0")).ready).toEqual([]);
    expect((await probeTileStates(null, ["map"], "1.7.0")).ready).toEqual([]);
    expect((await probeTileStates(BASE, ["../admin", "a b"], "1.7.0")).ready).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function tileProbeDoc(...specs: Array<{ id: string; ready?: boolean; source?: string }>) {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>("objects");
  for (const s of specs) {
    arr.push([
      makeObjectYMap({ objectId: s.id, imageAvailable: s.ready ?? false, sourceUrl: s.source ?? "", validationState: "valid", origin: "compositor", orderKey: "a" }),
    ]);
  }
  return { doc, arr };
}

describe("probeTileStates", () => {
  const info = (id: string) => `${BASE}/iiif/objects/${id}/info.json`;

  it("reports an object that answered 404 as not found, whether or not another answered 2xx", async () => {
    vi.stubGlobal("fetch", answeringFor([info("map")]));
    expect(await probeTileStates(BASE, ["map", "plan"], "1.7.0")).toEqual({ site: BASE, ready: ["map"], notFound: ["plan"] });
    vi.stubGlobal("fetch", answeringFor([]));
    expect(await probeTileStates(BASE, ["map", "plan"], "1.7.0")).toEqual({ site: BASE, ready: [], notFound: ["map", "plan"] });
  });

  it("leaves out an object that answered 5xx, timed out or failed, even when another answered 2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/boom/")) return new Response(null, { status: 500 });
      if (url.includes("/slow/")) throw new DOMException("The operation timed out.", "TimeoutError");
      if (url.includes("/down/")) throw new TypeError("fetch failed");
      return new Response(null, { status: 200 });
    }));
    expect(await probeTileStates(BASE, ["boom", "slow", "down", "map"], "1.7.0")).toEqual({ site: BASE, ready: ["map"], notFound: [] });
  });
});

describe("markTilesReady", () => {
  it("takes the objects reported missing off ready, and marks a later 2xx ready again", () => {
    const { doc, arr } = tileProbeDoc({ id: "map", ready: true }, { id: "plan", ready: true }, { id: "done", ready: true });
    markTilesReady(doc, ["map"], ["plan"]);
    expect(arr.toArray().map((m) => [m.get("object_id"), m.get("image_available")])).toEqual([
      ["map", true], ["plan", false], ["done", true],
    ]);
    markTilesReady(doc, ["plan"]);
    expect(arr.toArray().map((m) => m.get("image_available"))).toEqual([true, true, true]);
  });

  it("keeps the flag of an object that stopped being a self-hosted image while the probe was in flight", () => {
    const { doc, arr } = tileProbeDoc(
      { id: "plan", ready: true, source: "https://iiif.example/manifest.json" },
      { id: "song", ready: true, source: "song.mp3" },
      { id: "map", ready: true },
    );
    markTilesReady(doc, [], ["plan", "song", "map"]);
    expect(arr.toArray().map((m) => [m.get("object_id"), m.get("image_available")])).toEqual([
      ["plan", true], ["song", true], ["map", false],
    ]);
  });

  it("marks the objects that answered, and leaves every other as it was", () => {
    const { doc, arr } = tileProbeDoc({ id: "map" }, { id: "plan" }, { id: "done", ready: true });
    markTilesReady(doc, ["map"]);
    expect(arr.toArray().map((m) => [m.get("object_id"), m.get("image_available")])).toEqual([
      ["map", true], ["plan", false], ["done", true],
    ]);
  });

  it("writes nothing when no object answered", () => {
    const { doc } = tileProbeDoc({ id: "map" });
    const updates = vi.fn();
    doc.on("update", updates);
    markTilesReady(doc, []);
    markTilesReady(null, ["map"]);
    expect(updates).not.toHaveBeenCalled();
  });
});

describe("tileProbeCandidates", () => {
  it("asks about self-hosted images, those not yet ready first, and not about media or external sources", () => {
    expect(
      tileProbeCandidates([
        { object_id: "done", source_url: null, image_available: true },
        { object_id: "map", source_url: null, image_available: false },
        { object_id: "far", source_url: "https://iiif.example/manifest.json", image_available: false },
        { object_id: "song", source_url: "song.mp3", image_available: false },
        { object_id: "clip", source_url: "https://youtu.be/abc", image_available: false },
        { object_id: "", source_url: null, image_available: false },
      ]),
    ).toEqual(["map", "done"]);
  });
});

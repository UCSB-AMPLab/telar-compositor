// @vitest-environment jsdom
/**
 * The Objects page asks the site about each self-hosted image not yet ready
 * once per visit, and writes the objects whose tiles answered into the
 * document; an unreachable answer marks nothing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { makeObjectYMap } from "~/lib/object-ymap";

const fakeFetcher = { state: "idle" as string, data: undefined as unknown, submit: vi.fn() };
vi.mock("~/lib/page-site", () => ({ useSiteFetcher: () => fakeFetcher }));

import { useTileReadiness } from "~/hooks/use-tile-readiness";
import { TILE_PROBE_LIMIT, TILE_PROBE_RETRY_MS } from "~/lib/tile-readiness";

function tileHookDoc(...ids: string[]) {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>("objects");
  for (const id of ids) {
    arr.push([makeObjectYMap({ objectId: id, validationState: "valid", origin: "compositor", orderKey: "a" })]);
  }
  return { doc, arr };
}

const ROWS = [
  { object_id: "map", source_url: null, image_available: false },
  { object_id: "plan", source_url: null, image_available: false },
];

beforeEach(() => {
  fakeFetcher.state = "idle";
  fakeFetcher.data = undefined;
  fakeFetcher.submit.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The fetcher going through a submission and settling on `answer`. */
function settleTileProbe(rerender: () => void, answer: unknown) {
  fakeFetcher.state = "submitting";
  rerender();
  fakeFetcher.state = "idle";
  fakeFetcher.data = answer;
  rerender();
}

const askedIds = (call: number) => JSON.parse((fakeFetcher.submit.mock.calls[call][0] as { objectIds: string }).objectIds);


const SITE = "https://example.org/site";
describe("useTileReadiness", () => {
  it("asks once about the images not yet ready, and writes those that answered", () => {
    const { doc, arr } = tileHookDoc("map", "plan");
    const { rerender } = renderHook(() => useTileReadiness(doc, ROWS));
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(1);
    expect(fakeFetcher.submit.mock.calls[0][0]).toEqual({ intent: "probe-tiles", objectIds: JSON.stringify(["map", "plan"]) });

    fakeFetcher.state = "submitting";
    rerender();
    fakeFetcher.state = "idle";
    fakeFetcher.data = { ok: true, intent: "probe-tiles", site: SITE, ready: ["map"] };
    rerender();
    expect(arr.toArray().map((m) => m.get("image_available"))).toEqual([true, false]);
    // The revalidation the read causes renders again, and asks nothing yet.
    rerender();
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(1);
  });

  it("asks about a ready image after the unready ones, and takes it off ready on a not-found answer once the site has answered", () => {
    const { doc, arr } = tileHookDoc("done", "map");
    arr.toArray()[0].set("image_available", true);
    const rows = [
      { object_id: "done", source_url: null, image_available: true },
      { object_id: "map", source_url: null, image_available: false },
    ];
    const { rerender } = renderHook(() => useTileReadiness(doc, rows));
    expect(askedIds(0)).toEqual(["map", "done"]);
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: SITE, ready: ["map"], notFound: ["done"] });
    expect(arr.toArray().map((m) => m.get("image_available"))).toEqual([false, true]);
  });

  it("leaves a ready image as it is when the answer does not name it not found", () => {
    const { doc, arr } = tileHookDoc("done");
    arr.toArray()[0].set("image_available", true);
    const { rerender } = renderHook(() => useTileReadiness(doc, [{ object_id: "done", source_url: null, image_available: true }]));
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: SITE, ready: [], notFound: [] });
    expect(arr.toArray().map((m) => m.get("image_available"))).toEqual([true]);
  });

  it("marks nothing on an unreachable answer", () => {
    const { doc, arr } = tileHookDoc("map");
    const { rerender } = renderHook(() => useTileReadiness(doc, ROWS.slice(0, 1)));
    fakeFetcher.data = { ok: false, reason: "unreachable", intent: "probe-tiles" };
    rerender();
    expect(arr.toArray().map((m) => m.get("image_available"))).toEqual([false]);
  });

  it("asks nothing without a document", () => {
    renderHook(() => useTileReadiness(null, ROWS));
    expect(fakeFetcher.submit).not.toHaveBeenCalled();
  });

  it("asks again, after a wait, about an id the answer left out, and not about one it marked", () => {
    vi.useFakeTimers();
    const { doc } = tileHookDoc("map", "plan");
    const { rerender } = renderHook(() => useTileReadiness(doc, ROWS));
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: SITE, ready: ["map"] });
    rerender();
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(TILE_PROBE_RETRY_MS);
    });
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(2);
    expect(askedIds(1)).toEqual(["plan"]);
  });

  it("asks again, after a wait, about every id of an unreachable answer", () => {
    vi.useFakeTimers();
    const { doc } = tileHookDoc("map", "plan");
    const { rerender } = renderHook(() => useTileReadiness(doc, ROWS));
    settleTileProbe(rerender, { ok: false, reason: "unreachable", intent: "probe-tiles" });
    act(() => {
      vi.advanceTimersByTime(TILE_PROBE_RETRY_MS);
    });
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(2);
    expect(askedIds(1)).toEqual(["map", "plan"]);
  });

  it("asks about every id again for a new document", () => {
    const first = tileHookDoc("map", "plan").doc;
    const second = tileHookDoc("map", "plan").doc;
    const { rerender } = renderHook(({ doc }) => useTileReadiness(doc, ROWS), { initialProps: { doc: first } });
    fakeFetcher.state = "submitting";
    rerender({ doc: first });
    fakeFetcher.state = "idle";
    rerender({ doc: second });
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(2);
    expect(askedIds(1)).toEqual(["map", "plan"]);
  });

  it("asks again about the batch an answer left out, not the batch asked after it", () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: TILE_PROBE_LIMIT + 1 }, (_, i) => `obj-${i}`);
    const rows = ids.map((object_id) => ({ object_id, source_url: null, image_available: false }));
    const { doc } = tileHookDoc(...ids);
    const { rerender } = renderHook(() => useTileReadiness(doc, rows));
    expect(askedIds(0)).toEqual(ids.slice(0, TILE_PROBE_LIMIT));
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: SITE, ready: [] });
    expect(askedIds(1)).toEqual([ids[TILE_PROBE_LIMIT]]);

    act(() => {
      vi.advanceTimersByTime(TILE_PROBE_RETRY_MS);
    });
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(3);
    expect(askedIds(2)).toEqual(ids.slice(0, TILE_PROBE_LIMIT));
  });

  it("takes the 404s of an earlier read off ready once a later read has answered 2xx", () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: TILE_PROBE_LIMIT + 1 }, (_, i) => `obj-${i}`);
    const rows = ids.map((object_id) => ({ object_id, source_url: null, image_available: true }));
    const { doc, arr } = tileHookDoc(...ids);
    for (const m of arr.toArray()) m.set("image_available", true);
    const { rerender } = renderHook(() => useTileReadiness(doc, rows));
    const first = ids.slice(0, TILE_PROBE_LIMIT);
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: SITE, ready: [], notFound: first });
    expect(arr.toArray().every((m) => m.get("image_available") === true)).toBe(true);
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: SITE, ready: [ids[TILE_PROBE_LIMIT]], notFound: [] });

    act(() => {
      vi.advanceTimersByTime(TILE_PROBE_RETRY_MS);
    });
    expect(askedIds(2)).toEqual(first);
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: SITE, ready: [], notFound: first });
    expect(arr.toArray().map((m) => m.get("image_available"))).toEqual([...first.map(() => false), true]);
  });

  it("keeps the flag on a 404 from a site other than the one that answered 2xx", () => {
    const { doc, arr } = tileHookDoc("map", "plan");
    for (const m of arr.toArray()) m.set("image_available", true);
    const rows = ["map", "plan"].map((object_id) => ({ object_id, source_url: null, image_available: true }));
    const { rerender } = renderHook(() => useTileReadiness(doc, rows));
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: SITE, ready: ["map"], notFound: [] });
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: "https://example.org/moved", ready: [], notFound: ["plan"] });
    expect(arr.toArray().map((m) => m.get("image_available"))).toEqual([true, true]);
  });

  it("keeps the flag on a 404 when the site has answered 2xx for no object", () => {
    const { doc, arr } = tileHookDoc("done");
    arr.toArray()[0].set("image_available", true);
    const { rerender } = renderHook(() => useTileReadiness(doc, [{ object_id: "done", source_url: null, image_available: true }]));
    settleTileProbe(rerender, { ok: true, intent: "probe-tiles", site: SITE, ready: [], notFound: ["done"] });
    expect(arr.toArray().map((m) => m.get("image_available"))).toEqual([true]);
  });
});

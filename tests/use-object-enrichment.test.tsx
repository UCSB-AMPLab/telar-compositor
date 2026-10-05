// @vitest-environment jsdom
/**
 * The Objects page asks the collaboration server to fill its external objects
 * once per object and source while the document is open, only once the
 * document is the page's source, and again for an object whose source
 * changes.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import * as Y from "yjs";

const fakeFetcher = { state: "idle" as string, data: undefined as unknown, submit: vi.fn() };
vi.mock("~/lib/page-site", () => ({ useSiteFetcher: () => fakeFetcher }));

import { enrichmentKeys, useObjectEnrichment } from "~/hooks/use-object-enrichment";

type Row = { id: number; source_url: string | null; thumbnail: string | null };

const BELL: Row = { id: 5, source_url: "https://iiif.example/a", thumbnail: null };
const DRUM: Row = { id: 6, source_url: "https://iiif.example/d", thumbnail: null };

/** The fetcher going through a submission and settling. */
function settle(rerender: () => void) {
  fakeFetcher.state = "submitting";
  rerender();
  fakeFetcher.state = "idle";
  fakeFetcher.data = { ok: true, intent: "enrich-external" };
  rerender();
}

beforeEach(() => {
  fakeFetcher.state = "idle";
  fakeFetcher.data = undefined;
  fakeFetcher.submit.mockReset();
});

describe("enrichmentKeys", () => {
  it("names each object with a D1 id and an external source whose thumbnail is empty", () => {
    expect(enrichmentKeys([
      BELL,
      { id: 7, source_url: "https://iiif.example/t", thumbnail: "https://iiif.example/t.jpg" },
      { id: 8, source_url: null, thumbnail: null },
      { id: 0, source_url: "https://iiif.example/new", thumbnail: null },
    ])).toEqual(["5|https://iiif.example/a"]);
  });
});

describe("useObjectEnrichment", () => {
  it("does not ask before the document is the page's source", () => {
    renderHook(() => useObjectEnrichment(new Y.Doc(), false, [BELL]));
    expect(fakeFetcher.submit).not.toHaveBeenCalled();
  });

  it("asks once for a set of objects, and not again after the answer", () => {
    const doc = new Y.Doc();
    const { rerender } = renderHook(() => useObjectEnrichment(doc, true, [BELL, DRUM]));
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(1);
    expect(fakeFetcher.submit.mock.calls[0][0]).toEqual({ intent: "enrich-external" });

    settle(rerender);
    rerender();
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(1);
  });

  it("asks again for an object whose source changed", () => {
    const doc = new Y.Doc();
    let rows: Row[] = [BELL];
    const { rerender } = renderHook(() => useObjectEnrichment(doc, true, rows));
    settle(rerender);
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(1);

    rows = [{ ...BELL, source_url: "https://iiif.example/b" }];
    rerender();
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(2);
  });

  it("waits for a request in flight before asking about a new object", () => {
    const doc = new Y.Doc();
    let rows: Row[] = [BELL];
    const { rerender } = renderHook(() => useObjectEnrichment(doc, true, rows));
    fakeFetcher.state = "submitting";
    rows = [BELL, DRUM];
    rerender();
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(1);

    fakeFetcher.state = "idle";
    rerender();
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(2);
  });

  it("asks about a new document from the start", () => {
    let doc = new Y.Doc();
    const { rerender } = renderHook(() => useObjectEnrichment(doc, true, [BELL]));
    settle(rerender);
    doc = new Y.Doc();
    rerender();
    expect(fakeFetcher.submit).toHaveBeenCalledTimes(2);
  });
});

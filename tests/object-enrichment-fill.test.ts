/**
 * The server's fill of an external object (`fillFromManifests`) against a
 * plain document: only empty fields are filled, an object naming another
 * source is skipped, and a prose field held as an empty `Y.Text` is inserted
 * into, so a keystroke made into it before the fill arrives is merged with the
 * filled text rather than lost with a replaced type.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { enrichmentCandidates, fillFromManifests, readManifests, type ReadManifest } from "../workers/object-enrichment";
import type { IiifMetadata } from "~/lib/iiif-types";

const SOURCE = "https://iiif.example/manifest";

const METADATA: IiifMetadata = {
  title: "Bell", creator: "Maker", description: null, thumbnail: "https://iiif.example/t.jpg",
  source: null, credit: null, period: null, object_type: null, image_available: true,
};

function docWith(fields: Record<string, unknown>): Y.Doc {
  const doc = new Y.Doc();
  const entry = new Y.Map<unknown>();
  doc.getArray<Y.Map<unknown>>("objects").push([entry]);
  for (const [k, v] of Object.entries({ _id: 5, source_url: SOURCE, ...fields })) entry.set(k, v);
  return doc;
}

const manifest = (sourceUrl = SOURCE): ReadManifest[] => [{ id: 5, sourceUrl, metadata: METADATA }];
const entryOf = (doc: Y.Doc) => doc.getArray<Y.Map<unknown>>("objects").get(0);
const text = (doc: Y.Doc, key: string) => String(entryOf(doc).get(key) ?? "");

describe("enrichmentCandidates", () => {
  it("chooses objects with an id and a source whose thumbnail is empty", () => {
    expect(enrichmentCandidates(docWith({ thumbnail: "" }))).toEqual([{ id: 5, sourceUrl: SOURCE }]);
    expect(enrichmentCandidates(docWith({ thumbnail: "https://own/t.jpg" }))).toEqual([]);
    expect(enrichmentCandidates(docWith({ _id: null }))).toEqual([]);
    expect(enrichmentCandidates(docWith({ source_url: "" }))).toEqual([]);
  });
});

describe("fillFromManifests", () => {
  it("fills empty fields, keeps held ones, and marks the image available", () => {
    const doc = docWith({ title: new Y.Text("Mine"), creator: new Y.Text(""), image_available: false });

    const filled = fillFromManifests(doc, manifest());

    expect(filled.map((f) => [f.id, f.fields])).toEqual([[5, ["creator"]]]);
    expect(text(doc, "title")).toBe("Mine");
    expect(text(doc, "creator")).toBe("Maker");
    expect(entryOf(doc).get("thumbnail")).toBe("https://iiif.example/t.jpg");
    expect(entryOf(doc).get("image_available")).toBe(true);
  });

  it("writes nothing to an object whose source is not the one read", () => {
    const doc = docWith({ source_url: "https://iiif.example/other" });
    const updates = vi.fn();
    doc.on("update", updates);

    expect(fillFromManifests(doc, manifest())).toEqual([]);
    expect(updates).not.toHaveBeenCalled();
  });

  it("keeps a keystroke made into the empty title before the fill arrived, next to the manifest's text", () => {
    const server = docWith({ title: new Y.Text("") });
    const author = new Y.Doc();
    Y.applyUpdate(author, Y.encodeStateAsUpdate(server));
    (entryOf(author).get("title") as Y.Text).insert(0, "X");

    fillFromManifests(server, manifest());
    Y.applyUpdate(server, Y.encodeStateAsUpdate(author));

    const title = text(server, "title");
    expect(title).toContain("X");
    expect(title).toContain("Bell");
  });
});

describe("readManifests", () => {
  it("keeps the reads that answered a manifest and leaves out the rest", async () => {
    const fetchManifest = vi.fn(async (url: string, _signal?: AbortSignal) =>
      url === SOURCE ? { ok: true as const, metadata: METADATA } : { ok: false as const, error: "fetch_failed" as const });

    const read = await readManifests([{ id: 5, sourceUrl: SOURCE }, { id: 6, sourceUrl: "https://iiif.example/gone" }], fetchManifest);

    expect(read).toEqual([{ id: 5, sourceUrl: SOURCE, metadata: METADATA }]);
    expect(fetchManifest.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });
});

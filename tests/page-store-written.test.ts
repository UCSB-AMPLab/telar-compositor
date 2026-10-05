/**
 * The `pages.storeWrittenFrontmatter` arm (`workers/page-store-written.ts`)
 * over a `Y.Doc`, and its domain at the `/ingest-sync` boundary
 * (`workers/ingest-domains.ts`).
 *
 * The arm stores the block a landed publish wrote only on a page still
 * holding the block the publish read; the boundary refuses any entry holding
 * a field beside its row id, its `expected` and its `frontmatter`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import { applyWrittenFrontmatterStores } from "../workers/page-store-written";
import { partitionIngestArm, type IngestDiagnostic } from "../workers/ingest-domains";

/** A block the publish cannot read as a mapping: an unclosed flow sequence. */
const UNREADABLE = "\ntitle: [About\n";
/** The block the publish writes in its place. */
const WRITTEN = '\ntitle: "About"\n';

function storeDoc(pages: Array<{ id: number; frontmatter?: string | null }>) {
  const doc = new Y.Doc();
  const array = doc.getArray<Y.Map<unknown>>("pages");
  for (const { id, frontmatter } of pages) {
    const map = new Y.Map<unknown>();
    map.set("_id", id);
    if (frontmatter !== undefined) map.set("frontmatter", frontmatter);
    array.push([map]);
  }
  return { doc, array };
}

const mapBlock = (array: Y.Array<Y.Map<unknown>>, id: number) =>
  array.toArray().find((m) => m.get("_id") === id)?.get("frontmatter");

const storeEntry = (pageId: number) => ({ pageId, expected: UNREADABLE, frontmatter: WRITTEN });

describe("storing the block a publish wrote", () => {
  it("stores it on a page still holding the block the publish read", () => {
    const { doc, array } = storeDoc([{ id: 1, frontmatter: UNREADABLE }]);
    doc.transact(() => {
      expect(applyWrittenFrontmatterStores(array, [storeEntry(1)])).toEqual([1]);
    });
    expect(mapBlock(array, 1)).toBe(WRITTEN);
  });

  it("leaves a page holding another block, null, no block, or absent from the document", () => {
    const edited = "\ntitle: About\nlanguage: en\n";
    const { doc, array } = storeDoc([{ id: 1, frontmatter: edited }, { id: 2, frontmatter: null }, { id: 3 }]);
    doc.transact(() => {
      expect(applyWrittenFrontmatterStores(array, [storeEntry(1), storeEntry(2), storeEntry(3), storeEntry(4)])).toEqual([]);
    });
    expect(mapBlock(array, 1)).toBe(edited);
    expect(mapBlock(array, 2)).toBeNull();
    expect(mapBlock(array, 3)).toBeUndefined();
  });

  it("reports a second delivery as stored and writes nothing", () => {
    const { doc, array } = storeDoc([{ id: 1, frontmatter: UNREADABLE }]);
    doc.transact(() => applyWrittenFrontmatterStores(array, [storeEntry(1)]));
    let transactions = 0;
    doc.on("update", () => { transactions += 1; });
    doc.transact(() => {
      expect(applyWrittenFrontmatterStores(array, [storeEntry(1)])).toEqual([1]);
    });
    expect(transactions).toBe(0);
    expect(mapBlock(array, 1)).toBe(WRITTEN);
  });
});

describe("the arm at the ingest boundary", () => {
  function partition(entries: unknown[]) {
    const diagnostics: IngestDiagnostic[] = [];
    const result = partitionIngestArm(entries as never[], "pageStoreWrittenFrontmatter", (e: { pageId: unknown }) => e.pageId, diagnostics);
    return { ...result, diagnostics };
  }

  it("accepts an entry of a row id, an expected block and a written block", () => {
    expect(partition([storeEntry(1)]).accepted).toEqual([storeEntry(1)]);
  });

  it("refuses an entry holding any other field, without naming it", () => {
    const { accepted, refused, diagnostics } = partition([{ ...storeEntry(1), title: "Renamed" }]);
    expect(accepted).toEqual([]);
    expect(refused).toEqual([0]);
    expect(diagnostics).toEqual([{ arm: "pageStoreWrittenFrontmatter", position: 0, field: "unlisted", found: "string" }]);
  });

  it("refuses an entry whose row id is not one, or whose blocks are not strings", () => {
    const { refused } = partition([
      { ...storeEntry(1), pageId: "1" },
      { ...storeEntry(2), expected: null },
      { pageId: 3, expected: UNREADABLE },
    ]);
    expect(refused).toEqual([0, 1, 2]);
  });
});

/**
 * The `pages.storeWrittenFrontmatter` arm of `/ingest-sync`: the block a
 * publish wrote for a page whose stored block cannot be read, stored on that
 * page once the publish has landed.
 *
 * A stored block that does not read as a mapping is published with its title
 * alone (`writePageFrontmatter`'s `title-alone`). Until the Compositor holds
 * the block it wrote, the Pages screen judges a block the site does not
 * have. The publish sends each such page's stored block as `expected`
 * and the written block as `frontmatter`; the arm stores it only on a map
 * still holding `expected`, so an edit made to the page's settings after the
 * publish read them is never overwritten. A map already holding the written
 * block reports as stored without a write, so a second delivery changes
 * nothing.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

import { pageById } from "./page-capture";

/** One page's written block, by its D1 row id, with the block the publish read. */
export interface IngestPageStoreWritten {
  pageId: number;
  expected: string;
  frontmatter: string;
}

/** Whether the page now holds the written block, storing it where the map holds `expected`. */
function storeOne(pagesArray: Y.Array<Y.Map<unknown>>, entry: IngestPageStoreWritten): boolean {
  const page = pageById(pagesArray, entry.pageId);
  const held = page?.get("frontmatter");
  if (held === entry.frontmatter) return true;
  if (!page || held !== entry.expected) return false;
  page.set("frontmatter", entry.frontmatter);
  return true;
}

/**
 * Store each written block where its page still holds the block the publish
 * read. Must run inside the ingest's transaction. Returns the row ids that
 * hold the written block afterwards; a page holding another block, null, or
 * absent from the document is left out, and keeps reading as it did.
 */
export function applyWrittenFrontmatterStores(
  pagesArray: Y.Array<Y.Map<unknown>>,
  entries: readonly IngestPageStoreWritten[],
): number[] {
  return entries.filter((entry) => storeOne(pagesArray, entry)).map((entry) => entry.pageId);
}

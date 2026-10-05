/**
 * The `pages.captureFrontmatter` arm of `/ingest-sync`: a page's front matter,
 * read from its file by the Pages loader, stored on a page whose block was
 * never read.
 *
 * A page imported before its block was stored holds null. The loader reads
 * the file and sends the block here. It is written only onto a map whose `frontmatter` is still null
 * or absent, so a capture never replaces an edit or an earlier capture, and a
 * second delivery of the same capture changes nothing.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

/** One page's block, by its D1 row id. */
export interface IngestPageCapture {
  pageId: number;
  frontmatter: string;
}

/** The page map holding a D1 row id, or null. */
export function pageById(pagesArray: Y.Array<Y.Map<unknown>>, pageId: number): Y.Map<unknown> | null {
  for (const member of pagesArray) {
    if (member instanceof Y.Map && member.get("_id") === pageId) return member;
  }
  return null;
}

/**
 * Store each capture on its page when the page's block is still unread.
 * Must run inside the ingest's transaction. Returns the row ids written and
 * the row ids left alone: absent from the document, or already holding a
 * block. The ingest answers with the written ones, and only their snapshot
 * entries are brought up to the capture (`movePublishSnapshotPastCaptures`):
 * a page whose block another write stored first may hold an edit the last
 * publish never saw.
 */
export function applyFrontmatterCaptures(
  pagesArray: Y.Array<Y.Map<unknown>>,
  captures: readonly IngestPageCapture[],
): { applied: number[]; skipped: number[] } {
  const applied: number[] = [];
  const skipped: number[] = [];
  for (const { pageId, frontmatter } of captures) {
    const page = pageById(pagesArray, pageId);
    const held = page?.get("frontmatter");
    if (!page || (held !== null && held !== undefined)) {
      skipped.push(pageId);
      continue;
    }
    page.set("frontmatter", frontmatter);
    applied.push(pageId);
  }
  return { applied, skipped };
}

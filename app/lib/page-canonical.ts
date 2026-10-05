/**
 * The raw canonical form of a page's content, and its hash.
 *
 * A page's raw form is its live `{ title, body, frontmatter }` as D1's row or
 * the collaboration object's map holds it, with none of the publisher's
 * transformations. Its hash is the `expected` value the collaboration object
 * checks the page's live map against before an accept, so an edit made after
 * the check, or not yet snapshotted to D1 when it ran, refuses the accept.
 *
 * The compare form, which answers whether the Compositor's version of a page
 * file differs from GitHub's, renders through the publisher and lives on the
 * server, in `page-content.server.ts`.
 *
 * Imported by the Worker and the server alike: nothing here may depend on
 * either environment, so it uses only the Web Crypto digest both provide.
 *
 * @version v1.5.0-beta
 */

import { sha256Hex } from "~/lib/story-canonical";

/** A page's content as D1's row or the collaboration object's map holds it. */
export interface PageContent {
  title: string;
  body: string | null;
  /** The block between the fences; `""` for a file with none; null for a page never captured. */
  frontmatter: string | null;
}

/**
 * The hash of a page's raw content: the three fields by position, so where
 * one ends and the next begins is part of the input, and null (a block never
 * captured) apart from `""` (a file with none). Line endings are hashed as
 * held.
 */
export function pageRawHash(page: PageContent): Promise<string> {
  return sha256Hex(JSON.stringify([page.title, page.body, page.frontmatter]));
}

/**
 * A D1 row's content as the collaboration object's map holds it once loaded:
 * the map's title and body are `Y.Text`, built from the row's value or `""`
 * when it is NULL, and its `frontmatter` is the row's own. Hashed on both
 * sides of an accept, the row at check time and the map inside the gate, so
 * a row nobody has edited hashes as its map does.
 */
export function pageContentAsLoaded(row: {
  title: string | null;
  body: string | null;
  frontmatter: string | null;
}): PageContent {
  return { title: row.title ?? "", body: row.body ?? "", frontmatter: row.frontmatter };
}

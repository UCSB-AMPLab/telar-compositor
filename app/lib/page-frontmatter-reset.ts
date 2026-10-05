/**
 * Keeping only a page's title, in a document.
 *
 * The publish page offers this beside the blocker for a page whose kept front
 * matter no edit can retitle without changing another key. It sets the page's
 * `frontmatter` to `""`, the value of a page with no kept block, which the
 * publish writes with its title alone. The collaboration object runs it on its
 * own document (`/reset-page-frontmatter`), so the change reaches D1 in the
 * snapshot it takes straight after, and the peers receive it as any other
 * edit.
 *
 * Dependency-free apart from yjs and the value-domain readers, because the
 * Durable Object imports it.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { entityMaps } from "~/lib/value-domains";

/**
 * Sets `frontmatter` to `""` on every page whose slug is `slug`, in one
 * transaction. Returns the number of pages changed; a page already holding
 * `""` is not written, so a repeated reset writes nothing.
 */
export function resetPageFrontmatter(ydoc: Y.Doc, slug: string): number {
  let changed = 0;
  ydoc.transact(() => {
    for (const page of entityMaps(ydoc.getArray("pages")).maps) {
      if (page.get("slug") !== slug || page.get("frontmatter") === "") continue;
      page.set("frontmatter", "");
      changed += 1;
    }
  });
  return changed;
}

/**
 * The Pages screen's write to the menu when a page is deleted.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

/** Remove the menu entry naming each slug, in one transaction. */
export function removeNavEntries(ydoc: Y.Doc, slugs: readonly string[]): void {
  const navArray = ydoc.getMap("config").get("navigation") as unknown;
  if (!(navArray instanceof Y.Array) || slugs.length === 0) return;
  ydoc.transact(() => {
    for (const slug of slugs) {
      for (let i = 0; i < navArray.length; i++) {
        const item = navArray.get(i) as Record<string, unknown>;
        if (item.type === "page" && item.slug === slug) {
          navArray.delete(i, 1);
          break;
        }
      }
    }
  });
}

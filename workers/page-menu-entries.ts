/**
 * The menu entries `/ingest-sync`'s page arms write: `config.navigation`, the
 * `Y.Array` of plain entries the publish writes `_data/navigation.yml` from.
 *
 * A page entry names its page by slug alone, so an arm that removes or
 * renames a page changes the entries naming it in the same transaction:
 * otherwise the publish writes a link to a page that has gone. An entry is
 * replaced whole (delete and insert at its index), as the Pages screen's slug
 * field and `reconcileNavPageSlugs` replace one, and every other field it
 * carries, the label included, is kept.
 *
 * A page taken from GitHub may carry the entry GitHub's menu gives it
 * (`IngestPageMenuEntry`). It is placed directly after the entry it names
 * when the saved menu, as it stood before the ingest (`savedMenuItems`),
 * holds that entry, or at the end when it does not or the page names none;
 * an entry another insert of the same ingest added is not saved, so the
 * placement does not depend on the order of the inserts. It is added only
 * when no entry names the page's slug at that moment.
 *
 * Each function does nothing when the document holds no navigation array.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

/** A saved menu entry, as GitHub's menu names the item before an added page. */
export type IngestMenuAnchor =
  | { type: "page"; slug: string }
  | { type: "builtin"; key: string }
  | { type: "external"; url: string };

/** The menu entry a page taken from GitHub carries: its label and the entry it follows. */
export interface IngestPageMenuEntry {
  label: string;
  after: IngestMenuAnchor | null;
}

type MenuItem = Record<string, unknown>;

function menuItemAt(navigation: Y.Array<unknown>, index: number): MenuItem | null {
  const item = navigation.get(index);
  return item !== null && typeof item === "object" && !(item instanceof Y.Map) ? (item as MenuItem) : null;
}

function namesPage(item: MenuItem | null, slug: string): boolean {
  return item !== null && item.type === "page" && item.slug === slug;
}

/** Whether `item` is the saved entry `anchor` names. */
function isAnchor(item: MenuItem | null, anchor: IngestMenuAnchor): boolean {
  if (item === null || item.type !== anchor.type) return false;
  if (anchor.type === "page") return item.slug === anchor.slug;
  if (anchor.type === "builtin") return item.key === anchor.key;
  return item.url === anchor.url;
}

/** The menu's entries as they stand, read before the ingest's inserts change it. */
export function savedMenuItems(navigation: unknown): Array<MenuItem | null> {
  if (!(navigation instanceof Y.Array)) return [];
  return Array.from({ length: navigation.length }, (_, i) => menuItemAt(navigation, i));
}

/** Remove every entry naming `slug`. Inside the caller's transaction. */
export function dropPageMenuEntries(navigation: unknown, slug: string): void {
  if (!(navigation instanceof Y.Array)) return;
  for (let i = navigation.length - 1; i >= 0; i--) {
    if (namesPage(menuItemAt(navigation, i), slug)) navigation.delete(i, 1);
  }
}

/** Point every entry naming `from` at `to`, keeping its other fields. Inside the caller's transaction. */
export function repointPageMenuEntries(navigation: unknown, from: string, to: string): void {
  if (!(navigation instanceof Y.Array)) return;
  for (let i = 0; i < navigation.length; i++) {
    const item = menuItemAt(navigation, i);
    if (!namesPage(item, from)) continue;
    navigation.delete(i, 1);
    navigation.insert(i, [{ ...item, slug: to }]);
  }
}

/**
 * Add the entry `menu` describes for the page at `slug`, visible, unless an
 * entry already names the slug or there is no entry to add; its anchor
 * counts only when `saved` holds it. Inside the caller's transaction.
 */
export function placeInsertedPageMenuEntry(
  navigation: unknown,
  saved: ReadonlyArray<MenuItem | null>,
  slug: string,
  menu: IngestPageMenuEntry | undefined,
): void {
  if (!(navigation instanceof Y.Array) || menu === undefined) return;
  const items = savedMenuItems(navigation);
  if (items.some((item) => namesPage(item, slug))) return;
  const { after } = menu;
  const anchored = after !== null && saved.some((item) => isAnchor(item, after));
  const anchorAt = anchored ? items.findIndex((item) => isAnchor(item, after)) : -1;
  const entry = { type: "page", slug, label: menu.label, visible: true };
  if (anchorAt < 0) navigation.push([entry]);
  else navigation.insert(anchorAt + 1, [entry]);
}

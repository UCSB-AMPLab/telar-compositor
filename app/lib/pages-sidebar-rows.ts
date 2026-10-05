/**
 * The Pages screen's sidebar rows, built from the page records and ordered by
 * the menu.
 *
 * One row per page entry in the menu. A titled page's row is sortable,
 * because dragging it reorders the menu; an untitled page's row is listed but
 * is never a reorder target.
 *
 * @version v1.5.0-beta
 */

import type { PagesSidebarRow } from "~/components/features/pages/PagesSidebar";
import { keyFor, type YjsItemLike } from "~/lib/item-key";

export interface SidebarPage extends YjsItemLike {
  slug: string;
  title: string;
}

export interface SidebarNavItem {
  type: string;
  slug?: string;
  _tempId?: string;
}

export interface SidebarInputs<P extends SidebarPage, I extends SidebarNavItem> {
  /** The menu as the sidebar lists it: saved entries, then pages merged in. */
  items: readonly I[];
  pages: readonly P[];
  /** The dnd-kit id of the entry at a position. */
  sortableId: (item: I, index: number) => string;
  /** Whether this member may delete the page. */
  canDelete: (page: P) => boolean;
}

export interface SidebarRows {
  /** Menu entries, sortable, in menu order. */
  contentRows: PagesSidebarRow[];
  /** Pages with no title yet. */
  untitledRows: PagesSidebarRow[];
  /** Each sortable row's position in the full menu. */
  sidebarIdToFullIdx: Map<string, number>;
}

/** The sidebar's rows; see the module comment. */
export function buildSidebarRows<P extends SidebarPage, I extends SidebarNavItem>(inputs: SidebarInputs<P, I>): SidebarRows {
  const rows: SidebarRows = { contentRows: [], untitledRows: [], sidebarIdToFullIdx: new Map() };
  inputs.items.forEach((item, index) => {
    if (item.type !== "page") return;
    const page = item.slug
      ? inputs.pages.find((p) => p.slug === item.slug)
      : item._tempId ? inputs.pages.find((p) => p._tempId === item._tempId) : undefined;
    if (!page) return;
    const sortableId = inputs.sortableId(item, index);
    const row = { selectKey: keyFor(page), sortableId, label: page.title.trim(), canDelete: inputs.canDelete(page) };
    if (!row.label) {
      rows.untitledRows.push({ ...row, label: page.title, isUntitled: true });
      return;
    }
    rows.sidebarIdToFullIdx.set(sortableId, index);
    rows.contentRows.push({ ...row, isUntitled: false });
  });
  return rows;
}

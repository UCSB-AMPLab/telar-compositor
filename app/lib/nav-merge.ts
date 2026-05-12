/**
 * This file holds the helper that merges the project's persisted
 * navigation items (from Yjs `config.navigation`) with the in-memory
 * page list, so that newly-created pages always have a clickable nav
 * tab — even before they receive a slug.
 *
 * Why: the previous all-or-nothing fallback (`navItems.length > 0 ?
 * navItems : defaultNavItems`) ignored `displayPages` whenever the
 * project already had any nav items (i.e. always — Home/Objects/Glossary
 * are seeded). New pages only get pushed into navArray once their title
 * is non-empty (see the deferred-slug effect in `_app.pages.tsx`), so
 * an untitled fresh page lived in `pagesArray` with no nav tab to
 * click. Users couldn't navigate to it.
 *
 * Strategy: keep the existing nav order (so user reorderings persist),
 * then append any `displayPages` entry whose slug isn't already
 * represented. Untitled pages (no slug yet) are appended with a
 * synthetic `_tempId` field — this lets the renderer key by `_tempId`
 * until the user types a title and the slug auto-generates, at which
 * point the persisted nav entry takes over and the synthetic one drops
 * out (its slug is now in `navPageSlugs`).
 *
 * The `_tempId` field is render-only — it is never written back to the
 * Yjs navArray.
 *
 * @version v1.2.0-beta
 */

export interface NavItem {
  type: "page" | "builtin" | "external";
  key?: string;
  slug?: string;
  label: string;
  visible: boolean;
  /** Render-only marker for unsaved pages with no slug yet. Never persisted. */
  _tempId?: string;
  url?: string;
}

export interface PageLike {
  slug: string;
  title: string;
  _tempId?: string | null;
}

export function mergeNavItemsWithPages(
  navItems: NavItem[],
  displayPages: PageLike[],
  options: { untitledLabel?: string } = {},
): NavItem[] {
  const untitledLabel = options.untitledLabel ?? "Untitled";

  const navPageSlugs = new Set<string>();
  for (const item of navItems) {
    if (item.type === "page" && item.slug) navPageSlugs.add(item.slug);
  }

  const missing: NavItem[] = [];
  for (const page of displayPages) {
    if (page.slug) {
      if (!navPageSlugs.has(page.slug)) {
        missing.push({
          type: "page",
          slug: page.slug,
          label: page.title || page.slug,
          visible: true,
        });
      }
    } else if (page._tempId) {
      missing.push({
        type: "page",
        label: page.title || untitledLabel,
        visible: true,
        _tempId: page._tempId,
      });
    }
  }

  return missing.length > 0 ? [...navItems, ...missing] : navItems;
}

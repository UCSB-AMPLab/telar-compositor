/**
 * This file covers the merge between persisted nav items and the
 * pages array — closing the earlier carry-over where newly-created pages
 * had no nav tab to click.
 *
 * The bug: `effectiveNavItems = navItems.length > 0 ? navItems : defaultNavItems`
 * in `_app.pages.tsx` ignored `displayPages` whenever the project had any nav
 * items at all (i.e. always — Home/Objects/Glossary are seeded). New pages only
 * get pushed into the navArray once their title is non-empty, so an untitled
 * fresh page existed in `pagesArray` but had no clickable tab.
 *
 * The fix: `mergeNavItemsWithPages` keeps the persisted nav order, then
 * appends any displayPages whose slug isn't already represented. Untitled
 * pages get a synthetic entry keyed by `_tempId` so the user can still focus
 * them while typing the title.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect } from "vitest";
import { mergeNavItemsWithPages, type NavItem, type PageLike } from "~/lib/nav-merge";

const builtins: NavItem[] = [
  { type: "builtin", key: "home", label: "Home", visible: true },
  { type: "builtin", key: "collection", label: "Objects", visible: true },
  { type: "builtin", key: "glossary", label: "Glossary", visible: true },
];

describe("mergeNavItemsWithPages", () => {
  it("returns navItems unchanged when displayPages is empty", () => {
    const result = mergeNavItemsWithPages(builtins, []);
    expect(result).toEqual(builtins);
  });

  it("returns navItems unchanged when every page already has a matching nav entry", () => {
    const navItems: NavItem[] = [
      ...builtins,
      { type: "page", slug: "about", label: "About", visible: true },
    ];
    const pages: PageLike[] = [{ slug: "about", title: "About" }];
    const result = mergeNavItemsWithPages(navItems, pages);
    expect(result).toEqual(navItems);
    // Reference equality short-circuit (no allocation when nothing to merge).
    expect(result).toBe(navItems);
  });

  it("appends a page nav entry for a titled page missing from navItems", () => {
    const pages: PageLike[] = [
      { slug: "about", title: "About", _tempId: null },
    ];
    const result = mergeNavItemsWithPages(builtins, pages);
    expect(result).toEqual([
      ...builtins,
      { type: "page", slug: "about", label: "About", visible: true },
    ]);
  });

  it("preserves the navItems order when appending missing pages", () => {
    // User has reordered: [Glossary, Home, Objects] then created About.
    const reordered: NavItem[] = [
      { type: "builtin", key: "glossary", label: "Glossary", visible: true },
      { type: "builtin", key: "home", label: "Home", visible: true },
      { type: "builtin", key: "collection", label: "Objects", visible: true },
    ];
    const pages: PageLike[] = [{ slug: "about", title: "About" }];
    const result = mergeNavItemsWithPages(reordered, pages);
    expect(result.map((i) => (i.type === "builtin" ? i.key : i.slug))).toEqual([
      "glossary",
      "home",
      "collection",
      "about",
    ]);
  });

  it("appends untitled pages keyed by _tempId so they get a clickable tab", () => {
    const pages: PageLike[] = [
      { slug: "", title: "", _tempId: "uuid-new-page" },
    ];
    const result = mergeNavItemsWithPages(builtins, pages, {
      untitledLabel: "Untitled",
    });
    expect(result).toHaveLength(builtins.length + 1);
    const synthetic = result[result.length - 1];
    expect(synthetic).toEqual({
      type: "page",
      label: "Untitled",
      visible: true,
      _tempId: "uuid-new-page",
    });
    expect(synthetic.slug).toBeUndefined();
  });

  it("uses the page title (not the placeholder) when an untitled page has been partially typed", () => {
    // Slug auto-generation hasn't fired yet but the user has typed a title.
    const pages: PageLike[] = [
      { slug: "", title: "My new page", _tempId: "uuid-1" },
    ];
    const result = mergeNavItemsWithPages(builtins, pages);
    expect(result[result.length - 1]).toMatchObject({
      type: "page",
      label: "My new page",
      _tempId: "uuid-1",
    });
  });

  it("merges a mix of titled-already-in-nav, titled-missing, and untitled pages", () => {
    // Real-world: project with About in nav, plus a freshly-published Bio
    // (slug exists, not yet in navArray), plus an untitled in-progress page.
    const navItems: NavItem[] = [
      ...builtins,
      { type: "page", slug: "about", label: "About", visible: true },
    ];
    const pages: PageLike[] = [
      { slug: "about", title: "About" },
      { slug: "bio", title: "Bio" },
      { slug: "", title: "", _tempId: "uuid-wip" },
    ];
    const result = mergeNavItemsWithPages(navItems, pages, {
      untitledLabel: "Untitled",
    });
    expect(result).toHaveLength(navItems.length + 2);
    expect(result[navItems.length]).toEqual({
      type: "page",
      slug: "bio",
      label: "Bio",
      visible: true,
    });
    expect(result[navItems.length + 1]).toEqual({
      type: "page",
      label: "Untitled",
      visible: true,
      _tempId: "uuid-wip",
    });
  });

  it("does not append untitled pages that lack a _tempId (defensive)", () => {
    // Should never happen in practice — every Yjs-created page gets a _temp_id —
    // but guards against producing a nav entry with no stable identifier.
    const pages: PageLike[] = [{ slug: "", title: "Stranded", _tempId: null }];
    const result = mergeNavItemsWithPages(builtins, pages);
    expect(result).toEqual(builtins);
  });

  it("once a synthetic untitled page receives its slug+nav entry, the synthetic drops out", () => {
    // First render: untitled page with _tempId only.
    const navBefore: NavItem[] = [...builtins];
    const pageBefore: PageLike[] = [
      { slug: "", title: "", _tempId: "uuid-A" },
    ];
    const before = mergeNavItemsWithPages(navBefore, pageBefore);
    expect(before).toHaveLength(builtins.length + 1);
    expect(before[before.length - 1]._tempId).toBe("uuid-A");

    // After typing a title: slug auto-generates, navArray gets pushed,
    // displayPages now reports the slug. Merge should produce a single entry,
    // not the synthetic + the persisted one.
    const navAfter: NavItem[] = [
      ...builtins,
      { type: "page", slug: "my-page", label: "My page", visible: true },
    ];
    const pageAfter: PageLike[] = [
      { slug: "my-page", title: "My page", _tempId: "uuid-A" },
    ];
    const after = mergeNavItemsWithPages(navAfter, pageAfter);
    expect(after).toHaveLength(builtins.length + 1);
    const lastEntry = after[after.length - 1];
    expect(lastEntry.slug).toBe("my-page");
    expect(lastEntry._tempId).toBeUndefined();
  });

  it("falls back to slug as label when page title is empty but slug exists", () => {
    const pages: PageLike[] = [{ slug: "my-page", title: "" }];
    const result = mergeNavItemsWithPages(builtins, pages);
    expect(result[result.length - 1]).toEqual({
      type: "page",
      slug: "my-page",
      label: "my-page",
      visible: true,
    });
  });

  it("uses default 'Untitled' label when no untitledLabel option is provided", () => {
    const pages: PageLike[] = [{ slug: "", title: "", _tempId: "uuid-1" }];
    const result = mergeNavItemsWithPages(builtins, pages);
    expect(result[result.length - 1].label).toBe("Untitled");
  });
});

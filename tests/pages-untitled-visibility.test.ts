/**
 * Untitled-page visibility contract — surface untitled pages in the sidebar.
 * Untitled pages (empty `title`) appear ONLY in the editing sidebar (labelled
 * "Untitled — needs a title", with a delete affordance) and are EXCLUDED from
 * the nav simulator until titled (they can't be published, so they must not
 * preview in the live menu).
 *
 * Builds on the mergeNavItemsWithPages synthetic `_tempId` shape. These facts
 * pin the merge shape that both derivations build on; the sidebar-list and
 * effectiveNavItems derivations live in the route.
 */

import { describe, it, expect } from "vitest";
import { mergeNavItemsWithPages, type NavItem, type PageLike } from "~/lib/nav-merge";

const builtins: NavItem[] = [
  { type: "builtin", key: "home", label: "Home", visible: true },
  { type: "builtin", key: "collection", label: "Objects", visible: true },
  { type: "builtin", key: "glossary", label: "Glossary", visible: true },
];

describe("untitled page merge shape (foundation for sidebar/nav-sim split)", () => {
  it("an untitled page (empty title) gets a synthetic _tempId nav entry, NOT a slug entry", () => {
    const pages: PageLike[] = [{ slug: "", title: "", _tempId: "uuid-untitled" }];
    const result = mergeNavItemsWithPages(builtins, pages, { untitledLabel: "Untitled" });

    const synthetic = result[result.length - 1];
    expect(synthetic).toEqual({
      type: "page",
      label: "Untitled",
      visible: true,
      _tempId: "uuid-untitled",
    });
    // A synthetic untitled entry has no slug — this is what distinguishes it
    // from a publishable page and is the hook the nav-sim exclusion keys on.
    expect(synthetic.slug).toBeUndefined();
  });

  it("a titled page produces a slug-bearing entry (publishable → eligible for the nav simulator)", () => {
    const pages: PageLike[] = [
      { slug: "about", title: "About", _tempId: "uuid-about" },
      { slug: "", title: "", _tempId: "uuid-wip" },
    ];
    const result = mergeNavItemsWithPages(builtins, pages, { untitledLabel: "Untitled" });

    const aboutEntry = result.find((e) => e.type === "page" && e.slug === "about");
    expect(aboutEntry).toBeDefined();
    expect(aboutEntry?._tempId).toBeUndefined();

    // The merged list carries BOTH the titled (slug) and untitled (_tempId)
    // entries — the per-surface filtering is what splits them.
    const untitledEntry = result.find((e) => e.type === "page" && e._tempId === "uuid-wip");
    expect(untitledEntry?.slug).toBeUndefined();
  });

  it("the slug-vs-_tempId distinction is a clean predicate for the two derivations", () => {
    // Derivation contract the route will implement:
    //   sidebar list   = page entries WITH a _tempId-only OR slug (everything)
    //   nav simulator  = page entries WITH a non-empty slug (publishable only)
    const pages: PageLike[] = [
      { slug: "about", title: "About" },
      { slug: "", title: "", _tempId: "uuid-wip" },
    ];
    const merged = mergeNavItemsWithPages(builtins, pages, { untitledLabel: "Untitled" });

    const sidebarPages = merged.filter((e) => e.type === "page"); // includes untitled
    const navSimPages = merged.filter((e) => e.type === "page" && !!e.slug); // excludes untitled

    expect(sidebarPages).toHaveLength(2);
    expect(navSimPages).toHaveLength(1);
    expect(navSimPages[0].slug).toBe("about");
  });

  // The sidebar-list and nav-sim derivations live in the route. We replicate
  // the route's pure derivation predicates here (the same logic the route
  // applies to effectiveNavItems) rather than import the server route module,
  // which would break suite collection.
  describe("route derivations (replicated pure logic)", () => {
    const pages: PageLike[] = [
      { slug: "about", title: "About" },
      { slug: "", title: "", _tempId: "uuid-wip" },
    ];
    const merged = mergeNavItemsWithPages(builtins, pages, { untitledLabel: "Untitled" });

    it("the sidebar-list derivation INCLUDES the untitled page (it gets a row with a delete affordance)", () => {
      // contentRows = titled page entries; untitledRows = slug-less page entries.
      const contentRows = merged.filter((e) => e.type === "page" && !!e.slug);
      const untitledRows = merged.filter((e) => e.type === "page" && !e.slug);
      expect(contentRows.map((e) => e.slug)).toEqual(["about"]);
      expect(untitledRows).toHaveLength(1);
      expect(untitledRows[0]._tempId).toBe("uuid-wip");
      // The route labels untitled rows with the new i18n key (asserted at the
      // component level in tests/pages-home-row.test.tsx via t() passthrough).
    });

    it("the navSimItems derivation EXCLUDES untitled pages so they never preview in the live menu", () => {
      // navSimItems = full menu MINUS page entries with no slug.
      const navSimItems = merged.filter(
        (e) => !(e.type === "page" && !e.slug),
      );
      const navSimPageSlugs = navSimItems
        .filter((e) => e.type === "page")
        .map((e) => e.slug);
      expect(navSimPageSlugs).toEqual(["about"]);
      // Built-ins remain present in the nav simulator.
      expect(navSimItems.some((e) => e.type === "builtin" && e.key === "home")).toBe(true);
      // The untitled entry is gone from the nav-sim view.
      expect(navSimItems.some((e) => e.type === "page" && !e.slug)).toBe(false);
    });

    it("excludes a PLACEHOLDER-SLUG untitled page from the nav simulator", () => {
      // A freshly-added page carries a placeholder slug ("untitled"/"untitled-N")
      // while its title is still blank. The slug is truthy, so a slug-only
      // exclusion (`!e.slug`) let the page leak into the live-menu preview with
      // a warning badge. The route now excludes by empty TITLE — resolving the
      // page exactly as the sidebar does — so the two surfaces share one
      // definition of "untitled".
      const pagesWithPlaceholder: PageLike[] = [
        { slug: "about", title: "About" },
        { slug: "untitled", title: "", _tempId: "uuid-fresh" },
      ];
      const mergedP = mergeNavItemsWithPages(builtins, pagesWithPlaceholder, {
        untitledLabel: "Untitled",
      });
      const pageBySlug = new Map(pagesWithPlaceholder.map((p) => [p.slug, p]));

      // Replicates the route's isUntitledPageItem predicate (app/routes/_app.pages.tsx).
      const isUntitledPageItem = (item: NavItem): boolean => {
        if (item.type !== "page") return false;
        const page = item.slug
          ? pageBySlug.get(item.slug)
          : item._tempId
            ? pagesWithPlaceholder.find((p) => p._tempId === item._tempId)
            : undefined;
        if (!page) return !item.slug;
        return !(page.title ?? "").trim();
      };

      // The merge produces a slug-bearing entry for the placeholder-slug page,
      // so the OLD `!e.slug` filter would have kept it — this is the leak.
      const leakedUnderOldFilter = mergedP.filter(
        (e) => !(e.type === "page" && !e.slug),
      );
      expect(
        leakedUnderOldFilter.some((e) => e.type === "page" && e.slug === "untitled"),
      ).toBe(true);

      // The NEW title-based predicate excludes it.
      const navSimItems = mergedP.filter((item) => !isUntitledPageItem(item));
      const navSimPageSlugs = navSimItems
        .filter((e) => e.type === "page")
        .map((e) => e.slug);
      expect(navSimPageSlugs).toEqual(["about"]);
      expect(
        navSimItems.some((e) => e.type === "page" && e.slug === "untitled"),
      ).toBe(false);
    });

    it("untitled sidebar rows are excluded from the sortable id map so they cannot be reorder targets", () => {
      // sidebarIdToFullIdx only maps titled page entries to their full index.
      const sidebarIdToFullIdx = new Map<string, number>();
      merged.forEach((item, fullIdx) => {
        if (item.type !== "page" || !item.slug) return;
        sidebarIdToFullIdx.set(`nav-page-${item.slug}`, fullIdx);
      });
      expect(sidebarIdToFullIdx.has("nav-page-about")).toBe(true);
      // The untitled page has no slug-based id and no mapping → a drag bails.
      expect(sidebarIdToFullIdx.size).toBe(1);
    });
  });
});

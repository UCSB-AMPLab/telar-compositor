/**
 * A custom navigation label is legitimate, so the repair may not treat a label
 * as a page's name.
 *
 * `_app.pages.tsx` syncs a nav entry's label to its page title only while the
 * label is still tracking that title: its label-sync path writes only when the
 * stored label equals the title it last saw, so a label typed in the
 * NavigationEditor is left alone for good. A page's title and its menu label
 * are therefore free to diverge and stay diverged, and a label is not evidence
 * of which page an entry belongs to.
 *
 * So the repair may act only where the association is determined by something
 * the document actually states, and it may never write a label. A slug is a
 * machine reference the re-key invalidated; a label is the name the user chose.
 * Repairing the first must not rewrite the second. Where the first cannot be
 * determined, the honest outcome is a visible duplicate the user can fix, not a
 * silent identity swap they cannot — array position is not evidence either,
 * since the DO picks its keeper by D1 row id and never by menu order, and
 * neither is a label that happens to equal a title (see
 * `nav-label-not-identity.test.ts`).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import { reconcileNavPageSlugs, type ReconcilePage } from "~/lib/nav-reconcile";

type NavEntry = Record<string, unknown>;

function navArrayOf(ydoc: Y.Doc, entries: NavEntry[]): Y.Array<unknown> {
  const navArray = new Y.Array<unknown>();
  navArray.push(entries);
  ydoc.getMap("config").set("navigation", navArray);
  return navArray;
}

function pageEntry(slug: string, label: string, visible = true): NavEntry {
  return { type: "page", slug, label, visible };
}

function snapshot(navArray: Y.Array<unknown>): NavEntry[] {
  return navArray.toArray() as NavEntry[];
}

const builtins: NavEntry[] = [
  { type: "builtin", key: "home", label: "Home", visible: true },
  { type: "builtin", key: "collection", label: "Objects", visible: true },
];

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe("navigation reconcile — custom labels", () => {
  it("leaves both entries alone when no label names either colliding page", () => {
    // Both pages carry menu labels the user typed, so neither entry's label
    // matches a title and nothing in the document says which entry is whose.
    // "Meet the team" belongs to the page that kept `about`; "Our story"
    // belongs to the one the DO re-keyed to `about-2`.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("about", "Our story"),
      pageEntry("about", "Meet the team"),
    ]);

    const pages: ReconcilePage[] = [
      { slug: "about", title: "Team" },
      { slug: "about-2", title: "History" },
    ];

    const { repointed, removed } = reconcileNavPageSlugs(navArray, pages, {
      mutate: true,
      ydoc,
    });

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual([
      ...builtins,
      pageEntry("about", "Our story"),
      pageEntry("about", "Meet the team"),
    ]);
  });

  it("keeps the re-pointed entry's custom label", () => {
    // The group is interchangeable, so one of the two entries follows the
    // re-keyed page. What moves is the slug and only the slug: the label is
    // the name the user gave that menu item, and it is not the page title —
    // a repair that renamed menu items would be its own defect.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      pageEntry("about", "Our story"),
      pageEntry("about", "Our story"),
    ]);

    const { repointed } = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About us" },
        { slug: "about-2", title: "History" },
      ],
      { mutate: true, ydoc },
    );

    expect(repointed).toBe(1);
    expect(snapshot(navArray)).toEqual([
      pageEntry("about", "Our story"),
      pageEntry("about-2", "Our story"),
    ]);
  });

  it("does not delete an ambiguous surplus entry when no page can claim it", () => {
    // Removal is the same coin flip as a re-point: with the keeper undecided,
    // dropping "one of them" drops a label at random.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      pageEntry("about", "Our story"),
      pageEntry("about", "Meet the team"),
    ]);

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      [{ slug: "about", title: "Team" }],
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual([
      pageEntry("about", "Our story"),
      pageEntry("about", "Meet the team"),
    ]);
  });

  it("does not guess between two re-keyed pages", () => {
    // One determined keeper, but two minted slugs are free and the surplus
    // entry's custom label names neither page. Either assignment is a guess.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      pageEntry("about", "About us"),
      pageEntry("about", "Our story"),
    ]);

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About us" },
        { slug: "about-2", title: "History" },
        { slug: "about-3", title: "Team" },
      ],
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual([
      pageEntry("about", "About us"),
      pageEntry("about", "Our story"),
    ]);
  });

  it("still repairs a group whose entries are interchangeable", () => {
    // Two pages sharing a title is a common cause of the collision itself. No
    // label names one page over the other, but the entries are identical, so
    // no assignment can swap anything and no label can be lost.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("about", "About"),
      pageEntry("about", "About"),
    ]);

    const { repointed } = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About" },
        { slug: "about-2", title: "About" },
      ],
      { mutate: true, ydoc },
    );

    expect(repointed).toBe(1);
    expect(snapshot(navArray)).toEqual([
      ...builtins,
      pageEntry("about", "About"),
      pageEntry("about-2", "About"),
    ]);
  });

  it("treats entries differing only in visibility as distinct, not interchangeable", () => {
    // Same label, but one entry is hidden. Swapping them would publish a menu
    // item the user hid and hide one they published.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      pageEntry("about", "About", true),
      pageEntry("about", "About", false),
    ]);

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "Team" },
        { slug: "about-2", title: "History" },
      ],
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual([
      pageEntry("about", "About", true),
      pageEntry("about", "About", false),
    ]);
  });
});

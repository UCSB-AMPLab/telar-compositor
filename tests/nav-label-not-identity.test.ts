/**
 * A navigation label is not a page's identity — not even when it happens to
 * equal a page title.
 *
 * The repair used a label matching a page title as evidence that the entry
 * belonged to that page. The Pages route denies the premise: its label-sync
 * path writes a label only while the stored label still equals the title it
 * last saw, so a label typed in the NavigationEditor is left alone for good.
 * A custom label is therefore free text, and free text can equal anything —
 * including *another* page's title.
 *
 * That is the whole defect. Two pages collide on one slug; the DO re-keys the
 * loser. Page B's entry carries a custom label that happens to read like page
 * A's title, so the repair picks B's entry as A's keeper, and A's entry is then
 * handed to B's page by elimination. Both menu identities move to the wrong
 * page, and the result looks correct — which is what makes it worse than the
 * duplicate link it was trying to remove.
 *
 * There is no narrower reading of the label that rescues it. "The label equals
 * a title" and "the label equals a title but the entry is not that page's" are
 * indistinguishable in the document, because the document never recorded which
 * page an entry was minted for. So the label goes entirely, and the repair acts
 * only where the assignment cannot be wrong: a group of entries that are
 * identical field for field, where any assignment among them produces the same
 * array. Everywhere else the group is left exactly as it stands — the standing
 * ruling that a duplicate link the author can delete beats a swap they cannot
 * see.
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

describe("navigation reconcile — a label is not evidence of identity", () => {
  it("does not swap two entries when one page's custom label reads like the other page's title", () => {
    // `about` is kept by the page titled "About us"; the page titled "History"
    // was re-keyed to `about-2`. The History page's menu item was given the
    // custom label "About us" — legitimate, and nothing in the document says
    // it is not that page's own name for its link. The About-us page's menu
    // item is called "Team newsletter", also custom.
    //
    // Reading the label as identity picks entry 0 as the keeper of `about`
    // and hands entry 1 — the About-us page's item — to `about-2`. Both menu
    // items end up on the wrong page.
    const ydoc = new Y.Doc();
    const entries = [
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about", "Team newsletter"),
    ];
    const navArray = navArrayOf(ydoc, entries);

    const pages: ReconcilePage[] = [
      { slug: "about", title: "About us" },
      { slug: "about-2", title: "History" },
    ];

    const { repointed, removed } = reconcileNavPageSlugs(navArray, pages, {
      mutate: true,
      ydoc,
    });

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual(entries);
  });

  it("does not swap two entries when each label reads like the other page's title", () => {
    // The sharper form: both labels are custom, and between them they are a
    // permutation of the two page titles. Every label-based rule — "one entry
    // names the keeper", "the whole group matches the titles" — finds a
    // confident answer here, and it is the wrong one.
    const ydoc = new Y.Doc();
    const entries = [
      pageEntry("about", "History"),
      pageEntry("about", "About us"),
    ];
    const navArray = navArrayOf(ydoc, entries);

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About us" },
        { slug: "about-2", title: "History" },
      ],
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual(entries);
  });

  it("does not pick a re-keyed page for an entry because the label names it", () => {
    // The other half of the same signal: choosing the *target* by label. Two
    // pages were re-keyed out of `about`, and the surplus entry's label reads
    // like one of them. It is still free text, and the entry is still not
    // known to be either page's.
    const ydoc = new Y.Doc();
    const entries = [
      pageEntry("about", "About us"),
      pageEntry("about", "History"),
    ];
    const navArray = navArrayOf(ydoc, entries);

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
    expect(snapshot(navArray)).toEqual(entries);
  });
});

// ---------------------------------------------------------------------------
// The detector. A title is accepted as input because the caller's page records
// carry one; it must never reach a decision. Deleting the field would state
// that once; this states it in a way a later edit cannot quietly undo.
// ---------------------------------------------------------------------------

describe("navigation reconcile — page titles cannot influence the outcome", () => {
  const scenarios: { name: string; nav: NavEntry[]; slugs: string[] }[] = [
    {
      name: "two custom labels, one re-keyed page",
      nav: [...builtins, pageEntry("about", "Our story"), pageEntry("about", "Meet the team")],
      slugs: ["about", "about-2"],
    },
    {
      name: "labels that look like the titles",
      nav: [pageEntry("about", "About us"), pageEntry("about", "History")],
      slugs: ["about", "about-2"],
    },
    {
      name: "identical entries, one re-keyed page",
      nav: [...builtins, pageEntry("about", "About"), pageEntry("about", "About")],
      slugs: ["about", "about-2"],
    },
    {
      name: "identical entries, nothing to receive the surplus",
      nav: [pageEntry("about", "About us"), pageEntry("about", "About us")],
      slugs: ["about"],
    },
    {
      name: "three entries, two re-keyed pages",
      nav: [
        ...builtins,
        pageEntry("about", "One"),
        pageEntry("about", "Two"),
        pageEntry("about", "Three"),
      ],
      slugs: ["about", "about-2", "about-3"],
    },
    {
      name: "an entry differing only in visibility",
      nav: [pageEntry("about", "About", true), pageEntry("about", "About", false)],
      slugs: ["about", "about-2"],
    },
  ];

  // Every title assignment a user could plausibly have, including ones that
  // line up with the labels and ones that line up with the wrong labels.
  const titleSets: string[][] = [
    ["", "", ""],
    ["About us", "History", "Team"],
    ["History", "About us", "Team"],
    ["Our story", "Meet the team", "About"],
    ["About", "About", "About"],
    ["Three", "Two", "One"],
  ];

  for (const scenario of scenarios) {
    it(`reaches the same outcome whatever the pages are titled — ${scenario.name}`, () => {
      const outcomes = titleSets.map((titles) => {
        const ydoc = new Y.Doc();
        const navArray = navArrayOf(ydoc, scenario.nav.map((e) => ({ ...e })));
        const pages: ReconcilePage[] = scenario.slugs.map((slug, i) => ({
          slug,
          title: titles[i] ?? "",
        }));
        const { repointed, removed } = reconcileNavPageSlugs(navArray, pages, {
          mutate: true,
          ydoc,
        });
        return JSON.stringify({ items: snapshot(navArray), repointed, removed });
      });

      for (const outcome of outcomes) {
        expect(outcome).toBe(outcomes[0]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The honest paths — what the repair must still do once the label is gone.
// ---------------------------------------------------------------------------

describe("navigation reconcile — what identity is left", () => {
  it("still follows the re-key when the group's entries are identical", () => {
    // Two pages sharing a title is the ordinary way this collision happens:
    // the slug is generated from the title, so equal titles collide, and the
    // labels track the titles. Any assignment among identical entries produces
    // the same array, so there is nothing to get wrong.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("about", "About"),
      pageEntry("about", "About"),
    ]);

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About" },
        { slug: "about-2", title: "About" },
      ],
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 1, removed: 0 });
    expect(snapshot(navArray)).toEqual([
      ...builtins,
      pageEntry("about", "About"),
      pageEntry("about-2", "About"),
    ]);
  });

  it("still collapses an exact duplicate no page can claim", () => {
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about", "About us"),
    ]);

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      [{ slug: "about", title: "About us" }],
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 1 });
    expect(snapshot(navArray)).toEqual([...builtins, pageEntry("about", "About us")]);
  });

  it("leaves an ordinary menu alone", () => {
    const ydoc = new Y.Doc();
    const entries = [
      ...builtins,
      pageEntry("about", "Our story"),
      pageEntry("team", "Meet the team", false),
      { type: "external", url: "https://example.org", label: "Blog", visible: true },
    ];
    const navArray = navArrayOf(ydoc, entries);

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About us" },
        { slug: "team", title: "Team" },
      ],
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual(entries);
  });
});

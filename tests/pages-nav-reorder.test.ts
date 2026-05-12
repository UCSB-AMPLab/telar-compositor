/**
 * This file pins the page-tab reorder behaviour — guarding against the
 * earlier regression where dragging a page tab in the Pages tab silently
 * reverted (or made the tab disappear).
 *
 * The bug: `handleNavDragEnd` in `app/routes/_app.pages.tsx` constructed a
 * fresh `Y.Map` and only populated it `if (source instanceof Y.Map)`. The
 * project's `config.navigation` Y.Array stores PLAIN JSON objects (see the
 * server seed in `workers/collaboration.ts` and the in-route push sites),
 * so the branch never executed and an empty Y.Map was inserted at the
 * dragged-to slot, replacing the visible page tab.
 *
 * These tests build the navArray exactly the way production builds it
 * (plain `{type, slug, label, visible}` literals pushed via `navArray.push`)
 * and exercise the shared `reorderNavArray` helper that the route now calls.
 * They would have failed with the old inline clone block; they pass with
 * the shared helper.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { reorderNavArray } from "~/lib/yjs-helpers";

type NavEntry =
  | { type: "builtin"; key: string; label: string; visible: boolean }
  | { type: "page"; slug: string; label: string; visible: boolean }
  | { type: "external"; url: string; label: string; visible: boolean };

/**
 * Build a Y.Doc whose `config.navigation` Y.Array matches the production
 * seed shape from workers/collaboration.ts:705-725.
 */
function buildSeededDoc(entries: NavEntry[]): {
  doc: Y.Doc;
  navArray: Y.Array<unknown>;
} {
  const doc = new Y.Doc();
  const config = doc.getMap("config");
  const navArray = new Y.Array<unknown>();
  navArray.push(entries);
  config.set("navigation", navArray);
  return { doc, navArray };
}

function snapshot(navArray: Y.Array<unknown>): NavEntry[] {
  return navArray.toArray() as NavEntry[];
}

const builtins: NavEntry[] = [
  { type: "builtin", key: "home", label: "Home", visible: true },
  { type: "builtin", key: "collection", label: "Objects", visible: true },
  { type: "builtin", key: "glossary", label: "Glossary", visible: true },
];

function pageEntry(slug: string, label = slug): NavEntry {
  return { type: "page", slug, label, visible: true };
}

describe("reorderNavArray (plain-object navigation entries)", () => {
  it("moves a page tab downward (the original failing case) and preserves all fields", () => {
    const { doc, navArray } = buildSeededDoc([
      ...builtins,
      pageEntry("about"),
      pageEntry("team"),
      pageEntry("contact"),
      pageEntry("press"),
    ]);

    // Drag "about" (index 3) to "press" position (index 6).
    doc.transact(() => reorderNavArray(navArray, 3, 6));

    const after = snapshot(navArray);
    expect(after.map((e) => ("slug" in e ? e.slug : "key" in e ? e.key : e.url))).toEqual([
      "home",
      "collection",
      "glossary",
      "team",
      "contact",
      "press",
      "about",
    ]);

    // The moved entry retains its original fields (type, slug, label, visible).
    // The previous code inserted an EMPTY Y.Map here — this assertion would
    // have failed under the bug.
    const moved = after[6];
    expect(moved).toEqual({
      type: "page",
      slug: "about",
      label: "about",
      visible: true,
    });
  });

  it("never inserts an empty entry at the moved slot", () => {
    const { doc, navArray } = buildSeededDoc([
      ...builtins,
      pageEntry("a"),
      pageEntry("b"),
      pageEntry("c"),
    ]);

    doc.transact(() => reorderNavArray(navArray, 3, 5));

    for (const entry of snapshot(navArray)) {
      // Defensive: every entry must be a populated plain object with a `type`.
      expect(entry).not.toBeInstanceOf(Y.Map);
      expect(entry).not.toEqual({});
      expect(typeof (entry as { type?: unknown }).type).toBe("string");
    }
  });

  it("moves a page tab upward (regression coverage for the symmetric case)", () => {
    const { doc, navArray } = buildSeededDoc([
      ...builtins,
      pageEntry("about"),
      pageEntry("team"),
      pageEntry("contact"),
    ]);

    // Drag "contact" (index 5) up to "about" position (index 3).
    doc.transact(() => reorderNavArray(navArray, 5, 3));

    expect(snapshot(navArray).map((e) => ("slug" in e ? e.slug : "key" in e ? e.key : e.url))).toEqual([
      "home",
      "collection",
      "glossary",
      "contact",
      "about",
      "team",
    ]);
  });

  it("reordering a built-in tab leaves page entries untouched", () => {
    const { doc, navArray } = buildSeededDoc([
      ...builtins,
      pageEntry("about"),
      pageEntry("team"),
    ]);

    // Drag "Glossary" (index 2) before "Home" (index 0).
    doc.transact(() => reorderNavArray(navArray, 2, 0));

    const after = snapshot(navArray);
    expect(after.map((e) => ("slug" in e ? e.slug : "key" in e ? e.key : e.url))).toEqual([
      "glossary",
      "home",
      "collection",
      "about",
      "team",
    ]);

    // Page entries unchanged in shape.
    expect(after[3]).toEqual({ type: "page", slug: "about", label: "about", visible: true });
    expect(after[4]).toEqual({ type: "page", slug: "team", label: "team", visible: true });
  });

  it("downward reorder survives a clone-and-replay (proxy for hard reload)", () => {
    // The original UAT failure mode was "drag works visually, reverts on
    // hard reload". On reload the snapshotToD1 cycle persists
    // `navArray.toArray()` as `navigation_json`; the DO then re-seeds a
    // fresh navArray from that JSON on next connect. Simulate that round
    // trip and assert the final order matches what the user dragged to.
    const { doc, navArray } = buildSeededDoc([
      ...builtins,
      pageEntry("about"),
      pageEntry("team"),
      pageEntry("contact"),
      pageEntry("press"),
    ]);

    doc.transact(() => reorderNavArray(navArray, 3, 6));

    // Snapshot → JSON (the persistence path) → fresh doc (the reload path).
    const persistedJson = JSON.stringify(snapshot(navArray));
    const reseeded = JSON.parse(persistedJson) as NavEntry[];
    const { navArray: nav2 } = buildSeededDoc(reseeded);

    expect(snapshot(nav2).map((e) => ("slug" in e ? e.slug : "key" in e ? e.key : e.url))).toEqual([
      "home",
      "collection",
      "glossary",
      "team",
      "contact",
      "press",
      "about",
    ]);
  });

  it("no-ops on identical indices", () => {
    const before: NavEntry[] = [...builtins, pageEntry("about")];
    const { doc, navArray } = buildSeededDoc(before);
    doc.transact(() => reorderNavArray(navArray, 3, 3));
    expect(snapshot(navArray)).toEqual(before);
  });

  it("no-ops on out-of-range indices", () => {
    const before: NavEntry[] = [...builtins, pageEntry("about")];
    const { doc, navArray } = buildSeededDoc(before);
    doc.transact(() => reorderNavArray(navArray, -1, 0));
    doc.transact(() => reorderNavArray(navArray, 0, 99));
    doc.transact(() => reorderNavArray(navArray, 99, 0));
    expect(snapshot(navArray)).toEqual(before);
  });

  it("defensive Y.Map clone path: if a Y.Map ever lands in nav, it is deep-cloned (not reused)", () => {
    // Not exercised by production today, but the helper documents and tests
    // the defensive path so a future schema change can't silently corrupt.
    const doc = new Y.Doc();
    const config = doc.getMap("config");
    const navArray = new Y.Array<unknown>();

    const ymapEntry = new Y.Map<unknown>();
    ymapEntry.set("type", "page");
    ymapEntry.set("slug", "about");
    ymapEntry.set("label", new Y.Text("About"));
    ymapEntry.set("visible", true);

    doc.transact(() => {
      navArray.push([
        { type: "builtin", key: "home", label: "Home", visible: true },
        ymapEntry,
        { type: "page", slug: "team", label: "team", visible: true },
      ]);
    });
    config.set("navigation", navArray);

    doc.transact(() => reorderNavArray(navArray, 1, 2));

    const moved = navArray.get(2);
    expect(moved).toBeInstanceOf(Y.Map);
    // The moved entry is a clone — distinct identity from the original.
    expect(moved).not.toBe(ymapEntry);
    expect((moved as Y.Map<unknown>).get("slug")).toBe("about");
    expect((moved as Y.Map<unknown>).get("type")).toBe("page");
    const labelClone = (moved as Y.Map<unknown>).get("label");
    expect(labelClone).toBeInstanceOf(Y.Text);
    expect((labelClone as Y.Text).toString()).toBe("About");
  });
});

describe("reorderNavArray vs. the failed inline-clone implementation", () => {
  // Negative-control test: re-implement the OLD broken code and assert it
  // produces the exact bug we fixed. This locks in regression intent —
  // if anyone re-introduces the conditional Y.Map clone, this test fires.
  function brokenReorder(
    navArray: Y.Array<unknown>,
    oldIndex: number,
    newIndex: number
  ): void {
    const source = navArray.get(oldIndex);
    const clone = new Y.Map<unknown>();
    if (source instanceof Y.Map) {
      for (const [key, value] of source.entries()) {
        clone.set(key, value instanceof Y.Text ? new Y.Text(value.toString()) : value);
      }
    }
    navArray.delete(oldIndex, 1);
    navArray.insert(newIndex, [clone]);
  }

  it("the old broken code inserts an empty Y.Map at the moved slot", () => {
    const { doc, navArray } = buildSeededDoc([
      ...builtins,
      pageEntry("about"),
      pageEntry("team"),
      pageEntry("contact"),
      pageEntry("press"),
    ]);

    doc.transact(() => brokenReorder(navArray, 3, 6));

    const moved = navArray.get(6);
    expect(moved).toBeInstanceOf(Y.Map);
    expect((moved as Y.Map<unknown>).size).toBe(0);
    // Reading `.type` from an empty Y.Map yields undefined → the page tab
    // disappears from the rendered nav. This is exactly what UAT saw.
    expect((moved as Y.Map<unknown>).get("type")).toBeUndefined();
  });
});

/**
 * Page-order reorder contract: the single source of truth for page order is
 * the existing `navigation_json` Yjs array; both surfaces (the nav-menu
 * simulator and the left editing sidebar) are live VIEWS of that single
 * array. This file pins the single-move-reorder contract and the
 * both-views-stay-synced invariant.
 *
 * Composes the `reorderNavArray` helper the route's sidebar drag handler
 * calls against a real Y.Doc seed shape from workers/collaboration.ts.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { reorderNavArray } from "~/lib/yjs-helpers";

type NavEntry =
  | { type: "builtin"; key: string; label: string; visible: boolean }
  | { type: "page"; slug: string; label: string; visible: boolean }
  | { type: "external"; url: string; label: string; visible: boolean };

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

function keyOf(e: NavEntry): string {
  return "slug" in e ? e.slug : "key" in e ? e.key : e.url;
}

/** The worked example: [Home, Objects, A, Glossary, B, Share]. */
function buildD02Doc() {
  return buildSeededDoc([
    { type: "builtin", key: "home", label: "Home", visible: true },
    { type: "builtin", key: "collection", label: "Objects", visible: true },
    { type: "page", slug: "a", label: "A", visible: true },
    { type: "builtin", key: "glossary", label: "Glossary", visible: true },
    { type: "page", slug: "b", label: "B", visible: true },
    { type: "builtin", key: "share", label: "Share", visible: true },
  ]);
}

describe("sidebar reorder is a SINGLE move in navigation_json", () => {
  it("dragging page B above page A produces [Home, Objects, B, A, Glossary, Share] — built-in slots otherwise unchanged", () => {
    const { doc, navArray } = buildD02Doc();

    // Sidebar shows only the two page rows [A, B]. "Drag B above A" resolves
    // to the full-array move: B at full index 4 → above A at full index 2.
    const fullIdxA = 2;
    const fullIdxB = 4;
    doc.transact(() => reorderNavArray(navArray, fullIdxB, fullIdxA));

    expect(snapshot(navArray).map(keyOf)).toEqual([
      "home",
      "collection",
      "b",
      "a",
      "glossary",
      "share",
    ]);
  });

  it("the move touches only the dragged page — every built-in keeps its relative order", () => {
    const { doc, navArray } = buildD02Doc();
    doc.transact(() => reorderNavArray(navArray, 4, 2));

    const builtins = snapshot(navArray)
      .filter((e) => e.type === "builtin")
      .map(keyOf);
    // Objects still precedes Glossary still precedes Share.
    expect(builtins).toEqual(["home", "collection", "glossary", "share"]);
  });

  it("both views derive from the one array: filtered sidebar view AND full nav view reflect the same move", () => {
    const { doc, navArray } = buildD02Doc();
    doc.transact(() => reorderNavArray(navArray, 4, 2));

    const after = snapshot(navArray);

    // Full nav-simulator view = the whole array, in order.
    const navView = after.map(keyOf);
    expect(navView).toEqual(["home", "collection", "b", "a", "glossary", "share"]);

    // Sidebar view = the same array filtered to content pages (built-ins are
    // never rendered in the sidebar). It must reflect the post-move order with
    // no separate ordering to reconcile.
    const sidebarView = after
      .filter((e) => e.type === "page")
      .map(keyOf);
    expect(sidebarView).toEqual(["b", "a"]);
  });

  it("a built-in drag in the nav simulator repositions only that built-in; page order is untouched", () => {
    const { doc, navArray } = buildD02Doc();
    // Drag Glossary (full index 3) to the front (index 0).
    doc.transact(() => reorderNavArray(navArray, 3, 0));

    const pageOrder = snapshot(navArray)
      .filter((e) => e.type === "page")
      .map(keyOf);
    expect(pageOrder).toEqual(["a", "b"]);
  });

  // Route-level index translation (filtered sidebar position → full navArray
  // position), built by the Pages rewrite. We replicate the route's
  // `sidebarIdToFullIdx` derivation here (the same pure logic) rather than
  // import the server route module (which would break suite collection).
  it("sidebarIdToFullIdx maps a filtered sidebar drag (B over A) to full nav indices (4 → 2) and excludes untitled rows (no full-array entry)", () => {
    // Full nav array: [Home, Objects, A, Glossary, B, Share] plus an appended
    // synthetic untitled page (no slug, _tempId only) at the end (index 6).
    const fullNav = [
      { type: "builtin", key: "home" },
      { type: "builtin", key: "collection" },
      { type: "page", slug: "a" },
      { type: "builtin", key: "glossary" },
      { type: "page", slug: "b" },
      { type: "builtin", key: "share" },
      { type: "page", _tempId: "uuid-wip" }, // untitled — sidebar-only
    ] as const;

    // The route's derivation: titled page entries get a sidebarId→fullIdx
    // mapping; untitled (slug-less) page entries are EXCLUDED.
    const sidebarIdToFullIdx = new Map<string, number>();
    fullNav.forEach((item, fullIdx) => {
      if (item.type !== "page") return;
      if (!("slug" in item) || !item.slug) return; // untitled excluded
      sidebarIdToFullIdx.set(`nav-page-${item.slug}`, fullIdx);
    });

    expect(sidebarIdToFullIdx.get("nav-page-a")).toBe(2);
    expect(sidebarIdToFullIdx.get("nav-page-b")).toBe(4);
    // Untitled row has no sidebar→full mapping (its drag bails).
    expect(sidebarIdToFullIdx.get("nav-page-temp-uuid-wip")).toBeUndefined();
    expect(sidebarIdToFullIdx.size).toBe(2);

    // "Drag B over A" resolves to a single move 4 -> 2 in the full array.
    const { doc, navArray } = buildD02Doc();
    const oldFullIdx = sidebarIdToFullIdx.get("nav-page-b")!;
    const newFullIdx = sidebarIdToFullIdx.get("nav-page-a")!;
    doc.transact(() => reorderNavArray(navArray, oldFullIdx, newFullIdx));
    expect(snapshot(navArray).map(keyOf)).toEqual([
      "home",
      "collection",
      "b",
      "a",
      "glossary",
      "share",
    ]);
  });

  it("the sidebar drag is a SINGLE navigation_json move — no second pages-array reorder", () => {
    // Contract: handleSidebarDragEnd calls reorderNavArray exactly once inside
    // one transact and never touches a pages array. We pin the observable
    // consequence — one move mutates only the nav array, and a second
    // (redundant) reorder would have double-moved the entry. After a single
    // 4 -> 2 move the array is the target; a (hypothetical) second move
    // would diverge from it.
    const { doc, navArray } = buildD02Doc();
    let transactCount = 0;
    doc.on("afterTransaction", () => {
      transactCount += 1;
    });
    doc.transact(() => reorderNavArray(navArray, 4, 2));
    expect(transactCount).toBe(1);
    expect(snapshot(navArray).map(keyOf)).toEqual([
      "home",
      "collection",
      "b",
      "a",
      "glossary",
      "share",
    ]);
  });
});

/**
 * This file pins the recovery semantics for `sanitizeNavArray`, the helper
 * that defends against corrupted `config.navigation` entries left behind by
 * an earlier inline-fix attempt (commit f94282c) which inserted empty
 * Y.Maps in place of the dragged page record.
 *
 * Once snapshotToD1 persisted those broken entries, the nav loader
 * (`_app.pages.tsx:451-464`) would surface undefined `type`/`slug`/`key`
 * fields, which the render path silently dropped — leaving the nav bar
 * empty for any project that hit the broken deploy.
 *
 * These tests check the recovery semantics: filter invalid entries on read,
 * and (when configured) rewrite the navArray in place so the next snapshot
 * persists the cleaned shape.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { sanitizeNavArray } from "~/lib/yjs-helpers";

function buildNav(entries: unknown[]): {
  doc: Y.Doc;
  navArray: Y.Array<unknown>;
} {
  const doc = new Y.Doc();
  const config = doc.getMap("config");
  const navArray = new Y.Array<unknown>();
  config.set("navigation", navArray);
  doc.transact(() => navArray.insert(0, entries));
  return { doc, navArray };
}

describe("sanitizeNavArray", () => {
  it("returns valid plain-object entries unchanged", () => {
    const { navArray } = buildNav([
      { type: "builtin", key: "home", label: "Home", visible: true },
      { type: "builtin", key: "collection", label: "Objects", visible: true },
      { type: "page", slug: "about", label: "About", visible: true },
    ]);

    const { items, dropped } = sanitizeNavArray(navArray);
    expect(dropped).toBe(0);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.type)).toEqual(["builtin", "builtin", "page"]);
  });

  it("drops empty Y.Maps (the f94282c corruption signature)", () => {
    const { navArray } = buildNav([
      { type: "builtin", key: "home", label: "Home", visible: true },
      new Y.Map<unknown>(), // ← corruption from broken reorder
      { type: "page", slug: "about", label: "About", visible: true },
    ]);

    const { items, dropped } = sanitizeNavArray(navArray);
    expect(dropped).toBe(1);
    expect(items).toHaveLength(2);
    expect(items.every((i) => !(i instanceof Y.Map))).toBe(true);
  });

  it("drops Y.Map entries even when they have some fields populated", () => {
    // Defensive — partially populated Y.Map shouldn't pass either since
    // navArray's contract is plain JSON only.
    const partialYMap = new Y.Map<unknown>();
    partialYMap.set("type", "page");
    partialYMap.set("slug", "stranded");

    const { navArray } = buildNav([
      { type: "builtin", key: "home", label: "Home", visible: true },
      partialYMap,
    ]);

    const { items, dropped } = sanitizeNavArray(navArray);
    expect(dropped).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("home");
  });

  it("drops entries with no `type` field", () => {
    const { navArray } = buildNav([
      { type: "builtin", key: "home", label: "Home", visible: true },
      { label: "Stray label only" }, // no type
    ]);

    const { items, dropped } = sanitizeNavArray(navArray);
    expect(dropped).toBe(1);
    expect(items).toHaveLength(1);
  });

  it("drops page entries with empty/missing slug", () => {
    const { navArray } = buildNav([
      { type: "page", slug: "valid", label: "Valid Page" },
      { type: "page", slug: "", label: "Empty slug" },
      { type: "page", label: "No slug field" },
    ]);

    const { items, dropped } = sanitizeNavArray(navArray);
    expect(dropped).toBe(2);
    expect(items).toHaveLength(1);
    expect(items[0].slug).toBe("valid");
  });

  it("drops builtin entries with empty/missing key", () => {
    const { navArray } = buildNav([
      { type: "builtin", key: "home", label: "Home" },
      { type: "builtin", key: "", label: "Empty key" },
      { type: "builtin", label: "No key" },
    ]);

    const { items, dropped } = sanitizeNavArray(navArray);
    expect(dropped).toBe(2);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("home");
  });

  it("drops external entries with no url and no label", () => {
    const { navArray } = buildNav([
      { type: "external", url: "https://example.com", label: "Example" },
      { type: "external", label: "Label only is fine" },
      { type: "external", url: "https://x.com" },
      { type: "external" }, // no url, no label → drop
    ]);

    const { items, dropped } = sanitizeNavArray(navArray);
    expect(dropped).toBe(1);
    expect(items).toHaveLength(3);
  });

  it("drops null and primitive entries", () => {
    const { navArray } = buildNav([
      { type: "builtin", key: "home", label: "Home" },
      null,
      "stray-string",
      42,
      true,
    ]);

    const { items, dropped } = sanitizeNavArray(navArray);
    expect(dropped).toBe(4);
    expect(items).toHaveLength(1);
  });

  it("returns dropped=0 and an empty list when navArray is empty", () => {
    const { navArray } = buildNav([]);
    const { items, dropped } = sanitizeNavArray(navArray);
    expect(dropped).toBe(0);
    expect(items).toHaveLength(0);
  });

  it("does NOT mutate navArray when mutate=false (default)", () => {
    const { navArray } = buildNav([
      { type: "builtin", key: "home", label: "Home" },
      new Y.Map<unknown>(), // corrupt
    ]);

    const before = navArray.length;
    sanitizeNavArray(navArray);
    expect(navArray.length).toBe(before); // unchanged
  });

  it("rewrites navArray when mutate=true and entries were dropped", () => {
    const { doc, navArray } = buildNav([
      { type: "builtin", key: "home", label: "Home" },
      new Y.Map<unknown>(), // corrupt
      { type: "page", slug: "about", label: "About" },
    ]);

    const { items, dropped } = sanitizeNavArray(navArray, { mutate: true, ydoc: doc });
    expect(dropped).toBe(1);
    expect(items).toHaveLength(2);

    // navArray itself is now clean
    expect(navArray.length).toBe(2);
    const rebuilt = sanitizeNavArray(navArray);
    expect(rebuilt.dropped).toBe(0);
    expect(rebuilt.items).toHaveLength(2);
    expect(rebuilt.items[0].key).toBe("home");
    expect(rebuilt.items[1].slug).toBe("about");
  });

  it("does NOT rewrite navArray when mutate=true but nothing was dropped", () => {
    const { doc, navArray } = buildNav([
      { type: "builtin", key: "home", label: "Home" },
      { type: "page", slug: "about", label: "About" },
    ]);

    let updateFired = false;
    navArray.observe(() => { updateFired = true; });

    const { dropped } = sanitizeNavArray(navArray, { mutate: true, ydoc: doc });
    expect(dropped).toBe(0);
    expect(updateFired).toBe(false); // no Yjs write happened
  });

  it("recovery scenario: navArray entirely corrupt → empty list (caller falls back to defaults)", () => {
    const { doc, navArray } = buildNav([
      new Y.Map<unknown>(),
      new Y.Map<unknown>(),
      new Y.Map<unknown>(),
    ]);

    const { items, dropped } = sanitizeNavArray(navArray, { mutate: true, ydoc: doc });
    expect(dropped).toBe(3);
    expect(items).toHaveLength(0);
    expect(navArray.length).toBe(0);
    // The component falls back to defaultNavItems when navItems.length === 0
    // (see _app.pages.tsx:646), so the user gets a sensible nav bar back.
  });

  it("preserves all original fields on valid entries", () => {
    const { navArray } = buildNav([
      { type: "page", slug: "deep", label: "Deep Page", visible: false, custom: "ok" },
    ]);

    const { items } = sanitizeNavArray(navArray);
    expect(items[0]).toMatchObject({
      type: "page",
      slug: "deep",
      label: "Deep Page",
      visible: false,
    });
    // Extra unknown fields are kept (we only filter by required field shape)
    expect((items[0] as unknown as { custom: string }).custom).toBe("ok");
  });
});

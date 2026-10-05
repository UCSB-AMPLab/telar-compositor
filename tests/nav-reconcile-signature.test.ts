/**
 * The repair runs from an effect, so what it reads and what re-runs it must be
 * the same list.
 *
 * `reconcileNavPageSlugs` decides on full-entry equality — every field of a nav
 * entry, `visible` included. A signature that lists a subset of those fields
 * therefore misses edits the repair cares about: making two distinct duplicate
 * entries interchangeable, by hiding one of them, changes nothing the effect
 * watches, so the repair does not run and the re-keyed page stays out of the
 * menu until an unrelated page change or a reload re-triggers it.
 *
 * A hand-kept copy of one truth is the failure this codebase keeps paying for,
 * so the signature is built by the module that does the reading. These tests
 * pin the property rather than the field list: any change to any field of an
 * entry, and any change to the set of page slugs, must move the signature —
 * including fields nobody has added yet.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { navReconcileSignature, type ReconcilePage } from "~/lib/nav-reconcile";

type NavEntry = Record<string, unknown>;

const pages: ReconcilePage[] = [
  { slug: "about", title: "About us" },
  { slug: "team", title: "Our team" },
];

const entry: NavEntry = {
  type: "page",
  slug: "about",
  label: "About us",
  visible: true,
};

const entries: NavEntry[] = [
  { type: "builtin", key: "home", label: "Home", visible: true },
  entry,
  { type: "page", slug: "team", label: "Our team", visible: false },
];

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe("nav reconcile signature — every field the repair reads", () => {
  it("moves when an entry's visibility changes", () => {
    // Two duplicate entries differing only in `visible` are left alone by the
    // repair, because swapping them would publish an item the author hid.
    // Hiding the other one makes them interchangeable and the repair can act —
    // but only if this signature notices.
    const before = navReconcileSignature(pages, entries);
    const after = navReconcileSignature(pages, [
      entries[0],
      { ...entry, visible: false },
      entries[2],
    ]);

    expect(after).not.toBe(before);
  });

  it("moves when any single field of an entry changes", () => {
    // Stated as a property so a field added later is covered without anyone
    // remembering to come back here.
    const before = navReconcileSignature(pages, entries);

    for (const key of Object.keys(entry)) {
      const mutated = { ...entry, [key]: "changed-for-this-assertion" };
      const after = navReconcileSignature(pages, [entries[0], mutated, entries[2]]);
      expect(after, `changing ${key} left the signature unmoved`).not.toBe(before);
    }
  });

  it("moves when an entry gains a field", () => {
    const before = navReconcileSignature(pages, entries);
    const after = navReconcileSignature(pages, [
      entries[0],
      { ...entry, target: "_blank" },
      entries[2],
    ]);

    expect(after).not.toBe(before);
  });

  it("moves when an entry loses a field", () => {
    const before = navReconcileSignature(pages, entries);
    const { visible: _dropped, ...withoutVisible } = entry;
    const after = navReconcileSignature(pages, [entries[0], withoutVisible, entries[2]]);

    expect(after).not.toBe(before);
  });

  it("moves when a page slug appears, disappears or changes", () => {
    const before = navReconcileSignature(pages, entries);

    expect(navReconcileSignature([...pages, { slug: "about-2" }], entries)).not.toBe(before);
    expect(navReconcileSignature([pages[0]], entries)).not.toBe(before);
    expect(navReconcileSignature([{ slug: "about-2" }, pages[1]], entries)).not.toBe(before);
  });

  it("moves when entries are reordered", () => {
    const before = navReconcileSignature(pages, entries);
    const after = navReconcileSignature(pages, [entries[1], entries[0], entries[2]]);

    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The honest paths — a signature that moves on everything re-runs the repair
// on every keystroke.
// ---------------------------------------------------------------------------

describe("nav reconcile signature — what it must ignore", () => {
  it("does not move when only a page title changes", () => {
    // Titles are not evidence and the repair never reads one, so a title edit
    // — which is every keystroke in the page editor — must not re-run it.
    const before = navReconcileSignature(pages, entries);
    const after = navReconcileSignature(
      [{ slug: "about", title: "A completely different title" }, pages[1]],
      entries,
    );

    expect(after).toBe(before);
  });

  it("does not move when only an entry's key order changes", () => {
    const before = navReconcileSignature(pages, entries);
    const reordered: NavEntry = {
      visible: true,
      label: "About us",
      slug: "about",
      type: "page",
    };
    const after = navReconcileSignature(pages, [entries[0], reordered, entries[2]]);

    expect(after).toBe(before);
  });

  it("is stable across repeated calls on equal input", () => {
    const a = navReconcileSignature(pages, entries.map((e) => ({ ...e })));
    const b = navReconcileSignature(pages.map((p) => ({ ...p })), entries.map((e) => ({ ...e })));

    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// The wiring. The property above is worth nothing if the route still keeps its
// own list, so the coupling itself is asserted.
// ---------------------------------------------------------------------------

describe("Pages route — the reconcile effect depends on the shared signature", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../app/routes/_app.pages.tsx", import.meta.url)),
    "utf8",
  );

  it("builds the reconcile dependency by calling navReconcileSignature", () => {
    expect(source).toContain("navReconcileSignature(displayPages, navItems)");
  });

  it("gives that dependency to the effect that runs the repair", () => {
    const effectStart = source.indexOf("reconcileNavPageSlugs(");
    expect(effectStart).toBeGreaterThan(-1);
    const effectTail = source.slice(effectStart, effectStart + 400);
    expect(effectTail).toContain("navReconcileDep");
  });
});

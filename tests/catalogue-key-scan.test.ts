/**
 * Catalogue keys that no component references.
 *
 * `i18n-parity.test.ts` compares the two locales against each other, so a key
 * present in both, spelled correctly and translated, passes it forever whether
 * or not anything renders it. This test closes that direction, as
 * `jsx-literal-scan.test.ts` closes the opposite one — text with no key.
 *
 * The danger here is the inverse of the JSX scan's. That one errs toward
 * flagging real prose, which costs a look. This one errs toward calling a live
 * key dead, which costs a user seeing a raw key on screen. So absence of a
 * literal reference is never treated as absence of use: two probes must agree
 * (see `catalogue-key-scan.ts`), i18next's plural resolution is applied, and
 * every runtime-built key space is declared as a family with its member set
 * read from the code that owns it.
 *
 * The scan runs against a baseline rather than an allowlist. Its three
 * directions — new orphan, stale entry, revived key — are what make it a
 * ratchet: the debt can only shrink, and it cannot be quietly added to.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildSourceIndex,
  isLive,
  isReferenced,
  listCatalogueKeys,
  makeSourceIndex,
  namedInText,
  readStringArray,
  readUnionMembers,
  resolvesViaPlural,
  type CatalogueKey,
} from "./helpers/catalogue-key-scan";
import { familyCovers, keyFamilies, type KeyFamily } from "./helpers/catalogue-key-families";
import { ORPHAN_BASELINE, orphanEntries } from "./helpers/orphan-key-baseline";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Built once: parsing the whole app tree twice per assertion is the slow part. */
const index = buildSourceIndex(repoRoot);
const families = keyFamilies(repoRoot);
const catalogue = listCatalogueKeys(repoRoot);

/** True when any declared family for this namespace accounts for the key. */
function coveredByFamily(entry: CatalogueKey): boolean {
  return families.some((family) => family.ns === entry.ns && familyCovers(family, entry.key));
}

/** Every catalogue key nothing reaches: neither probe, nor plural, nor family. */
function deadKeys(): CatalogueKey[] {
  return catalogue.filter((entry) => !isLive(index, entry.key) && !coveredByFamily(entry));
}

const asId = (entry: { ns: string; key: string }) => `${entry.ns}:${entry.key}`;

describe("catalogue key scan — app/i18n/locales/en", () => {
  it("finds no dead key the baseline does not already carry", () => {
    const baselined = new Set(orphanEntries().map(asId));
    const unbaselined = deadKeys().map(asId).filter((id) => !baselined.has(id));
    expect(unbaselined).toEqual([]);
  });

  it("every baseline entry still names a key the catalogue holds", () => {
    // Forces the baseline to shrink as keys are removed. Without this an entry
    // outlives its key and the list slowly stops describing anything.
    const held = new Set(catalogue.map(asId));
    const stale = orphanEntries().map(asId).filter((id) => !held.has(id));
    expect(stale).toEqual([]);
  });

  it("every baseline entry is still dead", () => {
    // The direction that makes this a ratchet rather than a snapshot: a key
    // that gains a reference has to leave the list, not sit on it looking dead.
    const revived = orphanEntries()
      .filter((entry) => isLive(index, entry.key) || coveredByFamily(entry))
      .map(asId);
    expect(revived).toEqual([]);
  });

  it("every declared family's members are all in the catalogue", () => {
    // Read from the code that owns the domain, so extending that code without
    // writing the strings lands here. The other direction — a catalogue key
    // under a family's prefix that the member set does not contain — is caught
    // by the dead-key assertion above, which is why members are declared rather
    // than prefixes.
    const held = new Set(catalogue.map(asId));
    const missing: string[] = [];
    for (const family of families) {
      for (const member of family.members ?? []) {
        const id = `${family.ns}:${family.prefix}${member}`;
        if (!held.has(id) && ![...held].some((k) => k.startsWith(`${id}.`))) missing.push(id);
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives every family and every baseline group a reason", () => {
    // An exemption that outlives the argument for it is how a detector becomes
    // decoration; this is the same guard the JSX scan puts on its allowlist.
    const unreasoned = [
      ...families.filter((f) => f.reason.trim() === "").map((f) => `${f.ns}:${f.prefix}`),
      ...ORPHAN_BASELINE.filter((g) => g.reason.trim() === "").map((g) => g.ns),
    ];
    expect(unreasoned).toEqual([]);
  });

  it("makes every family name where its member set comes from", () => {
    // A family with no domain is an allowlist wearing a better name. An
    // underivable one has to say what blocks enumeration, since it excuses its
    // whole prefix and is the only kind here that does.
    const undeclared = families
      .filter((f) => (f.members === null ? !f.domain.startsWith("none") : f.domain.trim() === ""))
      .map((f) => `${f.ns}:${f.prefix}`);
    expect(undeclared).toEqual([]);
  });
});

describe("catalogue key scan — domain extraction", () => {
  it("reads an array const's members", () => {
    expect(readStringArray(repoRoot, "app/lib/contributions.ts", "CONTRIBUTION_KINDS")).toEqual([
      "steps",
      "panels",
      "objects",
      "pages",
      "glossary",
    ]);
  });

  it("reads a union type's members", () => {
    expect(readUnionMembers(repoRoot, "app/lib/undo-target.ts", "EntitySection")).toEqual([
      "stories",
      "objects",
      "glossary",
      "pages",
    ]);
  });

  it("refuses a symbol it cannot find rather than returning nothing", () => {
    // A silent empty domain would excuse the family's whole prefix by accident.
    expect(() => readStringArray(repoRoot, "app/lib/contributions.ts", "NO_SUCH_CONST")).toThrow();
  });
});

describe("catalogue key scan — detector fixtures", () => {
  const fixture = (literals: string[], text: string) => makeSourceIndex(literals, text);

  it("calls a key nothing names dead", () => {
    const source = `const label = t("editor.other");`;
    expect(isLive(fixture(["editor.other"], source), "editor.orphan")).toBe(false);
  });

  it("calls a key a literal names live", () => {
    const source = `const label = t("editor.orphan");`;
    expect(isLive(fixture(["editor.orphan"], source), "editor.orphan")).toBe(true);
  });

  it("calls a key only a comment names live", () => {
    // The text probe's whole point: no parse resolves a key named in prose,
    // and calling it dead on that basis is how a live string gets deleted.
    const source = `// resolved dynamically to media.loop_on\nconst x = 1;`;
    expect(isLive(fixture([], source), "media.loop_on")).toBe(true);
  });

  it("does not let a longer name rescue a shorter key", () => {
    // Unanchored matching hides 15 dead keys in this repository. Specimens,
    // each a real rescue that anchoring removes:
    for (const [key, text] of [
      ["summary.stories", "const n = summary.stories.new.length;"],
      ["section_title", 't("course.section_title")'],
      ["type_video", 't("media.media_type_video")'],
      ["new_story", 't("new_story_button")'],
      ["see_also", 't("drawer.see_also")'],
    ] as const) {
      expect(namedInText(fixture([], text), key), key).toBe(false);
      expect(text.includes(key), `${key} — unanchored would rescue it`).toBe(true);
    }
  });

  it("resolves a plural form through its base key", () => {
    const source = `t("word_count", { count })`;
    const idx = fixture(["word_count"], source);
    expect(resolvesViaPlural(idx, "word_count_other")).toBe(true);
    expect(isReferenced(idx, "word_count_other")).toBe(false);
  });

  it("does not flag a key built in a template literal when its family is declared", () => {
    // `sync_field.title` is never written out anywhere: the dialog builds it
    // from the field it is rendering. The family is what makes it live.
    const family = families.find((f) => f.ns === "objects" && f.prefix === "sync_field.");
    expect(family).toBeDefined();
    expect(isLive(index, "sync_field.title")).toBe(false);
    expect(familyCovers(family as KeyFamily, "sync_field.title")).toBe(true);
  });

  it("covers a family member's own subtree, for keys read as arrays", () => {
    // `t(key, { returnObjects: true })` asks for one key and reads a list under
    // it, whose leaves are `features.0`, `fixes.1`, and so on.
    const family = families.find((f) => f.ns === "release-notes");
    expect(family).toBeDefined();
    expect(familyCovers(family as KeyFamily, `${(family as KeyFamily).prefix}features.0`)).toBe(true);
  });

  it("excuses nothing outside a family's prefix", () => {
    const family = families.find((f) => f.ns === "common" && f.prefix === "role.");
    expect(familyCovers(family as KeyFamily, "role.convenor")).toBe(true);
    expect(familyCovers(family as KeyFamily, "role.denied_publish")).toBe(false);
  });
});

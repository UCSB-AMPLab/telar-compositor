/**
 * glossary-slug-lock.test.ts — contract spec for the slug
 * auto-derive-until-locked state machine and the term_id uniqueness guard.
 *
 * Slug-lock model: a term_id that equals slugifyTermId(title) is still
 * AUTO (the slug tracks the title); once the user hand-edits term_id so it
 * diverges from slugifyTermId(title), the slug is LOCKED. makeUniqueTermId
 * mirrors makeUniqueSlug semantics (`-2`, `-3`, … suffixes).
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  isSlugLocked,
  effectiveSlug,
  makeUniqueTermId,
} from "~/lib/glossary-slug";

describe("isSlugLocked", () => {
  it("is UNLOCKED when term_id equals slugifyTermId(title)", () => {
    expect(isSlugLocked("encomienda", "Encomienda")).toBe(false);
  });

  it("is LOCKED when term_id has been hand-edited away from the title-derived slug", () => {
    expect(isSlugLocked("enc", "Encomienda")).toBe(true);
  });

  it("treats a multi-word title-derived slug as unlocked", () => {
    expect(isSlugLocked("new-granada-1538", "New Granada (1538)")).toBe(false);
  });
});

describe("effectiveSlug", () => {
  it("follows the title when the slug is unlocked (auto)", () => {
    expect(effectiveSlug("encomienda", "Encomienda Grant", false)).toBe(
      "encomienda-grant",
    );
  });

  it("stays put on the hand-edited term_id when locked", () => {
    expect(effectiveSlug("enc", "Encomienda Grant", true)).toBe("enc");
  });
});

describe("makeUniqueTermId (uniqueness guard)", () => {
  it("returns the candidate unchanged when it does not collide", () => {
    expect(makeUniqueTermId("encomienda", ["mita", "audiencia"])).toBe(
      "encomienda",
    );
  });

  it("appends a -2 suffix when the candidate collides with the existing set", () => {
    expect(makeUniqueTermId("mita", ["mita"])).toBe("mita-2");
  });

  it("walks the suffix forward past consecutive collisions", () => {
    expect(makeUniqueTermId("mita", ["mita", "mita-2", "mita-3"])).toBe(
      "mita-4",
    );
  });
});

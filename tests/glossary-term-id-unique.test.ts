/**
 * glossary-term-id-unique.test.ts — contract spec for the term_id uniqueness
 * guard. makeUniqueTermId mirrors makeUniqueSlug semantics (`-2`, `-3`, …
 * suffixes).
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect } from "vitest";
import { makeUniqueTermId } from "~/lib/glossary-slug";

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

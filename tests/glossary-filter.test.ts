/**
 * glossary-filter.test.ts — contract spec for the `?q=` substring filter
 * predicate.
 *
 * The filter matches a term by recalling a phrase from EITHER its title
 * OR its definition body, case-insensitively. An empty query matches every
 * term (no filtering).
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect } from "vitest";
import { matchesTermFilter } from "~/lib/glossary-filter";

const term = { title: "Encomienda", definition: "A colonial labour grant." };

describe("matchesTermFilter", () => {
  it("matches a case-insensitive substring of the title", () => {
    expect(matchesTermFilter(term, "comi")).toBe(true);
    expect(matchesTermFilter(term, "ENCOMIENDA")).toBe(true);
  });

  it("matches a case-insensitive substring of the definition body", () => {
    expect(matchesTermFilter(term, "labour")).toBe(true);
    expect(matchesTermFilter(term, "COLONIAL")).toBe(true);
  });

  it("matches all terms for an empty query", () => {
    expect(matchesTermFilter(term, "")).toBe(true);
  });

  it("returns false when the query is found in neither title nor definition", () => {
    expect(matchesTermFilter(term, "mita")).toBe(false);
  });
});

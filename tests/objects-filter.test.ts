/**
 * objects-filter.test.ts — contract spec for the objects substring filter
 * predicate.
 *
 * Encodes the contract `app/lib/objects-filter.ts` implements.
 *
 * The filter matches an object by a case-insensitive substring of ANY of its
 * title, creator, year (compared as a string), or object_id. Fields other
 * than object_id are nullable and must NOT throw. An empty query matches
 * every object (no filtering).
 */

import { describe, it, expect } from "vitest";
import { matchesObjectFilter } from "~/lib/objects-filter";

describe("matchesObjectFilter", () => {
  it("matches a case-insensitive substring of the title", () => {
    expect(
      matchesObjectFilter(
        { title: "Mapa de Bogotá", creator: null, year: null, object_id: "mapa-01" },
        "bogot",
      ),
    ).toBe(true);
  });

  it("matches all objects for an empty query", () => {
    expect(
      matchesObjectFilter(
        { title: "Mapa de Bogotá", creator: null, year: null, object_id: "mapa-01" },
        "",
      ),
    ).toBe(true);
  });

  it("matches a substring of the creator without throwing on a null title", () => {
    expect(
      matchesObjectFilter(
        { title: null, creator: "Vélez", year: null, object_id: "x" },
        "vél",
      ),
    ).toBe(true);
  });

  it("matches the year as a string", () => {
    expect(
      matchesObjectFilter(
        { title: null, creator: null, year: "1810", object_id: "x" },
        "1810",
      ),
    ).toBe(true);
  });

  it("matches a substring of the object_id", () => {
    expect(
      matchesObjectFilter(
        { title: null, creator: null, year: null, object_id: "plano-norte" },
        "norte",
      ),
    ).toBe(true);
  });

  it("returns false when the query is found in no field", () => {
    expect(
      matchesObjectFilter(
        { title: "A", creator: "B", year: "1900", object_id: "c" },
        "zzz",
      ),
    ).toBe(false);
  });

  it("does not throw when every nullable field is null", () => {
    expect(
      matchesObjectFilter(
        { title: null, creator: null, year: null, object_id: "only-id" },
        "only",
      ),
    ).toBe(true);
  });
});

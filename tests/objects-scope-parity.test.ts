/**
 * Import and sync must read one file the same way.
 *
 * `parseTelarCsv` resolves a duplicate canonical column only under the sheet's
 * own scope; a caller that omits it gets a different row shape from the same
 * bytes. Import passes a scope and sync did not, so sync diffed the file
 * against the import that produced it, reported the object as changed, and
 * accepting reversed the import's decision and invented a custom column.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  parseTelarCsv,
  mapObjectsCsv,
  OBJECTS_CANONICAL_SCOPE,
  PROJECT_CANONICAL_SCOPE,
  STORY_CANONICAL_SCOPE,
  GLOSSARY_CANONICAL_SCOPE,
} from "~/lib/import.server";
import { comparableExtraColumns } from "~/lib/extra-columns.server";

const CSV = "object_id,title,medium_genre,medium\no1,A,oil,tempera\n";

describe("import and sync read one objects file identically", () => {
  it("agrees on the field and on the extras", () => {
    const rows = parseTelarCsv(CSV, undefined, false, OBJECTS_CANONICAL_SCOPE);
    const mapped = mapObjectsCsv(rows, 1);
    expect(mapped[0].object_type).toBe("tempera");
    expect(mapped[0].extra_columns).toBeUndefined();
    expect(rows[0].medium_genre_1).toBeUndefined();
  });

  // The shape sync used to see: the same bytes, no scope.
  it("differs from an unscoped parse, which is why the scope is passed", () => {
    const unscoped = parseTelarCsv(CSV);
    expect(unscoped[0].medium_genre).toBe("oil");
    expect(unscoped[0].medium_genre_1).toBe("tempera");
  });

  it("exposes a scope for every sheet sync parses", () => {
    for (const scope of [
      OBJECTS_CANONICAL_SCOPE, PROJECT_CANONICAL_SCOPE,
      STORY_CANONICAL_SCOPE, GLOSSARY_CANONICAL_SCOPE,
    ]) {
      expect(scope.size).toBeGreaterThan(0);
    }
  });
});

describe("a modelled key that escaped the repair cannot fabricate a diff", () => {
  // After the repair there are none: it resolves every modelled key at load,
  // and the export guard keeps any survivor out of the published file. Dropping
  // them from both sides is defence for a blob that reached a comparison
  // without having been through the repair.
  const escaped = JSON.stringify({ medium: "oil", notes: "mine" });
  const published = JSON.stringify({ notes: "mine" });

  it("reports no difference against the published file", () => {
    expect(comparableExtraColumns(escaped)).toBe(comparableExtraColumns(published));
  });

  it("still sees a real change to the author's own column", () => {
    const edited = JSON.stringify({ medium: "oil", notes: "changed" });
    expect(comparableExtraColumns(edited)).not.toBe(comparableExtraColumns(published));
  });

  it("still sees the author deleting their last custom column", () => {
    expect(comparableExtraColumns(published)).not.toBe(comparableExtraColumns(null));
  });

  // "No columns left" and "no blob" are one state and must compare as one,
  // or a blob holding only modelled keys reports a change against an absent
  // one — a two-way diff, a three-way editor-only count, and a false conflict
  // as soon as the repo side adds a column of its own.
  it.each([
    ["a blob of only modelled keys", '{"medium":"oil"}'],
    ["a blob of several modelled keys", '{"medium":"oil","tipo_objeto":"tempera"}'],
    ["a literal empty object", "{}"],
  ])("compares %s as an absent blob", (_label, blob) => {
    expect(comparableExtraColumns(blob)).toBe("");
    expect(comparableExtraColumns(blob)).toBe(comparableExtraColumns(null));
  });
});

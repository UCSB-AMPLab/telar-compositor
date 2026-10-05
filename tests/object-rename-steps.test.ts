/**
 * Which step values a rename rewrites: every value the site shows the object
 * for, under the sheet's order or D1's, and inside a collision only the values
 * whose trimmed form is exactly the old id.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { renameInsideCollision, renameStepValues } from "~/lib/object-rename-steps";

const renameRows = (ids: string[]) => ids.map((object_id) => ({ object_id }));
const VERSION = "1.8.0";

describe("renameInsideCollision", () => {
  it("is false for an id repeated in several rows", () => {
    expect(renameInsideCollision("map", { sheet: renameRows(["map", "map"]), d1: renameRows(["map"]), version: VERSION })).toBe(false);
  });

  it("is true when another row shares the site id in either order", () => {
    expect(renameInsideCollision("map", { sheet: renameRows(["map", "map.jpg"]), d1: renameRows(["map"]), version: VERSION })).toBe(true);
    expect(renameInsideCollision("map", { sheet: renameRows(["map"]), d1: renameRows(["map", "map.jpg"]), version: VERSION })).toBe(true);
  });
});

describe("renameStepValues", () => {
  it("takes every value the site shows the object for: exact, with an extension, and in another case", () => {
    const values = renameStepValues("map", ["map", "map.jpg", "MAP", " map ", "plan", null, ""], {
      sheet: renameRows(["map", "plan"]),
      d1: renameRows(["map", "plan"]),
      version: VERSION,
    });
    expect(values).toEqual(["map", "map.jpg", "MAP", " map "]);
  });

  it("unions the two orders: a value only D1's rows map to the object", () => {
    // `Map` alone in the sheet takes `MAP`; in D1 only `map` exists, so `MAP` folds to it.
    const values = renameStepValues("map", ["MAP"], {
      sheet: renameRows(["Map"]),
      d1: renameRows(["map"]),
      version: VERSION,
    });
    expect(values).toEqual(["MAP"]);
    expect(renameStepValues("map", ["MAP"], { sheet: renameRows(["Map"]), d1: renameRows(["Map"]), version: VERSION })).toEqual([]);
  });

  it("inside a collision takes only the values that are the old id once trimmed", () => {
    const values = renameStepValues("map", ["map", " map", "map.jpg", "MAP"], {
      sheet: renameRows(["map", "map.jpg"]),
      d1: renameRows(["map", "map.jpg"]),
      version: VERSION,
    });
    expect(values).toEqual(["map", " map"]);
  });

  it("does not treat a repeated id as a collision", () => {
    const values = renameStepValues("map", ["map.jpg", "map"], {
      sheet: renameRows(["map", "map"]),
      d1: renameRows(["map"]),
      version: VERSION,
    });
    expect(values).toEqual(["map.jpg", "map"]);
  });
});

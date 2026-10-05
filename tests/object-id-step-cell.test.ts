/**
 * A step's `object` cell as the framework's reference pass leaves it in the
 * story JSON (`_validate_object_references`, stories.py), which is the value
 * `_buildSceneMaps` groups scenes by.
 *
 * The pass trims the cell to look it up and never writes the trimmed value
 * back on its own: it writes the cell only when an extension comes off (the
 * trimmed, stripped value) or when the value matches an object only
 * case-insensitively (that object's id). Otherwise the cell stays as read,
 * whitespace included.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { stepObjectCellResolver } from "~/lib/object-id";

const cellOf = (objects: Array<{ object_id: string }>, cell: string, version: string | null = "1.7.0") =>
  stepObjectCellResolver(objects, version)(cell);

describe("stepObjectCellResolver", () => {
  const map = [{ object_id: "map" }];

  it("writes the stripped value, or the matched id, when an extension comes off", () => {
    expect(cellOf(map, "map.jpg")).toBe("map");
    expect(cellOf(map, "MAP.JPG")).toBe("map");
    expect(cellOf(map, " map.jpg")).toBe("map");
  });

  it("writes the matched id on a case-insensitive match", () => {
    expect(cellOf(map, "MAP")).toBe("map");
  });

  it("leaves the cell as read on an exact match with no extension", () => {
    expect(cellOf(map, "map")).toBe("map");
    expect(cellOf(map, " map")).toBe(" map");
  });

  it("leaves a cell matching nothing as read, and writes the stripped value when an extension came off", () => {
    expect(cellOf([], " ghost")).toBe(" ghost");
    expect(cellOf([], "ghost.jpg")).toBe("ghost");
  });

  it("leaves a cell that trims to nothing as read", () => {
    expect(cellOf(map, "   ")).toBe("   ");
    expect(cellOf(map, "")).toBe("");
  });

  it("takes, among ids differing only in case, the one whose site id first appeared later", () => {
    expect(cellOf([{ object_id: "Map" }, { object_id: "MAP" }], "map")).toBe("MAP");
    expect(cellOf([{ object_id: "MAP" }, { object_id: "Map" }], "map")).toBe("Map");
  });

  it("matches against site ids, and strips by the site's version", () => {
    expect(cellOf([{ object_id: "map.jpg" }], "MAP")).toBe("map");
    expect(cellOf([{ object_id: "map" }], "MAP.HEIC", "1.8.0")).toBe("map");
    expect(cellOf([{ object_id: "map" }], "MAP.HEIC", "1.7.0")).toBe("MAP.HEIC");
  });

  // pandas' default `na_values` (`STR_NA_VALUES`), which `read_csv` at v1.7.0
  // and before reads as missing and the stories processor fills with "".
  const tokens = [
    "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan", "1.#IND", "1.#QNAN",
    "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null",
  ];

  it("reads each missing-value token as an empty cell before 1.8.0 and on a site with no version", () => {
    const objects = [{ object_id: "NA" }, { object_id: "null" }];
    for (const token of tokens) {
      expect(cellOf(objects, token, "1.7.0")).toBe("");
      expect(cellOf(objects, token, null)).toBe("");
    }
  });

  it("reads a token as written from 1.8.0", () => {
    expect(cellOf([{ object_id: "NA" }], "NA", "1.8.0")).toBe("NA");
    expect(cellOf([], "None", "1.8.0")).toBe("None");
  });

  it("matches a token exactly, as pandas does", () => {
    expect(cellOf([], " NA", "1.7.0")).toBe(" NA");
    expect(cellOf([], "Na", "1.7.0")).toBe("Na");
    expect(cellOf([], "NONE", "1.7.0")).toBe("NONE");
  });
});

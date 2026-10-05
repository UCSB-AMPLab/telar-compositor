/**
 * What a cell's edges hold, on the path from the sheet to D1.
 *
 * The framework reads every cell with pandas and weighs it with CPython's
 * `str.strip()`, which keeps U+FEFF. JavaScript's `trim()` removes it. A cell
 * that is exactly the mark is therefore an object to the framework and an empty
 * cell to a reader trimming it, and a cell edged with one keeps the mark there
 * and loses it here — so a site is built from an object the Compositor never
 * imported, and republishes it under a spelling the sheet never had.
 *
 * `pythonStrip` is the one fold both sides can share, so every emptiness or
 * edge question asked of a CELL is asked under it. The two `trim()` calls left
 * in the importer gate warning TEXT — which cell a ragged-row message names,
 * and whether a blank-headed column is worth a warning — where the question is
 * what a reader can find in their spreadsheet, not what the framework builds.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { parseTelarCsv, mapObjectsCsv, OBJECTS_CANONICAL_SCOPE } from "~/lib/import.server";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
  describeWithFrameworkTag,
  frameworkObjectsRead,
  frameworkScriptsAtTag,
} from "./helpers/framework-checkout";

/** The mark CPython keeps and JavaScript removes. */
const MARK = "﻿";

/** An objects sheet whose first id is exactly the mark. */
const MARK_ID = `object_id,title\n${MARK},X\na,A\n`;

/** An objects sheet whose custom column holds the mark at both edges. */
const MARK_EDGED_VALUE = `object_id,notes\na,${MARK}X${MARK}\n`;

/** An objects sheet whose custom column holds nothing but the mark. */
const MARK_ONLY_VALUE = `object_id,notes\na,${MARK}\n`;

function mapped(csv: string) {
  return mapObjectsCsv(parseTelarCsv(csv, undefined, false, OBJECTS_CANONICAL_SCOPE));
}

function extras(csv: string): Record<string, string> {
  const blob = mapped(csv)[0]?.extra_columns;
  return blob ? (JSON.parse(blob) as Record<string, string>) : {};
}

describe("a cell the mark is all of", () => {
  it("is an object, not an empty id", () => {
    expect(mapped(MARK_ID).map((row) => row.object_id)).toEqual([MARK, "a"]);
  });

  it("is a custom value worth storing", () => {
    expect(extras(MARK_ONLY_VALUE)).toEqual({ notes: MARK });
  });
});

describe("a cell the mark edges", () => {
  it("keeps its marks in the stored value", () => {
    expect(extras(MARK_EDGED_VALUE)).toEqual({ notes: `${MARK}X${MARK}` });
  });
});

describeWithFrameworkTag(PUBLISHED_FRAMEWORK_TAG, "the framework reading the same cells", () => {
  const releases: Array<[string, () => string]> = [
    ["the test instance", () => FRAMEWORK_SCRIPTS_DIR],
    [PUBLISHED_FRAMEWORK_TAG, () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG)],
  ];

  for (const [release, scripts] of releases) {
    it(
      `builds both objects out of the mark-id sheet on ${release}`,
      () => {
        expect(frameworkObjectsRead(MARK_ID, scripts()).ids).toEqual([MARK, "a"]);
        expect(mapped(MARK_ID).map((row) => row.object_id)).toEqual(
          frameworkObjectsRead(MARK_ID, scripts()).ids,
        );
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  }
});

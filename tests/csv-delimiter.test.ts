/**
 * The delimiter every reading of a Telar CSV splits on.
 *
 * The framework reads every one of its CSVs with `pd.read_csv` and passes no
 * `sep`, so pandas splits on a comma and on nothing else — at the test instance
 * and at `PUBLISHED_FRAMEWORK_TAG` alike. A Compositor that lets Papa GUESS the
 * delimiter therefore reads a different file from the one the site is built
 * from whenever the guess lands anywhere but the comma, and a one-column export
 * whose cells happen to hold two semicolons or two tabs is enough to land it
 * there: the ids the importer stores are then cell fragments the framework
 * never sees, and the rest of each row is discarded.
 *
 * The cases here are the shapes that separate a guess from the comma, measured
 * against the framework at both releases rather than asserted from the spec.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { parseTelarCsv, mapObjectsCsv, OBJECTS_CANONICAL_SCOPE } from "~/lib/import.server";
import { serializeObjectsCsv } from "~/lib/csv-export.server";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
  describeWithFrameworkTag,
  frameworkObjectsRead,
  frameworkScriptsAtTag,
} from "./helpers/framework-checkout";

/** A one-column export whose every cell holds two semicolons. */
const SEMICOLON_CELLS = "object_id\na;x;y\nb;x;y\nc;x;y\n";

/** A one-column export whose every cell holds a tab. */
const TAB_CELLS = "object_id\ta\nb\tc\n";

/**
 * A semicolon file carrying a quote that opens in one dialect and not the
 * other: under the comma the `"` sits inside the field `#note;"first`, so the
 * record ends at the line break and `phantom"` is a row of its own.
 */
const SEMICOLON_MULTILINE = 'object_id;title\n#note;"first\nphantom"\na;A\nb;B\n';

/** The first column's cells, whatever the header row calls that column. */
function firstColumnCells(csv: string): string[] {
  const rows = parseTelarCsv(csv, undefined, false, OBJECTS_CANONICAL_SCOPE);
  if (rows.length === 0) return [];
  const name = Object.keys(rows[0])[0];
  return rows.map((row) => row[name] ?? "");
}

describe("a file the comma reads as one column", () => {
  it("keeps a cell's semicolons inside the cell", () => {
    expect(firstColumnCells(SEMICOLON_CELLS)).toEqual(["a;x;y", "b;x;y", "c;x;y"]);
  });

  it("stores those ids whole", () => {
    const ids = mapObjectsCsv(
      parseTelarCsv(SEMICOLON_CELLS, undefined, false, OBJECTS_CANONICAL_SCOPE),
    ).map((row) => row.object_id);
    expect(ids).toEqual(["a;x;y", "b;x;y", "c;x;y"]);
  });

  it("keeps a cell's tab inside the cell", () => {
    expect(firstColumnCells(TAB_CELLS)).toEqual(["b\tc"]);
  });

  it("reads a semicolon file's rows as the comma bounds them", () => {
    expect(firstColumnCells(SEMICOLON_MULTILINE)).toEqual(['phantom"', "a;A", "b;B"]);
  });

  // A file read one way and republished another loses rows on every pass. The
  // second publish is built from the first's output, so an unstable pair is a
  // file that never settles.
  it("republishes a semicolon file to a fixed point", () => {
    const once = serializeObjectsCsv([], SEMICOLON_MULTILINE);
    expect(serializeObjectsCsv([], once)).toBe(once);
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the framework reading the same files",
  () => {
    const releases: Array<[string, () => string]> = [
      ["test instance", () => FRAMEWORK_SCRIPTS_DIR],
      [PUBLISHED_FRAMEWORK_TAG, () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG)],
    ];

    for (const [release, scripts] of releases) {
      it(
        `splits ${release} on the comma alone`,
        () => {
          expect(frameworkObjectsRead(SEMICOLON_CELLS, scripts()).ids).toEqual(
            firstColumnCells(SEMICOLON_CELLS),
          );
          expect(frameworkObjectsRead(TAB_CELLS, scripts()).ids).toEqual(
            firstColumnCells(TAB_CELLS),
          );
          expect(frameworkObjectsRead(SEMICOLON_MULTILINE, scripts()).ids).toEqual(
            firstColumnCells(SEMICOLON_MULTILINE),
          );
        },
        FRAMEWORK_TIMEOUT_MS,
      );

      it(
        `holds one column for a tab file at ${release}`,
        () => {
          expect(frameworkObjectsRead(TAB_CELLS, scripts()).columns).toEqual(["object_id\ta"]);
        },
        FRAMEWORK_TIMEOUT_MS,
      );
    }
  },
);

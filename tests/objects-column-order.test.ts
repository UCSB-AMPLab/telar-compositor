/**
 * This file pins the order objects.csv's custom columns are written in.
 *
 * An object's kept columns are a JSON object keyed by header, and JavaScript
 * lists an integer-like key before every other whatever order it was written
 * in, so a sheet headed `2020` then `1990` came back from a publish as
 * `1990,2020`. The file on GitHub is the one record of the author's order, and
 * every writer of objects.csv has it: its custom columns keep their places in
 * the file, and the fixed columns it lacks are appended after them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { OBJECTS_CSV_COLUMNS, serializeObjectsCsv } from "~/lib/csv-export.server";
import type { ObjectRow } from "~/lib/csv-export.server";

function object(extras: Record<string, string>): ObjectRow {
  return {
    object_id: "obj-1",
    title: "Un objeto",
    featured: null,
    creator: null,
    description: null,
    source_url: null,
    period: null,
    year: null,
    medium_genre: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    alt_text: null,
    dimensions: null,
    extra_columns: JSON.stringify(extras),
  };
}

const header = (csv: string) => csv.split("\n")[0].split(",");

/** The fixed columns after `title`, which a file headed only `object_id,title` lacks. */
const AFTER_TITLE = OBJECTS_CSV_COLUMNS.slice(2);

describe("objects.csv's custom columns", () => {
  it("keep the order the existing file has them in, integer-like headers included", () => {
    const existing = "object_id,title,notes,2020,1990\nobj-1,Un objeto,n,a,b\n";

    const csv = serializeObjectsCsv([object({ notes: "n", "2020": "a", "1990": "b" })], existing);

    expect(header(csv)).toEqual(["object_id", "title", "notes", "2020", "1990", ...AFTER_TITLE]);
    expect(csv.split("\n").at(-1)).toMatch(/^obj-1,Un objeto,n,a,b,/);
  });

  it("put a column the file lacks after the ones it has", () => {
    const existing = "object_id,title,zeta,alfa\nobj-1,Un objeto,z,a\n";

    const csv = serializeObjectsCsv([object({ alfa: "a", zeta: "z", beta: "b" })], existing);

    expect(header(csv)).toEqual(["object_id", "title", "zeta", "alfa", ...AFTER_TITLE, "beta"]);
  });

  it("match a header with space around it as the import names it", () => {
    const existing = "object_id,title, zeta ,alfa\nobj-1,Un objeto,z,a\n";

    const csv = serializeObjectsCsv([object({ alfa: "a", zeta: "z" })], existing);

    expect(header(csv)).toEqual(["object_id", "title", "zeta", "alfa", ...AFTER_TITLE]);
  });

  it("keep a repeated header's place under the name the import gives it", () => {
    const existing = "object_id,title,2020,2020,1990\nobj-1,Un objeto,a,b,c\n";

    const csv = serializeObjectsCsv(
      [object({ "2020": "a", "2020_1": "b", "1990": "c" })],
      existing,
    );

    expect(header(csv)).toEqual(["object_id", "title", "2020", "2020_1", "1990", ...AFTER_TITLE]);
    expect(csv.split("\n").at(-1)).toMatch(/^obj-1,Un objeto,a,b,c,/);
  });

  it("follow the order given when there is no file", () => {
    const csv = serializeObjectsCsv([object({ zeta: "z", alfa: "a" })]);

    expect(header(csv).slice(-2)).toEqual(["alfa", "zeta"]);
  });
});

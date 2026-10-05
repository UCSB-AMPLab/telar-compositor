/**
 * Two header cells that strip to one canonical name but differ in the file,
 * such as `title` beside ` title `.
 *
 * pandas keeps them as two columns, both rename to `title`, and the
 * framework's collision check refuses the sheet (`_refuse_colliding_renames`,
 * scripts/telar/csv_utils.py). So the import applies the collision rule to
 * them, as it does to `Title` beside `title`, and publishes one `title`
 * column. A cell repeated with the same text as the file has it, spaces and
 * all, is the author's repeated column: pandas reads it as `.1` and the
 * framework builds it, so the second is kept as `title_1`.
 *
 * A custom name is outside the collision rule: `notes` and ` notes ` are
 * stored as `notes` and `notes_1`, and the publish writes a file the framework
 * builds.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  CollidingColumnsRefusal,
  OBJECTS_CANONICAL_SCOPE,
  parseTelarCsv,
  resolvedColumnPosition,
  type ParseTelarCsvOptions,
} from "~/lib/import.server";
import type { SheetIssue } from "~/lib/sheet-warnings";

function parseObjectsSheet(csv: string, options: ParseTelarCsvOptions = {}) {
  const warnings: SheetIssue[] = [];
  const rows = parseTelarCsv(csv, (issue) => warnings.push(issue), false, OBJECTS_CANONICAL_SCOPE, options);
  // These cases are about the collision; the heading report has its own tests.
  return { rows, warnings: warnings.filter((w) => w.code !== "header_spelling") };
}

/** What `fn` throws, or undefined when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("a canonical header beside the same header with spaces round it", () => {
  it("keeps the one that holds values and says the other was empty", () => {
    const { rows, warnings } = parseObjectsSheet("object_id,title, title \no1,,Kept\n");
    expect(rows[0]).toEqual({ object_id: "o1", title: "Kept" });
    expect(warnings).toEqual([
      {
        code: "column_collision_only_filled",
        name: "title",
        headers: ["title", "title"],
        kept: "title",
        column: 3,
      },
    ]);
  });

  it.each([
    ["a tab", "title\t"],
    ["a trailing space", "title "],
    ["a no-break space", "title "],
  ])("does the same for %s after the header", (_label, spaced) => {
    const { rows, warnings } = parseObjectsSheet(`object_id,title,${spaced}\no1,,Kept\n`);
    expect(rows[0]).toEqual({ object_id: "o1", title: "Kept" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "column_collision_only_filled", column: 3 });
  });

  it("keeps the first and says nothing when neither holds values", () => {
    const { rows, warnings } = parseObjectsSheet("object_id,title, title \no1,,\n");
    expect(Object.keys(rows[0])).toEqual(["object_id", "title"]);
    expect(warnings).toEqual([]);
    expect(resolvedColumnPosition(
      [["object_id", "title", " title "], ["o1", "", ""]], "title", OBJECTS_CANONICAL_SCOPE,
    )).toBe(1);
  });

  it("is refused when both hold values and the caller asks for refusal", () => {
    const outcome = thrownBy(() =>
      parseObjectsSheet("object_id,title, title \no1,A,B\n", { severalHoldValues: "refuse", sheetName: "objects.csv" }),
    );
    expect(outcome).toBeInstanceOf(CollidingColumnsRefusal);
    expect((outcome as CollidingColumnsRefusal).headers).toEqual(["title", "title"]);
  });

  it("keeps the last when both hold values under keep-last, and says so", () => {
    const { rows, warnings } = parseObjectsSheet("object_id,title, title \no1,A,B\n");
    expect(rows[0]).toEqual({ object_id: "o1", title: "B" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "column_collision_last", headers: ["title", "title"], column: 3 });
  });

  // The framework reads `title,title` as `title` and `title.1`: the repeat is
  // a column of its own, and the collision is between the first `title` and
  // ` title `.
  it("suffixes a literal repeat and applies the rule to the first of each text", () => {
    const { rows, warnings } = parseObjectsSheet("object_id,title,title, title \no1,,second,Kept\n");
    expect(rows[0]).toEqual({ object_id: "o1", title_1: "second", title: "Kept" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "column_collision_only_filled", headers: ["title", "title"] });
  });

  it("suffixes both repeats and drops the empty spaced column", () => {
    const { rows, warnings } = parseObjectsSheet("object_id,title,title, title , title \no1,A,B,,C\n");
    expect(rows[0]).toEqual({ object_id: "o1", title: "A", title_1: "B", title_2: "C" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "column_collision_only_filled", kept: "title", column: 2 });
  });
});

describe("header text repeated exactly as the file has it", () => {
  // pandas reads ` title , title ` as ` title ` and ` title .1`, and the
  // framework builds the sheet with both values.
  it("keeps both values of a spaced header repeated with the same spaces", () => {
    const { rows, warnings } = parseObjectsSheet("object_id, title , title \no1,A,B\n");
    expect(rows[0]).toEqual({ object_id: "o1", title: "A", title_1: "B" });
    expect(warnings).toEqual([]);
  });

  it("keeps a custom column beside its spaced twin under a suffix", () => {
    const { rows, warnings } = parseObjectsSheet("object_id,notes, notes \no1,x,y\n");
    expect(rows[0]).toEqual({ object_id: "o1", notes: "x", notes_1: "y" });
    expect(warnings).toEqual([]);
  });
});

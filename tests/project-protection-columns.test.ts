/**
 * This file pins how the project sheet's protection columns decide whether a
 * story is private when the sheet carries more than one of them.
 *
 * The framework renames every protection spelling to `protected` and refuses
 * a sheet in which two different headers arrive at it, so a story marked
 * `no` in one column and `yes` in another does not build. The Compositor
 * follows the rule it uses for every other canonical name: one column holding
 * values decides, and several make the import and the sync refuse the sheet.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  CollidingColumnsRefusal,
  PROJECT_CANONICAL_SCOPE,
  mapProjectCsv,
  parseTelarCsv,
} from "~/lib/import.server";
import type { SheetIssue } from "~/lib/sheet-warnings";

function importProject(csv: string, onWarning?: (issue: SheetIssue) => void) {
  return parseTelarCsv(csv, onWarning, true, PROJECT_CANONICAL_SCOPE, {
    severalHoldValues: "refuse",
    sheetName: "project.csv",
  });
}

describe("the project sheet's protection columns", () => {
  it("refuse the sheet when two different spellings both hold values, naming them", () => {
    const csv = "story_id,title,private,protegido\ns1,Uno,no,yes\n";

    let refusal: unknown;
    try {
      importProject(csv);
    } catch (err) {
      refusal = err;
    }

    expect(refusal).toBeInstanceOf(CollidingColumnsRefusal);
    expect((refusal as CollidingColumnsRefusal).sheet).toBe("project.csv");
    expect((refusal as CollidingColumnsRefusal).headers).toEqual(["private", "protegido"]);
  });

  it("take the value of the only one holding values, and say so", () => {
    const warnings: SheetIssue[] = [];
    const csv = "story_id,title,private,protegido\ns1,Uno,,yes\ns2,Dos,,\n";

    const stories = mapProjectCsv(importProject(csv, (issue) => warnings.push(issue)));

    expect(stories.map((s) => s.private)).toEqual([true, false]);
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "column_collision_only_filled", kept: "protegido" }),
    );
  });

  it("read a header repeated with the same text as a column of its own, as the framework does", () => {
    const csv = "story_id,title,private,private\ns1,Uno,,yes\n";

    const stories = mapProjectCsv(importProject(csv));

    expect(stories[0].private).toBe(false);
  });

  it("read headers that differ only in surrounding space as two columns, as pandas does", () => {
    const csv = "story_id,title,private, private \ns1,Uno,no,yes\n";

    expect(() => importProject(csv)).toThrow(CollidingColumnsRefusal);
  });

  it("count a sparse Spanish header row as data, as the framework does", () => {
    const csv = "story_id,private,privada\nid_historia,privada,\ns1,,yes\n";

    expect(() => importProject(csv)).toThrow(CollidingColumnsRefusal);
  });

  it("keep the last one, with a warning, where a reader does not refuse", () => {
    const warnings: SheetIssue[] = [];
    const csv = "story_id,title,private,protegido\ns1,Uno,yes,no\n";

    const rows = parseTelarCsv(csv, (issue) => warnings.push(issue), true, PROJECT_CANONICAL_SCOPE);

    expect(mapProjectCsv(rows)[0].private).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({ code: "column_collision_last" }));
  });

  it("leave a sheet with one protection column as it was", () => {
    const csv = "story_id,title,protegido\ns1,Uno,sí\ns2,Dos,no\n";

    expect(mapProjectCsv(importProject(csv)).map((s) => s.private)).toEqual([true, false]);
  });
});

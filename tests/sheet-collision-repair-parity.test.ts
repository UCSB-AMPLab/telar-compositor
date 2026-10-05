/**
 * The ported 1.8.0 column repair against the framework's own, recorded in
 * tests/fixtures/sheet-collision-repair.json by the generator beside it (run
 * `npm run parity:regenerate -- --check` when the framework moves).
 *
 * For every recorded site: the sheets checked and the role each is read in;
 * each sheet's text after the repair; the framework's records, in order; and
 * the outcome the upgrade takes for each sheet, which has to follow from those
 * records. For every recorded reading: the cells, the split, the skipped
 * lines, the header, pandas' labels, and the data rows and claimed names under
 * each role's scoping. Runs from the fixture, without the framework checkout.
 *
 * @version v1.5.0-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FRAMEWORK_GLOSSARY_COLUMN_ALIASES,
  FrameworkSheetUnreadableError,
  SPREADSHEETS_DIR,
  claimedNames,
  dataRows,
  headerRowRecord,
  readFrameworkSheet,
  type SheetScope,
} from "~/lib/framework-sheet.server";
import { FRAMEWORK_OBJECT_FIELDS } from "~/lib/import.server";
import {
  frameworkRecordOf,
  repairSheet,
  sheetsToCheck,
  type RepairSheetResult,
  type SheetRole,
} from "~/lib/sheet-collision-repair.server";
import { textAfter } from "./helpers/sheet-repair-site";

type Record3 = [string, string[], "applied" | "failed"];

interface Fixture {
  framework_commit: string;
  cases: {
    name: string;
    sheets: Record<string, string>;
    checked: { name: string; role: SheetRole; records: Record3[]; after: string; split: boolean | null }[];
  }[];
  readings: ({ name: string; text: string } & (
    | { error: string }
    | {
        bom: boolean;
        rows: string[][];
        records: [string[], string][] | null;
        skipped: boolean[];
        header_at: number;
        labels: string[];
        data_rows: Record<SheetRole, string[][]>;
        claimed_names: Record<SheetRole, [string, number[]][]>;
      }
  ))[];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "sheet-collision-repair.json"), "utf-8"),
) as Fixture;

const SCOPES: Record<SheetRole, SheetScope> = {
  project: {},
  story: {},
  objects: { canonicalFields: FRAMEWORK_OBJECT_FIELDS },
  glossary: { sheetAliases: FRAMEWORK_GLOSSARY_COLUMN_ALIASES },
};

/** A record as compared: an unreadable sheet's error is the framework's own wording, so only its sheet is. */
function comparable([key, args, status]: Record3): Record3 {
  return key === "v180_sheet_unreadable" ? [key, args.slice(0, 1), status] : [key, args, status];
}

/** The record the framework writes where it stops to keep a second header row recognised. */
const HEADER_ROW_REFUSAL = "v180_column_kept_for_header_row";

/**
 * The outcome the upgrade must take for a sheet, read off what the framework
 * did to it, first match winning as `repairSheet` documents.
 */
function outcomeFor(records: Record3[], split: boolean | null, changed: boolean): RepairSheetResult["kind"] {
  const keys = new Set(records.map(([key]) => key));
  const grouped = ["v180_column_not_removed", HEADER_ROW_REFUSAL, "v180_columns_hold_values"];
  if (keys.has("v180_sheet_unreadable")) return "sheet_unreadable_for_repair";
  if (split === false && grouped.some((key) => keys.has(key))) return "sheet_unreadable_for_repair";
  if (keys.has("v180_reserved_column")) return "sheet_reserved_column";
  if (keys.has("v180_column_not_removed") || keys.has(HEADER_ROW_REFUSAL)) return "sheet_rows_changed";
  if (keys.has("v180_columns_hold_values")) return "needs_choices";
  return changed ? "repaired" : "unchanged";
}

/**
 * The cells of `input` as the repair should leave them where it deleted the second header row: the
 * rows `csv.reader` gives, less that row, less each column the repair reports dropped (by its
 * first-read position), and with `#` before each header it reports marked.
 */
function withoutColumnsAndHeaderRow(input: string, role: SheetRole, result: RepairSheetResult): string[][] {
  const sheet = readFrameworkSheet(input);
  const at = headerRowRecord(sheet, SCOPES[role].sheetAliases);
  const dropped = new Set(result.report.flatMap((e) => (e.kind === "dropped" ? [e.position] : [])));
  const marked = new Set(result.report.flatMap((e) => (e.kind === "marked" ? [e.position] : [])));
  return sheet.rows.flatMap((row, r) => {
    if (r === at) return [];
    if (sheet.skipped[r]) return [row];
    return [row.flatMap((cell, i) => (dropped.has(i) ? [] : [marked.has(i) && r === sheet.headerAt ? `#${cell}` : cell]))];
  });
}

describe(`the column repair against the framework's (recorded at ${fixture.framework_commit.slice(0, 8)})`, () => {
  it("records enough of each kind to mean something", () => {
    const kinds = new Set(fixture.cases.flatMap((c) => c.checked.flatMap((s) => s.records.map(([key]) => key))));
    expect([...kinds].sort()).toEqual([
      "v180_column_dropped", "v180_column_dropped_all_empty", HEADER_ROW_REFUSAL,
      "v180_column_marked_note", "v180_column_not_removed", "v180_columns_hold_values",
      "v180_reserved_column", "v180_sheet_unreadable",
    ]);
    expect(fixture.cases.length).toBeGreaterThan(700);
  });

  it("finds no sheet to check on a site without sheets", () => {
    // The framework's site-level `v180_sheets_clean` record, written when no
    // sheet needs anything, is the caller's to write: repairSheet reports on
    // one sheet, and a site with none never calls it.
    const recorded = fixture.cases.find((c) => c.name === "TestReportsWithoutRepair: no sheets");
    expect(recorded?.checked).toEqual([]);
    expect(sheetsToCheck([])).toEqual([]);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, recorded) => {
    const paths = Object.keys(recorded.sheets).map((name) => `${SPREADSHEETS_DIR}/${name}`);
    const checked = sheetsToCheck(paths);
    expect(checked.map(({ name, role }) => [name, role])).toEqual(recorded.checked.map(({ name, role }) => [name, role]));
    checked.forEach(({ path, name, role }, i) => {
      const want = recorded.checked[i];
      const input = recorded.sheets[name];
      const result = repairSheet({ path, text: input, role });
      const after = textAfter(result, input);
      const deleted = result.report.some((e) => e.kind === "header_row_deleted");
      if (deleted) {
        // The one place the port goes past the framework's repair: where the framework stops to keep
        // the second header row recognised and deleting the row leaves every surviving cell published as
        // before, the port deletes the row. The framework left the sheet as it was, so what holds is
        // that the text is the input less the removed columns and that row, and the outcome follows
        // from the framework's other records.
        expect(want.records.some(([key]) => key === HEADER_ROW_REFUSAL), `${name}: the framework stopped for the row`).toBe(true);
        expect(readFrameworkSheet(after).rows, `${name}: the cells afterwards`).toEqual(withoutColumnsAndHeaderRow(input, role, result));
        const others = want.records.filter(([key]) => key !== HEADER_ROW_REFUSAL);
        // Every record the framework wrote for the columns it did repair has to be in the report too;
        // the port's own extra records are for the columns the framework refused. A deletion record
        // names the column kept in its place, which the port may itself have removed in a later pass
        // the framework refused, so for a deletion the column and the sheet have to match.
        const ours = result.report.map(frameworkRecordOf).flatMap((r) => (r ? [comparable([r.key, r.args, r.status])] : []));
        const isDeletion = (key: string) => key === "v180_column_dropped" || key === "v180_column_dropped_all_empty";
        for (const record of others) {
          const found = ours.some(
            (r) => JSON.stringify(r) === JSON.stringify(comparable(record)) || (isDeletion(r[0]) && isDeletion(record[0]) && r[1][0] === record[1][0] && r[1][1] === record[1][1]),
          );
          expect(found, `${name}: the framework's record ${JSON.stringify(record)} is in the report`).toBe(true);
        }
        expect(result.kind, `${name}: the outcome`).toBe(outcomeFor(others, want.split, true));
        return;
      }
      expect(after, `${name}: the text afterwards`).toBe(want.after);
      const records = result.report.map(frameworkRecordOf).map((r) => (r ? ([r.key, r.args, r.status] as Record3) : null));
      expect(records.map((r) => r && comparable(r)), `${name}: the records`).toEqual(want.records.map(comparable));
      expect(result.kind, `${name}: the outcome`).toBe(outcomeFor(want.records, want.split, want.after !== input));
    });
  });

  it.each(fixture.readings.map((r) => [r.name, r] as const))("reads %s as Sheet does", (_name, want) => {
    let sheet;
    try {
      sheet = readFrameworkSheet(want.text);
    } catch (error) {
      expect(error).toBeInstanceOf(FrameworkSheetUnreadableError);
      expect(want).toHaveProperty("error");
      return;
    }
    if ("error" in want) throw new Error(`read, where the framework raised ${want.error}`);
    expect({
      bom: sheet.bom,
      rows: sheet.rows,
      records: sheet.records?.map((r) => [r.fields, r.ending]) ?? null,
      skipped: sheet.skipped,
      header_at: sheet.headerAt,
      labels: sheet.labels,
    }).toEqual({
      bom: want.bom, rows: want.rows, records: want.records, skipped: want.skipped,
      header_at: want.header_at, labels: want.labels,
    });
    for (const role of Object.keys(SCOPES) as SheetRole[]) {
      expect(dataRows(sheet, SCOPES[role].sheetAliases), `data rows as ${role}`).toEqual(want.data_rows[role]);
      expect([...claimedNames(sheet.labels, SCOPES[role])], `claimed names as ${role}`).toEqual(want.claimed_names[role]);
    }
  });
});

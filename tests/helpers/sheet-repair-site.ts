/**
 * Runs the ported 1.8.0 column repair over a site's sheets the way the
 * framework's `repair_colliding_columns` runs over a site directory: every
 * sheet `sheetsToCheck` finds, in its order, each repaired, and the records
 * concatenated, `v180_sheets_clean` standing for none.
 *
 * @version v1.5.0-beta
 */
import { SPREADSHEETS_DIR } from "~/lib/framework-sheet.server";
import {
  frameworkRecordOf,
  repairSheet,
  sheetsToCheck,
  type ColumnChoice,
  type RepairOptions,
  type RepairSheetResult,
} from "~/lib/sheet-collision-repair.server";

export interface FrameworkRecord {
  key: string;
  args: string[];
  status: "applied" | "failed";
}

export interface SiteRepair {
  /** Each sheet's text as the framework would leave it on disk. */
  texts: Record<string, string>;
  /** The framework's records for the whole site. */
  records: FrameworkRecord[];
  /** Each checked sheet's result, by file name. */
  results: Record<string, RepairSheetResult>;
}

/** The text the framework would leave for a sheet: what it wrote, else the input. */
export function textAfter(result: RepairSheetResult, input: string): string {
  if (result.kind === "repaired") return result.text;
  if ("partialText" in result) return result.partialText;
  return input;
}

export function repairSite(
  sheets: Record<string, string>,
  choices: Record<string, readonly ColumnChoice[]> = {},
  options: RepairOptions = {},
): SiteRepair {
  const texts = { ...sheets };
  const records: FrameworkRecord[] = [];
  const results: Record<string, RepairSheetResult> = {};
  const paths = Object.keys(sheets).map((name) => `${SPREADSHEETS_DIR}/${name}`);
  for (const { path, name, role } of sheetsToCheck(paths)) {
    const result = repairSheet({ path, text: sheets[name], role, choices: choices[name] }, options);
    results[name] = result;
    texts[name] = textAfter(result, sheets[name]);
    for (const entry of result.report) {
      const record = frameworkRecordOf(entry);
      if (record) records.push(record);
    }
  }
  if (records.length === 0) records.push({ key: "v180_sheets_clean", args: [], status: "applied" });
  return { texts, records, results };
}

/**
 * The column layout a story CSV is published in.
 *
 * A story's step CSV is laid out as every sheet is (sheet-csv-layout.server.ts):
 * D1's values written into the file's own columns, in the file's order, under
 * the file's header text where both framework releases read it as the same
 * column, with its comment rows carried and what it lacks appended. This
 * module holds the story sheet's parameters: the import's story scope, the
 * story readers of the published tag and the head, and no name the sheet
 * never writes.
 *
 * The plain layout, for a file with no header or one Papa refused, writes the
 * fixed columns, then the kept keys, and no comment rows.
 *
 * @version v1.5.0-beta
 */

import { commentRecordsOf, readCsvForComments } from "~/lib/csv-export.server";
import { csvSheetFor } from "~/lib/import.server";
import { fileSheetLayout, plainSheetLayout } from "~/lib/sheet-csv-layout.server";
import type { SheetColumnSource, SheetCsvColumn, SheetCsvLayout } from "~/lib/sheet-csv-layout.server";

/** Where a published column's cells come from. */
export type StoryColumnSource = SheetColumnSource;

/** One column of a published story CSV: the header text written, and its cells' source. */
export type StoryCsvColumn = SheetCsvColumn;

/** The columns a story CSV is written in, and the comment rows written above its data. */
export type StoryCsvLayout = SheetCsvLayout;

/** The layout the plain render writes: the fixed columns, then the kept keys, and no comment rows. */
export function plainStoryLayout(fixedColumns: readonly string[], keptKeys: readonly string[]): StoryCsvLayout {
  return plainSheetLayout(fixedColumns, keptKeys, []);
}

/**
 * The layout of `existingCsv` for D1's `keptKeys`, or null when it has no
 * header record or Papa refused it. A file whose rows cannot be matched to the
 * characters they were read from throws `CsvCommentExtractionError`, as every
 * serializer carrying comments does.
 */
export function fileStoryLayout(
  existingCsv: string,
  fixedColumns: readonly string[],
  keptKeys: readonly string[],
): StoryCsvLayout | null {
  const reading = readCsvForComments(existingCsv);
  const sheet = { ...csvSheetFor("story"), fixedColumns };
  return fileSheetLayout(sheet, reading, commentRecordsOf(reading, true), keptKeys);
}

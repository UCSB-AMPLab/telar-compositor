/**
 * The column layout a sheet's CSV is published in: objects.csv and every
 * story CSV.
 *
 * A sheet on GitHub is the author's file as much as D1's rows are: its column
 * order, its header text (`página` as well as `page`, `id_objeto` as well as
 * `object_id`), the columns it added and has not filled yet, and its comment
 * rows, the template's instruction rows among them. A comment row annotates the
 * columns by position, so it stays correct only while each column it annotates
 * keeps its place. So a publish that has the file writes D1's values into the
 * file's own columns, in the file's order, and appends what the file lacks.
 *
 * Each position of the file is named as the import names it
 * (`importedHeader`), so the layout and the import cannot disagree about which
 * column a position is. In this order, a position is:
 *
 * 1. a blank header cell: an empty column, in place. Both framework releases
 *    build it, and the import drops it again on the next read;
 * 1b. in project.csv, the protection spelling (`private`, `privada`,
 *    `protected` and the rest) the import decides `private` from: the fixed
 *    column `private`. Any other protection spelling has no final name and is
 *    left out below, since the framework refuses two protection headers
 *    whether or not the loser holds values;
 * 2. a column the import dropped for a collision: left out, since the
 *    framework refuses two headers for one column whether or not the loser
 *    holds values;
 * 3. a fixed column: written from its D1 field, under the file's header text
 *    when every framework release the Compositor publishes to reads that text
 *    as the English name's column, and under the English name otherwise;
 * 4. a kept column D1 records: written from D1's cells under the name the
 *    import stores it under, which for a repeated header is `name_1`;
 * 5. a name the sheet never writes (objects' `iiif_manifest`, read into
 *    `source_url`): left out;
 * 6. a custom column empty in every data row: an empty column in place;
 * 7. anything else, a custom column with values D1 does not record: left out,
 *    except in the first position, where it is written empty so that the
 *    comment marker keeps its column.
 *
 * An empty column the framework would refuse is left out too: a reserved name,
 * or a member of a group of written headers the sheet's reader lands on one
 * column in any release. A blank column is named by pandas from its position, `Unnamed: <n>`,
 * so every blank column is left out when a written header folds to that shape.
 *
 * A column left out takes its cell out of every comment row, so each later
 * cell stays under the header it annotated; with none left out, comment rows
 * are carried byte for byte. Where the first column is left out, a comment row
 * whose new first cell is no comment is dropped, since it would be read as
 * data.
 *
 * The caller writes the sheet's plain layout instead when the file has no
 * header or Papa refused it (`fileSheetLayout` returns null), when the layout
 * does not write every fixed column and kept key exactly once, and when a data
 * row's first written cell would read as a comment (`chosenSheetLayout`).
 *
 * @version v1.5.0-beta
 */

import Papa from "papaparse";
import { foldHeader } from "~/lib/column-mapping";
import { isCommentCell } from "~/lib/csv-records";
import type { CsvCommentRecord } from "~/lib/csv-export.server";
import type { CsvSourceReading } from "~/lib/csv-record-scan.server";
import { isReservedColumnName } from "~/lib/extra-columns.server";
import {
  TELAR_CSV_PARSE_CONFIG,
  collidingHeaderGroups,
  fixedColumnHeaders,
  importedHeader,
  isCommentRow,
  positionalRow,
} from "~/lib/import.server";
import type { FixedColumnHeader, FrameworkRelease, ImportedHeader } from "~/lib/import.server";

/** Where a published column's cells come from. */
export type SheetColumnSource =
  | { kind: "fixed"; name: string }
  | { kind: "kept"; key: string }
  | { kind: "empty" };

/** One column of a published sheet: the header text written, and its cells' source. */
export interface SheetCsvColumn {
  header: string;
  source: SheetColumnSource;
}

/** The columns a sheet is written in, and the comment rows written above its data. */
export interface SheetCsvLayout {
  columns: SheetCsvColumn[];
  commentRows: string[];
  /** The held records given to `fileSheetLayout`, in their order, each written as a comment row is. */
  heldRows?: string[];
}

/** What the layout needs to know about one kind of sheet. */
export interface CsvSheet {
  /** The columns every publish writes, in canonical order. */
  fixedColumns: readonly string[];
  /** The scope the import reads the sheet under. */
  canonicalScope: ReadonlySet<string>;
  /**
   * The framework releases the published file is read by: a fixed column's
   * header text has to name it in each, and an empty column must not collide
   * with a written one in any.
   */
  releases: readonly FrameworkRelease[];
  /** Names the import reads and the sheet never writes. */
  neverWritten: ReadonlySet<string>;
  /** Whether the sheet is project.csv, whose protection spellings all read as `private`. */
  projectSheet: boolean;
  /**
   * Kept keys written under the header the file already holds for them rather
   * than the key's own name, for a column the framework reads under more than
   * one name (the glossary's `kind`, which a sheet may head `tipo`).
   */
  keepsFileHeader?: ReadonlySet<string>;
}

/** A column of the file at its position, with its source, or null when it is left out. */
interface FileColumn {
  position: number;
  header: string;
  source: SheetColumnSource | null;
  /** A blank header cell, which pandas names by its position. */
  blank: boolean;
}

const EMPTY: SheetColumnSource = { kind: "empty" };

/** pandas' name for a blank header cell, folded. */
const PANDAS_BLANK_NAME = /^unnamed: \d+$/;

/** The fixed columns in their order, then the kept keys, with `commentRows` above the data. */
export function plainSheetLayout(
  fixedColumns: readonly string[],
  keptKeys: readonly string[],
  commentRows: string[],
): SheetCsvLayout {
  return {
    columns: [
      ...fixedColumns.map((name) => ({ header: name, source: { kind: "fixed", name } as const })),
      ...keptKeys.map((key) => ({ header: key, source: { kind: "kept", key } as const })),
    ],
    commentRows,
  };
}

/**
 * The layout of the file `reading` was taken from, for D1's `keptKeys`, with
 * `records` its comment records. Null when the file has no header record or
 * Papa refused it: its cells are then Papa's recovery, not the author's
 * columns.
 *
 * `held` are data records the sheet writes back as the file has them rather
 * than from D1 (glossary rows that publish no term). They are carried as
 * comment rows are, but never dropped for their first cell, and `reading` is
 * to leave them out, so a column only they fill is an empty column in place.
 */
export function fileSheetLayout(
  sheet: CsvSheet,
  reading: CsvSourceReading,
  records: CsvCommentRecord[],
  keptKeys: readonly string[],
  held: CsvCommentRecord[] = [],
): SheetCsvLayout | null {
  const first = reading.rows[0];
  if (first === undefined || first.rejected) return null;
  const header = importedHeader(
    reading.rows.map((row) => row.cells),
    sheet.canonicalScope,
    sheet.projectSheet,
  );
  const kept = new Set(keptKeys);
  const fixed = fixedColumnHeaders(sheet, header, first.cells);
  const inFile = first.cells.map((cell, position) => fileColumnAt(sheet, header, fixed[position], cell, position, kept));
  const appended = appendedColumns(inFile, sheet.fixedColumns, keptKeys);
  leaveOutRefusedEmptyColumns(inFile, appended, sheet.releases);

  const leftOut = new Set(inFile.filter((c) => c.source === null).map((c) => c.position));
  const written = inFile.flatMap((c) => (c.source === null ? [] : [{ header: c.header, source: c.source }]));
  return {
    columns: [...written, ...appended],
    commentRows: carriedCommentRows(records, leftOut),
    heldRows: carriedCommentRows(held, leftOut, false),
  };
}

/**
 * One position of the file under the rules in the module comment, in their
 * order; `fixed` is the fixed column there (rules 1b and 3, `fixedColumnHeaders`).
 */
function fileColumnAt(
  sheet: CsvSheet,
  header: ImportedHeader,
  fixed: FixedColumnHeader | undefined,
  cell: string,
  position: number,
  kept: ReadonlySet<string>,
): FileColumn {
  const column = (text: string, source: SheetColumnSource | null, blank = false): FileColumn => ({
    position,
    header: text,
    source,
    blank,
  });
  if (header.blankHeaderIndexes.has(position)) return column("", EMPTY, true);
  if (fixed !== undefined) return column(fixed.written, { kind: "fixed", name: fixed.name });
  const name = header.finalNames[position];
  if (header.droppedColumnIndexes.has(position) || name === undefined) return column(cell, null);
  if (kept.has(name)) return column(keptHeader(sheet, name, cell), { kind: "kept", key: name });
  if (sheet.neverWritten.has(name)) return column(name, null);
  if (!header.holdsValues[position] || position === 0) return column(name, EMPTY);
  return column(name, null);
}

/** The header a kept key is written under: the file's own text where the sheet says so, else the key. */
function keptHeader(sheet: CsvSheet, key: string, cell: string): string {
  return sheet.keepsFileHeader?.has(key) ? cell.split("\u0000").join("") : key;
}

/** The fixed columns the file does not write in their order, then the kept keys it does not write in theirs. */
function appendedColumns(
  inFile: FileColumn[],
  fixedColumns: readonly string[],
  keptKeys: readonly string[],
): SheetCsvColumn[] {
  const fixedPresent = new Set<string>();
  const keptPresent = new Set<string>();
  for (const { source } of inFile) {
    if (source?.kind === "fixed") fixedPresent.add(source.name);
    if (source?.kind === "kept") keptPresent.add(source.key);
  }
  return [
    ...fixedColumns
      .filter((name) => !fixedPresent.has(name))
      .map((name) => ({ header: name, source: { kind: "fixed", name } as const })),
    ...keptKeys
      .filter((key) => !keptPresent.has(key))
      .map((key) => ({ header: key, source: { kind: "kept", key } as const })),
  ];
}

/**
 * Leaves out each empty column the framework would refuse or read onto a
 * written one: a reserved name, a member of a colliding group of the headers
 * written under any release's reader (the head refuses the file; the published
 * tag keeps both columns under one name and reads the empty one's value), and
 * every blank column when a written header folds to pandas' name for one.
 */
function leaveOutRefusedEmptyColumns(
  inFile: FileColumn[],
  appended: SheetCsvColumn[],
  releases: readonly FrameworkRelease[],
): void {
  const named = inFile.filter((c) => c.source?.kind === "empty" && !c.blank);
  for (const column of named) {
    if (isReservedColumnName(column.header)) column.source = null;
  }
  const writtenHeaders = () =>
    [...inFile.filter((c) => c.source !== null && !c.blank), ...appended].map((c) => c.header);
  const written = writtenHeaders();
  const colliding = new Set(
    releases.flatMap(({ renames, reader }) => collidingHeaderGroups(written, reader, renames).flat()),
  );
  for (const column of named) {
    if (column.source !== null && colliding.has(column.header)) column.source = null;
  }
  if (!writtenHeaders().some((h) => PANDAS_BLANK_NAME.test(foldHeader(h)))) return;
  for (const column of inFile) {
    if (column.blank) column.source = null;
  }
}

/**
 * The comment rows written above the data: byte for byte when no column is
 * left out, otherwise each written again from its cells without the columns
 * left out. A record Papa refused is written again from its repair, read under
 * the import's configuration, as the next publish will read it. With the first
 * column left out, a row whose remaining first cell is no comment is dropped,
 * unless `comments` is false: the records are data rows held as written.
 */
function carriedCommentRows(records: CsvCommentRecord[], leftOut: ReadonlySet<number>, comments = true): string[] {
  if (leftOut.size === 0) return records.map((r) => r.text);
  return records.flatMap((r) => {
    const cells = (r.cells ?? repairedCells(r.text)).filter((_, i) => !leftOut.has(i));
    if (comments && leftOut.has(0) && !isCommentRow(positionalRow(cells))) return [];
    return [Papa.unparse([cells], { header: false }).replace(/\r\n?/g, "\n")];
  });
}

/** A repaired comment record's cells, as the import reads the row the repair wrote. */
function repairedCells(text: string): string[] {
  return Papa.parse<string[]>(text, TELAR_CSV_PARSE_CONFIG).data[0] ?? [];
}

/**
 * Whether `layout` writes every fixed column and every kept key exactly once.
 * A layout that does not would drop a D1 value from the published file, or
 * write one twice.
 */
export function writesEachOnce(
  layout: SheetCsvLayout,
  fixedColumns: readonly string[],
  keptKeys: readonly string[],
): boolean {
  const fixed = new Map<string, number>();
  const kept = new Map<string, number>();
  for (const { source } of layout.columns) {
    if (source.kind === "fixed") fixed.set(source.name, (fixed.get(source.name) ?? 0) + 1);
    if (source.kind === "kept") kept.set(source.key, (kept.get(source.key) ?? 0) + 1);
  }
  return fixedColumns.every((name) => fixed.get(name) === 1) && keptKeys.every((key) => kept.get(key) === 1);
}

/**
 * The layout a sheet is published in: `candidate`, the file's own, unless
 * there is none, it fails the once-each check (a defect in the layout, logged,
 * never a failed publish), or a data row's first written cell would read as a
 * comment and the row be dropped from the built site. In each of those cases
 * the sheet's plain layout.
 */
export function chosenSheetLayout(
  sheetName: string,
  candidate: SheetCsvLayout | null,
  plain: () => SheetCsvLayout,
  fixedColumns: readonly string[],
  keptKeys: readonly string[],
  rows: readonly Record<string, string>[],
): SheetCsvLayout {
  if (candidate === null) return plain();
  if (!writesEachOnce(candidate, fixedColumns, keptKeys)) {
    console.warn(`${sheetName}: the file's layout does not write every column exactly once; writing the plain layout`);
    return plain();
  }
  const first = candidate.columns[0];
  if (first !== undefined && rows.some((row) => isCommentCell(cellOf(first.source, row)))) return plain();
  return candidate;
}

/**
 * One published cell of a row. `fields` has a null prototype and holds the
 * fixed columns by name and the kept cells by key, so a key the row does not
 * carry reads as no cell rather than as an inherited member.
 */
export function cellOf(source: SheetColumnSource, fields: Record<string, string>): string {
  if (source.kind === "fixed") return fields[source.name] ?? "";
  if (source.kind === "kept") return fields[source.key] ?? "";
  return "";
}

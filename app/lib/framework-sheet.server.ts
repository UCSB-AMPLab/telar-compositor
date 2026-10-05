/**
 * A spreadsheet as the framework's 1.8.0 upgrade reads it before it repairs
 * colliding columns: `Sheet` and the functions around it in
 * scripts/migrations/v180_sheets.py, with the rules they import from
 * scripts/telar/csv_utils.py.
 *
 * The repair edits bytes, so a sheet is held two ways at once: as the cells
 * CPython's `csv` reads (`rows`), and as each record's fields exactly as they
 * were written, with the terminator that ended the record (`records`). The
 * second is trusted only where it reads back as the first; otherwise it is
 * null and the sheet is never written. Which records are rows at all is
 * pandas' question, since pandas is what the build reads with: it skips a
 * line of nothing but spaces and tabs, before the header and between rows,
 * and its column labels step past a suffix another header already holds.
 *
 * Everything here predicts a Python process, so strings are stripped as
 * CPython strips them (`pythonStrip`) and lowered as the build's Python 3.11
 * lowers them (`pythonLower`). Nothing here imitates the Compositor's own CSV reading, which follows
 * PapaParse and is right for its own purpose.
 *
 * @version v1.5.0-beta
 */

import { foldHeader, pythonStrip } from "~/lib/column-mapping";
import { isCommentCell } from "~/lib/csv-records";
import {
  FRAMEWORK_COLUMN_RENAMES,
  ONCE_PUBLISHED_HEADER_TOKENS,
  frameworkRenameOf,
  type FrameworkSheetReader,
} from "~/lib/import.server";
import { pythonCsvLine, pythonCsvRows } from "~/lib/python-csv";

export { GLOSSARY_SHEETS, OBJECTS_SHEETS, PROJECT_SHEETS, SPREADSHEETS_DIR } from "~/lib/site-sheets.server";

/**
 * The aliases only the glossary sheet reads (`GLOSSARY_COLUMN_ALIASES`). `tipo`
 * is a word an author uses for a column of their own elsewhere, so on any other
 * sheet it stays the author's header.
 */
export const FRAMEWORK_GLOSSARY_COLUMN_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, { tipo: "kind" }),
);

const BOM = "\uFEFF";

export { LOWERED_ONLY_AFTER_UNICODE_14, pythonLower } from "~/lib/python-lower";

/** `str(value).lower().strip()`, the fold every framework header lookup uses. */
export const pythonFold: (value: string) => string = foldHeader;

/** A sheet the framework's reading raises on, which the upgrade reports and never writes. */
export class FrameworkSheetUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameworkSheetUnreadableError";
  }
}

// ---------------------------------------------------------------------------
// The byte-level split
// ---------------------------------------------------------------------------

/** One record as written: its fields' exact text and the terminator after it. */
export interface SplitRecord {
  fields: string[];
  ending: string;
}

const UNQUOTED = /[^,\r\n]*/y;
const TERMINATOR = /\r\n|\r|\n|/y;

/**
 * The end of the quoted field opening at `start`, or null when the quote never
 * closes or anything but a delimiter, a line ending or the end of the text
 * follows the closing quote.
 */
function frameworkQuotedFieldEnd(text: string, start: number): number | null {
  let index = start + 1;
  for (;;) {
    const close = text.indexOf('"', index);
    if (close < 0) return null;
    if (text[close + 1] === '"') {
      index = close + 2;
      continue;
    }
    const end = close + 1;
    return end === text.length || ",\r\n".includes(text[end]) ? end : null;
  }
}

function stickyMatchText(pattern: RegExp, text: string, pos: number): string {
  pattern.lastIndex = pos;
  return (pattern.exec(text) as RegExpExecArray)[0];
}

/** The record at `pos` and the position after it, or null. */
function splitRecord(text: string, pos: number): { record: SplitRecord; next: number } | null {
  const fields: string[] = [];
  for (;;) {
    let end: number;
    if (text[pos] === '"') {
      const close = frameworkQuotedFieldEnd(text, pos);
      if (close === null) return null;
      end = close;
    } else {
      end = pos + stickyMatchText(UNQUOTED, text, pos).length;
    }
    fields.push(text.slice(pos, end));
    pos = end;
    if (text[pos] !== ",") break;
    pos += 1;
  }
  const ending = stickyMatchText(TERMINATOR, text, pos);
  return { record: { fields, ending }, next: pos + ending.length };
}

/**
 * Every record of `text` as it was written, or null when some record cannot be
 * split with certainty: a quote that never closes, or text after a closing
 * quote. A field is quoted only when its first character is a quote.
 */
export function splitRecords(text: string): SplitRecord[] | null {
  const records: SplitRecord[] = [];
  let pos = 0;
  while (pos < text.length) {
    const split = splitRecord(text, pos);
    if (split === null) return null;
    records.push(split.record);
    pos = split.next;
  }
  return records;
}

/** What `csv` reads a record's written fields as; a blank record is no cells. */
export function cellsOf(fields: readonly string[]): string[] {
  if (fields.length === 1 && fields[0] === "") return [];
  return fields.map((f) => (f.startsWith('"') ? f.slice(1, -1).replaceAll('""', '"') : f));
}

/**
 * pandas' C tokenizer skips a line of spaces and tabs alone as blank; a form
 * feed, a vertical tab or any other character is a cell. Not `str.strip()`.
 */
const BLANK_LINE = /^[ \t]*$/;

/**
 * Whether pandas skips the record written as `fields`: one field, unquoted, of
 * nothing but spaces and tabs. A quoted `""` is a cell, so a row.
 */
export function isSkippedFields(fields: readonly string[]): boolean {
  return fields.length === 1 && BLANK_LINE.test(fields[0]);
}

/**
 * The same judgement on cells `csv` has read, for a sheet that cannot be split:
 * a quoted `""` line reads as the blank line it is not, which is why such a
 * sheet is only reported on.
 */
export function isSkippedRow(row: readonly string[]): boolean {
  return row.length <= 1 && BLANK_LINE.test(row.join(""));
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

/** One sheet as the repair reads it. */
export interface FrameworkSheet {
  /** Whether the text began with a byte-order mark, one of which was taken off. */
  bom: boolean;
  /** Every record's cells, as `csv.reader` gives them. */
  rows: string[][];
  /** Every record as written, or null when the split does not read back as `rows`. */
  records: SplitRecord[] | null;
  /** Whether pandas skips each record as a blank line. */
  skipped: boolean[];
  /** The index of the header record: the first not skipped, else `rows.length`. */
  headerAt: number;
  /** The header's cells; empty when there is no header. */
  header: string[];
  /** The records after the header that pandas reads as rows. */
  body: string[][];
  /** The column labels pandas gives the build, suffixes included. */
  labels: string[];
}

function sameRowLists(a: readonly (readonly string[])[], b: readonly (readonly string[])[]): boolean {
  return a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((c, j) => c === b[i][j]));
}

/**
 * `Sheet(path, text)`: `text` as decoded from UTF-8, byte-order mark included.
 * Throws FrameworkSheetUnreadableError where the framework's read raises.
 */
export function readFrameworkSheet(text: string): FrameworkSheet {
  const bom = text.startsWith(BOM);
  const content = bom ? text.slice(BOM.length) : text;
  const rows = pythonCsvRows(content);
  let records = splitRecords(content);
  if (records !== null && !sameRowLists(records.map((r) => cellsOf(r.fields)), rows)) records = null;
  const skipped = records === null ? rows.map(isSkippedRow) : records.map((r) => isSkippedFields(r.fields));
  const found = skipped.indexOf(false);
  const headerAt = found < 0 ? rows.length : found;
  const header = headerAt < rows.length ? rows[headerAt] : [];
  const body = rows.filter((_, i) => i > headerAt && !skipped[i]);
  const labels = pandasLabels(header, content);
  return { bom, rows, records, skipped, headerAt, header, body, labels };
}

/**
 * The header cells pandas' C tokenizer takes from `text` when asked for the
 * header alone, or undefined where `read_csv` raises instead: no line at all,
 * or a quote still open at the end of the text within the two lines it
 * tokenizes (the header and one more).
 *
 * The tokenizer takes one more byte-order mark off the front. It skips a line
 * of nothing but spaces and tabs, but it decides so only on reaching the line's
 * end: a line that starts with spaces or tabs and then holds something else is
 * tokenized again from just after the last LF before it, or from the start of
 * the text when there is none. Lines ended by a lone CR since that LF are
 * tokenized again with it, which is why `\t\r  x` has the header `\t`, and
 * `\r  x` a header of one empty cell.
 */
function pandasHeaderCells(text: string): string[] | undefined {
  const floor = text.startsWith(BOM) ? BOM.length : 0;
  const lines: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let state: "record" | "whitespace" | "crnl_nop" | "field" | "unquoted" | "quoted" | "quote" | "crnl" = "record";
  const endField = () => {
    fields.push(field);
    field = "";
  };
  const endLine = () => {
    lines.push(fields);
    fields = [];
  };
  let i = floor;
  while (i < text.length && lines.length < 2) {
    const c = text[i];
    i += 1;
    switch (state) {
      case "record":
        if (c === "\n") break;
        if (c === "\r") {
          state = "crnl_nop";
          break;
        }
        if (c === " " || c === "\t") {
          state = "whitespace";
          break;
        }
        state = "field";
        i -= 1;
        break;
      case "whitespace":
        if (c === "\n") state = "record";
        else if (c === "\r") state = "crnl_nop";
        else if (c !== " " && c !== "\t") {
          i = Math.max(floor, text.lastIndexOf("\n", i - 1) + 1);
          state = "field";
        }
        break;
      case "crnl_nop":
        state = "record";
        if (c !== "\n" && c !== ",") i -= 1;
        break;
      case "field":
        if (c === "\n") {
          endField();
          endLine();
          state = "record";
        } else if (c === "\r") {
          endField();
          state = "crnl";
        } else if (c === '"') state = "quoted";
        else if (c === ",") endField();
        else {
          field += c;
          state = "unquoted";
        }
        break;
      case "unquoted":
        if (c === "\n") {
          endField();
          endLine();
          state = "record";
        } else if (c === "\r") {
          endField();
          state = "crnl";
        } else if (c === ",") {
          endField();
          state = "field";
        } else field += c;
        break;
      case "quoted":
        if (c === '"') state = "quote";
        else field += c;
        break;
      case "quote":
        if (c === '"') {
          field += c;
          state = "quoted";
        } else if (c === ",") {
          endField();
          state = "field";
        } else if (c === "\n") {
          endField();
          endLine();
          state = "record";
        } else if (c === "\r") {
          endField();
          state = "crnl";
        } else {
          field += c;
          state = "unquoted";
        }
        break;
      case "crnl":
        endLine();
        if (c === "\n") state = "record";
        else if (c === ",") state = "field";
        else {
          state = "record";
          i -= 1;
        }
        break;
    }
  }
  if (lines.length < 2) {
    if (state === "quoted") return undefined;
    if (state === "field" || state === "unquoted" || state === "quote") {
      endField();
      endLine();
    } else if (state === "crnl") endLine();
  }
  return lines[0];
}

/**
 * The column labels the build's pandas read gives a sheet whose header is
 * `header`, `text` being the sheet after the framework took one mark off it.
 *
 * pandas reads the whole text where it can; where it cannot split it, or finds
 * no header in it, the framework hands it the header alone, written by
 * `csv.writer`. A cell is cut at its first NUL, and an empty one is
 * `Unnamed: <position>`. A repeated label gains `.1`, `.2`, stepping past a
 * suffix another label already holds, the named columns taken before the
 * unnamed ones, so `note,note,note.1` reads `note,note.2,note.1`. Throws when
 * there are not as many labels as header cells.
 */
export function pandasLabels(header: readonly string[], text?: string): string[] {
  if (header.length === 0) return [];
  let cells = text === undefined ? undefined : pandasHeaderCells(text);
  cells ??= pandasHeaderCells(pythonCsvLine(header));
  if (cells === undefined) throw new FrameworkSheetUnreadableError("No columns to parse from file");
  const labels = cells.map((cell, i) => cell.split("\u0000")[0] || `Unnamed: ${i}`);
  const unnamed = new Set(cells.flatMap((cell, i) => (cell.split("\u0000")[0] === "" ? [i] : [])));
  const order = [...labels.keys()].filter((i) => !unnamed.has(i)).concat([...unnamed]);
  const counts = new Map<string, number>();
  for (const i of order) {
    const old = labels[i];
    let col = old;
    let cur = counts.get(col) ?? 0;
    while (cur > 0) {
      counts.set(old, cur + 1);
      col = `${old}.${cur}`;
      cur = labels.includes(col) ? cur + 1 : counts.get(col) ?? 0;
    }
    labels[i] = col;
    counts.set(col, cur + 1);
  }
  if (labels.length !== header.length) {
    throw new FrameworkSheetUnreadableError("pandas reads a different number of columns");
  }
  return labels;
}

/**
 * `Sheet.edited`: the sheet's text with the fields at `indices` gone from every
 * record pandas reads, and `#` put before the header's first field when
 * `markFirst` is set (inside its quotes, if it has them), or null when the
 * sheet cannot be edited that safely. A skipped line is written back as it
 * was, and every other byte stays where it was. The record at `dropRecord` is
 * left out whole.
 */
export function editedText(
  sheet: FrameworkSheet,
  indices: Iterable<number>,
  markFirst: boolean,
  dropRecord: number | null = null,
): string | null {
  const doomed = new Set(indices);
  if (sheet.records === null || sheet.header.length === 0 || (markFirst && doomed.has(0))) return null;
  const text = sheet.records
    .map(({ fields, ending }, r) => {
      if (r === dropRecord) return "";
      if (sheet.skipped[r]) return fields.join(",") + ending;
      const kept = fields.map((field, i) => {
        if (!(markFirst && r === sheet.headerAt && i === 0)) return field;
        return field.startsWith('"') ? `"#${field.slice(1)}` : `#${field}`;
      });
      return kept.filter((_, i) => !doomed.has(i)).join(",") + ending;
    })
    .join("");
  return (sheet.bom ? BOM : "") + text;
}

// ---------------------------------------------------------------------------
// The rows the build reads, and the names its columns claim
// ---------------------------------------------------------------------------

/** How the build scopes the alias map for one sheet. */
export interface SheetScope {
  /** The objects sheet's `canonical_fields`: a rename outside it is not made. */
  canonicalFields?: ReadonlySet<string>;
  /** The aliases only this sheet reads, on top of the shared map. */
  sheetAliases?: Readonly<Record<string, string>>;
}

const HEADER_ROW_TOKENS: ReadonlySet<string> = new Set([
  ...Object.keys(FRAMEWORK_COLUMN_RENAMES),
  ...Object.values(FRAMEWORK_COLUMN_RENAMES),
  "x", "y", "zoom",
  ...ONCE_PUBLISHED_HEADER_TOKENS,
]);

/**
 * `is_header_row`: whether a row is a second, bilingual header row. Cells are
 * folded, empty ones are absent, and the row is a header row when it has at
 * least three cells and four in five of them name a column.
 */
export function frameworkIsHeaderRow(cells: readonly string[], sheetAliases?: Readonly<Record<string, string>>): boolean {
  const aliases = sheetAliases ? [...Object.keys(sheetAliases), ...Object.values(sheetAliases)] : [];
  let matches = 0;
  let total = 0;
  for (const cell of cells) {
    const folded = pythonFold(cell);
    if (!folded) continue;
    total += 1;
    if (HEADER_ROW_TOKENS.has(folded) || aliases.includes(folded)) matches += 1;
  }
  return total >= 3 && matches / total >= 0.8;
}

function bodyWithoutComments(sheet: FrameworkSheet): string[][] {
  return sheet.body.filter((row) => !isCommentCell(row[0]));
}

/**
 * Whether the build drops the first of `rows`, the rows left once comment rows
 * are gone, as a bilingual header row, judged on the cells of the columns the
 * build keeps (those whose label does not start with `#`).
 */
function headerRowSkipped(sheet: FrameworkSheet, rows: string[][], sheetAliases?: Readonly<Record<string, string>>): boolean {
  if (rows.length === 0) return false;
  const first = sheet.labels.flatMap((label, i) => (label.startsWith("#") ? [] : [rows[0][i] ?? ""]));
  return frameworkIsHeaderRow(first, sheetAliases);
}

/** Whether the sheet's first row after the comment rows is dropped as a bilingual header row. */
export function skipsHeaderRow(sheet: FrameworkSheet, sheetAliases?: Readonly<Record<string, string>>): boolean {
  return headerRowSkipped(sheet, bodyWithoutComments(sheet), sheetAliases);
}

/**
 * The index of the record the build drops as a bilingual header row, or null
 * when it drops none or the sheet's records cannot be trusted.
 */
export function headerRowRecord(sheet: FrameworkSheet, sheetAliases?: Readonly<Record<string, string>>): number | null {
  if (sheet.records === null || !skipsHeaderRow(sheet, sheetAliases)) return null;
  const at = sheet.rows.findIndex((row, r) => r > sheet.headerAt && !sheet.skipped[r] && !isCommentCell(row[0]));
  return at < 0 ? null : at;
}

/**
 * The rows the build treats as data: the body without its comment rows (a
 * first cell that, stripped, starts with `#`) and without a bilingual header
 * row first among those left.
 */
export function dataRows(sheet: FrameworkSheet, sheetAliases?: Readonly<Record<string, string>>): string[][] {
  const rows = bodyWithoutComments(sheet);
  return headerRowSkipped(sheet, rows, sheetAliases) ? rows.slice(1) : rows;
}

/** Whether some row holds something other than whitespace at `index`. */
export function holdsValues(rows: readonly (readonly string[])[], index: number): boolean {
  return rows.some((row) => index < row.length && pythonStrip(row[index]) !== "");
}

/**
 * `claimed_names`: each name the build would give a column, and the positions
 * of the columns claiming it, in the order first claimed. A label starting
 * with `#` claims nothing; a label the map renames claims its target, unless
 * the sheet is scoped and the target is outside the scope; every other label
 * claims itself folded.
 */
export function claimedNames(labels: readonly string[], scope: SheetScope = {}): Map<string, number[]> {
  const renames = scope.sheetAliases
    ? Object.assign(Object.create(null) as Record<string, string>, FRAMEWORK_COLUMN_RENAMES, scope.sheetAliases)
    : FRAMEWORK_COLUMN_RENAMES;
  const reader: FrameworkSheetReader = { scope: scope.canonicalFields ?? null, dropsInstructionColumns: true };
  const claims = new Map<string, number[]>();
  labels.forEach((label, index) => {
    if (label.startsWith("#")) return;
    const folded = pythonFold(label);
    const claim = frameworkRenameOf(folded, renames, reader) ?? folded;
    const members = claims.get(claim);
    if (members) members.push(index);
    else claims.set(claim, [index]);
  });
  return claims;
}

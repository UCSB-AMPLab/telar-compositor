/**
 * Record boundaries in a CSV, taken as character ranges over the untouched
 * source text.
 *
 * Removing one object from objects.csv has to leave the rest of the file byte
 * for byte: a leading BOM, CRLF terminators, non-ASCII titles, the bilingual
 * label row, comment rows, custom columns and fields holding newlines, commas
 * and doubled quotes all survive, because a delete is not a publish and the
 * author asked for one row to go. That requires ranges over the original
 * string rather than a re-serialisation.
 *
 * ONE READING decides everything else. Papa reads the whole file exactly as
 * `parseTelarCsv` reads it — the same string under `TELAR_CSV_PARSE_CONFIG` —
 * and that reading settles which rows exist, which the importer skips, which
 * row carries the id, which delimiter and terminator the file is written in,
 * and whether Papa could read it at all. This module supplies only the RANGES,
 * matched to Papa's rows by the cursor Papa reports for each. No skip rule is
 * written out twice and nothing is guessed that the reading already reported.
 *
 * It takes two runs of that one reading, because Papa answers two questions in
 * two places: a plain parse reports the file's errors and the pair it was read
 * with, and a stepped parse reports each row's cursor. A row of one empty field
 * never reaches a step at all — `skipEmptyLines` removes it first — so the
 * errors a final lone quote raises exist only in the plain parse's `errors`.
 *
 * That is the whole design, and it exists because every near-match of the two
 * readings has been a wrong answer. A record read WITHOUT the file in front of
 * it is read with neither the file's delimiter nor its terminator, so a row
 * whose only comma sits inside a value splits on a semicolon, a closing quote
 * followed by spaces reads as broken, and a U+FEFF that is field content in
 * the file is stripped as an encoding mark. A blank rule written here rather
 * than taken from the parse can disagree with `isPandasBlankLine` about a
 * delimiter-free line of nothing but spaces or tabs either way, and the two
 * then count the file's rows apart: the N-th row on one side is not the N-th
 * on the other, and the delete cuts a stranger's record.
 *
 * So the range's own text is read back with all of that restored — the file's
 * delimiter and terminator, a sacrificial record ahead of it so no character
 * sits at offset zero, the record's own terminator behind it — and has to
 * decode to the cells Papa already produced for that row. It is the one check
 * that a range holds the row it is paired with rather than a fragment of it.
 *
 * Ranges still come from a quoting-aware scan of the source, never from
 * physical lines, because Papa's rows carry decoded cells and no extent: a
 * quoted field may hold newlines, commas and doubled quotes, so a record and a
 * line are different things. The two are joined by the cursor, and the join is
 * checked at every row — a range that does not end exactly where Papa's row
 * ends means the scan and the parse disagree about where the records are, and
 * the file is refused rather than cut on the disagreement.
 *
 * Which records are data is the importer's question, so a detector
 * `createCsvRecordSkipDetector` builds — the same factory `parseTelarCsv`
 * classifies with, on the very cells Papa handed it — decides it here too.
 * WHICH object a data record belongs to is
 * the importer's question as well: `parseTelarCsv` is run over the same source
 * and names the ids, and its rows and the rows kept here are one sequence
 * because they are the same rows under the same filter. The id at the
 * importer's resolved column confirms the pairing before anything is cut.
 *
 * An absence costs the object's images exactly as a removal does, so it is
 * reachable only from a file that read clean: an error on the file, a record
 * Papa rejects, a row no range aligns to, a range that decodes to something
 * other than its row, or a header declaring no id column is `unusable`.
 *
 * A rename edits cells rather than cutting records, on the same reading: each
 * replaced field is located inside its row's own range, rewritten over its own
 * characters, and the result has to read back as the same rows with only
 * those cells changed. That holds for objects.csv's id cells, a story's
 * `object` cells and inline layer text, and glossary definitions alike.
 *
 * @version v1.5.0-beta
 */

import Papa from "papaparse";
import { GLOSSARY_COLUMN_ALIASES, foldHeader, pythonStrip } from "~/lib/column-mapping";
import { BOM, recordFieldsEnd } from "~/lib/csv-records";
import {
  GLOSSARY_CANONICAL_SCOPE,
  OBJECTS_CANONICAL_SCOPE,
  STORY_CANONICAL_SCOPE,
  TELAR_CSV_PARSE_CONFIG,
  createCsvRecordSkipDetector,
  importedHeader,
  instructionHeaderOf,
  parseTelarCsv,
  resolvedColumnPosition,
} from "~/lib/import.server";

/** A record's extent in the source text. */
export interface CsvRecordRange {
  /** Offset of the record's first character. */
  start: number;
  /** Offset one past the record's own line terminator, or the source end. */
  end: number;
  /** The record's text, terminator excluded. */
  text: string;
}

/** The outcome of removing one object's record from a CSV. */
export type CsvRecordRemoval =
  /**
   * Records were found; `text` is the source minus each one's exact range.
   * `survivors` is present only when that text would read one row fewer than
   * the rows left, because the cut put a row that reads as a repeated header
   * first: the caller writes the survivors in the Compositor's own layout
   * instead of `text`.
   */
  | { status: "removed"; text: string; survivors?: Record<string, string>[] }
  /** The CSV reads cleanly and holds no record for that object. */
  | { status: "absent" }
  /** No usable header, or a file this scan cannot claim to have read. */
  | { status: "unusable" };

/** The column a record is matched on. */
const ID_COLUMN = "object_id";


/**
 * Splits `source` into records with their ranges, on the boundaries
 * `recordFieldsEnd` draws for the `delimiter` and `newline` Papa read the same
 * source with.
 *
 * Terminators are consumed into the record that precedes them, so removing a
 * record's range removes its line ending with it. Both the delimiter and the
 * terminator come from the caller because Papa settles both per file and
 * reports them (`meta.delimiter`, `meta.linebreak`, papaparse.js:1791-1792): a
 * pair chosen here instead would be a second reading, and the two disagree
 * about where the records are on the first semicolon sheet or the first file
 * whose terminators the 1 MiB sample window cuts differently. A blank line is a
 * record of its own and is preserved like any other. An unterminated quoted
 * field runs to the end of the source, which keeps the scan total; the reader
 * below refuses such a file, because Papa reports it and a record that
 * swallowed the rest of the file is not a record whose range anything may be
 * cut from.
 */
export function scanCsvRecords(
  source: string,
  delimiter: string,
  newline: string,
): CsvRecordRange[] {
  const records: CsvRecordRange[] = [];
  let i = 0;

  while (i < source.length) {
    const start = i;
    const fieldsEnd = recordFieldsEnd(source, start, delimiter, newline);
    i = fieldsEnd;
    if (source.startsWith(newline, i)) i += newline.length;
    else if (i < source.length) i++;
    records.push({ start, end: i, text: source.slice(start, fieldsEnd) });
  }

  return records;
}

/** The three terminators Papa will parse with (papaparse.js:1455-1457). */
type LineBreak = "\r" | "\n" | "\r\n";

/** Narrows Papa's reported terminator to the set its own parser accepts. */
function asLineBreak(reported: string): LineBreak | null {
  return reported === "\r" || reported === "\n" || reported === "\r\n" ? reported : null;
}

/** How Papa read one file: its rows, the pair it read them with, its verdict. */
interface FileParse {
  rows: ParsedRow[];
  /** The delimiter Papa guessed for this file. */
  delimiter: string;
  /** The terminator Papa guessed for this file. */
  newline: LineBreak;
  /** True when Papa reported an error beyond the delimiter recovery. */
  refused: boolean;
}

/** One row of the whole-file parse: its cells, and where Papa left off. */
interface ParsedRow {
  /** The row's cells, decoded, exactly as `parseTelarCsv` receives them. */
  cells: string[];
  /** Papa's cursor for the row, in the source's own offsets. */
  boundary: number;
  /** True when Papa refused the record this row was read from. */
  rejected: boolean;
}

/** One reading of a CSV source: its rows, and Papa's verdict on the whole. */
export interface CsvSourceReading {
  /** The file's rows, each with the characters it was read from. */
  rows: CsvSourceRow[];
  /**
   * True when Papa reported an error on the file beyond the delimiter
   * recovery. Nothing in a refused file is vouched for: a record that
   * swallowed characters belonging to rows nobody can now see hides whatever
   * was in them.
   */
  refused: boolean;
}

/** A row of the file's own parse, and the characters it was read from. */
export interface CsvSourceRow {
  /** The row's cells, decoded, exactly as `parseTelarCsv` receives them. */
  cells: string[];
  /** The source characters the row occupies, terminator included in `end`. */
  range: CsvRecordRange;
  /** True when Papa refused the record these characters make up. */
  rejected: boolean;
}

/**
 * Papa's reading of the whole file, under the importer's own configuration.
 *
 * The cursor Papa reports for a row is the offset one past that row's
 * terminator, or the input's length for a final record with none
 * (papaparse.js:1734-1740 `saveRow`, :1714-1726 `finish`, both reaching
 * `meta.cursor` through `lastCursor` at :1795). Papa strips a U+FEFF at
 * absolute offset zero before the parser sees a character (:238, `stripBom` at
 * :254-259, which tests `charCodeAt(0)` alone), so every cursor of a file that
 * opens with one is a character short of the source it was read from; the mark
 * is one UTF-16 unit and the shift is exactly its length.
 *
 * The rows arrive already filtered: Papa's step wrapper runs `processResults`,
 * which applies `skipEmptyLines`, and returns without calling back when
 * nothing is left (:1053-1079, the filter at :1212-1217). A step row's `errors`
 * are that row's own and its `row` index counts within the step, which is
 * always the one row; which record Papa refused is therefore the step it
 * arrived on, recorded here, and not a number read off the error.
 *
 * So the file's VERDICT is taken from a plain parse of the same string under
 * the same configuration, and the step parse supplies cursors alone. The two
 * see different files: `skipEmptyLines` drops a row of one empty field before
 * the step wrapper calls back, and a lone quote at the end of a file decodes to
 * exactly that — `MissingQuotes` in the plain parse's `errors`, and a step
 * sequence with nothing wrong in it. An absence answered from the step parse
 * alone commits an object's images away against a file Papa could not read.
 *
 * The plain parse also names the pair the file was read with — `meta.delimiter`
 * and `meta.linebreak`, built from the parser's own `delim` and `newline`
 * (:1787-1798), both fixed before a character is read (:1089-1109). Null when
 * the terminator is not one the parser accepts, which is a file with no
 * reading to report.
 *
 * Every error either parse reports is a damaged record. The configuration pins
 * the delimiter, so Papa takes neither the guess nor the flag it sets when the
 * guess fails (:1093-1103), and `UndetectableDelimiter` — the one code that
 * names an advisory rather than a record (:1206-1210) — cannot be raised.
 */
function parseWholeFile(source: string): FileParse | null {
  const plain = Papa.parse<string[]>(source, TELAR_CSV_PARSE_CONFIG);
  const newline = asLineBreak(plain.meta.linebreak);
  if (newline === null) return null;

  const bomShift = source.startsWith(BOM) ? BOM.length : 0;
  const rows: ParsedRow[] = [];
  Papa.parse<string[]>(source, {
    ...TELAR_CSV_PARSE_CONFIG,
    step: (result) => {
      rows.push({
        cells: result.data,
        boundary: result.meta.cursor + bomShift,
        rejected: result.errors.length > 0,
      });
    },
  });

  return {
    rows,
    delimiter: plain.meta.delimiter,
    newline,
    refused: plain.errors.length > 0,
  };
}

/**
 * The sacrificial record a range's own characters are re-read behind.
 *
 * Papa strips a U+FEFF at absolute offset zero of whatever string it is handed
 * (:238, `stripBom` at :254-259), and a record handed over on its own starts at
 * offset zero. Behind one complete record the range starts where it starts in
 * the file — after a terminator, at an offset Papa strips nothing from — so a
 * mid-file mark stays the field content it is in the file.
 */
const SACRIFICIAL_RECORD = "z";

/**
 * The cells a range's own characters decode to, read as the file reads them,
 * or null when they are not exactly one record.
 *
 * The range is re-read behind a sacrificial record and followed by whatever
 * terminator the file put after it, so the characters meet the parser in the
 * position they occupy in the file: a closing quote separated from the
 * terminator by spaces closes its field, as Papa's `extraSpaces` rule has it
 * (:1699-1708), where the same characters read with the terminator stripped off
 * are `InvalidQuotes`.
 *
 * The file's own leading mark is the exception and is dropped first, because
 * Papa stripped it from the whole input before the parse: that row's cells do
 * not carry it and the range's characters do.
 *
 * The test is the range's own OFFSET, not its position in the parsed sequence.
 * Papa strips a mark at absolute offset zero and nowhere else (:238, `stripBom`
 * at :254-259, which tests `charCodeAt(0)` alone), and the first row Papa hands
 * over need not be the record the file opens with: `skipEmptyLines` drops a
 * blank line ahead of the header, and the mark behind it is then ordinary
 * content Papa keeps in the cell. Dropped from the range as well, the re-read
 * cells differ from the ones Papa gave for that row, the whole reading is
 * refused, and a delete answers `unusable` on a file nothing is wrong with.
 */
function cellsOfRange(
  source: string,
  range: CsvRecordRange,
  delimiter: string,
  newline: LineBreak,
): string[] | null {
  const opensFile = range.start === 0;
  const text = opensFile && range.text.startsWith(BOM) ? range.text.slice(BOM.length) : range.text;
  const terminator = source.slice(range.start + range.text.length, range.end);
  const parsed = Papa.parse<string[]>(SACRIFICIAL_RECORD + newline + text + terminator, {
    ...TELAR_CSV_PARSE_CONFIG,
    delimiter,
    newline,
  });
  return parsed.data.length === 2 ? parsed.data[1] : null;
}

/** True when two rows hold the same cells in the same order. */
function sameCells(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((cell, i) => cell === b[i]);
}

/**
 * The file's own rows with the characters each was read from, or null when the
 * scan and the parse disagree about where a record ends.
 *
 * A row's range is the LAST scanned record ending at or before the row's
 * cursor and after the previous row's — the walk consumes the scanned records
 * in order, so the records a row steps over are the empty lines Papa dropped
 * and can belong to no later row. A row the walk finds no record for, or one
 * whose record ends anywhere but exactly at the cursor, is the scan and the
 * parse drawing a boundary in two places; a caller is handed nothing rather
 * than a range neither side vouches for.
 *
 * The cursor settles where a record ENDS and says nothing about what its
 * characters mean, so the range's own text is read back as well and has to
 * decode to the very cells Papa handed over for that row. A range that ends in
 * the right place and reads as something else is a range whose text a caller
 * would carry through a republish as a row the file does not have.
 *
 * This is the one reading of a Telar CSV that both a delete and a republish
 * are built on, so that neither can hold a rule about which rows exist that
 * the other does not.
 */
export function readCsvSourceRows(source: string): CsvSourceReading | null {
  const parsed = parseWholeFile(source);
  if (parsed === null) return null;
  const { delimiter, newline } = parsed;
  const records = scanCsvRecords(source, delimiter, newline);
  const aligned: CsvSourceRow[] = [];
  let next = 0;
  let previousEnd = 0;

  for (const row of parsed.rows) {
    let chosen = -1;
    while (next < records.length && records[next].end <= row.boundary) {
      chosen = next;
      next += 1;
    }
    if (chosen === -1) return null;
    const range = records[chosen];
    if (range.end !== row.boundary) return null;
    if (range.start < previousEnd || range.end <= range.start) return null;
    const reread = cellsOfRange(source, range, delimiter, newline);
    if (reread === null || !sameCells(reread, row.cells)) return null;
    previousEnd = range.end;
    aligned.push({ cells: row.cells, range, rejected: row.rejected });
  }

  return { rows: aligned, refused: parsed.refused };
}

/** A row of a reading the importer keeps, and its position among the reading's rows. */
interface KeptRow {
  /** Index into the reading's `rows`. */
  index: number;
  row: CsvSourceRow;
}

/** objects.csv read for an edit: its id position, its kept rows, and the importer's rows for them. */
interface ObjectsSheetRows {
  reading: CsvSourceReading;
  table: string[][];
  idColumn: number;
  /** The rows the importer keeps, in order; the N-th is `imported[N]`. */
  data: KeptRow[];
  imported: Record<string, string>[];
}

/**
 * The rows of `reading` after the header that the importer keeps, classified
 * by one fresh detector in file order, the order `parseTelarCsv` classifies
 * them in, since the detector spends its one bilingual-row test on the first
 * record that is not a comment.
 */
function keptRowsOf(
  reading: CsvSourceReading,
  sheetAliases?: Readonly<Record<string, string>>,
): KeptRow[] {
  const table = reading.rows.map((row) => row.cells);
  const isSkippedCsvRecord = createCsvRecordSkipDetector(false, instructionHeaderOf(table), sheetAliases);
  const width = table[0].length;
  const kept: KeptRow[] = [];
  for (let index = 1; index < reading.rows.length; index++) {
    if (!isSkippedCsvRecord(reading.rows[index].cells, width).skip) kept.push({ index, row: reading.rows[index] });
  }
  return kept;
}

/**
 * A reading that read clean, or null: one Papa refused, holding a record it
 * rejected, or with no rows at all.
 */
function cleanReadingOf(source: string): CsvSourceReading | null {
  const reading = readCsvSourceRows(source);
  if (!reading || reading.refused || reading.rows.length === 0) return null;
  return reading.rows.some((row) => row.rejected) ? null : reading;
}

/**
 * objects.csv as both an edit and the importer read it, or null when the two
 * cannot be paired: a reading that is not clean, a header naming no id
 * column, or a different number of kept rows than the importer's.
 */
function readObjectsSheetRows(source: string): ObjectsSheetRows | null {
  const reading = cleanReadingOf(source);
  if (!reading) return null;
  const table = reading.rows.map((row) => row.cells);
  const idColumn = resolvedColumnPosition(table, ID_COLUMN, OBJECTS_CANONICAL_SCOPE);
  if (idColumn === -1) return null;
  const data = keptRowsOf(reading);
  const imported = parseTelarCsv(source, undefined, false, OBJECTS_CANONICAL_SCOPE);
  if (data.length !== imported.length) return null;
  return { reading, table, idColumn, data, imported };
}

/**
 * The answer for an id no imported row carries as written: `unusable` where a
 * row carries it once stripped (an id stored before ids were read as written),
 * `absent` otherwise.
 */
function noRecordFor(imported: ReadonlyArray<Record<string, string>>, objectId: string): CsvRecordRemoval {
  const stripped = pythonStrip(objectId);
  return imported.some((row) => pythonStrip(row[ID_COLUMN] ?? "") === stripped)
    ? { status: "unusable" }
    : { status: "absent" };
}

/**
 * Returns `source` with every record belonging to `objectId` removed, range and
 * terminator together, and everything else untouched.
 *
 * An id written in several rows is one object whose page the site builds from
 * the last of them, so a delete that left any of those rows would leave the
 * object on the site. Each is cut, and each has to pass the same check at the
 * importer's resolved id position.
 *
 * The importer settles identity end to end. `parseTelarCsv` reads this source
 * and names the ids; the rows kept here are Papa's rows under a detector
 * `createCsvRecordSkipDetector` builds fresh for this call, the same
 * classifier `parseTelarCsv` runs over the same rows of the same parse — one
 * factory, so the file-wide "has the header test been spent yet" position is
 * tracked once rather than remembered separately by each caller. The two
 * sequences are therefore the same rows, and the object at the importer's
 * N-th row owns the N-th of them. An id the importer never saw is the one
 * genuine absence, and it is the only route to one.
 *
 * The file has to have read clean before either an absence or a removal is
 * reachable, because both commit the object's images away: a record Papa
 * rejects has swallowed characters that belong to rows nobody can now see, and
 * the object hiding among them is missing from every reading. The two
 * remaining agreements are the sequence lengths and the target's own cell at
 * the importer's resolved id position. Any of them failing is `unusable`.
 *
 * Ids are compared as written, as the importer stores them: `map` and `map  `
 * are two objects on the site, and a delete of one leaves the other's row. An
 * id that no row carries as written but that a row carries once stripped is an
 * id stored before ids were read as written; the file is `unusable` for it
 * rather than a place it is absent from, since an absence would commit the
 * object's images away and leave its row.
 */
export function removeObjectRecord(source: string, objectId: string): CsvRecordRemoval {
  const sheet = readObjectsSheetRows(source);
  if (!sheet) return { status: "unusable" };
  const { idColumn, data, imported } = sheet;

  const targets = data.filter((_, position) => imported[position][ID_COLUMN] === objectId).map((kept) => kept.row);
  if (targets.length === 0) return noRecordFor(imported, objectId);
  if (targets.some((target) => target.cells[idColumn] !== objectId)) return { status: "unusable" };

  let text = "";
  let kept = 0;
  for (const target of targets) {
    text += source.slice(kept, target.range.start);
    kept = target.range.end;
  }
  text += source.slice(kept);

  return removalReadingAs(text, imported.filter((row) => row[ID_COLUMN] !== objectId));
}

/** `removed` with `text`, plus `survivors` when `text` reads one row fewer than they are. */
function removalReadingAs(text: string, survivors: Record<string, string>[]): CsvRecordRemoval {
  const reread = parseTelarCsv(text, undefined, false, OBJECTS_CANONICAL_SCOPE);
  return reread.length === survivors.length ? { status: "removed", text } : { status: "removed", text, survivors };
}


// ---------------------------------------------------------------------------
// Cell edits in place
// ---------------------------------------------------------------------------

/**
 * The delimiter every reading here is taken with: the importer's configuration
 * pins it, so Papa reports no other (`TELAR_CSV_PARSE_CONFIG`). Read when
 * called, not when the module loads, so a test that replaces the importer
 * can still load this module.
 */
function fileDelimiter(): string {
  return TELAR_CSV_PARSE_CONFIG.delimiter as string;
}

/** One cell of a reading to replace: its row in the reading, its column, its new decoded value. */
interface CellReplacement {
  row: number;
  column: number;
  value: string;
}

/** A field's extent within its record's text, and whether it was written quoted. */
interface FieldExtent {
  start: number;
  end: number;
  quoted: boolean;
}

/**
 * Where the quoted field opening at `open` ends in a record's text: the
 * delimiter or the record's end that closes it, with the spaces Papa lets sit
 * between a closing quote and either (`extraSpaces`, papaparse.js:1699-1708)
 * counted inside the field. A doubled quote is one literal quote; any other
 * quote that closes nothing is passed over, as Papa passes it.
 */
function quotedExtentEnd(text: string, open: number, delimiter: string): number {
  let from = open + 1;
  for (;;) {
    const quote = text.indexOf('"', from);
    if (quote === -1) return text.length;
    if (text[quote + 1] === '"') {
      from = quote + 2;
      continue;
    }
    let after = quote + 1;
    while (after < text.length && text[after] !== delimiter && text[after].trim() === "") after++;
    if (after === text.length || text[after] === delimiter) return after;
    from = quote + 1;
  }
}

/**
 * The extents of a record's fields within its own text, terminator excluded.
 * `opensFile` drops the leading mark Papa strips from the file's first
 * character, which belongs to no field.
 */
function fieldExtents(text: string, delimiter: string, opensFile: boolean): FieldExtent[] {
  const extents: FieldExtent[] = [];
  let start = opensFile && text.startsWith(BOM) ? BOM.length : 0;
  for (;;) {
    const quoted = text[start] === '"';
    const found = quoted ? quotedExtentEnd(text, start, delimiter) : text.indexOf(delimiter, start);
    const end = found === -1 ? text.length : found;
    extents.push({ start, end, quoted });
    if (end >= text.length) return extents;
    start = end + delimiter.length;
  }
}

/**
 * `value` written as a field: quoted when the field it replaces was, or when
 * the value holds a character an unquoted field cannot carry.
 */
function encodeField(value: string, quoted: boolean, delimiter: string): string {
  const needsQuotes = quoted || value.includes(delimiter) || /["\r\n]/.test(value) || value.startsWith(BOM);
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * `source` with each replacement's field rewritten over its own characters and
 * every other character untouched, or null when that cannot be vouched for.
 *
 * The field extents come from a quoting-aware walk of the row's own range,
 * and the walk has to find exactly as many fields as Papa gave the row. The
 * result is then read again and has to give the same rows with only the
 * replaced cells changed: an edit whose text reads as anything else would
 * commit a file the author did not ask for.
 */
function replaceCells(source: string, reading: CsvSourceReading, replacements: CellReplacement[]): string | null {
  const splices: { start: number; end: number; text: string }[] = [];
  const expected = reading.rows.map((row) => [...row.cells]);
  for (const { row, column, value } of replacements) {
    const { range, cells } = reading.rows[row];
    const extents = fieldExtents(range.text, fileDelimiter(), range.start === 0);
    if (extents.length !== cells.length || column >= extents.length) return null;
    const extent = extents[column];
    splices.push({
      start: range.start + extent.start,
      end: range.start + extent.end,
      text: encodeField(value, extent.quoted, fileDelimiter()),
    });
    expected[row][column] = value;
  }
  splices.sort((a, b) => a.start - b.start);

  let text = "";
  let kept = 0;
  for (const splice of splices) {
    text += source.slice(kept, splice.start) + splice.text;
    kept = splice.end;
  }
  text += source.slice(kept);

  return rereadsAsCells(text, expected) ? text : null;
}

/** True when `text` reads clean to exactly `expected`, row by row and cell by cell. */
function rereadsAsCells(text: string, expected: string[][]): boolean {
  const reread = cleanReadingOf(text);
  if (!reread || reread.rows.length !== expected.length) return false;
  return reread.rows.every((row, i) => sameCells(row.cells, expected[i]));
}

/** The outcome of renaming an object's records in objects.csv. */
export type CsvObjectRename =
  /** `text` is the source with the renamed rows' cells rewritten; `rows` counts them. */
  | { status: "renamed"; text: string; rows: number }
  /** The CSV reads cleanly and holds no record for that object. */
  | { status: "absent" }
  /** No usable header, or a file this scan cannot claim to have read. */
  | { status: "unusable" };

/** The objects.csv cells a rename rewrites beside the id, when they name what moved. */
export type RenamedObjectCell = "source_url" | "thumbnail";

/**
 * Returns `source` with every record of the object `oldId` carrying `newId`,
 * and nothing else changed but the cells `rewriteCell` answers for.
 *
 * A record is the object's when the importer reads its id as `oldId` as
 * written, or as `oldId` once stripped as `pythonStrip` strips it: an id held
 * in D1 from before ids were read as written is the stripped form of the
 * cell. Every such record is renamed, since the site builds the object from
 * the last of them and a rename that left one would leave the old id on the
 * site. The id cell itself has to be the importer's id for that row, as a
 * delete requires.
 *
 * `rewriteCell` is asked about the record's `source_url` and `thumbnail`
 * cells, at the positions the importer resolves them to, and answers the new
 * value or null to leave the cell.
 */
export function renameObjectRecords(
  source: string,
  oldId: string,
  newId: string,
  rewriteCell: (column: RenamedObjectCell, value: string) => string | null = () => null,
): CsvObjectRename {
  const sheet = readObjectsSheetRows(source);
  if (!sheet) return { status: "unusable" };
  const targets = objectRecordsOf(sheet, oldId);
  if (targets === null) return { status: "unusable" };
  if (targets.length === 0) return { status: "absent" };

  const others: [RenamedObjectCell, number][] = [
    ["source_url", resolvedColumnPosition(sheet.table, "source_url", OBJECTS_CANONICAL_SCOPE)],
    ["thumbnail", resolvedColumnPosition(sheet.table, "thumbnail", OBJECTS_CANONICAL_SCOPE)],
  ];
  const replacements = targets.flatMap((target) => [
    { row: target.index, column: sheet.idColumn, value: newId },
    ...otherCellReplacements(target, others, rewriteCell),
  ]);

  const text = replaceCells(source, sheet.reading, replacements);
  return text === null ? { status: "unusable" } : { status: "renamed", text, rows: targets.length };
}

/**
 * The kept rows of the object `oldId`, or null when one of them does not hold
 * the importer's id for it at the id position.
 */
function objectRecordsOf(sheet: ObjectsSheetRows, oldId: string): KeptRow[] | null {
  const { idColumn, data, imported } = sheet;
  const positions = data.flatMap((_, position) => (isRecordOf(imported[position][ID_COLUMN] ?? "", oldId) ? [position] : []));
  if (positions.some((position) => data[position].row.cells[idColumn] !== imported[position][ID_COLUMN])) return null;
  return positions.map((position) => data[position]);
}

/** The `source_url` and `thumbnail` cells of one renamed row that `rewriteCell` changes. */
function otherCellReplacements(
  target: KeptRow,
  others: [RenamedObjectCell, number][],
  rewriteCell: (column: RenamedObjectCell, value: string) => string | null,
): CellReplacement[] {
  const replacements: CellReplacement[] = [];
  for (const [name, column] of others) {
    const cell = column === -1 ? undefined : target.row.cells[column];
    const next = cell === undefined ? null : rewriteCell(name, cell);
    if (next !== null && next !== cell) replacements.push({ row: target.index, column, value: next });
  }
  return replacements;
}

/** True when an imported id names the object `oldId`, as written or stripped. */
function isRecordOf(importedId: string, oldId: string): boolean {
  return importedId === oldId || pythonStrip(importedId) === oldId;
}

/** The outcome of rewriting cells of a story CSV or glossary.csv in place. */
export type CsvCellRewrite =
  /** `text` is the source with `cells` cells rewritten and nothing else changed. */
  | { status: "rewritten"; text: string; cells: number }
  /** No cell needed rewriting; the file stays as it is. */
  | { status: "unchanged" }
  /** A file this scan cannot claim to have read. */
  | { status: "unusable" };

/**
 * Rewrites, in the rows the importer keeps, every cell `rewrite` answers for,
 * given the folded name the importer declares for the cell's column under
 * `scope` (two columns declaring one name are both asked). Header rows,
 * comment rows and cells past the header are never asked.
 */
function rewriteDeclaredColumns(
  source: string,
  scope: ReadonlySet<string>,
  rewrite: (name: string, value: string) => string | null,
  sheetAliases?: Readonly<Record<string, string>>,
): CsvCellRewrite {
  const reading = cleanReadingOf(source);
  if (!reading) return source.trim() === "" ? { status: "unchanged" } : { status: "unusable" };
  const names = importedHeader(reading.rows.map((row) => row.cells), scope).declaredNames;

  const replacements: CellReplacement[] = [];
  for (const { index, row } of keptRowsOf(reading, sheetAliases)) {
    names.forEach((name, column) => {
      const cell = row.cells[column];
      if (name === undefined || cell === undefined) return;
      const next = rewrite(foldHeader(name), cell);
      if (next !== null && next !== cell) replacements.push({ row: index, column, value: next });
    });
  }
  if (replacements.length === 0) return { status: "unchanged" };

  const text = replaceCells(source, reading, replacements);
  return text === null ? { status: "unusable" } : { status: "rewritten", text, cells: replacements.length };
}

/** The story column naming each step's object. */
const OBJECT_COLUMN = "object";

/**
 * The raw `object` cells of a story CSV's kept rows, from every column the
 * importer declares as `object`, or null for a file that does not read clean.
 */
export function storyObjectValues(source: string): string[] | null {
  const reading = cleanReadingOf(source);
  if (!reading) return source.trim() === "" ? [] : null;
  const names = importedHeader(reading.rows.map((row) => row.cells), STORY_CANONICAL_SCOPE).declaredNames;
  const values: string[] = [];
  for (const { row } of keptRowsOf(reading)) {
    names.forEach((name, column) => {
      const cell = row.cells[column];
      if (name !== undefined && foldHeader(name) === OBJECT_COLUMN && cell !== undefined) values.push(cell);
    });
  }
  return values;
}

/** What a rename changes in a story CSV. */
export interface StoryCsvRename {
  /** The raw `object` values that name the renamed object (`renameStepValues`). */
  stepValues: ReadonlySet<string>;
  newId: string;
  /** The rewrite of the file references in one cell of layer text. */
  rewriteText: (text: string) => string;
}

/**
 * True for a layer column the framework reads as panel content: every
 * `*_content` or `*_file` column (`_process_content_columns`,
 * scripts/telar/processors/stories.py).
 */
function isLayerColumn(name: string): boolean {
  return name.endsWith("_content") || name.endsWith("_file");
}

/**
 * Returns a story CSV with each `object` cell whose raw value is one of
 * `stepValues` set to `newId`, and each layer cell holding inline text (one
 * not naming a `.md` file, as the framework tells them apart) carrying its
 * file references rewritten; every other character stays.
 */
export function rewriteStoryCsv(source: string, rename: StoryCsvRename): CsvCellRewrite {
  return rewriteDeclaredColumns(source, STORY_CANONICAL_SCOPE, (name, value) => {
    if (name === OBJECT_COLUMN) return rename.stepValues.has(value) ? rename.newId : null;
    if (isLayerColumn(name) && !pythonStrip(value).endsWith(".md")) return rename.rewriteText(value);
    return null;
  });
}

/** Returns glossary.csv with the file references in each `definition` cell rewritten. */
export function rewriteGlossaryCsv(source: string, rewriteText: (text: string) => string): CsvCellRewrite {
  return rewriteDeclaredColumns(
    source,
    GLOSSARY_CANONICAL_SCOPE,
    (name, value) => (name === "definition" ? rewriteText(value) : null),
    GLOSSARY_COLUMN_ALIASES,
  );
}

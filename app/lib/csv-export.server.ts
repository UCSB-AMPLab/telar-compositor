/**
 * CSV serialisation utilities for Telar Compositor.
 *
 * Serialises D1 object rows back to the framework v1.0.0 objects.csv format
 * used by Telar sites. The output includes the standard header row, the
 * bilingual row (required by Telar's CSV parser), and one data row per object.
 *
 * Column set is the v1.0.0 authoritative list — object_type column renamed to
 * medium_genre (matching framework v1.0.0 CSV schema change).
 *
 * @version v1.5.0-beta
 */

import Papa from "papaparse";
import { OBJECTS_CSV_COLUMNS, foldHeader } from "~/lib/column-mapping";
import { BOM, isCommentCell } from "~/lib/csv-records";
import { readCsvSourceRows } from "~/lib/csv-record-scan.server";
import type { CsvSourceReading } from "~/lib/csv-record-scan.server";
import {
  csvSheetFor,
  isCommentRow,
  mapObjectsCsv,
  positionalRow,
} from "~/lib/import.server";
import { cellOf, chosenSheetLayout, fileSheetLayout, plainSheetLayout } from "~/lib/sheet-csv-layout.server";
import type { SheetCsvLayout } from "~/lib/sheet-csv-layout.server";
import {
  MODELLED_OBJECT_EXTRA_ALIASES,
  extraColumnUnion,
  parseExtraColumns,
} from "~/lib/extra-columns.server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export { OBJECTS_CSV_COLUMNS };

/**
 * Bilingual header row mapping each English column name to its Spanish equivalent.
 * Required by Telar's CSV parser — the second row is the Spanish label row.
 */
export const BILINGUAL_ROW: Record<string, string> = {
  object_id: "id_objeto",
  title: "titulo",
  featured: "destacado",
  creator: "creador",
  description: "descripcion",
  source_url: "url_fuente",
  period: "periodo",
  year: "año",
  medium_genre: "medio_genero",
  subjects: "temas",
  source: "fuente",
  credit: "credito",
  thumbnail: "miniatura",
  alt_text: "texto_alt",
  dimensions: "dimensiones",
};
// `col` here can be a custom column name from a user's own objects.csv (see
// `extraKeys` in serializeObjectsCsv below) — a file-supplied string, so a
// lookup on a plain object literal would return an inherited property for
// keys like `__proto__` or `constructor` instead of `undefined`. This line
// removes every inherited property so a lookup here can only ever return
// one of the entries above, or `undefined`.
Object.setPrototypeOf(BILINGUAL_ROW, null);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObjectRow {
  object_id: string;
  title: string | null;
  featured: boolean | null;
  creator: string | null;
  description: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  medium_genre: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  alt_text: string | null;
  dimensions?: string | null;
  /** JSON passthrough blob of custom columns not mapped to first-class fields. */
  extra_columns?: string | null;
}

/**
 * Shape of a D1 objects row (or a pending-upload row that shadows the D1
 * shape). The only CSV-relevant departure from ObjectRow is the object_type
 * column, which Telar v1.0.0 renamed to medium_genre at the CSV layer
 * while D1 keeps the original `object_type` column name internally.
 */
export interface ObjectDbRow {
  object_id: string;
  title: string | null;
  featured: boolean | null;
  creator: string | null;
  description: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  object_type: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  alt_text: string | null;
  dimensions?: string | null;
  extra_columns?: string | null;
}

/**
 * Maps a D1 objects row to the ObjectRow shape expected by serializeObjectsCsv.
 * Centralises the object_type ↔ medium_genre column rename so every call site
 * uses the same transform.
 */
export function dbObjectToCsvRow(row: ObjectDbRow): ObjectRow {
  return {
    object_id: row.object_id,
    title: row.title ?? null,
    featured: row.featured ?? null,
    creator: row.creator ?? null,
    description: row.description ?? null,
    source_url: row.source_url ?? null,
    period: row.period ?? null,
    year: row.year ?? null,
    medium_genre: row.object_type ?? null,
    subjects: row.subjects ?? null,
    source: row.source ?? null,
    credit: row.credit ?? null,
    thumbnail: row.thumbnail ?? null,
    alt_text: row.alt_text ?? null,
    dimensions: row.dimensions ?? null,
    extra_columns: row.extra_columns ?? null,
  };
}

/**
 * An objects.csv holding exactly these parsed rows in the Compositor's own
 * layout: the header, the bilingual row the framework's header test spends on,
 * `existingCsv`'s comment rows, then the rows with every cell as the author
 * wrote it. Used where cutting a record's bytes out would leave a row that
 * reads as a repeated header first in the file.
 */
export function reserialiseSurvivingObjects(rows: Record<string, string>[], existingCsv?: string): string {
  // `dbObjectToCsvRow` reads an absent column as null, so the insert shape's
  // undefined fields need no filling in here. The mapper's alt_text falls back
  // to the title, which a row that left the cell blank did not ask for.
  const objectRows = rows.flatMap((raw) =>
    mapObjectsCsv([raw]).map((row) => dbObjectToCsvRow({ ...(row as unknown as ObjectDbRow), alt_text: raw.alt_text || null })),
  );
  return serializeObjectsCsv(objectRows, existingCsv);
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * The comment records of an existing CSV — the instruction rows the framework's
 * spreadsheet template ships with, and any note an author has added beside
 * them — returned verbatim so a rewrite carries them over.
 *
 * Records, not lines. A quoted field may hold a newline: a custom column's
 * header can, and a description routinely does. Cut on physical lines, such a
 * record's continuation is judged on its own, and one beginning `#` is taken
 * for a comment of its own — extracted, emitted above the data, and extracted
 * again from that output, so the file grows a copy on every republish.
 *
 * A record counts as a comment when its first field opens with `#`, quoted or
 * not, which is where the framework draws the same line. The field is the one
 * Papa decodes and the test is `isCommentCell`, the very predicate the
 * importer's row detector classifies comments with: a record the importer
 * drops and this function does not keep is an author's comment that survives
 * every reading of
 * the file except the one that rewrites it. What that costs,
 * measured against both releases on 14 September: `telar.core.csv_to_json`,
 * which reads objects.csv, and
 * `generate_collections._generate_glossary_from_csv`, which writes the glossary
 * pages, each drop a record whose first cell begins `#`, at the published
 * release tag and on the test instance alike. The link-map reader
 * `telar.glossary.load_glossary_from_csv`
 * drops nothing: at both releases it reads such a record as a term, as it reads
 * the bilingual row. So a preserved comment row costs one spurious entry in the
 * glossary link map and nothing at all in the pages or the object data.
 *
 * A U+FEFF at the file's offset zero is dropped from the comment that carries
 * it: the mark belongs to the encoding, and only the first record can hold one
 * there. Anywhere else in a comment it is a character the author put in, and it
 * is kept.
 *
 * Readability is judged with the file's own terminator appended, because that
 * is what Papa had in front of it when it read the record in the file. A quote
 * closed with spaces before the terminator is Papa's `extraSpaces` rule and
 * legal; the same characters with nothing after them are `InvalidQuotes` and
 * `MissingQuotes`, so a comment the file carries fine reads as broken and the
 * author loses it without being told.
 *
 * A record Papa still cannot read — an unterminated quoted field, a quote
 * followed by text — is REPAIRED rather than dropped or carried: see
 * `repairCommentRecord`. Dropping loses the author's text, and carrying it
 * verbatim re-inserts an unterminated quote ABOVE the data, where it swallows
 * every data row beneath it and the file publishes with one field where the
 * objects were. Verbatim preservation and comment status cannot both hold for a
 * record whose own characters open with a quote, so comment status is what is
 * kept: the repair is the only edit the Compositor ever makes to a comment.
 *
 * What the framework makes of a repaired row, measured against both releases on
 * 15 September and identical at the two: the objects reader
 * `telar.core.csv_to_json` drops it, because pandas has the quotes off by then
 * and the first cell strips to text beginning `#`. The glossary page generator
 * skips a term whose `term_id` opens `#` (scripts/generate_collections.py:348
 * on the test instance, :300 at the published tag). The link-map reader
 * `telar.glossary.load_glossary_from_csv` skips nothing, so a repaired record
 * wide enough to carry a title costs one spurious entry there — the same one a
 * preserved comment has always cost.
 */
/**
 * A malformed comment candidate rewritten as a plain `#` line: its first
 * physical line, every `"` in it turned into `'`, leading spaces removed, and a
 * `#` in front if it does not already open with one.
 *
 * The first line only. A candidate whose quote never closes runs to the end of
 * the file, and the lines after the first are data rows the serializer writes
 * again from D1 — kept here they would publish twice.
 *
 * The quotes go because a comment that carries CSV quoting is the one shape
 * that can swallow the data below it or become a record of its own: left
 * verbatim an unterminated quote takes every row beneath it into one field,
 * and quoted whole the cell opens with a quote, which every reader of these
 * files takes for a value rather than for a comment. Turned into apostrophes
 * the author's characters are all still there, in a row that opens `#` and
 * closes nothing — a comment to the framework's objects reader and to its
 * glossary page generator alike, and the same text again on the next
 * republish, where this function is not reached at all because the row it
 * produces is one Papa reads without complaint.
 *
 * This is the only edit the Compositor ever makes to a comment. A comment Papa
 * reads is carried through byte for byte.
 */
function repairCommentRecord(record: string): string {
  const firstLine = record.split(/\r|\n/)[0];
  const unquoted = firstLine.split('"').join("'").replace(/^ +/, "");
  return unquoted.startsWith("#") ? unquoted : `#${unquoted}`;
}

/**
 * Whether a record Papa refused was reaching for a comment.
 *
 * Papa hands back a decoded cell even for a record it reports an error on: an
 * unterminated quote yields the rest of the input as the field's value, and a
 * quote followed by text yields everything it scanned past. That value is the
 * one the importer classifies, so it is the one asked first. The raw first
 * line, stripped of an opening quote and the whitespace behind it, stands in
 * only where Papa hands back no cell at all — a shape the marker would reach
 * only through the quoting the repair is about to remove.
 */
function isCommentCandidate(decoded: string | undefined, record: string): boolean {
  if (decoded !== undefined) return isCommentCell(decoded);
  return isCommentCell(record.split(/\r|\n/)[0].replace(/^"/, ""));
}

/**
 * Raised when the file a republish must carry comments through cannot be read
 * record by record.
 *
 * An empty list is the answer for a file with no comments, so it cannot also be
 * the answer for a file whose comments could not be found: returning it would
 * publish a file with the author's instruction rows silently gone, and every
 * publish after would have nothing left to carry. A throw stops the publish
 * with the file in the repository untouched.
 */
export class CsvCommentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvCommentExtractionError";
  }
}

/**
 * The comment records of `existingCsv`, each as the characters it occupies in
 * the file, for a republish to write back above the data.
 *
 * Which records those are is settled on the file's OWN parse — the rows
 * `readCsvSourceRows` reads under the importer's configuration — and on
 * `isCommentRow`, the importer's own predicate, over the cells that parse
 * produced. A record re-read on its own is read without the file in front of
 * it: Papa strips a U+FEFF at offset zero of whatever string it is handed, so
 * a mid-file mark that is field content in the file becomes an encoding mark
 * in the record, the quote behind it opens a field it never opened, and a data
 * row the importer keeps is republished as a comment above the header — where
 * the framework reads it as an object again, under an id carrying the mark.
 *
 * Surplus cells are dropped before the question is asked, because the header
 * declares how wide a row is and the importer weighs no cell past it. A row
 * kept here that the importer keeps as data would be written twice: once
 * verbatim as a comment, once from D1.
 *
 * A record Papa refused cannot be carried through verbatim — an unterminated
 * quote swallows every row beneath it — so a refused record reaching for the
 * marker is repaired instead, and one that is not is dropped, as a record
 * carrying no comment always has been.
 *
 * A file whose rows and ranges do not line up yields no reading at all, and
 * that is `CsvCommentExtractionError` rather than an empty list: no comment is
 * a fact about the file, and no reading is a fact about this function.
 */
export function extractCommentRows(existingCsv: string): string[] {
  return commentRecordsOf(readCsvForComments(existingCsv)).map((record) => record.text);
}

/**
 * The reading a republish carries comments from, or `CsvCommentExtractionError`
 * when the file's rows could not be matched to the characters they were read
 * from.
 */
export function readCsvForComments(existingCsv: string): CsvSourceReading {
  const reading = readCsvSourceRows(existingCsv);
  if (!reading) {
    throw new CsvCommentExtractionError(
      "The existing CSV's rows could not be matched to the characters they were read " +
        "from, so its comment rows cannot be carried through. Publishing would drop them.",
    );
  }
  return reading;
}

/**
 * One comment record a republish carries: the text it writes back, and the
 * cells Papa decoded it to, or null for a record Papa refused, whose text is
 * the repair and whose cells cannot be trusted.
 */
export interface CsvCommentRecord {
  text: string;
  cells: string[] | null;
}

/**
 * The comment records of a reading, in file order (see `extractCommentRows`).
 *
 * `headerWritten` says whether the caller writes the file's own header record
 * back as the header. A caller writing a header of its own carries a first
 * record that opens with the marker as a comment, since the header it writes
 * replaces that record. A caller writing the file's header already has that
 * record as its header line, so it is no comment: carried as one as well, it
 * would be written a second time on every publish.
 */
export function commentRecordsOf(reading: CsvSourceReading, headerWritten = false): CsvCommentRecord[] {
  if (reading.rows.length === 0) return [];
  const rows = reading.rows;
  const headerWidth = rows[0].cells.length;

  return rows.flatMap((row, index): CsvCommentRecord[] => {
    if (index === 0 && headerWritten) return [];
    // A mark at the file's offset zero is its encoding, and the only record
    // that can hold one there is the first. Carried into the output it lands
    // below the generated header, where pandas keeps it and Python's `strip`
    // does not remove it, so both objects readers hold a phantom object whose
    // id is the mark and the comment's own text. A mark anywhere else in a
    // comment is a character the author put there.
    const record = row.range.text;
    const text = index === 0 && record.startsWith(BOM) ? record.slice(BOM.length) : record;
    if (row.rejected) {
      return isCommentCandidate(row.cells[0], text) ? [{ text: repairCommentRecord(text), cells: null }] : [];
    }
    return isCommentRow(positionalRow(row.cells.slice(0, headerWidth))) ? [{ text, cells: row.cells }] : [];
  });
}

/**
 * One published data row: the fixed columns, then only the extra keys that
 * survive the modelled-column filter.
 *
 * Never spread the whole blob: a blob key equal to a fixed column's name would
 * overwrite that column's value, so a stale `medium_genre` inside
 * extra_columns would publish in place of the editor's — and the header filter
 * cannot see that, because it only decides which columns exist. Adding the
 * kept keys one by one, under the same header fold, is what makes the two
 * agree however the blob key is spelled.
 *
 * The row has a null prototype because an extras key can be `__proto__`,
 * `constructor` or `toString`: a plain object literal answers those from
 * Object.prototype, so a row that never declared the column would publish
 * `[object Object]` or a function's source where an empty cell belongs.
 */
function objectDataRow(obj: ObjectRow, parsed: Record<string, string>): Record<string, string> {
  const row = Object.create(null) as Record<string, string>;
  Object.assign(row, {
    object_id: obj.object_id,
    title: obj.title ?? "",
    featured: obj.featured ? "yes" : "",
    creator: obj.creator ?? "",
    description: obj.description ?? "",
    source_url: obj.source_url ?? "",
    period: obj.period ?? "",
    year: obj.year ?? "",
    medium_genre: obj.medium_genre ?? "",
    subjects: obj.subjects ?? "",
    source: obj.source ?? "",
    credit: obj.credit ?? "",
    thumbnail: obj.thumbnail ?? "",
    alt_text: obj.alt_text ?? "",
    dimensions: obj.dimensions ?? "",
  });
  for (const key of Object.keys(parsed)) {
    if (MODELLED_OBJECT_EXTRA_ALIASES[foldHeader(key)] !== undefined) continue;
    row[key] = parsed[key];
  }
  return row;
}

/**
 * The custom-column keys an objects.csv actually carries, in the order it
 * carries them: the sorted union of every row's blob, less the keys this
 * serializer drops.
 *
 * A key naming a field the Compositor already models is excluded: that field
 * has its own column in OBJECTS_CSV_COLUMNS, and emitting the blob's copy too
 * would put two columns in the file that the framework renames onto one
 * canonical name — which newer framework releases refuse to build and older
 * ones resolved silently in favour of whichever came last, the blob's copy.
 *
 * The primary guard is `promoteModelledExtras`, run by the Durable Object when
 * it loads a document: it empties these keys out of the stored blob, so in
 * normal operation nothing reaches here to exclude. This is the second line,
 * for a blob that has not been through that repair. It drops the column rather
 * than promoting it, because a value belongs in its field and the field is
 * already written by `objectDataRow`.
 *
 * One function, because the publish check that predicts what the framework
 * will make of this file has to predict on the headers the file WILL have. A
 * check reading the unfiltered union refuses a publish over a column this
 * never writes, and names a single spelling the author has no second copy of
 * to delete.
 */
export function objectsExtraColumnKeys(parsedRows: Array<Record<string, string>>): string[] {
  return extraColumnUnion(parsedRows).filter(
    (k) => MODELLED_OBJECT_EXTRA_ALIASES[foldHeader(k)] === undefined,
  );
}

/**
 * The layout of `existingCsv` for D1's `keptKeys` (sheet-csv-layout.server.ts),
 * or null when it has no header record or Papa refused it. A file whose rows
 * cannot be matched to their characters throws `CsvCommentExtractionError`.
 */
export function fileObjectsLayout(existingCsv: string, keptKeys: readonly string[]): SheetCsvLayout | null {
  const reading = readCsvForComments(existingCsv);
  return fileSheetLayout(csvSheetFor("objects"), reading, commentRecordsOf(reading, true), keptKeys);
}

/**
 * Serialises object rows to objects.csv: the header, the bilingual row, the
 * comment rows, then one data row per object, in the order given (every caller
 * orders by `objectsSheetOrder()`).
 *
 * With an existing file, in that file's own layout (`fileObjectsLayout`).
 * Without one, or where `chosenSheetLayout` refuses the file's layout, in the
 * canonical layout: the fixed columns, the custom columns in D1's order, and
 * the file's comment rows as `extractCommentRows` reads them.
 *
 * Conventions:
 *   - `featured: true` → "yes", `featured: false/null` → ""
 *   - All null fields → ""
 *   - Fields with commas or newlines are quoted by PapaParse automatically
 */
export function serializeObjectsCsv(objectRows: ObjectRow[], existingCsv?: string): string {
  // Parse extras once per row, preserving order alongside objectRows, then take
  // the keys the file carries. Both steps are shared implementations, so the
  // two serializers cannot drift in how a blob is read, and the publish check
  // cannot drift from either.
  const allParsed = objectRows.map((row) => parseExtraColumns(row.extra_columns));
  const extraKeys = objectsExtraColumnKeys(allParsed);

  // Data rows, each a null-prototype record of the fixed columns and only the
  // extra keys that survived the filter above (`objectDataRow`).
  const dataRows = objectRows.map((obj, i) => objectDataRow(obj, allParsed[i]));

  const layout = chosenSheetLayout(
    "objects.csv",
    existingCsv ? fileObjectsLayout(existingCsv, extraKeys) : null,
    () => plainSheetLayout(OBJECTS_CSV_COLUMNS, extraKeys, existingCsv ? extractCommentRows(existingCsv) : []),
    OBJECTS_CSV_COLUMNS,
    extraKeys,
    dataRows,
  );

  // Helper: normalise PapaParse output to LF-only line endings
  const normalise = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Header record. Every section of this file is unparsed as a complete record
  // set, never cut out of a larger one by splitting on a newline: a custom
  // column's header is the author's own text and a quoted CSV header may hold a
  // newline, so a section taken as the text up to the first physical newline
  // ends mid-record and the bilingual row lands inside the header's own quotes.
  const headerCsv = normalise(Papa.unparse([layout.columns.map((c) => c.header)], { header: false }));

  // Bilingual row — Spanish column name equivalents required by Telar's CSV
  // parser, looked up by the fixed column's English name whatever header the
  // file gives it. Custom columns intentionally get an EMPTY cell rather than
  // echoing their key: both header detectors (Compositor's isHeaderRow and the
  // framework's is_header_row) exclude empty cells from their known-bilingual
  // ratio, so emitting empties keeps the ratio at 1.0 regardless of how many
  // custom columns there are. Echoing the keys instead would dilute the ratio
  // below the 0.8 threshold at 4+ custom columns, so the bilingual row would be
  // mis-ingested as a phantom data object (object_id = "id_objeto"), corrupting
  // re-import and the live site.
  const bilingualRow = normalise(
    Papa.unparse(
      [layout.columns.map((c) => (c.source.kind === "fixed" ? (BILINGUAL_ROW[c.source.name] ?? "") : ""))],
      { header: false },
    ),
  );

  const dataCsv = normalise(
    Papa.unparse(
      dataRows.map((row) => layout.columns.map((c) => cellOf(c.source, row))),
      { header: false },
    ),
  );

  const sections = [headerCsv, bilingualRow, ...layout.commentRows, dataCsv];
  return sections.join("\n");
}

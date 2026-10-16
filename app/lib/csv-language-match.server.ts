/**
 * The manifest's `csv_language_match` operation: one cell of a sheet, found by
 * its row's key and its column, replaced by the text in the site's language
 * when it still holds one of the texts a case names.
 *
 * The rule is the framework's (`_correct_glossary` in
 * scripts/migrations/v181_to_v182.py). A cell matches a case's `equals` once
 * CRLF is read as LF. The text written takes the line ending the cell had, or
 * the file's where the cell had none. A cell that matches no case, an absent
 * file, column or row, a key held by more than one row, and a case with no
 * text for the site's language change nothing.
 *
 * Columns are found by the identity the Compositor reads every header under
 * (`foldHeader` through COLUMN_NAME_MAPPING), so a sheet the Compositor
 * published under Spanish headers (`id_término`, `definición`) is matched by
 * the manifest's English names.
 *
 * Only the changed field's text is replaced, so every other byte of the file
 * is kept, quoting and line endings included. The field is found by its
 * column's position among the row's fields, read with the rules papaparse
 * reads them with; a row whose fields cannot be read back to the cells
 * papaparse gave is left alone.
 *
 * The site's language is the framework's (`_detect_language` in
 * scripts/migrations/base.py), read from `_config.yml` as the chain has left
 * it: see `frameworkLanguage`.
 *
 * @version v1.5.5-beta
 */

import Papa from "papaparse";
import { load } from "js-yaml";
import { COLUMN_NAME_MAPPING, foldHeader } from "~/lib/column-mapping";
import type { CsvLanguageMatchOp, Language } from "~/lib/manifest-schema.server";

/** One record as parsed, with where its text starts and ends in the file, its line terminator excluded. */
interface SourceRecord {
  cells: string[];
  start: number;
  end: number;
  blank: boolean;
}

/** Every record of `content`, read with the comma pinned as the other CSV operations read it. */
function readRecords(content: string): SourceRecord[] {
  const records: SourceRecord[] = [];
  let start = 0;
  Papa.parse<string[]>(content, {
    skipEmptyLines: false,
    delimiter: ",",
    step: (result) => {
      const cursor = result.meta.cursor;
      const raw = content.slice(start, cursor);
      const line = raw.replace(/\r?\n$|\r$/, "");
      if (!(raw === "" && cursor === content.length && records.length > 0)) {
        records.push({ cells: result.data, start, end: start + line.length, blank: /^[ \t]*$/.test(line) });
      }
      start = cursor;
    },
  });
  return records;
}

/** The column a header names, as the Compositor identifies it. */
export function columnIdentity(header: string): string {
  const folded = foldHeader(header);
  return COLUMN_NAME_MAPPING[folded] ?? folded;
}

/** A field as Telar writes one that needs quoting. */
function quotedField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Whether papaparse would quote `value` to write it. */
function needsQuotes(value: string): boolean {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value);
}

/** One field's text in a record: [start, end) relative to the record's start, and the value it reads as. */
interface FieldSpan {
  start: number;
  end: number;
  value: string;
}

/**
 * The fields of one record's text, as papaparse reads them with the comma
 * pinned: a field that opens with a quote runs to the quote that closes it,
 * a doubled quote inside reading as one and a line break inside kept; any
 * other field runs to the next comma.
 */
function fieldSpans(raw: string): FieldSpan[] {
  const spans: FieldSpan[] = [];
  let at = 0;
  for (;;) {
    const field = raw[at] === '"' ? readQuotedField(raw, at) : readPlainField(raw, at);
    if (field === null) return [];
    spans.push({ start: at, end: field.next, value: field.value });
    if (field.next >= raw.length) return spans;
    at = field.next + 1;
  }
}

/** A field read from `raw` and where its text ends. */
interface FieldRead {
  value: string;
  next: number;
}

/** The field that opens with a quote at `from`, or null when it never closes or is not followed by a comma. */
function readQuotedField(raw: string, from: number): FieldRead | null {
  let text = "";
  let at = from + 1;
  for (;;) {
    const close = raw.indexOf('"', at);
    if (close < 0) return null;
    text += raw.slice(at, close);
    if (raw[close + 1] !== '"') {
      const next = close + 1;
      return next < raw.length && raw[next] !== "," ? null : { value: text, next };
    }
    text += '"';
    at = close + 2;
  }
}

/** The field that runs from `from` to the next comma, or to the end of `raw`. */
function readPlainField(raw: string, from: number): FieldRead {
  const comma = raw.indexOf(",", from);
  const next = comma < 0 ? raw.length : comma;
  return { value: raw.slice(from, next), next };
}

/**
 * `content` with `record`'s field at `column` written as `value`, or null
 * when the record's fields do not read back to its cells.
 */
function withCell(content: string, record: SourceRecord, column: number, value: string): string | null {
  const raw = content.slice(record.start, record.end);
  const spans = fieldSpans(raw);
  if (spans.length !== record.cells.length || spans.some((span, i) => span.value !== record.cells[i])) return null;
  const span = spans[column];
  const wasQuoted = raw[span.start] === '"';
  const field = wasQuoted || needsQuotes(value) ? quotedField(value) : value;
  const at = record.start + span.start;
  return content.slice(0, at) + field + content.slice(record.start + span.end);
}

/**
 * The site's language as the framework's migrations read it: the top-level
 * `telar_language`, or `telar.telar_language` where that is absent, lowercased;
 * Spanish when it starts with "es", and English otherwise, including for a
 * config that does not load or a value that is not text.
 */
export function frameworkLanguage(config: string | undefined): Language {
  try {
    const parsed = load(config ?? "") as Record<string, unknown>;
    let lang = parsed.telar_language;
    if (lang === null || lang === undefined) {
      const telar = parsed.telar === undefined ? {} : (parsed.telar as Record<string, unknown>);
      lang = telar.telar_language === undefined ? "en" : telar.telar_language;
    }
    return (lang as string).toLowerCase().startsWith("es") ? "es" : "en";
  } catch {
    return "en";
  }
}

/** The one row `op` names, with the column to write and the cell it holds there; null when the sheet does not hold exactly that. */
function locateCell(records: SourceRecord[], op: CsvLanguageMatchOp): { row: SourceRecord; column: number; cell: string } | null {
  const headerAt = records.findIndex((r) => !r.blank);
  if (headerAt < 0) return null;
  const header = records[headerAt].cells.map(columnIdentity);
  const keyColumn = header.indexOf(columnIdentity(op.key_column));
  const column = header.indexOf(columnIdentity(op.column));
  if (keyColumn < 0 || column < 0) return null;

  const rows = records.slice(headerAt + 1).filter((r) => !r.blank && r.cells[keyColumn] === op.key);
  if (rows.length !== 1) return null;
  const cell = rows[0].cells[column];
  return cell === undefined ? null : { row: rows[0], column, cell };
}

/** `value` with its line breaks in the ending `cell` has, or the file's where the cell has none. */
function inCellLineEnding(value: string, cell: string, content: string): string {
  const newline = cell.includes("\r\n") || (!cell.includes("\n") && content.includes("\r\n")) ? "\r\n" : "\n";
  return value.replace(/\r\n/g, "\n").replace(/\n/g, newline);
}

/**
 * Applies one `csv_language_match` to the virtual filesystem, for a site
 * whose language is `lang`. Returns whether it changed the file.
 */
export function applyCsvLanguageMatch(files: Map<string, string>, op: CsvLanguageMatchOp, lang: Language): boolean {
  const held = files.get(op.file);
  if (held === undefined) return false;
  // papaparse drops a leading byte order mark, so its cursors count from the
  // character after it; the mark is set aside and written back in front.
  const bom = held.startsWith("\uFEFF") ? "\uFEFF" : "";
  const content = held.slice(bom.length);
  const located = locateCell(readRecords(content), op);
  if (located === null) return false;
  const { row, column, cell } = located;
  const matched = op.cases.find((c) => c.equals === cell.replace(/\r\n/g, "\n"));
  const value = matched?.values[lang];
  if (value === undefined) return false;

  const written = inCellLineEnding(value, cell, content);
  if (written === cell) return false;
  const next = withCell(content, row, column, written);
  if (next === null) return false;
  files.set(op.file, bom + next);
  return true;
}

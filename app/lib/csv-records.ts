/**
 * Where one CSV record ends, and which cell makes a record a comment.
 *
 * A record and a line are different things: a quoted field may hold a newline,
 * a comma and doubled quotes, so anything that decides what a row IS has to
 * walk the text with the quoting in hand rather than split it on a newline. A
 * scan over physical lines cuts a record carrying one in two, and each half is
 * then judged on its own — a continuation that happens to begin `#` reads as a
 * comment row, a header's second half reads as a record of its own.
 *
 * The boundaries are PapaParse's, mirrored from its parser (papaparse 5.5.3,
 * `Parser` at papaparse.js:1417, the quoted-field loop at :1534-1638). Papa
 * reads every file this module's callers write and re-read, so a boundary
 * drawn anywhere else is a boundary only one side of the round trip believes
 * in: a record the scan keeps whole and Papa runs on swallows the rows beneath
 * it, and one the scan cuts and Papa keeps whole is re-emitted twice.
 *
 * The delimiter and the terminator are ARGUMENTS, never guesses. Papa settles
 * both per file — it guesses a delimiter whenever the configuration names none
 * (`guessDelimiter`, papaparse.js:1342-1394) and a terminator whenever the
 * configuration names no newline (`guessLineEndings`, :1164-1188) — and reports
 * the pair it used as `meta.delimiter` and `meta.linebreak` (:1791-1792). A
 * second guess made here is a second answer: on a semicolon sheet a scan
 * holding the comma ends a record at the newline inside a quoted title, where
 * Papa reads one row, and the caller cuts a fragment of it.
 *
 * One departure, deliberate: Papa emits a trailing EMPTY record for a text
 * ending in its terminator and this module does not. Comment extraction and
 * record removal both ask which characters belong to which record, and an
 * empty record at the end owns none of them.
 *
 * Below the serializers and the record scanner on purpose, so both can hold
 * the same rule without either importing the other's graph. Its one dependency
 * is `pythonStrip`, a leaf, because the comment rule is CPython's strip and a
 * second transcription of that set here would be the very duplication this
 * module exists to prevent.
 *
 * @version v1.5.0-beta
 */

import { pythonStrip } from "~/lib/column-mapping";

/**
 * Byte-order mark. Belongs to the file's encoding at offset zero, and to a
 * field anywhere else.
 *
 * An escape, not the character: a tool that strips a stray BOM out of a source
 * file would turn a literal into the empty string, and the guard below into
 * `ch === ""`, which is never true — so the mark would open the first field and
 * every record boundary after it would be drawn inside a quoted field.
 */
export const BOM = "\uFEFF";

/**
 * True for a DECODED cell that marks its record a comment — the framework's
 * template instruction rows, and any note an author has added beside them.
 *
 * It mirrors the framework's ROW rule, which is CPython's strip and not
 * JavaScript's: `telar.core.csv_to_json` drops a row whose first cell satisfies
 * `.str.strip().str.startswith('#')` (scripts/telar/core.py:94 on the test
 * instance, :90 at the published tag, the same line at both), and the glossary page
 * generator tests the same marker on an already-stripped term
 * (generate_collections.py:348 and :300, the term stripped at :338 and :291).
 * The two strips disagree over exactly two kinds of code point, and each
 * disagreement is a row one side turns into an object and the other does not.
 * U+FEFF is whitespace to `trim()` and a character to CPython, so a cell
 * opening with the mark is data to every framework reader and would be a
 * comment here — a row the Compositor drops and the site builds, carrying the
 * mark in its id. U+0085 is the reverse: a character to `trim()` and whitespace
 * to CPython, so the cell is a comment there and would be an object here that
 * the site never has.
 *
 * Decoded, never raw: the quoting belongs to the file's encoding of the cell,
 * not to the author's text, so `" #note"` and ` #note` are one comment written
 * two ways. A raw-text test sees a quote and a space in front of the marker and
 * calls the first of them data, which puts the importer, which skips it, and
 * the serializer, which drops it, on opposite sides of one record: the author's
 * comment disappears from a file every reader of it keeps.
 *
 * One function, so the two cannot answer differently. `isCommentRow` asks it of
 * the row's FIRST cell, the cell the framework's row rule tests, and
 * `extractCommentRows` asks `isCommentRow`, so a republish carries through the
 * records the importer skipped and no others.
 */
export function isCommentCell(value: string): boolean {
  return pythonStrip(value).startsWith("#");
}

/**
 * Whether a glossary.csv row whose term_id cell is `termId` publishes no term:
 * the id, stripped as CPython strips, is blank or opens `#`. The framework's
 * link map and its page generator both skip such a row, so the Compositor holds
 * it aside in the file rather than making a term of it.
 */
export function isHeldTermId(termId: string): boolean {
  return pythonStrip(termId) === "" || isCommentCell(termId);
}

/**
 * `rows` with one row per term_id: the row the framework publishes. Its page
 * generator skips a row with no title and, of rows sharing an id, writes the
 * first (`_csv_page_rows`, `first_at_each_address`, scripts/telar), so the
 * kept row is the id's first titled row, or its first row where none has a
 * title. glossary_terms is UNIQUE on (project_id, term_id) outside held ids
 * (migration 0072), so held ids are passed through, every one of them.
 */
export function publishedRowPerTermId<T extends { term_id?: string | null; title?: string | null }>(
  rows: readonly T[],
): T[] {
  const keptAt = new Map<string, number>();
  rows.forEach((row, i) => {
    const id = row.term_id ?? "";
    if (isHeldTermId(id)) return;
    const kept = keptAt.get(id);
    if (kept === undefined || (!hasTitle(rows[kept]) && hasTitle(row))) keptAt.set(id, i);
  });
  return rows.filter((row, i) => isHeldTermId(row.term_id ?? "") || keptAt.get(row.term_id ?? "") === i);
}

function hasTitle(row: { title?: string | null }): boolean {
  return pythonStrip(row.title ?? "") !== "";
}

/**
 * The run of whitespace between the closing quote at `quote` and `index`, as
 * Papa tolerates it (`extraSpaces`, papaparse.js:1699-1708): a quote separated
 * from the delimiter or the terminator by nothing but spaces still closes its
 * field. `index` of -1 means there is no such position, and nothing is skipped.
 */
function extraSpaces(source: string, quote: number, index: number): number {
  if (index === -1) return 0;
  const between = source.slice(quote + 1, index);
  return between !== "" && between.trim() === "" ? between.length : 0;
}

/** Where a quoted field's scan left off: the next field, or the record's end. */
interface QuotedFieldEnd {
  /** Offset of the next field's first character, when a delimiter closed it. */
  next?: number;
  /** Offset the record's fields end at, when the terminator closed it. */
  recordEnd?: number;
}

/**
 * The end of the quoted field whose opening quote is at `open`.
 *
 * A quote inside closes the field only when the delimiter, the terminator or
 * the end of the text follows it, spaces aside; a doubled quote is one literal
 * quote; a quote followed by anything else is Papa's `InvalidQuotes`, which it
 * reports and then keeps scanning past for a later closing quote. A quote that
 * never closes is `MissingQuotes`, and the field runs to the end of the text —
 * which keeps a scan built on this total: every character belongs to exactly
 * one record.
 */
function quotedFieldEnd(
  source: string,
  open: number,
  delimiter: string,
  newline: string,
): QuotedFieldEnd {
  let quote = open;

  for (;;) {
    quote = source.indexOf('"', quote + 1);
    if (quote === -1 || quote === source.length - 1) return { next: source.length };
    if (source[quote + 1] === '"') {
      quote += 1;
      continue;
    }
    const nextDelim = source.indexOf(delimiter, quote + 1);
    const nextNewline = source.indexOf(newline, quote + 1);
    const checkUpTo = nextNewline === -1 ? nextDelim : Math.min(nextDelim, nextNewline);
    const beforeDelim = extraSpaces(source, quote, checkUpTo);
    if (source[quote + 1 + beforeDelim] === delimiter) {
      return { next: quote + 2 + beforeDelim };
    }
    const beforeNewline = extraSpaces(source, quote, nextNewline);
    if (source.startsWith(newline, quote + 1 + beforeNewline)) {
      return { recordEnd: quote + 1 + beforeNewline };
    }
    quote += 1;
  }
}

/**
 * The offset at which the record starting at `start` ends, terminator
 * excluded. A quote opens a quoted field only at the start of a field, so a
 * bare quote mid-field is an ordinary character.
 *
 * `delimiter` is one character. Papa guesses from a list of single characters
 * (`delimitersToGuess`, papaparse.js:1345) and falls back to `DefaultDelimiter`
 * (:75), so a delimiter reported for a file parsed under a configuration
 * naming none is one character wide.
 */
export function recordFieldsEnd(
  source: string,
  start: number,
  delimiter: string,
  newline: string,
): number {
  let i = start;
  let fieldStart = true;

  while (i < source.length) {
    if (fieldStart && source[i] === '"') {
      const end = quotedFieldEnd(source, i, delimiter, newline);
      if (end.recordEnd !== undefined) return end.recordEnd;
      i = end.next as number;
      continue;
    }
    if (source.startsWith(newline, i)) return i;
    // The BOM sits before the FILE's first field and leaves it unopened. Papa
    // strips it at absolute offset zero and nowhere else (`stripBom`, which
    // tests `charCodeAt(0)` alone, papaparse.js:254-260, applied to the whole
    // input at :238),
    // so the same character opening any later record is field content: it
    // opens the field itself, and the quote behind it is an ordinary character
    // rather than the start of a quoted field. Skipped at every record start,
    // the scan keeps whole a record Papa cuts in two, and the row hiding in the
    // half the scan swallowed is reported absent from a file that has it.
    if (source[i] === BOM && i === 0) {
      i++;
      continue;
    }
    fieldStart = source[i] === delimiter;
    i++;
  }

  return i;
}

/**
 * The records of `text`, each without its own terminator, read on the
 * `delimiter` and `newline` Papa read the same text with.
 *
 * The other two terminators are content and are returned as part of the record
 * they fall in. A blank line is a record of its own, empty. Nothing else is
 * altered: a record comes back exactly as it was written, so a caller may put
 * it straight back into a file.
 */
export function splitCsvRecords(text: string, delimiter: string, newline: string): string[] {
  const records: string[] = [];
  let i = 0;

  while (i < text.length) {
    const fieldsEnd = recordFieldsEnd(text, i, delimiter, newline);
    records.push(text.slice(i, fieldsEnd));
    i = fieldsEnd;
    if (text.startsWith(newline, i)) i += newline.length;
    else if (i < text.length) i++;
  }

  return records;
}

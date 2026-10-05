/**
 * CPython's `csv` module as the framework's 1.8.0 sheet repair calls it: the
 * reader over `io.StringIO(text, newline='')` in the default `excel` dialect,
 * and the writer that turns one header row back into a line.
 *
 * The repair judges a sheet by the cells `csv.reader` gives it, and trusts its
 * own byte-level split of the file only where that split reads back as the
 * same cells, so a prediction of what the repair will do has to read cells as
 * CPython reads them rather than as PapaParse does. The two part on a quote in
 * the middle of an unquoted field (literal to CPython), on text after a
 * closing quote (kept, the field carrying on unquoted), and on a quote left
 * open at the end of the file (the field is saved as it stands). A NUL is an
 * ordinary character, and the reader never raises: `strict` is off, the field
 * limit is lifted around the read, and a lone CR always ends a line before the
 * reader can see a character after it.
 *
 * @version v1.5.0-beta
 */

/**
 * The lines `io.StringIO(text, newline='')` yields: each ends at a CR, an LF
 * or a CRLF, which it keeps, and the last may have no terminator.
 */
function pythonLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (ch === "\r") {
      const end = text[i + 1] === "\n" ? i + 2 : i + 1;
      lines.push(text.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

// The parser states of `_csv.c` the excel dialect can reach: no escape
// character, so neither escape state; no `skipinitialspace`.
const START_RECORD = 0;
const START_FIELD = 1;
const IN_FIELD = 2;
const IN_QUOTED_FIELD = 3;
const QUOTE_IN_QUOTED_FIELD = 4;
const EAT_CRNL = 5;

/** The end of a line, which `_csv.c` feeds the parser after the line's own characters. */
const EOL = null;

/**
 * Every record `csv.reader(io.StringIO(text, newline=''))` yields, as its
 * cells. A blank line is a record of no cells.
 */
export function pythonCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let state = START_RECORD;

  const saveField = () => {
    fields.push(field);
    field = "";
  };

  const process = (c: string | null) => {
    switch (state) {
      case START_RECORD:
        if (c === EOL) return;
        if (c === "\n" || c === "\r") {
          state = EAT_CRNL;
          return;
        }
        state = START_FIELD;
      // falls through: an ordinary character starts the first field
      case START_FIELD:
        if (c === "\n" || c === "\r" || c === EOL) {
          saveField();
          state = c === EOL ? START_RECORD : EAT_CRNL;
        } else if (c === '"') {
          state = IN_QUOTED_FIELD;
        } else if (c === ",") {
          saveField();
        } else {
          field += c;
          state = IN_FIELD;
        }
        return;
      case IN_FIELD:
        if (c === "\n" || c === "\r" || c === EOL) {
          saveField();
          state = c === EOL ? START_RECORD : EAT_CRNL;
        } else if (c === ",") {
          saveField();
          state = START_FIELD;
        } else {
          field += c;
        }
        return;
      case IN_QUOTED_FIELD:
        if (c === EOL) return;
        if (c === '"') state = QUOTE_IN_QUOTED_FIELD;
        else field += c;
        return;
      case QUOTE_IN_QUOTED_FIELD:
        if (c === '"') {
          field += c;
          state = IN_QUOTED_FIELD;
        } else if (c === ",") {
          saveField();
          state = START_FIELD;
        } else if (c === "\n" || c === "\r" || c === EOL) {
          saveField();
          state = c === EOL ? START_RECORD : EAT_CRNL;
        } else {
          field += c;
          state = IN_FIELD;
        }
        return;
      case EAT_CRNL:
        // Only a terminator's second character or the line's end can follow
        // here, because a line ends at its first CR or LF.
        if (c === EOL) state = START_RECORD;
        return;
    }
  };

  const lines = pythonLines(text);
  let next = 0;
  for (;;) {
    // One record: lines are fed until the parser is back at the start of one.
    do {
      if (next === lines.length) {
        // The end of the data inside a record: saved, as `strict=False` does.
        if (field !== "" || state === IN_QUOTED_FIELD) {
          saveField();
          rows.push(fields);
        }
        return rows;
      }
      const line = lines[next];
      next += 1;
      for (const c of line) process(c);
      process(EOL);
    } while (state !== START_RECORD);
    rows.push(fields);
    fields = [];
  }
}

/**
 * The line `csv.writer` writes for `cells`: minimal quoting, a doubled quote
 * inside a quoted cell, a lone empty cell written as `""` so that it is not a
 * blank line, and CRLF after it.
 */
export function pythonCsvLine(cells: readonly string[]): string {
  const quoted = cells.map((cell) => {
    const needs = (cells.length === 1 && cell === "") || /[,"\r\n]/.test(cell);
    return needs ? `"${cell.replaceAll('"', '""')}"` : cell;
  });
  return `${quoted.join(",")}\r\n`;
}

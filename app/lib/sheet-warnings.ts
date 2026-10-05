/**
 * What a read of a Telar sheet reports about the sheet, as data.
 *
 * The parser and the mappers after it (`parseTelarCsv`, `mapObjectsCsv`,
 * `mapGlossaryCsv`, `mapStoryCsv`) raise a `SheetIssue` through their
 * `onWarning` handler: a code and the fields its sentence needs, with no
 * sheet, because none of them knows which sheet it is reading. The caller
 * that does names it (`issuesFor`), and what reaches a screen is a
 * `SheetWarning`, written out in the reader's language by the `SheetWarnings`
 * component from `common:sheet_warnings.*`.
 *
 * Client-safe: the review step, the sync dialogs and the Start page import
 * these types, so nothing here may reach a server module.
 *
 * @version v1.5.0-beta
 */

/**
 * A row as a reader finds it in the spreadsheet: by its first non-empty cell,
 * trimmed, where it has one, and by its 1-based position among the rows after
 * the header otherwise.
 */
export type SheetRow = { label: string } | { position: number };

/** One problem a parse or a mapper found in a sheet it was given no name for. */
export type SheetIssue =
  /** A row with more values than the header has columns; the surplus was dropped. */
  | { code: "ragged_row"; row: SheetRow }
  /** The first data row read as a second, bilingual header row and skipped. */
  | { code: "bilingual_header_row"; row: SheetRow }
  /** A column with no heading whose values were not imported. `column` is 1-based. */
  | { code: "blank_header"; column: number }
  /**
   * Several spellings of one column, only one of them holding values, which
   * was kept. `headers` are every spelling as typed; `column` is the kept
   * one's 1-based position.
   */
  | { code: "column_collision_only_filled"; name: string; headers: string[]; kept: string; column: number }
  /** Several spellings of one column, more than one holding values; the last was kept. */
  | { code: "column_collision_last"; name: string; headers: string[]; column: number }
  /** Columns named for what the framework reserves; publishing is blocked. */
  | { code: "reserved_column"; columns: string[] }
  /**
   * Populated columns whose headings the framework reads as other columns
   * (`Step`, `Object_ID`): `headers` as typed, `names` what a publish writes
   * in their place, in sheet order. `fromGoogleSheets` for a tab the build
   * fetches, which no publish writes.
   */
  | { code: "header_spelling"; headers: string[]; names: string[]; fromGoogleSheets?: true }
  /** Populated columns headed `#`, which the framework drops before reading. */
  | { code: "instruction_column"; columns: string[] }
  /** Groups of columns the framework's reader folds into one field; publishing is blocked. */
  | { code: "folded_columns"; groups: string[][] }
  /** A step's x, y or zoom that is not a number, dropped. `value` is the cell as written. */
  | { code: "coordinate_invalid"; step: number; column: "x" | "y" | "zoom"; value: string }
  /** A step's page below 1, which the framework clears. */
  | { code: "page_below_one"; step: number; value: string }
  /** A step's decimal page, which the framework reads as its integer part. */
  | { code: "page_truncated"; step: number; value: string; readAs: number }
  /**
   * Rows whose ids the site reads as one object (`map` and `map.jpg`), in
   * sheet order, and the row its object page and steps show. Where
   * `sameRowEverywhere` is false, other parts of the site show the first row.
   */
  | { code: "object_site_id_shared"; ids: string[]; shown: string; sameRowEverywhere: boolean }
  /**
   * An object_id written in more than one row. The site's object page and
   * steps use the last row, and every other part of the site does too where
   * `sameRowEverywhere`; otherwise some parts use the first. A publish writes
   * the one row the Compositor holds for it.
   */
  | { code: "object_id_repeated"; id: string; sameRowEverywhere: boolean };

export type SheetIssueCode = SheetIssue["code"];

/** What the site does with a file that holds bytes it cannot read as UTF-8. */
export type UnreadableEffect = "build_stops" | "left_out" | "name_shown" | "from_sheets" | "not_used";

/**
 * What makes the next publish write such a file, or, for an older copy of a
 * story that no publish writes, remove it.
 */
export type UnreadableRepair = "publish" | "title_then_publish" | "import_then_publish" | "remove_old_copy";

/**
 * A warning a screen shows: a sheet's issue with the sheet named, or one of
 * the warnings about a read rather than a parse: a tree GitHub truncated, or
 * a file whose bytes are not valid UTF-8. `file` is a sheet's file name, or
 * any other file's path in the repository.
 */
export type SheetWarning =
  | (SheetIssue & { sheet: string })
  | { code: "tree_truncated" }
  | { code: "unreadable_characters"; file: string; effect: UnreadableEffect; repair: UnreadableRepair };

export type SheetWarningCode = SheetWarning["code"];

/** What a parse or a mapper is handed to report through. */
export type SheetIssueHandler = (issue: SheetIssue) => void;

/** A handler that records each issue against `sheet` into `sink`. */
export function issuesFor(sheet: string, sink: SheetWarning[]): SheetIssueHandler {
  return (issue) => {
    sink.push({ ...issue, sheet });
  };
}

/**
 * The sheet files the publish checks found misread headings in, in check
 * order: the files a publish corrects, which turns Publish on when nothing
 * else has changed.
 */
export function headingFilesOf(checks: { warnings: readonly { sheetWarning?: SheetWarning }[] } | null): string[] {
  const files = (checks?.warnings ?? []).flatMap(({ sheetWarning: w }) => (w?.code === "header_spelling" ? [w.sheet] : []));
  return [...new Set(files)];
}

/** The form field that says the submitted message is the "Correct column headings" headline. */
export const CORRECTS_HEADINGS = "correctsHeadings";

/**
 * The headline a publish commits. One that claims to correct headings keeps
 * it only while the publish, from the files it read, corrects some; otherwise
 * it is the neutral headline.
 */
export function headingsHeadline(
  claimed: boolean,
  corrected: readonly string[],
  fallback: string | null,
  message: string,
): string {
  return claimed && corrected.length === 0 ? fallback || "Publish site" : message;
}

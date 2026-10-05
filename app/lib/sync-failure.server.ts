/**
 * The result a sync action returns when the sync fails, shared by the objects
 * page's sync and the full sync on the dashboard.
 *
 * A sheet refused for its colliding columns comes back as its own error,
 * carrying the sheet and the columns, so the screen can tell the author which
 * columns to remove and where. A file the sync could not read comes back as
 * its own error too, by what the file is (`unreadableFailure`), so the screen
 * can name it and say that nothing changed. Any other failure carries the
 * action's own error code and the thrown message.
 *
 * @version v1.5.0-beta
 */

import { CollidingColumnsRefusal } from "~/lib/import.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";

/** The sheet a sync refused and the columns that each hold values, as typed. */
export interface CollidingColumns {
  sheet: string;
  canonicalName: string;
  headers: string[];
}

/** The ignore list the orphan restore and ignore read, at the repository root. */
const IGNORE_LIST_PATH = ".compositor-ignored";

/** What an action answers for a file it could not read, by what the file is. */
export type UnreadableFile =
  | { error: "sheet_unreadable"; sheet: string }
  | { error: "ignore_list_unreadable" }
  | { error: "file_unreadable"; file: string };

export type SyncFailure<I extends string> =
  | { ok: false; intent: I; error: "colliding_columns"; collidingColumns: CollidingColumns }
  | ({ ok: false; intent: I } & UnreadableFile)
  | { ok: false; intent: I; error: string; message: string };

/**
 * A sheet is named by its file name, as the colliding-columns refusal names
 * one; the ignore list by what it is; any other file by its path in the
 * repository, since only a sheet is a sheet to the author.
 */
export function unreadableFailure(path: string): UnreadableFile {
  if (path === IGNORE_LIST_PATH) return { error: "ignore_list_unreadable" };
  if (path.toLowerCase().endsWith(".csv")) return { error: "sheet_unreadable", sheet: path.slice(path.lastIndexOf("/") + 1) };
  return { error: "file_unreadable", file: path };
}

export function syncFailure<I extends string>(intent: I, err: unknown, error: string): SyncFailure<I> {
  if (err instanceof CollidingColumnsRefusal) {
    return {
      ok: false,
      intent,
      error: "colliding_columns",
      collidingColumns: { sheet: err.sheet, canonicalName: err.canonicalName, headers: err.headers },
    };
  }
  if (err instanceof SheetUnreadableError) return { ok: false, intent, ...unreadableFailure(err.path) };
  return { ok: false, intent, error, message: err instanceof Error ? err.message : "Unknown error" };
}

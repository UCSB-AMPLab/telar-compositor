/**
 * The toast the objects page shows for a failed sync. A sheet the sync
 * refused for its colliding columns names the sheet and the columns and where
 * to remove them, and a sheet it could not read is named; each stays until
 * dismissed so the author can read it; so does an apply the Compositor held
 * back for entries it cannot store, since the fault is the Compositor's. Any
 * other failure gets the general message, never the server's own text.
 *
 * @version v1.5.0-beta
 */

import type { CollidingColumns } from "~/lib/sync-failure.server";

export function syncErrorToast(
  data: { error: string; collidingColumns?: CollidingColumns; sheet?: string },
  t: (key: string, options?: Record<string, unknown>) => string,
): { message: string; type: "destructive"; autoDismissMs?: null } {
  if (data.error === "colliding_columns" && data.collidingColumns) {
    const message = t("sync_error_colliding_columns", {
      sheet: data.collidingColumns.sheet,
      columns: data.collidingColumns.headers.map((h) => `"${h}"`).join(", "),
    });
    return { message, type: "destructive", autoDismissMs: null };
  }
  if (data.error === "sheet_unreadable" && data.sheet) {
    return { message: t("sync_error_sheet_unreadable", { sheet: data.sheet }), type: "destructive", autoDismissMs: null };
  }
  if (data.error === "entries_refused") {
    return { message: t("sync_entries_refused"), type: "destructive", autoDismissMs: null };
  }
  return { message: t("sync_error_toast"), type: "destructive" };
}

/**
 * The values an upgrade notice fills in when its failure names a sheet or a
 * release file.
 *
 * A failure carries only the fields that apply to it, such as a sheet with or
 * without a column, or a path with or without a release version, and each
 * notice's text names exactly those. The values passed on are the fields
 * present and nothing else, so a notice never shows a placeholder for a field
 * the failure did not carry.
 *
 * @version v1.5.3-beta
 */

/** A sheet notice's values: the sheet, and the column or columns when named. */
export function sheetNoticeValues(detail: {
  sheet: string;
  column?: string;
  columns?: string;
}): Record<string, string> {
  const { sheet, column, columns } = detail;
  return { sheet, ...(column !== undefined ? { column } : {}), ...(columns !== undefined ? { columns } : {}) };
}

/** A read failure's values: the path and the release version, each when named. */
export function readNoticeValues(detail: { path?: string; version?: string }): Record<string, string> {
  return {
    ...(detail.path !== undefined ? { path: detail.path } : {}),
    ...(detail.version !== undefined ? { version: detail.version } : {}),
  };
}

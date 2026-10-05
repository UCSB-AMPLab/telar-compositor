/**
 * The publish check that names what a sheet on GitHub is warned about.
 *
 * A GitHub edit can leave a sheet that parses to the values D1 holds and still
 * raises a warning: a row with more cells than columns, a second bilingual
 * header row, a column with no heading. The sync state sees nothing divergent,
 * and the next publish rewrites the sheet from D1, so what sat in the cut-off
 * cells or the unheaded column is gone. This check reads each sheet at the
 * commit the stale-head check compared against, with the parse and mappers the
 * import uses, and lists each warning as it would read at the import, naming
 * the sheet and the row. It changes no sync state.
 *
 * A heading the site misreads (`header_spelling`) is named too, since every
 * publish rewrites it, except in a file whose sheet the build takes from a
 * Google Sheets tab.
 *
 * The warnings the publish already blocks on (`reserved_column`,
 * `folded_columns`) are left to their blockers. A read that fails or finds no
 * file gives nothing, and never fails the checks.
 *
 * @version v1.5.0-beta
 */

import type { FileAtRef } from "~/lib/github.server";
import {
  GLOSSARY_CANONICAL_SCOPE,
  OBJECTS_CANONICAL_SCOPE,
  PROJECT_CANONICAL_SCOPE,
  STORY_CANONICAL_SCOPE,
  mapGlossaryCsv,
  mapObjectsCsv,
  mapProjectCsv,
  mapStoryCsv,
  parseTelarCsv,
} from "~/lib/import.server";
import { issuesFor, type SheetWarning } from "~/lib/sheet-warnings";
import { markSheetsEffects, type SheetsSource } from "~/lib/unreadable-characters.server";
import type { ValidationItem, ValidationResult } from "~/lib/publish.server";
import { SPREADSHEETS_DIR as SHEETS_DIR, siteSheetFileAt, type SiteSheetRole, sheetReadText } from "~/lib/site-sheets.server";

const SPREADSHEETS_DIR = SHEETS_DIR;

/** Warnings a blocker in `runPrePublishValidation` already states. */
const BLOCKED_ELSEWHERE = new Set<string>(["reserved_column", "folded_columns"]);

interface SheetToRead {
  /**
   * The file's name for a story; for a site sheet, the English name, which the
   * file actually read replaces where the site holds the Spanish one.
   */
  file: string;
  /** Set for the three sheets the build reads by name, in either language. */
  role?: SiteSheetRole;
  scope: ReadonlySet<string>;
  /** project.csv is parsed under its own header vocabulary. */
  isProjectCsv?: boolean;
  map: (rows: Record<string, string>[], report: ReturnType<typeof issuesFor>) => void;
}

function sheetsToRead(storyIds: readonly string[]): SheetToRead[] {
  return [
    { file: "project.csv", role: "project", scope: PROJECT_CANONICAL_SCOPE, isProjectCsv: true, map: (rows) => void mapProjectCsv(rows) },
    { file: "objects.csv", role: "objects", scope: OBJECTS_CANONICAL_SCOPE, map: (rows, report) => void mapObjectsCsv(rows, undefined, report) },
    { file: "glossary.csv", role: "glossary", scope: GLOSSARY_CANONICAL_SCOPE, map: (rows, report) => void mapGlossaryCsv(rows, report) },
    ...storyIds.map((id) => ({
      file: `${id}.csv`,
      scope: STORY_CANONICAL_SCOPE,
      map: (rows: Record<string, string>[], report: ReturnType<typeof issuesFor>) => void mapStoryCsv(rows, 0, report),
    })),
  ];
}

/**
 * One non-blocking check per warning in the site's sheets, in sheet order
 * (project, objects, glossary, then each story), or none while the stale-head blocker
 * stands. `read` answers a repository path at the commit the checks compared
 * against, strictly, so a body that is not the whole file reads as an error.
 * Costs one read per sheet, and a second for a site sheet the site keeps
 * under its Spanish name. `sheets` are the Google Sheets settings the build
 * reads (`markSheetsEffects`).
 */
export async function sheetWarningChecksAt(
  validation: ValidationResult,
  storyIds: readonly string[],
  read: (path: string) => Promise<FileAtRef>,
  sheets?: SheetsSource | null,
): Promise<ValidationItem[]> {
  if (validation.blockers.some((b) => b.code === "stale_head")) return [];
  const toRead = sheetsToRead(storyIds);
  const reads = await Promise.all(toRead.map((sheet) => sheetFileText(sheet, read)));
  const found = toRead.flatMap((sheet, i) => {
    const { text, file } = reads[i];
    return text === null ? [] : sheetWarningsOf({ ...sheet, file }, text);
  });
  // A sheet the build takes from a Google Sheets tab: the publish rewrites its
  // file to no effect, so a misread heading there is not named.
  await markSheetsEffects(found, sheets).catch(() => undefined);
  return checkItems(found);
}

/**
 * The file's text without a byte-order mark, or null when absent or
 * unreadable, with the name of the file read: a site sheet is read from the
 * Spanish file where the English one is not there (`siteSheetFileAt`).
 */
async function sheetFileText(
  sheet: SheetToRead,
  read: (path: string) => Promise<FileAtRef>,
): Promise<{ text: string | null; file: string }> {
  const safeRead = async (path: string): Promise<FileAtRef> => {
    try {
      return await read(path);
    } catch {
      return { status: "error" };
    }
  };
  if (sheet.role === undefined) {
    return { text: sheetReadText(`${SPREADSHEETS_DIR}/${sheet.file}`, await safeRead(`${SPREADSHEETS_DIR}/${sheet.file}`), "run-validation"), file: sheet.file };
  }
  const found = await siteSheetFileAt(sheet.role, safeRead);
  return { text: sheetReadText(found.path, found.file, "run-validation"), file: found.name };
}


/** What the import would warn about one sheet, less what a blocker states. */
function sheetWarningsOf(sheet: SheetToRead, text: string): SheetWarning[] {
  const found: SheetWarning[] = [];
  const report = issuesFor(sheet.file, found);
  try {
    sheet.map(parseTelarCsv(text, report, sheet.isProjectCsv ?? false, sheet.scope, { severalHoldValues: "keep-last", sheetName: sheet.file }), report);
  } catch {
    // What the read raised before it threw stays in `found`.
  }
  return found.filter((w) => !BLOCKED_ELSEWHERE.has(w.code));
}

/** Each warning as a check, numbered within its sheet. */
function checkItems(warnings: readonly SheetWarning[]): ValidationItem[] {
  const counts = new Map<string, number>();
  return warnings.map((sheetWarning) => {
    const sheet = "sheet" in sheetWarning ? sheetWarning.sheet : "";
    const i = counts.get(sheet) ?? 0;
    counts.set(sheet, i + 1);
    return { code: "sheet_warning", message: "sheet_warning", entityId: `${sheet}/${i}`, sheetWarning };
  });
}

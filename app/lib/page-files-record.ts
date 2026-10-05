/**
 * The record of the page files the Compositor answers for
 * (`projects.page_files_json`, migration 0064): its type, and its text as
 * stored.
 *
 * Null means no record. Otherwise `{ "commit": "<sha>", "files": { "<name>":
 * <page id> | null } }`: each `.md` file directly in the pages folder that the
 * Compositor answers for, by its name relative to the folder, mapped to the
 * page written to or read from it, or to null for a file no page holds that
 * the next publish deletes. `commit` is the commit the files were read or
 * written at.
 *
 * Only names with no `/` that end in `.md` are recorded: the framework builds
 * pages from `*.md` directly in the folder and nothing below it. A stored
 * value that is not a record of that shape reads as no record.
 *
 * What each writer records, and the publish's deletions from it, are in
 * `page-files-record.server.ts`.
 *
 * @version v1.5.0-beta
 */

/** The page files the Compositor answers for at a commit. */
export interface PageFilesRecord {
  commit: string;
  files: Record<string, number | null>;
}

/** Whether `name` is one the record holds: a `.md` file directly in the pages folder. */
export function isRecordedPageFileName(name: string): boolean {
  return name.length > ".md".length && name.endsWith(".md") && !name.includes("/");
}

/** Whether an entry's value is one the record holds: a positive page id, or none. */
function isRecordedPageId(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

/** Whether `value` is a JSON object, not an array. */
function isRecordJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The files of a parsed value, or null when any entry is not one the record holds. */
function recordedFiles(value: unknown): Record<string, number | null> | null {
  if (!isRecordJsonObject(value)) return null;
  const files: Record<string, number | null> = {};
  for (const [name, id] of Object.entries(value)) {
    if (!isRecordedPageFileName(name) || !isRecordedPageId(id)) return null;
    files[name] = id;
  }
  return files;
}

/** The stored text parsed as JSON, or undefined when it is not JSON. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The stored text as a record, or null for none and for anything that is not one. */
export function parsePageFilesRecord(text: string | null | undefined): PageFilesRecord | null {
  if (!text) return null;
  const value = parsedJson(text);
  if (!isRecordJsonObject(value)) return null;
  const { commit, files } = value;
  if (typeof commit !== "string" || commit === "") return null;
  const parsed = recordedFiles(files);
  return parsed === null ? null : { commit, files: parsed };
}

/** The record as stored, its files in name order so one record has one text. */
export function serialisePageFilesRecord(record: PageFilesRecord): string {
  const names = Object.keys(record.files).filter(isRecordedPageFileName).sort();
  const files: Record<string, number | null> = {};
  for (const name of names) files[name] = record.files[name];
  return JSON.stringify({ commit: record.commit, files });
}

/**
 * `entries` merged into `previous`: its `commit` is kept, and with no record
 * they start one at `scanCommit`, the commit they were read at. An entry with
 * no page does not replace one the record holds.
 */
export function mergedPageFilesRecord(
  previous: PageFilesRecord | null,
  scanCommit: string,
  entries: Record<string, number | null>,
): PageFilesRecord {
  const files: Record<string, number | null> = { ...(previous?.files ?? {}) };
  for (const [name, id] of Object.entries(entries)) {
    if (isRecordedPageFileName(name) && (id !== null || !Object.hasOwn(files, name))) files[name] = id;
  }
  return { commit: previous?.commit ?? scanCommit, files };
}

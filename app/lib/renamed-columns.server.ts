/**
 * The publish check that names a repeated column the publish will rename.
 *
 * The import names every column by its position. A header whose text repeats
 * keeps the first position under its name and gives each later one `name_N`
 * (`renamedColumns`), and every serializer writes that name back as header
 * text: objects.csv, glossary.csv and a story CSV write each kept column in
 * the file's own place under the name the import gives it
 * (sheet-csv-layout.server.ts). So the published file says `notes_1`
 * where the author's sheet said `notes`, and the author is told before the
 * publish rather than after.
 *
 * A column is named only when the publish will write it: the keys each file
 * carries are taken from the serializer's own functions over D1, so a renamed
 * column holding no values, or holding them only on a step the story CSV
 * leaves out, is not named. D1 keeps no copy of any sheet, so each file whose
 * written keys could hold a renamed name is read at the commit the stale-head
 * check compared against.
 *
 * A file is judged by both readings of its header (`HeaderTextReading`): D1
 * can hold a key stored under the stripped reading, which named the second of
 * `title` and ` title ` `title_1`, and a publish writes that key back although
 * the import reads the two as colliding and names no column `title_1`.
 * Each written key is named once, under one reading (`writtenRenamedColumns`).
 *
 * The warning is advisory. A read that fails, that cannot be shown to be the
 * whole file, or that finds no file gives no warning and never fails the
 * checks: a check that cannot see the file has nothing to say about it.
 *
 * @version v1.5.0-beta
 */

import { objectsExtraColumnKeys } from "~/lib/csv-export.server";
import { readCsvSourceRows } from "~/lib/csv-record-scan.server";
import { parseExtraColumns } from "~/lib/extra-columns.server";
import type { FileAtRef } from "~/lib/github.server";
import {
  GLOSSARY_CANONICAL_SCOPE,
  OBJECTS_CANONICAL_SCOPE,
  STORY_CANONICAL_SCOPE,
  renamedColumns,
  type HeaderTextReading,
  type RenamedColumn,
} from "~/lib/import.server";
import { glossaryExtraColumnKeys, storyExtraColumnKeys, writtenStepsFor } from "~/lib/publish.server";
import { SPREADSHEETS_DIR, siteSheetFileAt, type SiteSheetRole, sheetReadText } from "~/lib/site-sheets.server";
import type {
  GlossaryTermForValidation,
  ObjectForValidation,
  StepForValidation,
  StepLayerForValidation,
  StoryForValidation,
  ValidationItem,
  ValidationResult,
} from "~/lib/publish.server";

/**
 * Every name the import assigns a repeated header ends in `_<digits>`
 * (`nextUniqueName`, import.server.ts), so a file whose written keys carry no
 * such name cannot have a renamed column in it and is not read. The gate is
 * necessary rather than sufficient: an author's own `notes_1` passes it and
 * costs a read that finds nothing renamed.
 */
const ASSIGNED_SUFFIX = /_\d+$/;

/** A sheet a publish writes kept columns into, and the keys it writes. */
interface WrittenSheet {
  /** The file's name as the warning gives it. */
  file: string;
  path: string;
  /** Set for a sheet the build reads by name, in either language: `file` and `path` are then the English ones. */
  role?: SiteSheetRole;
  /** The scope the import parses this sheet under. */
  scope: ReadonlySet<string>;
  keys: ReadonlySet<string>;
}

/** What decides which kept columns each sheet carries. */
export interface RenamedColumnSources {
  objects: ObjectForValidation[];
  glossary: GlossaryTermForValidation[];
  stories: StoryForValidation[];
  steps: StepForValidation[];
  /**
   * Every layer of the site's steps, in one query. Called at most once, and
   * only when a story's steps carry a suffixed key, so a site without one pays
   * nothing for it. The caller shares it with the story column blockers
   * (`stepLayersForValidation`), so it answers both from one read.
   */
  loadLayers: () => Promise<StepLayerForValidation[]>;
}

/**
 * The renamed-column warnings for a publish, or none while the stale-head
 * blocker stands: the tree the checks would read is not the one the publish
 * will land on once the author has synced.
 *
 * `read` answers a repository path at the commit the checks compared against,
 * strictly, so a body that is not the whole file reads as an error.
 */
export async function renamedColumnWarningsAt(
  validation: ValidationResult,
  sources: RenamedColumnSources,
  read: (path: string) => Promise<FileAtRef>,
): Promise<ValidationItem[]> {
  if (validation.blockers.some((b) => b.code === "stale_head")) return [];
  const sheets = (await writtenSheets(sources)).filter(hasAssignedSuffix);
  if (sheets.length === 0) return [];
  const reads = await Promise.all(sheets.map((sheet) => sheetText(sheet, read)));
  return sheets.flatMap((sheet, i) => {
    const { text, file } = reads[i];
    return text === null ? [] : sheetWarnings({ ...sheet, file }, text);
  });
}

/** Whether any key a sheet writes has a name the import may have assigned. */
function hasAssignedSuffix(sheet: WrittenSheet): boolean {
  return [...sheet.keys].some((key) => ASSIGNED_SUFFIX.test(key));
}

/**
 * The sheets carrying kept columns, in the order the warnings are given:
 * objects.csv, glossary.csv, then each story's CSV in story order. Each set of
 * keys is the one its serializer writes.
 */
async function writtenSheets(sources: RenamedColumnSources): Promise<WrittenSheet[]> {
  const sheets: WrittenSheet[] = [
    {
      file: "objects.csv",
      path: `${SPREADSHEETS_DIR}/objects.csv`,
      role: "objects",
      scope: OBJECTS_CANONICAL_SCOPE,
      keys: new Set(objectsExtraColumnKeys(sources.objects.map((o) => parseExtraColumns(o.extra_columns)))),
    },
    {
      file: "glossary.csv",
      path: `${SPREADSHEETS_DIR}/glossary.csv`,
      role: "glossary",
      scope: GLOSSARY_CANONICAL_SCOPE,
      keys: new Set(glossaryExtraColumnKeys(sources.glossary.map((t) => parseExtraColumns(t.extra_columns)))),
    },
  ];
  return [...sheets, ...(await writtenStorySheets(sources))];
}

/**
 * Each story CSV whose written keys could hold an assigned name, with the keys
 * `serializeStory` writes: those of its `publishedSteps`.
 *
 * The keys of all a story's steps are a superset of the keys its published
 * steps write, so a story whose steps carry no suffixed key at all is left out
 * before any layer is read. Only the stories left need their steps judged, and
 * a step's layers are part of that judgement.
 */
async function writtenStorySheets(sources: RenamedColumnSources): Promise<WrittenSheet[]> {
  const candidates = sources.stories
    .map((story) => ({ story, steps: sources.steps.filter((step) => step.story_id === story.story_id) }))
    .filter(({ story, steps }) => hasAssignedSuffix(writtenStorySheet(story, steps)));
  if (candidates.length === 0) return [];
  const layers = await layersOrNull(sources);
  if (layers === null) return [];
  return candidates.map(({ story, steps }) => writtenStorySheet(story, writtenStepsFor(steps, layers)));
}

/**
 * The site's step layers, or null when they cannot be read. The warning is a
 * suggestion, so a failed read costs the stories their warnings and leaves the
 * rest of the validation standing.
 */
async function layersOrNull(sources: RenamedColumnSources): Promise<StepLayerForValidation[] | null> {
  try {
    return await sources.loadLayers();
  } catch {
    console.warn("run-validation: could not read the step layers");
    return null;
  }
}

/** A story's CSV with the kept keys of `steps`, taken in step order. */
function writtenStorySheet(story: StoryForValidation, steps: StepForValidation[]): WrittenSheet {
  const ordered = [...steps].sort((a, b) => a.step_number - b.step_number);
  return {
    file: `${story.story_id}.csv`,
    path: `${SPREADSHEETS_DIR}/${story.story_id}.csv`,
    scope: STORY_CANONICAL_SCOPE,
    keys: new Set(storyExtraColumnKeys(ordered.map((step) => parseExtraColumns(step.extra_columns)))),
  };
}

/**
 * The file's text with a leading byte-order mark removed, as the import reads
 * it, or null for a file that is absent or could not be read whole, with the
 * name of the file read: a site sheet is read from the Spanish file where the
 * English one is not there (`siteSheetFileAt`).
 */
async function sheetText(
  sheet: WrittenSheet,
  read: (path: string) => Promise<FileAtRef>,
): Promise<{ text: string | null; file: string }> {
  const safeRead = async (path: string): Promise<FileAtRef> => {
    try {
      return await read(path);
    } catch {
      return { status: "error" };
    }
  };
  if (sheet.role === undefined) return { text: sheetReadText(sheet.path, await safeRead(sheet.path), "run-validation"), file: sheet.file };
  const found = await siteSheetFileAt(sheet.role, safeRead);
  return { text: sheetReadText(found.path, found.file, "run-validation"), file: found.name };
}


/**
 * One warning per repeated header the publish renames and writes, in the
 * order the header first appears. A header record the parse refuses gives
 * none, as the objects serializer's own column ordering treats it.
 */
function sheetWarnings(sheet: WrittenSheet, text: string): ValidationItem[] {
  const reading = readCsvSourceRows(text);
  if (!reading || reading.rows.length === 0 || reading.rows[0].rejected) return [];
  const byHeader = new Map<string, RenamedColumn[]>();
  for (const column of writtenRenamedColumns(reading.rows.map((row) => row.cells), sheet)) {
    byHeader.set(column.header, [...(byHeader.get(column.header) ?? []), column]);
  }
  return [...byHeader.values()].map((columns) => renamedWarning(sheet.file, columns));
}

/** One reading of a file's header: every column it renames, and those the publish writes. */
interface HeaderReadingResult {
  renamed: RenamedColumn[];
  written: RenamedColumn[];
}

function readHeaderAs(table: string[][], sheet: WrittenSheet, reading: HeaderTextReading): HeaderReadingResult {
  const renamed = renamedColumns(table, sheet.scope, reading);
  return { renamed, written: renamed.filter((column) => sheet.keys.has(column.renamed)) };
}

/**
 * Each written suffixed key of `table`, once, with the header and count of the
 * one reading it is attributed to. A key only one reading assigns belongs to
 * that reading. A key both assign, possibly to different headers, belongs to
 * the reading that accounts for more of the written keys, since D1's keys came
 * from one import and that import read the whole header one way (see
 * `prefersStrippedReading` for a tie).
 */
function writtenRenamedColumns(table: string[][], sheet: WrittenSheet): RenamedColumn[] {
  const asWritten = readHeaderAs(table, sheet, "as-written");
  const stripped = readHeaderAs(table, sheet, "stripped");
  const names = new Set([...asWritten.written, ...stripped.written].map((column) => column.renamed));
  return [...names].map((name) => attributedColumn(name, asWritten, stripped));
}

function attributedColumn(
  name: string,
  asWritten: HeaderReadingResult,
  stripped: HeaderReadingResult,
): RenamedColumn {
  const current = asWritten.written.find((column) => column.renamed === name);
  const former = stripped.written.find((column) => column.renamed === name);
  if (former === undefined) return current as RenamedColumn;
  if (current === undefined) return former;
  return prefersStrippedReading(current, asWritten, stripped) ? former : current;
}

/**
 * Whether a key both readings assign is named under the stripped one. The
 * reading accounting for more written keys wins. On a tie the import's own
 * reading keeps the key only if D1 writes every name that reading gives the
 * key's header; a header group it leaves partly unwritten was not stored by
 * that reading.
 */
function prefersStrippedReading(
  current: RenamedColumn,
  asWritten: HeaderReadingResult,
  stripped: HeaderReadingResult,
): boolean {
  if (stripped.written.length !== asWritten.written.length) {
    return stripped.written.length > asWritten.written.length;
  }
  return asWritten.renamed.some(
    (column) => column.header === current.header && !asWritten.written.includes(column),
  );
}

/**
 * The warning for one repeated header. Two columns sharing it read as "the
 * second"; three or more are counted and every written new name is listed.
 * The count is `total` rather than `count`, which i18next would take for a
 * plural and resolve against keys that do not exist.
 */
function renamedWarning(file: string, columns: RenamedColumn[]): ValidationItem {
  const { header, total } = columns[0];
  const entityId = `${file}/${header}`;
  if (total === 2) {
    return {
      code: "renamed_duplicate_column",
      message: "renamed_duplicate_column",
      entityId,
      params: { file, column: header, renamed: columns[0].renamed },
    };
  }
  return {
    code: "renamed_duplicate_columns",
    message: "renamed_duplicate_columns",
    entityId,
    params: { file, column: header, total, renamed: columns.map((c) => `"${c.renamed}"`).join(", ") },
  };
}

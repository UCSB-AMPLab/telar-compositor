/**
 * This file powers the Sync flow — the page where a project owner
 * reconciles whatever lives in D1 with whatever currently sits in the
 * GitHub repo's CSV files (`objects.csv`, story CSVs, `_config.yml`).
 *
 * Sync answers two questions side by side. What's in the repo but not
 * in D1, and what's in D1 but not in the repo? Same question for
 * fields: where the two sides disagree, the user picks per-field which
 * side wins. That is the three-way diff this module computes — repo,
 * D1, and the user's choices on top.
 *
 * `computeSyncDiff` and `applySyncChanges` cover objects only — the
 * original scope. `computeFullSyncDiff` and `applyFullSyncChanges`
 * extend the same model across stories and config, returning a richer
 * payload but routing per-field choices through the same apply path.
 * Both diff functions also flag images sitting in the repo's
 * `objects/` directory that no CSV row references — the user can
 * register them in one click rather than chasing dangling files
 * manually.
 *
 * Diff results include story-usage hints. When an object is missing
 * from the repo but still referenced by a step, the `missingObjects`
 * entry carries the list of stories and step numbers that point at
 * it, so the user can see what would break if they accept the
 * deletion.
 *
 * Everything here is pure in the sense that callers supply the
 * database handle and GitHub token — the module never reaches for
 * environment, headers, or session state on its own. The route
 * actions (currently in `_app.dashboard.tsx`) do the I/O
 * orchestration; this module does the comparison.
 *
 * @version v1.5.0-beta
 */

import { eq, and } from "drizzle-orm";
import { objects, steps, stories, project_config, project_pages, glossary_terms, layers } from "~/db/schema";
import { getFileAtRef, getRepoTree, getRepoHead, commitExists } from "~/lib/github.server";
import type { TreeEntry } from "~/lib/github.server";
import { holdOperationLease } from "~/lib/operation-lease.server";
import { toIngestInserts } from "~/lib/register-objects.server";
import {
  parseTelarCsv, mapObjectsCsv, mapProjectCsv, mapStoryCsv, readOncePerName, resolveLayerFileReferences,
  KNOWN_GLOSSARY_KEYS, checkGlossaryColumns,
  // Each sheet is parsed under its own scope, the same one import uses: a
  // file read two different ways diffs against itself, and accepting such a
  // diff reverses whatever the import decided.
  OBJECTS_CANONICAL_SCOPE, PROJECT_CANONICAL_SCOPE, STORY_CANONICAL_SCOPE, GLOSSARY_CANONICAL_SCOPE,
  isSafeSiteBase, misreadHeadingsIn, csvSheetForScope,
} from "~/lib/import.server";
import { isTiledImage } from "~/lib/tile-readiness";
import { compareVersions } from "~/lib/telar-version";
import {
  canonicalExtraColumns,
  collectExtraColumns,
  comparableExtraColumns,
  extrasOnWire,
} from "~/lib/extra-columns.server";
import { normalizeVersionTag } from "~/lib/version";
import {
  configFrameworkVersion,
  configSiteBase,
  repeatedIdIssues,
  sharedSiteIdIssues,
  siteObjectId,
  stepObjectResolver,
  tileableStem,
  tileableStems,
  tiledFromFiles,
} from "~/lib/object-id";
import {
  compareSheetOrder,
  githubSheet,
  inSheetOrder,
  objectOrderChange,
  onD1Spelling,
  type ObjectOrderChange,
} from "~/lib/objects.server";
import {
  hasPaddedId,
  legacyPairingRef,
  legacyRespellings,
  markLegacyIdsRepaired,
  respellingUpdate,
  sendRespellings,
  type LegacyRespelling,
} from "~/lib/legacy-object-ids.server";
import type { SheetEntry } from "~/lib/field-order";
import {
  siteVersionAtRef,
  siteVersionFrom,
  type SiteVersionSource,
} from "~/lib/site-version.server";
import {
  findInYamlBlock,
  parseYamlScalar,
  topLevelKeyRemainder,
} from "~/lib/config-yaml-block.server";
import { pythonStrip } from "~/lib/python-whitespace";
import { isHeldTermId, publishedRowPerTermId } from "~/lib/csv-records";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import type { getDb } from "~/lib/db.server";
import { checkStoryContent, readStoriesForAccept, storyTreesInconclusive } from "~/lib/story-content.server";
import type { StoryContentCheck } from "~/lib/story-content.server";
import { readPagesForAccept } from "~/lib/page-content.server";
import {
  acceptedPageFilesRecord, checkPageFiles, loadPageCheckScope, pageFileArms, pageFileTakes, pagesBaseOf, reviewedAdditionNames, withReducedHeldPages,
} from "~/lib/page-files-check.server";
import type { PageFileTake } from "~/lib/page-files-check.server";
import type { PageFilesRecord } from "~/lib/page-files-record";
import type { PageContentCheck } from "~/lib/page-content.server";
import type { StoryLayerRow, StoryStepRow } from "~/lib/publish.server";
import type { IngestObjectInsert, IngestPageInsert } from "../../workers/collaboration";
import type { IngestPageReplaceContent } from "../../workers/page-replace-content";
import type { IngestPageRemove } from "../../workers/page-remove-rename";
import { issuesFor } from "~/lib/sheet-warnings";
import { ownValue } from "~/components/features/dashboard/sync-changes";
import type { SheetWarning } from "~/lib/sheet-warnings";
import {
  appendWarnings, configSheets, headHasGlossaryCsv, listTabsOnce, markSheetsEffects, pushUnreadable, unreadableFileName, unreadableNames,
  withoutSheetsSupplied,
} from "~/lib/unreadable-characters.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { recordStorySheetReads, storySheetPath } from "~/lib/story-source-path.server";
import { recordStoryFileReads, storyFileRead, type OwedStoryFile } from "~/lib/story-files-to-delete.server";
import { canonicalKindsJson, repoGlossaryKindsJson } from "~/lib/glossary-kinds-yaml.server";
import { readSiteSheet, siteSheetFileAt } from "~/lib/site-sheets.server";

// ---------------------------------------------------------------------------
// Reading the repo's sheets
// ---------------------------------------------------------------------------

/** One sheet as a sync reads it: its file name, and the parse's settings. */
interface SyncSheet {
  fileName: string;
  isProjectCsv: boolean;
  scope: ReadonlySet<string>;
}

/** The factories name the file the read selected (`readSiteSheet`), the English one by default. */
function objectsSheet(fileName = "objects.csv"): SyncSheet {
  return { fileName, isProjectCsv: false, scope: OBJECTS_CANONICAL_SCOPE };
}

function projectSheet(fileName = "project.csv"): SyncSheet {
  return { fileName, isProjectCsv: true, scope: PROJECT_CANONICAL_SCOPE };
}

function glossarySheet(fileName = "glossary.csv"): SyncSheet {
  return { fileName, isProjectCsv: false, scope: GLOSSARY_CANONICAL_SCOPE };
}

/**
 * Whether the headings the site misreads in a sheet (`misreadHeadingsIn`)
 * differ between the base and the head, as header-to-name pairs. A base that
 * is absent reads as none.
 */
function headingsMoved(base: string | null | undefined, head: string | null, sheet: SyncSheet): boolean {
  const pairs = (text: string | null | undefined): string => {
    const layout = csvSheetForScope(sheet.scope);
    const rewrites = text && layout ? misreadHeadingsIn(text, layout) : [];
    return rewrites.map((r) => `${r.header}\u0000${r.name}`).sort().join("\u0001");
  };
  return pairs(base) !== pairs(head);
}

/** The sheet's file name in a one-element list when its misread headings moved, else an empty list. */
function headingFilesMoved(
  base: string | null | undefined, head: string | null, sheet: SyncSheet, fileName: string,
): string[] {
  return headingsMoved(base, head, sheet) ? [fileName] : [];
}

/** The `headingFile` field of a glossary diff: present only when the glossary sheet's misread headings moved. */
function glossaryHeadingField(
  base: string | null | undefined, head: string | null, fileName: string,
): { headingFile?: string } {
  return headingsMoved(base, head, glossarySheet(fileName)) ? { headingFile: fileName } : {};
}

/** The objects, project and glossary sheets whose misread headings moved, in that order. */
function movedHeadingFiles(objectsDiff: SyncDiff, glossaryDiff: GlossarySyncDiff, projectFiles: string[]): string[] {
  return [
    ...(objectsDiff.headingFiles ?? []),
    ...projectFiles,
    ...(glossaryDiff.headingFile ? [glossaryDiff.headingFile] : []),
  ];
}

/** The name of the file at `path`. */
function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function storySheet(storyId: string): SyncSheet {
  return { fileName: `${storyId}.csv`, isProjectCsv: false, scope: STORY_CANONICAL_SCOPE };
}

/**
 * Reads the sheet as it stands in the repo, which is what a sync takes in. A
 * sheet in which two or more columns claim one canonical name and each holds
 * values throws `CollidingColumnsRefusal`, naming the sheet and the columns:
 * the framework refuses to build it, and keeping one column would drop the
 * others' values without telling the author. Every read of the repo's current
 * sheets goes through here, and each happens before the sync writes anything.
 * An absent file reads as no rows.
 */
/**
 * A file's text at the pinned HEAD commit, or null where the file is absent
 * (a 404). Any other failure throws `SheetUnreadableError`: read as absent,
 * a failed read offers everything the file holds as removed. The leading
 * byte-order mark is dropped, as `getFileContent`'s decoding drops it. Read in
 * strict mode so HEAD's reads are the one kind the base's (non-strict,
 * `computeFullSyncDiff`) are not.
 *
 * A file whose bytes are not valid UTF-8 reads as the text a non-fatal decode
 * gives, and is named in `unreadable` when a list is given.
 */
async function contentAtRef(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  unreadable?: SheetWarning[],
  onRaw?: (raw: string) => void,
): Promise<string | null> {
  const read = await getFileAtRef(token, owner, repo, path, ref, { strict: true });
  if (read.status === "error") throw new SheetUnreadableError(path);
  if (read.status === "absent") return null;
  if (read.lossy) pushUnreadable(unreadable, path);
  onRaw?.(read.content);
  return read.content.replace(/^\uFEFF/, "");
}

/**
 * `warnings` receives what the parse found in the sheet, named by its file,
 * or is null for a read whose findings the author is not shown: an apply's
 * re-read, which the check before it already reported.
 */
function readRepoSheet(
  csv: string | null,
  sheet: SyncSheet,
  warnings: SheetWarning[] | null,
): Record<string, string>[] {
  if (!csv) return [];
  const onWarning = warnings ? issuesFor(sheet.fileName, warnings) : undefined;
  return parseTelarCsv(csv, onWarning, sheet.isProjectCsv, sheet.scope, {
    severalHoldValues: "refuse",
    sheetName: sheet.fileName,
  });
}

/**
 * A sheet read at the base: its rows, and the canonical names for which the
 * parse chose the last of several colliding columns that held values, as it
 * reports each such choice (`column_collision_last`). For those names the
 * base does not say which column the Compositor holds, so it cannot tell
 * which side changed a value they feed. `earlierClaimants[k]` is the sheet
 * read again with the (k+1)th claimant of each colliding name keeping it, so a
 * value held only in a column before the last can still be read.
 */
interface BaseSheet {
  rows: Record<string, string>[];
  collided: ReadonlySet<string>;
  earlierClaimants: Record<string, string>[][];
}

/**
 * Reads the sheet at the base, the revision last synced, which a three-way
 * diff uses only to tell which side moved a value. It keeps the last of
 * several colliding columns that hold values rather than refusing: the base
 * does not change until a sync succeeds, so a refusal here would stop the very
 * sync that brings the author's fix. An absent file reads as no rows.
 */
function readBaseSheet(csv: string | null, sheet: SyncSheet): BaseSheet {
  const collided = new Set<string>();
  if (!csv) return { rows: [], collided, earlierClaimants: [] };
  let claimants = 0;
  const parseKeeping = (keepClaimant?: number) =>
    parseTelarCsv(
      csv,
      (issue) => {
        if (issue.code !== "column_collision_last" || keepClaimant !== undefined) return;
        collided.add(issue.name);
        claimants = Math.max(claimants, issue.headers.length);
      },
      sheet.isProjectCsv,
      sheet.scope,
      { severalHoldValues: "keep-last", keepClaimant },
    );
  const rows = parseKeeping();
  const earlierClaimants = Array.from({ length: Math.max(claimants - 1, 0) }, (_, k) => parseKeeping(k));
  return { rows, collided, earlierClaimants };
}

/**
 * Whether a collision on the sheet's id column (`key`) leaves the base's rows
 * matched to nothing reliable. The diff then cannot tell which side changed
 * anything in the sheet, so every item that differs is a conflict with the
 * author's version the default and nothing is removed by default. An item
 * only the repository holds is offered as new and inserted by default, as it
 * is with no base: offering it as deleted here would have the next publish
 * delete it from the repository.
 */
function baseRowsUnknown(base: BaseSheet | null, key: string): boolean {
  return base !== null && base.collided.has(key);
}

/**
 * The diff fields the `collided` columns feed: for each, a row holding a value
 * in that column alone is read against the same row without it, and a field
 * whose reading differs takes its value from the column. `key` is the sheet's
 * id column, which both rows hold; a collision on it feeds no field.
 *
 * The probe finds the fields a column feeds on its own reading, with "true" as
 * its value: a non-empty string in a text field, a truthy one in `featured`,
 * `private` and `show_sections`, an entry in the custom-column blob. It does
 * not try every combination of columns, and a field it misses is compared as
 * though the base could place it, which leaves an author's edit there
 * suppressed or a conflict with the author's version the default, never
 * GitHub's. The answer is per sheet, not per cell: a collision on one custom
 * column flags the whole `extra_columns` blob, and a field that falls back to
 * another column (`source_url` to `iiif_manifest`) is flagged whatever its own
 * cell held.
 */
function fieldsFedBy<F extends string>(
  collided: ReadonlySet<string>,
  key: string,
  fields: readonly F[],
  read: (row: Record<string, string>) => (field: F) => string,
): Set<F> {
  const fed = new Set<F>();
  for (const name of collided) {
    if (name === key) continue;
    const without = read({ [key]: "probe" });
    const withValue = read({ [key]: "probe", [name]: "true" });
    for (const field of fields) if (withValue(field) !== without(field)) fed.add(field);
  }
  return fed;
}

/**
 * Whether an object or glossary field the base cannot place lets GitHub's
 * value be the default: every field but the custom-column blob, which the
 * accept writes whole, so GitHub's would replace the author's other custom
 * columns. The exception is defensive: a custom header repeated in a sheet is
 * kept as a column of its own, never read as a collision, so no parse puts the
 * blob among the fields a collision feeds today.
 */
export function repoDefaultsFor(field: SyncField | GlossarySyncField): boolean {
  return field !== "extra_columns";
}

/** The object sync fields the `collided` columns of objects.csv feed. */
export function objectFieldsFedBy(collided: ReadonlySet<string>): Set<SyncField> {
  return fieldsFedBy(collided, "object_id", SYNC_FIELDS, (row) => {
    const [mapped] = mapObjectsCsv([row]);
    const rawAlt = new Map([[row.object_id, row.alt_text ?? ""]]);
    return (field) => objectCsvFieldStr(field, mapped, rawAlt, row.object_id);
  });
}

/** The story row fields the `collided` columns of project.csv feed. */
export function storyFieldsFedBy(collided: ReadonlySet<string>): Set<keyof StorySyncItem> {
  return fieldsFedBy(collided, "story_id", STORY_SYNC_FIELDS, (row) => {
    const item = toStoryItem(mapProjectCsv([row])[0]);
    return (field) => storyFieldStr(item, field);
  });
}

/** The glossary fields the `collided` columns of glossary.csv feed. */
export function termFieldsFedBy(collided: ReadonlySet<string>): Set<GlossarySyncField> {
  return fieldsFedBy(collided, "term_id", GLOSSARY_SYNC_FIELDS, (row) => {
    const term = termRowOf(row);
    return (field) => termFieldStr(term, field);
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Fields compared during diff.
 *
 * Every field here is one that serializeObjectsCsv writes to objects.csv and
 * mapObjectsCsv reads back — so a repo-side edit to any of them is a real,
 * round-trippable change the user may want to reconcile. This set must stay in
 * step with the object entity-hash inputs in publish.server.ts
 * (buildEntityHashes): a field the hash tracks but sync ignores is a field
 * publish will silently clobber on the next commit because sync can neither
 * surface nor apply the repo's version. `alt_text`, `source_url`, `thumbnail`,
 * and `extra_columns` are here for exactly that reason — the hash already
 * covered them.
 *
 * `source_url` and `thumbnail` are published metadata, not compositor-internal
 * image state: the repo-empty guard in the changed-field rule below still
 * prevents an empty repo cell from wiping an IIIF-enriched D1 value, so
 * including them reconciles genuine repo edits without the historical
 * "IIIF-wipe on sync" risk. The truly internal `image_available` (probe-derived,
 * never published) stays out. The guard holds at the apply seam too: both apply
 * paths (applySyncChanges, resolveFullSyncPayload) default an unlisted field to
 * "d1" — leave D1 alone — so a field the diff never surfaced (guard-suppressed
 * enrichment, or an editor-only edit) is never written through with a repo cell.
 */
export const SYNC_FIELDS = [
  "title",
  "creator",
  "description",
  "period",
  "year",
  "object_type",
  "dimensions",
  "subjects",
  "source",
  "credit",
  "featured",
  "alt_text",
  "source_url",
  "thumbnail",
  "extra_columns",
] as const;

export type SyncField = typeof SYNC_FIELDS[number];

export interface StoryRef {
  storyTitle: string | null;
  stepNumber: number;
}

export interface NewObject {
  object_id: string;
  title: string | null;
  creator: string | null;
  description: string | null;
  period: string | null;
  year: string | null;
  object_type: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  featured: boolean;
  source_url: string | null;
  dimensions: string | null;
  image_available: boolean;
  /**
   * Three-way only. True when this row is present in the repo and in the base
   * but absent from D1 with a repo row that DIFFERS from the base — i.e. the
   * editor deleted it while GitHub edited it. The modal surfaces it as a
   * deleted-here/edited-there conflict (restore vs keep-deleted, default
   * keep-deleted). A pure editor deletion (repo row identical to base) is
   * suppressed instead of appearing here, so `newObjects` never resurrects it.
   */
  deletedInCompositor?: boolean;
}

export interface ChangedObject {
  object_id: string;
  dbId: number;
  title: string | null;
  changedFields: SyncField[];
  /**
   * Three-way only. The subset of `changedFields` where the repo AND D1 both
   * moved off the base to different values — genuine conflicts the modal
   * surfaces with an explicit per-field choice (default keep mine, except
   * `repoDefaultFields`). Empty in
   * two-way fallback mode. Repo-only fields sit in `changedFields` but not here.
   */
  conflictFields: SyncField[];
  /**
   * The subset of `conflictFields` whose default is GitHub's value: the base
   * could not say which side changed them (`BaseSheet`). Absent when none.
   */
  repoDefaultFields?: SyncField[];
  d1Values: Partial<Record<SyncField, string | boolean | null>>;
  repoValues: Partial<Record<SyncField, string | boolean | null>>;
}

export interface MissingObject {
  object_id: string;
  dbId: number;
  title: string | null;
  usedByStories: StoryRef[];
  /**
   * Three-way only. True when this row is absent from the repo but its D1 value
   * DIFFERS from the base on at least one sync field — the editor edited it
   * while GitHub deleted it. The modal surfaces such rows as a
   * deleted-in-repo/edited-here conflict (delete vs keep-mine, default
   * keep-mine) instead of listing them under "(removed)". Undefined in two-way
   * mode, where every missing object is simply "(removed)".
   */
  editedInCompositor?: boolean;
}

export interface UnregisteredFile {
  /** Derived object_id (filename without extension) */
  object_id: string;
  /** Original filename in the repo (e.g. "codex-mendoza.jpg") */
  filename: string;
}

export type { LegacyRespelling };

export interface SyncDiff {
  newObjects: NewObject[];
  changedObjects: ChangedObject[];
  missingObjects: MissingObject[];
  /** The objects sheet's file name at the head read: objects.csv, or objetos.csv where the site holds that one. */
  objectsSheet?: string;
  /** Image files in objects/ that aren't in objects.csv or D1 */
  unregisteredFiles: UnregisteredFile[];
  /**
   * GitHub's order of the rows both sides hold, where it is not D1's
   * (`objectOrderChange`); null where it is. The base is not consulted: the
   * Compositor cannot reorder objects, so a difference came from GitHub. Every
   * sync that records GitHub's head as read applies it.
   */
  reordered: ObjectOrderChange | null;
  /**
   * The rows D1 holds under the stripped form of GitHub's padded id, which the
   * sync gives GitHub's spelling without offering it (`respellLegacyObjectIds`);
   * every other comparison above reads them as paired. Absent when there is
   * none.
   */
  respelled?: LegacyRespelling[];
  /**
   * Present when GitHub writes a padded id and the commit legacy pairing is
   * judged against (`legacyRecordRef`) could not be read: the ids have not
   * been judged, so nothing is paired and the project is not marked repaired.
   */
  legacyUnjudged?: true;
  /**
   * Three-way only. Count of editor-only object changes suppressed from this
   * diff (fields whose only mover was the editor, plus suppressed
   * editor-deletions / editor-creations). Undefined in two-way mode.
   * computeFullSyncDiff folds this into FullSyncDiff.suppressedEditorOnly.
   */
  suppressedEditorOnly?: number;
  /**
   * What the reads of the repository's current objects sheet and tree found
   * wrong, for the author to fix on GitHub. The base is never read for these.
   * Absent from a diff built by hand, as an empty diff for a site with no
   * repository is.
   */
  warnings?: SheetWarning[];
  /**
   * The objects sheet, by its file name, when its bytes at the head are not
   * valid UTF-8, whether or not `warnings` are collected. Absent from a diff
   * built by hand.
   */
  unreadableFiles?: string[];
  /**
   * The objects sheet, by its file name, when the headings the site misreads
   * in it at the head differ from the base's (`headingsMoved`). Absent from a
   * diff built by hand.
   */
  headingFiles?: string[];
  /**
   * The commit the sheet and the tree were read at. The objects page's apply
   * carries it back and applies only while it is still GitHub's head.
   */
  headSha?: string;
  /**
   * The objects page's check only: the `objects_read_sha` it was compared
   * against as it stands after the check, null for none. The apply carries it
   * back and applies only while it is still the record.
   */
  baseSha?: string | null;
}

// ---------------------------------------------------------------------------
// The four files the sync diff compares: the objects, project and glossary
// sheets, each the file the build reads at the commit (`readSiteSheet`), and
// _config.yml. Shared by the head fetches and the three-way base fetches.
// ---------------------------------------------------------------------------

const CONFIG_YML_PATH = "_config.yml";

/** The sheets of the four base files, in the order `computeFullSyncDiff` reads them. */
const BASE_SHEETS = ["objects", "project", "glossary"] as const;

/**
 * The objects sheet and the repository tree, read at one head the caller
 * resolves here. The sheet is read strictly: a missing file is a site with no
 * objects yet (`csvContent` null), and any other failure throws
 * `SheetUnreadableError`. Read as a site with no objects, a failed read offers
 * every object D1 holds as removed, and an apply of it deletes them.
 */
async function readObjectsAtHead(
  token: string,
  owner: string,
  repo: string,
  pinnedHead?: string,
): Promise<{
  head: string; path: string; csvContent: string | null; lossy: boolean; tree: TreeEntry[]; truncated: boolean;
}> {
  const head = pinnedHead ?? (await getRepoHead(token, owner, repo, "main"));
  const [{ path, file: csv }, { tree, truncated }] = await Promise.all([
    siteSheetFileAt("objects", (at) => getFileAtRef(token, owner, repo, at, head, { strict: true })),
    getRepoTree(token, owner, repo, head),
  ]);
  if (csv.status === "error") throw new SheetUnreadableError(path);
  const csvContent = csv.status === "ok" ? csv.content : null;
  return { head, path, csvContent, lossy: csv.status === "ok" && csv.lossy === true, tree, truncated };
}

/**
 * Normalised comparison string for an object sync field read from a
 * CSV-derived row (repo HEAD or the three-way base). Applies exactly the same
 * rules the changed-field compare uses so base/repo/D1 strings are
 * commensurable: raw `alt_text` cell (never mapObjectsCsv's title fallback),
 * canonical (key-sorted) `extra_columns`, boolean stringification for
 * `featured`, and empty-string for an absent row or blank cell.
 */
function objectCsvFieldStr(
  field: SyncField,
  row: Record<string, unknown> | undefined,
  rawAltById: Map<string, string>,
  objectId: string,
): string {
  if (!row) return "";
  if (field === "featured") return String(Boolean(row.featured));
  if (field === "alt_text") {
    const v = rawAltById.get(objectId) || null;
    return v === null ? "" : String(v);
  }
  if (field === "extra_columns") {
    return comparableExtraColumns((row.extra_columns as string | null | undefined) ?? null);
  }
  const v = (row[field] as string | null | undefined) || null;
  return v === null ? "" : String(v);
}

/**
 * Normalised comparison string for an object sync field read from a D1 row.
 * Mirrors the changed-field loop's D1 stringification exactly (boolean coercion
 * for `featured`, canonical `extra_columns`, empty-string for null) so a D1 row
 * and a CSV-derived base row are commensurable.
 */
function d1ObjectFieldStr(field: SyncField, d1Obj: Record<string, unknown>): string {
  if (field === "featured") return String(Boolean(d1Obj.featured ?? false));
  if (field === "extra_columns") {
    return comparableExtraColumns((d1Obj.extra_columns as string | null | undefined) ?? null);
  }
  const v = (d1Obj[field] as string | null | undefined) ?? null;
  return v === null ? "" : String(v);
}

/**
 * The value a field held at the base in any colliding column before the last,
 * read from the base re-read with each earlier claimant keeping the name; ""
 * when none held one.
 */
function earlierClaimantValue(
  reads: { map: Map<string, Record<string, unknown>>; rawAlt: Map<string, string> }[],
  field: SyncField,
  objectId: string,
): string {
  for (const read of reads) {
    const value = objectCsvFieldStr(field, read.map.get(objectId), read.rawAlt, objectId);
    if (value) return value;
  }
  return "";
}

/**
 * True when an empty repo cell should be passed over rather than read as a
 * change.
 *
 * The guard exists for enrichment: a blank repo cell against IIIF-derived D1
 * data is the author leaving the column for the enrichment to fill, not an
 * edit. `extra_columns` is outside it — "empty" there is the state of an object
 * whose last custom column was deleted, and swallowing that means the deletion
 * can never be seen or accepted.
 *
 * `baseStr` is the base's value for the cell, or null when there is no base to
 * read it from (a two-way check, or a base whose id column collided). A cell
 * the base held and the repo cleared is an edit, not a cell left for enrichment.
 * A field a collision feeds is read from each of its colliding columns at the
 * base, so a value held in any of them counts as held.
 */
function repoCellIsSkippableEmpty(field: SyncField, repoStr: string, baseStr: string | null): boolean {
  return repoStr === "" && field !== "extra_columns" && !baseStr;
}

/** True when a repo row is field-for-field identical to its base row. */
function objectRowsIdentical(
  repoRow: Record<string, unknown> | undefined,
  baseRow: Record<string, unknown> | undefined,
  repoRawAlt: Map<string, string>,
  baseRawAlt: Map<string, string>,
  objectId: string,
): boolean {
  for (const field of SYNC_FIELDS) {
    if (
      objectCsvFieldStr(field, repoRow, repoRawAlt, objectId) !==
      objectCsvFieldStr(field, baseRow, baseRawAlt, objectId)
    ) {
      return false;
    }
  }
  return true;
}

export interface SyncChanges {
  /** object_ids to insert from repo CSV */
  newObjectIds: string[];
  /** object_ids to update (with per-field source choices) */
  changedObjectIds: string[];
  /**
   * The D1 id of each changed object as the author was shown it, by object_id.
   * An update is applied only to that row: an object deleted and re-created
   * under the same key since the check is not the one the author reviewed.
   * Neither apply updates anything for an entry without one.
   */
  changedDocIds?: Record<string, number>;
  /** Per-object, per-field choices: "repo" | "d1" */
  fieldChoices: Record<string, Record<string, "repo" | "d1">>;
  /** object_ids to delete from D1 (missing objects user chose to remove) */
  removedObjectIds: string[];
  /**
   * The D1 id of each removed object as the author was shown it, by object_id.
   * A removal is applied only to that row: an object deleted and re-created
   * under the same key since the check is not the one the author chose to
   * remove. The objects page's apply removes nothing for an entry without one.
   */
  removedDocIds?: Record<string, number>;
  /** object_ids to register from unregistered image files in objects/ */
  unregisteredObjectIds: string[];
  /**
   * The commit the check the author reviewed was read at (`SyncDiff.headSha`).
   * The objects page's apply refuses without it and reads at it; the full
   * sync's objects arm is read at the full check's own head instead.
   */
  headSha?: string;
  /**
   * The `objects_read_sha` the check the author reviewed was compared against
   * (`SyncDiff.baseSha`), null for none. The objects page's apply refuses
   * without it, and when the record is no longer it.
   */
  baseSha?: string | null;
  /**
   * The Compositor's value of each field taken from GitHub, as the check the
   * author reviewed read it (`ChangedObject.d1Values`), by object_id. The
   * collaboration object leaves a field whose value has changed since
   * (`changedSinceReview`). Absent for a field, the field is written as sent.
   */
  fieldsSeen?: Record<string, Record<string, string | boolean | null>>;
}

// ---------------------------------------------------------------------------
// computeSyncDiff
// ---------------------------------------------------------------------------

/**
 * Records a sheet warning for each group of objects.csv rows the site reads as
 * one object, which its object page and steps show only the later of, and for
 * each object_id written in more than one row. Nothing where the read collects
 * no warnings.
 */
function warnSharedSiteIds(
  repoRows: Array<Record<string, unknown>>,
  frameworkVersion: string | null,
  warnings: SheetWarning[] | null,
  fileName: string,
): void {
  if (!warnings) return;
  const report = issuesFor(fileName, warnings);
  const inSheetOrder = repoRows.map((r) => ({ object_id: String(r.object_id ?? "") }));
  for (const issue of sharedSiteIdIssues(inSheetOrder, frameworkVersion)) report(issue);
  for (const issue of repeatedIdIssues(inSheetOrder, frameworkVersion)) report(issue);
}

/** Every stem a file of these objects may carry: each id as written and the id the site gives it. */
function fileStemsOf(ids: readonly string[], frameworkVersion: string | null): Set<string> {
  const stems = new Set<string>();
  for (const id of ids) {
    stems.add(id);
    stems.add(siteObjectId(id, frameworkVersion));
  }
  return stems;
}

/**
 * Computes a three-way diff between D1 objects and the repo's objects.csv.
 *
 * Returns three arrays:
 *   newObjects     — in repo CSV but not in D1
 *   changedObjects — in both, but at least one compared field differs
 *   missingObjects — in D1 but not in repo CSV (includes story usage)
 */
export async function computeSyncDiff(
  projectId: number,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  baseObjectsContent?: string | null,
  /** The HEAD commit a caller pins its reads to; omitted, this resolves its own. */
  headRef?: string,
  /**
   * Whether to report what the reads found wrong (`warnings`). The objects
   * page's sync, which only an author starts, always does; the full sync
   * passes its own option through.
   */
  collectWarnings = true,
  /**
   * The site's framework version, which decides the id the site gives each
   * object (`siteObjectId`), and so which file is an object's and which step
   * names it: the repository's at the head read, else D1's (`siteVersionAtRef`).
   * Absent, the repository's alone.
   */
  version: SiteVersionSource = { d1: null },
  /**
   * The commit ids an earlier import stored stripped are judged against
   * (`legacyRecordRef`), while the project's `legacy_ids_repaired_at` is NULL,
   * for a caller that has read it; null where the project has no such commit.
   * objects.csv there is read only when some GitHub id is padded. Absent,
   * nothing is paired, and every id difference is an ordinary change.
   */
  legacyRef?: string | null,
): Promise<SyncDiff> {
  // Three-way vs two-way is decided by the caller and threaded in as the base
  // objects.csv CONTENT, not a ref: `undefined` means two-way (no base); a
  // string or `null` means three-way, where `null` is an empty base
  // (objects.csv legitimately absent at the base commit). computeFullSyncDiff
  // fetches every base file once and decides the mode for all sub-domains
  // together; the objects page reads objects.csv alone (`objectsBaseAt`).
  const threeWay = baseObjectsContent !== undefined;
  const baseSheet = threeWay ? readBaseSheet(baseObjectsContent ?? null, objectsSheet()) : null;
  const baseUnknown = baseRowsUnknown(baseSheet, "object_id");
  const baseCsvContent = threeWay && !baseUnknown ? (baseObjectsContent ?? null) : null;
  const { head, path: objectsPath, csvContent, lossy, tree, truncated } =
    await readObjectsAtHead(token, owner, repo, headRef);
  const frameworkVersion = await siteVersionAtRef(version, token, owner, repo, head);
  const warnings: SheetWarning[] | null = collectWarnings
    ? truncated ? [{ code: "tree_truncated" }] : []
    : null;
  const unreadableFiles = objectsUnreadable(objectsPath, lossy, warnings);

  // Fetch current D1 objects for this project
  const d1Objects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, projectId));
  const d1Map = new Map(d1Objects.map((o) => [o.object_id, o]));

  // Parse repo CSV into objects. Every comparison below is by D1's spelling of
  // an id an earlier import stored stripped (`legacyStrippedIds`); the warnings
  // and the file stems keep GitHub's.
  const objectsFileName = fileNameOf(objectsPath);
  const parsedAsWritten = readRepoSheet(csvContent, objectsSheet(objectsFileName), warnings);
  const repoRowsAsWritten = csvContent
    ? mapObjectsCsv(parsedAsWritten, projectId, warnings ? issuesFor(objectsFileName, warnings) : undefined)
    : [];
  const legacy = await legacyEvidence({ token, owner, repo }, repoRowsAsWritten, legacyRef);
  const { parsed: parsedCsvRows, mapped: repoRows, renames: legacyRenames } = pairLegacyObjectIds(
    parsedAsWritten,
    repoRowsAsWritten,
    d1Objects,
    legacy.recordedIds,
  );
  const legacyIds = new Map([...legacyRenames.values()].map((r) => [r.githubId, r.objectId]));
  const repoMap = new Map(repoRows.map((r) => [r.object_id as string, r]));
  warnSharedSiteIds(repoRowsAsWritten, frameworkVersion, warnings, objectsFileName);
  // Raw alt_text cells by object_id. mapObjectsCsv applies the import-time
  // accessibility fallback (alt_text = cell || title); that fallback is an
  // import enrichment, NOT repo state. Diffing against it would fabricate a
  // "changed" row for every object whose repo cell is blank, claiming the repo
  // holds the title. The diff must compare what the repo actually says.
  const rawAltTextById = new Map(
    parsedCsvRows.map((r) => [r.object_id ?? "", r.alt_text ?? ""]),
  );

  // Parse the three-way base copy the same way, with its own raw alt_text side
  // map. Empty when two-way.
  const parsedBaseRows = baseUnknown ? [] : onD1Spelling(baseSheet?.rows ?? [], legacyIds);
  const ambiguousFields = objectFieldsFedBy(baseSheet?.collided ?? new Set());
  const baseRows = threeWay && baseCsvContent ? mapObjectsCsv(parsedBaseRows, projectId) : [];
  const baseMap = new Map(baseRows.map((r) => [r.object_id as string, r]));
  const baseRawAltById = new Map(
    parsedBaseRows.map((r) => [r.object_id ?? "", r.alt_text ?? ""]),
  );
  const earlierBases = (baseUnknown ? [] : (baseSheet?.earlierClaimants ?? [])).map((rows) => {
    const parsed = onD1Spelling(rows, legacyIds);
    return {
      map: new Map(mapObjectsCsv(parsed, projectId).map((r) => [r.object_id as string, r])),
      rawAlt: new Map(parsed.map((r) => [r.object_id ?? "", r.alt_text ?? ""])),
    };
  });
  let suppressedEditorOnly = 0;


  // This project's step references, to detect story usage
  const stepRefs = await db
    .select({
      object_id: steps.object_id,
      step_number: steps.step_number,
      story_id: steps.story_id,
    })
    .from(steps)
    .innerJoin(stories, eq(steps.story_id, stories.id))
    .where(eq(stories.project_id, projectId));

  // Fetch story titles for referenced stories
  const storyRows = await db
    .select({ id: stories.id, title: stories.title })
    .from(stories)
    .where(eq(stories.project_id, projectId));
  const storyTitleMap = new Map(storyRows.map((s) => [s.id, s.title]));

  // Build usage map: object_id -> list of StoryRef, each step counted for
  // the D1 object the site shows for it (`stepObjectResolver`), so a step
  // naming `map` is a use of `map.jpg`.
  const showsFor = stepObjectResolver([...d1Objects].sort(compareSheetOrder), frameworkVersion);
  const usageMap = new Map<string, StoryRef[]>();
  for (const ref of stepRefs) {
    const shown = showsFor(ref.object_id);
    if (!shown) continue;
    const storyTitle = storyTitleMap.get(ref.story_id) ?? null;
    const existing = usageMap.get(shown.object_id) ?? [];
    existing.push({ storyTitle, stepNumber: ref.step_number });
    usageMap.set(shown.object_id, existing);
  }

  // Compute new objects (in repo but not in D1).
  //
  // Three-way refines "not in D1": a row present in the base and byte-identical
  // to the base is a pure editor deletion — suppress it (never resurrect). A
  // row present in the base but edited in the repo is a deleted-here/edited-
  // there conflict, flagged for the modal. A row absent from the base is
  // genuinely new, inserted as today.
  const newObjects: NewObject[] = [];
  for (const [objectId, repoRow] of repoMap.entries()) {
    if (d1Map.has(objectId)) continue;

    let deletedInCompositor = false;
    if (threeWay && !baseUnknown) {
      const baseRow = baseMap.get(objectId);
      if (baseRow) {
        if (objectRowsIdentical(repoRow, baseRow, rawAltTextById, baseRawAltById, objectId)) {
          suppressedEditorOnly++; // editor-only deletion — do not resurrect
          continue;
        }
        deletedInCompositor = true; // deleted here, edited there — conflict
      }
    }

    newObjects.push({
      object_id: objectId,
      title: (repoRow.title as string) || null,
      creator: (repoRow.creator as string) || null,
      description: (repoRow.description as string) || null,
      period: (repoRow.period as string) || null,
      year: (repoRow.year as string) || null,
      object_type: (repoRow.object_type as string) || null,
      subjects: (repoRow.subjects as string) || null,
      source: (repoRow.source as string) || null,
      credit: (repoRow.credit as string) || null,
      thumbnail: (repoRow.thumbnail as string) || null,
      featured: Boolean(repoRow.featured),
      source_url: (repoRow.source_url as string) || null,
      dimensions: (repoRow.dimensions as string) || null,
      image_available: false,
      ...(deletedInCompositor ? { deletedInCompositor: true } : {}),
    });
  }

  // Compute changed objects (in both, with differing fields)
  const changedObjects: ChangedObject[] = [];
  for (const [objectId, d1Obj] of d1Map.entries()) {
    const repoRow = repoMap.get(objectId);
    if (!repoRow) continue; // missing — handled below

    const changedFields: SyncField[] = [];
    const conflictFields: SyncField[] = [];
    const repoDefaultFields: SyncField[] = [];
    const d1Values: Partial<Record<SyncField, string | boolean | null>> = {};
    const repoValues: Partial<Record<SyncField, string | boolean | null>> = {};
    const baseRow = threeWay ? baseMap.get(objectId) : undefined;
    // Entity-grain suppression: an object with several editor-only fields counts
    // ONCE, whether or not other fields also surfaced as repo-only/conflict.
    let hadEditorOnly = false;

    for (const field of SYNC_FIELDS) {
      let d1Val: string | boolean | null;
      let repoVal: string | boolean | null;
      let d1Str: string;
      let repoStr: string;

      if (field === "featured") {
        d1Val = d1Obj.featured ?? false;
        repoVal = Boolean(repoRow.featured);
        d1Str = String(d1Val);
        repoStr = String(repoVal);
      } else if (field === "alt_text") {
        // Compare against the RAW repo CSV cell, not repoRow.alt_text —
        // mapObjectsCsv fills a blank cell with the object's title (an import
        // accessibility fallback). Using the fallback here would flag every
        // object with a blank repo cell as "changed to <title>", fabricating
        // repo state the user never wrote and, on accept, writing the title
        // into D1 alt_text as if authored.
        d1Val = (d1Obj.alt_text as string | null | undefined) ?? null;
        repoVal = rawAltTextById.get(d1Obj.object_id) || null;
        d1Str = d1Val === null ? "" : String(d1Val);
        repoStr = repoVal === null ? "" : String(repoVal);
      } else if (field === "extra_columns") {
        // Compare the custom-column blob semantically (parsed, keys-sorted),
        // never by raw-JSON string equality: a repo whose columns were merely
        // reserialised in a different key order is not a real change. The
        // displayed values stay raw so the user sees the actual stored JSON.
        d1Val = (d1Obj.extra_columns as string | null | undefined) ?? null;
        repoVal = (repoRow.extra_columns as string | null | undefined) ?? null;
        // Modelled names are dropped from BOTH sides: a key the repair retains
        // lives only on the editor side, because the export guard keeps it out
        // of the file, and comparing it raw reports the object as changed
        // against the file it was just published to.
        d1Str = comparableExtraColumns(d1Val);
        repoStr = comparableExtraColumns(repoVal);
      } else {
        d1Val = (d1Obj[field] as string | null | undefined) ?? null;
        repoVal = (repoRow[field] as string | null | undefined) || null;
        d1Str = d1Val === null ? "" : String(d1Val);
        repoStr = repoVal === null ? "" : String(repoVal);
      }

      // The repo-empty guard runs BEFORE classification: an empty repo cell
      // against enriched D1 data (likely IIIF) is never a diff entry, unless
      // the base held a value there, which the repo then cleared.
      //
      // It does NOT cover `extra_columns`, where "empty" is not a cell the
      // author left blank for the enrichment to fill — it is the state of an
      // object whose last custom column they deleted. Swallowing that hides
      // the one change the repo can make to the blob, and the deletion can
      // never be accepted.
      const baseStr = threeWay && !baseUnknown ? objectCsvFieldStr(field, baseRow, baseRawAltById, objectId) : null;
      const heldBefore = baseStr || (ambiguousFields.has(field) ? earlierClaimantValue(earlierBases, field, objectId) : "");
      if (d1Str === repoStr || repoCellIsSkippableEmpty(field, repoStr, heldBefore)) continue;

      if (!threeWay) {
        // Two-way fallback: every repo/D1 disagreement is a change (today's
        // behaviour), no conflict classification.
        changedFields.push(field);
        d1Values[field] = d1Val;
        repoValues[field] = repoVal;
        continue;
      }

      // A field the base cannot place is a conflict whichever side moved it.
      if (baseUnknown || ambiguousFields.has(field)) {
        changedFields.push(field);
        d1Values[field] = d1Val;
        repoValues[field] = repoVal;
        conflictFields.push(field);
        // A clearing defaults to GitHub's only where the Compositor still
        // holds the base's value; an edit made here is kept unless chosen away.
        const clearsAnEdit = repoStr === "" && d1Str !== heldBefore;
        if (!baseUnknown && repoDefaultsFor(field) && !clearsAnEdit) repoDefaultFields.push(field);
        continue;
      }

      // Three-way classification against the base value.
      const repoChanged = baseStr !== repoStr;
      const editorChanged = baseStr !== d1Str;

      if (editorChanged && !repoChanged) {
        // Editor-only — the repo never moved this field. Suppress it so the
        // sync cannot overwrite an unpublished edit with a stale repo value.
        // Counted once per object below, not once per field.
        hadEditorOnly = true;
        continue;
      }

      // repo-only (repoChanged && !editorChanged) or conflict (both changed).
      changedFields.push(field);
      d1Values[field] = d1Val;
      repoValues[field] = repoVal;
      if (repoChanged && editorChanged) conflictFields.push(field);
    }

    if (hadEditorOnly) suppressedEditorOnly++;

    if (changedFields.length > 0) {
      changedObjects.push({
        object_id: objectId,
        dbId: d1Obj.id,
        title: d1Obj.title ?? null,
        changedFields,
        conflictFields,
        ...(repoDefaultFields.length > 0 ? { repoDefaultFields } : {}),
        d1Values,
        repoValues,
      });
    }
  }

  // Compute missing objects (in D1 but not in repo CSV)
  // Compositor-origin objects are excluded: they were created by the compositor
  // and their CSV commit may have failed (e.g. StaleHeadError). They are
  // legitimate objects — warn rather than offering to delete.
  const missingObjects: MissingObject[] = [];
  for (const [objectId, d1Obj] of d1Map.entries()) {
    if (!repoMap.has(objectId)) {
      if (d1Obj.origin === "compositor") {
        continue; // skip — compositor-origin objects are not classified as missing
      }
      // Three-way: a row absent from BOTH the repo and the base is suppressed
      // from the "(removed)" list rather than offered for deletion. Because
      // compositor-origin rows were already skipped above, the rows reaching
      // here have origin != "compositor" — a repo object the user declined to
      // delete on an earlier sync, now settled behind the base. That is not an
      // unpublished editor change, so it is NOT counted in suppressedEditorOnly
      // (counting it would inflate the "N changes left untouched" note). A row
      // that WAS in the base is a genuine repo deletion, shown as today.
      if (threeWay && !baseUnknown && !baseMap.has(objectId)) {
        continue;
      }
      // Three-way: the row was in the base and is now gone from the repo. If
      // the editor also moved it off the base (any sync field differs), it is a
      // deleted-in-repo/edited-here conflict — flag it so the modal offers a
      // choice rather than silently destroying the unpublished edit on delete.
      let editedInCompositor = baseUnknown;
      if (threeWay && !baseUnknown) {
        const baseRow = baseMap.get(objectId);
        editedInCompositor = SYNC_FIELDS.some(
          (f) =>
            objectCsvFieldStr(f, baseRow, baseRawAltById, objectId) !==
            d1ObjectFieldStr(f, d1Obj),
        );
      }
      missingObjects.push({
        object_id: objectId,
        dbId: d1Obj.id,
        title: d1Obj.title ?? null,
        usedByStories: usageMap.get(objectId) ?? [],
        ...(editedInCompositor ? { editedInCompositor: true } : {}),
      });
    }
  }

  // Compute unregistered files (image files in telar-content/objects/ not in
  // CSV or D1). A file is a row's when its stem is the row's id as written or
  // the id the site gives it, since the site looks for `map.jpg`'s image as
  // `map` with each image extension.
  const registeredStems = fileStemsOf(
    [...repoRowsAsWritten.map((r) => r.object_id), ...d1Map.keys()],
    frameworkVersion,
  );
  const unregisteredFiles: UnregisteredFile[] = [];
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    const parts = entry.path.split("/");
    if (parts.length !== 3 || parts[0] !== "telar-content" || parts[1] !== "objects") continue;
    // A file with an empty stem (`.jpg`) is offered as nothing: no row can
    // take an empty id.
    const objectId = tileableStem(parts[2], frameworkVersion);
    if (!objectId) continue;
    if (!registeredStems.has(objectId)) {
      unregisteredFiles.push({ object_id: objectId, filename: parts[2] });
    }
  }

  return {
    newObjects,
    changedObjects,
    missingObjects,
    objectsSheet: objectsFileName,
    unregisteredFiles,
    reordered: objectOrderChange(repoRows, d1Objects),
    ...(legacyRenames.size > 0 ? { respelled: [...legacyRenames.values()] } : {}),
    ...(legacy.unjudged ? { legacyUnjudged: true as const } : {}),
    ...(threeWay ? { suppressedEditorOnly } : {}),
    ...(warnings ? { warnings } : {}),
    unreadableFiles,
    headingFiles: headingFilesMoved(baseObjectsContent, csvContent, objectsSheet(objectsFileName), objectsFileName),
    headSha: head,
  };
}

/**
 * The objects sheet's name when its read at the head was lossy, else none;
 * the sheet is named in `warnings` too when they are collected.
 */
function objectsUnreadable(path: string, lossy: boolean, warnings: SheetWarning[] | null): string[] {
  if (!lossy) return [];
  pushUnreadable(warnings ?? undefined, path);
  return [unreadableFileName(path)];
}

// ---------------------------------------------------------------------------
// applySyncChanges
// ---------------------------------------------------------------------------

/** A pending object row that has not yet been inserted into D1. */
export interface PendingObject {
  object_id: string;
  title: string | null;
  featured: boolean;
  creator: string | null;
  description: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  object_type: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  alt_text?: string | null;
  dimensions?: string | null;
  extra_columns?: string | null;
  image_available: boolean;
  origin?: string;
}

/**
 * An objects apply refused before it took the lease or read anything, because
 * the check it carries names no full commit SHA (an older page), or its commit
 * is not GitHub's head. The objects apply does not check the base the check
 * compared against, so the check's commit is the only identity it has; the
 * author checks again.
 */
export class ObjectsSyncStale extends Error {
  constructor() {
    super("sync-apply refused: the check's commit is not GitHub's head");
    this.name = "ObjectsSyncStale";
  }
}

/**
 * The commit the check was read at, while it is still GitHub's head. The value
 * arrives from the client, so only a full commit SHA, exactly 40 lowercase hex
 * characters, is taken; anything else, or a head that has moved, throws
 * `ObjectsSyncStale`.
 */
async function currentCheckedHead(
  changes: SyncChanges,
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  const headSha: unknown = changes.headSha;
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) throw new ObjectsSyncStale();
  if ((await getRepoHead(token, owner, repo, "main")) !== headSha) throw new ObjectsSyncStale();
  return headSha;
}

/**
 * Applies the author's selected objects sync changes, holding the `objects`
 * lease: the accepted field changes and the removals through the collaboration
 * object in one ingest, `missing_from_repo` in D1, the accepted new rows
 * registered through the collaboration object with `userId` as their actor, and
 * image files with no row returned as pending for the objects commit. See
 * `applyUnderLease`.
 *
 * Only the commit the author reviewed is applied: a check that is not
 * GitHub's head now is refused before the lease (`ObjectsSyncStale`), and
 * every read of the apply is at that commit, so a commit that lands after the
 * comparison is not read.
 *
 * A field taken from GitHub with no value the check read (`fieldsSeen`), as a
 * page loaded before the collaboration object compared them sends, is refused
 * before the lease (`SyncBaseStale`): the author checks again.
 *
 * Under the lease, once the apply has landed everything it was sent, the
 * project's objects_read_sha advances to the commit applied, compare-and-set
 * from the base the check was compared against (`readRecorded`), before the
 * lease is released: the next apply to take the lease finds it moved.
 *
 * Returns the count of changes applied. Throws, claiming nothing, when the
 * check is not current, the lease is held elsewhere, objects.csv cannot be
 * read, or the ingest fails.
 */
export async function applySyncChanges(
  projectId: number,
  changes: SyncChanges,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  env: FullSyncEnv,
  userId: number,
): Promise<ObjectsSyncApplied> {
  refuseUnseenGitHubFields(changes);
  const headSha = await currentCheckedHead(changes, token, owner, repo);
  // Under the objects lease, as every objects write through the document is:
  // no publish serialises objects.csv from D1 while this apply is changing it.
  const held = await holdOperationLease(
    env as unknown as Env, projectId, userId, "objects",
    async (landed) => {
      await finishPendingObjectOps(env, db, projectId, { token, owner, repo }, { head: headSha, stale: () => new ObjectsSyncStale() });
      const result = await applyUnderLease(
        projectId, changes, headSha, token, owner, repo, db, env, userId,
      );
      const readRecorded = await recordAppliedRead(db, projectId, changes, headSha, result);
      landed();
      return readRecorded === undefined ? result : { ...result, readRecorded };
    },
  );
  if (held.refused) throw new Error("sync-apply refused: another operation holds the lease");
  return held.value;
}

/**
 * Finishes the project's pending object operations before a sync compares
 * GitHub's rows with D1's: a landed commit whose document half has not run
 * would otherwise read as a difference, and applying it would undo the commit
 * in D1. A prepared record is judged by objects.csv at GitHub's head as it is
 * now, or a rename that switched Sheets off by `_config.yml` at that same
 * head, read here and only when a record needs it, never at the head a check
 * was pinned to: a commit landed since would read as not landed, and the record
 * would be dropped. Not `prepareObjectsCommit`, whose stripped-id refusal would
 * stand in front of the sync that repairs those ids. Throws when a record
 * cannot be finished.
 */
async function finishPendingObjectOps(
  env: FullSyncEnv,
  db: ReturnType<typeof getDb>,
  projectId: number,
  at: { token: string; owner: string; repo: string },
  /**
   * An apply's check is of one head: when completion finished a record and
   * GitHub's head is not it, `stale` is thrown, since the comparison that
   * follows would read what completion registered as absent.
   */
  checked?: { head: string; stale: () => Error },
): Promise<void> {
  const { completePendingObjectOps, readObjectsSheetAt, readSheetsOnAt } = await import("~/lib/pending-object-ops.server");
  let headRead: Promise<string> | undefined;
  const head = () => (headRead ??= getRepoHead(at.token, at.owner, at.repo));
  const completion = await completePendingObjectOps(
    env as unknown as Env, db, projectId,
    async () => (await readObjectsSheetAt(at.token, at.owner, at.repo, await head())).sheet,
    { sheetsOn: async () => readSheetsOnAt(at.token, at.owner, at.repo, await head()) },
  );
  if (!completion.ok) throw new Error(`pending operation ${completion.failedOp} could not be completed`);
  if (checked && completion.applied && (await getRepoHead(at.token, at.owner, at.repo)) !== checked.head) throw checked.stale();
}

/**
 * Before a check the author will review reads D1: finishes the pending object
 * operations under the `objects` lease, so the dialog does not offer a landed
 * operation as a difference. Throws when the lease is held elsewhere or a
 * record cannot be finished, which the check answers as a failed read: the
 * author checks again, rather than reviewing a difference that is not one.
 */
export async function finishPendingBeforeCheck(
  env: FullSyncEnv,
  db: ReturnType<typeof getDb>,
  projectId: number,
  userId: number,
  at: { token: string; owner: string; repo: string },
): Promise<void> {
  const held = await holdOperationLease(env as unknown as Env, projectId, userId, "objects", async (landed) => {
    await finishPendingObjectOps(env, db, projectId, at);
    landed();
  });
  if (held.refused) throw new Error("sync check refused: another operation holds the lease");
}

/**
 * Throws `SyncBaseStale` when a field the choices take from GitHub carries no
 * value the check read (`SyncChanges.fieldsSeen`): without it the collaboration
 * object cannot tell an edit made since the check, so the choice is refused
 * and the author checks again.
 */
function refuseUnseenGitHubFields(changes: SyncChanges): void {
  for (const objectId of changes.changedObjectIds) {
    const choices = ownValue(changes.fieldChoices, objectId) ?? {};
    const seen = ownValue(changes.fieldsSeen ?? {}, objectId) ?? {};
    for (const [field, choice] of Object.entries(choices)) {
      if (choice === "repo" && !Object.hasOwn(seen, field)) throw new SyncBaseStale();
    }
  }
}

/**
 * Advance objects_read_sha to `headSha`, compare-and-set from the check's base,
 * for an apply that landed everything it was sent: true when it moved, false
 * when another writer moved it first or the write failed. Undefined, nothing
 * written, for an apply that left something GitHub's commit holds (an update
 * not applied to the row reviewed, or a new row not added), which the next
 * check offers again, and for a caller that names no base.
 */
async function recordAppliedRead(
  db: ReturnType<typeof getDb>,
  projectId: number,
  changes: SyncChanges,
  headSha: string,
  applied: ObjectsSyncApplied,
): Promise<boolean | undefined> {
  if (changes.baseSha === undefined || applied.updateSkipped || applied.notAdded.length > 0) return undefined;
  // Imported here: github-status.server imports this module.
  const { bumpObjectsReadFrom } = await import("~/lib/github-status.server");
  try {
    return await bumpObjectsReadFrom(db, projectId, changes.baseSha, headSha);
  } catch (err) {
    console.error("sync-apply: objects_read_sha write failed", err);
    return false;
  }
}

/**
 * Apply GitHub's object order at `head`: "Use Compositor version" records
 * `head` as read, and the order has no Compositor side to keep. Reads
 * objects.csv strictly at `head`, compares it with D1 (`objectOrderChange`),
 * and sends one ingest under the objects lease, as every objects write through
 * the document is, holding `objects.order` and the rename-only updates that
 * give each row D1 holds under a stripped id GitHub's spelling
 * (`legacyStrippedIds`, judged against `legacyPairingRef`): recording `head`
 * with such a row left would have the next publish write D1's spelling over
 * GitHub's. Sends nothing where there is neither.
 *
 * Answers `superseded` when a row the order or a respelling names has been
 * re-created since, and the caller then records nothing; and `legacyUnjudged`
 * when a GitHub id is padded and the commit legacy pairing is judged against
 * could not be read, so the caller does not mark the ids repaired. `record`,
 * the caller's record of `head`, runs under the same lease once the ingest
 * superseded nothing, since a sync apply records what it applied under that
 * lease and the two move the same columns; `recorded` is what it answered,
 * false when it did not run, and absent without one. Throws
 * `SyncBaseStale`, writing nothing, when head_sha is no longer `base`, before
 * the lease or under it immediately before the ingest; throws
 * when objects.csv cannot be read, the lease is held elsewhere, or the ingest
 * fails.
 */
export async function applyGitHubObjectOrder(
  projectId: number,
  access: { token: string; owner: string; repo: string },
  head: string,
  /** The head_sha the check was computed against, null for none. */
  base: string | null,
  db: ReturnType<typeof getDb>,
  env: FullSyncEnv,
  userId: number,
  record?: () => Promise<boolean>,
): Promise<{ superseded: boolean; recorded?: boolean; legacyUnjudged?: true }> {
  // Before the lease and before anything is read or written, as the full sync
  // refuses a moved base: GitHub's order at `head` is the order of the check
  // computed against `base`, and a head another writer recorded since is not
  // the one this choice was made over.
  await refuseMovedBase(db, projectId, base);
  const held = await holdOperationLease(
    env as unknown as Env, projectId, userId, "objects",
    async (landed) => {
      const { csvContent, path: objectsPath } = await readObjectsAtHead(access.token, access.owner, access.repo, head);
      const repoRowsAsWritten = csvContent
        ? mapObjectsCsv(readRepoSheet(csvContent, objectsSheet(fileNameOf(objectsPath)), null), projectId)
        : [];
      const d1Objects = await db.select().from(objects).where(eq(objects.project_id, projectId));
      const legacy = await applyLegacyEvidence(db, projectId, access, repoRowsAsWritten);
      const { mapped: repoRows, renames } = pairLegacyObjectIds([], repoRowsAsWritten, d1Objects, legacy.recordedIds);
      const update = withGitHubSpelling([], renames);
      const order = underSentSpelling(objectOrderChange(repoRows, d1Objects)?.order ?? [], update);
      // Again under the lease, immediately before the ingest, as both sync
      // applies check theirs: a head recorded between the check above and
      // the lease is refused with nothing written.
      await refuseMovedBase(db, projectId, base);
      const answer = await ingestObjectChanges(env, projectId, { update, insert: [], remove: [], order });
      landed();
      const superseded = answer.superseded.length > 0;
      return {
        superseded,
        ...(record ? { recorded: !superseded && await record() } : {}),
        ...(legacy.unjudged ? { legacyUnjudged: true as const } : {}),
      };
    },
  );
  if (held.refused) throw new Error("object order refused: another operation holds the lease");
  return held.value;
}

/** Throws `SyncBaseStale` when the project's `record` (head_sha unless named) is not `base`. */
async function refuseMovedBase(
  db: ReturnType<typeof getDb>,
  projectId: number,
  base: string | null,
  record: "head_sha" | "objects_read_sha" = "head_sha",
): Promise<void> {
  const { projects } = await import("~/db/schema");
  const [recorded] = await db
    .select({ head_sha: projects.head_sha, objects_read_sha: projects.objects_read_sha })
    .from(projects)
    .where(eq(projects.id, projectId));
  if ((recorded?.[record] ?? null) !== base) throw new SyncBaseStale();
}

/**
 * Refuses the objects page's apply, with `SyncBaseStale`, unless the project's
 * objects_read_sha is still the base its check was compared against
 * (`SyncChanges.baseSha`): the check's defaults were chosen against that base,
 * as the full sync's were against head_sha, which it refuses the same way. The
 * value arrives from the client, so a check that names no base (an older
 * page), or names anything but null or a string, is refused too; a string
 * passes only by equalling the record. The caller runs this before
 * `applySyncChanges`, which writes nothing before it.
 */
export async function refuseMovedObjectsBase(
  db: ReturnType<typeof getDb>,
  projectId: number,
  changes: SyncChanges,
): Promise<void> {
  const base: unknown = changes.baseSha;
  if (base !== null && typeof base !== "string") throw new SyncBaseStale();
  await refuseMovedBase(db, projectId, base, "objects_read_sha");
}

/**
 * What the objects page's apply did. `appliedCount` counts the updates the
 * document applied and the removals sent. `updateSkipped` is true when the
 * apply was held back whole, writing nothing, for objects edited in the
 * Compositor since the check, a field changed or the row re-created
 * (`changedSinceReview` names them): GitHub's
 * change is then not read, and the caller does not record the commit as read.
 * An update to an object the document no longer holds at all is not counted
 * and does not set it: the object was deleted in the Compositor, and the next
 * check reads its absence as the author's own.
 *
 * `notAdded` names the accepted new rows the registration did not add to D1:
 * all of them when it failed, else those it answered as failed or already
 * present. The caller does not record the commit as read while any is named,
 * and they are not pending: the objects commit's unread check would refuse the
 * commit that registered them, so the next check offers them again instead.
 */
export interface ObjectsSyncApplied {
  appliedCount: number;
  pendingObjects: PendingObject[];
  updateSkipped: boolean;
  notAdded: string[];
  /** Objects with a field the collaboration object left, edited in the Compositor since the check. */
  changedSinceReview?: string[];
  /**
   * Whether objects_read_sha advanced to the commit applied (`recordAppliedRead`):
   * false when another writer had moved it. Absent when the apply did not try.
   */
  readRecorded?: boolean;
}

/**
 * The apply, holding the lease.
 *
 * The accepted field changes, the removals and GitHub's order of the rows both
 * sides hold (`objectOrderChange`, sent whatever the author ticked) go to the
 * collaboration object in one ingest, and its snapshot writes them to D1. Written to D1 directly,
 * a document still holding the old values writes them back on its next
 * snapshot, and a removal the page did not get to apply is re-inserted.
 * Updates name the D1 id the author was shown (`changedDocIds`), and are sent
 * only while D1 holds that key with that id; the document applies each only to
 * the object holding both, and answers the others as skipped. Removals name
 * the D1 id the author was shown (`removedDocIds`), and are sent only while
 * D1's row for that key still has it: an object deleted and
 * re-created under the same key since the check is not the one the author
 * chose to remove, and an entry with no id removes nothing. They are sent only
 * for objects still absent from the sheet read here, and never for a course
 * item, which belongs to the course and is absent from objects.csv until the
 * group's first publish.
 *
 * `missing_from_repo`, which only D1 holds, is written directly once the
 * ingest has answered. A failed ingest throws before it, so a failed apply
 * claims nothing.
 *
 * The accepted new rows with a row at `headSha` are then registered through
 * the collaboration object, as the objects commit registers its own, with the
 * author as actor and the repo as origin, each placed where GitHub's file has
 * it (`githubSheet`): the caller records `headSha` as
 * read, which says D1 holds every row of its objects.csv. Image files with no
 * row are returned as pending, since giving them one needs a commit.
 *
 * The same ingest carries `image_available` recomputed against the tree read
 * here (`recomputedImages`), whatever the author selected; `appliedCount`
 * leaves it out, since the author was shown no such change.
 */
async function applyUnderLease(
  projectId: number,
  changes: SyncChanges,
  headSha: string,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  env: FullSyncEnv,
  userId: number,
): Promise<ObjectsSyncApplied> {
  const { newObjectIds, changedObjectIds, fieldChoices, removedObjectIds, unregisteredObjectIds } = changes;
  const { csvContent, tree, truncated, path: objectsPath } = await readObjectsAtHead(token, owner, repo, headSha);

  const d1Objects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, projectId));

  const parsedAsWritten = csvContent ? readRepoSheet(csvContent, objectsSheet(fileNameOf(objectsPath)), null) : [];
  const { parsed: parsedRows, mapped: repoRows, renames } = pairLegacyObjectIds(
    parsedAsWritten,
    csvContent ? mapObjectsCsv(parsedAsWritten, projectId) : [],
    d1Objects,
    (await applyLegacyEvidence(db, projectId, { token, owner, repo }, parsedAsWritten)).recordedIds,
  );
  const repoMap = new Map(repoRows.map((r) => [r.object_id as string, r]));
  const rawAltById = new Map(parsedRows.map((r) => [r.object_id ?? "", r.alt_text ?? ""]));

  const newRows = newObjectIds.flatMap((objectId) => {
    const repoRow = repoMap.get(objectId);
    return repoRow ? [pendingFromRepoRow(objectId, repoRow)] : [];
  });
  const pendingObjects = (unregisteredObjectIds ?? []).map((objectId) =>
    pendingFromImageFile(objectId),
  );

  // Accepted field changes, to the row the author reviewed. Default "d1" means
  // "leave D1 alone": a field absent from the choices map is not written
  // through. Writing the repo cell for every unlisted field would revert
  // unpublished editor edits and wipe IIIF-enriched columns whose repo cell is
  // blank.
  const notSent: string[] = [];
  const reviewedUpdates = changedObjectIds.flatMap((objectId) => {
    const repoRow = repoMap.get(objectId);
    if (!repoRow) return [];
    const row = reviewedObjectRow(d1Objects, objectId, changes.changedDocIds);
    if (!row) {
      notSent.push(objectId);
      return [];
    }
    const choices = ownValue(fieldChoices, objectId) ?? {};
    const fields: Partial<Record<SyncField, string | boolean | null>> = {};
    for (const field of SYNC_FIELDS) {
      if ((choices[field] ?? "d1") === "repo") {
        fields[field] = acceptedObjectValue(field, repoRow, rawAltById.get(objectId));
      }
    }
    return [{ objectId, docId: row.id, fields, ...seenFieldsOf(changes, objectId, fields) }];
  });
  // Recomputed whatever the author selected; left out of what the apply counts.
  const [config] = await db.select().from(project_config).where(eq(project_config.project_id, projectId)).limit(1);
  const d1Version = configFrameworkVersion(config);
  const reviewedAndRespelled = withGitHubSpelling(reviewedUpdates, renames);
  const recomputed = await recomputedImages(config, d1Objects, reviewedAndRespelled, { tree, truncated }, () =>
    siteVersionAtRef({ d1: d1Version }, token, owner, repo, headSha).catch(() => d1Version));
  const update = withRecomputedImages(reviewedAndRespelled, recomputed);

  // By the row's identity: D1 has no unique index on (project_id, object_id),
  // so the row the author was shown is found by key AND id, whatever other
  // rows share the key.
  const remove = removedObjectIds.flatMap((objectId) => {
    const docId = ownValue(changes.removedDocIds ?? {}, objectId);
    const d1Obj = d1Objects.find((o) => o.object_id === objectId && o.id === docId);
    if (!d1Obj || d1Obj.course_project_id != null || repoMap.has(objectId)) return [];
    return [{ objectId, docId: d1Obj.id }];
  });

  // GitHub's order is applied whatever the author ticked: the Compositor
  // cannot reorder objects, so there is no order of theirs to keep.
  const order = underSentSpelling(objectOrderChange(repoRows, d1Objects)?.order ?? [], update);
  // Under the lease and before the first write, the base the caller checked
  // before taking it (`refuseMovedObjectsBase`) is checked again: an apply
  // that landed in between has moved it.
  if (changes.baseSha !== undefined) await refuseMovedBase(db, projectId, changes.baseSha, "objects_read_sha");
  // An update whose row was re-created in the Compositor since the check
  // holds the whole apply back, as the collaboration object holds it back for
  // a row it finds re-created (`recreatedSinceReview`).
  const recreated = recreatedSinceReview(changes, notSent);
  if (recreated.length > 0) return objectsApplyHeldFor(recreated);
  // The accepted new rows travel in the same ingest, where GitHub's sheet has
  // them, so they land with the updates or not at all.
  const sheet = underSentSpelling(githubSheet(repoRows, d1Objects), update);
  const insert = toIngestInserts(inSheetOrder(newRows, sheet), userId).map(
    (entry): IngestObjectInsert => ({ ...entry, origin: "repo" }),
  );
  const answer = await ingestObjectChanges(env, projectId, { update, insert, remove, order, sheet });
  const heldBack = heldBackObjectsApply(answer);
  if (heldBack) return heldBack;
  const skippedUpdates = reviewedUpdates.filter((u) => answer.skipped.includes(u.objectId)).length;

  await writeMissingFromRepo(db, projectId, d1Objects, repoMap, new Set(remove.map((r) => r.docId)));
  const notAdded = settleSyncInserts(insert, answer);
  return {
    appliedCount: reviewedUpdates.length - skippedUpdates + remove.length,
    pendingObjects,
    // Anything the document could not take held the whole ingest back above.
    updateSkipped: false,
    notAdded,
    changedSinceReview: answer.changedSinceReview,
  };
}

/**
 * The objects apply's answer when the collaboration object held its ingest
 * back, having written nothing, or null when it did not
 * (`objectsApplyHeldFor`). An answer naming an object without saying it held
 * back is taken as held back too: the record must not move over it, and
 * nothing more is written. A hold naming no object throws `SyncBaseStale`.
 */
function heldBackObjectsApply(answer: ObjectsIngestAnswer): ObjectsSyncApplied | null {
  const named = objectsEditedSinceReview(answer);
  if (!answer.heldBack && named.length === 0) return null;
  if (named.length === 0) throw new SyncBaseStale();
  return objectsApplyHeldFor(named);
}

/**
 * The objects an ingest answered edited in the Compositor since the check: a
 * field changed (`changedSinceReview`), the row re-created (`superseded`), or
 * a new row's key taken (`insertsSkipped`).
 */
function objectsEditedSinceReview(answer: ObjectsIngestAnswer): string[] {
  return [...new Set([...answer.changedSinceReview, ...answer.superseded, ...answer.insertsSkipped])];
}

/**
 * The objects apply's answer for an apply held back for `objectIds`, edited in
 * the Compositor since the check: nothing applied, nothing registered, and the
 * record kept, so the next check offers GitHub's changes against them.
 */
function objectsApplyHeldFor(objectIds: string[]): ObjectsSyncApplied {
  return { appliedCount: 0, pendingObjects: [], updateSkipped: true, notAdded: [], changedSinceReview: objectIds };
}

/**
 * Of the accepted updates not sent (`notSent`), those whose choice names the
 * D1 id the author was shown: that row no longer holds the key, so the object
 * was re-created in the Compositor since the check. A choice naming no id is
 * an older page's, and the apply is refused as stale (`SyncBaseStale`).
 */
function recreatedSinceReview(changes: SyncChanges, notSent: readonly string[]): string[] {
  const named = notSent.filter((objectId) => ownValue(changes.changedDocIds ?? {}, objectId) !== undefined);
  if (named.length < notSent.length) throw new SyncBaseStale();
  return named;
}

/**
 * The accepted new rows an objects ingest that was not held back did not add
 * to D1, by object_id: those D1 refused after the document took them, found
 * only once the write is made, and any the ingest's boundary refused, which
 * `entriesRefusal` refuses whole before here. Each entry carries the repo as
 * its origin, so a row that lands at a later snapshot has it too.
 */
function settleSyncInserts(insert: IngestObjectInsert[], answer: ObjectsIngestAnswer): string[] {
  return [
    ...answer.insertsFailed,
    ...answer.insertsRefusedAt.flatMap((position) => insert[position]?.object_id ?? []),
  ];
}

/**
 * The D1 row an accepted object update names: the one holding `objectId` with
 * the id the author was shown in `docIds`. None when that row no longer holds
 * the key, or when the choice names no id. D1 has no unique index on
 * (project_id, object_id), so the row is found by key AND id.
 */
function reviewedObjectRow<T extends { id: number; object_id: string }>(
  d1Objects: T[],
  objectId: string,
  docIds: Record<string, number> | undefined,
): T | undefined {
  const docId = ownValue(docIds ?? {}, objectId);
  return docId === undefined ? undefined : d1Objects.find((o) => o.object_id === objectId && o.id === docId);
}

/**
 * One repo row as a pending object, with the repo as its origin. It is not
 * ready: the Objects page marks it (`probe-tiles`).
 */
function pendingFromRepoRow(
  objectId: string,
  repoRow: Record<string, unknown>,
): PendingObject {
  return {
    object_id: objectId,
    title: (repoRow.title as string | null) ?? null,
    featured: Boolean(repoRow.featured),
    creator: (repoRow.creator as string | null) ?? null,
    description: (repoRow.description as string | null) ?? null,
    source_url: (repoRow.source_url as string | null) ?? null,
    period: (repoRow.period as string | null) ?? null,
    year: (repoRow.year as string | null) ?? null,
    object_type: (repoRow.object_type as string | null) ?? null,
    subjects: (repoRow.subjects as string | null) ?? null,
    source: (repoRow.source as string | null) ?? null,
    credit: (repoRow.credit as string | null) ?? null,
    thumbnail: (repoRow.thumbnail as string | null) ?? null,
    alt_text: (repoRow.alt_text as string | null) ?? null,
    dimensions: (repoRow.dimensions as string | null) ?? null,
    extra_columns: (repoRow.extra_columns as string | null) ?? null,
    image_available: false,
    origin: "repo",
  };
}

/**
 * An image file in the repository with no row, as a pending object under the
 * file's stem, not yet ready: the Objects page marks it (`probe-tiles`).
 */
function pendingFromImageFile(objectId: string): PendingObject {
  return {
    object_id: objectId,
    title: null,
    featured: false,
    creator: null,
    description: null,
    source_url: null,
    period: null,
    year: null,
    object_type: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    image_available: false,
    origin: "repo",
  };
}

/**
 * GitHub's objects rows, parsed (`parsed`) and mapped (`mapped`), with each id
 * an earlier import stored stripped written as D1 holds it
 * (`legacyStrippedIds`), so that every comparison with D1 pairs the two; and,
 * by D1 row id, GitHub's spelling of each such row, which an accepted update
 * gives it.
 */
function pairLegacyObjectIds<P extends { object_id?: unknown }, R extends { object_id?: unknown }>(
  parsed: readonly P[],
  mapped: readonly R[],
  d1Objects: ReadonlyArray<{ id: number; object_id: string }>,
  recordedIds: readonly string[] | null,
): { parsed: P[]; mapped: R[]; renames: Map<number, LegacyRespelling> } {
  const renames = legacyRespellings(mapped.map((r) => String(r.object_id ?? "")), d1Objects, recordedIds);
  const pairs = new Map([...renames.values()].map((r) => [r.githubId, r.objectId]));
  return { parsed: onD1Spelling(parsed, pairs), mapped: onD1Spelling(mapped, pairs), renames };
}

/**
 * The object ids a recorded version of objects.csv writes, as written: none
 * where that version had no objects.csv (null), and null where there is no
 * recorded version (undefined) or its id column cannot be placed. The evidence
 * `legacyStrippedIds` reads.
 */
function recordedObjectIds(content: string | null | undefined): string[] | null {
  if (content === undefined) return null;
  if (content === null) return [];
  const sheet = readBaseSheet(content, objectsSheet());
  if (baseRowsUnknown(sheet, "object_id")) return null;
  return sheet.rows.map((row) => row.object_id ?? "").filter((id) => pythonStrip(id) !== "");
}

/** What legacy pairing is judged by: the recorded ids, and whether they could be read. */
interface LegacyEvidence {
  /** The ids the record writes, as written; null for none, which pairs nothing. */
  recordedIds: string[] | null;
  /** True when a GitHub id is padded and the record could not be read. */
  unjudged: boolean;
}

const NO_LEGACY_EVIDENCE: LegacyEvidence = { recordedIds: null, unjudged: false };

/**
 * objects.csv at `ref`, the commit legacy pairing is judged against, read only
 * when some GitHub id is padded: no other id can name a row an import stored
 * stripped. `ref` undefined asks for no pairing; null is a project with no
 * such commit, which, like a record that cannot be read, leaves the ids
 * unjudged.
 */
async function legacyEvidence(
  access: { token: string; owner: string; repo: string },
  repoRows: ReadonlyArray<{ object_id?: unknown }>,
  ref: string | null | undefined,
): Promise<LegacyEvidence> {
  if (ref === undefined || !hasPaddedId(repoRows.map((row) => row.object_id))) return NO_LEGACY_EVIDENCE;
  const content = ref === null ? undefined : await legacyRecordContent(access, ref);
  const recordedIds = recordedObjectIds(content);
  return { recordedIds, unjudged: recordedIds === null };
}

/**
 * objects.csv at `ref`, read only to judge legacy ids: undefined where the read
 * fails, which leaves the ids unjudged rather than refusing. A read that is
 * also a three-way base is made, and refused, by the base's own reader
 * (`readBaseFiles`, `objectsBaseAt`) before this one.
 */
async function legacyRecordContent(
  access: { token: string; owner: string; repo: string },
  ref: string,
): Promise<string | null | undefined> {
  try {
    return await objectsBaseAt(access.token, access.owner, access.repo, ref);
  } catch {
    return undefined;
  }
}

/**
 * `legacyEvidence` for an apply, which reads the project's record itself
 * (`legacyPairingRef`), and only when some GitHub id is padded.
 */
async function applyLegacyEvidence(
  db: ReturnType<typeof getDb>,
  projectId: number,
  access: { token: string; owner: string; repo: string },
  repoRows: ReadonlyArray<{ object_id?: unknown }>,
): Promise<LegacyEvidence> {
  if (!hasPaddedId(repoRows.map((row) => row.object_id))) return NO_LEGACY_EVIDENCE;
  return legacyEvidence(access, repoRows, await legacyPairingRef(db, projectId));
}

/**
 * An objects update the author reviewed, by D1 id. `image_available` is never
 * a sync field the author sees; it rides on the entry only as a recomputed
 * value (`withRecomputedImages`).
 */
interface ReviewedObjectUpdate {
  objectId: string; docId: number; fields: Partial<Record<SyncField | "image_available", string | boolean | null>>; renameTo?: string;
  /** Each field's value as the check read it (`SyncChanges.fieldsSeen`); see `seenFieldsOf`. */
  seen?: Partial<Record<SyncField | "image_available", string | boolean | null>>;
}

/**
 * `image_available` recomputed by the tiler's rule (`recomputedImages`). By
 * key alone where D1 holds one row under the key: the value follows from the
 * key, so no re-created row can make it the wrong one, and a row the document
 * no longer holds is skipped. By D1 id where rows share the key, since an
 * entry by key reaches only the first document row holding it.
 */
interface RecomputedImageUpdate {
  objectId: string;
  docId?: number;
  fields: ReviewedObjectUpdate["fields"] & { image_available: boolean };
  seen: { image_available: boolean };
}

type ObjectUpdateEntry = ReviewedObjectUpdate;

/**
 * `image_available` by the tiler's rule (`tiledFromFiles`) against the tree an
 * apply read at its head, for each self-hosted image D1 holds with the other
 * value, each row by the source the apply leaves it with (`update`'s accepted
 * `source_url`, else D1's), with D1's value as `seen`: the collaboration
 * object writes it only where the document still holds that value. Only on a
 * site with no base the tile probe may ask, by the config the apply leaves,
 * whose readiness the repository decides (`readyTilesForProject`); on a site
 * the probe asks, readiness is the deployed site's tiles, and only the probe
 * marks or unmarks an object. A truncated tree unmarks nothing, since a file
 * it leaves out is not proven absent. The version is read only when there is
 * an image to judge.
 */
async function recomputedImages(
  config: { url?: string | null; baseurl?: string | null } | undefined,
  d1Objects: ReadonlyArray<{ id: number; object_id: string; source_url: string | null; image_available: boolean | null }>,
  update: readonly ReviewedObjectUpdate[],
  read: { tree: TreeEntry[]; truncated: boolean },
  siteVersion: () => Promise<string | null>,
): Promise<Array<{ rowId: number; entry: RecomputedImageUpdate }>> {
  const base = configSiteBase(config);
  if (base && isSafeSiteBase(base)) return [];
  const sourceOf = (row: { id: number; source_url: string | null }): string | null => {
    const fields = update.find((u) => u.docId === row.id)?.fields;
    if (!fields || !Object.hasOwn(fields, "source_url")) return row.source_url;
    return typeof fields.source_url === "string" ? fields.source_url : null;
  };
  const images = d1Objects.filter((o) => isTiledImage(o.object_id, sourceOf(o)));
  if (images.length === 0) return [];
  const version = await siteVersion();
  const stems = tileableStems(read.tree, version);
  const shared = (key: string) => d1Objects.filter((o) => o.object_id === key).length > 1;
  return images.flatMap((o) => {
    const tiled = tiledFromFiles(stems, o.object_id, version);
    const stored = o.image_available === true;
    if (tiled === stored || (read.truncated && !tiled)) return [];
    const entry = {
      objectId: o.object_id, ...(shared(o.object_id) ? { docId: o.id } : {}),
      fields: { image_available: tiled }, seen: { image_available: stored },
    };
    return [{ rowId: o.id, entry }];
  });
}

/** `update` with each recomputed value on the reviewed entry for its row, or on an entry of its own. */
function withRecomputedImages(
  update: ReviewedObjectUpdate[],
  recomputed: ReadonlyArray<{ rowId: number; entry: RecomputedImageUpdate }>,
): Array<ReviewedObjectUpdate | RecomputedImageUpdate> {
  const merged = update.map((entry) => ({ ...entry, fields: { ...entry.fields } }));
  const own: RecomputedImageUpdate[] = [];
  for (const { rowId, entry } of recomputed) {
    const reviewed = merged.find((u) => u.docId === rowId);
    if (!reviewed) own.push(entry);
    else {
      reviewed.fields.image_available = entry.fields.image_available;
      reviewed.seen = { ...reviewed.seen, image_available: entry.seen.image_available };
    }
  }
  return [...merged, ...own];
}

/**
 * `update` with every row `renames` names given GitHub's spelling: on the
 * update already sent for it, or on an update of its own carrying no field.
 * The respelling is the repair of an old import's error, so it is sent
 * whatever the author chose.
 */
function withGitHubSpelling(
  update: ObjectUpdateEntry[],
  renames: ReadonlyMap<number, LegacyRespelling>,
): ObjectUpdateEntry[] {
  const respelled = update.map((entry) => {
    const rename = renames.get(entry.docId);
    return rename === undefined ? entry : { ...entry, renameTo: rename.githubId };
  });
  const sent = new Set(update.map((entry) => entry.docId));
  for (const rename of renames.values()) {
    if (!sent.has(rename.docId)) respelled.push(respellingUpdate(rename));
  }
  return respelled;
}

/**
 * Run the sync check an author started, and repair the project's ids once.
 *
 * While the project's `legacy_ids_repaired_at` is NULL (`legacy.open`), the
 * check pairs the ids an earlier import stored stripped with GitHub's padded
 * spelling, judged against the commit whose object rows D1 accounts for
 * (`legacy.ref`, `legacyRecordRef`) as it stands, gives those rows GitHub's
 * spelling (`respellLegacyObjectIds`), sets the column, and runs the check
 * again without pairing, so what the author is shown is against the repaired
 * rows. With nothing to repair the column is set all the same. It is not set
 * where GitHub writes a padded id and that commit could not be read
 * (`legacyUnjudged`): the ids have not been judged. A repair that did not land
 * sets nothing and answers the first check, whose `respelled` then keeps the
 * head from being recorded. Once the column is set, the check runs without
 * pairing.
 */
export async function checkRepairingLegacyIds<T>(
  env: FullSyncEnv,
  projectId: number,
  userId: number,
  run: (legacyRef: string | null | undefined) => Promise<T>,
  legacyOf: (diff: T) => Pick<SyncDiff, "respelled" | "legacyUnjudged">,
  legacy: { db: ReturnType<typeof getDb>; open: boolean; ref: string | null },
): Promise<T> {
  if (!legacy.open) return run(undefined);
  const first = await run(legacy.ref);
  const { respelled = [], legacyUnjudged } = legacyOf(first);
  if (legacyUnjudged) return first;
  if (respelled.length === 0) {
    await markLegacyIdsRepaired(legacy.db, projectId);
    return first;
  }
  if (!(await respellLegacyObjectIds(env, projectId, userId, respelled))) return first;
  await markLegacyIdsRepaired(legacy.db, projectId);
  return run(undefined);
}

/**
 * Give each row of `respelled` GitHub's spelling of its id, and nothing else,
 * through the collaboration object under the objects lease, as every objects
 * write through the document is. The repair a check makes silently: the
 * author is offered nothing, and the next publish writes the padded id.
 * Answers true when every row took it; false when the lease was held
 * elsewhere, or a row was re-created or deleted since the check.
 */
export async function respellLegacyObjectIds(
  env: FullSyncEnv,
  projectId: number,
  userId: number,
  respelled: readonly LegacyRespelling[],
): Promise<boolean> {
  if (respelled.length === 0) return true;
  const held = await holdOperationLease(
    env as unknown as Env, projectId, userId, "objects",
    async (landed) => {
      const sent = await sendRespellings(env, projectId, respelled);
      landed();
      return sent;
    },
  );
  return !held.refused && held.value;
}

/**
 * Placement entries (`objects.order`, `objects.sheet`) naming a row an update
 * of the same ingest renames, under the new key: the document applies the
 * updates first, and finds a row by key and id.
 */
function underSentSpelling<T extends { objectId: string; docId?: number }>(
  entries: T[],
  update: ReadonlyArray<{ objectId: string; docId?: number; renameTo?: string }>,
): T[] {
  const renamed = new Map(update.flatMap((u) => (u.renameTo === undefined || u.docId === undefined ? [] : [[u.docId, u.renameTo] as const])));
  if (renamed.size === 0) return entries;
  return entries.map((entry) => {
    const renameTo = entry.docId === undefined ? undefined : renamed.get(entry.docId);
    return renameTo === undefined ? entry : { ...entry, objectId: renameTo };
  });
}

/** The objects arm's `order` and `sheet` under the spelling its updates give (`underSentSpelling`). */
function respellPlacement(arm: SyncIngestPayload["objects"]): void {
  if (arm.order) arm.order = underSentSpelling(arm.order, arm.update);
  if (arm.sheet) arm.sheet = underSentSpelling(arm.sheet, arm.update);
}

/** What an objects ingest answered, by object_id (`objectChangesAnswer`). */
interface ObjectsIngestAnswer {
  skipped: string[];
  /** Inserts skipped because a row holds the key: an object made in the Compositor since the check. */
  insertsSkipped: string[];
  /** Inserts D1 refused after the document took them. */
  insertsFailed: string[];
  /** Inserts the ingest's boundary refused, by position in the arm sent. */
  insertsRefusedAt: number[];
  superseded: string[];
  changedSinceReview: string[];
  /** Whether the collaboration object held the ingest back whole, writing nothing (`allOrNothing`). */
  heldBack: boolean;
}

/**
 * Send one objects ingest, all or nothing (`allOrNothing`), and answer the
 * object_ids of the updates the document skipped, and of the updates and order
 * entries it skipped because another object holds the key (`superseded`). An
 * arm with nothing in it sends nothing. A non-200 answer throws.
 */
async function ingestObjectChanges(
  env: FullSyncEnv,
  projectId: number,
  arm: {
    update: SyncIngestPayload["objects"]["update"];
    insert: IngestObjectInsert[];
    remove: Array<{ objectId: string; docId: number }>;
    order: Array<{ objectId: string; docId: number }>;
    /** GitHub's sheet, which places the inserts; sent only with them. */
    sheet?: SheetEntry[];
  },
): Promise<ObjectsIngestAnswer> {
  if ([arm.update, arm.insert, arm.remove, arm.order].every((entries) => entries.length === 0)) {
    return objectChangesAnswer({});
  }
  const { order, sheet, ...rest } = arm;
  const objectsArm = { ...rest, ...(order.length > 0 ? { order } : {}), ...(arm.insert.length > 0 ? { sheet } : {}) };
  const answer = await postObjectsIngest(env, projectId, objectsArm);
  const refusal = entriesRefusal(answer);
  if (refusal) throw refusal;
  return objectChangesAnswer(answer);
}

/**
 * The refusal for an ingest that names entries it cannot store: refused as
 * malformed at its boundary, or an insert over D1's row size. Under
 * `allOrNothing` the collaboration object holds the ingest back for them,
 * writing nothing; an answer naming any is refused whether or not it says it
 * held back, so the record does not move over it. Null when it names none.
 */
function entriesRefusal(answer: IngestSyncAnswer): SyncEntriesRefused | null {
  const refused = Object.fromEntries(
    Object.entries(answer.refused ?? {}).filter(([, positions]) => Array.isArray(positions) && positions.length > 0),
  );
  const oversized = ingestList(answer.oversized, "objectInsert");
  if (Object.keys(refused).length === 0 && oversized.length === 0) return null;
  return new SyncEntriesRefused(refused, oversized);
}

/** Post one ingest holding only an objects arm, and answer its body. A non-200 answer throws. */
async function postObjectsIngest(env: FullSyncEnv, projectId: number, objectsArm: object): Promise<IngestSyncAnswer> {
  const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
  const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
  const res = await stub.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ objects: objectsArm, allOrNothing: true }),
    }),
  );
  if (!res.ok) throw new Error(`ingest-sync failed: DO returned ${res.status}`);
  return (await res.json().catch(() => ({}))) as IngestSyncAnswer;
}

/**
 * The updates an objects ingest skipped, the updates, order entries and
 * removals it answered superseded, the updates with a field it left because
 * the Compositor's value changed since the check, and whether it held the
 * ingest back whole.
 */
function objectChangesAnswer(answer: IngestSyncAnswer): ObjectsIngestAnswer {
  return {
    skipped: ingestList(answer.skipped, "objectUpdate"),
    superseded: [
      ...ingestList(answer.superseded, "objectUpdate"),
      ...ingestList(answer.superseded, "objectOrder"),
      ...ingestList(answer.removals, "superseded"),
    ],
    changedSinceReview: ingestList(answer.changedSinceReview, "objectUpdate"),
    heldBack: answer.heldBack === true,
    insertsSkipped: ingestList(answer.skipped, "objectInsert"),
    insertsFailed: ingestList(answer.failed, "objectInsert"),
    insertsRefusedAt: ingestList(answer.refused, "objectInsert"),
  };
}

/** One list of an ingest's answer, empty where the answer names none. */
function ingestList<T>(group: Partial<Record<string, T[]>> | undefined, key: string): T[] {
  return group?.[key] ?? [];
}

/**
 * `seen` for one object's update: the value the check read for each field
 * sent (`SyncChanges.fieldsSeen`), or nothing where the choice carries none.
 */
function seenFieldsOf(
  changes: SyncChanges,
  objectId: string,
  fields: Partial<Record<SyncField, string | boolean | null>>,
): { seen?: Partial<Record<SyncField, string | boolean | null>> } {
  const shown = ownValue(changes.fieldsSeen ?? {}, objectId);
  if (!shown) return {};
  const seen = Object.fromEntries(
    Object.keys(fields).filter((field) => Object.hasOwn(shown, field)).map((field) => [field, shown[field]]),
  );
  return Object.keys(seen).length > 0 ? { seen } : {};
}

/**
 * `missing_from_repo`, which only D1 holds, decided and written per row: set
 * for a row whose key is absent from the repo and which was not removed (a
 * compositor-origin row is not a repo object and is never flagged), cleared
 * for one whose key is present again. Per row id rather than per key, since
 * two rows can share a key and each has its own origin.
 */
async function writeMissingFromRepo(
  db: ReturnType<typeof getDb>,
  projectId: number,
  d1Objects: Array<typeof objects.$inferSelect>,
  repoMap: Map<string, Record<string, unknown>>,
  removedRowIds: Set<number>,
): Promise<void> {
  const now = new Date().toISOString();
  for (const row of d1Objects) {
    const present = repoMap.has(row.object_id);
    const flag = !present && !removedRowIds.has(row.id) && row.origin !== "compositor";
    const clear = present && Boolean(row.missing_from_repo);
    if (!flag && !clear) continue;
    await db
      .update(objects)
      .set({ missing_from_repo: flag, updated_at: now })
      .where(and(eq(objects.project_id, projectId), eq(objects.id, row.id)));
  }
}

// ===========================================================================
// Full Sync — stories, steps, and config
// ===========================================================================

// ---------------------------------------------------------------------------
// Full Sync Types
// ---------------------------------------------------------------------------

export interface StorySyncItem {
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  order: number;
  isPrivate: boolean;
  showSections: boolean;
  /** The row's custom project.csv columns as the stored JSON blob; "" when it has none. */
  extraColumns: string;
  /**
   * Three-way only, on newStories entries. True when the story is present in
   * the base and absent from D1 with a repo row that DIFFERS from the base —
   * deleted here, edited there. A pure editor deletion (repo row identical to
   * base) is suppressed instead. The modal offers restore vs keep-deleted,
   * default keep-deleted, and buildThreeWayChanges inserts it only when restore
   * is chosen.
   */
  deletedInCompositor?: boolean;
}

/** A mapped project.csv row in the shape the story diff compares. */
function toStoryItem(r: Record<string, unknown>): StorySyncItem {
  return {
    story_id: r.story_id as string,
    title: (r.title as string | null | undefined) ?? null,
    subtitle: (r.subtitle as string | null | undefined) ?? null,
    byline: (r.byline as string | null | undefined) ?? null,
    order: (r.order as number) ?? 0,
    isPrivate: Boolean(r.private),
    showSections: Boolean(r.show_sections),
    extraColumns: (r.extra_columns as string | null | undefined) ?? "",
  };
}

/**
 * A story field as the diff compares it. `extraColumns` is compared parsed and
 * key-sorted, never as the raw JSON string, so a blob reserialised in another
 * key order is not a change. The displayed values stay raw.
 */
function storyFieldStr(item: StorySyncItem, field: keyof StorySyncItem): string {
  return field === "extraColumns" ? canonicalExtraColumns(item.extraColumns) : String(item[field] ?? "");
}

/**
 * One row's differing fields classified against the recorded sync base, as
 * objects are (`computeSyncDiff`): GitHub's (`changedFields`), both sides'
 * (`conflictFields`, a subset), or the Compositor's alone, which is left out
 * and only noted (`editorOnly`). `base` is null where there is nothing to
 * compare with (two-way mode, a row absent from the base), and every
 * differing field is then GitHub's; `unplaced` names a field the base cannot
 * place, which is a conflict whichever side moved it.
 */
function rowFieldsAgainstBase<F extends string>(
  fields: readonly F[],
  repoStr: (field: F) => string,
  d1Str: (field: F) => string,
  base: ((field: F) => string) | null,
  unplaced: (field: F) => boolean,
): { changedFields: F[]; conflictFields: F[]; editorOnly: boolean } {
  const changedFields: F[] = [];
  const conflictFields: F[] = [];
  let editorOnly = false;
  for (const field of fields) {
    const repo = repoStr(field);
    const d1 = d1Str(field);
    if (repo === d1) continue;
    const held = unplaced(field) || base === null ? null : base(field);
    if (held === repo) {
      editorOnly = true;
      continue;
    }
    changedFields.push(field);
    if (unplaced(field) || (held !== null && held !== d1)) conflictFields.push(field);
  }
  return { changedFields, conflictFields, editorOnly };
}

export interface StorySyncChangedItem {
  story_id: string;
  title: string | null;
  /**
   * The fields GitHub moved off the base (every differing field in two-way
   * mode). A field only the Compositor moved is never listed, and the accept
   * writes only listed fields (`rowFieldsAgainstBase`).
   */
  changedFields: string[];
  /** The subset of `changedFields` both sides moved; the row's one choice covers them. */
  conflictFields: string[];
  /**
   * Three-way only. True when `conflictFields` is not empty. The modal shows
   * the repo/Compositor value pairs (`repoValues`/`d1Values`, keyed by the
   * StorySyncItem field) and defaults to keep-mine. Always false in two-way
   * fallback mode.
   */
  conflict: boolean;
  /** A conflict whose default is GitHub's row: the base could not say which side changed it (`BaseSheet`). */
  repoByDefault?: boolean;
  d1Values: Partial<Record<keyof StorySyncItem, string | boolean>>;
  repoValues: Partial<Record<keyof StorySyncItem, string | boolean>>;
}

export interface StorySyncDiff {
  newStories: StorySyncItem[];
  changedStories: StorySyncChangedItem[];
  missingStories: Array<{ story_id: string; title: string | null }>;
  /**
   * The stories whose step or layer files differ (checkStoryContent), or why
   * the trees could not settle it. Absent from a diff built without the
   * story-file check.
   */
  content?: StoryContentCheck;
}

export interface ConfigSyncDiff {
  changedFields: Array<{
    key: string;
    d1Value: string | null;
    repoValue: string | null;
    /**
     * Three-way only. True when the repo AND D1 both moved this key off the
     * base. Repo-only keys carry false and are pre-accepted; editor-only keys
     * are suppressed upstream. Always false in two-way fallback mode.
     */
    conflict: boolean;
  }>;
  /** Set when repo telar.version differs from D1 telar_version. */
  versionChange: {
    direction: "ahead" | "behind";
    repoVersion: string;
    d1Version: string | null;
  } | null;
}

export interface GlossarySyncDiff {
  /** The glossary sheet's name when its misread headings differ from the base's (`headingsMoved`). */
  headingFile?: string;
  /** Terms in the repo CSV that are not in D1 */
  added: Array<{
    term_id: string;
    title: string;
    definition: string;
    related_terms: string;
    /** The kind as the repo row writes it; "" when none. */
    kind?: string;
    /** Raw custom-column blob as the repo row spells it; "" when none. */
    extra_columns: string;
    /**
     * Three-way only. True when the term is in the base and the repo row
     * DIFFERS from the base — deleted here, edited there. A pure editor
     * deletion (repo row identical to base) is suppressed instead. The modal
     * offers restore vs keep-deleted, default keep-deleted.
     */
    deletedInCompositor?: boolean;
  }>;
  /** Terms in D1 that are not in the repo CSV */
  removed: Array<{ term_id: string; title: string; dbId: number }>;
  /** Terms in both but with a differing title, definition, or related_terms */
  changed: Array<{
    term_id: string;
    title: string;
    dbId: number;
    d1Title: string;
    repoTitle: string;
    d1Definition: string;
    repoDefinition: string;
    d1RelatedTerms: string;
    repoRelatedTerms: string;
    d1Kind?: string;
    repoKind?: string;
    /**
     * The custom-column blobs, raw on both sides: the diff decides whether they
     * differ from the canonical (keys-sorted) forms, but shows what is stored.
     */
    d1ExtraColumns: string;
    repoExtraColumns: string;
    /** The fields GitHub moved off the base, as for a story (`StorySyncChangedItem`). */
    changedFields: GlossarySyncField[];
    /** The subset of `changedFields` both sides moved; the term's one choice covers them. */
    conflictFields: GlossarySyncField[];
    /** Three-way only. True when `conflictFields` is not empty. Always false in two-way fallback mode. */
    conflict: boolean;
    /** A conflict whose default is GitHub's term: the base could not say which side changed it (`BaseSheet`). */
    repoByDefault?: boolean;
  }>;
  /**
   * Three-way only. Count of editor-only glossary changes suppressed from this
   * diff (editor-only term edits, editor deletions, editor creations).
   * Undefined in two-way mode; folded into FullSyncDiff.suppressedEditorOnly.
   */
  suppressedEditorOnly?: number;
}

export interface FullSyncDiff {
  objects: SyncDiff;
  stories: StorySyncDiff;
  config: ConfigSyncDiff;
  glossary: GlossarySyncDiff;
  /**
   * The pages whose file changed on GitHub (checkPageContent), or why the
   * page files could not be read to a conclusion. Absent from a diff built
   * without the page-file check.
   */
  pages?: PageContentCheck;
  /**
   * True when the three-way diff found at least one conflict — a field or row
   * that both the repo and the editor moved off the base to different values,
   * or an object/term the editor deleted while GitHub edited it. Always false
   * in two-way fallback mode (no base to classify against). The modal reads it
   * to decide whether to render the conflicts block; `aggregateSyncDiff`
   * deliberately ignores it, so wiring it truthfully changes no diff-chip
   * count (see site-status-diff.ts and its pin test).
   */
  hasConflicts: boolean;
  /**
   * Which comparison produced this diff. "three-way" means the base (repo
   * files at `head_sha`) was available and editor-only changes were
   * suppressed / conflicts surfaced. "two-way" is the fallback (base
   * unavailable): today's repo-vs-D1 diff with no suppression and no conflict
   * markers.
   */
  classification: "three-way" | "two-way";
  /**
   * Three-way only. Count of editor-only changes suppressed from this diff
   * (object/config fields, story/glossary rows, and suppressed
   * editor-deletions / editor-creations) — feeds the modal's "N unpublished
   * changes left untouched" note. Always 0 in two-way mode.
   */
  suppressedEditorOnly: number;
  /**
   * The HEAD commit every read of this diff was pinned to: what an accept of
   * it pins to, so a commit landing after the check is not taken as read.
   */
  headSha?: string;
  /**
   * The project this diff was computed for. A choice made over it (Keep my
   * version, an apply) posts it back, so it is never taken as another
   * project's, whatever the session has switched to since.
   */
  projectId?: number;
  /**
   * The head_sha this diff was computed against, null when there was none.
   * A choice made over it holds only while head_sha is still this commit: a
   * head recorded since makes the diff describe something no longer there.
   */
  baseSha?: string | null;
  /**
   * What the reads of the repository at `headSha` found wrong: every sheet,
   * the step files the story check read, and the tree. Nothing read at the
   * base is reported, since the base is the state last reconciled with and
   * not what the author now has. Absent from a diff built by hand.
   */
  warnings?: SheetWarning[];
  /**
   * The files read at `headSha` whose bytes are not valid UTF-8, by the name
   * the author sees, filled whether or not `warnings` are collected. The site
   * does not build such a file as GitHub has it, so `hasDivergentChanges`
   * counts them: the status refresh, which shows no warnings, then does not
   * record the head, and the author's sync names the file.
   */
  unreadableFiles: string[];
  /**
   * The objects, project and glossary sheets, by file name, whose misread
   * headings at the head differ from the base's. A heading-only edit leaves D1
   * equal to the repository's parse, so `hasDivergentChanges` counts these
   * (the status refresh then does not record the head) and `hasDiffChanges`
   * does not (the dashboard check records it once the author has seen the
   * warning). Absent from a diff built by hand.
   */
  headingFiles?: string[];
}

/**
 * True when a FullSyncDiff contains any compositor-relevant divergence: objects,
 * stories, config fields, glossary entries, story or page files, a repo↔D1
 * version change, or a file read at the head whose bytes are not valid UTF-8. Used by
 * the _app loader to decide whether to raise the sync-divergence banner when
 * repo HEAD differs from the last known SHA — without this, a churn-only commit
 * would nag the user unnecessarily.
 */
export function hasDivergentChanges(diff: FullSyncDiff): boolean {
  return (
    objectsDiverge(diff.objects) ||
    diff.stories.newStories.length > 0 ||
    diff.stories.changedStories.length > 0 ||
    diff.stories.missingStories.length > 0 ||
    diff.config.changedFields.length > 0 ||
    diff.config.versionChange !== null ||
    diff.glossary.added.length > 0 ||
    diff.glossary.changed.length > 0 ||
    diff.glossary.removed.length > 0 ||
    filesDiverge(diff)
  );
}

/**
 * Whether the files read at the head make the site divergent: a story or
 * page file check that could not conclude or lists a change, a page file on
 * one side only, or a file whose bytes are not valid UTF-8, or a sheet whose misread headings moved.
 */
function filesDiverge(diff: FullSyncDiff): boolean {
  return (
    fileCheckDiverges(diff.stories.content) || fileCheckDiverges(diff.pages) || pageFilesListed(diff.pages) ||
    diff.unreadableFiles.length > 0 ||
    (diff.headingFiles?.length ?? 0) > 0
  );
}

/** Whether a concluded page check lists a page file on one side only, or a page GitHub added. */
function pageFilesListed(pages: PageContentCheck | undefined): boolean {
  return pages?.conclusive === true && ((pages.files?.length ?? 0) > 0 || (pages.additions?.length ?? 0) > 0);
}

/**
 * Whether the objects part of a diff makes the site divergent: a row new,
 * changed or missing, an image file with no row, GitHub's order of the rows
 * both sides hold, or a row D1 still holds under the stripped form of GitHub's
 * padded id (`respelled`). The last is never recorded as read: a publish would
 * write D1's stripped id over GitHub's, and only the author's sync, whose check
 * repairs it, may record that head.
 */
function objectsDiverge(objectsDiff: SyncDiff): boolean {
  const listed = [
    objectsDiff.newObjects, objectsDiff.changedObjects, objectsDiff.missingObjects, objectsDiff.unregisteredFiles,
  ];
  return objectsDiff.reordered != null || objectsDiff.respelled !== undefined || listed.some((list) => list.length > 0);
}

/** A story or page file check, as `hasDivergentChanges` reads it. */
type FileCheck = { conclusive: true; changes: readonly unknown[] } | { conclusive: false };

/**
 * Whether a file check makes the site divergent: it could not read the files
 * to a conclusion, or it lists a change. A diff built without the check has
 * none, which says nothing.
 */
function fileCheckDiverges(check: FileCheck | undefined): boolean {
  if (check === undefined) return false;
  return !check.conclusive || check.changes.length > 0;
}

/** Whether a file check lists a change both sides made. */
function fileCheckConflicts(check: { conclusive: true; changes: ReadonlyArray<{ kind: string }> } | { conclusive: false }): boolean {
  return check.conclusive && check.changes.some((c) => c.kind === "conflict");
}

export interface FullSyncChanges {
  objects: SyncChanges;
  /**
   * story_ids where user accepted repo changes (update D1 to repo values).
   * `acceptContent` is the stories whose step and layer content the user
   * accepted from HEAD (StorySyncDiff.content); read by the accept.
   */
  stories: {
    accept: string[]; reject: string[]; insertNew: string[]; acceptContent?: string[];
    /** Per accepted story, per field: "repo" writes GitHub's value; any other field is left alone. */
    fieldChoices?: Record<string, Record<string, "repo" | "d1">>;
    /**
     * Per story in `acceptContent`, the `expected` hash the check recorded
     * (StoryContentChange.expected). The collaboration object refuses the
     * story when its live content no longer hashes to it.
     */
    contentExpected?: Record<string, string>;
  };
  /** config field keys where user accepted repo changes */
  config: { accept: string[]; reject: string[] };
  /** term_ids where user accepted repo changes, with per-field choices as for stories */
  glossary: {
    accept: string[]; reject: string[]; insertNew: string[];
    fieldChoices?: Record<string, Record<string, "repo" | "d1">>;
  };
  /**
   * The HEAD commit the check read. Every read of the accept is at this
   * commit, and head_sha advances to it and no later. Absent, the accept
   * resolves HEAD once, before its first read.
   */
  headSha?: string;
  /**
   * The project and the base of the check the dialog showed
   * (`FullSyncDiff.projectId`, `.baseSha`). The apply is refused unless the
   * project is the one it runs for and head_sha is still the base.
   */
  projectId?: number;
  baseSha?: string | null;
  /**
   * True when the check the dialog showed read the story files to a
   * conclusion (`stories.content.conclusive`), so the stories it listed are
   * all the story changes there are. Anything but `true`, absence included,
   * keeps head_sha.
   */
  storyContentChecked?: boolean;
  /**
   * The pages whose file the author took GitHub's version of
   * (FullSyncDiff.pages), each with the slug of the file the check read and
   * the `expected` hash it recorded (PageContentChange). The collaboration
   * object refuses a page whose live content no longer hashes to it.
   */
  pages?: {
    acceptContent: Array<{ pageId: number; slug: string; expected: string }>;
    /**
     * The page files on one side only the author chose to follow GitHub on
     * (`PageContentCheck.files`). Additions are never named here: the accept
     * takes them from its own check.
     */
    takeFiles?: PageFileTake[];
    /** The file names of the additions the dialog showed, compared with the accept's own check. */
    addFiles?: string[];
  };
  /**
   * True when the check the dialog showed read the page files to a
   * conclusion (`pages.conclusive`), so the pages it listed are all the page
   * changes there are. Anything but `true`, absence included, keeps head_sha.
   */
  pageContentChecked?: boolean;
}

/**
 * The check's HEAD from the accept's changes, or undefined when none came.
 * The value arrives from the client, and every read of the accept is pinned
 * to it and head_sha records it, so only a full commit SHA, exactly 40
 * lowercase hex characters, is taken; anything else throws. The strict reads
 * at it then establish that the commit exists.
 */
export function checkedHeadSha(changes: FullSyncChanges): string | undefined {
  const headSha: unknown = changes.headSha;
  if (headSha === undefined) return undefined;
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("apply-full-sync refused: headSha is not a full commit SHA");
  }
  return headSha;
}

/**
 * An apply refused before it wrote anything, because the check it carries was
 * computed for another project, or against a base that is no longer the
 * recorded head_sha, or names no base at all (an older page). The author
 * checks again against the head recorded now.
 */
export class SyncBaseStale extends Error {
  constructor() {
    super("apply-full-sync refused: the check's base is no longer the recorded head");
    this.name = "SyncBaseStale";
  }
}

/**
 * Accepted page content the collaboration object did not apply, by page id:
 * pages edited in the Compositor since the check (`changedSinceReview`), and
 * pages it could not find, read, refused as malformed, or D1 does not show
 * (`failed`). The accept stops without advancing head_sha, so the next check
 * offers them again.
 */
export class PageContentNotApplied extends Error {
  readonly changedSinceReview: number[];
  readonly failed: number[];
  constructor(changedSinceReview: number[], failed: number[]) {
    super(
      `page content not applied: changed since review [${changedSinceReview.join(", ")}], ` +
        `failed [${failed.join(", ")}]`,
    );
    this.name = "PageContentNotApplied";
    this.changedSinceReview = changedSinceReview;
    this.failed = failed;
  }
}

/**
 * Accepted story content the collaboration object did not apply: stories
 * edited in the Compositor since the check (`changedSinceReview`), and
 * stories it could not find or read (`failed`). The accept stops without
 * advancing head_sha, so the next check offers them again.
 */
export class StoryContentNotApplied extends Error {
  readonly changedSinceReview: string[];
  readonly failed: string[];
  constructor(changedSinceReview: string[], failed: string[]) {
    super(
      `story content not applied: changed since review [${changedSinceReview.join(", ")}], ` +
        `failed [${failed.join(", ")}]`,
    );
    this.name = "StoryContentNotApplied";
    this.changedSinceReview = changedSinceReview;
    this.failed = failed;
  }
}

/**
 * Accepted object fields the collaboration object left because the
 * Compositor's value changed since the check, by object_id. Everything else
 * the accept applied stands; head_sha has not moved, so the next check offers
 * them again.
 */
export class ObjectsChangedSinceReview extends Error {
  readonly objectIds: string[];
  constructor(objectIds: string[]) {
    super(`object fields changed since review: [${objectIds.join(", ")}]`);
    this.name = "ObjectsChangedSinceReview";
    this.objectIds = objectIds;
  }
}

/**
 * Accepted new object rows D1 refused after the collaboration object took
 * them, by object_id: a refusal found only by the write. The rest of the
 * accept stands; head_sha has not moved, so the next check offers the rows
 * again.
 */
export class ObjectsNotAdded extends Error {
  readonly objectIds: string[];
  constructor(objectIds: string[]) {
    super(`objects not added: [${objectIds.join(", ")}]`);
    this.name = "ObjectsNotAdded";
    this.objectIds = objectIds;
  }
}

/**
 * Accepted new rows of the other insert arms (glossary terms, pages) D1
 * refused after the collaboration object took them, by arm and key. As for
 * `ObjectsNotAdded`, the rest of the accept stands and head_sha has not moved.
 */
export class InsertsNotAdded extends Error {
  readonly failed: Record<string, string[]>;
  constructor(failed: Record<string, string[]>) {
    super(`inserts not added: ${JSON.stringify(failed)}`);
    this.name = "InsertsNotAdded";
    this.failed = failed;
  }
}

/**
 * An apply the collaboration object held back whole, writing nothing, for
 * entries it cannot store: refused as malformed at its boundary (`refused`,
 * by arm and position), or an object insert over D1's row size
 * (`oversized`, by object_id). The record does not move, and checking again
 * offers the same entries, so no retry helps. The fault is the Compositor's:
 * an id or value its own payload builder produced out of domain (blank-id rows
 * are dropped when objects.csv is read), or a row over D1's size.
 */
export class SyncEntriesRefused extends Error {
  readonly refused: Record<string, number[]>;
  readonly oversized: string[];
  constructor(refused: Record<string, number[]>, oversized: string[]) {
    super(`sync apply refused: entries the Compositor cannot store ${JSON.stringify({ refused, oversized })}`);
    this.name = "SyncEntriesRefused";
    this.refused = refused;
    this.oversized = oversized;
  }
}

// ---------------------------------------------------------------------------
// /ingest-sync payload + residue (the DO-routed apply)
// ---------------------------------------------------------------------------

/** Step wire shape shared with the collaboration DO's /ingest-sync endpoint. */
export interface SyncIngestStep {
  step_number?: number;
  kind?: string;
  object_id?: string;
  x?: number | null;
  y?: number | null;
  zoom?: number | null;
  page?: string;
  question?: string;
  answer?: string;
  alt_text?: string;
  clip_start?: string;
  clip_end?: string;
  loop?: string;
  /** The step's kept story CSV cells as a JSON object string; absent when none. */
  extra_columns?: string;
}

/** Layer wire shape shared with the collaboration DO's /ingest-sync endpoint. */
export interface SyncIngestLayer {
  step_index: number;
  layer_number: number;
  title?: string;
  button_label?: string;
  content?: string;
}

/**
 * The fully-resolved, typed payload the action hands to the DO. Everything here
 * flows through the Y.Doc and is persisted by the snapshot pipeline; the DO does
 * no parsing. D1-only columns (origin, missing_from_repo, related_terms,
 * telar_version) are NOT here — they travel in the residue and are written to D1
 * directly by the action.
 */
export interface SyncIngestPayload {
  config: Array<{ key: string; value: string | boolean | number }>;
  telarVersion?: string;
  stories: {
    /** Only the fields the author took from GitHub; the document keeps the rest. */
    update: Array<{
      storyId: string; title?: string; subtitle?: string; byline?: string;
      isPrivate?: boolean; showSections?: boolean;
    }>;
    insert: Array<{
      storyId: string; title: string; subtitle: string; byline: string;
      isPrivate: boolean; showSections: boolean;
      steps: SyncIngestStep[]; layers: SyncIngestLayer[];
    }>;
    /** Accepted content: the story's steps and layers replaced, if unchanged since `expected`. */
    replaceContent?: Array<{
      storyId: string; expected: string;
      steps: SyncIngestStep[]; layers: SyncIngestLayer[];
    }>;
  };
  objects: {
    /**
     * By D1 id: the row the author reviewed, and no other under its key.
     * `renameTo` gives a row stored under a stripped id GitHub's spelling
     * (`legacyStrippedIds`).
     */
    update: Array<ReviewedObjectUpdate | RecomputedImageUpdate>;
    /**
     * The DO's own reader type, not a look-alike: a field the DO stops reading,
     * or one it starts requiring, is a typecheck failure here rather than a
     * value that quietly never arrives. `origin` is absent from every row this
     * producer builds — see the insert loops in resolveFullSyncPayload.
     */
    insert: IngestObjectInsert[];
    /** By D1 id: the row the author was shown, and no other under its key. */
    remove: Array<{ objectId: string; docId: number }>;
    /** GitHub's order of the rows the sync paired, by key and D1 id (`objectOrderChange`). */
    order?: Array<{ objectId: string; docId: number }>;
    /** GitHub's objects.csv in order, which places the inserts (`githubSheet`). */
    sheet?: SheetEntry[];
  };
  glossary: {
    update: Array<{ termId: string; title?: string; definition?: string; kind?: string }>;
    insert: Array<{ termId: string; title: string; definition: string; kind: string }>;
    /**
     * Terms whose id publishes none (`isHeldTermId`) that a held row of
     * glossary.csv carries unchanged (`heldTermsTheRepoHolds`), by D1 id with
     * the document values that were compared. The document removes such a term
     * only while it still has those values.
     */
    removeHeld?: HeldTermRemoval[];
  };
  /**
   * Accepted pages: each page's content replaced, if unchanged since
   * `expected`; the pages GitHub added or the author restored; the pages
   * GitHub deleted that the author removed too.
   */
  pages?: { replaceContent?: IngestPageReplaceContent[]; insert?: IngestPageInsert[]; remove?: IngestPageRemove[] };
}

/**
 * The D1-only writes that accompany an ingest. These columns are safe to write
 * directly: the snapshot UPDATE omits them and the stale-id re-INSERT preserves
 * them from the surviving row (see the field registry). Part 1 (missing flags,
 * the D1-only glossary columns for updated terms) is written before the ingest;
 * part 2 (the same glossary columns for inserted terms, the version heal) runs
 * after it, once the rows exist.
 */
export interface FullSyncResidue {
  /**
   * D1 row ids to flag missing_from_repo = true. By row, not by key: two rows
   * can share an object_id, and each has its own origin and its own removal.
   */
  missingFromRepoSet: number[];
  /** D1 row ids to clear missing_from_repo = false. */
  missingFromRepoClear: number[];
  /**
   * The glossary columns D1 owns alone — related_terms and the extra_columns
   * passthrough — for terms the ingest updated. Named for the columns rather
   * than for one of them: both are absent from the Y.Doc for the same reason
   * and travel the same way.
   */
  glossaryD1Update: Array<{ termId: string; relatedTerms?: string | null; extraColumns?: string | null }>;
  /** The same columns for newly inserted terms (written after the DO INSERT). */
  glossaryD1Insert: Array<{ termId: string; relatedTerms: string | null; extraColumns: string | null }>;
  /**
   * The stories' custom project.csv columns, which D1 owns alone like the
   * glossary's: the snapshot UPDATE omits them. For stories the ingest updated.
   */
  storyD1Update: Array<{ storyId: string; extraColumns: string | null }>;
  /** The same column for newly inserted stories (written after the DO INSERT). */
  storyD1Insert: Array<{ storyId: string; extraColumns: string | null }>;
  /** The version to heal D1 to when the repo is ahead, else null. */
  telarVersionHeal: string | null;
  /** The repository's glossary kinds as canonical JSON, when the author took them; D1 only. */
  glossaryKindsAccept: string | null;
  /**
   * The stories whose CSV in the spreadsheets folder this apply read: each
   * inserted with a file there, and each whose content was accepted. Their
   * `source_path` is recorded once the ingest has applied them.
   */
  storiesRead: string[];
  /** The CSVs of the stories inserted, with the blobs read, for the record of files a first publish deletes. */
  storyFileReads: OwedStoryFile[];
}

/**
 * The DO binding + secret the action needs to call /ingest-sync. Mirrors the
 * collab-reset.server.ts CollabResetEnv shape so any Env satisfies it.
 */
export interface FullSyncEnv {
  SESSION_SECRET: string;
  // Method syntax (bivariant params) so the real Env's DurableObjectNamespace
  // satisfies this structural subset without a cast.
  COLLABORATION: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

// ---------------------------------------------------------------------------
// Config field extractor
// ---------------------------------------------------------------------------

/** Managed _config.yml fields synced between repo and D1 */
/**
 * Story fields the full-sync diff compares (registry-pinned: the field
 * registry's storyFields declarations must equal this list — see the
 * derivation pins in tests/field-registry-lists.test.ts).
 *
 * `order` is intentionally excluded: the import pipeline writes a 0-based
 * sequence into `stories.order`, but `project.csv` is 1-based, so every
 * freshly-imported project would report every story as "(changed)" on
 * every sync check. Until the import is normalised to match the CSV
 * (separate fix), the sync diff compares user-visible content only.
 * Trade-off: a pure reorder with no content change won't surface here —
 * a known limitation.
 *
 * `showSections` is included: it round-trips through project.csv
 * (show_sections/mostrar_secciones) and the story hash, so a repo-side toggle
 * must be reconcilable or it would be silently reverted on the next publish.
 */
export const STORY_SYNC_FIELDS: ReadonlyArray<keyof StorySyncItem> = [
  "title",
  "subtitle",
  "byline",
  "isPrivate",
  "showSections",
  "extraColumns",
];

/**
 * Config fields the full-sync diff manages (registry-pinned: the field
 * registry's config sync declarations must equal this list — see the
 * derivation pins in tests/field-registry-lists.test.ts).
 */
export const MANAGED_CONFIG_FIELDS = [
  "title",
  "lang",
  "baseurl",
  "url",
  "description",
  "author",
  "email",
  "logo",
  "story_key",
  "collection_mode",
  "theme",
  "include_demo_content",
  "show_on_homepage",
  "show_story_steps",
  "show_object_credits",
  "browse_and_search",
  "show_link_on_homepage",
  "show_sample_on_homepage",
  "featured_count",
  "skip_stories",
  "glossary_kinds_json",
] as const;

type ManagedConfigField = typeof MANAGED_CONFIG_FIELDS[number];

/**
 * Managed fields stored as D1 booleans but published as unquoted YAML
 * "true"/"false" scalars. The diff normalizes the D1 boolean to that string
 * form before comparing, and the accept path coerces the repo scalar back to
 * a real boolean (writing the raw string would store the truthy "false").
 */
const BOOLEAN_CONFIG_FIELDS: ReadonlySet<ManagedConfigField> = new Set([
  "collection_mode",
  "include_demo_content",
  "show_on_homepage",
  "show_story_steps",
  "show_object_credits",
  "browse_and_search",
  "show_link_on_homepage",
  "show_sample_on_homepage",
  "skip_stories",
] as ManagedConfigField[]);

/**
 * Maps a managed field to its actual _config.yml key when the two differ from
 * the D1 column name. "lang" and "theme" publish under `telar_`-prefixed
 * top-level keys (buildConfigManagedFields in publish.server.ts); the
 * interface toggles publish as nested block children, named here with a
 * dotted `block.child` path that extractConfigFields resolves via the shared
 * block walker. Without an alias, extractConfigFields would match a literal
 * `^lang:` (or `^show_on_homepage:`) line that no real config file contains,
 * so a repo-side edit could never surface in a sync diff.
 */
export const CONFIG_YAML_KEY_ALIASES: Partial<Record<ManagedConfigField, string>> = {
  lang: "telar_language",
  theme: "telar_theme",
  include_demo_content: "story_interface.include_demo_content",
  show_on_homepage: "story_interface.show_on_homepage",
  show_story_steps: "story_interface.show_story_steps",
  show_object_credits: "story_interface.show_object_credits",
  browse_and_search: "collection_interface.browse_and_search",
  show_link_on_homepage: "collection_interface.show_link_on_homepage",
  show_sample_on_homepage: "collection_interface.show_sample_on_homepage",
  featured_count: "collection_interface.featured_count",
  // `development-features:` is the framework's block name; `dev_features` is
  // only a Liquid local, so it never appears in _config.yml.
  skip_stories: "development-features.skip_stories",
  // The top-level `glossary: kinds:` list, compared as canonical JSON
  // (extractConfigFields), not the `collections: glossary:` entry.
  glossary_kinds_json: "glossary.kinds",
};

/**
 * Reads the story key from a _config.yml string, mirroring the writer's
 * precedence in publish.server.ts's updateConfigFields: the key lives under the
 * `protected:` block as `  key:`, with a top-level `story_key:` line kept only as
 * a legacy fallback. So read `protected.key` first and let it win; fall back to
 * top-level `story_key:` only when the nested value is absent. Without this, a
 * repo whose only copy of the key sits under `protected:` (the normal case) read
 * back as null, producing a phantom sync diff against the identical D1 value.
 */
function extractStoryKey(yamlContent: string): string | null {
  const nested = findInYamlBlock(yamlContent, "protected", (line) => {
    const m = line.match(/^\s+key:[ \t]*(.*)$/);
    return m ? m[1] : undefined;
  });
  if (nested !== undefined) {
    const parsed = parseYamlScalar(nested);
    if (parsed !== null) return parsed;
  }
  const top = yamlContent.match(/^story_key:[ \t]*(.*)$/m);
  return top ? parseYamlScalar(top[1]) : null;
}

/**
 * Extracts managed config field values from a raw _config.yml string using
 * line-based parsing — same approach as disableGoogleSheetsInConfig, to
 * preserve multi-line config files with comments (a full js-yaml parse+
 * rewrite of the whole document is what this line walk exists to avoid;
 * `parseYamlScalar`'s quoted branch does use js-yaml, but only on the single
 * captured scalar, not the document).
 *
 * Only extracts top-level scalar keys (the managed set), plus story_key via the
 * block-aware reader above. Complex YAML sub-keys (e.g. telar.version) are not
 * touched. Handles double-quoted, single-quoted, and bare scalar values
 * correctly, including values containing a quote (e.g. HTML descriptions) —
 * but only when the scalar is a single line. A value spanning multiple
 * lines (e.g. `description: "a\n  b"`) is not reassembled by this line
 * walk: only the first line reaches `parseYamlScalar`, which then sees an
 * unterminated quote, falls back to `decodeQuotedScalarFallback`, and
 * returns just that first line's content (verified: `"a\n  b"` comes back
 * as `"a"`, not `"a b"`). Pre-existing behaviour, not fixed here — fixing
 * it means changing the file walk itself, which exists to keep comments
 * and unmanaged keys intact.
 */
export function extractConfigFields(yamlContent: string): Record<ManagedConfigField, string | null> {
  const result: Record<string, string | null> = {};
  for (const key of MANAGED_CONFIG_FIELDS) {
    if (key === "story_key") {
      // story_key is nested under `protected:` — needs the block-aware reader
      // above rather than a top-level line match.
      result[key] = extractStoryKey(yamlContent);
      continue;
    }
    if (key === "glossary_kinds_json") {
      // The list as canonical JSON, so formatting in the file is not a change.
      result[key] = repoGlossaryKindsJson(yamlContent);
      continue;
    }
    const yamlKey = CONFIG_YAML_KEY_ALIASES[key] ?? key;
    if (yamlKey.includes(".")) {
      // Nested block child (story_interface.* / collection_interface.*):
      // resolve through the shared block walker so the boundary rule matches
      // the publish writer's (updateConfigBlocks uses the same primitive).
      const [blockKey, childKey] = yamlKey.split(".");
      const childRe = new RegExp(`^[ \\t]+${childKey}:[ \\t]*(.*)$`);
      const found = findInYamlBlock(yamlContent, blockKey, (line) => {
        const cm = line.match(childRe);
        return cm ? (parseYamlScalar(cm[1]) ?? null) : undefined;
      });
      result[key] = found ?? null;
      continue;
    }
    // The whole remainder of the key's line, through the shared matcher that
    // readConfigScalar also uses, so both readers of this file agree.
    const raw = topLevelKeyRemainder(yamlContent, yamlKey);
    result[key] = raw !== undefined ? parseYamlScalar(raw) : null;
  }
  return result as Record<ManagedConfigField, string | null>;
}

// Where the repository's framework version is read, beside the rule that
// decides which version a read of the repository matches ids with.
export { extractTelarVersion } from "~/lib/site-version.server";

/**
 * A D1 config value in the string form `extractConfigFields` gives the
 * repository's, so a logically unchanged value never reads as a sync diff.
 * Boolean columns (collection_mode and the interface toggles) come back from
 * drizzle as JS booleans and featured_count as a number, where the file holds
 * bare scalars. The glossary kinds compare as canonical JSON, and a null kinds
 * column follows the repository's file, so it reads as whatever the file holds.
 */
function comparableConfigValue(key: ManagedConfigField, d1Val: unknown, repoVal: string | null): string | null {
  if (key === "glossary_kinds_json") return canonicalKindsJson(d1Val as string | null) ?? repoVal;
  if (typeof d1Val === "boolean") return d1Val ? "true" : "false";
  if (typeof d1Val === "number") return String(d1Val);
  return (d1Val as string | null | undefined) ?? null;
}

/** An accepted config field's repository value, typed as the shared document holds it. */
function pushAcceptedConfig(
  config: SyncIngestPayload["config"],
  key: ManagedConfigField,
  raw: string | null,
): void {
  if (BOOLEAN_CONFIG_FIELDS.has(key)) {
    // A bare "false" scalar is truthy as a string — coerce to a real boolean.
    config.push({ key, value: raw === "true" });
  } else if (key === "featured_count") {
    const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    // A count that is not a number is left out.
    if (Number.isFinite(n)) config.push({ key, value: n });
  } else {
    config.push({ key, value: raw ?? "" });
  }
}

/**
 * The project_config columns a sync's VERSION heal writes, or null when it
 * heals nothing and the row must not be touched on that account.
 */
export function configHealPatch(
  residue: Pick<FullSyncResidue, "telarVersionHeal">,
  now: string,
): Record<string, unknown> | null {
  if (!residue.telarVersionHeal) return null;
  return { telar_version: residue.telarVersionHeal, updated_at: now };
}

// ---------------------------------------------------------------------------
// computeFullSyncDiff
// ---------------------------------------------------------------------------

/**
 * The content check with GitHub's content no longer the default for a story
 * whose row is a conflict defaulting to the author's. The accept takes a
 * story's content and row together on the content card's one choice, so the
 * author's row wins the default for both; an explicit choice of GitHub's
 * content still takes the row with it.
 */
export function withRowDefaults(
  check: StoryContentCheck,
  changedStories: readonly StorySyncChangedItem[],
): StoryContentCheck {
  if (!check.conclusive) return check;
  const authorRows = new Set(changedStories.filter((s) => s.conflict && !s.repoByDefault).map((s) => s.story_id));
  return {
    ...check,
    changes: check.changes.map((change) =>
      change.acceptByDefault && authorRows.has(change.story_id) ? { ...change, acceptByDefault: false } : change,
    ),
  };
}

/** The content check with each listed story's title, for the dialog to name it. */
function withStoryTitles(
  check: StoryContentCheck,
  titleOf: (storyId: string) => string | null | undefined,
): StoryContentCheck {
  if (!check.conclusive) return check;
  return { ...check, changes: check.changes.map((change) => ({ ...change, title: titleOf(change.story_id) ?? null })) };
}

/**
 * Computes a full three-way diff for objects, stories, and config between
 * D1 and the repo.
 *
 * - Objects: delegates to existing `computeSyncDiff`
 * - Stories: compares D1 stories table against repo project.csv, and the
 *   stories' step and layer files (`checkStoryContent`)
 * - Config: compares D1 project_config against repo _config.yml managed fields
 * - Pages: compares D1's pages with their files (`checkPageContent`)
 *
 * D1 wins by default when both sides changed — callers must explicitly add
 * a story_id to `changes.stories.accept` to apply the repo version.
 */
export async function computeFullSyncDiff(
  projectId: number,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  baseRef?: string | null,
  /**
   * `collectWarnings` asks for what the reads at HEAD found wrong
   * (`warnings`), and for the new stories' step files to be read for it. Only
   * the dashboard's check, which an author starts, asks: the status refresh
   * runs this diff every 45 seconds while the heads differ and shows none.
   * `headRef` is the commit to read at, for a caller that records a head it
   * has already judged.
   */
  options: {
    collectWarnings?: boolean; headRef?: string; frameworkVersion?: string | null;
    /** The commit legacy pairing is judged against (`computeSyncDiff`'s `legacyRef`); absent pairs nothing. */
    legacyRef?: string | null;
  } = {},
): Promise<FullSyncDiff> {
  const collectWarnings = options.collectWarnings === true;
  // Every HEAD read of this diff is pinned to one commit, and the diff reports
  // it (`headSha`), so an accept can pin to it too. A caller that has judged a
  // head of its own passes it (`headRef`), so the head it records is the one
  // this diff read; the status refresh does. Otherwise the head is resolved
  // here, once.
  const head = options.headRef ?? (await getRepoHead(token, owner, repo, "main"));
  // Decide three-way vs two-way ONCE for the WHOLE diff. Fetch all four base
  // files at the ref in parallel via getFileAtRef, which tells "absent" (404 →
  // empty base for that domain) apart from "error" (transient / 5xx / 429 →
  // base unknown). An "error" is resolved by one lookup of the base commit
  // (`refuseUnlessBaseMissing`): a commit that does not exist, after a
  // force-push, makes the whole diff two-way; a failed read of one that does
  // refuses the check, since a two-way check can restore a row the author
  // deleted and default an editor-only change to the repository's value. All
  // four "absent" is also two-way (a GC'd or bad ref — nothing to compare).
  // Any other mix is three-way, with an "absent" file meaning an EMPTY base
  // for that domain. Threading base CONTENT (not a ref) down to the sub-diffs
  // keeps this the single mode-decision point.
  const base = baseRef ? await readBaseFiles(token, owner, repo, baseRef) : null;
  const threeWay = base !== null;
  const [baseObjectsCsv, baseProjectCsv, baseGlossaryCsv, baseConfigYml] = base ?? [null, null, null, null];
  let suppressedEditorOnly = 0;

  // Story fields compared / mapped into a StorySyncItem shape. Shared by the
  // repo, base, and D1 sides so classification stays symmetrical.
  const storyFields = STORY_SYNC_FIELDS;
  const storyRowChanged = (a: StorySyncItem, b: StorySyncItem): boolean =>
    storyFields.some((f) => storyFieldStr(a, f) !== storyFieldStr(b, f));

  // The site's framework version is the repository's at the head read, and
  // D1's only where the repository names none: the apply
  // (`resolveFullSyncPayload`) reads it the same way, so a site upgraded on
  // GitHub is reviewed and applied on one version.
  // The files read lossily at the head, whether or not warnings are collected:
  // the status refresh counts them as divergence (`unreadableFiles`).
  const unreadable: SheetWarning[] = [];
  const configYmlContent = await contentAtRef(token, owner, repo, CONFIG_YML_PATH, head, unreadable);
  const siteVersion = siteVersionFrom(configYmlContent, options.frameworkVersion ?? null);

  // 1. Delegate objects diff. Thread the base objects.csv CONTENT: undefined in
  //    two-way, string|null (null = empty base) in three-way.
  const objectsDiff = await computeSyncDiff(
    projectId, token, owner, repo, db, threeWay ? baseObjectsCsv : undefined, head, collectWarnings,
    { atRef: siteVersion }, options.legacyRef,
  );
  suppressedEditorOnly += objectsDiff.suppressedEditorOnly ?? 0;

  // 2. Fetch project.csv from repo and parse into story rows
  const warnings: SheetWarning[] | null = collectWarnings ? [...(objectsDiff.warnings ?? [])] : null;
  const projectRead = await readSiteSheet("project", (path) => contentAtRef(token, owner, repo, path, head, unreadable));
  const projectCsvContent = projectRead.content;
  const repoStoryRows = projectCsvContent
    ? mapProjectCsv(readRepoSheet(projectCsvContent, projectSheet(projectRead.name), warnings), projectId)
    : [];
  const repoStoryMap = new Map(
    repoStoryRows.map((r) => [r.story_id as string, toStoryItem(r)]),
  );

  // Base story rows (three-way only).
  const baseProject = threeWay ? readBaseSheet(baseProjectCsv, projectSheet()) : null;
  const projectBaseUnknown = baseRowsUnknown(baseProject, "story_id");
  const baseStoryRows = baseProject && !projectBaseUnknown ? mapProjectCsv(baseProject.rows, projectId) : [];
  const ambiguousStoryFields = storyFieldsFedBy(baseProject?.collided ?? new Set());
  const baseStoryMap = new Map(baseStoryRows.map((r) => [r.story_id as string, toStoryItem(r)]));

  // 3. Fetch D1 stories for this project
  const d1StoryRows = await db
    .select()
    .from(stories)
    .where(eq(stories.project_id, projectId));
  const d1StoryMap = new Map(d1StoryRows.map((s) => [s.story_id, s]));

  // 4. Compute story diffs (row grain — accept/reject is whole-story).
  const newStories: StorySyncItem[] = [];
  const changedStories: StorySyncChangedItem[] = [];
  const missingStories: Array<{ story_id: string; title: string | null }> = [];

  for (const [storyId, repoRow] of repoStoryMap.entries()) {
    if (!d1StoryMap.has(storyId)) {
      // In repo, not in D1. Three-way mirrors the object/glossary rule: a story
      // present in the base is an editor deletion. If the repo row is identical
      // to the base, it is a pure editor deletion — suppress it. If the repo
      // edited the story while the editor deleted it, surface a
      // deleted-here/edited-there conflict (restore vs keep-deleted, default
      // keep-deleted). A story absent from the base is genuinely new.
      if (threeWay) {
        const baseItem = baseStoryMap.get(storyId);
        if (baseItem) {
          if (!storyRowChanged(repoRow, baseItem)) {
            suppressedEditorOnly++;
            continue;
          }
          newStories.push({ ...repoRow, deletedInCompositor: true });
          continue;
        }
      }
      newStories.push(repoRow);
      continue;
    }

    const d1Row = d1StoryMap.get(storyId)!;
    const d1Item: StorySyncItem = {
      story_id: storyId,
      title: d1Row.title ?? null,
      subtitle: d1Row.subtitle ?? null,
      byline: d1Row.byline ?? null,
      order: d1Row.order ?? 0,
      isPrivate: d1Row.private ?? false,
      showSections: d1Row.show_sections ?? false,
      extraColumns: d1Row.extra_columns ?? "",
    };

    const baseItem = threeWay ? baseStoryMap.get(storyId) : undefined;
    const fieldStr = (row: StorySyncItem) => (f: keyof StorySyncItem) => storyFieldStr(row, f);
    const { changedFields, conflictFields, editorOnly } = rowFieldsAgainstBase(
      storyFields, fieldStr(repoRow), fieldStr(d1Item), baseItem ? fieldStr(baseItem) : null,
      (f) => projectBaseUnknown || (baseItem !== undefined && ambiguousStoryFields.has(f)),
    );
    if (editorOnly) suppressedEditorOnly++; // counted once per story, as for objects
    if (changedFields.length === 0) continue;

    const d1Values: Partial<Record<keyof StorySyncItem, string | boolean>> = {};
    const repoValues: Partial<Record<keyof StorySyncItem, string | boolean>> = {};
    for (const field of changedFields) {
      d1Values[field] = d1Item[field] as string | boolean;
      repoValues[field] = repoRow[field] as string | boolean;
    }
    // The base cannot say which side moved an ambiguous field: GitHub's value
    // is the default only when the Compositor left every other field as the
    // base has it.
    // The custom-column blob is written whole, so a base that cannot place it
    // never defaults to GitHub's (`repoDefaultsFor`).
    const repoByDefault =
      baseItem !== undefined &&
      conflictFields.some((f) => ambiguousStoryFields.has(f)) &&
      !ambiguousStoryFields.has("extraColumns") &&
      !storyFields.some(
        (f) => !ambiguousStoryFields.has(f) && storyFieldStr(d1Item, f) !== storyFieldStr(baseItem, f),
      );

    changedStories.push({
      story_id: storyId,
      title: d1Row.title ?? null,
      changedFields,
      conflictFields,
      conflict: conflictFields.length > 0,
      ...(repoByDefault ? { repoByDefault } : {}),
      d1Values,
      repoValues,
    });
  }

  for (const [storyId, d1Row] of d1StoryMap.entries()) {
    if (repoStoryMap.has(storyId)) continue;
    // In D1, not in repo. Three-way: absent from the base too → editor-created,
    // unpublished → suppress from the removed list (was in the base → genuine
    // repo deletion, shown as today).
    if (threeWay && !projectBaseUnknown && !baseStoryMap.has(storyId)) {
      suppressedEditorOnly++;
      continue;
    }
    missingStories.push({ story_id: storyId, title: d1Row.title ?? null });
  }

  // 4b. The stories' step and layer files, pinned to the same HEAD.
  const checked = await storyContentOf({
    token, owner, repo, db, head,
    base: baseRef ?? null,
    d1Stories: d1StoryRows,
    deletedHere: threeWay
      ? [...baseStoryMap.keys()].filter((id) => repoStoryMap.has(id) && !d1StoryMap.has(id))
      : [],
    headRowIds: new Set(repoStoryMap.keys()),
    warnings: warnings ?? undefined,
  });
  const content = withRowDefaults(
    withStoryTitles(checked, (id) => d1StoryMap.get(id)?.title ?? repoStoryMap.get(id)?.title),
    changedStories,
  );
  if (content.conclusive) {
    suppressedEditorOnly += content.suppressedEditorOnly;
    // A story deleted here whose files changed there takes the same restore /
    // keep-deleted choice as one whose row changed.
    for (const change of content.changes) {
      if (change.kind !== "restore-choice" || newStories.some((n) => n.story_id === change.story_id)) continue;
      const repoRow = repoStoryMap.get(change.story_id);
      if (!repoRow) continue;
      newStories.push({ ...repoRow, deletedInCompositor: true });
      suppressedEditorOnly--;
    }
  }

  // 5. Compare _config.yml (read above) against D1 project_config
  const repoConfigFields = configYmlContent
    ? extractConfigFields(configYmlContent)
    : ({} as Record<ManagedConfigField, string | null>);
  const baseConfigFields =
    threeWay && baseConfigYml
      ? extractConfigFields(baseConfigYml)
      : ({} as Record<ManagedConfigField, string | null>);

  const d1ConfigRows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, projectId));
  const d1Config = (d1ConfigRows[0] as unknown as Record<string, string | null | undefined> | undefined) ?? {};

  const configChangedFields: ConfigSyncDiff["changedFields"] = [];

  for (const key of MANAGED_CONFIG_FIELDS) {
    const repoVal = repoConfigFields[key] ?? null;
    const d1Val = comparableConfigValue(key, d1Config[key], repoVal);

    // Repo-empty guard (unchanged): only a non-null repo value that differs
    // from D1 is a candidate diff entry.
    if (repoVal === null || repoVal === d1Val) continue;

    if (!threeWay) {
      configChangedFields.push({ key, d1Value: d1Val, repoValue: repoVal, conflict: false });
      continue;
    }

    // Three-way classification against the base config value (already the same
    // string|null form the repo side uses).
    const baseVal = baseConfigFields[key] ?? null;
    const repoChanged = baseVal !== repoVal;
    const editorChanged = baseVal !== d1Val;
    if (editorChanged && !repoChanged) {
      suppressedEditorOnly++; // editor-only setting — the repo never moved it
      continue;
    }
    configChangedFields.push({
      key,
      d1Value: d1Val,
      repoValue: repoVal,
      conflict: repoChanged && editorChanged,
    });
  }

  // Detect external version change. Compare repo _config.yml
  // telar.version with D1 project_config.telar_version. Healed in
  // applyFullSyncChanges when direction === "ahead". "behind" is
  // surfaced to the dashboard but not auto-applied.
  const repoTelarVersion = siteVersionFrom(configYmlContent, null);
  const d1TelarVersion =
    (d1Config.telar_version as string | null | undefined) ?? null;

  let versionChange: ConfigSyncDiff["versionChange"] = null;
  if (repoTelarVersion && repoTelarVersion !== d1TelarVersion) {
    if (!d1TelarVersion) {
      // D1 value empty — treat any repo version as "ahead"
      versionChange = {
        direction: "ahead",
        repoVersion: repoTelarVersion,
        d1Version: null,
      };
    } else {
      const repoTag = normalizeVersionTag(repoTelarVersion);
      const d1Tag = normalizeVersionTag(d1TelarVersion);
      const cmp = compareVersions(repoTag, d1Tag);
      if (cmp > 0) {
        versionChange = {
          direction: "ahead",
          repoVersion: repoTelarVersion,
          d1Version: d1TelarVersion,
        };
      } else if (cmp < 0) {
        versionChange = {
          direction: "behind",
          repoVersion: repoTelarVersion,
          d1Version: d1TelarVersion,
        };
      }
    }
  }

  // 6. Compute glossary diff. Thread the base glossary.csv CONTENT: undefined
  //    in two-way, string|null (null = empty base) in three-way.
  const glossaryDiff = await computeGlossarySyncDiff(
    projectId, token, owner, repo, db, threeWay ? baseGlossaryCsv : undefined, head, warnings, unreadable,
  );
  suppressedEditorOnly += glossaryDiff.suppressedEditorOnly ?? 0;

  // 6b. The pages' files, pinned to the same HEAD.
  const pages = await pageContentOf({ token, owner, repo, db, projectId, head, base: baseRef, warnings, unreadable });
  suppressedEditorOnly += suppressedBy(pages);

  // 7. The stories new on GitHub, and those deleted here that it brings back,
  //    which the story check does not compare: their step files read for
  //    warnings only, after every other read of the check.
  if (warnings) {
    appendWarnings(warnings, await newStoryWarnings(token, owner, repo, head, newStories.map((s) => s.story_id)));
  }

  const listTabs = listTabsOnce();
  const unreadableFiles = await settleUnreadable(
    warnings, unreadable, objectsDiff, configYmlContent, headHasGlossaryCsv(token, owner, repo, head), listTabs,
  );
  const headingFiles = await withoutSheetsSupplied(
    movedHeadingFiles(objectsDiff, glossaryDiff, headingFilesMoved(baseProjectCsv, projectCsvContent, projectSheet(projectRead.name), projectRead.name)),
    async () => configSheets(configYmlContent),
    listTabs,
  );

  // hasConflicts is wired truthfully in three-way mode: any field/row both
  // sides moved off the base, or any deleted-here/edited-there presence.
  const hasConflicts =
    threeWay &&
    (objectsDiff.changedObjects.some((o) => o.conflictFields.length > 0) ||
      objectsDiff.newObjects.some((o) => o.deletedInCompositor) ||
      objectsDiff.missingObjects.some((o) => o.editedInCompositor) ||
      changedStories.some((s) => s.conflict) ||
      [content, pages].some(fileCheckConflicts) ||
      newStories.some((s) => s.deletedInCompositor) ||
      configChangedFields.some((c) => c.conflict) ||
      glossaryDiff.changed.some((t) => t.conflict) ||
      glossaryDiff.added.some((t) => t.deletedInCompositor));

  return {
    objects: objectsDiff,
    stories: { newStories, changedStories, missingStories, content },
    config: { changedFields: configChangedFields, versionChange },
    glossary: glossaryDiff,
    pages,
    hasConflicts,
    classification: threeWay ? "three-way" : "two-way",
    suppressedEditorOnly: threeWay ? suppressedEditorOnly : 0,
    headSha: head,
    projectId,
    baseSha: baseRef ?? null,
    ...(warnings ? { warnings } : {}),
    unreadableFiles,
    headingFiles,
  };
}

/**
 * The files read lossily at the head, by the name the author sees. Where
 * warnings are collected, the lossy reads made before the list existed or
 * outside it are added to it, once per file, and a sheet the published Google
 * Sheet has a tab for is marked as taken from there. Whether the build takes
 * sheets from Google Sheets, and from which, is read from `configYml`, the
 * `_config.yml` at the head the check read (`configSheets`).
 */
async function settleUnreadable(
  warnings: SheetWarning[] | null,
  unreadable: SheetWarning[],
  objectsDiff: SyncDiff,
  configYml: string | null,
  glossaryCsvPresent: () => Promise<boolean>,
  listTabs: (url: string) => Promise<Array<{ name: string }>>,
): Promise<string[]> {
  if (warnings) {
    appendWarnings(warnings, unreadable);
    await markSheetsEffects(warnings, async () => configSheets(configYml), listTabs, glossaryCsvPresent);
  }
  return [
    ...new Set([...(objectsDiff.unreadableFiles ?? []), ...unreadableNames(unreadable), ...unreadableNames(warnings ?? [])]),
  ];
}

/**
 * The four base files' contents at `baseRef`, in `BASE_SHEETS` order then
 * _config.yml, with null for an absent file, or null for a two-way diff: a
 * failed read at a commit that does not exist, or every file absent. A failed read at a commit that
 * exists refuses (`refuseUnlessBaseMissing`).
 */
async function readBaseFiles(
  token: string,
  owner: string,
  repo: string,
  baseRef: string,
): Promise<Array<string | null> | null> {
  // Strict: a loose read accepts a body whose length disagrees with the file's
  // size, and a truncated base sheet would read as an empty one.
  const atBase = (path: string) => getFileAtRef(token, owner, repo, path, baseRef, { strict: true });
  const all = await Promise.all([
    ...BASE_SHEETS.map((role) => siteSheetFileAt(role, atBase)),
    atBase(CONFIG_YML_PATH).then((file) => ({ path: CONFIG_YML_PATH, file })),
  ]);
  const failed = all.find((r) => r.file.status === "error");
  if (failed) {
    await refuseUnlessBaseMissing(token, owner, repo, baseRef, failed.path);
    return null;
  }
  if (all.every((r) => r.file.status === "absent")) return null;
  // A strict read keeps the byte-order mark, which the loose read dropped.
  return all.map(({ file }) => (file.status === "ok" ? file.content.replace(/^\uFEFF/, "") : null));
}

/**
 * The base of the objects page's three-way check (`computeSyncDiff`'s
 * `baseObjectsContent`): objects.csv at `ref`, the commit whose objects.csv D1
 * last accounted for (`projects.objects_read_sha`), read strictly as the full
 * sync reads its base. Null when that commit holds no objects.csv, an empty
 * base. Undefined, no base and a two-way check, when there is no record, or
 * when GitHub does not hold the commit or cannot say whether it does. A failed
 * read of a commit GitHub holds refuses the check.
 */
export async function objectsBaseAt(
  token: string,
  owner: string,
  repo: string,
  ref: string | null,
): Promise<string | null | undefined> {
  if (!ref) return undefined;
  const { path, file: read } = await siteSheetFileAt("objects", (at) =>
    getFileAtRef(token, owner, repo, at, ref, { strict: true }),
  );
  if (read.status === "ok") return read.content.replace(/^\uFEFF/, "");
  if (read.status === "error") {
    await refuseUnlessBaseMissing(token, owner, repo, ref, path);
    return undefined;
  }
  return (await commitExists(token, owner, repo, ref)) === "exists" ? null : undefined;
}

/**
 * A base read failed: returns when the base commit does not exist, and throws
 * `SheetUnreadableError` for `failedPath` when it does, or when the lookup
 * cannot say. One lookup for the whole check.
 */
async function refuseUnlessBaseMissing(
  token: string,
  owner: string,
  repo: string,
  baseRef: string,
  failedPath: string,
): Promise<void> {
  if ((await commitExists(token, owner, repo, baseRef)) === "missing") return;
  throw new SheetUnreadableError(failedPath);
}

/**
 * The story-file check for one diff, with each D1 story's step and layer rows
 * read only if the story is compared. A failure of the check itself is an
 * answer it could not reach, never an empty one.
 */
async function storyContentOf(args: {
  token: string;
  owner: string;
  repo: string;
  db: ReturnType<typeof getDb>;
  head: string;
  base: string | null;
  d1Stories: Array<typeof stories.$inferSelect>;
  deletedHere: string[];
  headRowIds: ReadonlySet<string>;
  warnings: SheetWarning[] | undefined;
}): Promise<StoryContentCheck> {
  const { db } = args;
  try {
    return await checkStoryContent({
      token: args.token,
      owner: args.owner,
      repo: args.repo,
      base: args.base,
      head: args.head,
      deletedHere: args.deletedHere,
      headRowIds: args.headRowIds,
      warnings: args.warnings,
      d1: args.d1Stories.map((story) => ({
        story_id: story.story_id,
        loadRows: async () => {
          const stepRows = await db.select().from(steps).where(eq(steps.story_id, story.id));
          const layerRows: (typeof layers.$inferSelect)[] = [];
          for (const step of stepRows) {
            layerRows.push(...(await db.select().from(layers).where(eq(layers.step_id, step.id))));
          }
          return { stepRows, layerRows };
        },
      })),
    });
  } catch (err) {
    return { conclusive: false, reason: `the story files could not be checked: ${(err as Error).message}` };
  }
}

/** The editor-only changes a concluded page check left out; none for one that did not conclude. */
function suppressedBy(pages: PageContentCheck): number {
  return pages.conclusive ? pages.suppressedEditorOnly : 0;
}

/**
 * The page-file check for one diff, over the project's pages as D1 holds
 * them, the page files record and the saved menu (`checkPageFiles`), its
 * base the recorded head or, while there is none, the record's commit. A
 * failure of the check itself is an answer it could not reach, never an
 * empty one.
 */
async function pageContentOf(args: {
  token: string;
  owner: string;
  repo: string;
  db: ReturnType<typeof getDb>;
  projectId: number;
  head: string;
  base: string | null | undefined;
  warnings: SheetWarning[] | null;
  unreadable: SheetWarning[];
}): Promise<PageContentCheck> {
  try {
    const scope = await loadPageCheckScope(args.db, args.projectId);
    return await checkPageFiles(
      { token: args.token, owner: args.owner, repo: args.repo }, scope, pagesBaseOf(args.base ?? null, scope.record), args.head,
      { warnings: args.warnings ?? undefined, unreadable: args.unreadable },
    );
  } catch (err) {
    return { conclusive: false, reason: `the page files could not be checked: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// computeGlossarySyncDiff
// ---------------------------------------------------------------------------

/**
 * Glossary fields the sync diff compares (registry-pinned: the field
 * registry's glossary declarations must equal this list — see the derivation
 * pins in tests/field-registry-lists.test.ts). term_id is the diff key, not a
 * compared field.
 */
export const GLOSSARY_SYNC_FIELDS = ["title", "definition", "related_terms", "kind", "extra_columns"] as const;

export type GlossarySyncField = typeof GLOSSARY_SYNC_FIELDS[number];

/** One term's compared fields, from either side of the diff. */
type GlossaryTermRow = Record<GlossarySyncField, string>;

/**
 * A glossary.csv row as the diff compares it. Its custom columns are collected
 * the same way mapGlossaryCsv collects them at import, so a column added by
 * hand reaches the diff as the one blob D1 stores rather than as loose cells.
 */
/** A repo row's kind: its `kind` cell, "" where the sheet has none. */
function rowKind(r: Record<string, string>): string {
  return r.kind ?? "";
}

/** A legacy held term the sync removes, with the values it was compared at. */
export interface HeldTermRemoval {
  dbId: number;
  title: string;
  definition: string;
  kind: string;
}

/**
 * The D1 terms whose id publishes none (`isHeldTermId`) and that a held row of
 * the repository's glossary.csv carries with the same id, stripped as the
 * reader strips it, and the same value in every compared field
 * (`GLOSSARY_SYNC_FIELDS`). The file holds what such a term holds, so removing
 * it loses nothing. A held term edited in the
 * Compositor, or one with no such row, is not here: the file has no copy of
 * its values, and the publish writes them in its row's place.
 */
function heldTermsTheRepoHolds<T extends HeldTermColumns>(
  d1Terms: readonly T[],
  repoRows: readonly Record<string, string>[],
): T[] {
  const heldRows = repoRows
    .filter((r) => isHeldTermId(r.term_id ?? ""))
    .map((r) => ({ termId: pythonStrip(r.term_id ?? ""), row: termRowOf(r) }));
  return d1Terms.filter((t) => {
    if (!isHeldTermId(t.term_id)) return false;
    const d1Row = d1TermRowOf(t);
    return heldRows.some((h) => h.termId === pythonStrip(t.term_id) && sameTermRow(h.row, d1Row));
  });
}

/** The columns of a D1 term the diff compares, with its id. */
type HeldTermColumns = Pick<
  typeof glossary_terms.$inferSelect,
  "id" | "term_id" | "title" | "definition" | "related_terms" | "kind" | "extra_columns"
>;

/** Whether two term rows agree in every compared field. */
function sameTermRow(a: GlossaryTermRow, b: GlossaryTermRow): boolean {
  return GLOSSARY_SYNC_FIELDS.every((f) => termFieldStr(a, f) === termFieldStr(b, f));
}

/** A D1 term as the diff compares it. */
function d1TermRowOf(t: HeldTermColumns): GlossaryTermRow {
  return {
    title: t.title ?? "",
    definition: t.definition ?? "",
    related_terms: t.related_terms ?? "",
    kind: t.kind ?? "",
    extra_columns: t.extra_columns ?? "",
  };
}

function termRowOf(r: Record<string, string>): GlossaryTermRow {
  const { extras } = collectExtraColumns(r, KNOWN_GLOSSARY_KEYS);
  return {
    title: r.title ?? "",
    definition: r.definition ?? "",
    related_terms: r.related_terms ?? "",
    kind: rowKind(r),
    extra_columns: Object.keys(extras).length > 0 ? JSON.stringify(extras) : "",
  };
}

/**
 * A term field as the diff compares it. extra_columns is compared semantically
 * (parsed, keys sorted), never by raw JSON string equality: a blob the repo
 * merely reserialised in a different key order is not a change. Every other
 * field compares as the string it is. The displayed values stay raw, so the
 * user sees the actual stored JSON.
 */
function termFieldStr(row: GlossaryTermRow, field: GlossarySyncField): string {
  return field === "extra_columns" ? canonicalExtraColumns(row.extra_columns) : row[field];
}

/**
 * Computes a diff between D1 glossary_terms and the repo's glossary.csv.
 *
 * - added: terms in repo CSV not in D1
 * - removed: terms in D1 not in repo CSV
 * - changed: terms in both whose title, definition, or related terms differ
 */
export async function computeGlossarySyncDiff(
  projectId: number,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof import("~/lib/db.server").getDb>,
  baseGlossaryContent?: string | null,
  /** The HEAD commit a caller pins its reads to; omitted, the default branch. */
  headRef?: string,
  /** Receives what the read of the repository's glossary.csv found wrong in it. */
  warnings: SheetWarning[] | null = null,
  /** Receives glossary.csv when its bytes at the head are not valid UTF-8. */
  unreadable?: SheetWarning[],
): Promise<GlossarySyncDiff> {
  // Three-way vs two-way is decided by the caller and threaded in as the base
  // glossary.csv CONTENT, not a ref (see computeSyncDiff): `undefined` is
  // two-way; a string or `null` is three-way, where `null` is an empty base.
  // computeFullSyncDiff owns the single mode decision, so no own base fetch.
  const threeWay = baseGlossaryContent !== undefined;
  const baseGlossary = threeWay ? readBaseSheet(baseGlossaryContent ?? null, glossarySheet()) : null;
  const glossaryBaseUnknown = baseRowsUnknown(baseGlossary, "term_id");
  const glossaryHead = headRef ?? (await getRepoHead(token, owner, repo, "main"));
  const glossaryRead = await readSiteSheet("glossary", (path) => contentAtRef(token, owner, repo, path, glossaryHead, unreadable));
  const glossaryCsvContent = glossaryRead.content;

  // One row per id, the one the site publishes, as the import keeps it.
  const buildTermMap = (rows: Record<string, string>[]) =>
    new Map(publishedRowPerTermId(rows).filter((r) => !isHeldTermId(r.term_id ?? "")).map((r) => [r.term_id as string, termRowOf(r)] as [string, GlossaryTermRow]));
  const repoGlossaryRows = readRepoSheet(glossaryCsvContent, glossarySheet(glossaryRead.name), warnings);
  // The term map is built without `mapGlossaryCsv`, so the column checks it
  // runs at import are run here on the same rows.
  if (warnings) checkGlossaryColumns(repoGlossaryRows, issuesFor(glossaryRead.name, warnings));
  const repoTermMap = buildTermMap(repoGlossaryRows);
  const baseTermMap =
    baseGlossary && !glossaryBaseUnknown ? buildTermMap(baseGlossary.rows) : new Map<string, GlossaryTermRow>();

  // Fetch D1 glossary terms for this project
  const d1Terms = await db
    .select()
    .from(glossary_terms)
    .where(eq(glossary_terms.project_id, projectId));
  // A term whose id publishes none is listed as removed below, by row, when
  // the repository holds it unchanged.
  const d1TermMap = new Map(d1Terms.filter((t) => !isHeldTermId(t.term_id)).map((t) => [t.term_id, t]));

  const added: GlossarySyncDiff["added"] = [];
  const removed: GlossarySyncDiff["removed"] = [];
  const changed: GlossarySyncDiff["changed"] = [];
  let suppressedEditorOnly = 0;

  const termRowChanged = (a: GlossaryTermRow, b: GlossaryTermRow): boolean => !sameTermRow(a, b);
  const ambiguousTermFields = termFieldsFedBy(baseGlossary?.collided ?? new Set());

  // Find added and changed
  for (const [termId, repoTerm] of repoTermMap.entries()) {
    const d1Term = d1TermMap.get(termId);
    if (!d1Term) {
      // In repo, not in D1. Three-way: a term present in the base and identical
      // to it is a pure editor deletion — suppress it. A term the repo edited
      // while the editor deleted it is a deleted-here/edited-there conflict.
      if (threeWay) {
        const baseTerm = baseTermMap.get(termId);
        if (baseTerm) {
          if (!termRowChanged(repoTerm, baseTerm)) {
            suppressedEditorOnly++;
            continue;
          }
          added.push({
            term_id: termId,
            title: repoTerm.title,
            definition: repoTerm.definition,
            related_terms: repoTerm.related_terms,
            kind: repoTerm.kind,
            extra_columns: repoTerm.extra_columns,
            deletedInCompositor: true,
          });
          continue;
        }
      }
      added.push({
        term_id: termId,
        title: repoTerm.title,
        definition: repoTerm.definition,
        related_terms: repoTerm.related_terms,
        kind: repoTerm.kind,
        extra_columns: repoTerm.extra_columns,
      });
    } else {
      const d1TermRow = d1TermRowOf(d1Term);
      if (!termRowChanged(d1TermRow, repoTerm)) continue;
      // Title is compared alongside definition/related_terms because it too
      // round-trips through glossary.csv and the glossary hash — a repo-side
      // title edit that sync ignored would be reverted on the next publish.
      const baseTerm = threeWay ? baseTermMap.get(termId) : undefined;
      const termStr = (row: GlossaryTermRow) => (f: GlossarySyncField) => termFieldStr(row, f);
      const { changedFields, conflictFields, editorOnly } = rowFieldsAgainstBase(
        GLOSSARY_SYNC_FIELDS, termStr(repoTerm), termStr(d1TermRow), baseTerm ? termStr(baseTerm) : null,
        (f) => glossaryBaseUnknown || (baseTerm !== undefined && ambiguousTermFields.has(f)),
      );
      if (editorOnly) suppressedEditorOnly++; // counted once per term, as for objects
      if (changedFields.length === 0) continue;
      // As for a story row: GitHub's is the default only when every other field
      // is as the base has it, and never when the custom-column blob, which is
      // written whole, is one of the fields the base cannot place.
      const repoByDefault =
        baseTerm !== undefined &&
        conflictFields.some((f) => ambiguousTermFields.has(f)) &&
        [...ambiguousTermFields].every(repoDefaultsFor) &&
        !GLOSSARY_SYNC_FIELDS.some(
          (f) => !ambiguousTermFields.has(f) && termFieldStr(d1TermRow, f) !== termFieldStr(baseTerm, f),
        );
      changed.push({
        term_id: termId,
        title: d1Term.title ?? repoTerm.title,
        dbId: d1Term.id,
        d1Title: d1TermRow.title,
        repoTitle: repoTerm.title,
        d1Definition: d1TermRow.definition,
        repoDefinition: repoTerm.definition,
        d1RelatedTerms: d1TermRow.related_terms,
        repoRelatedTerms: repoTerm.related_terms,
        d1Kind: d1TermRow.kind,
        repoKind: repoTerm.kind,
        d1ExtraColumns: d1TermRow.extra_columns,
        repoExtraColumns: repoTerm.extra_columns,
        changedFields,
        conflictFields,
        conflict: conflictFields.length > 0,
        ...(repoByDefault ? { repoByDefault } : {}),
      });
    }
  }

  // Find removed. A term whose id publishes none is removed whatever the base
  // says when a held row of glossary.csv carries it unchanged (`removeHeld`):
  // the file holds its values, and the framework never published it. Listed
  // by row, since such ids can repeat.
  const held = heldTermsTheRepoHolds(d1Terms, repoGlossaryRows);
  removed.push(...held.map((t) => ({ term_id: t.term_id, title: t.title ?? "", dbId: t.id })));
  for (const [termId, d1Term] of d1TermMap.entries()) {
    if (repoTermMap.has(termId)) continue;
    // In D1, not in repo. Three-way: absent from the base too → editor-created,
    // unpublished → suppress from the removed list.
    if (threeWay && !glossaryBaseUnknown && !baseTermMap.has(termId)) {
      suppressedEditorOnly++;
      continue;
    }
    removed.push({ term_id: termId, title: d1Term.title ?? "", dbId: d1Term.id });
  }

  return {
    added,
    removed,
    changed,
    ...(threeWay ? { suppressedEditorOnly } : {}),
    ...glossaryHeadingField(baseGlossaryContent, glossaryCsvContent, glossaryRead.name),
  };
}

// ---------------------------------------------------------------------------
// applyFullSyncChanges
// ---------------------------------------------------------------------------

/**
 * Resolves the user's accepted full-sync changes into a fully-typed DO ingest
 * payload plus the D1-only residue. Pure resolution: it re-fetches the repo
 * files (objects.csv, project.csv, _config.yml, glossary.csv, per-story CSVs
 * and the accepted stories' content), every one at one commit (`pinnedHead`,
 * else `changes.headSha`, else HEAD resolved once), reads the current D1
 * objects/config, maps accepted keys to typed values, and coerces each per
 * its column type. No DO calls, no writes — unit-testable with a mocked
 * getFileAtRef + db.
 *
 * Everything in `payload` flows through the Y.Doc and is persisted by the
 * snapshot pipeline. `residue` carries the D1-only columns the Y.Doc never holds
 * (missing_from_repo, related_terms, origin) plus the server-computed
 * telar_version heal decision.
 *
 * `actorUserId` is the owner the route resolved server-side; it becomes
 * `created_by` on every object this sync inserts. It is a parameter rather than
 * a lookup because this function takes no request and does no auth — the caller
 * that gated the apply is the only place the identity is known.
 */
/** The value an accepted "repo" choice writes for one object field. */
function acceptedObjectValue(
  field: SyncField,
  repoRow: Record<string, unknown>,
  rawAlt: string | null | undefined,
): string | boolean | null {
  if (field === "featured") return Boolean(repoRow.featured);
  if (field === "alt_text") return rawAlt || null;
  return (repoRow[field] as string | null | undefined) || null;
}

/**
 * A story's rows, in the order the framework renders them, on the ingest's
 * wire: each layer names its step by position in `steps`.
 */
function contentOnWire(rows: { stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] }): {
  steps: SyncIngestStep[];
  layers: SyncIngestLayer[];
} {
  const position = new Map(rows.stepRows.map((s, i) => [s.id, i]));
  return {
    steps: rows.stepRows.map((s) => ({
      step_number: s.step_number,
      kind: s.kind ?? "media",
      object_id: s.object_id ?? "",
      x: s.x ?? null,
      y: s.y ?? null,
      zoom: s.zoom ?? null,
      page: s.page ?? "",
      question: s.question ?? "",
      answer: s.answer ?? "",
      alt_text: s.alt_text ?? "",
      clip_start: s.clip_start ?? "",
      clip_end: s.clip_end ?? "",
      loop: s.loop ?? "",
      extra_columns: extrasOnWire(s.extra_columns),
    })),
    layers: rows.layerRows.map((l) => ({
      step_index: position.get(l.step_id)!,
      layer_number: l.layer_number,
      title: l.title ?? "",
      button_label: l.button_label ?? "",
      content: l.content ?? "",
    })),
  };
}

/** How many new stories' step files the check reads at once. */
const NEW_STORY_READS_AT_ONCE = 4;

/**
 * The warnings of the step CSVs of the stories new on GitHub, read at `head`
 * so the author sees them before bringing a story in, in the order given.
 *
 * The parse and its scope must be the ones `resolveFullSyncPayload` reads a
 * new story with (`readRepoSheet` under `storySheet`, then `mapStoryCsv`), or
 * the check warns about a sheet the accept reads differently. The layer files
 * the step CSV names are read as the accept reads them
 * (`resolveLayerFileReferences`), for whether their bytes are valid UTF-8
 * only: their text is discarded, since the file a cell names changes no
 * step's coordinates, page or row.
 *
 * A read that throws keeps what it raised before it threw. A refused sheet is
 * the accept's to refuse, so the check says nothing more of it.
 */
async function newStoryWarnings(
  token: string,
  owner: string,
  repo: string,
  head: string,
  storyIds: readonly string[],
): Promise<SheetWarning[]> {
  const perStory: SheetWarning[][] = storyIds.map(() => []);
  let next = 0;
  // A layer file several new stories name is read once, and named once.
  const layerFound: SheetWarning[] = [];
  const readLayer = readOncePerName((filename: string) =>
    contentAtRef(token, owner, repo, `telar-content/texts/stories/${filename}`, head, layerFound),
  );
  const readNext = async (): Promise<void> => {
    while (next < storyIds.length) {
      const index = next++;
      const storyId = storyIds[index];
      const found = perStory[index];
      try {
        const csv = await contentAtRef(token, owner, repo, `telar-content/spreadsheets/${storyId}.csv`, head, found);
        const rows = readRepoSheet(csv, storySheet(storyId), found);
        if (csv) mapStoryCsv(rows, 0, issuesFor(storySheet(storyId).fileName, found));
        await resolveLayerFileReferences(rows, readLayer);
      } catch {
        // What the read raised before it threw stays in `found`.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(NEW_STORY_READS_AT_ONCE, storyIds.length) }, readNext),
  );
  return [...perStory.flat(), ...layerFound];
}

/** A project.csv row's value for each story field the accept can write, as the ingest takes it. */
const ACCEPTED_STORY_VALUES: Record<string, (r: Record<string, unknown>) => string | boolean> = {
  title: (r) => String((r.title as string | null | undefined) ?? ""),
  subtitle: (r) => String((r.subtitle as string | null | undefined) ?? ""),
  byline: (r) => String((r.byline as string | null | undefined) ?? ""),
  isPrivate: (r) => Boolean(r.private),
  showSections: (r) => Boolean(r.show_sections),
};

/** The columns of `values` that are set; an undefined one is not written. */
function definedColumns(values: Record<string, string | null | undefined>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, string | null>;
}

/**
 * An accepted story or term posted without its field choices (a dialog from
 * before them) would apply nothing while head_sha advances, so the next
 * publish would overwrite GitHub's change: refused, and the author checks again.
 */
function refuseRowsWithoutChoices(changes: FullSyncChanges): void {
  const unchosen = (ids: string[], choices: FullSyncChanges["stories"]["fieldChoices"]) =>
    ids.some((id) => ownValue(choices ?? {}, id) === undefined);
  if (unchosen(changes.stories.accept, changes.stories.fieldChoices)) throw new SyncBaseStale();
  if (unchosen(changes.glossary.accept, changes.glossary.fieldChoices)) throw new SyncBaseStale();
}

/**
 * The fields of an accepted story or term the author took from GitHub
 * (`FullSyncChanges.stories.fieldChoices`). A field with no "repo" choice is
 * left alone, as for objects (`fullSyncObjectUpdates`).
 */
function repoFieldsOf(fieldChoices: Record<string, Record<string, "repo" | "d1">> | undefined, id: string): Set<string> {
  const choices = ownValue(fieldChoices ?? {}, id) ?? {};
  return new Set(Object.keys(choices).filter((field) => choices[field] === "repo"));
}

/**
 * The full sync's object updates — per accepted field ("repo" by default; "d1"
 * keeps D1). Each names the D1 id the author was shown (`changedDocIds`) and
 * is sent only for a row holding that key AND that id. One accepted and not
 * sent, because the row reviewed no longer holds the key or the choice names
 * no id, is in `notSent`, and the apply then applies nothing
 * (`recreatedSinceReview`).
 */
function fullSyncObjectUpdates(
  objectChanges: SyncChanges,
  repoObjMap: Map<string, Record<string, unknown>>,
  rawAltById: Map<string, string>,
  d1Objects: Array<{ id: number; object_id: string }>,
): { update: ReviewedObjectUpdate[]; notSent: string[] } {
  const update: ReviewedObjectUpdate[] = [];
  const notSent: string[] = [];
  for (const objectId of objectChanges.changedObjectIds) {
    const repoRow = repoObjMap.get(objectId);
    if (!repoRow) continue;
    const choices = ownValue(objectChanges.fieldChoices, objectId) ?? {};
    const fields: Partial<Record<SyncField, string | boolean | null>> = {};
    let anyRepo = false;
    for (const field of SYNC_FIELDS) {
      // Default "d1" means "leave D1 alone": a field absent from the choices map
      // (an editor-only suppressed field, or a guard-suppressed enrichment
      // field) must NOT be written through with the repo cell — that would
      // revert unpublished editor edits and wipe an IIIF-enriched thumbnail /
      // source_url whose repo cell is blank. Only an explicitly-accepted "repo"
      // field is written through the ingest.
      const choice = choices[field] ?? "d1";
      if (choice !== "repo") continue;
      fields[field] = acceptedObjectValue(field, repoRow, rawAltById.get(objectId));
      anyRepo = true;
    }
    if (!anyRepo) continue;
    const row = reviewedObjectRow(d1Objects, objectId, objectChanges.changedDocIds);
    if (row) update.push({ objectId, docId: row.id, fields, ...seenFieldsOf(objectChanges, objectId, fields) });
    else notSent.push(objectId);
  }
  return { update, notSent };
}

/**
 * The accepted pages from the accept's changes. The entries arrive from the
 * client, and each slug names the file read at the check's HEAD, so only a
 * positive integer page id, a slug naming a file directly in the pages folder
 * and a non-empty `expected` are taken; anything else throws before anything
 * is read or written.
 */
function acceptedPageEntries(changes: FullSyncChanges): Array<{ pageId: number; slug: string; expected: string }> {
  const entries: unknown = changes.pages?.acceptContent ?? [];
  if (!Array.isArray(entries)) throw new Error("apply-full-sync refused: pages.acceptContent is not a list");
  return entries.map((entry) => {
    const { pageId, slug, expected } = (entry ?? {}) as Record<string, unknown>;
    const plainSlug =
      typeof slug === "string" && slug !== "" && slug === slug.trim() && !slug.includes("/") && slug !== "." && slug !== "..";
    if (typeof pageId !== "number" || !Number.isSafeInteger(pageId) || pageId <= 0 || !plainSlug) {
      throw new Error("apply-full-sync refused: an accepted page names no page file");
    }
    if (typeof expected !== "string" || expected === "") {
      throw new Error(`accepted content for page ${pageId} carries no expected hash from its review`);
    }
    return { pageId, slug: slug as string, expected };
  });
}

/**
 * The accepted pages (`acceptedPageEntries`) added to the payload as
 * `pages.replaceContent`, GitHub's version of each read at `head`
 * (`readPagesForAccept`). No accepted page adds no arm.
 */
async function addAcceptedPages(
  payload: SyncIngestPayload,
  changes: FullSyncChanges,
  access: { token: string; owner: string; repo: string },
  head: string,
): Promise<void> {
  const acceptedPages = acceptedPageEntries(changes);
  if (acceptedPages.length === 0) return;
  const pageContent = await readPagesForAccept(access, head, acceptedPages.map((p) => p.slug));
  payload.pages = {
    replaceContent: acceptedPages.map(({ pageId, slug, expected }) => ({ pageId, expected, ...pageContent.get(slug)! })),
  };
}

/**
 * The record an accept writes with its head (`acceptedPageFilesRecord`). An
 * insert the ingest names no page for was not applied, and the accept stops
 * before head_sha moves.
 */
function acceptedRecordJson(pageFiles: AcceptedPageFiles, answer: IngestSyncAnswer): string {
  const recordJson = acceptedPageFilesRecord(pageFiles.record, pageFiles.inserted, answer.insertedPages);
  if (recordJson === null) throw new InsertsNotAdded({ pageInsert: pageFiles.inserted.map((p) => p.slug) });
  return recordJson;
}

/** The accept's own page-file check: the record it describes, and the pages its arms insert. */
interface AcceptedPageFiles {
  record: PageFilesRecord;
  inserted: IngestPageInsert[];
}

/**
 * The page-file arms of an accept, added to the payload from its own check
 * at the pages base and the pinned head (`checkPageFiles`): every addition,
 * each file the author chose to follow GitHub on (`pageFileArms`), and the
 * held pages the one-language reduction removes (`withReducedHeldPages`). A
 * choice the check does not list is a page changed since the check. Null when
 * the check does not conclude: no arm is added and head_sha is held; a choice
 * that cannot then be honoured refuses the accept.
 */
async function addPageFileArms(
  projectId: number,
  payload: SyncIngestPayload,
  changes: FullSyncChanges,
  db: ReturnType<typeof getDb>,
  access: { token: string; owner: string; repo: string },
  base: string | null,
  head: string,
): Promise<AcceptedPageFiles | null> {
  const takes = pageFileTakes(changes.pages?.takeFiles);
  const scope = await loadPageCheckScope(db, projectId);
  const check = await checkPageFiles(access, scope, pagesBaseOf(base, scope.record), head);
  if (!check.conclusive) {
    if (takes.length > 0) throw new Error(`apply-full-sync refused: the page files could not be read: ${check.reason}`);
    return null;
  }
  const arms = await pageFileArms(access, check, takes, reviewedAdditionNames(changes.pages?.addFiles), head);
  if (arms.stale.length > 0) throw new PageContentNotApplied(arms.stale, []);
  if (arms.unnamed) throw new SyncBaseStale();
  const held = withReducedHeldPages(check, payload.pages?.replaceContent ?? [], arms.remove);
  if (held.replaceContent.length > 0) payload.pages = { ...payload.pages, replaceContent: held.replaceContent };
  if (arms.insert.length > 0) payload.pages = { ...payload.pages, insert: arms.insert };
  if (held.remove.length > 0) payload.pages = { ...payload.pages, remove: held.remove };
  return { record: held.record, inserted: arms.insert };
}

/**
 * GitHub's order in the full sync's payload: the rows both sides hold, in
 * GitHub's order (`objects.order`), and the new rows, sent in GitHub's order
 * with GitHub's sheet to place them by (`objects.sheet`). The order is sent
 * whatever the author chose, since the Compositor cannot reorder objects and
 * holds no order of its own to keep.
 */
function addGitHubObjectOrder(
  payload: SyncIngestPayload,
  repoInserts: IngestObjectInsert[],
  repoRows: ReadonlyArray<{ object_id: unknown }>,
  d1Objects: ReadonlyArray<{ id: number; object_id: string; order_key: string | null }>,
): void {
  const order = objectOrderChange(repoRows, d1Objects)?.order;
  if (order) payload.objects.order = order;
  if (repoInserts.length === 0) return;
  const sheet = githubSheet(repoRows, d1Objects);
  payload.objects.sheet = sheet;
  payload.objects.insert.push(...inSheetOrder(repoInserts, sheet));
}

export async function resolveFullSyncPayload(
  projectId: number,
  changes: FullSyncChanges,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  actorUserId: number,
  pinnedHead?: string,
): Promise<{ payload: SyncIngestPayload; residue: FullSyncResidue; updatesNotSent: string[] }> {
  const head = pinnedHead ?? checkedHeadSha(changes) ?? (await getRepoHead(token, owner, repo, "main"));
  const atHead = (path: string) => contentAtRef(token, owner, repo, path, head);
  const objectChanges = changes.objects;
  const storyChanges = changes.stories;
  const configChanges = changes.config;
  const glossaryChanges = changes.glossary ?? { accept: [], reject: [], insertNew: [] };

  const payload: SyncIngestPayload = {
    config: [],
    stories: { update: [], insert: [] },
    objects: { update: [], insert: [], remove: [] },
    glossary: { update: [], insert: [] },
  };
  const residue: FullSyncResidue = {
    missingFromRepoSet: [],
    missingFromRepoClear: [],
    glossaryD1Update: [],
    glossaryD1Insert: [],
    storyD1Update: [],
    storyD1Insert: [],
    telarVersionHeal: null,
    glossaryKindsAccept: null,
    storiesRead: [],
    storyFileReads: [],
  };

  // --- Objects (objects.csv + repo tree + D1 rows) ------------------------
  const { csvContent: objectsCsvContent, tree: objectsTree, truncated: objectsTreeTruncated, path: objectsSheetPath } = await readObjectsAtHead(token, owner, repo, head);
  const d1Objects = await db.select().from(objects).where(eq(objects.project_id, projectId));
  const parsedObjAsWritten = readRepoSheet(objectsCsvContent, objectsSheet(fileNameOf(objectsSheetPath)), null);
  const { parsed: parsedObjRows, mapped: repoObjRows, renames: objectRenames } = pairLegacyObjectIds(
    parsedObjAsWritten,
    objectsCsvContent ? mapObjectsCsv(parsedObjAsWritten, projectId) : [],
    d1Objects,
    (await applyLegacyEvidence(db, projectId, { token, owner, repo }, parsedObjAsWritten)).recordedIds,
  );
  const repoObjMap = new Map(repoObjRows.map((r) => [r.object_id as string, r]));
  // Raw alt_text cell by object_id. mapObjectsCsv fills a blank cell with the
  // object's title (an import accessibility fallback that is NOT repo state), so
  // an explicitly-accepted alt_text change must write the RAW cell — the same
  // side map computeSyncDiff diffs against — not the enriched row's fallback.
  const rawAltById = new Map(parsedObjRows.map((r) => [r.object_id ?? "", r.alt_text ?? ""]));

  // Object inserts (new CSV rows + unregistered image files).
  //
  // Each insert carries `origin: "repo"`. A row whose D1 INSERT fails at the
  // flush stays in the document and lands at a later snapshot, which reads its
  // origin from the document; a write after the ingest would find no row.
  //
  // `created_by` is the accepting owner, resolved server-side by the route —
  // the same attribution the objects tab records when it registers a pending
  // object, so a repo-sourced row is not the one row nobody appears to own.
  //
  // A new row is inserted not ready (`image_available: false`): the Objects
  // page marks it (`probe-tiles`).
  const repoInserts: IngestObjectInsert[] = [];
  for (const objectId of objectChanges.newObjectIds) {
    const repoRow = repoObjMap.get(objectId);
    if (!repoRow) continue;
    repoInserts.push({
      object_id: objectId,
      title: (repoRow.title as string | null) ?? null,
      featured: Boolean(repoRow.featured),
      creator: (repoRow.creator as string | null) ?? null,
      description: (repoRow.description as string | null) ?? null,
      source_url: (repoRow.source_url as string | null) ?? null,
      period: (repoRow.period as string | null) ?? null,
      year: (repoRow.year as string | null) ?? null,
      object_type: (repoRow.object_type as string | null) ?? null,
      subjects: (repoRow.subjects as string | null) ?? null,
      source: (repoRow.source as string | null) ?? null,
      credit: (repoRow.credit as string | null) ?? null,
      thumbnail: (repoRow.thumbnail as string | null) ?? null,
      alt_text: (repoRow.alt_text as string | null) ?? null,
      dimensions: (repoRow.dimensions as string | null) ?? null,
      extra_columns: (repoRow.extra_columns as string | null) ?? null,
      image_available: false,
      created_by: actorUserId,
      origin: "repo",
    });
  }
  addGitHubObjectOrder(payload, repoInserts, repoObjRows, d1Objects);
  const fileInserts: IngestObjectInsert[] = [];
  for (const objectId of objectChanges.unregisteredObjectIds ?? []) {
    fileInserts.push({
      object_id: objectId,
      title: null,
      featured: false,
      creator: null,
      description: null,
      source_url: null,
      period: null,
      year: null,
      object_type: null,
      subjects: null,
      source: null,
      credit: null,
      thumbnail: null,
      image_available: false,
      created_by: actorUserId,
      origin: "repo",
    });
  }
  payload.objects.insert.push(...fileInserts);

  // Object updates, to the row the author reviewed (see fullSyncObjectUpdates).
  const { update: objectUpdates, notSent: updatesNotSent } = fullSyncObjectUpdates(
    objectChanges, repoObjMap, rawAltById, d1Objects,
  );
  const reviewedObjectUpdates = withGitHubSpelling(objectUpdates, objectRenames);
  payload.objects.update = reviewedObjectUpdates;
  respellPlacement(payload.objects);

  // Object removes go through the doc so the snapshot's orphan-delete drops the
  // D1 row (and nothing resurrects it on the next snapshot). Each names the D1
  // id the author was shown (`removedDocIds`) and is sent only for a row holding
  // that key AND that id: an object deleted and re-created under the same key
  // since the check is not the one the author chose, a row sharing its key is
  // left alone, and a choice with no id removes nothing. Never for an object
  // back in the sheet read here, and never for a course item: it belongs to the
  // course, not the repo, and is absent from objects.csv until the group's
  // first publish (the DO's remove path refuses them too — defence in depth on
  // a cross-project guarantee).
  payload.objects.remove = objectChanges.removedObjectIds.flatMap((objectId) => {
    const docId = ownValue(objectChanges.removedDocIds ?? {}, objectId);
    const row = d1Objects.find((o) => o.object_id === objectId && o.id === docId);
    if (!row || row.course_project_id != null || repoObjMap.has(objectId)) return [];
    return [{ objectId, docId: row.id }];
  });

  // missing_from_repo, per row: set for a row whose key is absent from the repo
  // and which is not being removed (and is not compositor-origin); clear for a
  // row whose key is present again. By row id, since a removal names one row
  // and another row can share its key.
  const removedRowIds = new Set(payload.objects.remove.map((r) => r.docId));
  for (const row of d1Objects) {
    const present = repoObjMap.has(row.object_id);
    if (!present && !removedRowIds.has(row.id) && row.origin !== "compositor") {
      residue.missingFromRepoSet.push(row.id);
    }
    if (present && row.missing_from_repo) residue.missingFromRepoClear.push(row.id);
  }

  // --- Stories (project.csv + per-story CSVs for inserts) -----------------
  const { content: projectCsvContent, name: projectFileName } = await readSiteSheet("project", atHead);
  const repoStoryRows = projectCsvContent
    ? mapProjectCsv(readRepoSheet(projectCsvContent, projectSheet(projectFileName), null), projectId)
    : [];
  const repoStoryMap = new Map(repoStoryRows.map((r) => [r.story_id as string, r]));

  for (const storyId of storyChanges.accept) {
    const r = repoStoryMap.get(storyId);
    if (!r) continue;
    // Only the fields chosen as GitHub's are stated; the document keeps every
    // other one. Empty strings ARE applied — no `|| undefined` skipping (a
    // repo-side clear must land, not leave a forever-dirty field).
    const repo = repoFieldsOf(storyChanges.fieldChoices, storyId);
    const update = Object.fromEntries(
      Object.entries(ACCEPTED_STORY_VALUES).filter(([field]) => repo.has(field)).map(([field, valueOf]) => [field, valueOf(r)]),
    );
    if (Object.keys(update).length > 0) payload.stories.update.push({ storyId, ...update });
    if (repo.has("extraColumns")) {
      residue.storyD1Update.push({ storyId, extraColumns: (r.extra_columns as string | null | undefined) ?? null });
    }
  }

  const layerAtHead = readOncePerName((filename: string) => atHead(`telar-content/texts/stories/${filename}`));
  for (const storyId of storyChanges.insertNew) {
    const r = repoStoryMap.get(storyId);
    if (!r) continue;
    // Resolve any layerN_content cell that points at a texts/stories/*.md file
    // to the file's body before mapping (a published story stores only the
    // filename); missing files degrade to inline handling, as the importer does.
    let storyCsvRaw: string | null = null;
    const storyCsvContent = await contentAtRef(token, owner, repo, storySheetPath(storyId), head, undefined, (raw) => { storyCsvRaw = raw; });
    let steps: SyncIngestStep[] = [];
    let layers: SyncIngestLayer[] = [];
    if (storyCsvContent) {
      residue.storiesRead.push(storyId);
      residue.storyFileReads.push(...(await storyFileRead(storySheetPath(storyId), storyCsvRaw)));
      const resolvedRows = await resolveLayerFileReferences(
        readRepoSheet(storyCsvContent, storySheet(storyId), null),
        layerAtHead,
      );
      const { steps: stepRows, layers: layerRows } = mapStoryCsv(resolvedRows, 0);
      steps = stepRows.map((s) => ({
        step_number: s.step_number,
        kind: s.kind,
        object_id: (s.object_id as string | null) ?? "",
        x: (s.x as number | null) ?? null,
        y: (s.y as number | null) ?? null,
        zoom: (s.zoom as number | null) ?? null,
        page: (s.page as string | null) ?? "",
        question: (s.question as string | null) ?? "",
        answer: (s.answer as string | null) ?? "",
        alt_text: (s.alt_text as string | null) ?? "",
        clip_start: (s.clip_start as string | null) ?? "",
        clip_end: (s.clip_end as string | null) ?? "",
        loop: (s.loop as string | null) ?? "",
        extra_columns: extrasOnWire(s.extra_columns),
      }));
      // The DO threads layers by position into the `steps` array built just
      // above, so `stepIndex` is the right one of the two parent keys a
      // MappedLayer carries — `stepNumber` is what D1 pairs on, and the two
      // differ whenever the CSV states step numbers that are not 1..N in order.
      layers = layerRows.map((l) => ({
        step_index: l.stepIndex,
        layer_number: l.layer_number,
        title: (l.title as string | null) ?? "",
        button_label: (l.button_label as string | null) ?? "",
        content: (l.content as string | null) ?? "",
      }));
    }
    payload.stories.insert.push({
      storyId,
      title: String((r.title as string | null | undefined) ?? ""),
      subtitle: String((r.subtitle as string | null | undefined) ?? ""),
      byline: String((r.byline as string | null | undefined) ?? ""),
      isPrivate: Boolean(r.private),
      showSections: Boolean(r.show_sections),
      steps,
      layers,
    });
    // A new row holds none already, so a story with no custom cells needs no write.
    const extraColumns = (r.extra_columns as string | null | undefined) ?? null;
    if (extraColumns !== null) residue.storyD1Insert.push({ storyId, extraColumns });
  }

  // Accepted content, read at the same commit as everything above. The row
  // fields of a story accepted with its content travel in the same ingest,
  // and the collaboration object applies both or neither.
  const acceptContent = storyChanges.acceptContent ?? [];
  const expectedOf = (storyId: string): string => {
    const recorded = storyChanges.contentExpected;
    const expected = recorded && Object.hasOwn(recorded, storyId) ? recorded[storyId] : undefined;
    if (typeof expected !== "string" || expected === "") {
      throw new Error(`accepted content for ${storyId} carries no expected hash from its review`);
    }
    return expected;
  };
  const expectedHashes = acceptContent.map((storyId) => [storyId, expectedOf(storyId)] as const);
  const contentRows = await readStoriesForAccept({ token, owner, repo }, head, acceptContent);
  residue.storiesRead.push(...acceptContent);
  if (expectedHashes.length > 0) {
    payload.stories.replaceContent = expectedHashes.map(([storyId, expected]) => ({
      storyId,
      expected,
      ...contentOnWire(contentRows.get(storyId)!),
    }));
  }

  // Accepted pages, GitHub's version read at the same commit, from the file
  // the check read for each.
  await addAcceptedPages(payload, changes, { token, owner, repo }, head);

  // --- Config (_config.yml) + telar_version heal --------------------------
  const configYmlContent = await atHead(CONFIG_YML_PATH);
  const repoConfigFields = configYmlContent
    ? extractConfigFields(configYmlContent)
    : ({} as Record<ManagedConfigField, string | null>);
  for (const key of configChanges.accept) {
    if (!MANAGED_CONFIG_FIELDS.includes(key as ManagedConfigField)) continue;
    const raw = repoConfigFields[key as ManagedConfigField] ?? null;
    // The kinds are D1 only: the column never passes through the shared document.
    if (key === "glossary_kinds_json") residue.glossaryKindsAccept = raw;
    else pushAcceptedConfig(payload.config, key as ManagedConfigField, raw);
  }

  const d1ConfigRows = await db.select().from(project_config).where(eq(project_config.project_id, projectId));
  const d1Config = (d1ConfigRows[0] as unknown as Record<string, unknown> | undefined) ?? {};
  const repoTelarVersion = siteVersionFrom(configYmlContent, null);
  const d1TelarVersion = (d1Config.telar_version as string | null | undefined) ?? null;
  // Heal only when the repo is AHEAD (an external upgrade via upgrade.py or a
  // GitHub Action). "behind" is the user's call, surfaced on the dashboard. This
  // is the L3 fix: computed server-side here, never from a caller-passed diff.
  if (repoTelarVersion && repoTelarVersion !== d1TelarVersion) {
    if (!d1TelarVersion) {
      residue.telarVersionHeal = repoTelarVersion;
    } else if (
      compareVersions(normalizeVersionTag(repoTelarVersion), normalizeVersionTag(d1TelarVersion)) > 0
    ) {
      residue.telarVersionHeal = repoTelarVersion;
    }
  }
  if (residue.telarVersionHeal) payload.telarVersion = residue.telarVersionHeal;
  // Recomputed against the tree read above, whatever the author selected.
  // The site's address is the one this accept leaves: an accepted url or baseurl over D1's.
  const acceptedConfig = new Map(payload.config.map((entry) => [entry.key, entry.value]));
  const siteConfig = {
    url: acceptedConfig.has("url") ? String(acceptedConfig.get("url")) : d1ConfigRows[0]?.url,
    baseurl: acceptedConfig.has("baseurl") ? String(acceptedConfig.get("baseurl")) : d1ConfigRows[0]?.baseurl,
  };
  payload.objects.update = withRecomputedImages(reviewedObjectUpdates, await recomputedImages(
    siteConfig, d1Objects, reviewedObjectUpdates, { tree: objectsTree, truncated: objectsTreeTruncated },
    async () => siteVersionFrom(configYmlContent, d1TelarVersion),
  ));

  // --- Glossary (glossary.csv) --------------------------------------------
  Object.assign(payload.glossary, await heldTermRemoval(db, projectId, atHead));
  if (glossaryChanges.insertNew.length > 0 || glossaryChanges.accept.length > 0) {
    const { content: glossaryCsvContent, name: glossaryFileName } = await readSiteSheet("glossary", atHead);
    const repoTerms = readRepoSheet(glossaryCsvContent, glossarySheet(glossaryFileName), null);
    const repoTermMap = new Map(publishedRowPerTermId(repoTerms).filter((r) => !isHeldTermId(r.term_id ?? "")).map((r) => [r.term_id as string, r]));
    // The repo row's custom columns, collected exactly as import collects them.
    const extraColumnsOf = (row: Record<string, string>): string | null => {
      const { extras } = collectExtraColumns(row, KNOWN_GLOSSARY_KEYS);
      return Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;
    };
    for (const termId of glossaryChanges.insertNew) {
      const t = repoTermMap.get(termId);
      if (!t) continue;
      payload.glossary.insert.push({
        termId, title: t.title ?? "", definition: t.definition ?? "", kind: rowKind(t),
      });
      residue.glossaryD1Insert.push({
        termId,
        relatedTerms: t.related_terms || null,
        extraColumns: extraColumnsOf(t),
      });
    }
    for (const termId of glossaryChanges.accept) {
      const t = repoTermMap.get(termId);
      if (!t) continue;
      // As for a story: only the fields chosen as GitHub's are written.
      const repo = repoFieldsOf(glossaryChanges.fieldChoices, termId);
      const githubTermValues = (values: Record<string, string | null>) =>
        Object.fromEntries(Object.entries(values).filter(([field]) => repo.has(field)));
      const doc = githubTermValues({ title: t.title ?? "", definition: t.definition ?? "", kind: rowKind(t) });
      const d1Only = githubTermValues({ related_terms: t.related_terms || null, extra_columns: extraColumnsOf(t) });
      if (Object.keys(doc).length > 0) payload.glossary.update.push({ termId, ...doc });
      if (Object.keys(d1Only).length > 0) {
        residue.glossaryD1Update.push({ termId, relatedTerms: d1Only.related_terms, extraColumns: d1Only.extra_columns });
      }
    }
  }

  return { payload, residue, updatesNotSent };
}

/**
 * `removeHeld` when D1 holds a term whose id publishes none (`isHeldTermId`)
 * that the repository's glossary.csv carries unchanged (`heldTermsTheRepoHolds`).
 * Such a term is removed through the document, which the snapshot then writes
 * to D1: a D1 delete alone is written back by the snapshot from the document.
 * glossary.csv is read only when D1 holds such a term.
 */
async function heldTermRemoval(
  db: ReturnType<typeof getDb>,
  projectId: number,
  atHead: (path: string) => Promise<string | null>,
): Promise<{ removeHeld?: HeldTermRemoval[] }> {
  const terms = await db
    .select({
      id: glossary_terms.id,
      term_id: glossary_terms.term_id,
      title: glossary_terms.title,
      definition: glossary_terms.definition,
      related_terms: glossary_terms.related_terms,
      kind: glossary_terms.kind,
      extra_columns: glossary_terms.extra_columns,
    })
    .from(glossary_terms)
    .where(eq(glossary_terms.project_id, projectId));
  if (!terms.some((t) => isHeldTermId(t.term_id))) return {};
  const glossaryRead = await readSiteSheet("glossary", atHead);
  const repoRows = readRepoSheet(glossaryRead.content, glossarySheet(glossaryRead.name), null);
  const removable = heldTermsTheRepoHolds(terms, repoRows);
  if (removable.length === 0) return {};
  return {
    removeHeld: removable.map((t) => ({ dbId: t.id, title: t.title ?? "", definition: t.definition ?? "", kind: t.kind ?? "" })),
  };
}

/**
 * Applies the user's selected full-sync changes by routing every content change
 * THROUGH the collaboration DO's /ingest-sync endpoint, so the snapshot pipeline
 * performs the D1 writes it would otherwise revert. The D1-only residue is
 * written directly, split around the ingest by whether the rows must already
 * exist (see resolveFullSyncPayload / FullSyncResidue).
 *
 * `actorUserId` must be the caller's server-resolved owner: it is written as
 * `created_by` on every inserted object and never round-trips through a form.
 *
 * Returns the new HEAD SHA. A failed ingest throws WITHOUT advancing head_sha,
 * so the divergence banner persists and a retry is safe (idempotent by key).
 * The same holds for the content residue written after the ingest: only the
 * two genuinely re-derivable writes (object `origin`, the version heal) are
 * allowed to fail quietly.
 */
export async function applyFullSyncChanges(
  projectId: number,
  changes: FullSyncChanges,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  actorUserId: number,
  env: FullSyncEnv,
): Promise<FullSyncApplied> {
  // Before the lease, the first write.
  checkedHeadSha(changes);
  refuseUnseenGitHubFields(changes.objects);
  refuseRowsWithoutChoices(changes);
  // The check applies only to the project it was computed for, and only while
  // head_sha is still the base it was computed against: otherwise what it
  // listed as GitHub's changes is not what lies between the recorded head and
  // its HEAD. Refused before the lease and before anything is read or written.
  // The base is also what the story trees are read from and what head_sha
  // advances from, compare-and-set, which covers a head another writer records
  // after this read ("Use Compositor version" refuses a moved base the same
  // way before its lease, and records compare-and-set after its order ingest).
  const base = changes.baseSha;
  if (changes.projectId !== projectId || base === undefined) throw new SyncBaseStale();
  if (base !== null && !/^[0-9a-f]{40}$/.test(base)) throw new SyncBaseStale();
  const { projects } = await import("~/db/schema");
  const [recordedRow] = await db
    .select({ head_sha: projects.head_sha })
    .from(projects)
    .where(eq(projects.id, projectId));
  if ((recordedRow?.head_sha ?? null) !== base) throw new SyncBaseStale();
  // The whole apply under the objects lease: it removes and registers objects
  // through the document, and no publish may serialise objects.csv from D1
  // while it does. A refused lease fails the apply as any other failure.
  const held = await holdOperationLease(
    env as unknown as Env, projectId, actorUserId, "objects",
    async (landed) => {
      const result = await applyFullSyncUnderLease(projectId, changes, token, owner, repo, db, actorUserId, env, base);
      landed();
      return result;
    },
  );
  if (held.refused) throw new Error("apply-full-sync refused: another operation holds the lease");
  return held.value;
}

/**
 * What an accept did with head_sha. `newHeadSha` is the commit it recorded
 * as synced, or null when it recorded none: because the story or page files at
 * the check's HEAD could not be read to a conclusion (`storyFilesInconclusive`,
 * `pageFilesInconclusive`). The accepted changes are applied, and the site
 * stays divergent. An accept the collaboration object could not take whole
 * applies nothing and throws (`refuseHeldBackIngest`).
 */
export interface FullSyncApplied {
  newHeadSha: string | null;
  storyFilesInconclusive: boolean;
  /** As `storyFilesInconclusive`, for the page files (`pageFilesUnread`). */
  pageFilesInconclusive: boolean;
}

/** What `/ingest-sync` answers, as far as the accept reads it. */
interface IngestSyncAnswer {
  /** An all-or-nothing ingest that wrote nothing, for what the lists below name (`allOrNothing`). */
  heldBack?: boolean;
  skipped?: Record<string, string[]>;
  /** Updates with a field left because the Compositor's value changed since the check. */
  changedSinceReview?: { objectUpdate?: string[] };
  /** Skipped because another object holds the key: re-created since the check. */
  superseded?: { objectUpdate?: string[]; objectOrder?: string[] };
  /** What each object removal met; `superseded` as above. */
  removals?: { superseded?: string[] };
  /** Inserts the document took and D1 refused, by arm (`objectInsert`, `glossaryInsert`, `pageInsert`). */
  failed?: Record<string, string[]>;
  refused?: Record<string, number[]>;
  /** Inserts an all-or-nothing ingest was held back for, their row over D1's row size. */
  oversized?: { objectInsert?: string[] };
  content?: { applied?: string[]; alreadyApplied?: string[]; changedSinceReview?: string[]; failed?: string[] };
  pageContent?: { applied?: number[]; alreadyApplied?: number[]; changedSinceReview?: number[]; failed?: number[] };
  /** What each page removal met, as `pageContent`. */
  pageRemove?: { applied?: number[]; alreadyApplied?: number[]; changedSinceReview?: number[]; failed?: number[] };
  /** The id of each page inserted, by slug. */
  insertedPages?: Record<string, number>;
}

/**
 * The accepted content the ingest did not apply, or null. A story sent and
 * named neither applied nor already applied counts as failed.
 */
function contentNotApplied(payload: SyncIngestPayload, answer: IngestSyncAnswer): StoryContentNotApplied | null {
  const sent = payload.stories.replaceContent ?? [];
  if (sent.length === 0) return null;
  const outcome = answer.content ?? {};
  const changed = outcome.changedSinceReview ?? [];
  const done = new Set([...(outcome.applied ?? []), ...(outcome.alreadyApplied ?? [])]);
  const failed = sent.map((e) => e.storyId).filter((id) => !done.has(id) && !changed.includes(id));
  return changed.length > 0 || failed.length > 0 ? new StoryContentNotApplied(changed, failed) : null;
}

/**
 * The accepted pages the ingest did not apply, or null. A page sent and named
 * neither applied nor already applied counts as failed.
 */
function pageContentNotApplied(payload: SyncIngestPayload, answer: IngestSyncAnswer): PageContentNotApplied | null {
  const content = pageArmNotApplied(payload.pages?.replaceContent ?? [], answer.pageContent);
  const removals = pageArmNotApplied(payload.pages?.remove ?? [], answer.pageRemove);
  const changed = [...content.changed, ...removals.changed];
  const failed = [...content.failed, ...removals.failed];
  return changed.length > 0 || failed.length > 0 ? new PageContentNotApplied(changed, failed) : null;
}

/** The page ids one page arm sent that its outcome names changed since review, or neither applied nor already applied. */
function pageArmNotApplied(
  sent: ReadonlyArray<{ pageId: number }>,
  outcome: IngestSyncAnswer["pageContent"],
): { changed: number[]; failed: number[] } {
  const changed = outcome?.changedSinceReview ?? [];
  const done = new Set([...(outcome?.applied ?? []), ...(outcome?.alreadyApplied ?? [])]);
  return { changed, failed: sent.map((e) => e.pageId).filter((id) => !done.has(id) && !changed.includes(id)) };
}

/**
 * The accepted new rows D1 refused after the document took them, in any insert
 * arm the answer reports in `failed`, or null: object rows first, as
 * `ObjectsNotAdded`; the other arms as `InsertsNotAdded`. Found only by the
 * write, so the rest of the ingest has landed; the accept stops before
 * head_sha moves, as the objects page's apply keeps objects_read_sha for a row
 * it did not add.
 */
function insertsNotAdded(answer: IngestSyncAnswer): ObjectsNotAdded | InsertsNotAdded | null {
  const objectIds = ingestList(answer.failed, "objectInsert");
  if (objectIds.length > 0) return new ObjectsNotAdded(objectIds);
  const others = Object.entries(answer.failed ?? {}).filter(([arm, keys]) => arm.endsWith("Insert") && keys.length > 0);
  return others.length > 0 ? new InsertsNotAdded(Object.fromEntries(others)) : null;
}

/**
 * Log what the ingest skipped. An update whose entity is absent
 * from the doc is skipped (deleted concurrently, or a legacy D1-only row the
 * doc never held — the same snapshot removes such rows). The accept still
 * succeeds for everything else and head_sha advances (a skipped row's fate is
 * identical with or without this apply), but skips must be visible in the
 * logs, not silently absorbed into a success response. An object update
 * whose key another object holds never reaches here: the collaboration object
 * holds the whole accept back for it (`refuseHeldBackIngest`), as it does for
 * an entry its boundary refused as malformed (`entriesRefusal`).
 */
function logIngestSkips(projectId: number, ingestBody: IngestSyncAnswer): void {
  try {
    const skippedEntries = Object.entries(ingestBody.skipped ?? {}).filter(([, ids]) => ids.length > 0);
    if (skippedEntries.length > 0) {
      console.error(
        `[full-sync] ingest skipped entities for project ${projectId}:`,
        JSON.stringify(Object.fromEntries(skippedEntries)),
      );
    }
  } catch {
    // Diagnostic only — an unparseable body never fails a 200 ingest.
  }
}

/**
 * Post the full sync's one ingest, all or nothing (`allOrNothing`), and
 * answer its body. A non-200 answer throws.
 */
async function postFullSyncIngest(
  env: FullSyncEnv,
  projectId: number,
  payload: SyncIngestPayload,
): Promise<IngestSyncAnswer> {
  const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
  const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
  const res = await stub.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, allOrNothing: true }),
    }),
  );
  if (!res.ok) throw new Error(`ingest-sync failed: DO returned ${res.status}`);
  return (await res.json().catch(() => ({}))) as IngestSyncAnswer;
}

/**
 * Throws for an ingest the collaboration object held back, which wrote
 * nothing: entries it cannot store (`entriesRefusal`), a story's, then a
 * page's content changed since the check, or the
 * story or page edited away (`contentHeldBack`)
 * (`StoryContentNotApplied`, `PageContentNotApplied`), or an object edited
 * in the Compositor since, a field changed or the row re-created
 * (`ObjectsChangedSinceReview`); a hold naming none of them is stale
 * (`SyncBaseStale`). The author checks again; head_sha has not moved. An
 * answer naming any of them is refused so whether or not it says it held
 * back: the record must not move over it.
 */
function refuseHeldBackIngest(answer: IngestSyncAnswer): void {
  const refusal = entriesRefusal(answer);
  if (refusal) throw refusal;
  const stories = contentHeldBack(answer.content, answer.heldBack === true);
  if (stories.length > 0) throw new StoryContentNotApplied(stories, []);
  const pages = [answer.pageContent, answer.pageRemove].flatMap((o) => contentHeldBack(o, answer.heldBack === true));
  if (pages.length > 0) throw new PageContentNotApplied(pages, []);
  const objects = objectChangesAnswer(answer);
  const edited = objectsEditedSinceReview(objects);
  if (edited.length > 0) throw new ObjectsChangedSinceReview(edited);
  if (objects.heldBack) throw new SyncBaseStale();
}

/**
 * The stories or pages a held-back ingest names for their content: changed
 * since the check, or, where the ingest was held back, found missing or
 * unreadable as it was planned. Both are edits made in the Compositor since
 * the check. A content failure in an ingest that was not held back came after
 * its write, and is answered as a failure to save (`contentNotApplied`).
 */
function contentHeldBack<T>(outcome: { changedSinceReview?: T[]; failed?: T[] } | undefined, heldBack: boolean): T[] {
  return [...(outcome?.changedSinceReview ?? []), ...(heldBack ? outcome?.failed ?? [] : [])];
}

/** Stores the repository's glossary kinds the author took, when they took them. */
async function writeAcceptedKinds(db: ReturnType<typeof getDb>, projectId: number, kinds: string | null, now: string) {
  if (kinds === null) return;
  await db
    .update(project_config)
    .set({ glossary_kinds_json: kinds, updated_at: now })
    .where(eq(project_config.project_id, projectId));
}

/** The full-sync apply, holding the lease. See `applyFullSyncChanges`. */
async function applyFullSyncUnderLease(
  projectId: number,
  changes: FullSyncChanges,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  actorUserId: number,
  env: FullSyncEnv,
  base: string | null,
): Promise<FullSyncApplied> {
  // 1. Resolve the typed payload + D1-only residue from the repo files, all
  //    read at one commit: the check's HEAD, or HEAD resolved once here. That
  //    commit is the one head_sha records; a commit landing after it is not
  //    read, so it is not recorded as synced.
  const head = checkedHeadSha(changes) ?? (await getRepoHead(token, owner, repo));
  await finishPendingObjectOps(env, db, projectId, { token, owner, repo }, { head, stale: () => new SyncBaseStale() });
  const { payload, residue, updatesNotSent } = await resolveFullSyncPayload(
    projectId, changes, token, owner, repo, db, actorUserId, head,
  );
  const pageFiles = await addPageFileArms(projectId, payload, changes, db, { token, owner, repo }, base, head);
  // Under the lease and before the first write, the base checked before
  // taking it is checked again: an apply that landed in between has moved it.
  await refuseMovedBase(db, projectId, base);
  // An update whose row was re-created in the Compositor since the check
  // holds the whole accept back, as the collaboration object holds it back for
  // a row it finds re-created (`allOrNothing`).
  const recreated = recreatedSinceReview(changes.objects, updatesNotSent);
  if (recreated.length > 0) throw new ObjectsChangedSinceReview(recreated);
  const now = new Date().toISOString();

  // 2. Ingest through the DO — the one true commit point, all or nothing. A
  //    non-200 aborts the apply: head_sha stays put, the banner persists, and
  //    a retry is safe. One the object held back wrote nothing and throws here.
  const ingestBody = await postFullSyncIngest(env, projectId, payload);
  refuseHeldBackIngest(ingestBody);

  // 3. Residue part 1 — snapshot-safe columns (idempotent, and the snapshot
  //    preserves them by omission), written once the ingest has taken the
  //    accept: missing_from_repo flags and the D1-only glossary columns for
  //    updated terms.
  for (const rowId of residue.missingFromRepoSet) {
    await db
      .update(objects)
      .set({ missing_from_repo: true, updated_at: now })
      .where(and(eq(objects.project_id, projectId), eq(objects.id, rowId)));
  }
  for (const rowId of residue.missingFromRepoClear) {
    await db
      .update(objects)
      .set({ missing_from_repo: false, updated_at: now })
      .where(and(eq(objects.project_id, projectId), eq(objects.id, rowId)));
  }
  for (const { termId, relatedTerms, extraColumns } of residue.glossaryD1Update) {
    await db
      .update(glossary_terms)
      .set({ ...definedColumns({ related_terms: relatedTerms, extra_columns: extraColumns }), updated_at: now })
      .where(and(eq(glossary_terms.project_id, projectId), eq(glossary_terms.term_id, termId)));
  }

  for (const { storyId, extraColumns } of residue.storyD1Update) {
    await db
      .update(stories)
      .set({ extra_columns: extraColumns, updated_at: now })
      .where(and(eq(stories.project_id, projectId), eq(stories.story_id, storyId)));
  }

  // Accepted content the ingest took but could not save, and an accepted new
  // row D1 refused, stop the accept before head_sha moves (step 6);
  // stories are answered first, then pages, then objects. Everything else the
  // ingest applied stands, with its residue below, and a retry is safe.
  const notApplied = contentNotApplied(payload, ingestBody)
    ?? pageContentNotApplied(payload, ingestBody)
    ?? insertsNotAdded(ingestBody);
  logIngestSkips(projectId, ingestBody);

  // 4. Residue part 2a — CONTENT on rows the ingest just wrote: the D1-only
  //    glossary columns for inserted terms. These rows could not exist before
  //    the ingest, so the write cannot move earlier; it must still succeed
  //    before head_sha does, and so it is deliberately outside the
  //    log-and-continue below.
  //
  //    Letting it fail quietly is not cosmetic. head_sha would advance with the
  //    column missing from D1, and that revision becomes the base of the next
  //    three-way diff — which then reads the absent column as an editor-only
  //    change and SUPPRESSES it, so the repo value is never offered again and
  //    the author is never told. A throw leaves head_sha where it was, the
  //    divergence banner up, and a retry safe: the DO's skip-if-present finds
  //    the terms already in the document and this residue runs again.
  for (const { termId, relatedTerms, extraColumns } of residue.glossaryD1Insert) {
    await db
      .update(glossary_terms)
      .set({ related_terms: relatedTerms, extra_columns: extraColumns, updated_at: now })
      .where(and(eq(glossary_terms.project_id, projectId), eq(glossary_terms.term_id, termId)));
  }

  for (const { storyId, extraColumns } of residue.storyD1Insert) {
    await db
      .update(stories)
      .set({ extra_columns: extraColumns, updated_at: now })
      .where(and(eq(stories.project_id, projectId), eq(stories.story_id, storyId)));
  }

  await writeAcceptedKinds(db, projectId, residue.glossaryKindsAccept, now);

  // 5. Residue part 2b — the genuinely cosmetic write: the version heal
  //    re-runs on the next load. It is not content and is not read back as a
  //    base, so a failure here logs and the apply stands.
  try {
    const healPatch = configHealPatch(residue, now);
    if (healPatch !== null) {
      await db
        .update(project_config)
        .set(healPatch)
        .where(eq(project_config.project_id, projectId));
    }
  } catch (err) {
    console.error("[full-sync] post-ingest cosmetic residue write failed (head_sha still advances)", err);
  }

  if (notApplied) throw notApplied;
  // Every story read is applied: record the file each was read from.
  await recordStorySheetReads(db, projectId, residue.storiesRead);
  await recordStoryFileReads(db, projectId, residue.storyFileReads);

  // 6. Bump head_sha to the commit read + activity metadata (projects is not
  //    snapshot-managed). Only over story and page files the author was shown:
  //    head_sha records a commit as synced, and the next publish overwrites
  //    any story or page edit it acknowledges. Two conditions, both required,
  //    for the story files and again for the page files:
  //    - the check the dialog showed read them to a conclusion
  //      (`storyContentChecked`, `pageContentChecked`). The accept is pinned to
  //      that check's head and a later commit is refused as stale, so a
  //      concluded check listed every change at this head and base. Anything
  //      but `true`, as an older dialog sends, keeps the head;
  //    - the files conclude now, read by the server, since the flag says what
  //      the dialog saw and not what the trees hold: the story trees, and the
  //      accept's own page-file check (`addPageFileArms`), which reads the
  //      pages folder whether or not the project holds a page.
  //    It advances compare-and-set from the check's base, so a head another
  //    writer recorded meanwhile is kept, and the answer then names no commit
  //    as synced.
  const held = await headHeldForFiles(projectId, changes, { token, owner, repo }, base, head, pageFiles);
  if (held) return held;
  // The record goes in the same compare-and-set as the head, built from the
  // accept's check and the ingest's receipts, never from a read of D1 after it.
  const recordJson = acceptedRecordJson(pageFiles!, ingestBody);
  // Imported here: github-status.server imports this module.
  const { bumpProjectHeadFrom } = await import("~/lib/github-status.server");
  const recorded = await bumpProjectHeadFrom(
    db, projectId, base, head, Date.parse(now), { last_synced_at: now, page_files_json: recordJson },
  );

  return { newHeadSha: recorded ? head : null, storyFilesInconclusive: false, pageFilesInconclusive: false };
}

/**
 * The accept's answer when head_sha is held for the story or the page files
 * (step 6 of `applyFullSyncUnderLease`), or null when neither holds it. The
 * page files hold it unless the check the dialog showed concluded them and
 * the accept's own check (`addPageFileArms`) did too.
 */
async function headHeldForFiles(
  projectId: number,
  changes: FullSyncChanges,
  access: { token: string; owner: string; repo: string },
  base: string | null,
  head: string,
  pageFiles: AcceptedPageFiles | null,
): Promise<FullSyncApplied | null> {
  const storyFilesInconclusive =
    changes.storyContentChecked !== true || (await storyFilesUnread(projectId, access, base, head));
  const pageFilesInconclusive = changes.pageContentChecked !== true || pageFiles === null;
  if (pageFilesInconclusive) console.warn(`[full-sync] project ${projectId}: head_sha kept, page files not concluded`);
  if (!storyFilesInconclusive && !pageFilesInconclusive) return null;
  return { newHeadSha: null, storyFilesInconclusive, pageFilesInconclusive };
}

/**
 * Whether the story subtrees from `base` (the check's base) to `head` fail to
 * conclude, as the check's tree reading
 * decides it; with no base, at `head` alone. A read that throws counts as not
 * concluded.
 */
async function storyFilesUnread(
  projectId: number,
  access: { token: string; owner: string; repo: string },
  base: string | null,
  head: string,
): Promise<boolean> {
  try {
    const reason = await storyTreesInconclusive(access, base, head);
    if (reason === null) return false;
    console.warn(`[full-sync] project ${projectId}: head_sha kept, story files not concluded: ${reason}`);
  } catch (err) {
    console.warn(`[full-sync] project ${projectId}: head_sha kept, story trees not read`, err);
  }
  return true;
}

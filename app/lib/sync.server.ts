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
 * @version v1.4.2-beta
 */

import { eq, and } from "drizzle-orm";
import { objects, steps, stories, project_config, glossary_terms } from "~/db/schema";
import { getFileContent, getFileAtRef, getRepoTree, getRepoHead } from "~/lib/github.server";
import { parseTelarCsv, mapObjectsCsv, mapProjectCsv, mapStoryCsv, resolveLayerFileReferences } from "~/lib/import.server";
import { compareVersions } from "~/lib/upgrade.server";
import { canonicalExtraColumns } from "~/lib/extra-columns.server";
import { normalizeVersionTag } from "~/lib/version";
import { findInYamlBlock } from "~/lib/config-yaml-block.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import type { getDb } from "~/lib/db.server";

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
   * surfaces with an explicit per-field choice (default keep mine). Empty in
   * two-way fallback mode. Repo-only fields sit in `changedFields` but not here.
   */
  conflictFields: SyncField[];
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

export interface SyncDiff {
  newObjects: NewObject[];
  changedObjects: ChangedObject[];
  missingObjects: MissingObject[];
  /** Image files in objects/ that aren't in objects.csv or D1 */
  unregisteredFiles: UnregisteredFile[];
  /**
   * Three-way only. Count of editor-only object changes suppressed from this
   * diff (fields whose only mover was the editor, plus suppressed
   * editor-deletions / editor-creations). Undefined in two-way mode.
   * computeFullSyncDiff folds this into FullSyncDiff.suppressedEditorOnly.
   */
  suppressedEditorOnly?: number;
}

// ---------------------------------------------------------------------------
// Managed file paths (repo-relative) — the four files the sync diff compares.
// Shared by the head fetches and the three-way base fetches.
// ---------------------------------------------------------------------------

const OBJECTS_CSV_PATH = "telar-content/spreadsheets/objects.csv";
const PROJECT_CSV_PATH = "telar-content/spreadsheets/project.csv";
const GLOSSARY_CSV_PATH = "telar-content/spreadsheets/glossary.csv";
const CONFIG_YML_PATH = "_config.yml";

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
    return canonicalExtraColumns((row.extra_columns as string | null | undefined) ?? null);
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
    return canonicalExtraColumns((d1Obj.extra_columns as string | null | undefined) ?? null);
  }
  const v = (d1Obj[field] as string | null | undefined) ?? null;
  return v === null ? "" : String(v);
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
  /** Per-object, per-field choices: "repo" | "d1" */
  fieldChoices: Record<string, Record<string, "repo" | "d1">>;
  /** object_ids to delete from D1 (missing objects user chose to remove) */
  removedObjectIds: string[];
  /** object_ids to register from unregistered image files in objects/ */
  unregisteredObjectIds: string[];
}

// ---------------------------------------------------------------------------
// D1 batch helper (matches import.server.ts pattern)
// ---------------------------------------------------------------------------

function chunkForD1<T>(colCount: number, rows: T[]): T[][] {
  const maxRows = Math.floor(100 / colCount);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += maxRows) {
    chunks.push(rows.slice(i, i + maxRows));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// computeSyncDiff
// ---------------------------------------------------------------------------

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
): Promise<SyncDiff> {
  // Three-way vs two-way is decided by the caller and threaded in as the base
  // objects.csv CONTENT, not a ref: `undefined` means two-way (no base — the
  // objects-tab caller passes nothing); a string or `null` means three-way,
  // where `null` is an empty base (objects.csv legitimately absent at the base
  // commit). computeFullSyncDiff fetches every base file once and decides the
  // mode for all sub-domains together, so this function no longer fetches its
  // own base.
  const threeWay = baseObjectsContent !== undefined;
  const baseCsvContent = threeWay ? (baseObjectsContent ?? null) : null;
  const [csvContent, { tree }] = await Promise.all([
    getFileContent(token, owner, repo, OBJECTS_CSV_PATH),
    getRepoTree(token, owner, repo),
  ]);

  // Determine which object_ids have IIIF tiles in the repo
  const imageExtensions = new Set(["jpg", "jpeg", "png", "tif", "tiff", "pdf"]);
  const iiifObjectIds = new Set(
    tree
      .filter((entry) => {
        if (entry.type !== "blob") return false;
        const parts = entry.path.split("/");
        if (parts.length !== 3 || parts[0] !== "telar-content" || parts[1] !== "objects") return false;
        const ext = parts[2].split(".").pop()?.toLowerCase() ?? "";
        return imageExtensions.has(ext);
      })
      .map((entry) => entry.path.split("/")[2].replace(/\.[^.]+$/, ""))
  );

  // Parse repo CSV into objects
  const parsedCsvRows = csvContent ? parseTelarCsv(csvContent) : [];
  const repoRows = csvContent ? mapObjectsCsv(parsedCsvRows, projectId) : [];
  const repoMap = new Map(repoRows.map((r) => [r.object_id as string, r]));
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
  const parsedBaseRows = threeWay && baseCsvContent ? parseTelarCsv(baseCsvContent) : [];
  const baseRows = threeWay && baseCsvContent ? mapObjectsCsv(parsedBaseRows, projectId) : [];
  const baseMap = new Map(baseRows.map((r) => [r.object_id as string, r]));
  const baseRawAltById = new Map(
    parsedBaseRows.map((r) => [r.object_id ?? "", r.alt_text ?? ""]),
  );
  let suppressedEditorOnly = 0;

  // Fetch current D1 objects for this project
  const d1Objects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, projectId));
  const d1Map = new Map(d1Objects.map((o) => [o.object_id, o]));

  // Fetch step references to detect story usage
  const stepRefs = await db
    .select({
      object_id: steps.object_id,
      step_number: steps.step_number,
      story_id: steps.story_id,
    })
    .from(steps);

  // Fetch story titles for referenced stories
  const storyRows = await db
    .select({ id: stories.id, title: stories.title })
    .from(stories)
    .where(eq(stories.project_id, projectId));
  const storyTitleMap = new Map(storyRows.map((s) => [s.id, s.title]));

  // Build usage map: object_id -> list of StoryRef
  const usageMap = new Map<string, StoryRef[]>();
  for (const ref of stepRefs) {
    if (!ref.object_id) continue;
    const storyTitle = storyTitleMap.get(ref.story_id) ?? null;
    const existing = usageMap.get(ref.object_id) ?? [];
    existing.push({ storyTitle, stepNumber: ref.step_number });
    usageMap.set(ref.object_id, existing);
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
    if (threeWay) {
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
      image_available: iiifObjectIds.has(objectId),
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
        d1Str = canonicalExtraColumns(d1Val);
        repoStr = canonicalExtraColumns(repoVal);
      } else {
        d1Val = (d1Obj[field] as string | null | undefined) ?? null;
        repoVal = (repoRow[field] as string | null | undefined) || null;
        d1Str = d1Val === null ? "" : String(d1Val);
        repoStr = repoVal === null ? "" : String(repoVal);
      }

      // The repo-empty guard runs BEFORE classification and is unchanged:
      // an empty repo cell against enriched D1 data (likely IIIF) is never a
      // diff entry, in either mode.
      if (d1Str === repoStr || repoStr === "") continue;

      if (!threeWay) {
        // Two-way fallback: every repo/D1 disagreement is a change (today's
        // behaviour), no conflict classification.
        changedFields.push(field);
        d1Values[field] = d1Val;
        repoValues[field] = repoVal;
        continue;
      }

      // Three-way classification against the base value.
      const baseStr = objectCsvFieldStr(field, baseRow, baseRawAltById, objectId);
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
      if (threeWay && !baseMap.has(objectId)) {
        continue;
      }
      // Three-way: the row was in the base and is now gone from the repo. If
      // the editor also moved it off the base (any sync field differs), it is a
      // deleted-in-repo/edited-here conflict — flag it so the modal offers a
      // choice rather than silently destroying the unpublished edit on delete.
      let editedInCompositor = false;
      if (threeWay) {
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

  // Compute unregistered files (image files in telar-content/objects/ not in CSV or D1)
  const unregisteredFiles: UnregisteredFile[] = [];
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    const parts = entry.path.split("/");
    if (parts.length !== 3 || parts[0] !== "telar-content" || parts[1] !== "objects") continue;
    const ext = parts[2].split(".").pop()?.toLowerCase() ?? "";
    if (!imageExtensions.has(ext)) continue;
    const objectId = parts[2].replace(/\.[^.]+$/, "");
    if (!repoMap.has(objectId) && !d1Map.has(objectId)) {
      unregisteredFiles.push({ object_id: objectId, filename: parts[2] });
    }
  }

  return {
    newObjects,
    changedObjects,
    missingObjects,
    unregisteredFiles,
    ...(threeWay ? { suppressedEditorOnly } : {}),
  };
}

// ---------------------------------------------------------------------------
// applySyncChanges
// ---------------------------------------------------------------------------

/**
 * Applies the user's selected sync changes to D1.
 *
 * - Inserts new objects from repo CSV (re-fetches CSV to get current values)
 * - Updates changed objects, using per-field "repo" or "d1" source choices
 * - Deletes removed objects
 * - Sets missing_from_repo = true for missing objects that were NOT removed
 * - Clears missing_from_repo = false for objects found in repo CSV
 *
 * Returns the total count of changes applied.
 */
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

export async function applySyncChanges(
  projectId: number,
  changes: SyncChanges,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>
): Promise<{ appliedCount: number; pendingObjects: PendingObject[]; removedObjectIds: string[] }> {
  const { newObjectIds, changedObjectIds, fieldChoices, removedObjectIds, unregisteredObjectIds } = changes;

  // Re-fetch CSV and tree to get authoritative repo values
  const [csvContent, { tree }] = await Promise.all([
    getFileContent(token, owner, repo, "telar-content/spreadsheets/objects.csv"),
    getRepoTree(token, owner, repo),
  ]);

  const imageExtensions2 = new Set(["jpg", "jpeg", "png", "tif", "tiff", "pdf"]);
  const iiifObjectIds = new Set(
    tree
      .filter((entry) => {
        if (entry.type !== "blob") return false;
        const parts = entry.path.split("/");
        if (parts.length !== 3 || parts[0] !== "telar-content" || parts[1] !== "objects") return false;
        const ext = parts[2].split(".").pop()?.toLowerCase() ?? "";
        return imageExtensions2.has(ext);
      })
      .map((entry) => entry.path.split("/")[2].replace(/\.[^.]+$/, ""))
  );

  const repoRows = csvContent ? mapObjectsCsv(parseTelarCsv(csvContent), projectId) : [];
  const repoMap = new Map(repoRows.map((r) => [r.object_id as string, r]));

  // Fetch current D1 objects for update/flag operations
  const d1Objects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, projectId));
  const d1Map = new Map(d1Objects.map((o) => [o.object_id, o]));

  const now = new Date().toISOString();
  let appliedCount = 0;
  const pendingObjects: PendingObject[] = [];

  // 1. Collect new objects as PENDING (not inserted into D1 yet)
  if (newObjectIds.length > 0) {
    for (const objectId of newObjectIds) {
      const repoRow = repoMap.get(objectId);
      if (!repoRow) continue;
      pendingObjects.push({
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
        dimensions: repoRow.dimensions ?? null,
        extra_columns: repoRow.extra_columns ?? null,
        image_available: iiifObjectIds.has(objectId),
        origin: "repo",
      });
    }
  }

  // 1b. Collect unregistered image files as PENDING (not inserted into D1 yet)
  if (unregisteredObjectIds && unregisteredObjectIds.length > 0) {
    for (const objectId of unregisteredObjectIds) {
      pendingObjects.push({
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
        image_available: true,
        origin: "repo",
      });
    }
  }

  // 2. Update changed objects (immediate — existing D1 rows)
  for (const objectId of changedObjectIds) {
    const repoRow = repoMap.get(objectId);
    const d1Obj = d1Map.get(objectId);
    if (!repoRow || !d1Obj) continue;

    const choices = fieldChoices[objectId] ?? {};
    const updatePayload: Record<string, string | boolean | null> = {
      updated_at: now,
    };

    for (const field of SYNC_FIELDS) {
      // Default "d1" means "leave D1 alone": a field absent from the choices map
      // is not written through. Writing the repo cell for every unlisted field
      // would revert unpublished editor edits and wipe IIIF-enriched columns
      // whose repo cell is blank. The objects-tab dialog emits an explicit
      // "repo" for every field it changed, so its visible behaviour is unchanged.
      const choice = choices[field] ?? "d1";
      if (choice === "repo") {
        if (field === "featured") {
          updatePayload[field] = Boolean(repoRow.featured);
        } else {
          updatePayload[field] = (repoRow[field] as string | null | undefined) || null;
        }
      }
    }

    await db
      .update(objects)
      .set(updatePayload)
      .where(and(eq(objects.project_id, projectId), eq(objects.object_id, objectId)));

    appliedCount++;
  }

  // 3. Delete removed objects (immediate)
  for (const objectId of removedObjectIds) {
    await db
      .delete(objects)
      .where(and(eq(objects.project_id, projectId), eq(objects.object_id, objectId)));
    appliedCount++;
  }

  // 4. Flag missing objects that were NOT removed (immediate)
  // Compositor-origin objects are skipped — they are not repo objects and
  // should not be flagged as missing when absent from the repo CSV.
  const allD1ObjectIds = [...d1Map.keys()];
  const removedSet = new Set(removedObjectIds);
  const repoObjectIds = new Set(repoMap.keys());

  for (const objectId of allD1ObjectIds) {
    if (!repoObjectIds.has(objectId) && !removedSet.has(objectId)) {
      const d1Obj = d1Map.get(objectId);
      if (d1Obj?.origin === "compositor") continue; // don't flag compositor-origin objects
      await db
        .update(objects)
        .set({ missing_from_repo: true, updated_at: now })
        .where(and(eq(objects.project_id, projectId), eq(objects.object_id, objectId)));
    }
  }

  // 5. Clear missing_from_repo flag for objects now present in repo (immediate)
  for (const objectId of repoObjectIds) {
    const d1Obj = d1Map.get(objectId);
    if (d1Obj && d1Obj.missing_from_repo) {
      await db
        .update(objects)
        .set({ missing_from_repo: false, updated_at: now })
        .where(and(eq(objects.project_id, projectId), eq(objects.object_id, objectId)));
    }
  }

  // Echo the removed ids so the client can drop their Y.Maps — the route delete
  // above removes the D1 rows, but the Y.Doc is the source of truth and the next
  // snapshot would re-INSERT (resurrect) any object whose Y.Map still exists.
  return { appliedCount, pendingObjects, removedObjectIds };
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

export interface StorySyncChangedItem {
  story_id: string;
  title: string | null;
  changedFields: string[];
  /**
   * Three-way only. Story diffs classify at ROW grain (accept/reject is
   * whole-row), so `conflict` is one boolean: true when the repo AND the
   * editor both moved this story off the base. The modal then shows the
   * repo/Compositor value pair (`repoValues`/`d1Values`, keyed by the
   * StorySyncItem field) and defaults to keep-mine. Editor-only rows are
   * suppressed upstream, so they never reach this list. Both maps are empty
   * and `conflict` is false in two-way fallback mode.
   */
  conflict: boolean;
  d1Values: Partial<Record<keyof StorySyncItem, string | boolean>>;
  repoValues: Partial<Record<keyof StorySyncItem, string | boolean>>;
}

export interface StorySyncDiff {
  newStories: StorySyncItem[];
  changedStories: StorySyncChangedItem[];
  missingStories: Array<{ story_id: string; title: string | null }>;
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
  /** Terms in the repo CSV that are not in D1 */
  added: Array<{
    term_id: string;
    title: string;
    definition: string;
    related_terms: string;
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
    /**
     * Three-way only. True when the repo AND D1 both moved this term off the
     * base (row grain — accept/reject is whole-row). Repo-only terms carry
     * false and are pre-accepted; editor-only terms are suppressed upstream.
     * Always false in two-way fallback mode.
     */
    conflict: boolean;
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
}

/**
 * True when a FullSyncDiff contains any compositor-relevant divergence: objects,
 * stories, config fields, glossary entries, or a repo↔D1 version change. Used by
 * the _app loader to decide whether to raise the sync-divergence banner when
 * repo HEAD differs from the last known SHA — without this, a churn-only commit
 * would nag the user unnecessarily.
 */
export function hasDivergentChanges(diff: FullSyncDiff): boolean {
  return (
    diff.objects.newObjects.length > 0 ||
    diff.objects.changedObjects.length > 0 ||
    diff.objects.missingObjects.length > 0 ||
    diff.objects.unregisteredFiles.length > 0 ||
    diff.stories.newStories.length > 0 ||
    diff.stories.changedStories.length > 0 ||
    diff.stories.missingStories.length > 0 ||
    diff.config.changedFields.length > 0 ||
    diff.config.versionChange !== null ||
    diff.glossary.added.length > 0 ||
    diff.glossary.changed.length > 0 ||
    diff.glossary.removed.length > 0
  );
}

export interface FullSyncChanges {
  objects: SyncChanges;
  /** story_ids where user accepted repo changes (update D1 to repo values) */
  stories: { accept: string[]; reject: string[]; insertNew: string[] };
  /** config field keys where user accepted repo changes */
  config: { accept: string[]; reject: string[] };
  /** term_ids where user accepted repo changes */
  glossary: { accept: string[]; reject: string[]; insertNew: string[] };
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
    update: Array<{
      storyId: string; title: string; subtitle: string; byline: string;
      isPrivate: boolean; showSections: boolean;
    }>;
    insert: Array<{
      storyId: string; title: string; subtitle: string; byline: string;
      isPrivate: boolean; showSections: boolean;
      steps: SyncIngestStep[]; layers: SyncIngestLayer[];
    }>;
  };
  objects: {
    update: Array<{ objectId: string; fields: Partial<Record<SyncField, string | boolean | null>> }>;
    insert: PendingObject[];
    remove: string[];
  };
  glossary: {
    update: Array<{ termId: string; title: string; definition: string }>;
    insert: Array<{ termId: string; title: string; definition: string }>;
  };
}

/**
 * The D1-only writes that accompany an ingest. These columns are safe to write
 * directly: the snapshot UPDATE omits them and the stale-id re-INSERT preserves
 * them from the surviving row (see the field registry). Part 1 (missing flags,
 * related_terms for updated terms) is written before the ingest; part 2 (origin
 * for inserted objects, related_terms for inserted terms, the version heal) runs
 * after it, once the rows exist.
 */
export interface FullSyncResidue {
  /** object_ids to flag missing_from_repo = true. */
  missingFromRepoSet: string[];
  /** object_ids to clear missing_from_repo = false. */
  missingFromRepoClear: string[];
  /** related_terms for terms whose title/definition were updated. */
  relatedTermsUpdate: Array<{ termId: string; relatedTerms: string | null }>;
  /** related_terms for newly inserted terms (written after the DO INSERT). */
  relatedTermsInsert: Array<{ termId: string; relatedTerms: string | null }>;
  /** object_ids of inserted objects to patch origin = "repo" after the INSERT. */
  originRepo: string[];
  /** The version to heal D1 to when the repo is ahead, else null. */
  telarVersionHeal: string | null;
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
};

/**
 * Parse a single YAML scalar value (the text after `key:` on one line) into its
 * string value. Handles double-quoted (inverse of publish.server's yamlQuote:
 * \" \\ \n), single-quoted (YAML '' -> '), and bare scalars (trailing # comment
 * stripped). Returns null for an empty/absent value. Line-based — no js-yaml
 * dependency (keeps multi-line/commented config files intact).
 */
function parseYamlScalar(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null;
  if (s.startsWith('"')) {
    // Double-quoted: consume to the matching unescaped closing quote.
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (c === "\\") {
        const next = s[i + 1];
        if (next === "n") out += "\n";
        else if (next === '"') out += '"';
        else if (next === "\\") out += "\\";
        else out += next ?? "";
        i++;
      } else if (c === '"') {
        break;
      } else {
        out += c;
      }
    }
    return out;
  }
  if (s.startsWith("'")) {
    // Single-quoted: '' is a literal single quote; ends at a lone '.
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (c === "'") {
        if (s[i + 1] === "'") { out += "'"; i++; }
        else break;
      } else {
        out += c;
      }
    }
    return out;
  }
  // Bare scalar: strip a trailing " # comment".
  const noComment = s.replace(/\s+#.*$/, "").trim();
  return noComment === "" ? null : noComment;
}

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
 * line-based parsing — same approach as disableGoogleSheetsInConfig to avoid
 * a js-yaml dependency in sync.server.ts and to preserve multi-line config
 * files with comments.
 *
 * Only extracts top-level scalar keys (the managed set), plus story_key via the
 * block-aware reader above. Complex YAML sub-keys (e.g. telar.version) are not
 * touched. Handles double-quoted, single-quoted, and bare scalar values
 * correctly, including values containing a quote (e.g. HTML descriptions).
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
    // Match the key line and capture the raw remainder (top-level keys only).
    const m = yamlContent.match(new RegExp(`^${yamlKey}:[ \\t]*(.*)$`, "m"));
    result[key] = m ? parseYamlScalar(m[1]) : null;
  }
  return result as Record<ManagedConfigField, string | null>;
}

/**
 * Extract the `version:` value from the `telar:` block of a site's
 * _config.yml. Returns null when absent or malformed. Delegates the
 * block-walk to the shared `findInYamlBlock` in config-yaml-block.server.ts
 * (the same idiom `updateTelarVersionInConfig` in upgrade.server.ts uses on
 * the write side) to avoid a full YAML parse — keeps comments/whitespace-
 * tolerance cheap and preserves behaviour on the same exotic inputs.
 *
 * `haltAfterBlock: true` preserves this function's original behaviour of
 * stopping the whole scan once the (first) telar: block ends, rather than
 * continuing to look for a later duplicate top-level `telar:` key.
 *
 * Exported to enable direct unit testing (see tests/sync.server.test.ts).
 */
export function extractTelarVersion(yamlContent: string): string | null {
  return (
    findInYamlBlock(
      yamlContent,
      "telar",
      (line) => {
        const m = line.match(/^\s+version:\s*["']?([^\s"'#]+)/);
        return m ? m[1] : undefined;
      },
      { haltAfterBlock: true },
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// computeFullSyncDiff
// ---------------------------------------------------------------------------

/**
 * Computes a full three-way diff for objects, stories, and config between
 * D1 and the repo.
 *
 * - Objects: delegates to existing `computeSyncDiff`
 * - Stories: compares D1 stories table against repo project.csv
 * - Config: compares D1 project_config against repo _config.yml managed fields
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
): Promise<FullSyncDiff> {
  // Decide three-way vs two-way ONCE for the WHOLE diff. Fetch all four base
  // files at the ref in parallel via getFileAtRef, which tells "absent" (404 →
  // empty base for that domain) apart from "error" (transient / 5xx / 429 →
  // base unknown). The rule: any "error" forces two-way everywhere — a partial
  // base would misclassify, leaving some domains three-way and silently
  // degrading others to two-way. All four "absent" is also two-way (a GC'd or
  // bad ref — nothing to compare). Any other mix is three-way, with an "absent"
  // file meaning an EMPTY base for that domain. Threading base CONTENT (not a
  // ref) down to the sub-diffs keeps this the single mode-decision point.
  let baseObjectsCsv: string | null = null;
  let baseProjectCsv: string | null = null;
  let baseGlossaryCsv: string | null = null;
  let baseConfigYml: string | null = null;
  let threeWay = false;
  if (baseRef) {
    const [objRes, projRes, glossRes, cfgRes] = await Promise.all([
      getFileAtRef(token, owner, repo, OBJECTS_CSV_PATH, baseRef),
      getFileAtRef(token, owner, repo, PROJECT_CSV_PATH, baseRef),
      getFileAtRef(token, owner, repo, GLOSSARY_CSV_PATH, baseRef),
      getFileAtRef(token, owner, repo, CONFIG_YML_PATH, baseRef),
    ]);
    const all = [objRes, projRes, glossRes, cfgRes];
    const anyError = all.some((r) => r.status === "error");
    const allAbsent = all.every((r) => r.status === "absent");
    if (!anyError && !allAbsent) {
      threeWay = true;
      baseObjectsCsv = objRes.status === "ok" ? objRes.content : null;
      baseProjectCsv = projRes.status === "ok" ? projRes.content : null;
      baseGlossaryCsv = glossRes.status === "ok" ? glossRes.content : null;
      baseConfigYml = cfgRes.status === "ok" ? cfgRes.content : null;
    }
  }
  let suppressedEditorOnly = 0;

  // Story fields compared / mapped into a StorySyncItem shape. Shared by the
  // repo, base, and D1 sides so classification stays symmetrical.
  const storyFields = STORY_SYNC_FIELDS;
  const toStoryItem = (r: Record<string, unknown>): StorySyncItem => ({
    story_id: r.story_id as string,
    title: (r.title as string | null | undefined) ?? null,
    subtitle: (r.subtitle as string | null | undefined) ?? null,
    byline: (r.byline as string | null | undefined) ?? null,
    order: (r.order as number) ?? 0,
    isPrivate: Boolean(r.private),
    showSections: Boolean(r.show_sections),
  });
  const storyRowChanged = (a: StorySyncItem, b: StorySyncItem): boolean =>
    storyFields.some((f) => String(a[f] ?? "") !== String(b[f] ?? ""));

  // 1. Delegate objects diff. Thread the base objects.csv CONTENT: undefined in
  //    two-way, string|null (null = empty base) in three-way.
  const objectsDiff = await computeSyncDiff(
    projectId, token, owner, repo, db, threeWay ? baseObjectsCsv : undefined,
  );
  suppressedEditorOnly += objectsDiff.suppressedEditorOnly ?? 0;

  // 2. Fetch project.csv from repo and parse into story rows
  const projectCsvContent = await getFileContent(
    token, owner, repo, PROJECT_CSV_PATH,
  );
  const repoStoryRows = projectCsvContent
    ? mapProjectCsv(parseTelarCsv(projectCsvContent), projectId)
    : [];
  const repoStoryMap = new Map(
    repoStoryRows.map((r) => [r.story_id as string, toStoryItem(r)]),
  );

  // Base story rows (three-way only).
  const baseStoryRows =
    threeWay && baseProjectCsv ? mapProjectCsv(parseTelarCsv(baseProjectCsv), projectId) : [];
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
    };

    const changedFields: string[] = [];
    const d1Values: Partial<Record<keyof StorySyncItem, string | boolean>> = {};
    const repoValues: Partial<Record<keyof StorySyncItem, string | boolean>> = {};
    for (const field of storyFields) {
      if (String(repoRow[field] ?? "") !== String(d1Item[field] ?? "")) {
        changedFields.push(field);
        d1Values[field] = d1Item[field] as string | boolean;
        repoValues[field] = repoRow[field] as string | boolean;
      }
    }

    if (changedFields.length === 0) continue;

    let conflict = false;
    if (threeWay) {
      const baseItem = baseStoryMap.get(storyId);
      // No base row → cannot be editor-only; surface as a repo change.
      const repoChanged = baseItem ? storyRowChanged(repoRow, baseItem) : true;
      const editorChanged = baseItem ? storyRowChanged(d1Item, baseItem) : false;
      if (editorChanged && !repoChanged) {
        suppressedEditorOnly++; // editor-only — the repo never moved this story
        continue;
      }
      conflict = repoChanged && editorChanged;
    }

    changedStories.push({
      story_id: storyId,
      title: d1Row.title ?? null,
      changedFields,
      conflict,
      d1Values,
      repoValues,
    });
  }

  for (const [storyId, d1Row] of d1StoryMap.entries()) {
    if (repoStoryMap.has(storyId)) continue;
    // In D1, not in repo. Three-way: absent from the base too → editor-created,
    // unpublished → suppress from the removed list (was in the base → genuine
    // repo deletion, shown as today).
    if (threeWay && !baseStoryMap.has(storyId)) {
      suppressedEditorOnly++;
      continue;
    }
    missingStories.push({ story_id: storyId, title: d1Row.title ?? null });
  }

  // 5. Fetch _config.yml and compare against D1 project_config
  const configYmlContent = await getFileContent(token, owner, repo, CONFIG_YML_PATH);
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
    let d1Val = (d1Config[key] as string | boolean | number | null | undefined) ?? null;

    // Boolean columns (collection_mode and the interface toggles) come back
    // from drizzle as real JS booleans, and featured_count as a number, but
    // repo _config.yml stores bare scalars — extractConfigFields/
    // parseYamlScalar always returns a string. Normalize D1's value to the
    // same string form before comparing, same approach as storyFields'
    // isPrivate normalization above, so a logically unchanged value never
    // false-positives as a sync diff.
    if (typeof d1Val === "boolean") {
      d1Val = d1Val ? "true" : "false";
    } else if (typeof d1Val === "number") {
      d1Val = String(d1Val);
    }

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
  const repoTelarVersion = configYmlContent ? extractTelarVersion(configYmlContent) : null;
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
    projectId, token, owner, repo, db, threeWay ? baseGlossaryCsv : undefined,
  );
  suppressedEditorOnly += glossaryDiff.suppressedEditorOnly ?? 0;

  // hasConflicts is wired truthfully in three-way mode: any field/row both
  // sides moved off the base, or any deleted-here/edited-there presence.
  const hasConflicts =
    threeWay &&
    (objectsDiff.changedObjects.some((o) => o.conflictFields.length > 0) ||
      objectsDiff.newObjects.some((o) => o.deletedInCompositor) ||
      objectsDiff.missingObjects.some((o) => o.editedInCompositor) ||
      changedStories.some((s) => s.conflict) ||
      newStories.some((s) => s.deletedInCompositor) ||
      configChangedFields.some((c) => c.conflict) ||
      glossaryDiff.changed.some((t) => t.conflict) ||
      glossaryDiff.added.some((t) => t.deletedInCompositor));

  return {
    objects: objectsDiff,
    stories: { newStories, changedStories, missingStories },
    config: { changedFields: configChangedFields, versionChange },
    glossary: glossaryDiff,
    hasConflicts,
    classification: threeWay ? "three-way" : "two-way",
    suppressedEditorOnly: threeWay ? suppressedEditorOnly : 0,
  };
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
export const GLOSSARY_SYNC_FIELDS = ["title", "definition", "related_terms"] as const;

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
): Promise<GlossarySyncDiff> {
  // Three-way vs two-way is decided by the caller and threaded in as the base
  // glossary.csv CONTENT, not a ref (see computeSyncDiff): `undefined` is
  // two-way; a string or `null` is three-way, where `null` is an empty base.
  // computeFullSyncDiff owns the single mode decision, so no own base fetch.
  const threeWay = baseGlossaryContent !== undefined;
  const baseGlossaryCsv = threeWay ? (baseGlossaryContent ?? null) : null;
  const glossaryCsvContent = await getFileContent(token, owner, repo, GLOSSARY_CSV_PATH);

  const buildTermMap = (csv: string | null) =>
    new Map(
      (csv ? parseTelarCsv(csv) : [])
        .filter((r) => r.term_id)
        .map((r) => [
          r.term_id as string,
          { title: r.title ?? "", definition: r.definition ?? "", related_terms: r.related_terms ?? "" },
        ]),
    );
  const repoTermMap = buildTermMap(glossaryCsvContent);
  const baseTermMap = threeWay ? buildTermMap(baseGlossaryCsv) : new Map<string, { title: string; definition: string; related_terms: string }>();

  // Fetch D1 glossary terms for this project
  const d1Terms = await db
    .select()
    .from(glossary_terms)
    .where(eq(glossary_terms.project_id, projectId));
  const d1TermMap = new Map(d1Terms.map((t) => [t.term_id, t]));

  const added: GlossarySyncDiff["added"] = [];
  const removed: GlossarySyncDiff["removed"] = [];
  const changed: GlossarySyncDiff["changed"] = [];
  let suppressedEditorOnly = 0;

  const termRowChanged = (
    a: { title: string; definition: string; related_terms: string },
    b: { title: string; definition: string; related_terms: string },
  ): boolean => GLOSSARY_SYNC_FIELDS.some((f) => a[f] !== b[f]);

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
            deletedInCompositor: true,
          });
          continue;
        }
      }
      added.push({ term_id: termId, title: repoTerm.title, definition: repoTerm.definition, related_terms: repoTerm.related_terms });
    } else {
      const d1TermRow = {
        title: d1Term.title ?? "",
        definition: d1Term.definition ?? "",
        related_terms: d1Term.related_terms ?? "",
      };
      if (!termRowChanged(d1TermRow, repoTerm)) continue;
      // Title is compared alongside definition/related_terms because it too
      // round-trips through glossary.csv and the glossary hash — a repo-side
      // title edit that sync ignored would be reverted on the next publish.
      let conflict = false;
      if (threeWay) {
        const baseTerm = baseTermMap.get(termId);
        const repoChanged = baseTerm ? termRowChanged(repoTerm, baseTerm) : true;
        const editorChanged = baseTerm ? termRowChanged(d1TermRow, baseTerm) : false;
        if (editorChanged && !repoChanged) {
          suppressedEditorOnly++; // editor-only term edit
          continue;
        }
        conflict = repoChanged && editorChanged;
      }
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
        conflict,
      });
    }
  }

  // Find removed
  for (const [termId, d1Term] of d1TermMap.entries()) {
    if (repoTermMap.has(termId)) continue;
    // In D1, not in repo. Three-way: absent from the base too → editor-created,
    // unpublished → suppress from the removed list.
    if (threeWay && !baseTermMap.has(termId)) {
      suppressedEditorOnly++;
      continue;
    }
    removed.push({ term_id: termId, title: d1Term.title ?? "", dbId: d1Term.id });
  }

  return { added, removed, changed, ...(threeWay ? { suppressedEditorOnly } : {}) };
}

// ---------------------------------------------------------------------------
// applyFullSyncChanges
// ---------------------------------------------------------------------------

/**
 * Resolves the user's accepted full-sync changes into a fully-typed DO ingest
 * payload plus the D1-only residue. Pure resolution: it re-fetches the repo
 * files (objects.csv, project.csv, _config.yml, glossary.csv, per-story CSVs)
 * and reads the current D1 objects/config, maps accepted keys to typed values,
 * and coerces each per its column type. No DO calls, no writes — unit-testable
 * with a mocked getFileContent + db.
 *
 * Everything in `payload` flows through the Y.Doc and is persisted by the
 * snapshot pipeline. `residue` carries the D1-only columns the Y.Doc never holds
 * (missing_from_repo, related_terms, origin) plus the server-computed
 * telar_version heal decision.
 */
export async function resolveFullSyncPayload(
  projectId: number,
  changes: FullSyncChanges,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
): Promise<{ payload: SyncIngestPayload; residue: FullSyncResidue }> {
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
    relatedTermsUpdate: [],
    relatedTermsInsert: [],
    originRepo: [],
    telarVersionHeal: null,
  };

  // --- Objects (objects.csv + repo tree + D1 rows) ------------------------
  const [objectsCsvContent, { tree }] = await Promise.all([
    getFileContent(token, owner, repo, "telar-content/spreadsheets/objects.csv"),
    getRepoTree(token, owner, repo),
  ]);
  const imageExtensions = new Set(["jpg", "jpeg", "png", "tif", "tiff", "pdf"]);
  const iiifObjectIds = new Set(
    tree
      .filter((entry) => {
        if (entry.type !== "blob") return false;
        const parts = entry.path.split("/");
        if (parts.length !== 3 || parts[0] !== "telar-content" || parts[1] !== "objects") return false;
        const ext = parts[2].split(".").pop()?.toLowerCase() ?? "";
        return imageExtensions.has(ext);
      })
      .map((entry) => entry.path.split("/")[2].replace(/\.[^.]+$/, "")),
  );
  const parsedObjRows = objectsCsvContent ? parseTelarCsv(objectsCsvContent) : [];
  const repoObjRows = objectsCsvContent ? mapObjectsCsv(parsedObjRows, projectId) : [];
  const repoObjMap = new Map(repoObjRows.map((r) => [r.object_id as string, r]));
  // Raw alt_text cell by object_id. mapObjectsCsv fills a blank cell with the
  // object's title (an import accessibility fallback that is NOT repo state), so
  // an explicitly-accepted alt_text change must write the RAW cell — the same
  // side map computeSyncDiff diffs against — not the enriched row's fallback.
  const rawAltById = new Map(parsedObjRows.map((r) => [r.object_id ?? "", r.alt_text ?? ""]));

  const d1Objects = await db.select().from(objects).where(eq(objects.project_id, projectId));
  const d1ObjMap = new Map(d1Objects.map((o) => [o.object_id, o]));

  // Object inserts (new CSV rows + unregistered image files). origin rides the
  // PendingObject shape for the DO's benefit but is D1-patched afterwards.
  for (const objectId of objectChanges.newObjectIds) {
    const repoRow = repoObjMap.get(objectId);
    if (!repoRow) continue;
    payload.objects.insert.push({
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
      image_available: iiifObjectIds.has(objectId),
      origin: "repo",
    });
  }
  for (const objectId of objectChanges.unregisteredObjectIds ?? []) {
    payload.objects.insert.push({
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
      image_available: true,
      origin: "repo",
    });
  }
  for (const p of payload.objects.insert) residue.originRepo.push(p.object_id);

  // Object updates — per accepted field ("repo" by default; "d1" keeps D1).
  for (const objectId of objectChanges.changedObjectIds) {
    const repoRow = repoObjMap.get(objectId);
    const d1Obj = d1ObjMap.get(objectId);
    if (!repoRow || !d1Obj) continue;
    const choices = objectChanges.fieldChoices[objectId] ?? {};
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
      if (field === "featured") fields[field] = Boolean(repoRow.featured);
      else if (field === "alt_text") fields[field] = rawAltById.get(objectId) || null;
      else fields[field] = (repoRow[field] as string | null | undefined) || null;
      anyRepo = true;
    }
    if (anyRepo) payload.objects.update.push({ objectId, fields });
  }

  // Object removes go through the doc so the snapshot's orphan-delete drops the
  // D1 row (and nothing resurrects it on the next snapshot).
  payload.objects.remove = [...objectChanges.removedObjectIds];

  // missing_from_repo: set for D1 objects absent from the repo (not removed,
  // not compositor-origin); clear for objects now present again in the repo.
  const removedSet = new Set(objectChanges.removedObjectIds);
  for (const [objectId, d1Obj] of d1ObjMap.entries()) {
    if (!repoObjMap.has(objectId) && !removedSet.has(objectId)) {
      if (d1Obj.origin === "compositor") continue;
      residue.missingFromRepoSet.push(objectId);
    }
  }
  for (const objectId of repoObjMap.keys()) {
    const d1Obj = d1ObjMap.get(objectId);
    if (d1Obj && d1Obj.missing_from_repo) residue.missingFromRepoClear.push(objectId);
  }

  // --- Stories (project.csv + per-story CSVs for inserts) -----------------
  const projectCsvContent = await getFileContent(token, owner, repo, "telar-content/spreadsheets/project.csv");
  const repoStoryRows = projectCsvContent ? mapProjectCsv(parseTelarCsv(projectCsvContent), projectId) : [];
  const repoStoryMap = new Map(repoStoryRows.map((r) => [r.story_id as string, r]));

  for (const storyId of storyChanges.accept) {
    const r = repoStoryMap.get(storyId);
    if (!r) continue;
    // Empty strings ARE applied — no `|| undefined` skipping (a repo-side clear
    // must land, not leave a forever-dirty field).
    payload.stories.update.push({
      storyId,
      title: String((r.title as string | null | undefined) ?? ""),
      subtitle: String((r.subtitle as string | null | undefined) ?? ""),
      byline: String((r.byline as string | null | undefined) ?? ""),
      isPrivate: Boolean(r.private),
      showSections: Boolean(r.show_sections),
    });
  }

  for (const storyId of storyChanges.insertNew) {
    const r = repoStoryMap.get(storyId);
    if (!r) continue;
    // Resolve any layerN_content cell that points at a texts/stories/*.md file
    // to the file's body before mapping (a published story stores only the
    // filename); missing files degrade to inline handling, as the importer does.
    const storyCsvContent = await getFileContent(token, owner, repo, `telar-content/spreadsheets/${storyId}.csv`);
    let steps: SyncIngestStep[] = [];
    let layers: SyncIngestLayer[] = [];
    if (storyCsvContent) {
      const resolvedRows = await resolveLayerFileReferences(
        parseTelarCsv(storyCsvContent),
        (filename) => getFileContent(token, owner, repo, `telar-content/texts/stories/${filename}`),
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
      }));
      // mapStoryCsv stamps layer.step_id = -(rowIndex + 1); convert back to a
      // 0-based step_index the DO threads layers by.
      layers = layerRows.map((l) => ({
        step_index: Math.abs(l.step_id as number) - 1,
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
  }

  // --- Config (_config.yml) + telar_version heal --------------------------
  const configYmlContent = await getFileContent(token, owner, repo, "_config.yml");
  const repoConfigFields = configYmlContent
    ? extractConfigFields(configYmlContent)
    : ({} as Record<ManagedConfigField, string | null>);
  for (const key of configChanges.accept) {
    if (!MANAGED_CONFIG_FIELDS.includes(key as ManagedConfigField)) continue;
    const raw = repoConfigFields[key as ManagedConfigField] ?? null;
    if (BOOLEAN_CONFIG_FIELDS.has(key as ManagedConfigField)) {
      // A bare "false" scalar is truthy as a string — coerce to a real boolean.
      payload.config.push({ key, value: raw === "true" });
    } else if (key === "featured_count") {
      const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
      // Non-numeric count: drop the entry (the old direct write skipped it too).
      if (Number.isFinite(n)) payload.config.push({ key, value: n });
    } else {
      payload.config.push({ key, value: raw ?? "" });
    }
  }

  const d1ConfigRows = await db.select().from(project_config).where(eq(project_config.project_id, projectId));
  const d1Config = (d1ConfigRows[0] as unknown as Record<string, unknown> | undefined) ?? {};
  const repoTelarVersion = configYmlContent ? extractTelarVersion(configYmlContent) : null;
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

  // --- Glossary (glossary.csv) --------------------------------------------
  if (glossaryChanges.insertNew.length > 0 || glossaryChanges.accept.length > 0) {
    const glossaryCsvContent = await getFileContent(token, owner, repo, "telar-content/spreadsheets/glossary.csv");
    const repoTerms = glossaryCsvContent ? parseTelarCsv(glossaryCsvContent) : [];
    const repoTermMap = new Map(repoTerms.filter((r) => r.term_id).map((r) => [r.term_id as string, r]));
    for (const termId of glossaryChanges.insertNew) {
      const t = repoTermMap.get(termId);
      if (!t) continue;
      payload.glossary.insert.push({ termId, title: t.title ?? "", definition: t.definition ?? "" });
      residue.relatedTermsInsert.push({ termId, relatedTerms: t.related_terms || null });
    }
    for (const termId of glossaryChanges.accept) {
      const t = repoTermMap.get(termId);
      if (!t) continue;
      payload.glossary.update.push({ termId, title: t.title ?? "", definition: t.definition ?? "" });
      residue.relatedTermsUpdate.push({ termId, relatedTerms: t.related_terms || null });
    }
  }

  return { payload, residue };
}

/**
 * Applies the user's selected full-sync changes by routing every content change
 * THROUGH the collaboration DO's /ingest-sync endpoint, so the snapshot pipeline
 * performs the D1 writes it would otherwise revert. The D1-only residue is
 * written directly, split around the ingest by whether the rows must already
 * exist (see resolveFullSyncPayload / FullSyncResidue).
 *
 * Returns the new HEAD SHA. A failed ingest throws WITHOUT advancing head_sha,
 * so the divergence banner persists and a retry is safe (idempotent by key).
 */
export async function applyFullSyncChanges(
  projectId: number,
  changes: FullSyncChanges,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  env: FullSyncEnv,
): Promise<{ newHeadSha: string }> {
  // 1. Resolve the typed payload + D1-only residue from the repo files.
  const { payload, residue } = await resolveFullSyncPayload(projectId, changes, token, owner, repo, db);
  const now = new Date().toISOString();

  // 2. Residue part 1 — snapshot-safe columns, written BEFORE the ingest so a
  //    later ingest failure leaves them harmlessly (they are idempotent and the
  //    snapshot preserves them by omission): missing_from_repo flags and
  //    related_terms for updated terms.
  for (const objectId of residue.missingFromRepoSet) {
    await db
      .update(objects)
      .set({ missing_from_repo: true, updated_at: now })
      .where(and(eq(objects.project_id, projectId), eq(objects.object_id, objectId)));
  }
  for (const objectId of residue.missingFromRepoClear) {
    await db
      .update(objects)
      .set({ missing_from_repo: false, updated_at: now })
      .where(and(eq(objects.project_id, projectId), eq(objects.object_id, objectId)));
  }
  for (const { termId, relatedTerms } of residue.relatedTermsUpdate) {
    await db
      .update(glossary_terms)
      .set({ related_terms: relatedTerms, updated_at: now })
      .where(and(eq(glossary_terms.project_id, projectId), eq(glossary_terms.term_id, termId)));
  }

  // 3. Ingest through the DO — the one true commit point. A non-200 aborts the
  //    apply: head_sha stays put, the banner persists, and a retry is safe.
  const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
  const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
  const ingestRes = await stub.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  if (!ingestRes.ok) {
    throw new Error(`ingest-sync failed: DO returned ${ingestRes.status}`);
  }
  // Surface partial application: an update whose entity is absent from the doc
  // is skipped (deleted concurrently, or a legacy D1-only row the doc never
  // held — the same snapshot removes such rows). The accept still succeeds for
  // everything else and head_sha advances (a skipped row's fate is identical
  // with or without this apply), but skips must be visible in the logs, not
  // silently absorbed into a success response.
  try {
    const ingestBody = (await ingestRes.json()) as { skipped?: Record<string, string[]> };
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

  // 4. Residue part 2 — snapshot-omitted columns on rows the ingest just wrote:
  //    origin for inserted objects, related_terms for inserted terms, and the
  //    telar_version heal. A failure here is cosmetic (no reverts) — log and go.
  try {
    for (const objectId of residue.originRepo) {
      await db
        .update(objects)
        .set({ origin: "repo", updated_at: now })
        .where(and(eq(objects.project_id, projectId), eq(objects.object_id, objectId)));
    }
    for (const { termId, relatedTerms } of residue.relatedTermsInsert) {
      await db
        .update(glossary_terms)
        .set({ related_terms: relatedTerms, updated_at: now })
        .where(and(eq(glossary_terms.project_id, projectId), eq(glossary_terms.term_id, termId)));
    }
    if (residue.telarVersionHeal) {
      await db
        .update(project_config)
        .set({ telar_version: residue.telarVersionHeal, updated_at: now })
        .where(eq(project_config.project_id, projectId));
    }
  } catch (err) {
    console.error("[full-sync] post-ingest residue write failed (cosmetic; head_sha still advances)", err);
  }

  // 5. Bump head_sha + activity metadata (projects is not snapshot-managed).
  const { projects } = await import("~/db/schema");
  const newHeadSha = await getRepoHead(token, owner, repo);
  await db
    .update(projects)
    .set({ head_sha: newHeadSha, last_synced_at: now, updated_at: now, gh_checked_at: null })
    .where(eq(projects.id, projectId));

  return { newHeadSha };
}

/**
 * Sync utilities for the Telar Compositor objects manager.
 *
 * Computes a three-way diff between the D1 objects table and the repo's
 * objects.csv, and applies the user's selected changes back to D1.
 *
 * Exports:
 *   computeSyncDiff(projectId, token, owner, repo, db) — diff computation
 *   applySyncChanges(projectId, changes, token, owner, repo, db) — apply
 *   SyncDiff, SyncChanges — types for the diff/apply flow
 */

import { eq, and } from "drizzle-orm";
import { objects, steps, stories } from "~/db/schema";
import { getFileContent, getRepoTree } from "~/lib/github.server";
import { parseTelarCsv, mapObjectsCsv } from "~/lib/import.server";
import type { getDb } from "~/lib/db.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields compared during diff */
export const SYNC_FIELDS = [
  "title",
  "creator",
  "description",
  "period",
  "year",
  "object_type",
  "subjects",
  "source",
  "credit",
  "featured",
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
  image_available: boolean;
}

export interface ChangedObject {
  object_id: string;
  dbId: number;
  title: string | null;
  changedFields: SyncField[];
  d1Values: Partial<Record<SyncField, string | boolean | null>>;
  repoValues: Partial<Record<SyncField, string | boolean | null>>;
}

export interface MissingObject {
  object_id: string;
  dbId: number;
  title: string | null;
  usedByStories: StoryRef[];
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
  db: ReturnType<typeof getDb>
): Promise<SyncDiff> {
  // Fetch repo CSV and tree in parallel
  const [csvContent, { tree }] = await Promise.all([
    getFileContent(token, owner, repo, "telar-content/spreadsheets/objects.csv"),
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
  const repoRows = csvContent ? mapObjectsCsv(parseTelarCsv(csvContent), projectId) : [];
  const repoMap = new Map(repoRows.map((r) => [r.object_id as string, r]));

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

  // Compute new objects (in repo but not in D1)
  const newObjects: NewObject[] = [];
  for (const [objectId, repoRow] of repoMap.entries()) {
    if (!d1Map.has(objectId)) {
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
        image_available: iiifObjectIds.has(objectId),
      });
    }
  }

  // Compute changed objects (in both, with differing fields)
  const changedObjects: ChangedObject[] = [];
  for (const [objectId, d1Obj] of d1Map.entries()) {
    const repoRow = repoMap.get(objectId);
    if (!repoRow) continue; // missing — handled below

    const changedFields: SyncField[] = [];
    const d1Values: Partial<Record<SyncField, string | boolean | null>> = {};
    const repoValues: Partial<Record<SyncField, string | boolean | null>> = {};

    for (const field of SYNC_FIELDS) {
      let d1Val: string | boolean | null;
      let repoVal: string | boolean | null;

      if (field === "featured") {
        d1Val = d1Obj.featured ?? false;
        repoVal = Boolean(repoRow.featured);
      } else {
        d1Val = (d1Obj[field] as string | null | undefined) ?? null;
        repoVal = (repoRow[field] as string | null | undefined) || null;
      }

      const d1Str = d1Val === null ? "" : String(d1Val);
      const repoStr = repoVal === null ? "" : String(repoVal);

      // Only flag as changed if the repo has a different non-empty value.
      // If the repo value is empty but D1 has data, that data likely came
      // from IIIF enrichment — not a conflict the user needs to resolve.
      if (d1Str !== repoStr && repoStr !== "") {
        changedFields.push(field);
        d1Values[field] = d1Val;
        repoValues[field] = repoVal;
      }
    }

    if (changedFields.length > 0) {
      changedObjects.push({
        object_id: objectId,
        dbId: d1Obj.id,
        title: d1Obj.title ?? null,
        changedFields,
        d1Values,
        repoValues,
      });
    }
  }

  // Compute missing objects (in D1 but not in repo CSV)
  const missingObjects: MissingObject[] = [];
  for (const [objectId, d1Obj] of d1Map.entries()) {
    if (!repoMap.has(objectId)) {
      missingObjects.push({
        object_id: objectId,
        dbId: d1Obj.id,
        title: d1Obj.title ?? null,
        usedByStories: usageMap.get(objectId) ?? [],
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

  return { newObjects, changedObjects, missingObjects, unregisteredFiles };
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
  image_available: boolean;
}

export async function applySyncChanges(
  projectId: number,
  changes: SyncChanges,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>
): Promise<{ appliedCount: number; pendingObjects: PendingObject[] }> {
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
        image_available: iiifObjectIds.has(objectId),
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
      const choice = choices[field] ?? "repo";
      if (choice === "repo") {
        if (field === "featured") {
          updatePayload[field] = Boolean(repoRow.featured);
        } else {
          updatePayload[field] = (repoRow[field] as string | null | undefined) || null;
        }
      }
      // "d1" means keep existing — no update needed
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
  const allD1ObjectIds = [...d1Map.keys()];
  const removedSet = new Set(removedObjectIds);
  const repoObjectIds = new Set(repoMap.keys());

  for (const objectId of allD1ObjectIds) {
    if (!repoObjectIds.has(objectId) && !removedSet.has(objectId)) {
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

  return { appliedCount, pendingObjects };
}

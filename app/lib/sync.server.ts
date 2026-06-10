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
 * @version v1.3.0-beta
 */

import { eq, and } from "drizzle-orm";
import { objects, steps, layers, stories, project_config, glossary_terms } from "~/db/schema";
import { getFileContent, getRepoTree, getRepoHead } from "~/lib/github.server";
import { parseTelarCsv, mapObjectsCsv, mapProjectCsv, mapStoryCsv } from "~/lib/import.server";
import { compareVersions } from "~/lib/upgrade.server";
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
  "dimensions",
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
  dimensions: string | null;
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
        dimensions: (repoRow.dimensions as string) || null,
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
  // Compositor-origin objects are excluded: they were created by the compositor
  // and their CSV commit may have failed (e.g. StaleHeadError). They are
  // legitimate objects — warn rather than offering to delete.
  const missingObjects: MissingObject[] = [];
  for (const [objectId, d1Obj] of d1Map.entries()) {
    if (!repoMap.has(objectId)) {
      if (d1Obj.origin === "compositor") {
        continue; // skip — compositor-origin objects are not classified as missing
      }
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

/**
 * Minimal publish snapshot type — a snapshot of the content state at the time
 * of the last publish. Used to distinguish "both sides changed" (conflict) from
 * "only repo changed" (auto-accept). Defined here to avoid a circular dependency
 * with publish.server.ts. When publish runs, the
 * PublishSnapshot type from publish.server.ts can be used as a drop-in
 * replacement since this interface is structurally compatible.
 */
export interface PublishSnapshot {
  stories: Array<{
    story_id: string;
    title: string | null;
    subtitle: string | null;
    byline: string | null;
    order: number;
    isPrivate: boolean;
  }>;
  config: Record<string, string | null>;
}

export interface StorySyncItem {
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  order: number;
  isPrivate: boolean;
}

export interface StorySyncChangedItem {
  story_id: string;
  title: string | null;
  changedFields: string[];
  /** True when both repo and D1 changed this story since the publish baseline */
  isConflict: boolean;
}

export interface StorySyncDiff {
  newStories: StorySyncItem[];
  changedStories: StorySyncChangedItem[];
  missingStories: Array<{ story_id: string; title: string | null }>;
}

export interface ConfigSyncDiff {
  changedFields: Array<{ key: string; d1Value: string | null; repoValue: string | null }>;
  /** Set when repo telar.version differs from D1 telar_version. */
  versionChange: {
    direction: "ahead" | "behind";
    repoVersion: string;
    d1Version: string | null;
  } | null;
}

export interface GlossarySyncDiff {
  /** Terms in the repo CSV that are not in D1 */
  added: Array<{ term_id: string; title: string; definition: string; related_terms: string }>;
  /** Terms in D1 that are not in the repo CSV */
  removed: Array<{ term_id: string; title: string; dbId: number }>;
  /** Terms in both but with differing definitions or related_terms */
  changed: Array<{
    term_id: string;
    title: string;
    dbId: number;
    d1Definition: string;
    repoDefinition: string;
    d1RelatedTerms: string;
    repoRelatedTerms: string;
  }>;
}

export interface FullSyncDiff {
  objects: SyncDiff;
  stories: StorySyncDiff;
  config: ConfigSyncDiff;
  glossary: GlossarySyncDiff;
  /** True when at least one story or config field is a conflict (both sides changed) */
  hasConflicts: boolean;
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
// Config field extractor
// ---------------------------------------------------------------------------

/** Managed _config.yml fields synced between repo and D1 */
const MANAGED_CONFIG_FIELDS = [
  "title",
  "lang",
  "baseurl",
  "url",
  "description",
  "author",
  "email",
] as const;

type ManagedConfigField = typeof MANAGED_CONFIG_FIELDS[number];

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
 * Extracts managed config field values from a raw _config.yml string using
 * line-based parsing — same approach as disableGoogleSheetsInConfig to avoid
 * a js-yaml dependency in sync.server.ts and to preserve multi-line config
 * files with comments.
 *
 * Only extracts top-level scalar keys (the managed set). Complex YAML sub-keys
 * (e.g. telar.version) are not touched. Handles double-quoted, single-quoted,
 * and bare scalar values correctly — the previous regex silently returned null
 * for any value containing a quote (e.g. HTML descriptions).
 */
export function extractConfigFields(yamlContent: string): Record<ManagedConfigField, string | null> {
  const result: Record<string, string | null> = {};
  for (const key of MANAGED_CONFIG_FIELDS) {
    // Match the key line and capture the raw remainder (top-level keys only).
    const m = yamlContent.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
    result[key] = m ? parseYamlScalar(m[1]) : null;
  }
  return result as Record<ManagedConfigField, string | null>;
}

/**
 * Extract the `version:` value from the `telar:` block of a site's
 * _config.yml. Returns null when absent or malformed. Mirrors the
 * line-walker pattern in updateTelarVersionInConfig (upgrade.server.ts)
 * to avoid a full YAML parse — keeps comments/whitespace-tolerance cheap
 * and preserves behaviour on the same exotic inputs.
 *
 * Exported to enable direct unit testing (see tests/sync.server.test.ts).
 */
export function extractTelarVersion(yamlContent: string): string | null {
  const lines = yamlContent.split("\n");
  let inTelar = false;
  for (const line of lines) {
    if (/^telar:/.test(line)) {
      inTelar = true;
      continue;
    }
    if (inTelar) {
      // End of telar: block when a non-indented, non-comment, non-empty line appears
      if (/^[^\s#]/.test(line) && line.trim() !== "") break;
      const m = line.match(/^\s+version:\s*["']?([^\s"'#]+)/);
      if (m) return m[1];
    }
  }
  return null;
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
 * Conflict detection: when `publishSnapshot` is non-null, a story change is
 * flagged as a conflict only if BOTH the repo value AND the D1 value differ
 * from the snapshot baseline. If `publishSnapshot` is null (never published),
 * all diffs are returned without conflict flags — `hasConflicts` is false.
 *
 * D1 wins by default for conflicts — callers must explicitly add conflicting
 * story_ids to `changes.stories.accept` to apply the repo version.
 */
export async function computeFullSyncDiff(
  projectId: number,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  publishSnapshot: PublishSnapshot | null,
): Promise<FullSyncDiff> {
  // 1. Delegate objects diff to existing function
  const objectsDiff = await computeSyncDiff(projectId, token, owner, repo, db);

  // 2. Fetch project.csv from repo and parse into story rows
  const projectCsvContent = await getFileContent(
    token, owner, repo, "telar-content/spreadsheets/project.csv"
  );
  const repoStoryRows = projectCsvContent
    ? mapProjectCsv(parseTelarCsv(projectCsvContent), projectId)
    : [];
  const repoStoryMap = new Map(
    repoStoryRows.map((r) => [
      r.story_id as string,
      {
        story_id: r.story_id as string,
        title: (r.title as string | null | undefined) ?? null,
        subtitle: (r.subtitle as string | null | undefined) ?? null,
        byline: (r.byline as string | null | undefined) ?? null,
        order: (r.order as number) ?? 0,
        isPrivate: Boolean(r.private),
      } as StorySyncItem,
    ])
  );

  // 3. Fetch D1 stories for this project
  const d1StoryRows = await db
    .select()
    .from(stories)
    .where(eq(stories.project_id, projectId));
  const d1StoryMap = new Map(d1StoryRows.map((s) => [s.story_id, s]));

  // 4. Build snapshot baseline maps for conflict detection
  const snapshotStoryMap = publishSnapshot
    ? new Map(publishSnapshot.stories.map((s) => [s.story_id, s]))
    : null;

  // 5. Compute story diffs
  //
  // `order` is intentionally excluded: the import pipeline writes a 0-based
  // sequence into `stories.order`, but `project.csv` is 1-based, so every
  // freshly-imported project would report every story as "(changed)" on
  // every sync check. Until the import is normalised to match the CSV
  // (separate fix), the sync diff compares user-visible content only.
  // Trade-off: a pure reorder with no content change won't surface here —
  // a known limitation.
  const storyFields: Array<keyof StorySyncItem> = ["title", "subtitle", "byline", "isPrivate"];

  const newStories: StorySyncItem[] = [];
  const changedStories: StorySyncChangedItem[] = [];
  const missingStories: Array<{ story_id: string; title: string | null }> = [];

  for (const [storyId, repoRow] of repoStoryMap.entries()) {
    if (!d1StoryMap.has(storyId)) {
      newStories.push(repoRow);
    } else {
      const d1Row = d1StoryMap.get(storyId)!;
      const changedFields: string[] = [];

      const d1Item: StorySyncItem = {
        story_id: storyId,
        title: d1Row.title ?? null,
        subtitle: d1Row.subtitle ?? null,
        byline: d1Row.byline ?? null,
        order: d1Row.order ?? 0,
        isPrivate: d1Row.private ?? false,
      };

      for (const field of storyFields) {
        const repoVal = String(repoRow[field] ?? "");
        const d1Val = String(d1Item[field] ?? "");
        if (repoVal !== d1Val) {
          changedFields.push(field);
        }
      }

      if (changedFields.length > 0) {
        let isConflict = false;
        if (snapshotStoryMap) {
          const baseline = snapshotStoryMap.get(storyId);
          if (baseline) {
            // Conflict: both repo and D1 changed relative to baseline
            const repoChangedFromBaseline = changedFields.some((f) => {
              const key = f as keyof StorySyncItem;
              return String(repoRow[key] ?? "") !== String(baseline[key] ?? "");
            });
            const d1ChangedFromBaseline = changedFields.some((f) => {
              const key = f as keyof StorySyncItem;
              return String(d1Item[key] ?? "") !== String(baseline[key] ?? "");
            });
            isConflict = repoChangedFromBaseline && d1ChangedFromBaseline;
          }
        }

        changedStories.push({
          story_id: storyId,
          title: d1Row.title ?? null,
          changedFields,
          isConflict,
        });
      }
    }
  }

  for (const [storyId, d1Row] of d1StoryMap.entries()) {
    if (!repoStoryMap.has(storyId)) {
      missingStories.push({ story_id: storyId, title: d1Row.title ?? null });
    }
  }

  // 6. Fetch _config.yml and compare against D1 project_config
  const configYmlContent = await getFileContent(token, owner, repo, "_config.yml");
  const repoConfigFields = configYmlContent
    ? extractConfigFields(configYmlContent)
    : ({} as Record<ManagedConfigField, string | null>);

  const d1ConfigRows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, projectId));
  const d1Config = (d1ConfigRows[0] as unknown as Record<string, string | null | undefined> | undefined) ?? {};

  const configChangedFields: ConfigSyncDiff["changedFields"] = [];

  for (const key of MANAGED_CONFIG_FIELDS) {
    const repoVal = repoConfigFields[key] ?? null;
    const d1Val = (d1Config[key] as string | null | undefined) ?? null;

    if (repoVal !== null && repoVal !== d1Val) {
      configChangedFields.push({ key, d1Value: d1Val, repoValue: repoVal });
    }
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
      const repoTag = repoTelarVersion.startsWith("v") ? repoTelarVersion : `v${repoTelarVersion}`;
      const d1Tag = d1TelarVersion.startsWith("v") ? d1TelarVersion : `v${d1TelarVersion}`;
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

  // 7. Determine if there are any conflicts
  const hasConflicts =
    publishSnapshot !== null && changedStories.some((s) => s.isConflict);

  // 8. Compute glossary diff
  const glossaryDiff = await computeGlossarySyncDiff(projectId, token, owner, repo, db);

  return {
    objects: objectsDiff,
    stories: { newStories, changedStories, missingStories },
    config: { changedFields: configChangedFields, versionChange },
    glossary: glossaryDiff,
    hasConflicts,
  };
}

// ---------------------------------------------------------------------------
// computeGlossarySyncDiff
// ---------------------------------------------------------------------------

/**
 * Computes a diff between D1 glossary_terms and the repo's glossary.csv.
 *
 * - added: terms in repo CSV not in D1
 * - removed: terms in D1 not in repo CSV
 * - changed: terms in both but with differing definitions
 */
export async function computeGlossarySyncDiff(
  projectId: number,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof import("~/lib/db.server").getDb>,
): Promise<GlossarySyncDiff> {
  // Fetch glossary CSV from repo
  const glossaryCsvContent = await getFileContent(
    token, owner, repo, "telar-content/spreadsheets/glossary.csv"
  );
  const repoTerms = glossaryCsvContent
    ? parseTelarCsv(glossaryCsvContent)
    : [];
  const repoTermMap = new Map(
    repoTerms
      .filter((r) => r.term_id)
      .map((r) => [
        r.term_id,
        { title: r.title ?? "", definition: r.definition ?? "", related_terms: r.related_terms ?? "" },
      ]),
  );

  // Fetch D1 glossary terms for this project
  const d1Terms = await db
    .select()
    .from(glossary_terms)
    .where(eq(glossary_terms.project_id, projectId));
  const d1TermMap = new Map(d1Terms.map((t) => [t.term_id, t]));

  const added: GlossarySyncDiff["added"] = [];
  const removed: GlossarySyncDiff["removed"] = [];
  const changed: GlossarySyncDiff["changed"] = [];

  // Find added and changed
  for (const [termId, repoTerm] of repoTermMap.entries()) {
    const d1Term = d1TermMap.get(termId);
    if (!d1Term) {
      added.push({ term_id: termId, title: repoTerm.title, definition: repoTerm.definition, related_terms: repoTerm.related_terms });
    } else if (
      (d1Term.definition ?? "") !== repoTerm.definition ||
      (d1Term.related_terms ?? "") !== repoTerm.related_terms
    ) {
      changed.push({
        term_id: termId,
        title: d1Term.title ?? repoTerm.title,
        dbId: d1Term.id,
        d1Definition: d1Term.definition ?? "",
        repoDefinition: repoTerm.definition,
        d1RelatedTerms: d1Term.related_terms ?? "",
        repoRelatedTerms: repoTerm.related_terms,
      });
    }
  }

  // Find removed
  for (const [termId, d1Term] of d1TermMap.entries()) {
    if (!repoTermMap.has(termId)) {
      removed.push({ term_id: termId, title: d1Term.title ?? "", dbId: d1Term.id });
    }
  }

  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// applyFullSyncChanges
// ---------------------------------------------------------------------------

/**
 * Applies the user's selected full sync changes to D1.
 *
 * Objects: delegates to existing `applySyncChanges`.
 * Stories:
 *   - insertNew: fetch story CSV from repo, insert story row + steps
 *   - accept: update D1 story fields to repo values
 *   - reject: no change (D1 wins)
 * Config:
 *   - accept: update matching project_config fields
 *   - reject: no change (D1 wins)
 * After all changes: fetch current repo HEAD SHA and update projects.head_sha.
 *
 * Returns the new HEAD SHA.
 */
export async function applyFullSyncChanges(
  projectId: number,
  changes: FullSyncChanges,
  token: string,
  owner: string,
  repo: string,
  db: ReturnType<typeof getDb>,
  diff?: FullSyncDiff,
): Promise<{ newHeadSha: string }> {
  const { stories: storyChanges, config: configChanges } = changes;

  // 1. Apply object changes via existing function
  await applySyncChanges(projectId, changes.objects, token, owner, repo, db);

  const now = new Date().toISOString();

  // 2. Re-fetch project.csv to get current story values from repo
  const projectCsvContent = await getFileContent(
    token, owner, repo, "telar-content/spreadsheets/project.csv"
  );
  const repoStoryRows = projectCsvContent
    ? mapProjectCsv(parseTelarCsv(projectCsvContent), projectId)
    : [];
  const repoStoryMap = new Map(
    repoStoryRows.map((r) => [r.story_id as string, r])
  );

  // 3. Insert new stories (and their steps)
  const acceptSet = new Set(storyChanges.accept);
  const insertSet = new Set(storyChanges.insertNew);

  for (const storyId of insertSet) {
    const repoRow = repoStoryMap.get(storyId);
    if (!repoRow) continue;

    // Insert story record
    await db
      .insert(stories)
      .values({
        project_id: projectId,
        story_id: storyId,
        title: (repoRow.title as string | undefined) || undefined,
        subtitle: (repoRow.subtitle as string | undefined) || undefined,
        byline: (repoRow.byline as string | undefined) || undefined,
        order: (repoRow.order as number) ?? 0,
        private: Boolean(repoRow.private),
      });

    // Fetch and insert story steps
    const storyCsvContent = await getFileContent(
      token, owner, repo, `telar-content/spreadsheets/${storyId}.csv`
    );
    if (storyCsvContent) {
      // Get the newly inserted story's DB id
      const insertedStoryRows = await db
        .select()
        .from(stories)
        .where(and(eq(stories.project_id, projectId), eq(stories.story_id, storyId)));

      if (insertedStoryRows.length > 0) {
        const storyDbId = insertedStoryRows[0].id;
        const { steps: stepRows, layers: layerRows } = mapStoryCsv(
          parseTelarCsv(storyCsvContent),
          storyDbId,
        );

        if (stepRows.length > 0) {
          const stepsWithId = stepRows.map((s) => ({ ...s, story_id: storyDbId }));
          // D1: steps has 14 inserted cols → max 7 rows per insert (7×14=98 ≤ 100)
          for (let i = 0; i < stepsWithId.length; i += 7) {
            await db.insert(steps).values(stepsWithId.slice(i, i + 7));
          }
        }

        if (layerRows.length > 0) {
          // Back-fill real step ids. mapStoryCsv sets step_id = -(index+1) as a
          // placeholder where the index is the row's position in the filtered CSV
          // (not the explicit `step` column value). After inserting steps, SELECT
          // them back and sort by `id` ASC (insertion order), which matches the
          // filtered-row order used to assign placeholders. Sorting by step_number
          // would misalign layers when the CSV has non-sequential step values.
          const insertedSteps = await db
            .select({ id: steps.id })
            .from(steps)
            .where(eq(steps.story_id, storyDbId));
          const orderedStepIds = insertedSteps
            .sort((a, b) => a.id - b.id)
            .map((s) => s.id);
          const layersWithIds = layerRows
            .map((layer) => {
              const stepIndex = Math.abs(layer.step_id as number) - 1; // placeholder → 0-based
              const realStepId = orderedStepIds[stepIndex];
              if (realStepId === undefined) return null;
              return { ...layer, step_id: realStepId };
            })
            .filter((l): l is NonNullable<typeof l> => l !== null);
          // layers table has 6 columns → max 16 rows per insert (D1 bind-var limit)
          for (let i = 0; i < layersWithIds.length; i += 16) {
            await db.insert(layers).values(layersWithIds.slice(i, i + 16));
          }
        }
      }
    }
  }

  // 4. Update accepted changed stories
  for (const storyId of acceptSet) {
    const repoRow = repoStoryMap.get(storyId);
    if (!repoRow) continue;

    await db
      .update(stories)
      .set({
        title: (repoRow.title as string | undefined) || undefined,
        subtitle: (repoRow.subtitle as string | undefined) || undefined,
        byline: (repoRow.byline as string | undefined) || undefined,
        order: (repoRow.order as number) ?? 0,
        private: Boolean(repoRow.private),
        updated_at: now,
      })
      .where(and(eq(stories.project_id, projectId), eq(stories.story_id, storyId)));
  }

  // 5. Apply accepted config changes
  if (configChanges.accept.length > 0) {
    const configYmlContent = await getFileContent(token, owner, repo, "_config.yml");
    if (configYmlContent) {
      const repoConfigFields = extractConfigFields(configYmlContent);
      const updatePayload: Record<string, string | null | undefined> = { updated_at: now };

      for (const key of configChanges.accept) {
        if (MANAGED_CONFIG_FIELDS.includes(key as ManagedConfigField)) {
          updatePayload[key] = repoConfigFields[key as ManagedConfigField] ?? null;
        }
      }

      await db
        .update(project_config)
        .set(updatePayload)
        .where(eq(project_config.project_id, projectId));
    }
  }

  // 6. Apply accepted glossary changes
  const glossaryChanges = changes.glossary ?? { accept: [], reject: [], insertNew: [] };
  if (glossaryChanges.insertNew.length > 0 || glossaryChanges.accept.length > 0 || glossaryChanges.reject.length > 0) {
    // Re-fetch glossary CSV to get current repo values
    const glossaryCsvContent = await getFileContent(
      token, owner, repo, "telar-content/spreadsheets/glossary.csv"
    );
    const repoTerms = glossaryCsvContent ? parseTelarCsv(glossaryCsvContent) : [];
    const repoTermMap = new Map(
      repoTerms.filter((r) => r.term_id).map((r) => [r.term_id, r])
    );

    // Insert new terms (accepted additions from repo)
    for (const termId of glossaryChanges.insertNew) {
      const repoTerm = repoTermMap.get(termId);
      if (!repoTerm) continue;
      await db
        .insert(glossary_terms)
        .values({
          project_id: projectId,
          term_id: termId,
          title: repoTerm.title || undefined,
          definition: repoTerm.definition || undefined,
          related_terms: repoTerm.related_terms || undefined,
          updated_at: now,
        });
    }

    // Update changed terms where user accepted repo version
    for (const termId of glossaryChanges.accept) {
      const repoTerm = repoTermMap.get(termId);
      if (!repoTerm) continue;
      await db
        .update(glossary_terms)
        .set({
          definition: repoTerm.definition || null,
          related_terms: repoTerm.related_terms || null,
          updated_at: now,
        })
        .where(
          and(
            eq(glossary_terms.project_id, projectId),
            eq(glossary_terms.term_id, termId),
          ),
        );
    }
  }

  // 6b. Silently heal D1 telar_version when repo is ahead (external
  // upgrade performed via telar/scripts/upgrade.py or GitHub Actions).
  // Do NOT auto-downgrade on "behind" — user decides via the
  // dashboard. When no diff is provided (pre-Plan-11 callers), skip healing.
  if (diff?.config.versionChange?.direction === "ahead") {
    await db
      .update(project_config)
      .set({
        telar_version: diff.config.versionChange.repoVersion,
        updated_at: now,
      })
      .where(eq(project_config.project_id, projectId));
  }

  // 7. Fetch current repo HEAD and update projects.head_sha
  const { projects } = await import("~/db/schema");
  const newHeadSha = await getRepoHead(token, owner, repo);

  await db
    .update(projects)
    .set({ head_sha: newHeadSha, last_synced_at: now, updated_at: now, gh_checked_at: null })
    .where(eq(projects.id, projectId));

  return { newHeadSha };
}

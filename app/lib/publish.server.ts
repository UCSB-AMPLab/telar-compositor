/**
 * Publish library for Telar Compositor.
 *
 * Provides all server-side logic for the Publish wizard:
 *   - CSV serialisation (project.csv and per-story CSVs) in Telar bilingual format
 *   - Layer markdown file helpers (filename derivation and file content assembly)
 *   - Line-based _config.yml mutation preserving comments and formatting
 *   - Change summary computation against a stored publish snapshot
 *   - Pre-publish validation (stale HEAD, missing titles, missing positions)
 *   - Full publish file set assembly (buildPublishFileSet)
 *
 * Called by the Publish route — no UI logic lives here.
 */

import Papa from "papaparse";
import { eq } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import { getFileContent } from "~/lib/github.server";
import { slugify } from "~/lib/slugify";
import { extractCommentRows, serializeObjectsCsv, dbObjectToCsvRow } from "~/lib/csv-export.server";
import type { CommitFile } from "~/lib/commit.server";
import {
  projects,
  project_config,
  project_landing,
  stories,
  steps,
  layers,
  objects,
  glossary_terms,
  project_pages,
} from "~/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublishSnapshot {
  /** Non-draft story_ids published in the last commit */
  story_ids: string[];
  /** All object_ids at the time of the last publish */
  object_ids: string[];
  /** JSON.stringify of managed project_config fields */
  config_hash: string;
  /** JSON.stringify of project_landing fields */
  landing_hash: string;
}

export interface ChangeSummary {
  isUpToDate: boolean;
  stories: {
    new: { story_id: string; title: string | null }[];
    modified: { story_id: string; title: string | null }[];
    deleted: { story_id: string; title: string | null }[];
  };
  objects: {
    new: { object_id: string; title: string | null }[];
    modified: { object_id: string; title: string | null }[];
    deleted: { object_id: string; title: string | null }[];
  };
  settings: { changed: { key: string; label: string }[] };
  landing: { changed: boolean };
}

export interface ValidationItem {
  code: string;
  message: string;
  entityId?: string;
  params?: Record<string, string>;
}

export interface ValidationResult {
  blockers: ValidationItem[];
  warnings: ValidationItem[];
}

/** Input state used for computing change summaries */
export interface CurrentPublishState {
  storyIds: string[];
  objectIds: string[];
  configHash: string;
  landingHash: string;
  stories: { story_id: string; title: string | null }[];
  objects: { object_id: string; title: string | null }[];
}

// ---------------------------------------------------------------------------
// Project CSV serialiser
// ---------------------------------------------------------------------------

const PROJECT_CSV_COLUMNS = [
  "order",
  "story_id",
  "title",
  "subtitle",
  "byline",
  "private",
] as const;

const PROJECT_BILINGUAL_ROW: Record<string, string> = {
  order: "orden",
  story_id: "id_historia",
  title: "titulo",
  subtitle: "subtitulo",
  byline: "firma",
  private: "privada",
};

interface StoryRow {
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  order: number;
  private: boolean;
  draft: boolean;
}

/** Normalises PapaParse output to LF-only line endings */
const normalise = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/**
 * Serialises D1 story rows to the Telar project.csv format.
 *
 * Output structure:
 *   Line 1: English header row
 *   Line 2: Spanish bilingual row
 *   Lines 3+: Comment/instruction rows (preserved from existing CSV)
 *   Remaining: Data rows, sorted by order ascending, draft stories omitted
 *
 * private: true → "yes"; false → ""
 */
export function serializeProjectCsv(storyRows: StoryRow[], existingCsv?: string): string {
  const columns = PROJECT_CSV_COLUMNS as unknown as string[];

  const headerCsv = normalise(Papa.unparse([{}], { columns })).split("\n")[0];

  // Bilingual row — Spanish column name equivalents required by Telar's CSV parser
  const bilingualRow = normalise(
    Papa.unparse([columns.map((col) => PROJECT_BILINGUAL_ROW[col] ?? col)], { header: false }),
  );

  const commentRows = existingCsv ? extractCommentRows(existingCsv) : [];

  // Filter out drafts, sort by order
  const filtered = storyRows
    .filter((s) => !s.draft)
    .sort((a, b) => a.order - b.order);

  const dataRows = filtered.map((s) => ({
    order: String(s.order),
    story_id: s.story_id,
    title: s.title ?? "",
    subtitle: s.subtitle ?? "",
    byline: s.byline ?? "",
    private: s.private ? "yes" : "",
  }));

  const dataCsv = normalise(Papa.unparse(dataRows, { columns }))
    .split("\n")
    .slice(1)
    .join("\n");

  return [headerCsv, bilingualRow, ...commentRows, dataCsv].join("\n");
}

// ---------------------------------------------------------------------------
// Story CSV serialiser
// ---------------------------------------------------------------------------

const STORY_CSV_COLUMNS = [
  "step",
  "object",
  "x",
  "y",
  "zoom",
  "page",
  "question",
  "answer",
  "alt_text",
  "layer1_button",
  "layer1_content",
  "layer2_button",
  "layer2_content",
  "clip_start",
  "clip_end",
  "loop",
] as const;

const STORY_BILINGUAL_ROW: Record<string, string> = {
  step: "paso",
  object: "objeto",
  x: "x",
  y: "y",
  zoom: "zoom",
  page: "pagina",
  question: "pregunta",
  answer: "respuesta",
  alt_text: "texto_alt",
  layer1_button: "boton1",
  layer1_content: "contenido1",
  layer2_button: "boton2",
  layer2_content: "contenido2",
  clip_start: "inicio_clip",
  clip_end: "fin_clip",
  loop: "bucle",
};

export interface LayerData {
  layer_number: number;
  title: string | null;
  button_label: string | null;
  content: string | null;
}

export interface StepWithLayers {
  step_number: number;
  object_id: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
  page: string | null;
  question: string | null;
  answer: string | null;
  alt_text: string | null;
  clip_start: string | null;
  clip_end: string | null;
  loop: string | null;
  layers: LayerData[];
}

/**
 * Returns true if a step is "fully empty" — no content, no object, no layers.
 * Fully empty steps are skipped during publish (they are not valid rows).
 */
function isFullyEmptyStep(step: StepWithLayers): boolean {
  if (step.object_id) return false;
  if (step.question) return false;
  if (step.answer) return false;
  if (step.layers.some((l) => l.content)) return false;
  return true;
}

/**
 * Serialises D1 step rows (with layers) to a Telar story CSV.
 *
 * @param stepRows The steps to serialise, each containing their layers
 * @param storySlug The slug of the story — used as prefix for layer filenames
 * @param existingCsv Optional existing CSV content for comment preservation
 */
export function serializeStoryCsv(
  stepRows: StepWithLayers[],
  storySlug: string,
  existingCsv?: string,
): string {
  const columns = STORY_CSV_COLUMNS as unknown as string[];

  const headerCsv = normalise(Papa.unparse([{}], { columns })).split("\n")[0];

  // Bilingual row — Spanish column name equivalents required by Telar's CSV parser
  const bilingualRow = normalise(
    Papa.unparse([columns.map((col) => STORY_BILINGUAL_ROW[col] ?? col)], { header: false }),
  );

  const commentRows = existingCsv ? extractCommentRows(existingCsv) : [];

  // Track used filenames per story to detect duplicates
  const usedFilenames = new Set<string>();

  const nonEmptySteps = stepRows.filter((s) => !isFullyEmptyStep(s));

  const dataRows = nonEmptySteps.map((step) => {
    const layer1 = step.layers.find((l) => l.layer_number === 1) ?? null;
    const layer2 = step.layers.find((l) => l.layer_number === 2) ?? null;

    // Layer is "present" only when it has non-empty content
    const layer1HasContent = Boolean(layer1?.content);
    const layer2HasContent = Boolean(layer2?.content);

    const layer1Filename = layer1HasContent
      ? layerFilename(storySlug, step.step_number, 1, layer1?.title, usedFilenames)
      : "";
    const layer2Filename = layer2HasContent
      ? layerFilename(storySlug, step.step_number, 2, layer2?.title, usedFilenames)
      : "";

    return {
      step: String(step.step_number),
      object: step.object_id ?? "",
      x: String(step.x ?? 0.5),
      y: String(step.y ?? 0.5),
      zoom: String(step.zoom ?? 1),
      page: step.page && step.page !== "1" ? step.page : "",
      question: step.question ?? "",
      answer: step.answer ?? "",
      alt_text: step.alt_text ?? "",
      layer1_button: layer1HasContent ? (layer1?.button_label ?? "") : "",
      layer1_content: layer1Filename,
      layer2_button: layer2HasContent ? (layer2?.button_label ?? "") : "",
      layer2_content: layer2Filename,
      clip_start: step.clip_start ?? "",
      clip_end: step.clip_end ?? "",
      loop: step.loop ?? "",
    };
  });

  const dataCsv = normalise(Papa.unparse(dataRows, { columns }))
    .split("\n")
    .slice(1)
    .join("\n");

  return [headerCsv, bilingualRow, ...commentRows, dataCsv].join("\n");
}

// ---------------------------------------------------------------------------
// Layer file helpers
// ---------------------------------------------------------------------------

/**
 * Derives the filename for a layer markdown file.
 *
 * Uses `{storySlug}-{slugify(title)}.md` when a title is provided.
 * Falls back to `{storySlug}-step{N}-layer{N}.md` when:
 *   - title is null or empty
 *   - the derived filename is already in usedFilenames (duplicate detection)
 *
 * Adds the result to usedFilenames if provided.
 */
export function layerFilename(
  storySlug: string,
  stepNumber: number,
  layerNumber: number,
  title?: string | null,
  usedFilenames?: Set<string>,
): string {
  const fallback = `${storySlug}-step${stepNumber}-layer${layerNumber}.md`;

  if (!title || title.trim() === "") {
    if (usedFilenames) usedFilenames.add(fallback);
    return fallback;
  }

  const titleBased = `${storySlug}-${slugify(title)}.md`;

  if (usedFilenames && usedFilenames.has(titleBased)) {
    // Collision — fall back to step/layer numbering
    usedFilenames.add(fallback);
    return fallback;
  }

  if (usedFilenames) usedFilenames.add(titleBased);
  return titleBased;
}

/**
 * Produces the content of a layer markdown file.
 *
 * When a title is provided: YAML frontmatter with title key + blank line + content.
 * When no title: just the content (no frontmatter block).
 */
export function layerFileContent(
  title: string | null | undefined,
  content: string,
): string {
  if (!title || title.trim() === "") {
    return content;
  }
  return `---\ntitle: ${yamlQuote(title)}\n---\n\n${content}`;
}

// ---------------------------------------------------------------------------
// Config mutation
// ---------------------------------------------------------------------------

/**
 * Updates managed fields in a _config.yml string using line-based regex mutation.
 *
 * Preserves all comments, indentation, quotes, and unmanaged fields.
 * Appends fields that are not found.
 *
 * The `story_key` field is special: it lives under the `protected:` block as
 * `  key: {value}`. When updating story_key, we scan for `^  key:` inside
 * the `^protected:` block.
 */
export function updateConfigFields(yaml: string, fields: Record<string, string>): string {
  const lines = yaml.split("\n");
  const result: string[] = [];
  const fieldsToAppend = new Set(Object.keys(fields));

  let inProtected = false;
  const storyKeyValue = fields["story_key"];
  let storyKeyUpdated = false;

  for (const line of lines) {
    // Track protected: block
    if (/^protected:/.test(line)) {
      inProtected = true;
      result.push(line);
      continue;
    }

    // Exiting protected block (non-indented, non-empty, non-comment line)
    if (inProtected && /^[^\s#]/.test(line) && line.trim() !== "") {
      inProtected = false;
    }

    // Handle story_key inside protected block
    if (inProtected && storyKeyValue !== undefined && !storyKeyUpdated && /^\s+key:/.test(line)) {
      result.push(`  key: ${storyKeyValue}`);
      fieldsToAppend.delete("story_key");
      storyKeyUpdated = true;
      continue;
    }

    // Handle regular top-level fields
    let pushed = false;
    for (const [key, value] of Object.entries(fields)) {
      if (key === "story_key") continue; // handled separately above
      if (new RegExp(`^${key}:`).test(line)) {
        result.push(`${key}: ${value}`);
        fieldsToAppend.delete(key);
        pushed = true;
        break;
      }
    }

    if (!pushed) {
      result.push(line);
    }
  }

  // Append any fields not found in the original YAML
  // Insert before trailing blank lines to keep formatting tidy
  const appended: string[] = [];
  for (const key of fieldsToAppend) {
    if (key === "story_key" && !storyKeyUpdated) {
      // story_key not found under protected — append at top level
      appended.push(`${key}: ${fields[key]}`);
    } else if (key !== "story_key") {
      appended.push(`${key}: ${fields[key]}`);
    }
  }

  if (appended.length > 0) {
    // Find the last non-empty line index
    let insertAt = result.length;
    while (insertAt > 0 && result[insertAt - 1].trim() === "") {
      insertAt--;
    }
    result.splice(insertAt, 0, ...appended);
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Change summary
// ---------------------------------------------------------------------------

/**
 * Computes the change summary between current D1 state and the last publish snapshot.
 *
 * If snapshot is null (first-time publish), all entities are classified as "new".
 */
export function computeChangeSummary(
  currentState: CurrentPublishState,
  snapshot: PublishSnapshot | null,
): ChangeSummary {
  if (snapshot === null) {
    // First-time publish — everything is new
    return {
      isUpToDate: false,
      stories: {
        new: currentState.stories,
        modified: [],
        deleted: [],
      },
      objects: {
        new: currentState.objects,
        modified: [],
        deleted: [],
      },
      settings: { changed: [{ key: "all", label: "All settings (first publish)" }] },
      landing: { changed: true },
    };
  }

  const currentStorySet = new Set(currentState.storyIds);
  const snapshotStorySet = new Set(snapshot.story_ids);
  const currentObjectSet = new Set(currentState.objectIds);
  const snapshotObjectSet = new Set(snapshot.object_ids);

  // Stories: new = in current but not snapshot; deleted = in snapshot but not current
  // modified = in both (we don't have per-story hashes, so treat all existing as modified)
  const newStories = currentState.stories.filter((s) => !snapshotStorySet.has(s.story_id));
  const modifiedStories = currentState.stories.filter((s) => snapshotStorySet.has(s.story_id));
  const deletedStoryIds = snapshot.story_ids.filter((id) => !currentStorySet.has(id));
  const deletedStories = deletedStoryIds.map((id) => ({ story_id: id, title: null }));

  // Objects: new = in current but not snapshot; deleted = in snapshot but not current
  // modified = in both (same reasoning as stories)
  const newObjects = currentState.objects.filter((o) => !snapshotObjectSet.has(o.object_id));
  const modifiedObjects = currentState.objects.filter((o) => snapshotObjectSet.has(o.object_id));
  const deletedObjectIds = snapshot.object_ids.filter((id) => !currentObjectSet.has(id));
  const deletedObjects = deletedObjectIds.map((id) => ({ object_id: id, title: null }));

  // Config and landing changes detected via hash comparison
  const configChanged = currentState.configHash !== snapshot.config_hash;
  const landingChanged = currentState.landingHash !== snapshot.landing_hash;

  const settingsChanged = configChanged
    ? [{ key: "config", label: "Site settings changed" }]
    : [];

  // Without per-entity hashes, isUpToDate is always false when there are
  // existing stories or objects (they appear as "modified"). This is
  // conservative but ensures users can always publish edits.
  const isUpToDate =
    newStories.length === 0 &&
    modifiedStories.length === 0 &&
    deletedStories.length === 0 &&
    newObjects.length === 0 &&
    modifiedObjects.length === 0 &&
    deletedObjects.length === 0 &&
    !configChanged &&
    !landingChanged;

  return {
    isUpToDate,
    stories: {
      new: newStories,
      modified: modifiedStories,
      deleted: deletedStories,
    },
    objects: {
      new: newObjects,
      modified: modifiedObjects,
      deleted: deletedObjects,
    },
    settings: { changed: settingsChanged },
    landing: { changed: landingChanged },
  };
}

// ---------------------------------------------------------------------------
// Pre-publish validation
// ---------------------------------------------------------------------------

export interface StoryForValidation {
  story_id: string;
  title: string | null;
}

export interface StepForValidation {
  id: number;
  step_number: number;
  object_id: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
  question: string | null;
  answer: string | null;
}

export interface ObjectForValidation {
  object_id: string;
  title: string | null;
}

/**
 * Runs pre-publish validation checks.
 *
 * Blockers prevent publishing; warnings are advisory.
 *
 * Blocker: headSha !== currentRepoHead (repo has diverged — re-sync required)
 * Warnings:
 *   - Objects missing a title
 *   - Steps that have an object but no position (x/y/zoom all null)
 *   - Fully empty steps are excluded from all checks
 */
export function runPrePublishValidation(params: {
  headSha: string;
  currentRepoHead: string;
  stories: StoryForValidation[];
  steps: StepForValidation[];
  objects: ObjectForValidation[];
}): ValidationResult {
  const blockers: ValidationResult["blockers"] = [];
  const warnings: ValidationResult["warnings"] = [];

  // Blocker: stale HEAD
  if (params.headSha !== params.currentRepoHead) {
    blockers.push({
      code: "stale_head",
      message: "stale_head",
    });
  }

  // Warning: objects without titles
  for (const obj of params.objects) {
    if (!obj.title || obj.title.trim() === "") {
      warnings.push({
        code: "object_no_title",
        message: "object_no_title",
        entityId: obj.object_id,
        params: { id: obj.object_id },
      });
    }
  }

  // Warning: steps with object but no position
  for (const step of params.steps) {
    // Skip fully empty steps
    const fullyEmpty =
      !step.object_id &&
      !step.question &&
      !step.answer;
    if (fullyEmpty) continue;

    // Only warn when step references an object but has no position
    if (step.object_id && step.x == null && step.y == null && step.zoom == null) {
      warnings.push({
        code: "step_no_position",
        message: "step_no_position",
        entityId: String(step.id),
        params: { number: String(step.step_number) },
      });
    }
  }

  return { blockers, warnings };
}

// ---------------------------------------------------------------------------
// Full publish file set assembly
// ---------------------------------------------------------------------------

export interface BuildPublishParams {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  projectId: number;
  env: Env;
}

/**
 * Assembles the full set of CommitFile objects for a publish commit.
 *
 * Reads all stories, steps, layers, objects, project_config, and project_landing
 * from D1 and generates:
 *   - _config.yml (managed fields updated, comments preserved)
 *   - telar-content/spreadsheets/project.csv
 *   - telar-content/spreadsheets/{story_id}.csv per non-draft story
 *   - telar-content/spreadsheets/objects.csv
 *   - telar-content/texts/stories/*.md layer files
 *   - index.md (managed frontmatter fields + welcome_body)
 */
export async function buildPublishFileSet(
  params: BuildPublishParams,
): Promise<CommitFile[]> {
  const { token, owner, repo, projectId, env } = params;
  const db = getDb(env.DB);

  // Fetch all required D1 data
  const [
    storyRows,
    configRow,
    landingRow,
    objectRows,
  ] = await Promise.all([
    db.select().from(stories).where(eq(stories.project_id, projectId)),
    db
      .select()
      .from(project_config)
      .where(eq(project_config.project_id, projectId))
      .limit(1),
    db
      .select()
      .from(project_landing)
      .where(eq(project_landing.project_id, projectId))
      .limit(1),
    db.select().from(objects).where(eq(objects.project_id, projectId)),
  ]);

  const config = configRow[0];
  const landing = landingRow[0];

  // Fetch repo files for comment/format preservation
  const [existingConfigYml, existingObjectsCsv, existingIndexMd] = await Promise.all([
    getFileContent(token, owner, repo, "_config.yml"),
    getFileContent(token, owner, repo, "telar-content/spreadsheets/objects.csv"),
    getFileContent(token, owner, repo, "index.md"),
  ]);

  const files: CommitFile[] = [];

  // --- _config.yml ---
  if (existingConfigYml && config) {
    const managedFields: Record<string, string> = {};
    if (config.title != null) managedFields["title"] = yamlQuote(config.title);
    if (config.url != null) managedFields["url"] = yamlQuote(config.url);
    if (config.baseurl != null) managedFields["baseurl"] = yamlQuote(config.baseurl);
    if (config.description != null) managedFields["description"] = yamlQuote(config.description);
    if (config.author != null) managedFields["author"] = yamlQuote(config.author);
    if (config.email != null) managedFields["email"] = yamlQuote(config.email);
    if (config.logo != null) managedFields["logo"] = yamlQuote(config.logo);
    if (config.story_key != null) managedFields["story_key"] = config.story_key;

    const updatedConfig = updateConfigFields(existingConfigYml, managedFields);
    files.push({ path: "_config.yml", content: updatedConfig });
  }

  // --- project.csv ---
  const projectCsvContent = serializeProjectCsv(
    storyRows.map((s) => ({
      story_id: s.story_id,
      title: s.title ?? null,
      subtitle: s.subtitle ?? null,
      byline: s.byline ?? null,
      order: s.order ?? 0,
      private: s.private ?? false,
      draft: s.draft ?? false,
    })),
  );
  files.push({
    path: "telar-content/spreadsheets/project.csv",
    content: projectCsvContent,
  });

  // --- objects.csv ---
  const objectsCsvContent = serializeObjectsCsv(
    objectRows.map(dbObjectToCsvRow),
    existingObjectsCsv ?? undefined,
  );
  files.push({
    path: "telar-content/spreadsheets/objects.csv",
    content: objectsCsvContent,
  });

  // --- Per-story CSVs and layer files ---
  const nonDraftStories = storyRows.filter((s) => !s.draft);

  for (const story of nonDraftStories) {
    // Fetch steps for this story
    const stepRows = await db
      .select()
      .from(steps)
      .where(eq(steps.story_id, story.id));

    // Fetch layers for all steps in this story
    const stepIds = stepRows.map((s) => s.id);
    let layerRows: (typeof layers.$inferSelect)[] = [];

    if (stepIds.length > 0) {
      // Fetch layers one step at a time to avoid IN clause complexity with D1
      for (const stepId of stepIds) {
        const stepLayers = await db
          .select()
          .from(layers)
          .where(eq(layers.step_id, stepId));
        layerRows.push(...stepLayers);
      }
    }

    // Build StepWithLayers
    const stepsWithLayers: StepWithLayers[] = stepRows.map((step) => ({
      step_number: step.step_number,
      object_id: step.object_id ?? null,
      x: step.x ?? null,
      y: step.y ?? null,
      zoom: step.zoom ?? null,
      page: step.page ?? null,
      question: step.question ?? null,
      answer: step.answer ?? null,
      alt_text: step.alt_text ?? null,
      clip_start: step.clip_start ?? null,
      clip_end: step.clip_end ?? null,
      loop: step.loop ?? null,
      layers: layerRows
        .filter((l) => l.step_id === step.id)
        .map((l) => ({
          layer_number: l.layer_number,
          title: l.title ?? null,
          button_label: l.button_label ?? null,
          content: l.content ?? null,
        })),
    }));

    const storySlug = story.story_id;

    // Story CSV
    const storyCsvContent = serializeStoryCsv(stepsWithLayers, storySlug);
    files.push({
      path: `telar-content/spreadsheets/${storySlug}.csv`,
      content: storyCsvContent,
    });

    // Layer markdown files
    const usedFilenames = new Set<string>();
    for (const step of stepsWithLayers) {
      for (const layer of step.layers) {
        if (!layer.content) continue;
        const filename = layerFilename(
          storySlug,
          step.step_number,
          layer.layer_number,
          layer.title,
          usedFilenames,
        );
        const fileContent = layerFileContent(layer.title, layer.content);
        files.push({
          path: `telar-content/texts/stories/${filename}`,
          content: fileContent,
        });
      }
    }
  }

  // --- index.md ---
  if (landing) {
    let indexContent: string;

    if (existingIndexMd) {
      // Parse existing frontmatter
      const match = existingIndexMd.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (match) {
        const frontmatterLines = match[1].split("\n");
        const managedFrontmatterKeys = new Set([
          "stories_heading",
          "stories_intro",
          "objects_heading",
          "objects_intro",
        ]);

        // Preserve non-managed frontmatter keys, replace managed ones
        const preservedLines = frontmatterLines.filter((l) => {
          const key = l.match(/^([^:]+):/)?.[1]?.trim();
          return !key || !managedFrontmatterKeys.has(key);
        });

        const managedLines: string[] = [];
        if (landing.stories_heading)
          managedLines.push(`stories_heading: ${yamlQuote(landing.stories_heading)}`);
        if (landing.stories_intro)
          managedLines.push(`stories_intro: ${yamlQuote(landing.stories_intro)}`);
        if (landing.objects_heading)
          managedLines.push(`objects_heading: ${yamlQuote(landing.objects_heading)}`);
        if (landing.objects_intro)
          managedLines.push(`objects_intro: ${yamlQuote(landing.objects_intro)}`);

        const allFrontmatterLines = [...preservedLines, ...managedLines].filter(
          (l) => l.trim() !== "",
        );

        const body = landing.welcome_body ?? match[2].trim();
        indexContent = `---\n${allFrontmatterLines.join("\n")}\n---\n\n${body}`;
      } else {
        // No frontmatter in existing file — build from scratch
        indexContent = buildIndexMd(landing);
      }
    } else {
      indexContent = buildIndexMd(landing);
    }

    files.push({ path: "index.md", content: indexContent });
  }

  // --- navigation.yml ---
  const configForNav = await db
    .select({ navigation_json: project_config.navigation_json })
    .from(project_config)
    .where(eq(project_config.project_id, projectId))
    .limit(1);
  const navJson = configForNav[0]?.navigation_json ?? null;
  if (navJson) {
    try {
      const navItems = JSON.parse(navJson) as NavItem[];
      if (navItems.length > 0) {
        files.push({ path: "_data/navigation.yml", content: buildNavigationYml(navItems) });
      }
    } catch {
      // Malformed navigation JSON — skip nav file generation
    }
  }

  // --- glossary.csv ---
  const glossaryRows = await db
    .select({ term_id: glossary_terms.term_id, title: glossary_terms.title, definition: glossary_terms.definition })
    .from(glossary_terms)
    .where(eq(glossary_terms.project_id, projectId));
  if (glossaryRows.length > 0) {
    files.push({
      path: "telar-content/spreadsheets/glossary.csv",
      content: serializeGlossaryCsv(glossaryRows),
    });
  }

  // --- page markdown files ---
  const pageRows = await db
    .select({ title: project_pages.title, slug: project_pages.slug, body: project_pages.body })
    .from(project_pages)
    .where(eq(project_pages.project_id, projectId));
  for (const page of pageRows) {
    files.push({
      path: `telar-content/texts/pages/${page.slug}.md`,
      content: serializePageMarkdown(page.title, page.body ?? ""),
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Navigation YAML serializer
// ---------------------------------------------------------------------------

interface NavItem {
  type: string;
  slug?: string;
  key?: string;
  url?: string;
  label: string;
  visible?: boolean;
}

/**
 * Serialises a navigation items array to a Telar-compatible navigation.yml string.
 *
 * Writes both `title_en` and `titulo_es` with the same label value for
 * monolingual sites. Hidden items (visible: false) are excluded.
 */
export function buildNavigationYml(navItems: NavItem[]): string {
  const visible = navItems.filter((i) => i.visible !== false);
  const lines = ["menu:"];
  for (const item of visible) {
    const label = yamlQuote(item.label ?? "");
    if (item.type === "page") {
      lines.push(`  - title_en: ${label}`);
      lines.push(`    titulo_es: ${label}`);
      lines.push(`    url: /${item.slug}/`);
    } else if (item.type === "builtin" && item.key === "glossary") {
      lines.push(`  - title_en: ${label}`);
      lines.push(`    titulo_es: ${label}`);
      lines.push(`    url: /glossary/`);
    } else if (item.type === "builtin" && item.key === "collection") {
      lines.push(`  - title_en: ${label}`);
      lines.push(`    titulo_es: ${label}`);
      lines.push(`    url: /objects/`);
    } else if (item.type === "external") {
      lines.push(`  - title_en: ${label}`);
      lines.push(`    url: ${yamlQuote(item.url ?? "")}`);
      lines.push(`    external: true`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Glossary CSV serializer
// ---------------------------------------------------------------------------

/**
 * Serialises glossary terms to a CSV string suitable for glossary.csv.
 *
 * Double-quotes within values are escaped by doubling them per RFC 4180.
 */
export function serializeGlossaryCsv(
  terms: Array<{ term_id: string; title: string | null; definition: string | null }>,
): string {
  const header = "term_id,title,definition";
  const rows = terms.map((t) => {
    const def = (t.definition ?? "").replace(/"/g, '""');
    const title = (t.title ?? "").replace(/"/g, '""');
    return `${t.term_id},"${title}","${def}"`;
  });
  return [header, ...rows].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Page markdown serializer
// ---------------------------------------------------------------------------

/**
 * Serialises a page title and body to a Telar-compatible markdown file string.
 *
 * Output format:
 * ---
 * title: Title
 * ---
 *
 * Body content
 */
/** Quote a value for safe YAML output — double-quote and escape inner quotes/newlines. */
function yamlQuote(val: string): string {
  return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function serializePageMarkdown(title: string, body: string): string {
  return `---\ntitle: ${yamlQuote(title)}\n---\n\n${body}\n`;
}

function buildIndexMd(
  landing: {
    stories_heading: string | null;
    stories_intro: string | null;
    objects_heading: string | null;
    objects_intro: string | null;
    welcome_body: string | null;
  },
): string {
  const lines: string[] = [];
  if (landing.stories_heading) lines.push(`stories_heading: ${yamlQuote(landing.stories_heading)}`);
  if (landing.stories_intro) lines.push(`stories_intro: ${yamlQuote(landing.stories_intro)}`);
  if (landing.objects_heading) lines.push(`objects_heading: ${yamlQuote(landing.objects_heading)}`);
  if (landing.objects_intro) lines.push(`objects_intro: ${yamlQuote(landing.objects_intro)}`);

  const frontmatter = lines.length > 0 ? `---\n${lines.join("\n")}\n---\n\n` : "";
  return `${frontmatter}${landing.welcome_body ?? ""}`;
}

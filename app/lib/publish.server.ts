/**
 * This file is the server-side library powering the Publish wizard —
 * CSV serialisation, layer markdown assembly, line-based `_config.yml`
 * mutation, change-summary computation, validation, and full publish
 * file-set assembly.
 *
 * Provides:
 *   - CSV serialisation (`project.csv` and per-story CSVs) in Telar's
 *     bilingual format
 *   - Layer markdown file helpers (filename derivation and file content
 *     assembly)
 *   - Line-based `_config.yml` mutation preserving comments and
 *     formatting
 *   - Change-summary computation against a stored publish snapshot
 *   - Pre-publish validation (stale HEAD, missing titles, missing
 *     positions)
 *   - Full publish file-set assembly (`buildPublishFileSet`)
 *
 * Called by the Publish route — no UI logic lives here.
 *
 * @version v1.4.2-beta
 */

import Papa from "papaparse";
import { canonicalExtraColumns } from "~/lib/extra-columns.server";
import { eq, max } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import { getFileContent } from "~/lib/github.server";
import { parseYaml } from "~/lib/yaml.server";
import { slugify } from "~/lib/slugify";
import { extractCommentRows, serializeObjectsCsv } from "~/lib/csv-export.server";
import type { CommitFile } from "~/lib/commit.server";
import { sanitiseInlineHtml } from "~/lib/sanitise-html";
import { mutateYamlBlock, findYamlBlockRegions } from "~/lib/config-yaml-block.server";
import {
  V121_BODIES,
  V121_FRONTMATTER_DEFAULTS,
  normalizeBody,
} from "~/lib/v130-ingest.server";
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

/**
 * Hash format version. Bumped whenever any bucket's hash inputs change.
 * computeChangeSummary treats a snapshot whose stored `entity_hashes.version`
 * differs from this constant the same as a snapshot without `entity_hashes`
 * at all — fires the back-compat bootstrap path so the modal banner
 * explains the noise and the commit message suppresses the modify_X
 * flood.
 *
 * Version history:
 *   1 — initial entity-hashing rewrite (002fb3f0). Object hash included
 *       `order`; page hash included `order`. Both proved to be
 *       false-positive triggers — objects.csv doesn't encode object
 *       order, and page reorder is captured by entity_hashes.navigation,
 *       not the page file.
 *   2 — drop `order` from object and page hashes. Stories keep `order`
 *       because serializeProjectCsv DOES sort by it and write the column.
 *   3 — add `dimensions` and `extra_columns` to the object hash. Both are
 *       D1 fields serializeObjectsCsv now reads (the custom-column
 *       passthrough blob included); without them, edits to either would
 *       not be detected as a change and publish would skip re-emitting
 *       the row. extra_columns is canonicalised (keys sorted) before
 *       hashing so equivalent data hashes identically regardless of
 *       stored key order.
 *   4 — add glossary `related_terms` to the glossary hash. It's a D1 field
 *       serializeGlossaryCsv now reads and writes; without it, edits to a
 *       term's related terms would not be detected as a change and publish
 *       would skip re-emitting the row.
 */
export const ENTITY_HASHES_VERSION = 4;

/**
 * Per-entity content hashes keyed by entity ID. The diff in
 * `computeChangeSummary` reads these to classify every entity bucket
 * uniformly:
 *
 *   - new      = current items not present in snapshot
 *   - modified = items in both where the hash differs
 *   - deleted  = snapshot items not present in current
 *
 * Hashing is D1-only — no GitHub I/O — and the inputs cover every field
 * the existing serialisers in `buildPublishFileSet` write to the published
 * file or its frontmatter. That makes hash equality on D1 source data
 * equivalent to byte equality on the published file for change-detection
 * purposes, while avoiding the GitHub fetches the file-content path would
 * require.
 *
 * Both the change-summary modal and the auto-generated commit message read
 * from the same `ChangeSummary` produced by these hashes, so the two can
 * never disagree (the architectural lesson from the page-hashing patch
 * cluster: cf04e12, ffa2844, 19d6ed0 — modal-vs-message asymmetry was the
 * root cause).
 *
 * Back-compat: snapshots written before entity-hashing landed have no
 * `entity_hashes` field. `computeChangeSummary` detects this and marks
 * every current entity as modified for that one publish — one wave of
 * noise then accurate forever (same trade-off as the page-hash back-compat
 * fallback in commit 19d6ed0; under-reporting hides real edits, which is
 * the worse failure mode).
 */
export interface EntityHashes {
  /**
   * Hash format version. See ENTITY_HASHES_VERSION above for semantics.
   * A stored snapshot whose `version` differs from the current constant
   * is treated as back-compat (banner + suppressed-flood commit), giving
   * us a path to evolve hash inputs without silently re-flooding the
   * change-review modal.
   *
   * Persisted snapshots from before this field existed have no `version`;
   * `computeChangeSummary` defaults missing values to 1 at the runtime
   * boundary so old snapshots round-trip cleanly.
   */
  version: number;
  /** keyed by trimmed slug (matches pageRowsToCommitFiles + buildPageContentHashes) */
  pages: Record<string, string>;
  /**
   * EntityHashes.stories: hashes only non-draft stories (drafts excluded from
   * the hash-summary, so they don't appear in the auto-generated commit
   * message). Drafts DO produce files (telar-content/spreadsheets/{id}.csv)
   * per the orphans-are-drafts round-trip rule — but are
   * excluded from the project.csv-driven hash-summary that names entities
   * in commit messages.
   */
  stories: Record<string, string>;
  /** keyed by object_id */
  objects: Record<string, string>;
  /** keyed by term_id */
  glossary: Record<string, string>;
  /** structural hash of navigation_json (parsed); empty string if absent or unparseable */
  navigation: string;
  /** hash of project_landing fields; empty string if no landing row */
  landing: string;
  /** hash of buildConfigManagedFields(config); empty string if no config row */
  settings: string;
}

export interface PublishSnapshot {
  /** Non-draft story_ids published in the last commit */
  story_ids: string[];
  /**
   * All story_ids that had a {story_id}.csv file written in the last commit
   * (draft + non-draft): per-story files are now written for
   * all stories regardless of draft flag, so accurate hard-delete tracking
   * requires knowing the full set of files that existed on GitHub
   * after the prior publish — not just the project.csv-tracked subset.
   *
   * Optional for back-compat: older snapshots don't have
   * this field. `computeStoryDeletions` falls back to `story_ids` when this
   * is absent — accepting the one-edge-case gap where a story that was
   * already-draft before this rule shipped gets hard-deleted on the first
   * publish after upgrade (its file is not in the snapshot and never gets
   * deleted). That gap is closed after one publish, because the next
   * publish writes the full `all_story_ids` set.
   */
  all_story_ids?: string[];
  /** All object_ids at the time of the last publish */
  object_ids: string[];
  /**
   * Slugs of every page committed at the last publish (i.e. with a non-empty
   * trimmed slug — empty-slug pages never land in the commit per
   * pageRowsToCommitFiles). Optional for back-compat with snapshots written
   * before page tracking landed; when absent, the diff treats the snapshot
   * side as empty so all current pages appear as new on the next publish.
   */
  page_slugs?: string[];
  /**
   * Per-page content hash keyed by slug. Superseded by `entity_hashes.pages`
   * for new snapshots; kept for back-compat reads of snapshots written
   * between the page-hashing patch (commit ffa2844 / 19d6ed0) and the
   * entity-hashing rewrite. Dual-written by the publish action during the
   * transition.
   */
  page_hashes?: Record<string, string>;
  /** JSON.stringify of managed project_config fields (kept as an isUpToDate fast-path) */
  config_hash: string;
  /**
   * Per-field map of managed project_config values at the last publish.
   * Drives per-field diff in computeChangeSummary. Optional
   * for back-compat with older snapshots; when
   * absent, the diff treats the snapshot side as empty so all currently-set
   * fields appear as changes on the next publish.
   */
  config_managed?: Record<string, string>;
  /** JSON.stringify of project_landing fields */
  landing_hash: string;
  /**
   * Hash of `project_config.navigation_json` at the last publish. Optional
   * for back-compat with snapshots written before navigation tracking
   * landed; when absent, the diff treats the snapshot side as empty so any
   * current navigation appears as a change on the next publish. The
   * navigation file is always re-derived from `navigation_json` and pushed
   * to GitHub, so byte-equality of the JSON is a sufficient signal.
   */
  navigation_hash?: string;
  /**
   * Per-entity content hashes for every entity bucket — pages, stories,
   * objects, glossary, plus single-string navigation/landing/settings
   * hashes. The single source of truth for both the change-summary modal
   * and the auto-generated commit message (a snapshot's `ChangeSummary`
   * is computed entirely from the diff between this and the current
   * D1-derived hashes via `buildEntityHashes`).
   *
   * Optional for back-compat with snapshots written before entity-hashing
   * landed: when absent, every current entity is marked as modified for
   * that one publish (one wave of noise then accurate forever — same
   * trade-off as the page-hash back-compat fallback in commit 19d6ed0).
   */
  entity_hashes?: EntityHashes;
}

export interface ChangeSummary {
  isUpToDate: boolean;
  /**
   * True iff the snapshot existed but lacked `entity_hashes` (a one-shot
   * transition signal: snapshots written before the entity-hashing rewrite
   * landed). Drives:
   *   - Banner in the Review modal explaining the back-compat flood
   *   - Suppression of `modify_X` parts in the auto-generated commit
   *     message (those are noise + signal mixed; we can't separate them
   *     in back-compat mode so we omit them rather than mislead)
   * False for first-publish (snapshot===null) and for normal operation
   * (snapshot has entity_hashes).
   */
  backCompatBootstrap: boolean;
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
  pages: {
    new: { slug: string; title: string | null }[];
    modified: { slug: string; title: string | null }[];
    deleted: { slug: string; title: string | null }[];
  };
  glossary: {
    new: { term_id: string; title: string | null }[];
    modified: { term_id: string; title: string | null }[];
    deleted: { term_id: string; title: string | null }[];
  };
  settings: { changed: { key: string; label: string; value?: string }[] };
  landing: { changed: boolean };
  navigation: { changed: boolean };
  /**
   * File-system view of pending changes, separate from the
   * publishable view above. The `stories.{new,modified,deleted}` lists drive
   * the commit-message body (drafts EXCLUDED — they're private and must not
   * appear in the public commit log). This `fileChanges` section drives the
   * UI's "is there anything to publish?" gate and the Review modal's "Files
   * going to GitHub" panel, and INCLUDES drafts because per-story files now
   * write a `{story_id}.csv` for every D1 story regardless of draft flag.
   *
   * Computed against `snapshot.all_story_ids` (preferred) or `snapshot.story_ids`
   * (back-compat fallback for older snapshots — closes after one publish,
   * same gap as `computeStoryDeletions`).
   */
  fileChanges: {
    /** story_ids whose {story_id}.csv will be created this publish */
    addedStoryFiles: string[];
    /** story_ids whose {story_id}.csv will be deleted this publish */
    removedStoryFiles: string[];
  };
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
  /**
   * Per-entity content hashes for every bucket. Built once by
   * `buildEntityHashes(db, projectId)` and consumed by `computeChangeSummary`
   * to classify new/modified/deleted uniformly across every entity type.
   * Identical to what gets persisted in `PublishSnapshot.entity_hashes` on
   * the next successful publish.
   */
  entityHashes: EntityHashes;
  /**
   * Current `project_config` row, used to build the per-field managed-fields
   * map for the settings diff. Null when no config row exists yet (rare —
   * a config row is created when a project is initialised). Settings keep
   * a separate per-field detector even after the entity-hashing rewrite
   * because the commit-message helper needs per-field labels (e.g. `lang`
   * with the post-change value attached) that a single hash cannot carry.
   */
  config: typeof project_config.$inferSelect | null;
  stories: { story_id: string; title: string | null }[];
  objects: { object_id: string; title: string | null }[];
  pages: { slug: string; title: string | null }[];
  glossary: { term_id: string; title: string | null }[];
  /**
   * All D1 story_ids regardless of draft flag. Drives the
   * `fileChanges` section of `ChangeSummary` so the UI gate ("Everything is
   * up to date" / NEXT-disabled) and the Review modal's "Files going to
   * GitHub" panel are aware that drafts contribute `{story_id}.csv` writes
   * and deletions even though they never appear in `stories`/`project.csv`.
   *
   * `stories` above stays non-drafts-only (drives commit-message naming).
   */
  allStoryIds: string[];
}

// ---------------------------------------------------------------------------
// Project CSV serialiser
// ---------------------------------------------------------------------------

export const PROJECT_CSV_COLUMNS = [
  "order",
  "story_id",
  "title",
  "subtitle",
  "byline",
  "private",
  "show_sections",
] as const;

export const PROJECT_BILINGUAL_ROW: Record<string, string> = {
  order: "orden",
  story_id: "id_historia",
  title: "titulo",
  subtitle: "subtitulo",
  byline: "firma",
  private: "privada",
  show_sections: "mostrar_secciones",
};

interface StoryRow {
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  order: number;
  private: boolean;
  draft: boolean;
  show_sections: boolean;
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
    // show_sections — same boolean -> "yes" | "" convention as private
    show_sections: s.show_sections ? "yes" : "",
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

export const STORY_CSV_COLUMNS = [
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

export const STORY_BILINGUAL_ROW: Record<string, string> = {
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
  /**
   * Distinguishes a section-card step (chapter heading) from a regular
   * media step. The framework signal in stories.csv is empty `object` column;
   * the writer enforces that signal defensively for kind='section'.
   */
  kind: "media" | "section";
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
  // A section step is a heading card that is meaningful on its own (its title
  // lives outside object/question/answer/layer content), so it must never be
  // dropped — even when titled-but-otherwise-empty.
  if (step.kind === "section") return false;
  if (step.object_id) return false;
  if (step.question) return false;
  if (step.answer) return false;
  if (step.layers.some((l) => l.content)) return false;
  return true;
}

/**
 * A layer markdown file referenced by a story CSV. The `filename` here is the
 * SAME value written into the CSV's `layerN_content` cell, so the file the
 * publish loop writes can never disagree with the CSV's reference.
 */
export interface StoryLayerFile {
  /** Bare filename (no path) — matches the CSV `layerN_content` cell exactly. */
  filename: string;
  /** Layer title (drives frontmatter via layerFileContent). */
  title: string | null;
  /** Layer body content (non-empty — empty layers are not emitted). */
  content: string;
}

/**
 * Result of serialising a story: the CSV string plus the exact list of layer
 * markdown files it references. Both are produced in a SINGLE pass over the
 * sorted, empty-filtered steps using ONE `usedFilenames` Set, so filename
 * assignment happens exactly once and the CSV and the on-disk files cannot
 * diverge (e.g. when two layers share a title after a step reorder).
 */
export interface SerializedStory {
  csv: string;
  layerFiles: StoryLayerFile[];
}

/**
 * Serialises D1 step rows (with layers) into a Telar story CSV AND the layer
 * markdown files that CSV references — in one pass, with one filename-collision
 * Set. This is the single source of truth for layer filename assignment.
 *
 * @param stepRows The steps to serialise, each containing their layers
 * @param storySlug The slug of the story — used as prefix for layer filenames
 * @param existingCsv Optional existing CSV content for comment preservation
 */
export function serializeStory(
  stepRows: StepWithLayers[],
  storySlug: string,
  existingCsv?: string,
): SerializedStory {
  const columns = STORY_CSV_COLUMNS as unknown as string[];

  const headerCsv = normalise(Papa.unparse([{}], { columns })).split("\n")[0];

  // Bilingual row — Spanish column name equivalents required by Telar's CSV parser
  const bilingualRow = normalise(
    Papa.unparse([columns.map((col) => STORY_BILINGUAL_ROW[col] ?? col)], { header: false }),
  );

  const commentRows = existingCsv ? extractCommentRows(existingCsv) : [];

  // Track used filenames per story to detect duplicates
  const usedFilenames = new Set<string>();

  // Layer files referenced by the CSV, collected in the SAME pass / SAME order
  // / SAME usedFilenames Set as the CSV cells below — guarantees the file the
  // publish loop writes matches the CSV's `layerN_content` reference.
  const layerFiles: StoryLayerFile[] = [];

  // Sort by step_number ascending so editor reorder survives publish.
  // Mirrors serializeProjectCsv's `.sort((a, b) => a.order - b.order)` pattern.
  // Spread to avoid mutating the caller's array (relevant for tests and future non-D1 callers).
  const sortedSteps = [...stepRows].sort((a, b) => a.step_number - b.step_number);
  const nonEmptySteps = sortedSteps.filter((s) => !isFullyEmptyStep(s));

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

    // Emit the layer file alongside the cell that references it, using the
    // filename just resolved. layer1HasContent guarantees layer1.content is a
    // non-empty string here, so the non-null assertion is safe.
    if (layer1HasContent) {
      layerFiles.push({
        filename: layer1Filename,
        title: layer1!.title,
        content: layer1!.content!,
      });
    }
    if (layer2HasContent) {
      layerFiles.push({
        filename: layer2Filename,
        title: layer2!.title,
        content: layer2!.content!,
      });
    }

    // A step only has a positionable IIIF viewer when it's a media step with
    // an object. Section steps (heading cards) and object-less steps have no
    // viewer, so they must emit EMPTY coordinate cells rather than the
    // 0.5/0.5/1 defaults — otherwise phantom coords round-trip wrong and churn
    // the entity hash.
    const hasViewer = step.kind !== "section" && !!step.object_id;

    return {
      step: String(step.step_number),
      // Defensive empty-object write for kind='section' steps — guarantees the
      // framework's section-card signal even if internal kind/object_id state
      // has drifted.
      object: step.kind === "section" ? "" : (step.object_id ?? ""),
      x: hasViewer ? String(step.x ?? 0.5) : "",
      y: hasViewer ? String(step.y ?? 0.5) : "",
      zoom: hasViewer ? String(step.zoom ?? 1) : "",
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

  const csv = [headerCsv, bilingualRow, ...commentRows, dataCsv].join("\n");

  return { csv, layerFiles };
}

/**
 * Serialises D1 step rows (with layers) to a Telar story CSV.
 *
 * Thin wrapper over {@link serializeStory} for callers that only need the CSV
 * string (e.g. unit tests pinning CSV output). The publish path uses
 * `serializeStory` directly so the layer files it writes are guaranteed to
 * match the filenames recorded in this CSV.
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
  return serializeStory(stepRows, storySlug, existingCsv).csv;
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
  // Route the title through yamlQuote so a title containing a double
  // quote or newline can't break the YAML frontmatter (mirrors
  // serializePageMarkdown). yamlQuote is a hoisted function declaration so the
  // forward reference here is safe.
  return `---\ntitle: ${yamlQuote(title)}\n---\n\n${content}`;
}

// ---------------------------------------------------------------------------
// Config mutation
// ---------------------------------------------------------------------------

/**
 * Known top-level keys of the canonical Telar template `_config.yml`
 * (ucsb-amplab/telar — verified stable across framework versions). Used as the
 * sweep boundary so a description paragraph that happens to start with a
 * lowercase `word:` (e.g. "usage: …") is treated as prose and swept, while a
 * real key (`url:`, `plugins:`) stops the sweep. Far more robust than matching
 * any `key:`-shaped line.
 */
export const KNOWN_CONFIG_KEYS = new Set([
  "title",
  "description",
  "url",
  "baseurl",
  "author",
  "email",
  "logo",
  "telar_theme",
  "telar_language",
  "collection_mode",
  "story_key",
  "story_interface",
  "collection_interface",
  "protected",
  "telar",
  "google_sheets",
  "collections",
  "collections_dir",
  "markdown",
  "permalink",
  "exclude",
  "defaults",
  "future",
  "show_drafts",
  "plugins",
  "webrick",
  "development-features",
]);

/**
 * A "structural" line ends a swept continuation region: a known top-level
 * config key, a comment, or a document separator. Bare prose (including
 * sentences that contain or start with a colon) and blank lines are NOT
 * structural and get swept.
 */
function isStructuralConfigLine(line: string): boolean {
  if (/^\s*#/.test(line) || /^---\s*$/.test(line)) return true;
  const m = line.match(/^([a-z][a-z0-9_-]*):(\s|$)/);
  return m ? KNOWN_CONFIG_KEYS.has(m[1]) : false;
}

/**
 * True when a matched `key: value` line opens a double-quoted scalar it does
 * not close on the same physical line (odd count of unescaped quotes in the
 * value). Such a line is the head of a multi-line scalar — its continuation
 * lines must be swept when the field is replaced, otherwise old continuation
 * (or duplicate-paragraph corruption) is orphaned outside the new closing quote.
 */
function opensUnterminatedQuotedScalar(line: string): boolean {
  const m = line.match(/^[A-Za-z0-9_-]+:\s*(.*)$/);
  if (!m) return false;
  const value = m[1];
  if (!value.startsWith('"')) return false;
  let quotes = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"' && (i === 0 || value[i - 1] !== "\\")) quotes++;
  }
  return quotes % 2 === 1;
}

/**
 * Updates managed fields in a _config.yml string using line-based regex mutation.
 *
 * Preserves all comments, indentation, quotes, and unmanaged fields.
 * Appends fields that are not found.
 *
 * The `story_key` field is special: it lives under the `protected:` block as
 * `  key: {value}`. When updating story_key, we scan for `^  key:` inside
 * the `^protected:` block.
 *
 * Additionally performs a silent heal of `telar.version` lines that carry a
 * leading `v` prefix. Legacy v1.2.0 repos store the version as
 * `v1.2.0`; the canonical form (matching D1's import-side strip) is unprefixed.
 * Idempotent — once healed, subsequent publishes are a no-op for the line.
 *
 * Self-heals multi-line scalar corruption: replacing a field whose existing
 * value opens an unterminated quote sweeps the orphaned continuation lines,
 * repairing _config.yml files broken by the pre-fix bare-newline serializer.
 */
export function updateConfigFields(yaml: string, fields: Record<string, string>): string {
  // Heal the legacy v-prefix on telar.version up front, via the shared config
  // block walker. This is the one part of this function whose block tracking is
  // cleanly separable: the heal touches only indented `version:` lines inside
  // the `telar:` block, it never interacts with the top-level field sweep below
  // (both `telar` and `protected` are structural keys that terminate a sweep, so
  // the sweep can never reach inside either block), and telar.version is not a
  // managed field, so nothing in the field/append logic reads or writes it.
  // Delegating it to mutateYamlBlock retires this file's private copy of the
  // telar block enter/exit idiom. The heal is idempotent — it only rewrites a
  // line that still carries the `v` prefix, so a once-healed repo is a no-op.
  // The `protected:` story_key handling below stays local: its single-pass
  // ordering against a top-level `story_key:` line is load-bearing (a top-level
  // key seen first suppresses the protected write), which independent block
  // passes cannot reproduce.
  yaml = mutateYamlBlock(yaml, "telar", (line) => {
    if (/^\s+version:\s*['"]?v/.test(line)) {
      return line.replace(/(version:\s*['"]?)v/, "$1");
    }
    return null;
  });

  const lines = yaml.split("\n");
  const result: string[] = [];
  const fieldsToAppend = new Set(Object.keys(fields));

  let inProtected = false;
  const storyKeyValue = fields["story_key"];
  let storyKeyUpdated = false;
  // Self-heal: when set, drop orphaned continuation lines of a multi-line
  // scalar we just replaced, until the next structural line. Repairs
  // _config.yml files corrupted by the pre-fix bare-newline serializer.
  let sweepingContinuation = false;

  for (const line of lines) {
    // Sweep orphaned continuation lines of a just-replaced multi-line scalar.
    // Stop (and fall through to normal processing) at the next structural line.
    if (sweepingContinuation) {
      if (isStructuralConfigLine(line)) {
        sweepingContinuation = false;
      } else {
        continue;
      }
    }

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

    // Handle top-level story_key (legacy fallback when no protected: block exists,
    // and self-healing cleanup of duplicate top-level lines from the pre-fix bug
    // where every publish appended a new story_key: line because the loop below
    // skipped story_key, leaving the append path to fire unconditionally).
    if (storyKeyValue !== undefined && /^story_key:/.test(line)) {
      if (!storyKeyUpdated) {
        result.push(`story_key: ${storyKeyValue}`);
        fieldsToAppend.delete("story_key");
        storyKeyUpdated = true;
      }
      // else: drop duplicate (don't push)
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
        // If the old line opened a multi-line scalar, sweep its now-orphaned
        // continuation lines (including duplicate-paragraph corruption).
        if (opensUnterminatedQuotedScalar(line)) sweepingContinuation = true;
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

/**
 * Writes managed NESTED block fields (story_interface, collection_interface)
 * into a _config.yml string via line-based surgical mutation — the block-level
 * analogue of updateConfigFields. Values are written verbatim (the caller emits
 * unquoted bool/int via buildConfigManagedBlocks); comments, indentation, and
 * unmanaged keys are preserved.
 *
 * Per block: replace each managed key's value in place (preserving the line's
 * indent + trailing comment); insert managed keys not present at the end of the
 * block's child region; append the whole block at EOF if absent. Block
 * boundaries and child indent come from the shared `findYamlBlockRegions`
 * primitive (config-yaml-block.server.ts). Hardening: flow-style blocks
 * (`key: {...}`) are refused (left untouched — line-based editing would
 * corrupt them; the publish parse-gate keeps the build valid and the toggle
 * simply doesn't apply); duplicate top-level block keys operate on the LAST
 * occurrence (js-yaml + the framework read the last); line endings are
 * normalised to the file's dominant EOL to avoid mixed \r\n / \n.
 */
export function updateConfigBlocks(
  yaml: string,
  blocks: Record<string, Record<string, string>>,
): string {
  if (Object.keys(blocks).length === 0) return yaml;
  const eol = yaml.includes("\r\n") ? "\r\n" : "\n";
  let lines = yaml.split(/\r?\n/);

  for (const [blockKey, fields] of Object.entries(blocks)) {
    if (Object.keys(fields).length === 0) continue;

    const regions = findYamlBlockRegions(lines, blockKey);

    if (regions.length === 0) {
      let end = lines.length;
      while (end > 0 && lines[end - 1].trim() === "") end--;
      const appended = [`${blockKey}:`, ...Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`)];
      lines = [...lines.slice(0, end), ...appended, ...lines.slice(end)];
      continue;
    }

    // LAST occurrence: js-yaml and the framework both read the last block.
    const { headerIdx, regionEnd, childIndent } = regions[regions.length - 1];
    const afterColon = lines[headerIdx].slice(blockKey.length + 1).trim();
    if (afterColon !== "" && !afterColon.startsWith("#")) continue; // flow/inline → refuse

    const written = new Set<string>();
    for (let i = headerIdx + 1; i < regionEnd; i++) {
      if (/^\s*#/.test(lines[i])) continue;
      const m = lines[i].match(/^(\s+)([A-Za-z0-9_-]+):\s*([^#]*?)(\s*#.*)?$/);
      if (!m) continue;
      const [, indent, key, , comment] = m;
      if (fields[key] !== undefined && !written.has(key)) {
        lines[i] = `${indent}${key}: ${fields[key]}${comment ?? ""}`;
        written.add(key);
      }
    }

    const toInsert = Object.entries(fields)
      .filter(([k]) => !written.has(k))
      .map(([k, v]) => `${childIndent}${k}: ${v}`);
    if (toInsert.length > 0) {
      let insertAt = regionEnd;
      while (insertAt > headerIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
      lines = [...lines.slice(0, insertAt), ...toInsert, ...lines.slice(insertAt)];
    }
  }

  return lines.join(eol);
}

/**
 * Managed free-text string fields — the only source of _config.yml scalar
 * corruption. Kept in sync with the string fields in buildConfigManagedFields.
 */
export const MANAGED_STRING_FIELD_KEYS = new Set([
  "title",
  "url",
  "baseurl",
  "description",
  "author",
  "email",
  "logo",
]);

/** True when `s` parses as YAML. The hygiene gate's validity check. */
function isParseableYaml(s: string): boolean {
  try {
    parseYaml(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Last-resort rescue for a _config.yml that the surgical heal could not make
 * valid (an exotic corruption shape). Strips every managed string-field line
 * and its orphaned multi-line continuation, leaving all framework keys and
 * comments intact, then re-applies the managed fields cleanly from D1. The
 * managed values come from buildConfigManagedFields (single-line, escaped), so
 * the reapplied lines are always valid; only unrecoverable scalar garbage is
 * dropped. Field order may change for rescued files — cosmetic, and only for
 * files that were already broken.
 */
function stripManagedStringScalars(yaml: string): string {
  const lines = yaml.split("\n");
  const kept: string[] = [];
  let sweeping = false;
  for (const line of lines) {
    if (sweeping) {
      if (isStructuralConfigLine(line)) {
        sweeping = false;
      } else {
        continue;
      }
    }
    const keyMatch = line.match(/^([a-z][a-z0-9_-]*):/);
    if (keyMatch && MANAGED_STRING_FIELD_KEYS.has(keyMatch[1])) {
      // Drop this managed string line; sweep its continuation if it opened a
      // multi-line scalar (the corruption shape).
      if (opensUnterminatedQuotedScalar(line)) sweeping = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Produces a guaranteed-valid _config.yml for the publish commit.
 *
 * Applies two kinds of update: top-level managed fields (`fields`, via
 * `updateConfigFields`) and nested managed-block children (`blocks`, via
 * `updateConfigBlocks` — e.g. `story_interface.include_demo_content`). Both are
 * written surgically, preserving comments, field order, and unmanaged framework
 * keys/toggles. `blocks` defaults to `{}`, so existing two-argument callers are
 * unaffected.
 *
 * It threads them through a four-tier fallback so no publish can ever commit a
 * _config.yml that breaks the Jekyll build:
 *
 * 1. Surgical fields + nested blocks. If it parses, ship it.
 * 2. Rescue — strip corrupt managed string scalars (an exotic pre-existing
 *    corruption the line-based heal can't fully repair), then re-apply both
 *    passes. Settings-safe: preserves every unmanaged key, re-emitting only
 *    managed fields, which already reflect the user's intent from D1.
 * 3. Guaranteed-valid fallback — drop the block write rather than corrupt
 *    (e.g. a flow-style block `story_interface: {}` the line heal can't extend),
 *    keeping the rescued top-level field update.
 * 4. Original behaviour — plain field update; the call site parse-gates this too.
 *
 * This is the single entry point the publish path uses.
 */
export function healConfigYaml(
  existingYaml: string,
  fields: Record<string, string>,
  blocks: Record<string, Record<string, string>> = {},
): string {
  // Tier 1: surgical top-level + nested-block update.
  const withBlocks = updateConfigBlocks(updateConfigFields(existingYaml, fields), blocks);
  if (isParseableYaml(withBlocks)) return withBlocks;
  // Tier 2: rescue corrupt managed string scalars, then re-apply both passes.
  const rescuedFields = updateConfigFields(stripManagedStringScalars(existingYaml), fields);
  const rescued = updateConfigBlocks(rescuedFields, blocks);
  if (isParseableYaml(rescued)) return rescued;
  // Tier 3: same rescued fields, drop the block write rather than corrupt.
  if (isParseableYaml(rescuedFields)) return rescuedFields;
  // Tier 4: original behaviour (the call site parse-gates this too).
  return updateConfigFields(existingYaml, fields);
}

// ---------------------------------------------------------------------------
// Change summary
// ---------------------------------------------------------------------------

/**
 * Generic per-entity diff. The same logic powers stories, objects, pages,
 * and glossary — the only differences are the identity field (`story_id`
 * vs `slug` etc.) and the shape of the deleted-item placeholder.
 *
 * Standard mode (snapshot has entity_hashes for this bucket):
 *   new      = current items whose id is not in `snapshotHashes`
 *   modified = items in both where the hash differs
 *   deleted  = ids in `snapshotHashes` not present in current (built into
 *              placeholder items via `toDeleted`)
 *
 * Back-compat mode (`backCompat: true` — snapshot has no `entity_hashes`):
 *   new      = current items not in `legacyIds` (the snapshot's pre-hashing
 *              record of what existed: story_ids, object_ids, page_slugs;
 *              empty for glossary, which was never tracked legacy-style)
 *   modified = current items whose id IS in `legacyIds` — every existing
 *              entity flagged for one publish so real edits aren't hidden;
 *              accurate from the next publish onward once entity_hashes
 *              is populated. Same trade-off as the page-hash back-compat
 *              fallback (commit 19d6ed0).
 *   deleted  = ids in `legacyIds` not present in current
 */
function diffEntities<T>(opts: {
  current: T[];
  idOf: (item: T) => string;
  toDeleted: (id: string) => T;
  currentHashes: Record<string, string>;
  snapshotHashes: Record<string, string>;
  legacyIds: string[];
  backCompat: boolean;
}): { new: T[]; modified: T[]; deleted: T[] } {
  const { current, idOf, toDeleted, currentHashes, snapshotHashes, legacyIds, backCompat } = opts;

  if (backCompat) {
    const legacy = new Set(legacyIds);
    return {
      new: current.filter((item) => !legacy.has(idOf(item))),
      modified: current.filter((item) => legacy.has(idOf(item))),
      deleted: legacyIds
        .filter((id) => !current.some((item) => idOf(item) === id))
        .map(toDeleted),
    };
  }

  const snapshotIds = new Set(Object.keys(snapshotHashes));
  return {
    new: current.filter((item) => !snapshotIds.has(idOf(item))),
    modified: current.filter((item) => {
      const id = idOf(item);
      return snapshotIds.has(id) && currentHashes[id] !== snapshotHashes[id];
    }),
    deleted: Array.from(snapshotIds)
      .filter((id) => !current.some((item) => idOf(item) === id))
      .map(toDeleted),
  };
}

/**
 * Computes the change summary between current D1 state and the last
 * publish snapshot. Single source of truth for both the change-summary
 * modal and the auto-generated commit message — both consumers read every
 * field of the returned `ChangeSummary` so they can never disagree (the
 * architectural lesson from the page-hashing patch cluster: cf04e12,
 * ffa2844, 19d6ed0).
 *
 * Three modes:
 *   1. snapshot === null (first publish): everything is new.
 *   2. snapshot exists with `entity_hashes`: standard hash diff per bucket.
 *   3. snapshot exists without `entity_hashes` (back-compat for snapshots
 *      written before entity-hashing landed): mark all current entities
 *      as modified for that one publish, then accurate forever.
 *
 * Settings keep their own per-field detector against `snapshot.config_managed`
 * because the commit-message helper needs per-field labels — for example
 * the `lang` entry carries the post-change value as its label so the
 * helper can pick `change_language_to_es` vs `change_language_to_en`
 * without re-reading the config row. The `entity_hashes.settings` hash
 * exists for completeness but is not consumed here.
 */
export function computeChangeSummary(
  currentState: CurrentPublishState,
  snapshot: PublishSnapshot | null,
): ChangeSummary {
  if (snapshot === null) {
    // First publish: every D1 file will be created. Drafts are absent from
    // `stories` (publishable view) so list them explicitly in
    // `fileChanges.addedStoryFiles`, dedup'd against the non-drafts that
    // `stories.new` already names.
    const namedNewIds = new Set(currentState.stories.map((s) => s.story_id));
    return {
      isUpToDate: false,
      backCompatBootstrap: false,
      stories: { new: currentState.stories, modified: [], deleted: [] },
      objects: { new: currentState.objects, modified: [], deleted: [] },
      pages: { new: currentState.pages, modified: [], deleted: [] },
      glossary: { new: currentState.glossary, modified: [], deleted: [] },
      settings: { changed: [{ key: "all", label: "All settings (first publish)" }] },
      landing: { changed: currentState.entityHashes.landing.length > 0 },
      navigation: { changed: currentState.entityHashes.navigation.length > 0 },
      fileChanges: {
        addedStoryFiles: currentState.allStoryIds.filter((id) => !namedNewIds.has(id)),
        removedStoryFiles: [],
      },
    };
  }

  // Back-compat fires for two cases:
  //   1. snapshot has no entity_hashes at all (pre-rewrite snapshots)
  //   2. snapshot has entity_hashes but a stale version (pre-rewrite
  //      snapshots that were upgraded under an earlier hash format,
  //      then the format changed). Both surface the same banner and
  //      suppress the modify_X flood — honest about why every existing
  //      entity flags as Modified for one publish.
  // The `?? 1` defaults snapshots written before the version field
  // existed to v1; mismatch with ENTITY_HASHES_VERSION fires back-compat.
  const snapshotEntityHashes = snapshot.entity_hashes;
  const snapshotVersion = snapshotEntityHashes?.version ?? 1;
  const backCompat =
    snapshotEntityHashes === undefined || snapshotVersion !== ENTITY_HASHES_VERSION;

  const storiesDiff = diffEntities({
    current: currentState.stories,
    idOf: (s) => s.story_id,
    toDeleted: (id) => ({ story_id: id, title: null }),
    currentHashes: currentState.entityHashes.stories,
    snapshotHashes: snapshotEntityHashes?.stories ?? {},
    legacyIds: snapshot.story_ids,
    backCompat,
  });

  const objectsDiff = diffEntities({
    current: currentState.objects,
    idOf: (o) => o.object_id,
    toDeleted: (id) => ({ object_id: id, title: null }),
    currentHashes: currentState.entityHashes.objects,
    snapshotHashes: snapshotEntityHashes?.objects ?? {},
    legacyIds: snapshot.object_ids,
    backCompat,
  });

  const pagesDiff = diffEntities({
    current: currentState.pages,
    idOf: (p) => p.slug,
    toDeleted: (slug) => ({ slug, title: null }),
    currentHashes: currentState.entityHashes.pages,
    snapshotHashes: snapshotEntityHashes?.pages ?? {},
    // Legacy fallback prefers page_hashes keys (more accurate — only
    // committable pages) then page_slugs (always populated post-pages-tracking).
    legacyIds: snapshot.page_hashes
      ? Object.keys(snapshot.page_hashes)
      : (snapshot.page_slugs ?? []),
    backCompat,
  });

  // Glossary was never tracked in the snapshot pre-entity-hashing — there
  // is no `glossary_term_ids` legacy field. In back-compat mode that
  // ambiguity matters: empty `legacyIds` would make `diffEntities` treat
  // every current term as "Added," but we can't actually back up that
  // claim — terms bundled with the site template predate anything the
  // user did. Override here to flag glossary as modified instead, matching
  // the bootstrap semantics for stories/objects/pages: "we can't separate
  // signal from noise on the back-compat publish, so everything existing
  // is shown as Modified for one publish."
  const glossaryDiff = backCompat
    ? {
        new: [] as { term_id: string; title: string | null }[],
        modified: currentState.glossary,
        deleted: [] as { term_id: string; title: string | null }[],
      }
    : diffEntities({
        current: currentState.glossary,
        idOf: (g) => g.term_id,
        toDeleted: (term_id) => ({ term_id, title: null }),
        currentHashes: currentState.entityHashes.glossary,
        snapshotHashes: snapshotEntityHashes?.glossary ?? {},
        legacyIds: [],
        backCompat,
      });

  // Navigation / landing — single-string hashes. Back-compat: if snapshot
  // has no entity_hashes, any non-empty current hash surfaces as a change.
  // Standard: byte-equality of the structural hash.
  let navigationChanged: boolean;
  let landingChanged: boolean;
  if (backCompat) {
    navigationChanged = currentState.entityHashes.navigation.length > 0;
    landingChanged = currentState.entityHashes.landing.length > 0;
  } else {
    navigationChanged =
      currentState.entityHashes.navigation !== snapshotEntityHashes!.navigation;
    landingChanged =
      currentState.entityHashes.landing !== snapshotEntityHashes!.landing;
  }

  // Settings — per-field diff against snapshot.config_managed.
  // Independent of entity_hashes.settings because the commit-message helper
  // needs per-field labels (especially `lang` with its post-change value).
  // Valid `key` values:
  //   - managed-field names from buildConfigManagedFields (title, url,
  //     story_key, collection_mode, etc.)
  //   - "lang" — config.lang is stored under "telar_language" in the
  //     managed map but exposed as "lang" here so the commit-message
  //     helper can resolve the target-language label.
  //   - dotted `block.key` entries (e.g. story_interface.include_demo_content,
  //     collection_interface.featured_count) from buildConfigChangeFields —
  //     these have no special-casing and fall through to the default label
  //     branch. Back-compat: snapshots written before block-field tracking
  //     lack these entries, so they surface as changed on the first
  //     post-upgrade publish, then settle.
  //   - "all" — emitted only by the first-publish branch above.
  const currentManaged = currentState.config
    ? buildConfigChangeFields(currentState.config)
    : {};
  const snapshotManaged = snapshot.config_managed ?? {};
  const changedKeys = new Set<string>([
    ...Object.keys(currentManaged),
    ...Object.keys(snapshotManaged),
  ]);
  const settingsChanged: ChangeSummary["settings"]["changed"] = [];
  for (const key of changedKeys) {
    if (currentManaged[key] !== snapshotManaged[key]) {
      const summaryKey = key === "telar_language" ? "lang" : key;
      // For value-dependent keys (lang, collection_mode), thread the post-change
      // value as the label so downstream renderers can pick a value-specific
      // i18n string (e.g. change_language_to_es, change_collection_mode_on).
      // collection_mode is stored as "true"/"false" but mapped to "on"/"off"
      // here to match the i18n key naming.
      let labelValue: string;
      if (key === "telar_language") {
        labelValue = currentManaged[key] ?? "";
      } else if (key === "collection_mode") {
        labelValue = currentManaged[key] === "true" ? "on" : "off";
      } else {
        labelValue = summaryKey;
      }
      // value carries the post-change raw value ("true"/"false"/number) so the
      // commit-message + popover label resolver can pick an on/off variant for
      // nested boolean block fields (see app/lib/settings-change-i18n.ts).
      settingsChanged.push({ key: summaryKey, label: labelValue, value: currentManaged[key] });
    }
  }

  // File-set diff: set-difference between the full prior
  // file set and the current full D1 set, then dedup against the publishable
  // story diff so non-drafts aren't double-counted. Prefer `all_story_ids`
  // when present; fall back to `story_ids` (non-drafts only) for older snapshots
  // written before that field existed — closes the gap after one publish,
  // same back-compat shape as `computeStoryDeletions`.
  const priorAllIds = new Set(snapshot.all_story_ids ?? snapshot.story_ids ?? []);
  const currentAllIds = new Set(currentState.allStoryIds);
  const rawAdded = [...currentAllIds].filter((id) => !priorAllIds.has(id));
  const rawRemoved = [...priorAllIds].filter((id) => !currentAllIds.has(id));
  const namedNewIds = new Set(storiesDiff.new.map((s) => s.story_id));
  const namedDeletedIds = new Set(storiesDiff.deleted.map((s) => s.story_id));
  const addedStoryFiles = rawAdded.filter((id) => !namedNewIds.has(id));
  const removedStoryFiles = rawRemoved.filter((id) => !namedDeletedIds.has(id));

  const isUpToDate =
    storiesDiff.new.length === 0 &&
    storiesDiff.modified.length === 0 &&
    storiesDiff.deleted.length === 0 &&
    objectsDiff.new.length === 0 &&
    objectsDiff.modified.length === 0 &&
    objectsDiff.deleted.length === 0 &&
    pagesDiff.new.length === 0 &&
    pagesDiff.modified.length === 0 &&
    pagesDiff.deleted.length === 0 &&
    glossaryDiff.new.length === 0 &&
    glossaryDiff.modified.length === 0 &&
    glossaryDiff.deleted.length === 0 &&
    settingsChanged.length === 0 &&
    !landingChanged &&
    !navigationChanged &&
    addedStoryFiles.length === 0 &&
    removedStoryFiles.length === 0;

  return {
    isUpToDate,
    backCompatBootstrap: backCompat,
    stories: storiesDiff,
    objects: objectsDiff,
    pages: pagesDiff,
    glossary: glossaryDiff,
    settings: { changed: settingsChanged },
    landing: { changed: landingChanged },
    navigation: { changed: navigationChanged },
    fileChanges: { addedStoryFiles, removedStoryFiles },
  };
}

/**
 * Finds the maximum `updated_at` across every entity table that the
 * entity-hashing rewrite tracks for a given project. Used by the loader
 * to decide whether a back-compat snapshot can be silently upgraded
 * (no edits since last publish → safe to write entity_hashes to D1
 * without making a GitHub commit) or whether the user has pending
 * edits and the loud-bootstrap path with banner must fire.
 *
 * Returns the ISO timestamp string of the most-recent edit across:
 *   stories, steps, layers, objects, project_pages, glossary_terms,
 *   project_config, project_landing
 *
 * Steps and layers are joined through stories so the project filter
 * still applies. Returns null when the project has no entities at all
 * (a brand-new project).
 *
 * Cost: 8 max-aggregate queries running in parallel. Only invoked
 * when the loader detects a back-compat snapshot (one-shot per project
 * during the entity-hashing transition); the snapshot upgrade short-
 * circuits this on subsequent navigations.
 */
export async function findEntityMaxUpdatedAt(
  db: ReturnType<typeof getDb>,
  projectId: number,
): Promise<string | null> {
  const [
    storiesMax,
    stepsMax,
    layersMax,
    objectsMax,
    pagesMax,
    glossaryMax,
    configMax,
    landingMax,
  ] = await Promise.all([
    db.select({ m: max(stories.updated_at) })
      .from(stories)
      .where(eq(stories.project_id, projectId)),
    db.select({ m: max(steps.updated_at) })
      .from(steps)
      .innerJoin(stories, eq(steps.story_id, stories.id))
      .where(eq(stories.project_id, projectId)),
    db.select({ m: max(layers.updated_at) })
      .from(layers)
      .innerJoin(steps, eq(layers.step_id, steps.id))
      .innerJoin(stories, eq(steps.story_id, stories.id))
      .where(eq(stories.project_id, projectId)),
    db.select({ m: max(objects.updated_at) })
      .from(objects)
      .where(eq(objects.project_id, projectId)),
    db.select({ m: max(project_pages.updated_at) })
      .from(project_pages)
      .where(eq(project_pages.project_id, projectId)),
    db.select({ m: max(glossary_terms.updated_at) })
      .from(glossary_terms)
      .where(eq(glossary_terms.project_id, projectId)),
    db.select({ m: max(project_config.updated_at) })
      .from(project_config)
      .where(eq(project_config.project_id, projectId)),
    db.select({ m: max(project_landing.updated_at) })
      .from(project_landing)
      .where(eq(project_landing.project_id, projectId)),
  ]);

  const candidates = [
    storiesMax[0]?.m,
    stepsMax[0]?.m,
    layersMax[0]?.m,
    objectsMax[0]?.m,
    pagesMax[0]?.m,
    glossaryMax[0]?.m,
    configMax[0]?.m,
    landingMax[0]?.m,
  ].filter((v): v is string => Boolean(v));

  if (candidates.length === 0) return null;
  // ISO-8601 timestamps sort lexicographically — string max is correct.
  return candidates.reduce((a, b) => (a > b ? a : b));
}

// ---------------------------------------------------------------------------
// Pre-publish validation
// ---------------------------------------------------------------------------

export interface StoryForValidation {
  story_id: string;
  title: string | null;
  /**
   * Whether the story is marked private. Drives the private_story_no_key
   * warning: a published Telar >=1.6 site with a private story but no site-wide
   * story key hard-fails its build (the framework's encryption interlock).
   */
  private?: boolean | null;
  /**
   * Whether the story is a draft. Drafts are excluded from the published
   * stories index (the orphans-are-drafts rule), so a private draft never
   * reaches the framework's encryption interlock and must not trigger the
   * private_story_no_key warning.
   */
  draft?: boolean | null;
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

export interface PageForValidation {
  slug: string | null;
  title: string | null;
}

/**
 * Runs pre-publish validation checks.
 *
 * Blockers prevent publishing; warnings are advisory.
 *
 * Blockers:
 *   - headSha !== currentRepoHead (repo has diverged — re-sync required)
 *   - Pages missing a title (the page can't be published in this state — no
 *     usable URL or menu entry — and pageRowsToCommitFiles excludes it; gating
 *     here forces the user to either name or delete the row before any publish)
 * Warnings:
 *   - Objects missing a title (still emitted, just imperfect)
 *   - Steps that have an object but no position (x/y/zoom all null)
 *   - Private stories present but no site-wide story key set (the build will
 *     fail on Telar >=1.6 until a key is set — advisory, never a blocker)
 *   - Fully empty steps are excluded from all checks
 */
export function runPrePublishValidation(params: {
  headSha: string;
  currentRepoHead: string;
  stories: StoryForValidation[];
  steps: StepForValidation[];
  objects: ObjectForValidation[];
  pages: PageForValidation[];
  storyKey?: string | null;
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

  // Blocker: pages without titles. Distinct from object_no_title (warning):
  // an empty-title page can't be published at all (no usable URL/menu entry —
  // pageRowsToCommitFiles excludes it). Promoting to blocker prevents the
  // user from advancing past the Checks step until they either name the page
  // or delete it. Multiple page blockers are possible; the rendering side
  // keys by code+entityId.
  //
  // A titleless page has an empty or temp slug, so the old slug-interpolated
  // copy rendered the unhelpful `Page ""…`. The reworded message is
  // recovery-oriented and does NOT depend on slug, so we drop
  // `params: { slug }`. We still need a unique, non-slug-derived `entityId`
  // per blocker so the renderer (keyed by code+entityId) gives each untitled
  // page a distinct React key — use a 1-based ordinal among untitled pages.
  let untitledPageOrdinal = 0;
  for (const page of params.pages) {
    if (!page.title || page.title.trim() === "") {
      untitledPageOrdinal += 1;
      blockers.push({
        code: "page_no_title",
        message: "page_no_title",
        entityId: `untitled-${untitledPageOrdinal}`,
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

  // Warning: private stories present but no site-wide story key set. On
  // Telar >=1.6 the framework encrypts private stories at build time and
  // refuses to build when a story is private but no key exists — so the
  // published site build would hard-fail. We warn rather than block: the user
  // may still be mid-setup, and blocking would trap otherwise-valid publishes.
  // The message names the affected stories (title when present, story_id as a
  // fallback) so the user knows exactly which ones force the requirement.
  const storyKeySet =
    params.storyKey != null && params.storyKey.trim() !== "";
  if (!storyKeySet) {
    // Drafts are skipped: a draft story is absent from the published stories
    // index (the orphans-are-drafts rule), so the framework's interlock never
    // sees its private flag and the build cannot fail on its account.
    const privateStoryNames = params.stories
      .filter((s) => s.private && !s.draft)
      .map((s) => (s.title && s.title.trim() !== "" ? s.title.trim() : s.story_id));
    if (privateStoryNames.length > 0) {
      warnings.push({
        code: "private_story_no_key",
        message: "private_story_no_key",
        params: { stories: privateStoryNames.join(", ") },
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
 * Builds the `managedFields` map for `_config.yml` from a `project_config` row.
 *
 * Each entry maps a top-level YAML key to the formatted scalar that
 * `updateConfigFields` should write. Strings are wrapped in double quotes;
 * `collection_mode` is emitted as an unquoted boolean for js-yaml round-trip;
 * `telar_language` is emitted unquoted to match the framework template's format.
 *
 * Exported so the round-trip from D1 schema → YAML serialisation can be
 * exercised in isolation, guarding against the "added a column to D1 but
 * forgot to thread it through publish" omission pattern.
 */
export function buildConfigManagedFields(
  config: typeof project_config.$inferSelect,
): Record<string, string> {
  const fields: Record<string, string> = {};
  // Route every free-text string field through yamlQuote so embedded newlines,
  // double quotes, and backslashes are escaped into a single-line YAML scalar.
  // The prior naive `"${value}"` wrapping let a multi-paragraph description (or
  // a quote in the title) emit bare newlines / unbalanced quotes, corrupting
  // _config.yml and breaking every Jekyll build (production incident 2026-05-28).
  if (config.title != null) fields["title"] = yamlQuote(config.title);
  if (config.url != null) fields["url"] = yamlQuote(config.url);
  if (config.baseurl != null) fields["baseurl"] = yamlQuote(config.baseurl);
  if (config.description != null) fields["description"] = yamlQuote(sanitiseInlineHtml(config.description));
  if (config.author != null) fields["author"] = yamlQuote(config.author);
  if (config.email != null) fields["email"] = yamlQuote(config.email);
  if (config.logo != null) fields["logo"] = yamlQuote(config.logo);
  if (config.theme != null) fields["telar_theme"] = yamlQuote(config.theme);
  // story_key is a free-text secret that users may set to anything, including
  // characters YAML treats specially — a `#` starts a comment and a `:` opens a
  // mapping, so an unquoted key like `a#b` or `a: b` parses back truncated or
  // absent, silently losing the key on the next read. Quote it exactly like the
  // other managed string fields; the readers (sync's parseYamlScalar, import's
  // js-yaml) strip the quotes on the way back, so this is transparent on
  // round-trip for keys that never needed quoting.
  if (config.story_key != null) fields["story_key"] = yamlQuote(config.story_key);
  if (config.lang != null) fields["telar_language"] = config.lang;
  if (config.collection_mode != null) {
    fields["collection_mode"] = config.collection_mode ? "true" : "false";
  }
  return fields;
}

/**
 * Builds the managed NESTED config blocks (story_interface, collection_interface)
 * from a project_config row. Values are emitted UNQUOTED — js-yaml coerces
 * unquoted true/false/4 to boolean/number, which import.server.ts relies on
 * (a quoted "false" would be read back as a truthy string). Null fields are
 * omitted; empty blocks are dropped. google_sheets is intentionally excluded
 * (nested string = corruption-risk class; not Config-UI editable).
 */
export function buildConfigManagedBlocks(
  config: typeof project_config.$inferSelect,
): Record<string, Record<string, string>> {
  const b = (v: boolean) => (v ? "true" : "false");
  const story: Record<string, string> = {};
  if (config.show_on_homepage != null) story["show_on_homepage"] = b(config.show_on_homepage);
  if (config.show_story_steps != null) story["show_story_steps"] = b(config.show_story_steps);
  if (config.show_object_credits != null) story["show_object_credits"] = b(config.show_object_credits);
  if (config.include_demo_content != null) story["include_demo_content"] = b(config.include_demo_content);

  const collection: Record<string, string> = {};
  if (config.browse_and_search != null) collection["browse_and_search"] = b(config.browse_and_search);
  if (config.show_link_on_homepage != null) collection["show_link_on_homepage"] = b(config.show_link_on_homepage);
  if (config.show_sample_on_homepage != null) collection["show_sample_on_homepage"] = b(config.show_sample_on_homepage);
  if (config.featured_count != null) collection["featured_count"] = String(config.featured_count);

  const blocks: Record<string, Record<string, string>> = {};
  if (Object.keys(story).length > 0) blocks["story_interface"] = story;
  if (Object.keys(collection).length > 0) blocks["collection_interface"] = collection;
  return blocks;
}

/**
 * Flattened managed view used for CHANGE DETECTION only (not for writing):
 * top-level managed fields plus each block field under a `block.key` dotted key.
 * Ensures a pure nested-toggle change (e.g. demo content off) is detected as an
 * unpublished change and stored in the publish snapshot's config_managed.
 */
export function buildConfigChangeFields(
  config: typeof project_config.$inferSelect,
): Record<string, string> {
  const fields = buildConfigManagedFields(config);
  for (const [blockKey, kv] of Object.entries(buildConfigManagedBlocks(config)))
    for (const [k, v] of Object.entries(kv)) fields[`${blockKey}.${k}`] = v;
  return fields;
}

/**
 * Convert page rows from D1 into commit files. Pure — no DB access.
 *
 * Skip rows with empty/null/whitespace slug so a nameless
 * page never produces `telar-content/texts/pages/.md`. The trim is load-bearing —
 * collaborative inputs sometimes carry trailing whitespace from CSV imports.
 * The trimmed slug is used in the path
 * interpolation so a row with a whitespace-only slug never produces
 * `pages/   .md` either.
 */
export function pageRowsToCommitFiles(
  pageRows: Pick<typeof project_pages.$inferSelect, "title" | "slug" | "body">[],
): CommitFile[] {
  const files: CommitFile[] = [];
  for (const page of pageRows) {
    if (!isPagePublishable(page)) continue;
    files.push({
      path: `telar-content/texts/pages/${(page.slug ?? "").trim()}.md`,
      content: serializePageMarkdown(page.title ?? "", page.body ?? ""),
    });
  }
  return files;
}

/**
 * A page is publishable when both its title and slug are non-empty after
 * trim. Empty-title pages auto-acquire a temporary slug like `untitled`
 * from the editor's auto-slug-from-title path (regression silent since
 * 2026-04-15, partly addressed for nav-merge but not in
 * the publish pipeline). This predicate is the single source of truth
 * for whether such a row reaches GitHub or the entity-hash snapshot.
 */
export function isPagePublishable(page: { title: string | null; slug: string | null }): boolean {
  return !!(page.title ?? "").trim() && !!(page.slug ?? "").trim();
}

/**
 * Per-page content hash keyed by trimmed slug. Used by computeChangeSummary
 * to detect which existing pages were actually edited between publishes.
 *
 * The hash inputs (`title + body + slug`) are exactly the fields that
 * affect the published `pages/{slug}.md` file or its frontmatter.
 *
 * `project_pages.order` is deliberately EXCLUDED. The Pages tab has
 * reorder UI, and a reorder there DOES propagate to a publishable change
 * — but via `navigation_json` (which drives `_data/navigation.yml` and
 * the menu bar), not via the per-slug page files. That signal is already
 * captured by `entity_hashes.navigation` and surfaces as the "Navigation
 * menu" row in the change-review modal. Including `order` in the page
 * hash would double-count the same user action under two buckets.
 *
 * Pages with empty/whitespace slugs are excluded — they never land in the
 * commit, so they have no presence in the snapshot and shouldn't appear in
 * the diff.
 */
export function buildPageContentHashes(
  pageRows: Pick<typeof project_pages.$inferSelect, "title" | "slug" | "body">[],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const page of pageRows) {
    if (!isPagePublishable(page)) continue;
    const slug = (page.slug ?? "").trim();
    hashes[slug] = JSON.stringify({
      title: page.title ?? "",
      body: page.body ?? "",
      slug,
    });
  }
  return hashes;
}

/**
 * Builds the full per-entity hash map for every entity bucket the publish
 * pipeline tracks: pages, stories, objects, glossary, navigation, landing,
 * settings. Single source of truth for change detection.
 *
 * Hashing is D1-only — no GitHub I/O. Each hash input is the exact field
 * set that the corresponding serialiser inside `buildPublishFileSet` writes
 * to the published file or its frontmatter. That makes hash equality on
 * D1 source data equivalent to byte equality on the published file for
 * change-detection purposes.
 *
 * Determinism notes:
 *   - Steps and layers are sorted by `step_number` / `layer_number` before
 *     hashing so D1 query order (insertion-order via auto-increment id)
 *     does not leak into the hash. Reorders DO change the hash because
 *     `step_number` itself is part of the hashed fields.
 *   - Object key order in `JSON.stringify` follows literal-construction
 *     order in modern V8 / Workers; the explicit literals below pin that
 *     order so two callers with the same D1 data produce byte-identical
 *     hashes.
 *   - Drafts are excluded from the stories bucket so they never appear in
 *     the project.csv-driven hash-summary (toggling draft on/off appears
 *     as a deletion / addition in the commit message rather than a
 *     modification). Drafts now DO produce a per-story
 *     {story_id}.csv file in `buildPublishFileSet` — the orphans-are-drafts
 *     round-trip rule — but they remain absent from project.csv and from
 *     this hash-summary input, so the commit-message naming layer is
 *     unchanged.
 *   - Empty/whitespace-slug pages are excluded for the same reason — they
 *     never land in the commit (`pageRowsToCommitFiles` skips them).
 */
export async function buildEntityHashes(
  db: ReturnType<typeof getDb>,
  projectId: number,
): Promise<EntityHashes> {
  const [
    storyRows,
    objectRows,
    pageRows,
    glossaryRows,
    configRow,
    landingRow,
  ] = await Promise.all([
    db.select().from(stories).where(eq(stories.project_id, projectId)),
    db.select().from(objects).where(eq(objects.project_id, projectId)),
    db
      .select({
        title: project_pages.title,
        slug: project_pages.slug,
        body: project_pages.body,
        order: project_pages.order,
      })
      .from(project_pages)
      .where(eq(project_pages.project_id, projectId)),
    db
      .select({
        term_id: glossary_terms.term_id,
        title: glossary_terms.title,
        definition: glossary_terms.definition,
        related_terms: glossary_terms.related_terms,
      })
      .from(glossary_terms)
      .where(eq(glossary_terms.project_id, projectId)),
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
  ]);

  const config = configRow[0] ?? null;
  const landing = landingRow[0] ?? null;

  // Pages — share canonical hash inputs with buildPageContentHashes
  // (title + body + slug; order is deliberately excluded — a reorder
  // surfaces once, as the navigation change), keyed by trimmed slug.
  const pages = buildPageContentHashes(pageRows);

  // Objects — every D1 field that serializeObjectsCsv reads, including
  // dimensions and the extra_columns custom-column passthrough blob. Objects
  // have no order field: they are not reorderable in the compositor and the
  // published Telar framework has no object order (it renders featured
  // objects in natural CSV order and sorts the objects index by title).
  // The published objects.csv row order is determined by D1 query order
  // (auto-increment id ≈ insertion order). extra_columns is canonicalised
  // (keys sorted) so equivalent data hashes identically regardless of stored
  // key order.
  const objectHashes: Record<string, string> = {};
  for (const o of objectRows) {
    objectHashes[o.object_id] = JSON.stringify({
      object_id: o.object_id,
      title: o.title ?? "",
      featured: o.featured ?? false,
      creator: o.creator ?? "",
      description: o.description ?? "",
      source_url: o.source_url ?? "",
      period: o.period ?? "",
      year: o.year ?? "",
      object_type: o.object_type ?? "",
      subjects: o.subjects ?? "",
      source: o.source ?? "",
      credit: o.credit ?? "",
      thumbnail: o.thumbnail ?? "",
      alt_text: o.alt_text ?? "",
      dimensions: o.dimensions ?? "",
      extra_columns: canonicalExtraColumns(o.extra_columns),
    });
  }

  // Stories — non-draft only for hash-summary purposes. Hash captures the
  // project.csv row, every step (sorted by step_number), and every layer for
  // each step (sorted by layer_number). Toggling a story to draft removes it
  // from this hash bucket — appearing as a deletion in the next change
  // summary's commit message — but its per-story
  // {story_id}.csv file is still written by buildPublishFileSet below.
  const storyHashes: Record<string, string> = {};
  const nonDraftStories = storyRows.filter((s) => !s.draft);
  for (const story of nonDraftStories) {
    const stepRows = await db
      .select()
      .from(steps)
      .where(eq(steps.story_id, story.id));
    const sortedSteps = [...stepRows].sort(
      (a, b) => a.step_number - b.step_number,
    );

    const stepsForHash: Array<Record<string, unknown>> = [];
    for (const step of sortedSteps) {
      const layerRows = await db
        .select()
        .from(layers)
        .where(eq(layers.step_id, step.id));
      const sortedLayers = [...layerRows].sort(
        (a, b) => a.layer_number - b.layer_number,
      );
      stepsForHash.push({
        step_number: step.step_number,
        kind: step.kind ?? "media",
        object_id: step.object_id ?? "",
        x: step.x,
        y: step.y,
        zoom: step.zoom,
        page: step.page ?? "",
        question: step.question ?? "",
        answer: step.answer ?? "",
        alt_text: step.alt_text ?? "",
        clip_start: step.clip_start ?? "",
        clip_end: step.clip_end ?? "",
        loop: step.loop ?? "",
        layers: sortedLayers.map((l) => ({
          layer_number: l.layer_number,
          title: l.title ?? "",
          button_label: l.button_label ?? "",
          content: l.content ?? "",
        })),
      });
    }

    storyHashes[story.story_id] = JSON.stringify({
      story_id: story.story_id,
      title: story.title ?? "",
      subtitle: story.subtitle ?? "",
      byline: story.byline ?? "",
      order: story.order ?? 0,
      private: story.private ?? false,
      show_sections: story.show_sections ?? false,
      steps: stepsForHash,
    });
  }

  // Glossary — id + title + definition. No `order` column on the schema
  // (verified) so reorders aren't representable.
  const glossaryHashes: Record<string, string> = {};
  for (const term of glossaryRows) {
    glossaryHashes[term.term_id] = JSON.stringify({
      term_id: term.term_id,
      title: term.title ?? "",
      definition: term.definition ?? "",
      related_terms: term.related_terms ?? "",
    });
  }

  // Navigation — structural hash of the parsed JSON so whitespace edits
  // don't surface as changes. Empty string when no nav exists or when
  // the JSON is malformed; `_data/navigation.yml` skips serialisation in
  // the same condition, so the diff stays consistent.
  let navigationHash = "";
  if (config?.navigation_json) {
    try {
      navigationHash = JSON.stringify(JSON.parse(config.navigation_json));
    } catch {
      // Malformed — leave empty
    }
  }

  // Landing — every field that affects index.md (frontmatter + body).
  const landingHash = landing
    ? JSON.stringify({
        stories_heading: landing.stories_heading ?? "",
        stories_intro: landing.stories_intro ?? "",
        objects_heading: landing.objects_heading ?? "",
        objects_intro: landing.objects_intro ?? "",
        welcome_body: landing.welcome_body ?? "",
      })
    : "";

  // Settings — exact output of buildConfigManagedFields. Per-field diff
  // (driving lang/title/etc. labels in the commit message) is computed
  // separately in computeChangeSummary against snapshot.config_managed,
  // so this hash exists for completeness/symmetry only.
  const settingsHash = config
    ? JSON.stringify(buildConfigChangeFields(config))
    : "";

  return {
    version: ENTITY_HASHES_VERSION,
    pages,
    stories: storyHashes,
    objects: objectHashes,
    glossary: glossaryHashes,
    navigation: navigationHash,
    landing: landingHash,
    settings: settingsHash,
  };
}

/**
 * Hard-deleted stories (in a prior project.csv-tracked publish,
 * no longer in D1) get their {story_id}.csv deleted on GitHub this publish.
 * Drafts are NOT hard-deletes — they remain in D1 with draft=true and their
 * file is still written by buildPublishFileSet's file-set assembly.
 *
 * Pure helper, extracted so the contract is unit-testable. Production wiring
 * lives in `_app.publish.tsx` action: passes the current D1 story IDs (all of
 * them, draft + non-draft, since all of them now get files) and the
 * loaded prior snapshot.
 *
 * Contract:
 *   - snapshot is null (first publish ever) → []
 *   - prior published IDs set is empty → [] (nothing was previously
 *     published, so nothing to delete; matches the first-publish path on a
 *     snapshot written before story_ids tracking)
 *   - otherwise → set difference (priorIds - currentStoryIds), mapped to
 *     `telar-content/spreadsheets/${id}.csv` paths
 *
 * "Prior published IDs" = `snapshot.all_story_ids` when present (newer
 * snapshots; tracks files written for both drafts and non-drafts), falling
 * back to `snapshot.story_ids` for older snapshots (which only tracked
 * non-drafts because drafts had no file presence on GitHub at the time).
 *
 * No user input flows into the deletion paths — story IDs come from the
 * snapshot (the system's own prior commit record) and from D1 (the user's
 * own rows, written through the validated `stories.story_id` column).
 * Mitigates a tampering vector — a malicious orphan file injected into the
 * repo cannot displace a draft.
 */
export function computeStoryDeletions(
  currentStoryIds: string[],
  snapshot: PublishSnapshot | null,
): string[] {
  if (!snapshot) return [];
  const priorIds = snapshot.all_story_ids ?? snapshot.story_ids ?? [];
  if (priorIds.length === 0) return [];
  const currentSet = new Set(currentStoryIds);
  return priorIds
    .filter((id) => !currentSet.has(id))
    .map((id) => `telar-content/spreadsheets/${id}.csv`);
}

/**
 * Page-file hard-delete detection — the page analogue of
 * `computeStoryDeletions`. A page slug rename writes the new
 * `texts/pages/{new}.md` but never removes `texts/pages/{old}.md`, so without
 * this a renamed (or hard-deleted) page orphans a stale `.md` — and a stale
 * live page — in the repo. Returns the `.md` paths for prior committable slugs
 * absent from the current committable set. Empty on first publish (no
 * snapshot) or for snapshots written before `page_slugs` tracking existed
 * (the field is optional — missing/empty means "nothing known to delete",
 * mirroring the `priorIds.length === 0` guard above).
 *
 * The caller MUST pass `currentPageSlugs` computed with the SAME trim/
 * non-empty filter used to build `page_slugs` in the snapshot, and MUST drop
 * any returned path that also appears in this publish's additions (a recycled
 * slug being rewritten), so a still-live page is never deleted.
 */
export function computePageDeletions(
  currentPageSlugs: string[],
  snapshot: PublishSnapshot | null,
): string[] {
  if (!snapshot) return [];
  const priorSlugs = snapshot.page_slugs ?? [];
  if (priorSlugs.length === 0) return [];
  const currentSet = new Set(currentPageSlugs);
  return priorSlugs
    .filter((slug) => !currentSet.has(slug))
    .map((slug) => `telar-content/texts/pages/${slug}.md`);
}

/**
 * Returns the file-set paths that buildPublishFileSet will
 * write for the given D1 story rows. ALL stories produce a path regardless
 * of draft flag — the orphans-are-drafts round-trip rule. Pure helper,
 * extracted from buildPublishFileSet so the contract is unit-testable
 * without GitHub I/O.
 *
 * Path shape mirrors buildPublishFileSet exactly:
 *   `telar-content/spreadsheets/${story.story_id}.csv`
 *
 * The set of paths returned here is the set the importer will scan
 * for orphans against project.csv. project.csv continues to exclude drafts
 * via serializeProjectCsv, so any draft story produces an orphan file — by
 * design.
 */
export function storyPathsForPublish(
  storyRows: Array<{ story_id: string; draft: boolean }>,
): string[] {
  return storyRows.map((s) => `telar-content/spreadsheets/${s.story_id}.csv`);
}

/**
 * Assembles the full set of CommitFile objects for a publish commit.
 *
 * Reads all stories, steps, layers, objects, project_config, and project_landing
 * from D1 and generates:
 *   - _config.yml (managed fields updated, comments preserved)
 *   - telar-content/spreadsheets/project.csv
 *   - telar-content/spreadsheets/{story_id}.csv per story (draft + non-draft) — orphans-are-drafts
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
  const [existingConfigYml, existingObjectsCsv, existingIndexMd, existingGlossaryCsv] =
    await Promise.all([
      getFileContent(token, owner, repo, "_config.yml"),
      getFileContent(token, owner, repo, "telar-content/spreadsheets/objects.csv"),
      getFileContent(token, owner, repo, "index.md"),
      getFileContent(token, owner, repo, "telar-content/spreadsheets/glossary.csv"),
    ]);

  const files: CommitFile[] = [];

  // --- _config.yml ---
  // healConfigYaml escapes managed fields and self-heals orphaned multi-line
  // scalars left by the pre-fix serializer, so a user's next publish repairs a
  // previously-broken site through the normal build pipeline. Hygiene gate: the
  // result is parsed before committing — if it somehow still isn't valid YAML
  // (a corruption shape beyond the line-based heal), the config write is skipped
  // rather than committing broken YAML or overwriting the user's settings. The
  // repo's current _config.yml is left untouched and the event is logged for
  // manual follow-up; the rest of the publish still proceeds.
  if (existingConfigYml && config) {
    const managedFields = buildConfigManagedFields(config);
    const managedBlocks = buildConfigManagedBlocks(config);
    const updatedConfig = healConfigYaml(existingConfigYml, managedFields, managedBlocks);
    if (isParseableYaml(updatedConfig)) {
      files.push({ path: "_config.yml", content: updatedConfig });
    } else {
      console.warn(
        `[publish] _config.yml for project ${projectId} could not be healed to valid YAML; ` +
          `skipping config write to avoid committing broken YAML or resetting settings`,
      );
    }
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
      // show_sections column from stories table
      show_sections: s.show_sections ?? false,
    })),
  );
  files.push({
    path: "telar-content/spreadsheets/project.csv",
    content: projectCsvContent,
  });

  // --- objects.csv ---
  const objectsCsvContent = serializeObjectsCsv(
    objectRows.map((o) => ({
      object_id: o.object_id,
      title: o.title ?? null,
      featured: o.featured ?? null,
      creator: o.creator ?? null,
      description: o.description ?? null,
      source_url: o.source_url ?? null,
      period: o.period ?? null,
      year: o.year ?? null,
      medium_genre: o.object_type ?? null, // D1 stores as object_type; CSV exports as medium_genre (v1.0.0)
      subjects: o.subjects ?? null,
      source: o.source ?? null,
      credit: o.credit ?? null,
      thumbnail: o.thumbnail ?? null,
      alt_text: o.alt_text ?? null,
      dimensions: o.dimensions ?? null,
      extra_columns: o.extra_columns ?? null,
    })),
    existingObjectsCsv ?? undefined,
  );
  files.push({
    path: "telar-content/spreadsheets/objects.csv",
    content: objectsCsvContent,
  });

  // --- Per-story CSVs and layer files ---
  // Iterate over ALL stories (draft + non-draft). Each story
  // produces one telar-content/spreadsheets/{story_id}.csv file regardless of
  // draft flag — that's the orphans-are-drafts round-trip rule. project.csv
  // still excludes drafts (serializeProjectCsv at line 312), so drafts appear
  // on GitHub as orphan files relative to project.csv, which the
  // importer detects and the dashboard banner surfaces.
  for (const story of storyRows) {
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
      // kind from D1; defaults to "media"
      // for any pre-existing rows where the schema default did not apply.
      kind: (step.kind as "media" | "section") ?? "media",
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

    // Story CSV + the layer files it references — produced together in one
    // pass so filename assignment happens exactly once. The file-writing loop
    // below uses serializeStory's `layerFiles` directly, so a file's path can
    // never disagree with the CSV's `layerN_content` cell (the divergence bug
    // that occurred when titles collided after a step reorder).
    const { csv: storyCsvContent, layerFiles } = serializeStory(
      stepsWithLayers,
      storySlug,
    );
    files.push({
      path: `telar-content/spreadsheets/${storySlug}.csv`,
      content: storyCsvContent,
    });

    // Layer markdown files — one per CSV-referenced layer, using the exact
    // filename + content the CSV recorded.
    for (const layerFile of layerFiles) {
      files.push({
        path: `telar-content/texts/stories/${layerFile.filename}`,
        content: layerFileContent(layerFile.title, layerFile.content),
      });
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

        // Defensive gates against re-emitting v1.2.1 English literals
        // that survived the upgrade-time cleanup (sites that bypass the compositor's
        // upgrade flow). Sync `===` for short frontmatter strings and
        // `normalizeBody` equality for the welcome body — never async, because
        // making serializeProjectToCommitFiles async would cascade through the
        // entire publish path.
        const managedLines: string[] = [];
        if (
          landing.stories_heading &&
          landing.stories_heading !== V121_FRONTMATTER_DEFAULTS.stories_heading
        )
          managedLines.push(`stories_heading: ${yamlQuote(landing.stories_heading)}`);
        if (landing.stories_intro)
          managedLines.push(`stories_intro: ${yamlQuote(landing.stories_intro)}`);
        if (
          landing.objects_heading &&
          landing.objects_heading !== V121_FRONTMATTER_DEFAULTS.objects_heading
        )
          managedLines.push(`objects_heading: ${yamlQuote(landing.objects_heading)}`);
        if (
          landing.objects_intro &&
          landing.objects_intro !== V121_FRONTMATTER_DEFAULTS.objects_intro
        )
          managedLines.push(`objects_intro: ${yamlQuote(landing.objects_intro)}`);

        const allFrontmatterLines = [...preservedLines, ...managedLines].filter(
          (l) => l.trim() !== "",
        );

        // Fall back to the parsed body when landing.welcome_body is the
        // verbatim v1.2.1 default. Sync normalizeBody equality (no
        // async cascade); CRLF-tolerant.
        const useLandingBody =
          landing.welcome_body !== null &&
          landing.welcome_body !== undefined &&
          normalizeBody(landing.welcome_body) !== normalizeBody(V121_BODIES.index);
        const body = useLandingBody ? landing.welcome_body! : match[2].trim();
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
    .select({ term_id: glossary_terms.term_id, title: glossary_terms.title, definition: glossary_terms.definition, related_terms: glossary_terms.related_terms })
    .from(glossary_terms)
    .where(eq(glossary_terms.project_id, projectId));
  if (glossaryRows.length > 0) {
    files.push({
      path: "telar-content/spreadsheets/glossary.csv",
      content: serializeGlossaryCsv(glossaryRows, existingGlossaryCsv ?? undefined),
    });
  }

  // --- page markdown files ---
  // Empty-slug rows are skipped inside pageRowsToCommitFiles so a
  // nameless page never produces `telar-content/texts/pages/.md`.
  const pageRows = await db
    .select({ title: project_pages.title, slug: project_pages.slug, body: project_pages.body })
    .from(project_pages)
    .where(eq(project_pages.project_id, projectId));
  files.push(...pageRowsToCommitFiles(pageRows));

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
 * Canonical labels + URLs for the built-in nav sections, in both languages.
 *
 * Built-in items are not user-renameable (the editor shows them via a fixed
 * `builtinLabels` t() map), so the stored `label` is just the English seed.
 * `navigation.yml` is bilingual — the framework header picks `title_en` vs
 * `titulo_es` by `telar_language` — so we emit BOTH canonical values here, from
 * one output, correct for English and Spanish sites alike. (Previously the stored
 * English label was copied into both fields, so Spanish sites published
 * `titulo_es: "Objects"` and the header rendered the English label.)
 *
 * `home` is deliberately absent: the navbar-brand already links home, so no
 * redundant Home menu item is emitted.
 */
const BUILTIN_NAV: Record<string, { en: string; es: string; url: string }> = {
  collection: { en: "Objects", es: "Objetos", url: "/objects/" },
  glossary: { en: "Glossary", es: "Glosario", url: "/glossary/" },
};

/**
 * Serialises a navigation items array to a Telar-compatible navigation.yml string.
 *
 * Built-in items emit their canonical bilingual labels (see `BUILTIN_NAV`); a
 * `home` built-in (or any unknown key) is skipped. Custom page items are
 * genuinely monolingual, so the user's single label is written into both
 * `title_en` and `titulo_es`; external links emit only `title_en` (plus the URL
 * and the `external` flag). Hidden items (visible: false) are excluded.
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
    } else if (item.type === "builtin") {
      const key = item.key ?? "";
      // Own-property lookup so inherited keys (e.g. "__proto__") can't resolve to
      // a truthy non-entry and crash on the undefined label below.
      const builtin = Object.hasOwn(BUILTIN_NAV, key) ? BUILTIN_NAV[key] : undefined;
      if (!builtin) continue; // home / unknown builtins are intentionally not emitted
      lines.push(`  - title_en: ${yamlQuote(builtin.en)}`);
      lines.push(`    titulo_es: ${yamlQuote(builtin.es)}`);
      lines.push(`    url: ${builtin.url}`);
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

export const GLOSSARY_CSV_COLUMNS = ["term_id", "title", "definition", "related_terms"] as const;

/**
 * Spanish bilingual second-row values for glossary.csv. These are
 * framework-recognised header tokens (KNOWN_BILINGUAL_VALUES), so a re-import
 * skips the row via isHeaderRow rather than ingesting it as a phantom term.
 */
export const GLOSSARY_BILINGUAL_ROW: Record<string, string> = {
  term_id: "id_término",
  title: "titulo",
  definition: "definición",
  related_terms: "términos_relacionados",
};

/**
 * Serialises glossary terms to a CSV string suitable for glossary.csv.
 *
 * Output structure mirrors serializeObjectsCsv (SSOT alignment):
 *   Line 1: English header row (column names)
 *   Line 2: Spanish bilingual row
 *   Lines 3+: Comment/instruction rows (preserved from existing CSV)
 *   Remaining: Data rows (one per term)
 *
 * Built via Papa.unparse, which quotes only fields that need it per RFC 4180.
 * This avoids the latent corruption of the prior hand-built concat, which left
 * `term_id` unquoted — a term_id containing a comma or quote broke the row.
 * Output uses LF line endings.
 *
 * @param terms Glossary terms to serialise
 * @param existingCsv Optional existing CSV content — comment rows are extracted
 *                    and preserved in the output
 */
export function serializeGlossaryCsv(
  terms: Array<{
    term_id: string;
    title: string | null;
    definition: string | null;
    related_terms: string | null;
  }>,
  existingCsv?: string,
): string {
  const columns = GLOSSARY_CSV_COLUMNS as unknown as string[];
  const normalise = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Header line only (PapaParse always adds a header when unparsing objects)
  const headerCsv = normalise(Papa.unparse([{}], { columns })).split("\n")[0];

  // Spanish bilingual second row. These are framework-recognised header tokens
  // (KNOWN_BILINGUAL_VALUES), so a re-import skips this row via isHeaderRow
  // rather than ingesting it as a phantom term. related_terms ->
  // términos_relacionados.
  const bilingualRow = normalise(
    Papa.unparse(
      [GLOSSARY_CSV_COLUMNS.map((col) => GLOSSARY_BILINGUAL_ROW[col] ?? col)],
      { header: false },
    ),
  );

  // Preserve comment rows from existing CSV
  const commentRows = existingCsv ? extractCommentRows(existingCsv) : [];

  const dataRows = terms.map((t) => ({
    term_id: t.term_id,
    title: t.title ?? "",
    definition: t.definition ?? "",
    related_terms: t.related_terms ?? "",
  }));
  const dataCsv = normalise(Papa.unparse(dataRows, { columns }))
    .split("\n")
    .slice(1)
    .join("\n");

  return [headerCsv, bilingualRow, ...commentRows, dataCsv].join("\n") + "\n";
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
  // Normalize CR/CRLF to LF first so no raw carriage return can survive into
  // the double-quoted scalar. extractConfigFields reads values back with a
  // line regex whose `.` excludes \r, so a bare CR would truncate the value
  // on round-trip; normalizing here removes that hazard for every field.
  return `"${val
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

export function serializePageMarkdown(title: string, body: string): string {
  return `---\ntitle: ${yamlQuote(title)}\n---\n\n${body}\n`;
}

/**
 * First-publish path: builds index.md frontmatter + body from the project_landing
 * row when the file does not yet exist on the repo.
 *
 * Defensive gates: the four frontmatter heading/intro fields and the
 * welcome body each guard against re-emitting verbatim v1.2.1 English defaults
 * that survived the upgrade-time D1 cleanup —
 * for sites that bypass the compositor's upgrade flow. Sync `===` and
 * sync `normalizeBody` only (no async cascade through publish).
 *
 * Exported so tests/publish.server.test.ts can exercise the gates directly.
 */
export function buildIndexMd(
  landing: {
    stories_heading: string | null;
    stories_intro: string | null;
    objects_heading: string | null;
    objects_intro: string | null;
    welcome_body: string | null;
  },
): string {
  const lines: string[] = [];
  if (
    landing.stories_heading &&
    landing.stories_heading !== V121_FRONTMATTER_DEFAULTS.stories_heading
  )
    lines.push(`stories_heading: ${yamlQuote(landing.stories_heading)}`);
  if (landing.stories_intro) lines.push(`stories_intro: ${yamlQuote(landing.stories_intro)}`);
  if (
    landing.objects_heading &&
    landing.objects_heading !== V121_FRONTMATTER_DEFAULTS.objects_heading
  )
    lines.push(`objects_heading: ${yamlQuote(landing.objects_heading)}`);
  if (
    landing.objects_intro &&
    landing.objects_intro !== V121_FRONTMATTER_DEFAULTS.objects_intro
  )
    lines.push(`objects_intro: ${yamlQuote(landing.objects_intro)}`);

  const frontmatter = lines.length > 0 ? `---\n${lines.join("\n")}\n---\n\n` : "";
  // Drop welcome_body when it equals the v1.2.1 default. First-publish
  // path has no parsed-body fallback, so emit empty string.
  const useLandingBody =
    landing.welcome_body !== null &&
    landing.welcome_body !== undefined &&
    normalizeBody(landing.welcome_body) !== normalizeBody(V121_BODIES.index);
  const body = useLandingBody ? landing.welcome_body! : "";
  return `${frontmatter}${body}`;
}

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
 * @version v1.5.0-beta
 */

import { glossarySheetOrder } from "~/lib/glossary-order.server";
import { isParkingKey } from "~/lib/parking-key";
import { opensKeptTerm, sharedGlossaryAddresses } from "~/lib/glossary-addresses";
import Papa from "papaparse";
import {
  GLOSSARY_COLUMN_ALIASES,
  GLOSSARY_CSV_COLUMNS,
  PROJECT_CSV_COLUMNS,
  STORY_CSV_COLUMNS,
  foldHeader,
  pythonStrip,
} from "~/lib/column-mapping";
import {
  canonicalExtraColumns,
  collectExtraColumns,
  csvDataRow,
  extraColumnUnion,
  isReservedColumnName,
  parseExtraColumns,
  reservedColumnsIn,
} from "~/lib/extra-columns.server";
import { and, eq, max } from "drizzle-orm";
import { objectsSheetOrder } from "~/lib/objects.server";
import { getDb } from "~/lib/db.server";
import { getFileAtRef, getFileContent, getSubtreeOids, listSubtreeEntries } from "~/lib/github.server";
import type { FileAtRef } from "~/lib/github.server";
import { siteSheetFileAt, writtenSheetPath, type SiteSheetRole } from "~/lib/site-sheets.server";
import { ObjectsCommitUnready } from "~/lib/pending-object-ops.server";
import { parseYaml } from "~/lib/yaml.server";
import {
  capturedFrontmatter,
  fenceFrontmatter,
  frontmatterLineEnding,
  writePageFrontmatter,
} from "~/lib/page-frontmatter.server";
import type { FrontmatterWrite } from "~/lib/page-frontmatter.server";
import { createEngine } from "knap";
import type { FilterRegistry, RenderLimits } from "knap";
import { escapeYamlString, filtersWithYamlString } from "~/lib/knap-filters.server";
import { slugify } from "~/lib/slugify";
import { derivedHeadingOf } from "~/lib/panel-heading";
import {
  CsvCommentExtractionError,
  OBJECTS_CSV_COLUMNS,
  commentRecordsOf,
  extractCommentRows,
  objectsExtraColumnKeys,
  readCsvForComments,
  serializeObjectsCsv,
} from "~/lib/csv-export.server";
import { fileStoryLayout, plainStoryLayout } from "~/lib/story-csv-layout.server";
import {
  cellOf,
  chosenSheetLayout,
  fileSheetLayout,
  plainSheetLayout,
} from "~/lib/sheet-csv-layout.server";
import type { SheetCsvLayout } from "~/lib/sheet-csv-layout.server";
import {
  FRAMEWORK_GLOSSARY_COLUMN_RENAMES,
  FRAMEWORK_GLOSSARY_READER,
  FRAMEWORK_OBJECTS_READER,
  GLOSSARY_CANONICAL_SCOPE,
  FRAMEWORK_STORIES_READER,
  collidingHeaderGroups,
  createCsvRecordSkipDetector,
  csvSheetFor,
  importedColumnNames,
  instructionHeaderOf,
  misreadHeadingsIn,
  parseTelarCsv,
  projectCsvStoryRows,
  type CsvSheetKind,
  type FrameworkSheetReader,
} from "~/lib/import.server";
import type { CsvSourceReading, CsvSourceRow } from "~/lib/csv-record-scan.server";
import { cleanCommitContent } from "~/lib/commit.server";
import { gitBlobSha } from "~/lib/story-files.server";
import { sha256Hex } from "~/lib/story-canonical";
import { isFullyEmptyStep, isPanel, layerBody, type StepContent } from "~/lib/story-rows";
import type { CommitFile, ConditionalDeletion } from "~/lib/commit.server";
import type { SheetWarning } from "~/lib/sheet-warnings";
import { buildYmlRunsEncryptStep } from "~/lib/build-workflow.server";
import { sanitiseInlineHtml } from "~/lib/sanitise-html";
import { answerChecks, storyNameOf } from "~/lib/answer-checks.server";
import { keptGlossaryTerms } from "~/lib/glossary-links";
import { mutateYamlBlock, findYamlBlockRegions, isBlankOrComment } from "~/lib/config-yaml-block.server";
import {
  canonicalKindsJson,
  parseStoredGlossaryKinds,
  repoGlossaryKindsJson,
  writeGlossaryKinds,
} from "~/lib/glossary-kinds-yaml.server";
import { isCommentCell, isHeldTermId } from "~/lib/csv-records";
import { siteAddressOfPage } from "~/lib/jekyll-slug";
import { storyIdRefusal } from "~/lib/story-id";
import {
  V121_BODIES,
  V121_FRONTMATTER_DEFAULTS,
  normalizeBody,
  splitWelcomeLiquidBlock,
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
  /**
   * The object_id values in the order objects.csv is written (sheet order);
   * empty string when there are no objects. Absent from a snapshot written
   * before the order was hashed, which reads as unchanged: without that, every
   * site would show an unpublished change after the release.
   */
  objectOrder: string;
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
  /** Whether objects.csv's row order differs from the one last published (`EntityHashes.objectOrder`). */
  objectOrder: { changed: boolean };
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
  /**
   * Interpolation values for the item's string. A number is carried as a
   * number, not as its digits: i18next turns plural handling OFF for a `count`
   * that arrives as a string, so a `_one`/`_other` pair would fall through to
   * a key that does not exist.
   *
   * An array carries KEYS, not words — the kinds of formatting an answer uses.
   * Naming them is the renderer's job, because the names are locale strings
   * and this runs on the server against no locale.
   */
  params?: Record<string, string | number | string[]>;
  /**
   * The kept story columns this item can be cleared by removing, for the
   * control the publish page offers beside a story column blocker. `columns`
   * are the extras keys verbatim, as the step maps hold them.
   */
  removable?: RemovableColumns;
  /**
   * On a `page_frontmatter_replaced` warning: the page it is about and a
   * fingerprint of the stored block the publish replaces
   * (`withReplacedSettings`). A publish acknowledges the warning by naming
   * both, so a page given the slug since, or a block changed since, is not
   * acknowledged by it.
   */
  replacedSettings?: ReplacedSettings;
  /**
   * On a `sheet_warning` item: what a sheet on GitHub is warned about, which
   * the page writes from `common:sheet_warnings.*` as the import's review does.
   */
  sheetWarning?: SheetWarning;
}

/** A page's stored settings block, as a publish that replaces it names it. */
export interface ReplacedSettings {
  pageId: number;
  fingerprint: string;
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

export { PROJECT_CSV_COLUMNS };

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
  /** JSON passthrough blob of custom columns not mapped to first-class fields. */
  extra_columns?: string | null;
}

/**
 * The custom-column keys a project.csv carries, in sorted-union order, less
 * any that folds onto a fixed column: written, it would put one header in the
 * file twice.
 */
export function projectExtraColumnKeys(parsedRows: Array<Record<string, string>>): string[] {
  const fixedFolded = new Set<string>(PROJECT_CSV_COLUMNS.map(foldHeader));
  return extraColumnUnion(parsedRows).filter((key) => !fixedFolded.has(foldHeader(key)));
}

/** Normalises PapaParse output to LF-only line endings */
const normalise = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/**
 * The layout of `existingCsv` (sheet-csv-layout.server.ts), or null when it
 * has no header record or Papa refused it. A file whose rows cannot be matched
 * to their characters throws `CsvCommentExtractionError`.
 */
export function fileProjectLayout(existingCsv: string, keptKeys: readonly string[] = []): SheetCsvLayout | null {
  const reading = readCsvForComments(existingCsv);
  return fileSheetLayout(csvSheetFor("project"), reading, commentRecordsOf(reading, true), keptKeys);
}

/**
 * Serialises D1 story rows to the Telar project.csv format.
 *
 * Output structure:
 *   Line 1: header row
 *   Line 2: Spanish bilingual row
 *   Lines 3+: Comment/instruction rows (preserved from existing CSV)
 *   Remaining: Data rows, sorted by order ascending, draft stories omitted
 *
 * With an existing file, in that file's own layout (`fileProjectLayout`).
 * Without one, or where `chosenSheetLayout` refuses the file's layout, the
 * fixed columns with the file's comment rows as `extractCommentRows` reads
 * them.
 *
 * private: true → "yes"; false → ""
 */
export function serializeProjectCsv(storyRows: StoryRow[], existingCsv?: string | null): string {
  // Filter out drafts, sort by order
  const written = storyRows.filter((s) => !s.draft).sort((a, b) => a.order - b.order);

  // Custom columns of the stories written: parsed once per row, then the keys
  // the file carries. A story with no value for a key writes an empty cell.
  const allParsed = written.map((s) => parseExtraColumns(s.extra_columns));
  const extraKeys = projectExtraColumnKeys(allParsed);

  // Built column by column on a null-prototype record, never a spread of the
  // parsed extras over the fixed fields (see `serializeGlossaryCsv`).
  const dataRows = written.map((s, i) => {
    const fields: Record<string, string> = Object.create(null);
    fields.order = String(s.order);
    fields.story_id = s.story_id;
    fields.title = s.title ?? "";
    fields.subtitle = s.subtitle ?? "";
    fields.byline = s.byline ?? "";
    fields.private = s.private ? "yes" : "";
    // show_sections — same boolean -> "yes" | "" convention as private
    fields.show_sections = s.show_sections ? "yes" : "";
    for (const key of extraKeys) fields[key] = allParsed[i][key] ?? "";
    return csvDataRow(fields);
  });

  const layout = chosenSheetLayout(
    "project.csv",
    existingCsv ? fileProjectLayout(existingCsv, extraKeys) : null,
    () => plainSheetLayout(PROJECT_CSV_COLUMNS, extraKeys, existingCsv ? extractCommentRows(existingCsv) : []),
    PROJECT_CSV_COLUMNS,
    extraKeys,
    dataRows,
  );

  const headerCsv = normalise(Papa.unparse([layout.columns.map((c) => c.header)], { header: false }));

  // Bilingual row — Spanish column name equivalents required by Telar's CSV
  // parser, by the fixed column's name whatever header the file gives it. A
  // custom column gets an EMPTY cell: the detectors leave empty cells out of
  // their known-bilingual ratio, so the row is still read as a header however
  // many custom columns there are.
  const bilingualRow = normalise(
    Papa.unparse(
      [layout.columns.map((c) => (c.source.kind === "fixed" ? (PROJECT_BILINGUAL_ROW[c.source.name] ?? "") : ""))],
      { header: false },
    ),
  );

  const dataCsv = normalise(
    Papa.unparse(
      dataRows.map((row) => layout.columns.map((c) => cellOf(c.source, row))),
      { header: false },
    ),
  );

  return [headerCsv, bilingualRow, ...layout.commentRows, dataCsv].join("\n");
}

// ---------------------------------------------------------------------------
// Story CSV serialiser
// ---------------------------------------------------------------------------

export { STORY_CSV_COLUMNS };

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
  /**
   * JSON object of the step's cells in story CSV columns the Compositor does
   * not map (see `mapStoryCsv`). Written back after the fixed columns.
   * Optional because a caller with no kept columns has nothing to pass; an
   * absent, empty or corrupt blob contributes no cells.
   */
  extra_columns?: string | null;
  layers: LayerData[];
}

/**
 * Which of a step's layers are written, and the title each is written with.
 *
 * A layer is written when it is a panel (`isPanel`), with its own title. The
 * one exception is a layer 1 that is not a panel under a layer 2 that is:
 * the site draws layer 2's button only inside layer 1's content
 * (panels.js:297), so without layer 1 layer 2 would be published and never
 * reached. That layer 1 is written with no body and, as its title, the
 * heading the site would show for it (`derivedHeadingOf`: its button label,
 * else the site language's default label), so the reader sees the heading
 * the site would have shown anyway. The import reads such a title back as no
 * title (`mapStoryCsv`), so a round trip stores nothing the author did not.
 */
function writtenLayers(
  layer1: LayerData | null,
  layer2: LayerData | null,
  siteLang: string,
): { layer1: { title: string | null } | null; layer2: { title: string | null } | null } {
  const layer2Written = isPanel(layer2);
  const layer1Written = isPanel(layer1) || (layer1 !== null && layer2Written);
  return {
    layer1: !layer1Written
      ? null
      : { title: isPanel(layer1) ? layer1!.title : derivedHeadingOf(1, layer1!.button_label, siteLang) },
    layer2: layer2Written ? { title: layer2!.title } : null,
  };
}

/** A step as publish orders it and decides whether to write it (`isFullyEmptyStep`). */
export type StepRowFields = Pick<StepWithLayers, "step_number" | "kind"> & StepContent;

/**
 * The steps a story CSV writes, in step order: every step but the fully empty
 * ones. The publish check that names the columns a story CSV will carry reads
 * the same steps, so the two cannot disagree about which steps count.
 */
export function publishedSteps<T extends StepRowFields>(stepRows: readonly T[]): T[] {
  return [...stepRows].sort((a, b) => a.step_number - b.step_number).filter((s) => !isFullyEmptyStep(s));
}

/**
 * The kept columns a story CSV carries, in the order they first appear across
 * `parsedRows`, which the caller passes in published step order. First-seen
 * rather than sorted, because the import records each step's cells in the
 * order its file had them, and that is the order most likely to match the
 * file's own header.
 *
 * A key whose fold names a fixed column is left out: that column is already
 * written from its own field, and a second copy would be two columns the
 * framework reads as one.
 *
 * One function, because the publish check that predicts what the framework
 * will make of this file has to read the headers the file will have.
 */
export function storyExtraColumnKeys(parsedRows: Array<Record<string, string>>): string[] {
  const fixedFolded = new Set<string>(STORY_CSV_COLUMNS.map(foldHeader));
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const parsed of parsedRows) {
    for (const key of Object.keys(parsed)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (fixedFolded.has(foldHeader(key))) continue;
      keys.push(key);
    }
  }
  return keys;
}

/** Writes a step's own cells in the kept columns onto its published row. */
function addKeptCells(
  fields: Record<string, string>,
  extraKeys: readonly string[],
  parsed: Record<string, string>,
): void {
  for (const key of extraKeys) {
    if (Object.hasOwn(parsed, key)) fields[key] = String(parsed[key]);
  }
}

/**
 * A step's hash entry with its kept cells added, canonicalised, only when it
 * has some: a story with none hashes byte for byte as it does without the
 * field, so ENTITY_HASHES_VERSION need not move, and a bump would have idle
 * sites adopt new baselines silently.
 */
function withKeptCellsForHash(
  stepHash: Record<string, unknown>,
  raw: string | null,
): Record<string, unknown> {
  if (Object.keys(parseExtraColumns(raw)).length === 0) return stepHash;
  return { ...stepHash, extra_columns: canonicalExtraColumns(raw) };
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
  /** Layer body as written, cleaned and stripped; empty for a panel that is only a title. */
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
 * @param existingCsv Optional existing CSV, whose column layout and comment
 *   rows are written (`fileStoryLayout`) unless `chosenSheetLayout` refuses
 *   them for the plain layout
 * @param siteLang The site's `telar_language`, which names the default label
 *   a layer file's derived heading falls back to (`writtenLayers`); the
 *   Compositor's own default, English, when the site states none
 */
export function serializeStory(
  stepRows: StepWithLayers[],
  storySlug: string,
  existingCsv?: string,
  siteLang = "en",
): SerializedStory {
  // Sorted by step_number so editor reorder survives publish, without
  // mutating the caller's array.
  const nonEmptySteps = publishedSteps(stepRows);

  // Kept columns follow the fixed ones, in the order they first appear.
  const allParsed = nonEmptySteps.map((step) => parseExtraColumns(step.extra_columns));
  const extraKeys = storyExtraColumnKeys(allParsed);

  // Track used filenames per story to detect duplicates
  const usedFilenames = new Set<string>();

  // Layer files referenced by the CSV, collected in the SAME pass / SAME order
  // / SAME usedFilenames Set as the CSV cells below — guarantees the file the
  // publish loop writes matches the CSV's `layerN_content` reference.
  const layerFiles: StoryLayerFile[] = [];

  const fieldRows = nonEmptySteps.map((step, i) => {
    const layer1 = step.layers.find((l) => l.layer_number === 1) ?? null;
    const layer2 = step.layers.find((l) => l.layer_number === 2) ?? null;

    // Which layers are written, and with which titles (`writtenLayers`).
    const layer1Body = layerBody(layer1?.content);
    const layer2Body = layerBody(layer2?.content);
    const written = writtenLayers(layer1, layer2, siteLang);
    const layer1HasContent = written.layer1 !== null;
    const layer2HasContent = written.layer2 !== null;

    // Named from the title the file is written with, so a layer 1 written
    // with its derived heading is named as it is after an import reads that
    // heading as no title and the next publish derives it again.
    const layer1Filename = written.layer1
      ? layerFilename(storySlug, step.step_number, 1, written.layer1.title, usedFilenames)
      : "";
    const layer2Filename = written.layer2
      ? layerFilename(storySlug, step.step_number, 2, written.layer2.title, usedFilenames)
      : "";

    // Emit the layer file alongside the cell that references it, using the
    // filename just resolved. A non-empty body means the layer exists.
    if (written.layer1) {
      layerFiles.push({ filename: layer1Filename, title: written.layer1.title, content: layer1Body });
    }
    if (written.layer2) {
      layerFiles.push({ filename: layer2Filename, title: written.layer2.title, content: layer2Body });
    }

    // A step only has a positionable IIIF viewer when it's a media step with
    // an object. Section steps (heading cards) and object-less steps have no
    // viewer, so they must emit EMPTY coordinate cells rather than the
    // 0.5/0.5/1 defaults — otherwise phantom coords round-trip wrong and churn
    // the entity hash.
    // Decided on the object as the build and the import will read it, cleaned
    // then stripped (the same rule as `layerBody`): an id of only whitespace
    // or rejected characters is no object, and the row is read as a section
    // card, so it must not carry coordinates the parse would then drop.
    const hasViewer = step.kind !== "section" && layerBody(step.object_id) !== "";

    // Null-prototype, built field by field and never spread from the blob, for
    // the reasons `csvDataRow` gives: a kept column can be named `__proto__`
    // or `constructor`, and a step lacking it must publish an empty cell.
    const fields: Record<string, string> = Object.create(null);
    Object.assign(fields, {
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
    });
    addKeptCells(fields, extraKeys, allParsed[i]);
    return fields;
  });

  // The existing file's own layout when it has one the layout accepts,
  // otherwise the plain one. Chosen after the rows are built, because a row
  // whose first written cell reads as a comment rules the file's layout out.
  const layout = chosenSheetLayout(
    `story ${storySlug}`,
    existingCsv ? fileStoryLayout(existingCsv, STORY_CSV_COLUMNS, extraKeys) : null,
    () => plainStoryLayout(STORY_CSV_COLUMNS, extraKeys),
    STORY_CSV_COLUMNS,
    extraKeys,
    fieldRows,
  );

  // Unparsed as a complete record rather than cut at the first newline: a
  // kept column's header is the author's own text and may hold one.
  const headerCsv = normalise(Papa.unparse([layout.columns.map((c) => c.header)], { header: false }));

  // Bilingual row — Spanish column name equivalents required by Telar's CSV
  // parser. A kept or empty custom column gets an EMPTY cell, as in
  // serializeObjectsCsv: both header detectors leave empty cells out of their
  // known-bilingual ratio, so the row is still recognised however many custom
  // columns there are. The table is read only for the fixed columns: a custom
  // column can be named `constructor` or `__proto__`, which a plain lookup
  // answers from Object.prototype.
  const bilingualCells = layout.columns.map((c) =>
    c.source.kind === "fixed" ? STORY_BILINGUAL_ROW[c.source.name] : "",
  );
  const bilingualRow = normalise(Papa.unparse([bilingualCells], { header: false }));

  const dataRows = fieldRows.map((fields) => layout.columns.map((c) => cellOf(c.source, fields)));
  const dataCsv = normalise(Papa.unparse(dataRows, { header: false }));

  const csv = [headerCsv, bilingualRow, ...layout.commentRows, dataCsv].join("\n");

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
 * The rule that keeps names distinct: every name is checked against
 * usedFilenames before it is taken, the fallback included, and a name already
 * used gets the first free numeric suffix (`-2`, `-3`, ...) on the name it
 * would have had. Names are assigned in step order, so the same story always
 * gets the same names, and a story with no collision gets the names it had
 * before the suffix existed. Without the check, a fallback could take the
 * name a title had already claimed (a layer titled "step3 layer1"), and two
 * layers would publish to one file.
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
  const titleBased = title && title.trim() !== "" ? `${storySlug}-${slugify(title)}.md` : null;
  const wanted = titleBased !== null && !usedFilenames?.has(titleBased) ? titleBased : fallback;
  if (!usedFilenames) return wanted;
  let name = wanted;
  for (let suffix = 2; usedFilenames.has(name); suffix++) {
    name = `${wanted.slice(0, -".md".length)}-${suffix}.md`;
  }
  usedFilenames.add(name);
  return name;
}

// `\r?` so a CRLF line (split on `\n`, it keeps its `\r`) is read as the rule
// it is: the framework reads layer files with universal newlines.
const AMBIGUOUS_RULE_LINE = /^(?:-{3,}|={3,})[ \t]*\r?$/;

/**
 * Inserts a blank line before every `---`/`===` line that directly follows
 * non-blank text with no intervening blank line — the one shape markdown
 * reads as a setext-heading underline rather than a horizontal rule. A
 * setext underline must directly follow a paragraph line with no blank
 * line between them, so the inserted blank line is enough on its own to
 * make the rule parse as a rule; nothing needs to be added that would then
 * have to be stripped back out on import.
 *
 * A rule already separated by a blank line (or at the very start of the
 * content) is left untouched: the check is against the ORIGINAL previous
 * line, not the line this function may have just inserted, so re-running
 * it against its own output is a no-op — a body already carrying the
 * inserted blank line publishes unchanged on the next round.
 *
 * Operates only on the text handed to the file writer; the caller's stored
 * content is never touched.
 */
export function guardAmbiguousRuleLines(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const previousOriginalLine = i > 0 ? lines[i - 1] : "";
    if (AMBIGUOUS_RULE_LINE.test(lines[i]) && previousOriginalLine.trim() !== "") {
      // The blank line takes the line end of the text it follows, so a CRLF
      // body stays CRLF.
      out.push(previousOriginalLine.endsWith("\r") ? "\r" : "");
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Document rendering
// ---------------------------------------------------------------------------

/**
 * Limits for every document render, each set rather than inherited.
 *
 * knap's defaults suit a note-taking template that a person edits; these
 * documents are module constants rendered against author content of
 * unbounded size, so the two ceilings that touch content are raised and the
 * two that describe the template itself are lowered to what the constants
 * below actually need.
 *
 * A render that exceeds a limit throws — knap reports LIMIT_EXCEEDED and
 * `renderOrThrow` raises it — so a limit set too low fails the publish
 * rather than writing a truncated file. That is the reason `maxOutputLength`
 * and `maxValueLength` are set where they are: a layer body is whatever the
 * author pasted, and no upstream gate caps it.
 */
const DOCUMENT_RENDER_LIMITS: RenderLimits = {
  // The templates in this file are constants of a few dozen bytes. 8 KB
  // leaves room to edit them and still fails fast if a variable is ever
  // passed where a template is expected.
  maxTemplateLength: 8_192,
  // A Worker has 128 MB of memory and the whole file set is assembled in it
  // before the commit, so a single document approaching this size fails on
  // memory first. The limit is here to turn an absurd value into a named
  // error rather than an out-of-memory kill.
  maxOutputLength: 32 * 1024 * 1024,
  maxValueLength: 32 * 1024 * 1024,
  // Operations scale with the number of rendered nodes, and these templates
  // have a fixed handful each. A million bounds a runaway without being a
  // ceiling any real document approaches.
  maxOperations: 1_000_000,
  // Neither template nests at all; this leaves room for one that does.
  maxDepth: 20,
};

/**
 * Filters available to the document templates: the shared YAML string
 * escaper, plus `rule_guard` for the one transform knap has no equivalent
 * for. knap ships markdown filters, not a setext-underline guard, so
 * `guardAmbiguousRuleLines` stays a Telar-specific filter rather than being
 * expressed in template syntax.
 */
const documentFilters: FilterRegistry = {
  ...filtersWithYamlString,
  rule_guard: (value) => guardAmbiguousRuleLines(value),
};

/**
 * The module's single engine. Building one per call would re-validate the
 * filter registry on every file of every publish.
 *
 * `allowRegex` is off because no template here uses a regex-capable filter;
 * leaving it on would grant author content regex semantics it never needs.
 */
const documentEngine = createEngine({
  filters: documentFilters,
  limits: DOCUMENT_RENDER_LIMITS,
  allowRegex: false,
});

/**
 * What can and cannot be rendered through this engine.
 *
 * knap removes one leading `[\t ]*\r?\n?` at every block boundary — a
 * `{% if %}` or `{% for %}` loses it from the start of its own output, or
 * from whatever follows when the block renders nothing — and a `{% for %}`
 * removes one more from each iteration's result, putting a single newline
 * back between iterations. Measured against knap 0.4.2; `trimOutput` does
 * not affect it.
 *
 * A template producing indentation-sensitive YAML data therefore cannot be
 * written as the document reads. Making one byte-stable means padding it
 * with whitespace whose only purpose is to be eaten, which is why
 * `navigation.yml` and `index.md` are built as strings and not rendered
 * here.
 *
 * Of the two templates below, the layer file has no block at all and so no
 * dependency on any of this. The page markdown has one `{% for %}` over the
 * frontmatter map, and does depend on it in exactly one way: the loop body
 * starts with `\n`, which the per-iteration trim removes and the join puts
 * back between entries, so the opening `---\n` supplies the first line break
 * and the closing `\n---` the last. That holds only while the map is never
 * empty — it always carries `title` — because an empty loop would move its
 * toll onto the closing fence. Adding a key is safe; removing
 * `title` is not.
 */

/** Layer markdown: a frontmatter block and the guarded body. */
const LAYER_FILE_TEMPLATE = "---\ntitle: {{ title | yaml_string }}\n---\n\n{{ content | rule_guard }}";

/**
 * Produces the content of a layer markdown file.
 *
 * Always emits a frontmatter block, titled or not: an untitled layer gets
 * `title: ""`, which the framework resolves to the same empty title as a
 * file with no frontmatter at all. Writing the block unconditionally is
 * what lets a lazy frontmatter match anchor on its own non-empty title line
 * instead of merging with a leading `---` the author put in the body.
 *
 * `rule_guard` runs on the body so a rule that would otherwise pair with the
 * preceding line into a setext heading survives as a rule.
 */
export async function layerFileContent(
  title: string | null | undefined,
  content: string,
): Promise<string> {
  return documentEngine.renderOrThrow(LAYER_FILE_TEMPLATE, {
    variables: { title: title ?? "", content },
  });
}

// ---------------------------------------------------------------------------
// Config mutation
// ---------------------------------------------------------------------------

/**
 * Known top-level keys of the canonical Telar template `_config.yml`
 * (ucsb-amplab/telar — verified stable across framework versions), plus every
 * block this publish writes. Used as the sweep boundary so a description
 * paragraph that happens to start with a lowercase `word:` (e.g. "usage: …")
 * is treated as prose and swept, while a real key (`url:`, `plugins:`) stops
 * the sweep. Far more robust than matching any `key:`-shaped line.
 *
 * A block the Compositor writes has to be here whether or not the template
 * carries it yet, because a top-level line the sweep does not recognise is
 * swept as prose. `story_content:` is here for the same reason and no longer
 * for its own: the Compositor stopped writing it, and a site whose file
 * already carries the block keeps it only while the sweep stops at the key.
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
  "story_content",
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
  "glossary",
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
 * `story_key` is a top-level scalar, which is the only place the framework has
 * read it from since v0.8.0-beta. A `protected:` block, where a repo has one,
 * is not a story_key location and is passed through untouched.
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
  yaml = mutateYamlBlock(yaml, "telar", (line) => {
    if (/^\s+version:\s*['"]?v/.test(line)) {
      return line.replace(/(version:\s*['"]?)v/, "$1");
    }
    return null;
  });

  const lines = yaml.split("\n");
  const result: string[] = [];
  const fieldsToAppend = new Set(Object.keys(fields));

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

    // Handle top-level story_key. The first occurrence takes the value and any
    // later one is dropped, so a file that accumulated duplicates comes back
    // with one line.
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
    appended.push(`${key}: ${fields[key]}`);
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
/**
 * The top-level blocks this publish writes. `buildConfigManagedBlocks` emits
 * exactly these, and the pre-publish check reads the file for the shapes it
 * could not write among them.
 */
export const MANAGED_CONFIG_BLOCKS = [
  "story_interface",
  "collection_interface",
  "development-features",
] as const;

/**
 * What a managed block's header line may carry and still be editable.
 *
 * The writer works line by line: it rewrites the indented children under a
 * bare `key:` header. Everything else on that line puts the mapping somewhere
 * those lines are not — a flow mapping holds its keys on the header itself and
 * may run over several lines, an alias puts them in another node entirely, an
 * anchor or a tag changes what the node IS. A line writer that edited one
 * anyway would drop unmanaged keys, turn a number into a string, or write a
 * value the site reads from elsewhere; each of those has been observed.
 *
 * Empty is the ordinary block header. A comment after the colon is still one.
 */
export function isWritableBlockHeader(afterColon: string): boolean {
  const rest = afterColon.trim();
  return rest === "" || rest.startsWith("#");
}

/**
 * One direct child of a managed block: `key: value` with an optional trailing
 * comment, the key optionally spaced before its colon.
 *
 * ONE definition, read by the block reader below and by nothing else, so the
 * pre-check, the writer and the duplicate detection cannot disagree about what
 * a key is. They did: a rule that required the colon to touch the key left
 * `answer_word_limit : 60` unrecognised, while js-yaml and Psych both read it
 * as the key — so the publish rewrote an earlier duplicate and the site kept
 * reading the later one.
 *
 * `<<` is a key here: a merge brings values in from elsewhere, and a direct
 * child written beside it shadows them, which is the value the site reads. A
 * quoted key is NOT, deliberately — and because every line of a block is now
 * read, one no longer hides beside a key that is recognised. A line with no
 * space after the colon is not a mapping entry at all (`a:b` is the scalar
 * "a:b"), and is not one here.
 */
const CHILD_ENTRY = /^([ \t]*)([A-Za-z0-9_-]+|<<)[ \t]*:([ \t].*|)$/;

/**
 * Indicators a plain scalar cannot begin with, in YAML's own words.
 *
 * `-` only when what follows is not a digit: `- x` is a sequence item, while
 * `-1` is a number, and refusing that refused a value the writer can read.
 */
const YAML_INDICATOR = /^(?:[|>{}[\]!&*?:,%@`]|-(?![0-9]))/;

/** One child line of a block, taken apart. */
interface BlockChild {
  /** Index of the key's line within the file. */
  at: number;
  /** The line's own indentation, which fixes the block's. */
  indent: string;
  key: string;
  /** The value as written, without its comment. Empty when the line has none. */
  value: string;
  /** The trailing comment WITH the whitespace that stood before it, or "". */
  comment: string;
}

/** Where one line of a block's region stands in relation to its children. */
type LinePlace = "ignored" | "child" | "deeper" | "outside";

/**
 * Where `line` stands, given the indentation the block's children have settled
 * on — `null` while the first content line is still to come, which is the line
 * that settles it.
 */
function placeOf(line: string, childIndent: string | null): LinePlace {
  if (isBlankOrComment(line)) return "ignored";
  if (childIndent === null) return "child";
  const indent = indentOf(line).length;
  if (indent > childIndent.length) return "deeper";
  return indent < childIndent.length ? "outside" : "child";
}

/**
 * `line` as a child of the block, or null when the reader cannot read it.
 *
 * A tab in the indentation is refused: YAML forbids one there outright, so a
 * block indented with a tab is a block no parser reads — and the writer, which
 * reuses the indentation it found, would write the same unreadable line back.
 */
function childFrom(line: string, at: number, managed: readonly string[]): BlockChild | null {
  const entry = line.match(CHILD_ENTRY);
  if (!entry || entry[1].includes("\t")) return null;
  const [, indent, key, rest] = entry;
  const read = managed.includes(key) ? readManagedValue(rest) : { value: "", comment: "" };
  return read === null ? null : { at, indent, key, value: read.value, comment: read.comment };
}

/** `line`'s leading whitespace. */
function indentOf(line: string): string {
  return line.match(/^[ \t]*/)![0];
}

/**
 * A managed child's value and trailing comment, or null when the value is not
 * one this writer may replace.
 *
 * The writer rebuilds the line, so it has to know exactly where the value ends
 * — and in YAML that is not a question a line can always answer. A `#` opens a
 * comment only after whitespace, so `a#c` is the scalar "a#c" and rewriting
 * around it published `75#c`, a string. Inside quotes a `#` is never a
 * comment, and a quoted scalar need not even end on the line it starts.
 *
 * So a managed value is a plain unquoted scalar with no `#` in it, or nothing
 * at all, optionally followed by whitespace and a comment. Every value this
 * publish writes is `true`, `false` or a decimal integer, so nothing the
 * Compositor itself emits is refused here, and what an author has written by
 * hand in another shape is reported rather than mangled.
 */
function readManagedValue(rest: string): { value: string; comment: string } | null {
  const body = rest.trimStart();
  if (body === "") return { value: "", comment: "" };
  const separator = rest.slice(0, rest.length - body.length);
  if (body.startsWith("#")) return { value: "", comment: separator + body };
  // The comment carries the WHOLE whitespace run that stood before it, not the
  // single space the search matched: rebuilding the line without it moved a
  // comment an author had aligned.
  const hash = body.search(/[ \t]#/);
  const value = (hash === -1 ? body : body.slice(0, hash)).trimEnd();
  const comment = hash === -1 ? "" : body.slice(value.length);
  if (/["'#]/.test(value) || YAML_INDICATOR.test(value)) return null;
  return { value, comment };
}

/**
 * The managed keys each block carries, for a check that runs before a publish
 * has a `project_config` row in hand.
 *
 * `buildConfigManagedBlocks` writes these and no others; a test pins the two
 * against each other, because a key added there and not here would be written
 * into a shape this check never judged. Every key is judged whether or not a
 * given publish writes it: a column that is null today is written by the next
 * save, and an author reading the file sees the same key either way.
 */
export const MANAGED_BLOCK_FIELDS: Record<string, readonly string[]> = {
  story_interface: [
    "show_on_homepage",
    "show_story_steps",
    "show_object_credits",
    "include_demo_content",
  ],
  collection_interface: [
    "browse_and_search",
    "show_link_on_homepage",
    "show_sample_on_homepage",
    "featured_count",
  ],
  "development-features": ["skip_stories"],
};

/**
 * A managed block's children, or null when the reader cannot account for every
 * line of it.
 *
 * The one reader, used by the pre-check and by the writer. Accounting for
 * EVERY line is the rule, because every line left unread has been a way to
 * publish a value nobody chose: a quoted duplicate key sitting unseen beside a
 * recognised one, a second copy at another indentation that makes the whole
 * file unparseable, a quoted scalar carrying on past its line.
 *
 * The region's child indentation is the first content line's, and that line
 * must be a child entry. After it, a line at that indentation must be a child
 * entry too; a deeper line belongs to the child above it; a SHALLOWER line
 * belongs to nothing, since the block's own indentation is already fixed.
 * Comments and blank lines belong to nobody and are stepped over wherever they
 * sit. An unmanaged child may own deeper lines of any kind — the writer copies
 * its lines and never reads its value — while a managed child must be a plain
 * scalar on its own line.
 */
function readBlockChildren(
  lines: string[],
  blockKey: string,
  region: { headerIdx: number; regionEnd: number },
): BlockChild[] | null {
  const managed = Object.hasOwn(MANAGED_BLOCK_FIELDS, blockKey) ? MANAGED_BLOCK_FIELDS[blockKey] : [];
  const children: BlockChild[] = [];
  let childIndent: string | null = null;
  for (let i = region.headerIdx + 1; i < region.regionEnd; i++) {
    const place = placeOf(lines[i], childIndent);
    if (place === "ignored") continue;
    if (place === "outside") return null;
    if (place === "deeper") {
      const owner = children[children.length - 1];
      // A deeper line is the value of the child above it. An unmanaged child
      // may have one — the writer copies its lines without reading them — and
      // a managed one may not, because the writer replaces its line.
      if (!owner || managed.includes(owner.key)) return null;
      continue;
    }
    const child = childFrom(lines[i], i, managed);
    if (child === null) return null;
    childIndent = child.indent;
    children.push(child);
  }
  return children;
}

/** The first line inside a block's region that carries a value, if any. */
function firstBlockValueLine(
  lines: string[],
  region: { headerIdx: number; regionEnd: number },
): string | undefined {
  for (let i = region.headerIdx + 1; i < region.regionEnd; i++) {
    if (!isBlankOrComment(lines[i])) return lines[i];
  }
  return undefined;
}

/**
 * Whether the writer can edit one occurrence of a managed block.
 *
 * The header first: one carrying a flow mapping, an anchor, an alias or a tag
 * puts the mapping where this writer's lines are not. Then the block itself,
 * every line of it, through the one reader — an empty block is writable, since
 * there is nothing to misread and the writer creates the children.
 */
function isWritableBlock(
  lines: string[],
  blockKey: string,
  region: { headerIdx: number; regionEnd: number },
): boolean {
  if (!isWritableBlockHeader(lines[region.headerIdx].slice(blockKey.length + 1))) return false;
  if (firstBlockValueLine(lines, region) === undefined) return true;
  return readBlockChildren(lines, blockKey, region) !== null;
}

/**
 * The LAST occurrence of `blockKey` in `lines` — which is the one every reader
 * of the file takes and the one the writer would edit — or undefined when the
 * file has no such block, in which case there is nothing to refuse and the
 * writer appends a fresh one.
 */
function lastBlockRegion(lines: string[], blockKey: string) {
  const regions = findYamlBlockRegions(lines, blockKey);
  return regions[regions.length - 1];
}

/**
 * The managed blocks in `yaml` the writer cannot edit, named as the file
 * names them.
 *
 * Read before a publish rather than discovered during one: the writer's answer
 * to a block like this is to refuse, and an author told at the check can fix
 * the file instead of watching a publish fail.
 */
export function unwritableConfigBlocks(yaml: string, blockKeys: readonly string[]): string[] {
  const lines = yaml.split(/\r?\n/);
  return blockKeys.filter((key) => {
    const region = lastBlockRegion(lines, key);
    return region !== undefined && !isWritableBlock(lines, key, region);
  });
}

/** Raised by the writer for a managed block it cannot edit. */
export class UnwritableConfigBlockError extends Error {
  constructor(readonly block: string) {
    super(`_config.yml block "${block}" is not written as an indented block mapping`);
    this.name = "UnwritableConfigBlockError";
  }
}

/**
 * `lines` with `fields` written into one existing occurrence of a block.
 *
 * A block this writer cannot edit throws rather than being skipped. Skipping
 * it silently commits every other file beside a _config.yml whose managed
 * settings disagree with the Compositor's, and says so to nobody; the publish
 * check raises `config_block_unwritable` for the same shape — through this
 * same reader — before a publish starts, so a publish that still reaches here
 * is one whose file changed under it, and failing is the honest answer.
 *
 * A key being written that appears more than once among the children has its
 * LAST occurrence rewritten and the earlier ones removed: YAML reads the last
 * of two duplicate keys, so the earlier ones are lines no reader of this file
 * acts on, and leaving them would leave the published value behind the one
 * this writer just wrote.
 *
 * Whatever is not a key being written — comments, blank lines, unmanaged keys,
 * every line of THEIR values, and managed keys this publish has no value for —
 * comes through exactly as it was found.
 */
function writeFieldsIntoBlock(
  lines: string[],
  blockKey: string,
  fields: Record<string, string>,
  region: { headerIdx: number; regionEnd: number; childIndent: string },
): string[] {
  const { headerIdx, regionEnd, childIndent } = region;
  if (!isWritableBlockHeader(lines[headerIdx].slice(blockKey.length + 1))) {
    throw new UnwritableConfigBlockError(blockKey);
  }
  const children = readBlockChildren(lines, blockKey, region);
  if (children === null) throw new UnwritableConfigBlockError(blockKey);

  // A Map, because the keys come from the FILE. Asking a plain object whether
  // it has a key reaches `Object.prototype`, so a child an author named
  // `constructor` looked like a field to write and was published as the
  // constructor's own source text.
  const writing = new Map(Object.entries(fields));
  const written = children.filter((child) => writing.has(child.key));
  const authoritative = new Map<string, number>();
  for (const child of written) authoritative.set(child.key, child.at);
  const byLine = new Map(written.map((child) => [child.at, child]));

  const body: string[] = [];
  for (let i = headerIdx + 1; i < regionEnd; i++) {
    const child = byLine.get(i);
    if (!child) {
      body.push(lines[i]);
      continue;
    }
    if (authoritative.get(child.key) !== i) continue;
    body.push(`${childIndent}${child.key}: ${writing.get(child.key)}${child.comment}`);
  }

  let insertAt = body.length;
  while (insertAt > 0 && body[insertAt - 1].trim() === "") insertAt--;
  const missing = Object.entries(fields)
    .filter(([key]) => !authoritative.has(key))
    .map(([key, value]) => `${childIndent}${key}: ${value}`);
  body.splice(insertAt, 0, ...missing);

  return [...lines.slice(0, headerIdx + 1), ...body, ...lines.slice(regionEnd)];
}

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
    lines = writeFieldsIntoBlock(lines, blockKey, fields, regions[regions.length - 1]);
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

/**
 * The `_config.yml` a publish would commit for `config`, or null when it would
 * leave the repository's file exactly as it found it.
 *
 * One function because there are two askers and one answer. The publish asks it
 * for the content of the file it is about to commit; the pre-publish check asks
 * it whether there will be one, so an author is told before a publish rather
 * than after a silent skip. Asked separately, the two would answer the same
 * question two ways, and the check would refuse publishes the writer handles or
 * bless ones it drops — most of all for the orphaned multi-line scalars the
 * heal exists to repair, which do not parse as they stand and publish perfectly.
 *
 * Null means the healed result is still not valid YAML: a corruption shape
 * beyond the line-based heal, in keys this writer does not manage. Committing
 * it would break the site's build and overwriting it would discard settings
 * nobody chose to lose, so the publish writes no config at all.
 *
 * A managed block the writer cannot edit throws out of here, as it does out of
 * `healConfigYaml`: that is a different refusal, with `config_block_unwritable`
 * of its own, and a publish reaching it fails rather than skipping the write.
 */
export function publishableConfigYaml(
  existingYaml: string,
  config: typeof project_config.$inferSelect,
): string | null {
  const healed = healConfigYaml(
    existingYaml,
    buildConfigManagedFields(config),
    buildConfigManagedBlocks(config),
  );
  const written = withGlossaryKinds(healed, config.glossary_kinds_json);
  return isParseableYaml(written) ? written : null;
}

/**
 * `yaml` with the stored glossary kinds written in, or exactly as given when
 * the column is null: a project that never edited its kinds follows the
 * repository's file, and the publish must not touch it. A `glossary:` the
 * writer cannot edit throws, as an unwritable managed block does.
 */
function withGlossaryKinds(yaml: string, json: string | null | undefined): string {
  const kinds = parseStoredGlossaryKinds(json);
  if (kinds === null) return yaml;
  // A list the repository already holds is not written again: the file keeps
  // its own formatting and the publish claims no change to it.
  if (canonicalKindsJson(json) === repoGlossaryKindsJson(yaml)) return yaml;
  const written = writeGlossaryKinds(yaml, kinds);
  if (written === null) throw new UnwritableConfigBlockError("glossary");
  return written;
}

/** The blocker naming a managed block the writer cannot edit. */
function blockUnwritableBlocker(block: string): ValidationResult["blockers"][number] {
  return {
    code: "config_block_unwritable",
    message: "config_block_unwritable",
    entityId: block,
    params: { block },
  };
}

/**
 * What the repository's `_config.yml` stops a publish for: a managed block the
 * writer cannot edit, or a file whose publish would write no config at all.
 *
 * Both answers come from here because they come from one write. The block
 * check reads the file as it stands, which is where an author can see and fix
 * the shape; the parse check runs the write itself through
 * `publishableConfigYaml`, not a likeness of it, since the orphaned multi-line
 * scalars an older serializer left behind do not parse and heal perfectly, and
 * refusing those would refuse every publish that exists to repair them.
 *
 * Running the write means the write's refusals surface here too. The rescue
 * pass can strip a corrupt line and orphan the one below it inside a block,
 * which the block writer then cannot read whole — a shape the file did not have
 * before the heal touched it, so the block check cannot see it coming. That
 * throw names its block, and the author is told about that block: the publish
 * it would reach fails, and a refusal nothing explains is the defect this check
 * exists to end. Named twice it would say the same sentence twice, so a block
 * the file check already named is not named again.
 *
 * Nothing is said about a file or a config row the caller did not read.
 */
function configBlockers(
  configYml: string | null | undefined,
  config: typeof project_config.$inferSelect | null | undefined,
): ValidationResult["blockers"] {
  const named = unwritableConfigBlocks(configYml ?? "", MANAGED_CONFIG_BLOCKS);
  const blockers = named.map(blockUnwritableBlocker);

  if (!configYml || !config) return blockers;
  try {
    if (publishableConfigYaml(configYml, config) !== null) return blockers;
  } catch (err) {
    if (!(err instanceof UnwritableConfigBlockError)) throw err;
    if (!named.includes(err.block)) blockers.push(blockUnwritableBlocker(err.block));
    return blockers;
  }
  blockers.push({ code: "config_unparseable", message: "config_unparseable" });
  return blockers;
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
 * Managed keys that a stored `config_managed` may carry but no live config
 * produces. They are dropped from the key union in `computeChangeSummary`, so
 * a snapshot holding one reports no settings change rather than a difference
 * against `undefined` — a difference no author could act on, since the setting
 * has no presence in the product and no entry in the label mapping, and would
 * reach them as a raw dotted key.
 *
 * Entries here are permanent. A key must stay listed for as long as any stored
 * snapshot could still carry it, which is unbounded: a project that has not
 * published since the key was written still holds it. Dropping an entry
 * restores the phantom change for exactly those projects.
 *
 * This suppresses only the listed keys. An unlisted key that the current
 * version does not produce still surfaces as a change, because it means a
 * snapshot holds something this version does not understand.
 */
const RETIRED_MANAGED_KEYS: ReadonlySet<string> = new Set([
  "story_content.answer_word_limit",
]);

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
/**
 * Whether navigation and landing differ from the snapshot's. In back-compat
 * (no snapshot hashes, or hashes of another version), any non-empty current
 * hash is a change.
 */
function singleHashChanges(
  current: EntityHashes,
  snapshotHashes: EntityHashes | undefined,
  backCompat: boolean,
): { navigationChanged: boolean; landingChanged: boolean } {
  if (backCompat || snapshotHashes === undefined) {
    return { navigationChanged: current.navigation.length > 0, landingChanged: current.landing.length > 0 };
  }
  return {
    navigationChanged: current.navigation !== snapshotHashes.navigation,
    landingChanged: current.landing !== snapshotHashes.landing,
  };
}

/**
 * Whether objects were reordered since the snapshot: the ids both the
 * snapshot's sequence and the current one hold, in another relative order. An
 * object added or removed since changes the sequence without reordering
 * anything, and is its own change in the objects bucket. A snapshot with no
 * `objectOrder` (written before the order was hashed, or with no entity hashes
 * at all) reads as unchanged.
 */
function objectOrderDiffers(current: EntityHashes, snapshotHashes: Partial<EntityHashes> | undefined): boolean {
  const published = snapshotHashes?.objectOrder;
  if (published === undefined || published === current.objectOrder) return false;
  const before = objectIdSequence(published);
  const now = objectIdSequence(current.objectOrder);
  const both = new Set(before.filter((id) => now.includes(id)));
  const kept = (ids: string[]) => ids.filter((id) => both.has(id));
  return kept(before).join("\u0000") !== kept(now).join("\u0000");
}

/** The object_id sequence an `objectOrder` hash holds; none for an empty or unreadable one. */
function objectIdSequence(hash: string): string[] {
  try {
    const ids: unknown = hash === "" ? [] : JSON.parse(hash);
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

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
      // A first publish writes the order; there is no published one to reorder.
      objectOrder: { changed: false },
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
  const { navigationChanged, landingChanged } = singleHashChanges(currentState.entityHashes, snapshotEntityHashes, backCompat);

  const objectOrderChanged = objectOrderDiffers(currentState.entityHashes, snapshotEntityHashes);

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
  // Keys in RETIRED_MANAGED_KEYS are never valid `key` values: they are
  // dropped from the union before the comparison runs.
  const currentManaged = currentState.config
    ? buildConfigChangeFields(currentState.config)
    : {};
  const snapshotManaged = snapshot.config_managed ?? {};
  const changedKeys = new Set<string>(
    [...Object.keys(currentManaged), ...Object.keys(snapshotManaged)].filter(
      (key) => !RETIRED_MANAGED_KEYS.has(key),
    ),
  );
  const settingsChanged: ChangeSummary["settings"]["changed"] = [];
  for (const key of changedKeys) {
    if (currentManaged[key] !== snapshotManaged[key]) {
      // skip_stories publishes under the framework's `development-features:`
      // block, but its copy is named for the setting, not the block it happens
      // to live in — so it reports under the bare field name.
      const summaryKey =
        key === "telar_language"
          ? "lang"
          : key === "development-features.skip_stories"
            ? "skip_stories"
            : key;
      // For value-dependent keys (lang, collection_mode, skip_stories), thread
      // the post-change value as the label so downstream renderers can pick a
      // value-specific i18n string (e.g. change_language_to_es,
      // change_collection_mode_on). Booleans are stored as "true"/"false" but
      // mapped to "on"/"off" here to match the i18n key naming.
      let labelValue: string;
      if (key === "telar_language") {
        labelValue = currentManaged[key] ?? "";
      } else if (key === "collection_mode" || summaryKey === "skip_stories") {
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
    !objectOrderChanged &&
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
    objectOrder: { changed: objectOrderChanged },
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
   * Whether the story is marked private. Drives the two private-story
   * warnings, private_story_no_key and private_story_workflow_stale: a
   * published Telar >=1.6 site with a private story hard-fails its build when
   * the site-wide story key or the workflow's encryption step is missing (the
   * framework's encryption interlock).
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
  /**
   * The story the step belongs to, carried on the row so a blocker can name it:
   * a step number alone identifies nothing on a site with several stories.
   * Optional because the position warning predates it and names only the step.
   */
  story_id?: string | null;
  story_title?: string | null;
  /**
   * JSON passthrough blob of the step's kept story CSV cells (see
   * `mapStoryCsv`). Drives `story_reserved_column` and
   * `story_colliding_columns`: `serializeStory` writes every key back out as
   * a column of the story's CSV. Absent or corrupt blobs contribute nothing.
   */
  extra_columns?: string | null;
  /**
   * The step's kind, which with its content and layers decides whether the
   * story CSV writes it (`publishedSteps`). Optional because only the checks
   * on the columns a story CSV carries read it — the story column blockers and
   * the renamed-column warning; absent reads as a media step.
   */
  kind?: "media" | "section";
}

/** A step's layer as the story CSV writer judges it: a panel or not. */
export interface StepLayerForValidation {
  step_id: number;
  title: string | null;
  content: string | null;
}

/**
 * What a blocker's removal control takes out: `columns` from every row of
 * `table` (for steps, of the story `storyId` only). `rows[column]` is how
 * many rows hold a value in it, which the confirmation states.
 */
export interface RemovableColumns {
  table: "steps" | "objects" | "glossary";
  storyId?: string;
  columns: string[];
  rows: Record<string, number>;
}

/** How many of `blobs` hold a non-empty value under `column`. */
function rowsHolding(blobs: ReadonlyArray<string | null | undefined>, column: string): number {
  return blobs.filter((raw) => pythonStrip(String(parseExtraColumns(raw)[column] ?? "")) !== "").length;
}

export interface ObjectForValidation {
  object_id: string;
  title: string | null;
  /**
   * JSON passthrough blob of custom columns (see `mapObjectsCsv`). Drives the
   * `object_reserved_column` blocker: a key in here matching
   * `RESERVED_COLUMN_NAMES` (case-insensitively, trimmed) would be written
   * back into objects.csv at publish and refused by the framework's own
   * build. Optional because not every caller has it to hand;
   * absent or corrupt blobs simply contribute no reserved keys.
   */
  extra_columns?: string | null;
}

export interface PageForValidation {
  /** The page's row id, which `replacedSettings` names. */
  id?: number;
  slug: string | null;
  title: string | null;
  /**
   * The page's kept front matter, or its file's where a check carried it
   * forward. Absent or NULL is a block the check cannot see, and nothing is
   * judged.
   */
  frontmatter?: string | null;
}

/**
 * A blocker for each publishable page whose kept front matter no edit can
 * retitle without changing another key: the publish would stop at that page
 * rather than write it. `entityId` is the slug, which the reset control acts
 * on.
 */
function pageFrontmatterBlockers(pages: PageForValidation[]): ValidationItem[] {
  return pages
    .filter((page) => isPagePublishable(page) && !!page.frontmatter &&
      writePageFrontmatter(page.frontmatter, page.title ?? "", page.slug ?? "").kind === "unwritable")
    .map((page) => ({
      code: "page_frontmatter_unwritable",
      message: "page_frontmatter_unwritable",
      entityId: page.slug ?? "",
      params: { page: page.title ?? "" },
    }));
}

/**
 * Whether the publish writes this page with its title alone over a stored
 * block it cannot read as a mapping: a syntax error, an unknown tag, a list or
 * scalar root, a value its explicit tag cannot take (`writePageFrontmatter`'s
 * `title-alone`). The condition is the writer's, not the Pages screen's, so a
 * block the Pages screen reads as an ordinary page but the writer cannot read
 * counts too. An empty or absent block is written with its title alone as
 * well, but holds nothing to lose.
 */
export function replacesPageFrontmatter(page: PageForValidation): boolean {
  return isPagePublishable(page) && !!page.frontmatter &&
    writePageFrontmatter(page.frontmatter, page.title ?? "", page.slug ?? "").kind === "title-alone";
}

/**
 * A warning for each page whose unreadable settings the publish will replace
 * with its title alone (`replacesPageFrontmatter`). The publish goes ahead;
 * once it lands, the block it wrote is stored (`storeWrittenPageFrontmatter`).
 */
export function pageFrontmatterReplacedWarnings(pages: PageForValidation[]): ValidationItem[] {
  return pages.filter(replacesPageFrontmatter).map((page) => ({
    code: "page_frontmatter_replaced",
    message: "page_frontmatter_replaced",
    entityId: page.slug ?? "",
    params: { page: page.title ?? "" },
  }));
}

/** The key an acknowledgement is matched on: the page and its block's fingerprint together. */
export function replacedSettingsKey(settings: ReplacedSettings): string {
  return `${settings.pageId}:${settings.fingerprint}`;
}

/**
 * The warnings with `replacedSettings` set on each `page_frontmatter_replaced`
 * one, from the page among `pages` it names by slug (slugs are unique at any
 * one time, and the warnings were made from these pages). The fingerprint is
 * the SHA-256 of the stored block as the check read it. A page without an id
 * gets none, and so cannot be acknowledged.
 */
export async function withReplacedSettings(
  warnings: ValidationItem[],
  pages: readonly PageForValidation[],
): Promise<ValidationItem[]> {
  return Promise.all(warnings.map(async (warning) => {
    if (warning.code !== "page_frontmatter_replaced") return warning;
    const page = pages.find((p) => (p.slug ?? "") === warning.entityId);
    if (page?.id === undefined || !page.frontmatter) return warning;
    return { ...warning, replacedSettings: { pageId: page.id, fingerprint: await sha256Hex(page.frontmatter) } };
  }));
}

export interface GlossaryTermForValidation {
  term_id: string;
  /** Decides whether the row is a term, for `glossary_shared_address`. */
  title?: string | null;
  /**
   * JSON passthrough blob of custom columns (see `mapGlossaryCsv`). Drives the
   * `glossary_reserved_column` blocker, for the same reason
   * `ObjectForValidation.extra_columns` drives its object counterpart:
   * `serializeGlossaryCsv` writes every key in here back into glossary.csv as a
   * real column, and the framework's build refuses a sheet carrying one of
   * these. Absent or corrupt blobs contribute no reserved keys.
   */
  extra_columns?: string | null;
  /** The entry's kind, which the file writes as a column of its own. */
  kind?: string | null;
}

/**
 * The `build.yml` detector belongs to build-workflow.server.ts, beside the
 * repair that acts on it. It is re-exported here so the validator's callers
 * and tests can keep importing it from the module the validator lives in.
 */
export { buildYmlRunsEncryptStep };

/**
 * Names the stories the framework's encryption interlock will actually see:
 * private and not a draft. A draft is absent from the published stories index
 * (the orphans-are-drafts rule), so its private flag never reaches the
 * framework and cannot fail a build.
 *
 * Both private-story warnings name their stories through this one helper, so
 * the two lists can never disagree when they fire together. A story is named by
 * its title, falling back to `story_id` when it has none.
 */
function namePrivateNonDraftStories(stories: StoryForValidation[]): string[] {
  return stories
    .filter((s) => s.private && !s.draft)
    .map((s) => (s.title && s.title.trim() !== "" ? s.title.trim() : s.story_id));
}

/**
 * The warnings raised by the two prerequisites a Telar >=1.6 build imposes on a
 * private story: a site-wide story key, and a `build.yml` that runs the
 * encryption step. Both are advisory — the framework refuses the build, and
 * blocking here would hold every other publish behind a file the compositor
 * cannot always fix. Both can fire at once; that is two missing prerequisites,
 * not a duplicate.
 *
 * `buildWorkflow` carries the outcome of reading `.github/workflows/build.yml`
 * at the validated commit. `absent` warns, because the framework fails in that
 * state too. `error` and `undefined` are indeterminate — a read that failed and
 * a read never made are both silent.
 */
function privateStoryWarnings(
  stories: StoryForValidation[],
  storyKey: string | null | undefined,
  buildWorkflow: FileAtRef | undefined,
): ValidationResult["warnings"] {
  const warnings: ValidationResult["warnings"] = [];
  const names = namePrivateNonDraftStories(stories);
  if (names.length === 0) return warnings;
  const storyList = names.join(", ");

  const storyKeySet = storyKey != null && storyKey.trim() !== "";
  if (!storyKeySet) {
    warnings.push({
      code: "private_story_no_key",
      message: "private_story_no_key",
      params: { stories: storyList },
    });
  }

  const workflowStale =
    buildWorkflow?.status === "absent" ||
    (buildWorkflow?.status === "ok" && !buildYmlRunsEncryptStep(buildWorkflow.content));
  if (workflowStale) {
    warnings.push({
      code: "private_story_workflow_stale",
      message: "private_story_workflow_stale",
      params: { stories: storyList },
    });
  }

  return warnings;
}

/**
 * One blocker per reserved column found in a set of rows' `extra_columns`,
 * naming the row and the column verbatim. Shared by objects and glossary: the
 * two sheets have the same passthrough and the same framework reader, so a
 * second copy of this loop could only drift into judging them differently.
 */
function reservedColumnBlockers<T extends { extra_columns?: string | null }>(
  rows: T[],
  code: string,
  idOf: (row: T) => string,
  table: "objects" | "glossary",
): ValidationResult["blockers"] {
  const offered = new Set<string>();
  return rows.flatMap((row) =>
    reservedColumnsIn(row.extra_columns).map((column) => {
      // The removal takes the column from every row, so only the first
      // blocker naming it carries the control.
      const first = !offered.has(column);
      offered.add(column);
      return {
        code,
        message: code,
        entityId: idOf(row),
        params: { id: idOf(row), column },
        ...(first && {
          removable: {
            table,
            columns: [column],
            rows: { [column]: rowsHolding(rows.map((r) => r.extra_columns), column) },
          },
        }),
      };
    }),
  );
}

/**
 * One blocker per row whose id would read as a comment once this sheet is
 * published, naming the row. Shared by objects and glossary for the same
 * reason `reservedColumnBlockers` is: the two sheets fail the same way, so a
 * second copy of this test could only drift into judging them differently.
 *
 * `object_id` is `OBJECTS_CSV_COLUMNS[0]` (csv-export.server.ts) and
 * `term_id` is `GLOSSARY_CSV_COLUMNS[0]` (this file), so a published row's
 * first cell is always its id. `telar.core.csv_to_json` drops any row whose
 * first cell, CPython-stripped, starts with "#" (scripts/telar/core.py:99),
 * and `generate_collections.py` drops a glossary term by the same test
 * applied to `term_id` directly (:347) — so an id opening "#" turns the row
 * into a comment the instant it is published: the object or term disappears
 * from the site, and the next sync reads the row back as the comment it now
 * looks like rather than as the object or term it was.
 *
 * For OBJECTS, the id can only arrive here by import, through column order —
 * `slugify` strips every character that is not alphanumeric or whitespace,
 * so an id the Compositor generates can never open with "#". A sheet headed
 * `title, object_id` carrying an id of `#id` has an ordinary title in its
 * first cell, so the importer's own comment-row rule does not fire and the
 * row imports as real data; the object becomes a comment only once the
 * Compositor's fixed column order puts `object_id` first, because
 * `telar.core.csv_to_json` tests `df.columns[0]` — whichever column that is
 * — never `object_id` by name (`first_col = df.columns[0]`, core.py:98).
 *
 * The glossary reader does not share that shape, so the same account does
 * not carry over to glossary terms. `generate_collections.py` reads
 * `term_id` by NAME (`row.get('term_id', '')`, :338) and tests that value
 * directly (:347) — column position never enters into it. A sheet headed
 * `title, term_id, definition` carrying a term_id of `#id` is already a
 * comment to the framework as written; no reordering by the Compositor is
 * what turns it into one.
 *
 * That is also why this is a publish blocker and never an import warning,
 * and why the id is never rewritten on the way out: at import the row
 * genuinely is data, and silently renaming an id an author chose is a
 * decision on their behalf this makes nowhere else.
 *
 * Calls `isCommentCell` rather than testing the id directly: it mirrors
 * CPython's `strip()`, not JavaScript's, and the two disagree over U+FEFF and
 * U+0085 in opposite directions. A hand-rolled test would put this blocker
 * and the framework's drop rule on opposite sides of both.
 */
function commentRowIdBlockers<T>(
  rows: T[],
  code: string,
  idOf: (row: T) => string,
): ValidationResult["blockers"] {
  return rows
    .filter((row) => isCommentCell(idOf(row)))
    .map((row) => {
      const id = idOf(row);
      return { code, message: code, entityId: id, params: { id } };
    });
}

/**
 * One blocker per group of headers the framework would read as a single field,
 * for one published sheet.
 *
 * The header set is the sheet's fixed columns plus `extraKeysOf` — the same
 * surviving-key rule its serializer writes the file by — so this measures the
 * file about to be published rather than any one row, and never refuses over a
 * column that file will not carry.
 *
 * The glossary shape: a custom column spelled `crédito` beside the fixed
 * `credit`. `normalize_column_names` renames the first onto the second,
 * `_refuse_colliding_renames` raises `ColumnCollisionError`, and that
 * propagates uncaught out of `generate_collections._generate_glossary_from_csv`
 * — the site's next build fails. (Measured against the framework, 14
 * September; the link-map reader `telar/glossary.py` catches the same error and
 * silently loses every term instead.)
 *
 * The objects shape: `Nota` beside `nota`, two custom columns the Compositor's
 * own table renames neither of and the framework folds together.
 * `telar.core.csv_to_json` calls `normalize_column_names` with `OBJECT_FIELDS`
 * and the same refusal fires, so the site's next build fails there too.
 * (Measured on the test instance, 14 September. The published tag renames only
 * a header its table carries and keeps the author's spelling otherwise, so it
 * reads those as two columns and builds.)
 *
 * `reader` is that `OBJECT_FIELDS` argument together with the instruction-column
 * removal above it, and the reason the objects blocker and the glossary blocker
 * differ on the same pair of headers: `step` beside `paso`, and `#Note` beside
 * `#note`, are two custom columns on an objects sheet and one field twice over
 * on a glossary sheet, whose readers scope nothing and remove nothing first.
 *
 * One blocker for the whole file, not one per row: the collision is a property
 * of the emitted column set, and a per-row blocker would repeat one fact as
 * many times as the sheet is long.
 */
function collidingColumnBlockers(
  rows: Array<{ extra_columns?: string | null }>,
  fixedColumns: readonly string[],
  extraKeysOf: (parsed: Array<Record<string, string>>) => string[],
  code: string,
  reader?: FrameworkSheetReader,
  renames?: Readonly<Record<string, string>>,
): ValidationResult["blockers"] {
  const extras = extraKeysOf(rows.map((r) => parseExtraColumns(r.extra_columns)));
  return collidingHeaderGroups([...fixedColumns, ...extras], reader, renames).map((group) => ({
    code,
    message: code,
    params: { columns: group.map((h) => `"${h}"`).join(", ") },
  }));
}

/**
 * The steps of one or more stories that the story CSV writes
 * (`publishedSteps`), each judged with its own layers from `layers`. A step
 * with no layer in `layers` is judged as having none.
 */
export function writtenStepsFor<T extends StepForValidation>(
  steps: readonly T[],
  layers: readonly StepLayerForValidation[],
): T[] {
  const byStep = new Map<number, StepLayerForValidation[]>();
  for (const layer of layers) {
    const group = byStep.get(layer.step_id);
    if (group) group.push(layer);
    else byStep.set(layer.step_id, [layer]);
  }
  return publishedSteps(
    steps.map((step) => ({ ...step, kind: step.kind ?? "media", layers: byStep.get(step.id) ?? [] })),
  );
}

/** The steps that carry a story_id, grouped by it, in the order first seen. */
function stepsByStory(steps: StepForValidation[]): Map<string, StepForValidation[]> {
  const byStory = new Map<string, StepForValidation[]>();
  for (const step of steps) {
    if (!step.story_id) continue;
    const group = byStory.get(step.story_id);
    if (group) group.push(step);
    else byStory.set(step.story_id, [step]);
  }
  return byStory;
}

/** The kept columns `serializeStory` writes for `steps`, taken in step order. */
function storyKeysOf(steps: StepForValidation[]): string[] {
  const sorted = [...steps].sort((a, b) => a.step_number - b.step_number);
  return storyExtraColumnKeys(sorted.map((step) => parseExtraColumns(step.extra_columns)));
}

/**
 * Whether the story column blockers could come out differently once the
 * steps' layers are known, for any story in `steps`.
 *
 * A step with no layers is written when its kind, object, question, answer or
 * kept cells make it a row, and layers can only add steps to those. So the
 * keys of the steps written without layers, the keys of the steps actually
 * written, and the keys of every step are each contained in the next, and the
 * blockers are a function of the key set. The layers can change a story's
 * verdict only when its every-step keys raise a blocker and are not all
 * carried by the steps written without layers.
 */
export function storyColumnBlockersNeedLayers(steps: StepForValidation[]): boolean {
  for (const [storyId, storySteps] of stepsByStory(steps)) {
    const allKeys = storyKeysOf(storySteps);
    if (storyColumnBlockersFor(storyId, storyNameOf(storySteps[0]), allKeys).length === 0) continue;
    if (storyKeysOf(writtenStepsFor(storySteps, [])).length !== allKeys.length) return true;
  }
  return false;
}

/**
 * The layers the story column blockers need, or undefined when they are not
 * needed or cannot be read. Either way the blockers then judge every step, and
 * the keys of every step contain those of the written steps, so a failed read
 * can block more than the written steps would, never less.
 */
export async function stepLayersForValidation(
  steps: StepForValidation[],
  loadLayers: () => Promise<StepLayerForValidation[]>,
): Promise<StepLayerForValidation[] | undefined> {
  if (!storyColumnBlockersNeedLayers(steps)) return undefined;
  try {
    return await loadLayers();
  } catch {
    console.warn("validation: could not read the step layers; judging every step's columns");
    return undefined;
  }
}

/**
 * The story column blockers: one per kept column the framework reserves, and
 * one per group of columns it reads as one, for each story's CSV.
 *
 * Measured on the header `serializeStory` will write — the fixed columns and
 * `storyExtraColumnKeys` over the steps it writes — against the story reader
 * (`FRAMEWORK_STORIES_READER`), which scopes nothing and drops instruction
 * columns first. Framework 1.8.0 refuses either and fails the build; at 1.7.0
 * a collision renames two columns onto one label and one can lose its values.
 *
 * The steps written are judged with `layers` (`writtenStepsFor`). Without
 * them every step is judged, which gives the same verdict whenever
 * `storyColumnBlockersNeedLayers` is false and can only block more otherwise.
 *
 * Each carries `removable`, the kept columns the publish page can remove from
 * every step of the story. A fixed column in a collision group is not one: it
 * is written from its own field.
 */
function storyColumnBlockers(
  steps: StepForValidation[],
  layers?: readonly StepLayerForValidation[],
): ValidationResult["blockers"] {
  const blockers: ValidationResult["blockers"] = [];
  for (const [storyId, storySteps] of stepsByStory(steps)) {
    const judged = layers ? writtenStepsFor(storySteps, layers) : storySteps;
    blockers.push(
      ...storyColumnBlockersFor(
        storyId,
        storyNameOf(storySteps[0]),
        storyKeysOf(judged),
        storySteps.map((step) => step.extra_columns),
      ),
    );
  }
  return blockers;
}

/** The story column blockers for one story's CSV carrying the kept columns `keys`. */
function storyColumnBlockersFor(
  storyId: string,
  story: string,
  keys: string[],
  blobs: ReadonlyArray<string | null | undefined> = [],
): ValidationResult["blockers"] {
  if (keys.length === 0) return [];
  const removable = (columns: string[]): RemovableColumns => ({
    table: "steps",
    storyId,
    columns,
    rows: Object.fromEntries(columns.map((c) => [c, rowsHolding(blobs, c)])),
  });
  const blockers: ValidationResult["blockers"] = [];
  for (const column of keys.filter(isReservedColumnName)) {
    blockers.push({
      code: "story_reserved_column",
      message: "story_reserved_column",
      entityId: storyId,
      params: { story, column },
      removable: removable([column]),
    });
  }

  const kept = new Set(keys);
  for (const group of collidingHeaderGroups([...STORY_CSV_COLUMNS, ...keys], FRAMEWORK_STORIES_READER)) {
    blockers.push({
      code: "story_colliding_columns",
      message: "story_colliding_columns",
      entityId: storyId,
      params: { story, columns: group.map((h) => `"${h}"`).join(", ") },
      removable: removable(group.filter((h) => kept.has(h))),
    });
  }
  return blockers;
}

/**
 * The warning for each glossary id published at an address another id holds.
 * The build keeps the first id in glossary.csv and builds, so this does not
 * block; the rest are not published. A reference to an id differing only in
 * case still opens the kept term, and one differing in punctuation shows as
 * missing, so the two have their own wording.
 */
function glossarySharedAddressWarnings(glossary: GlossaryTermForValidation[]): ValidationResult["warnings"] {
  return sharedGlossaryAddresses(glossary).flatMap((shared) =>
    shared.dropped.map((dropped) => {
      const code = opensKeptTerm(shared.kept, dropped) ? "glossary_shared_address_case" : "glossary_shared_address";
      return { code, message: code, entityId: dropped, params: { kept: shared.kept, dropped } };
    }),
  );
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
 *   - Stories missing a title (unlike a draft, serializeProjectCsv still
 *     writes an untitled, non-draft story into the published index with an
 *     empty title cell — it ships as a blank entry rather than being
 *     dropped, so this blocks rather than warns)
 *   - An object carrying a reserved column name (see `RESERVED_COLUMN_NAMES`
 *     in extra-columns.server.ts) in its extra_columns passthrough:
 *     `serializeObjectsCsv` writes every extra_columns key back out as a real
 *     objects.csv column, and the framework's own build refuses any sheet
 *     carrying one of these — so shipping it would commit a file the site's
 *     next build cannot process. Refuses rather than dropping, renaming, or
 *     silently omitting the column: each of those decides on the author's
 *     behalf (dropping loses content they created; renaming is a deliberate
 *     feature, not something to do silently as a side effect of a
 *     publish; omitting-but-storing leaves D1 and the sheet disagreeing
 *     about what the sheet contains).
 *   - A glossary term carrying a reserved column name in its extra_columns
 *     passthrough, for the same reason and on the same terms: glossary.csv has
 *     the same passthrough, and the framework reads both files through the same
 *     refusal.
 *   - Two glossary columns the framework's bilingual rename would collapse into
 *     one field (see `collidingColumnBlockers`)
 *   - A story CSV column the framework reserves, or two it reads as one
 *     (see `storyColumnBlockers`)
 *   - An object_id or term_id that opens with "#": each is its sheet's first
 *     published column, and the framework drops any row whose first cell,
 *     CPython-stripped, starts with "#" — so publishing it drops the row from
 *     the site, and the next sync reads it back as a comment, not as the
 *     object or term it was (see `commentRowIdBlockers`)
 * Warnings:
 *   - Objects missing a title (still emitted, just imperfect)
 *   - Steps that have an object but no position (x/y/zoom all null)
 *   - Private stories present but no site-wide story key set (the build will
 *     fail on Telar >=1.6 until a key is set — advisory, never a blocker)
 *   - Private stories present but the site's `.github/workflows/build.yml`
 *     does not run the encryption step, or is absent (the same Telar >=1.6
 *     interlock, its second prerequisite — advisory, never a blocker)
 *   - Fully empty steps are excluded from all checks
 *
 * Pure: `buildWorkflow` is the caller's read of `.github/workflows/build.yml`
 * at the validated commit, passed in rather than fetched here. `undefined`
 * means the caller did not read it, which is the case for every site with no
 * private, non-draft story.
 */
export function runPrePublishValidation(params: {
  headSha: string;
  currentRepoHead: string;
  stories: StoryForValidation[];
  steps: StepForValidation[];
  objects: ObjectForValidation[];
  pages: PageForValidation[];
  glossary: GlossaryTermForValidation[];
  storyKey?: string | null;
  /**
   * The repository's `_config.yml` at the commit this publish would land on,
   * for the managed blocks the writer could not edit. Absent means the caller
   * did not read it, and nothing is checked — a publish that cannot see the
   * file cannot report on it either.
   */
  configYml?: string | null;
  /**
   * The `project_config` row a publish would write into `configYml`. The heal
   * takes the managed fields and blocks built from it, so the check cannot ask
   * whether the write would succeed without it. Absent means the caller did not
   * read the row, and the write is not judged.
   */
  config?: typeof project_config.$inferSelect | null;
  buildWorkflow?: FileAtRef;
  /**
   * The layers of the site's steps, which decide whether a step with no
   * content of its own is written (`stepLayersForValidation`). Absent means
   * the story column blockers judge every step.
   */
  stepLayers?: readonly StepLayerForValidation[];
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

  // Blocker: a row whose extra_columns carries a name the framework reserves
  // for itself. Both serializers write every extra_columns key back out as a
  // real CSV column, and the framework refuses to build any sheet carrying one
  // of these (ReservedColumnError in scripts/telar/csv_utils.py) — so
  // publishing it would ship a commit whose very next build fails. One blocker
  // per affected row, naming both the row and the column so the author knows
  // exactly what to rename.
  blockers.push(
    ...reservedColumnBlockers(params.objects, "object_reserved_column", (o) => o.object_id, "objects"),
    ...reservedColumnBlockers(params.glossary, "glossary_reserved_column", (t) => t.term_id, "glossary"),
  );

  // Blocker: an id that opens with "#". object_id and term_id are each
  // sheet's first published column, and the framework drops any row whose
  // first cell, CPython-stripped, starts with "#" — so publishing such an id
  // drops the row from the site, and the next sync reads it back as the
  // comment it now looks like. See `commentRowIdBlockers` for the full
  // account, including why this is a publish blocker and not an import
  // warning, and why the id is never rewritten on the way out.
  blockers.push(
    ...commentRowIdBlockers(params.objects, "object_id_comment_row", (o) => o.object_id),
    ...commentRowIdBlockers(params.glossary, "glossary_id_comment_row", (t) => t.term_id),
  );

  // Blocker: two columns the framework reads as one field, on either sheet
  // that carries a passthrough blob. Same outcome as a reserved column — a
  // commit whose very next build fails — by a different route: the rename, not
  // the name.
  blockers.push(
    ...collidingColumnBlockers(
      params.objects,
      OBJECTS_CSV_COLUMNS,
      objectsExtraColumnKeys,
      "objects_colliding_columns",
      FRAMEWORK_OBJECTS_READER,
    ),
    // The glossary reader passes no scope, so every rename in its table
    // lands, the glossary's own aliases among them.
    ...collidingColumnBlockers(
      params.glossary.map((t) => ({ extra_columns: glossaryKeptBlob(t) })),
      GLOSSARY_CSV_COLUMNS,
      glossaryExtraColumnKeys,
      "glossary_colliding_columns",
      FRAMEWORK_GLOSSARY_READER,
      FRAMEWORK_GLOSSARY_COLUMN_RENAMES,
    ),
  );

  // Blocker: a story CSV column the framework refuses — a reserved name, or
  // two columns it reads as one. Story CSVs are written for drafts too, so
  // every story is checked.
  blockers.push(...storyColumnBlockers(params.steps, params.stepLayers));

  // Blocker: a story ID the site cannot take. Publish writes the story's CSV
  // to spreadsheets/<id>.csv, so an ID with a path character in it, or the
  // name of the project, objects or glossary sheet, writes the wrong file.
  // Drafts are checked too: their CSVs are written.
  for (const story of params.stories) {
    if (storyIdRefusal(story.story_id) !== null) {
      blockers.push({
        code: "story_id_refused",
        message: "story_id_refused",
        entityId: story.story_id,
        params: { id: story.story_id },
      });
    }
  }

  // Blocker: stories without titles. `serializeProjectCsv` (:399) does not
  // drop an untitled, non-draft story the way it drops drafts — it writes
  // title: "" — so it publishes as a blank entry in the story index with
  // nothing telling the user why. The message names the story by its
  // story_id, since that is the only identifier an untitled story has.
  // Drafts are skipped for the same reason the private_story_no_key warning
  // below skips them: a draft is absent from the published index (the
  // orphans-are-drafts rule), so its missing title never reaches the site.
  for (const story of params.stories) {
    if (story.draft) continue;
    if (!story.title || story.title.trim() === "") {
      blockers.push({
        code: "story_no_title",
        message: "story_no_title",
        entityId: story.story_id,
        params: { id: story.story_id },
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

  blockers.push(...pageFrontmatterBlockers(params.pages));
  warnings.push(...pageFrontmatterReplacedWarnings(params.pages));

  // Warning: glossary ids published at one address.
  warnings.push(...glossarySharedAddressWarnings(params.glossary));

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

  // Blockers: a managed config block the writer cannot edit, and a _config.yml
  // the publish would heal into something that still is not valid YAML. Both
  // are raised here rather than at the write, because an author who is not told
  // either watches a publish report success while the setting they changed
  // never reaches the site, or watches one fail with nothing on screen saying
  // why.
  blockers.push(...configBlockers(params.configYml, params.config));

  // The answer's own checks: its length against the site's limit, the kinds a
  // build removes outright, and the kinds it flattens. Layers and the question
  // are exempt — they are the long-form room a step has — so only the answer
  // is read.
  const answers = answerChecks(params.steps, { terms: keptGlossaryTerms(params.glossary), baseUrl: "" });
  blockers.push(...answers.blockers);

  // Warnings: the prerequisites a Telar >=1.6 build imposes on a private story.
  // The framework encrypts private stories at build time and refuses to build
  // when a prerequisite is missing, so the published site build would hard-fail.
  // We warn rather than block: the user may still be mid-setup, and blocking
  // would trap otherwise-valid publishes. Each message names the affected
  // stories so the user knows exactly which ones force the requirement.
  warnings.push(
    ...privateStoryWarnings(params.stories, params.storyKey, params.buildWorkflow),
  );

  // Warning, never a blocker: an answer using a mark the build flattens. The
  // words all survive, so there is nothing to refuse a publish over — only a
  // published site that will read plainer than the editor does.
  warnings.push(...answers.warnings);

  return { blockers, warnings };
}

// ---------------------------------------------------------------------------
// Full publish file set assembly
// ---------------------------------------------------------------------------

export interface BuildPublishParams {
  token: string;
  owner: string;
  repo: string;
  /**
   * The revision every read of the repository is taken at — a SHA, so that one
   * publish is one revision. A branch NAME resolves again on each read, and a
   * hand commit between two of them puts the file set across two revisions.
   */
  ref: string;
  projectId: number;
  env: Env;
  /**
   * The `_config.yml` the caller has already read at `branch`, if it has: the
   * publish action reads it to judge whether it can write the managed blocks,
   * and the file it judged must be the file this assembly edits. `null` says
   * the caller read no file, and no config is written at all. Omitted, the
   * assembly reads the file itself.
   */
  configYml?: string | null;
  /**
   * The `project_config` row the caller has already read, if it has. The write
   * is decided by the row and the file together — the heal repairs a broken
   * managed line only where the row carries a value to write over it — so the
   * row the check judged must be the row this assembly writes from, for the
   * same reason the file must be. `null` says the caller read no row, and no
   * config is written at all. Omitted, the assembly reads the row itself.
   */
  config?: typeof project_config.$inferSelect | null;
  /**
   * The page rows the caller has already read, if it has. The publish records
   * which pages it committed, and deletes the files of pages no longer there,
   * from the same rows the files are written from, so the three cannot
   * describe different pages. An empty array is a site with no
   * pages. Omitted, the assembly reads the pages itself.
   */
  pages?: PublishPageRow[];
  /**
   * The `project_landing` row the caller has already read, for the same
   * reason: `index.md` and the recorded landing hash come from one row.
   * `null` says the site has none. Omitted, the assembly reads it itself.
   */
  landing?: typeof project_landing.$inferSelect | null;
  /**
   * The objects sheet as the caller has already read it strictly at `ref`: its
   * path (`siteSheetFileAt`) and text, undefined for a site with none. The
   * publish action reads it to finish the objects operations still owed before
   * D1 is read, and the file it read is the one rewritten here. Omitted, the
   * assembly reads it itself, strictly.
   */
  objectsSheet?: { path: string; existingCsv: string | undefined };
  /**
   * Filled by the assembly with the path the glossary sheet was read from, so
   * the caller can tell whether the Spanish glossary was the source
   * (`spanishSheetCounterparts`) without reading it again.
   */
  glossaryReadFrom?: { path?: string };
  /**
   * Filled by the assembly with the path of each sheet it read at `ref` whose
   * headings the rewrite corrects, so the caller can tell whether the publish
   * corrects any.
   */
  headingsCorrected?: string[];
}

/** Records `path` in `params.headingsCorrected` when `text`, the sheet read there, has headings the rewrite corrects. */
function noteHeadings(params: BuildPublishParams, kind: CsvSheetKind, path: string, text: string | null | undefined): void {
  if (params.headingsCorrected && text && misreadHeadingsIn(text, csvSheetFor(kind)).length > 0) {
    params.headingsCorrected.push(path);
  }
}

/** A page as the publish reads it: what its file and its hash are made from. */
export type PublishPageRow = Pick<
  typeof project_pages.$inferSelect,
  "title" | "slug" | "body" | "frontmatter" | "frontmatter_source" | "order"
>;

/**
 * The rows a publish captures once and hands both to the file set and to the
 * hashes it records, so the commit and the record describe one state.
 * Each omitted row is read where it is needed.
 */
export interface CapturedPublishRows {
  pages?: PublishPageRow[];
  config?: typeof project_config.$inferSelect | null;
  landing?: typeof project_landing.$inferSelect | null;
}

/**
 * The pages a publish reads, when the caller has not captured them, with the
 * row id the post-publish store names each page by
 * (`storeWrittenPageFrontmatter`).
 */
export function readPublishPages(
  db: ReturnType<typeof getDb>,
  projectId: number,
): Promise<Array<PublishPageRow & { id: number }>> {
  return db
    .select({
      id: project_pages.id,
      title: project_pages.title,
      slug: project_pages.slug,
      body: project_pages.body,
      frontmatter: project_pages.frontmatter,
      frontmatter_source: project_pages.frontmatter_source,
      order: project_pages.order,
    })
    .from(project_pages)
    .where(eq(project_pages.project_id, projectId));
}

/** The landing row a publish reads, as a list of at most one, when the caller has not captured it. */
export function readPublishLanding(db: ReturnType<typeof getDb>, projectId: number) {
  return db.select().from(project_landing).where(eq(project_landing.project_id, projectId)).limit(1);
}

/** A captured row as the list of at most one that a read of it answers. */
function asRows<T>(row: T | null): T[] {
  return row ? [row] : [];
}

// The pages, settings and landing a publish works from: the row the caller
// captured and handed down, or a read of its own when it did not. A read is
// returned unawaited, as a query chain, so a caller can run it in one
// Promise.all with its other reads.

function pagesFor(db: ReturnType<typeof getDb>, projectId: number, captured?: PublishPageRow[]) {
  return captured ?? readPublishPages(db, projectId);
}

function configRowsFor(
  db: ReturnType<typeof getDb>,
  projectId: number,
  captured: typeof project_config.$inferSelect | null | undefined,
) {
  if (captured !== undefined) return asRows(captured);
  return db.select().from(project_config).where(eq(project_config.project_id, projectId)).limit(1);
}

function landingRowsFor(
  db: ReturnType<typeof getDb>,
  projectId: number,
  captured: typeof project_landing.$inferSelect | null | undefined,
) {
  return captured !== undefined ? asRows(captured) : readPublishLanding(db, projectId);
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
  // These are scalars for a line splicer, not a document: `updateConfigFields`
  // writes each one into an existing `_config.yml` line, preserving the
  // comments and ordering around it. There is no template to render, so they
  // stay on yamlQuote — which is the same escaper the templates use through
  // the `yaml_string` filter, so the scalars match either way.
  //
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
 * Builds the managed NESTED config blocks (story_interface,
 * collection_interface, development-features) from a
 * project_config row. Values are emitted UNQUOTED — js-yaml coerces
 * unquoted true/false/4 to boolean/number, which import.server.ts relies on
 * (a quoted "false" would be read back as a truthy string). Null fields are
 * omitted; empty blocks are dropped. google_sheets is intentionally excluded
 * (nested string = corruption-risk class; not Config-UI editable).
 *
 * `story_content` is NOT among them. Its one key was the answer word limit,
 * which is no longer a per-site setting, so nothing here has a value to write
 * into that block — and a site whose file already carries it keeps every line
 * of it, copied like any other block this writer does not manage: the keys,
 * the values, the comments, the indentation and the order, down to a tab or a
 * duplicated child. The one thing not preserved is the line ending, which
 * `updateConfigBlocks` normalises across the whole file whenever any managed
 * block is written, as it did before this block stopped being managed.
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

  // `development-features:` is the framework's block name in _config.yml;
  // `dev_features` is only a Liquid local in _layouts/index.html.
  const development: Record<string, string> = {};
  if (config.skip_stories != null) development["skip_stories"] = b(config.skip_stories);

  const blocks: Record<string, Record<string, string>> = {};
  if (Object.keys(story).length > 0) blocks["story_interface"] = story;
  if (Object.keys(collection).length > 0) blocks["collection_interface"] = collection;
  if (Object.keys(development).length > 0) blocks["development-features"] = development;
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
  // Present only while the column is set, as the write is: a project that
  // never edited its kinds has nothing here to report or to hash.
  const kinds = canonicalKindsJson(config.glossary_kinds_json);
  if (kinds !== null) fields["glossary.kinds"] = kinds;
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
export async function pageRowsToCommitFiles(pageRows: PageContentRow[]): Promise<CommitFile[]> {
  const files: CommitFile[] = [];
  for (const page of pageRows) {
    if (!isPagePublishable(page)) continue;
    files.push({
      path: pageFilePath(page),
      content: await serializePageMarkdown(page.title ?? "", page.body ?? "", page.frontmatter, page.slug ?? ""),
    });
  }
  return files;
}

/**
 * A page as its file and its hash are made from. `frontmatter` is optional
 * for a caller holding no block: absent and null are both a page written with
 * its title alone.
 */
type PageContentRow = Pick<typeof project_pages.$inferSelect, "title" | "slug" | "body"> & {
  frontmatter?: string | null;
};

/** Where a publishable page's file lives: its trimmed slug under the pages directory. */
function pageFilePath(page: { slug: string | null }): string {
  return `telar-content/texts/pages/${(page.slug ?? "").trim()}.md`;
}

/** A page's front matter could not be read from the repository, so its file cannot be written without losing it. */
export class UnreadablePageError extends Error {
  constructor(readonly path: string) {
    super(`could not read ${path} to carry its front matter forward`);
    this.name = "UnreadablePageError";
  }
}

/**
 * A page whose kept front matter no edit can give its new title without
 * changing another key. The publish stops rather than write it; the checks
 * name the page and offer to keep only its title.
 */
export class UnwritablePageFrontmatterError extends Error {
  constructor(readonly slug: string) {
    super(`the front matter of page "${slug}" cannot take its title without changing another key`);
    this.name = "UnwritablePageFrontmatterError";
  }
}

/** How many page files a carry-forward reads at once. */
const CARRY_FORWARD_READS = 6;

/** `fn` over `items`, at most `limit` at a time, results in the items' order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Where a page's front matter is carried forward from: the file it was imported as. */
function carryForwardPath(page: { slug: string | null; frontmatter_source?: string | null }): string {
  return pageFilePath({ slug: page.frontmatter_source ?? page.slug });
}

/** What a carry-forward needs of a page. */
export type CarriablePage = Pick<PublishPageRow, "slug" | "title" | "frontmatter"> & {
  frontmatter_source?: string | null;
};

/** The repository and revision a carry-forward reads at. */
export type CarryForwardSource = Pick<BuildPublishParams, "token" | "owner" | "repo" | "ref">;

/**
 * The file a page never captured is published with the block of, read
 * through `read` (a repository path to what a strict read of it answers):
 * its content, or the path whose read failed.
 *
 * The file is the one the page was imported as (`frontmatter_source`, set to
 * the slug of every page the column found), so a page renamed since still
 * reads its own; a page without a source, or whose source is its current
 * slug, reads its current slug and stops there. Where the source file is
 * absent and names another slug, the file at the current slug is read: a
 * publish of the renamed page wrote the block there and deleted the source
 * file in the same commit, while the page stays uncaptured. An absent result
 * at every path tried is a page written as a new one would be (`""`).
 *
 * This is the one statement of the rule: the publish reads through it
 * (`readCarryForwardContent`), and so does every check that compares a page
 * with what a publish would write.
 */
export async function carriedPageFile(
  page: CarriablePage,
  read: (path: string) => Promise<FileAtRef>,
): Promise<{ ok: true; content: string } | { ok: false; path: string }> {
  const path = carryForwardPath(page);
  const first = await read(path);
  if (first.status === "ok") return { ok: true, content: first.content };
  if (first.status === "error") return { ok: false, path };
  const currentPath = pageFilePath({ slug: page.slug });
  if (currentPath === path) return { ok: true, content: "" };
  const fallback = await read(currentPath);
  if (fallback.status === "ok") return { ok: true, content: fallback.content };
  if (fallback.status === "error") return { ok: false, path: currentPath };
  return { ok: true, content: "" };
}

/**
 * A page never captured's file content at `ref`, read by `carriedPageFile`'s
 * rule, or `null` when a failed read should leave the page as it is
 * (non-strict). A read that fails throws with `strict`, naming whichever path
 * failed, stopping the publish rather than writing the page without its keys;
 * without it the page stays NULL, which is what a check that cannot see the
 * file reports on.
 */
export async function readCarryForwardContent(
  source: CarryForwardSource,
  page: CarriablePage,
  strict: boolean,
): Promise<string | null> {
  const carried = await carriedPageFile(page, (path) =>
    getFileAtRef(source.token, source.owner, source.repo, path, source.ref, { strict: true }),
  );
  if (carried.ok) return carried.content;
  if (strict) throw new UnreadablePageError(carried.path);
  return null;
}

/**
 * The pages with the front matter of each one never captured read from its
 * file at `ref`, the revision the publish is built on.
 *
 * A page imported before its block was stored holds NULL, and writing it from
 * its title alone would delete every other key its file carries. So its file
 * is read, six at a time; `readCarryForwardContent` says which file.
 *
 * The rows returned are new objects, so the rows the caller hashes still
 * hold NULL and an uncaptured page never reads as changed.
 *
 * A leading byte-order mark is dropped before the block is found, as the
 * import's read drops it, so a page carried forward is written without one.
 */
export async function withCarriedFrontmatter<P extends CarriablePage>(
  pages: P[],
  source: CarryForwardSource,
  strict = true,
): Promise<P[]> {
  return mapBounded(pages, CARRY_FORWARD_READS, async (page) => {
    if (page.frontmatter !== null || !isPagePublishable(page)) return page;
    const content = await readCarryForwardContent(source, page, strict);
    if (content === null) return page;
    return { ...page, frontmatter: capturedFrontmatter(content.replace(/^\uFEFF/, "")) };
  });
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
  const slug = (page.slug ?? "").trim();
  return !!(page.title ?? "").trim() && !!slug && !isParkingKey(slug);
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
export function buildPageContentHashes(pageRows: PageContentRow[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const page of pageRows) {
    if (!isPagePublishable(page)) continue;
    const slug = (page.slug ?? "").trim();
    hashes[slug] = JSON.stringify(pageHashInput(page, slug));
  }
  return hashes;
}

/**
 * What a page's hash is made from. The front matter is added after the other
 * keys and only when non-empty, so a page without any, or one whose block was
 * never captured, hashes exactly as it did before the field existed and the
 * hash version does not move.
 */
function pageHashInput(page: PageContentRow, slug: string): Record<string, string> {
  const input: Record<string, string> = { title: page.title ?? "", body: page.body ?? "", slug };
  if (page.frontmatter) input.frontmatter = page.frontmatter;
  return input;
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
/**
 * What the navigation hash is made from.
 *
 * The saved entries, parsed and re-serialised so whitespace edits do not
 * surface as changes; empty when there is no menu or its JSON is malformed,
 * the condition in which `_data/navigation.yml` is not written either.
 *
 * A page served at an address other than its slug (`Credits.md` at
 * `/credits/`) adds the addresses written, so a menu last published with the
 * raw slug lists as changed once and the corrected link can be published.
 */
function navigationHashInput(navigationJson: string | null): string {
  if (!navigationJson) return "";
  let saved: unknown;
  try {
    saved = JSON.parse(navigationJson);
  } catch {
    return "";
  }
  const savedText = JSON.stringify(saved);
  if (!Array.isArray(saved)) return savedText;
  const moved = servedAddressesUnlikeSlugs(saved as NavItem[]);
  return moved.length === 0 ? savedText : JSON.stringify({ menu: savedText, addresses: moved });
}

/** Each page entry's served address where it is not its slug: the URL the publish writes for it. */
function servedAddressesUnlikeSlugs(entries: readonly NavItem[]): string[] {
  return entries
    .filter((e) => e.type === "page" && e.visible !== false && typeof e.slug === "string" && siteAddressOfPage(e.slug) !== e.slug)
    .map((e) => siteAddressOfPage(e.slug as string));
}

export async function buildEntityHashes(
  db: ReturnType<typeof getDb>,
  projectId: number,
  captured: CapturedPublishRows = {},
): Promise<EntityHashes> {
  const [
    storyRows,
    objectRows,
    pageRows,
    glossaryRows,
    configRows,
    landingRows,
  ] = await Promise.all([
    db.select().from(stories).where(eq(stories.project_id, projectId)),
    db.select().from(objects).where(eq(objects.project_id, projectId)).orderBy(objectsSheetOrder()),
    pagesFor(db, projectId, captured.pages),
    db
      .select({
        term_id: glossary_terms.term_id,
        title: glossary_terms.title,
        definition: glossary_terms.definition,
        related_terms: glossary_terms.related_terms,
        kind: glossary_terms.kind,
        extra_columns: glossary_terms.extra_columns,
      })
      .from(glossary_terms)
      .where(eq(glossary_terms.project_id, projectId)),
    configRowsFor(db, projectId, captured.config),
    landingRowsFor(db, projectId, captured.landing),
  ]);

  const config = configRows[0] ?? null;
  const landing = landingRows[0] ?? null;

  // Pages — share canonical hash inputs with buildPageContentHashes
  // (title + body + slug; order is deliberately excluded — a reorder
  // surfaces once, as the navigation change), keyed by trimmed slug.
  const pages = buildPageContentHashes(pageRows);

  // Objects — every D1 field that serializeObjectsCsv reads, including
  // dimensions and the extra_columns custom-column passthrough blob, keyed by
  // object_id. Row order is hashed separately (`objectOrder`, below).
  // extra_columns is canonicalised (keys sorted) so equivalent data hashes
  // identically regardless of stored key order.
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
      const stepHash: Record<string, unknown> = {
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
      };
      stepsForHash.push(withKeptCellsForHash(stepHash, step.extra_columns));
    }

    storyHashes[story.story_id] = JSON.stringify(
      withKeptCellsForHash(
        {
          story_id: story.story_id,
          title: story.title ?? "",
          subtitle: story.subtitle ?? "",
          byline: story.byline ?? "",
          order: story.order ?? 0,
          private: story.private ?? false,
          show_sections: story.show_sections ?? false,
          steps: stepsForHash,
        },
        story.extra_columns,
      ),
    );
  }

  // Glossary — id + title + definition. No `order` column on the schema
  // (verified) so reorders aren't representable. extra_columns is canonicalised
  // (keys sorted) so a blob reserialised in a different key order is the same
  // data to the hash and to the sync diff alike.
  const glossaryHashes: Record<string, string> = {};
  for (const term of glossaryRows) {
    glossaryHashes[term.term_id] = JSON.stringify({
      term_id: term.term_id,
      title: term.title ?? "",
      definition: term.definition ?? "",
      related_terms: term.related_terms ?? "",
      // The kind is hashed among the kept columns it is written with, so a
      // sheet's hashes stay as they were when its kind moved out of the blob.
      extra_columns: canonicalExtraColumns(glossaryKeptBlob(term)),
    });
  }

  const navigationHash = navigationHashInput(config?.navigation_json ?? null);


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
    objectOrder: objectOrderHash(objectRows),
  };
}

/**
 * The hash of objects' row order in sheet order, which reaches the site (the
 * later of two rows it reads as one object; the released framework's homepage
 * sample); empty for no objects. The hash is over the object_id sequence,
 * because D1 row ids are not stable across the snapshot's re-insert. The
 * document holds one row per object_id, so the sequence names every order the
 * site can see.
 */
function objectOrderHash(objectRows: ReadonlyArray<{ object_id: string }>): string {
  return objectRows.length > 0 ? JSON.stringify(objectRows.map((o) => o.object_id)) : "";
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
 * The older copies of each story this publish writes that the commit deletes
 * when they are there, the story's CSV in the spreadsheets folder is absent at
 * the head it is built on, and their bytes are not valid UTF-8.
 *
 * `_data/<id>.csv` is read by Jekyll as site data, so such a copy stops the
 * build, and it is deleted whatever path the story was read from
 * (`source_path`), NULL included: the author is never left to open GitHub to
 * unblock a build. `<id>.csv` at the root is not read by the site, and is
 * deleted only when it is the file the Compositor read the story from, since a
 * story made here, or imported before the path was recorded, can share its id
 * with an unrelated CSV; it is also kept while `_data/<id>.csv` is there. A
 * readable copy is kept, since a story the sync inserted or a Google Sheets
 * import can leave one beside the story that holds the only copy of
 * something. Only for the stories whose CSV is in `files`.
 */
export function olderStoryCopies(
  files: readonly CommitFile[],
  stories: ReadonlyArray<{ story_id: string; source_path: string | null }>,
): ConditionalDeletion[] {
  const written = new Set(files.map((f) => f.path));
  return stories
    .filter((story) => written.has(`telar-content/spreadsheets/${story.story_id}.csv`))
    .flatMap((story) => [dataCopyOf(story.story_id), ...readRootCopy(story)]);
}

/** Story `id`'s copy in `_data/`, unless its CSV in the spreadsheets folder is there. */
function dataCopyOf(id: string): ConditionalDeletion {
  return { path: `_data/${id}.csv`, unlessPresent: [`telar-content/spreadsheets/${id}.csv`], onlyIfUnreadable: true };
}

/** The story's root copy, where it is the file the story was read from, unless a copy read before it is there. */
function readRootCopy(story: { story_id: string; source_path: string | null }): ConditionalDeletion[] {
  const id = story.story_id;
  const root = `${id}.csv`;
  if (story.source_path !== root) return [];
  return [{ path: root, unlessPresent: [`telar-content/spreadsheets/${id}.csv`, `_data/${id}.csv`], onlyIfUnreadable: true }];
}

const PROJECT_CSV = "telar-content/spreadsheets/project.csv";

/**
 * GitHub's project.csv could not be read, so the stories deleted since it was
 * written cannot be known, nor their `_data` copies, which stop the build, and
 * the publish refuses rather than leave one. A retry reads it again.
 */
export class UnreadableProjectCsvError extends Error {
  constructor() {
    super(`could not read ${PROJECT_CSV} to find the stories deleted since it was written`);
    this.name = "UnreadableProjectCsvError";
  }
}

/**
 * The `_data` copy of each story that GitHub's project.csv at `source.ref`
 * lists and D1 no longer has, on the terms `olderStoryCopies` names it for a
 * story the publish writes. No CSV is written for a deleted story, so its ids
 * are read from project.csv as the import read them (`projectCsvStoryRows`).
 * Its root copy is never named: with the story's row gone, no path it was
 * read from is known, and the site does not read that file. A story in D1 is
 * left to `olderStoryCopies`; an id listed twice is named once. project.csv
 * absent, or one the import cannot parse, names nothing: refusing would leave
 * a publish that rewrites project.csv with no way through. A read that fails
 * throws `UnreadableProjectCsvError`.
 */
export async function deletedStoryDataCopies(
  source: { token: string; owner: string; repo: string; ref: string },
  d1StoryIds: readonly string[],
): Promise<ConditionalDeletion[]> {
  const { file: read } = await siteSheetAt(source, "project");
  if (read.status === "absent") return [];
  if (read.status !== "ok") throw new UnreadableProjectCsvError();
  let rows: ReturnType<typeof projectCsvStoryRows>;
  try {
    rows = projectCsvStoryRows(read.content.replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  const inD1 = new Set(d1StoryIds);
  // A blank id names no story file.
  const listed = new Set(rows.map((r) => r.story_id ?? "").filter((id) => pythonStrip(id) !== ""));
  return [...listed].filter((id) => !inD1.has(id)).map(dataCopyOf);
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

/** What `carriedPageDeletions` reads of a page: whether it is written, where, and from which file it carries. */
type PageFileSource = { title: string | null; slug: string | null; frontmatter_source?: string | null };

/**
 * The page files a publish deletes because a page it writes was carried from
 * them (`frontmatter_source`) under another slug: the page is written at its
 * own slug, and the file it was imported as would otherwise stay, built as a
 * page of the site, with no snapshot naming it for `computePageDeletions`.
 *
 * A file a held page claims is kept: one at a page's own slug, and one a page
 * this publish does not write (`isPagePublishable`) still carries its block
 * from. A page carried from its own slug, or with a blank source, names none.
 * The caller drops any path the publish also writes, as for the other page
 * deletions.
 */
export function carriedPageDeletions(pages: readonly PageFileSource[]): string[] {
  const claimed = new Set(pages.flatMap(claimedPageFiles));
  const carried = pages.filter((page) => isPagePublishable(page) && hasCarrySource(page)).map(carryForwardPath);
  return [...new Set(carried)].filter((path) => !claimed.has(path));
}

/** Whether a page names a file to carry its block from, blank names aside. */
function hasCarrySource(page: PageFileSource): boolean {
  return (page.frontmatter_source ?? "").trim() !== "";
}

/** The page files a held page keeps: its own, and the one it carries from while unwritten. */
function claimedPageFiles(page: PageFileSource): string[] {
  const own = (page.slug ?? "").trim() === "" ? [] : [pageFilePath(page)];
  const carriedFrom = !isPagePublishable(page) && hasCarrySource(page) ? [carryForwardPath(page)] : [];
  return [...own, ...carriedFrom];
}

/**
 * Clears `frontmatter_source` on each page whose carried file is among the
 * `deletions` a landed publish sent (`carriedPageDeletions`), so no later
 * publish names that path again and a file created there afterwards is kept.
 * The page then carries its block from its own file, which the publish wrote
 * with it. `pages` are the pages as the publish captured them; a source
 * changed since is kept. Runs after the commit has landed, so a failure is
 * logged and returns.
 */
export async function clearCarriedPageSources(
  db: ReturnType<typeof getDb>,
  projectId: number,
  pages: ReadonlyArray<PageFileSource & { id: number }>,
  deletions: readonly string[],
): Promise<void> {
  const deleted = new Set(deletions);
  const cleared = pages.filter((page) => hasCarrySource(page) && deleted.has(carryForwardPath(page)));
  try {
    for (const page of cleared) {
      await db
        .update(project_pages)
        .set({ frontmatter_source: null })
        .where(and(
          eq(project_pages.project_id, projectId),
          eq(project_pages.id, page.id),
          eq(project_pages.frontmatter_source, page.frontmatter_source!),
        ));
    }
  } catch (err) {
    console.error("[publish] clearing the sources of carried page files failed", { projectId, err });
  }
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
 * The text of `path` at `ref`, or null where the read produced no file.
 *
 * A read without a ref takes the repository's DEFAULT branch, which on a site
 * whose default is not the branch being published is a different file from the
 * one the publish checks measured and the one the commit replaces — settings
 * from a branch nobody looked at, published.
 */
async function fileAtRef(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const read = await getFileAtRef(token, owner, repo, path, ref);
  return read.status === "ok" ? read.content : null;
}

/**
 * The sheet the build reads in `role` at `source.ref`, read strictly, and its
 * path, which is the file the publish writes that sheet to (`siteSheetFileAt`).
 */
function siteSheetAt(source: { token: string; owner: string; repo: string; ref: string }, role: SiteSheetRole) {
  return siteSheetFileAt(role, (path) =>
    getFileAtRef(source.token, source.owner, source.repo, path, source.ref, { strict: true }),
  );
}

/** A sheet this assembly rewrites: the file it is written to, and its text there, null for none. */
interface ExistingSheet {
  path: string;
  content: string | null;
}

/**
 * The objects sheet this assembly rewrites: the one the caller already read, or
 * a strict read of its own. A read that fails is never taken for a missing
 * file: the rewrite would drop the sheet's comment and instruction rows, so it
 * throws `ObjectsCommitUnready`, which the publish answers `objects_unreadable`.
 */
async function objectsCsvForAssembly(params: BuildPublishParams): Promise<ExistingSheet> {
  if (params.objectsSheet !== undefined) {
    return { path: params.objectsSheet.path, content: params.objectsSheet.existingCsv ?? null };
  }
  const { path, file: read } = await siteSheetAt(params, "objects");
  if (read.status === "error") throw new ObjectsCommitUnready("unreadable", "objects.csv could not be read");
  return { path, content: read.status === "ok" ? read.content : null };
}

/**
 * A file the publish rewrites from what it reads could not be read, so writing
 * it would drop what it carries: the landing page's frontmatter lines and body,
 * the glossary's or project sheet's comment and instruction rows, or a story CSV's layout and
 * comment rows. For a story `path` is its CSV, or the spreadsheets directory
 * when the listing failed.
 */
export class UnreadablePublishFileError extends Error {
  constructor(readonly file: "landing" | "glossary" | "stories" | "project", readonly path: string) {
    super(`could not read ${path} to carry its content forward`);
    this.name = "UnreadablePublishFileError";
  }
}

/**
 * `path` read strictly at `ref` for a rewrite, or null when the site has no
 * such file or the publish does not write it (`writes` false), in which case
 * nothing is read and a failed read cannot refuse the publish. A failed read
 * throws `UnreadablePublishFileError` naming `file`.
 */
async function rewrittenFileAt(
  params: BuildPublishParams,
  writes: boolean,
  path: string,
  file: UnreadablePublishFileError["file"],
): Promise<string | null> {
  if (!writes) return null;
  const read = await getFileAtRef(params.token, params.owner, params.repo, path, params.ref, { strict: true });
  if (read.status === "error") throw new UnreadablePublishFileError(file, path);
  // For index.md's frontmatter match, which starts at the first character;
  // harmless for the glossary, whose comment extraction drops the mark anyway.
  return read.status === "ok" ? read.content.replace(/^\uFEFF/, "") : null;
}

/**
 * The sheet in `role` read for a rewrite as `rewrittenFileAt` reads a file, and
 * the path the publish writes it to.
 */
async function rewrittenSheetAt(
  params: BuildPublishParams,
  role: SiteSheetRole,
  file: UnreadablePublishFileError["file"],
): Promise<ExistingSheet> {
  const { path, file: read } = await siteSheetAt(params, role);
  if (read.status === "error") throw new UnreadablePublishFileError(file, path);
  return { path, content: read.status === "ok" ? read.content.replace(/^\uFEFF/, "") : null };
}

/** GitHub's glossary sheet as the publish reads it, and whether its bytes are not valid UTF-8. */
interface ExistingGlossary extends ExistingSheet {
  lossy: boolean;
}

/**
 * GitHub's glossary.csv at the publish's revision. With terms in D1 it is read
 * as every rewritten file is (`rewrittenFileAt`), a failed read refusing the
 * publish. With none, it is read only to learn whether its bytes are valid
 * UTF-8: the framework stops the build on a glossary.csv they are not, and
 * the publish then writes the file without terms. A failed read there writes
 * nothing and refuses nothing, as the publish did before it read the file.
 */
async function glossaryForAssembly(params: BuildPublishParams, hasTerms: boolean): Promise<ExistingGlossary> {
  if (hasTerms) {
    const sheet = await rewrittenSheetAt(params, "glossary", "glossary");
    if (params.glossaryReadFrom) params.glossaryReadFrom.path = sheet.path;
    return { ...sheet, lossy: false };
  }
  const { path, file: read } = await siteSheetAt(params, "glossary");
  if (params.glossaryReadFrom) params.glossaryReadFrom.path = path;
  if (read.status !== "ok" || !read.lossy) return { path, content: null, lossy: false };
  return { path, content: read.content.replace(/^\uFEFF/, ""), lossy: true };
}

/**
 * The glossary.csv the publish writes: D1's terms over GitHub's comment and
 * instruction rows; with no terms, the header, the bilingual row and GitHub's
 * comment rows when GitHub's copy is not valid UTF-8, which the framework
 * builds with no glossary pages; else nothing.
 */
function glossaryFiles(
  terms: Parameters<typeof serializeGlossaryCsv>[0],
  existing: ExistingGlossary,
): CommitFile[] {
  if (terms.length === 0 && !existing.lossy) return [];
  return [{ path: writtenSheetPath("glossary"), content: serializeGlossaryCsv(terms, existing.content ?? undefined, existing.lossy) }];
}

/**
 * The `_config.yml` this assembly edits: the one the caller already read at the
 * same ref, or a read of its own when the caller made none.
 *
 * Two reads of one path are two chances to disagree, and the publish action
 * reads this file to judge whether it can write the managed blocks at all — so
 * the file it judged is the file edited here.
 */
async function configForAssembly(params: BuildPublishParams): Promise<string | null> {
  if (params.configYml !== undefined) return params.configYml;
  return fileAtRef(params.token, params.owner, params.repo, "_config.yml", params.ref);
}

/**
 * The `project_config` row this assembly writes from: the one the caller
 * already read, or a read of its own when the caller made none.
 *
 * Two reads of one row are two chances to disagree, and the row is half of
 * what decides whether a config is written at all — a settings save landing
 * between them is enough to turn a check that passed into a write silently
 * skipped. So the row the check judged is the row written from here.
 */
async function configRowForAssembly(
  params: BuildPublishParams,
  db: ReturnType<typeof getDb>,
): Promise<typeof project_config.$inferSelect | undefined> {
  if (params.config !== undefined) return params.config ?? undefined;
  const rows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, params.projectId))
    .limit(1);
  return rows[0];
}

/** A step row as `renderStoryFiles` reads it. */
export type StoryStepRow = Pick<
  typeof steps.$inferSelect,
  | "id" | "step_number" | "kind" | "object_id" | "x" | "y" | "zoom" | "page" | "question"
  | "answer" | "alt_text" | "clip_start" | "clip_end" | "loop" | "extra_columns"
>;

/** A layer row as `renderStoryFiles` reads it. */
export type StoryLayerRow = Pick<
  typeof layers.$inferSelect,
  "step_id" | "layer_number" | "title" | "button_label" | "content"
>;

/**
 * One story's committed files: its step CSV at
 * `telar-content/spreadsheets/{storySlug}.csv` and the layer files that CSV
 * names under `telar-content/texts/stories/`, with the bytes a publish commits.
 *
 * Without `existingCsv` this is the plain render, which every reader comparing
 * D1 with the repository uses. With it, the CSV is written in that file's
 * layout (`serializeStory`), which only the publish asks for.
 *
 * The content is already what the commit primitive sends: `cleanCommitContent`
 * is applied here, and applying it again at the commit changes nothing. A
 * caller comparing D1 with the repository (the change check, the no-base blob
 * comparison) hashes or parses exactly what the publish writes, so this is the
 * only place those files are rendered and `buildPublishFileSet` calls it.
 */
export async function renderStoryFiles(
  storySlug: string,
  stepRows: StoryStepRow[],
  layerRows: StoryLayerRow[],
  siteLang = "en",
  existingCsv?: string,
): Promise<CommitFile[]> {
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
    extra_columns: step.extra_columns,
    layers: layerRows
      .filter((l) => l.step_id === step.id)
      .map((l) => ({
        layer_number: l.layer_number,
        title: l.title ?? null,
        button_label: l.button_label ?? null,
        content: l.content ?? null,
      })),
  }));

  // Story CSV + the layer files it references — produced together in one
  // pass so filename assignment happens exactly once. The file-writing loop
  // below uses serializeStory's `layerFiles` directly, so a file's path can
  // never disagree with the CSV's `layerN_content` cell.
  const { csv, layerFiles } = serializeStory(stepsWithLayers, storySlug, existingCsv, siteLang);
  const files: CommitFile[] = [
    { path: `telar-content/spreadsheets/${storySlug}.csv`, content: csv },
  ];

  // Layer markdown files — one per CSV-referenced layer, using the exact
  // filename + content the CSV recorded.
  for (const layerFile of layerFiles) {
    files.push({
      path: `telar-content/texts/stories/${layerFile.filename}`,
      content: await layerFileContent(layerFile.title, layerFile.content),
    });
  }
  return files.map((f) => ({ path: f.path, content: cleanCommitContent(f.path, f.content) }));
}

const STORY_SHEETS_DIR = "telar-content/spreadsheets";

/**
 * The spreadsheets subtree at the publish ref, as file name to blob SHA,
 * listed once for every story. Empty, and not listed, when there are no
 * stories, and empty when the directory is absent. A listing
 * that cannot be trusted, or a request that fails, refuses the publish, since
 * a story file it fails to show is a file the publish would overwrite unread.
 */
async function storySheetsAt(params: BuildPublishParams, storyCount: number): Promise<Map<string, string>> {
  if (storyCount === 0) return new Map();
  const listing = await listStorySheets(params).catch(() => null);
  if (listing === null) throw new UnreadablePublishFileError("stories", STORY_SHEETS_DIR);
  return listing;
}

/** The listing `storySheetsAt` takes, or null when it cannot be trusted. */
export async function listStorySheets(
  params: Pick<BuildPublishParams, "token" | "owner" | "repo" | "ref">,
): Promise<Map<string, string> | null> {
  const { token, owner, repo, ref } = params;
  const trees = await getSubtreeOids(token, owner, repo, [ref], [STORY_SHEETS_DIR]);
  if (!trees.ok) return null;
  const at = trees.at(ref, STORY_SHEETS_DIR);
  if (at.kind === "absent") return new Map();
  if (at.kind !== "tree") return null;
  return (await listSubtreeEntries(token, owner, repo, at.oid))?.files ?? null;
}

/** The CSV a story whose ID changed was last written to (its `source_path`), when the listing holds it. */
function previousStorySheet(sheets: ReadonlyMap<string, string>, storySlug: string, sourcePath: string | null): string | null {
  const prefix = `${STORY_SHEETS_DIR}/`;
  if (!sourcePath?.startsWith(prefix)) return null;
  const name = sourcePath.slice(prefix.length);
  return name !== `${storySlug}.csv` && sheets.has(name) ? sourcePath : null;
}

/**
 * The sheet a story is laid out from, or null for the plain render. A file is
 * a story's when its `source_path` names it, which a publish records for every
 * story it writes; a file at an ID is no evidence of whose it is, since a story
 * deleted or renamed leaves its file at an ID another story may take. So: the
 * file at its ID when its own record names it; else its recorded file, when
 * listed and no other story records it; else the file at its ID, when no other
 * story records it. NULL, a story never published, claims no file.
 */
function layoutSheetFor(
  sheets: ReadonlyMap<string, string>,
  story: { story_id: string; source_path: string | null },
  path: string,
  others: ReadonlyArray<{ story_id: string; source_path: string | null }>,
): string | null {
  const own = sheets.has(`${story.story_id}.csv`);
  if (own && story.source_path === path) return path;
  const claimedByAnother = (p: string) => others.some((o) => o.source_path === p);
  const previous = previousStorySheet(sheets, story.story_id, story.source_path);
  if (previous !== null && !claimedByAnother(previous)) return previous;
  return own && !claimedByAnother(path) ? path : null;
}

/**
 * A story's files as the publish commits them. The plain render, unless the
 * story's CSV at the publish ref is another blob: then the file is read
 * strictly and the story rendered again in its layout. Equal blobs mean the
 * file holds nothing the render does not, so it is not read. A story with no
 * CSV of its own whose ID changed is rendered in the layout of the CSV it was
 * last written to (`previousStorySheet`); see `layoutSheetFor` for when that
 * file is preferred to one at its ID. A read that fails, or a listed file
 * that reads as absent, refuses the publish naming the story.
 */
async function storyFilesForPublish(
  params: BuildPublishParams,
  sheets: ReadonlyMap<string, string>,
  story: { story_id: string; source_path: string | null },
  others: ReadonlyArray<{ story_id: string; source_path: string | null }>,
  stepRows: StoryStepRow[],
  layerRows: StoryLayerRow[],
  siteLang: string,
): Promise<CommitFile[]> {
  const storySlug = story.story_id;
  const plain = await renderStoryFiles(storySlug, stepRows, layerRows, siteLang);
  const path = `${STORY_SHEETS_DIR}/${storySlug}.csv`;
  const layoutPath = layoutSheetFor(sheets, story, path, others);
  if (layoutPath === null) return plain;
  const plainCsv = plain.find((f) => f.path === path);
  const layoutSha = sheets.get(layoutPath.slice(STORY_SHEETS_DIR.length + 1));
  if (plainCsv !== undefined && (await gitBlobSha(plainCsv.content)) === layoutSha) return plain;
  const read = await getFileAtRef(params.token, params.owner, params.repo, layoutPath, params.ref, { strict: true });
  if (read.status !== "ok") throw new UnreadablePublishFileError("stories", layoutPath);
  noteHeadings(params, "story", layoutPath, read.content);
  return renderStoryFiles(storySlug, stepRows, layerRows, siteLang, read.content);
}

/**
 * Raised by the file set for a story whose CSV, as written from the steps and
 * layers the file set read, carries columns the story column blockers refuse.
 * The publish validates an earlier read of the same rows, and a step or panel
 * saved between the two can give the CSV such columns; the build would refuse
 * the file, so nothing is written and the checks name the columns.
 */
export class StoryColumnsBlockedError extends Error {
  constructor(readonly storyId: string) {
    super(`the columns of story "${storyId}" changed after the checks and are refused`);
    this.name = "StoryColumnsBlockedError";
  }
}

/** Throws `StoryColumnsBlockedError` when the story CSV these rows write carries refused columns. */
function refuseBlockedStoryColumns(
  story: { story_id: string; title: string | null },
  stepRows: StoryStepRow[],
  layerRows: StoryLayerRow[],
): void {
  const judged = stepRows.map((step) => ({ ...step, story_id: story.story_id, story_title: story.title }));
  if (storyColumnBlockers(judged, layerRows).length > 0) throw new StoryColumnsBlockedError(story.story_id);
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
  const { token, owner, repo, ref, projectId, env } = params;
  const db = getDb(env.DB);

  // Fetch all required D1 data
  const [
    storyRows,
    config,
    landingRow,
    objectRows,
    glossaryRows,
  ] = await Promise.all([
    db.select().from(stories).where(eq(stories.project_id, projectId)),
    configRowForAssembly(params, db),
    landingRowsFor(db, projectId, params.landing),
    db.select().from(objects).where(eq(objects.project_id, projectId)).orderBy(objectsSheetOrder()),
    db
      .select({ term_id: glossary_terms.term_id, title: glossary_terms.title, definition: glossary_terms.definition, related_terms: glossary_terms.related_terms, kind: glossary_terms.kind, extra_columns: glossary_terms.extra_columns })
      .from(glossary_terms)
      .where(eq(glossary_terms.project_id, projectId))
      .orderBy(glossarySheetOrder()),
  ]);

  const landing = landingRow[0];

  // Fetch repo files for comment/format preservation, every one of them at the
  // one revision this publish is built from.
  const [existingConfigYml, existingObjects, existingIndexMd, existingGlossaryCsv, existingProject] =
    await Promise.all([
      configForAssembly(params),
      objectsCsvForAssembly(params),
      rewrittenFileAt(params, landing !== undefined, "index.md", "landing"),
      glossaryForAssembly(params, glossaryRows.length > 0),
      rewrittenSheetAt(params, "project", "project"),
    ]);

  const files: CommitFile[] = [];
  noteHeadings(params, "project", existingProject.path, existingProject.content);
  noteHeadings(params, "objects", existingObjects.path, existingObjects.content);
  noteHeadings(params, "glossary", existingGlossaryCsv.path, existingGlossaryCsv.content);

  // --- _config.yml ---
  // healConfigYaml escapes managed fields and self-heals orphaned multi-line
  // scalars left by the pre-fix serializer, so a user's next publish repairs a
  // previously-broken site through the normal build pipeline. Hygiene gate: the
  // result is parsed before committing — if it somehow still isn't valid YAML
  // (a corruption shape beyond the line-based heal), the config write is skipped
  // rather than committing broken YAML or overwriting the user's settings. The
  // repo's current _config.yml is left untouched and the rest of the publish
  // still proceeds; `config_unparseable` is what tells the author, raised by
  // `runPrePublishValidation` off this same function before a publish starts.
  // The log line is for a publish that reached here anyway.
  if (existingConfigYml && config) {
    const updatedConfig = publishableConfigYaml(existingConfigYml, config);
    if (updatedConfig !== null) {
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
      extra_columns: s.extra_columns ?? null,
    })),
    existingProject.content,
  );
  files.push({
    path: writtenSheetPath("project"),
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
    existingObjects.content ?? undefined,
  );
  files.push({
    path: writtenSheetPath("objects"),
    content: objectsCsvContent,
  });

  // --- Per-story CSVs and layer files ---
  const sheets = await storySheetsAt(params, storyRows.length);
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

    // Fetch layers one step at a time to avoid IN clause complexity with D1
    const layerRows: (typeof layers.$inferSelect)[] = [];
    for (const step of stepRows) {
      layerRows.push(...(await db.select().from(layers).where(eq(layers.step_id, step.id))));
    }

    refuseBlockedStoryColumns(story, stepRows, layerRows);
    files.push(...(await storyFilesForPublish(params, sheets, story, storyRows.filter((o) => o !== story), stepRows, layerRows, config?.lang ?? "en")));
  }

  // --- index.md ---
  if (landing) {
    const indexContent = indexMdForPublish(existingIndexMd, landing);
    files.push({ path: "index.md", content: indexContent });
  }

  // The page rows are read before the menu, which resolves its entries
  // against them; their files are written last, below.
  const pageRows = await withCarriedFrontmatter(await pagesFor(db, projectId, params.pages), params);

  // --- navigation.yml ---
  files.push(...navigationFiles(config?.navigation_json ?? null));

  // --- glossary.csv ---
  files.push(...glossaryFiles(glossaryRows, existingGlossaryCsv));

  // --- page markdown files ---
  // Empty-slug rows are skipped inside pageRowsToCommitFiles so a
  // nameless page never produces `telar-content/texts/pages/.md`.
  files.push(...(await pageRowsToCommitFiles(pageRows)));

  return files;
}

// ---------------------------------------------------------------------------
// Navigation YAML serializer
// ---------------------------------------------------------------------------

/**
 * `_data/navigation.yml`, from the settings row the rest of the assembly
 * writes from, so the menu and _config.yml are one settings state. No file
 * when there is no menu or its JSON does not parse.
 *
 * Only the parse is guarded. A render failure is a programming error in the
 * template, not a malformed stored value, and must not be swallowed into "no
 * navigation file" — a publish that quietly dropped the menu would be worse
 * than one that failed.
 */
function navigationFiles(navigationJson: string | null): CommitFile[] {
  if (!navigationJson) return [];
  let navItems: NavItem[];
  try {
    navItems = JSON.parse(navigationJson) as NavItem[];
  } catch {
    return [];
  }
  if (!navItems || navItems.length === 0) return [];
  return [{ path: "_data/navigation.yml", content: buildNavigationYml(navItems) }];
}

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
 *
 * Built line by line rather than rendered: the entries are an indented YAML
 * block sequence, and the note above LAYER_FILE_TEMPLATE says why a template
 * cannot carry that indentation without padding written to be eaten. Every
 * scalar goes through the shared escaper by way of yamlQuote, URLs included.
 *
 * A page item's URL is the address the site serves the page at, Jekyll's
 * `:name` of its file name (`siteAddressOfPage`), not the slug: an imported
 * page keeps a file name such as `Credits.md` or `credits_two.md`, served at
 * `/credits/` and `/credits-two/`. The address has only letters, digits and
 * hyphens, but it is quoted like every other scalar rather than relying on a
 * producer to have cleaned it.
 */
export function buildNavigationYml(navItems: NavItem[]): string {
  const visible = navItems.filter((i) => i.visible !== false);
  const lines = ["menu:"];
  for (const item of visible) {
    const label = yamlQuote(item.label ?? "");
    if (item.type === "page") {
      lines.push(`  - title_en: ${label}`);
      lines.push(`    titulo_es: ${label}`);
      lines.push(`    url: ${yamlQuote(`/${siteAddressOfPage(item.slug ?? "")}/`)}`);
    } else if (item.type === "builtin") {
      const key = item.key ?? "";
      // Own-property lookup so inherited keys (e.g. "__proto__") can't resolve to
      // a truthy non-entry and crash on the undefined label below.
      const builtin = Object.hasOwn(BUILTIN_NAV, key) ? BUILTIN_NAV[key] : undefined;
      if (!builtin) continue; // home / unknown builtins are intentionally not emitted
      lines.push(`  - title_en: ${yamlQuote(builtin.en)}`);
      lines.push(`    titulo_es: ${yamlQuote(builtin.es)}`);
      // A built-in URL is a module constant and needs no quoting; quoted
      // anyway so every scalar on this path goes through one escaper and a
      // reader does not have to work out which ones were exempt.
      lines.push(`    url: ${yamlQuote(builtin.url)}`);
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

export { GLOSSARY_CSV_COLUMNS };

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
// `col` here can be a custom column name from a user's own glossary.csv (see
// `extraKeys` in serializeGlossaryCsv below) — a file-supplied string, so a
// lookup on a plain object literal would return an inherited property for
// keys like `__proto__` or `constructor` instead of `undefined`. This line
// removes every inherited property so a lookup here can only ever return
// one of the entries above, or `undefined`.
Object.setPrototypeOf(GLOSSARY_BILINGUAL_ROW, null);

/**
 * The custom-column keys a glossary.csv actually carries, in the order it
 * carries them: the sorted union of every term's blob, less the keys this
 * serializer drops.
 *
 * An extras key that folds onto a fixed column is dropped rather than emitted:
 * it would put one header in the file twice and leave the framework holding two
 * columns of one name.
 *
 * One function, because the publish check that predicts what the framework will
 * make of this file has to predict on the headers the file WILL have. A check
 * reading the unfiltered union refuses a publish over a column this never
 * writes, and names a single spelling the author has no second copy of to
 * delete.
 */
export function glossaryExtraColumnKeys(parsedRows: Array<Record<string, string>>): string[] {
  const fixedFolded = new Set<string>(GLOSSARY_CSV_COLUMNS.map(foldHeader));
  return extraColumnUnion(parsedRows).filter((key) => !fixedFolded.has(foldHeader(key)));
}

/**
 * A term's kept columns as the file writes them: its passthrough blob with the
 * entry's `kind` among them, the one column the framework reads under two
 * names. `kind` is no fixed column, so the file's own header for it is kept
 * (`keepsFileHeader`) and a file without one gets `kind`.
 */
export function glossaryKeptBlob(t: { extra_columns?: string | null; kind?: string | null }): string | null {
  if (!t.kind) return t.extra_columns ?? null;
  return JSON.stringify({ ...parseExtraColumns(t.extra_columns), kind: t.kind });
}

/** A glossary.csv row that publishes no term (`isHeldTermId`), held where the file has it. */
export interface HeldGlossaryRow {
  row: CsvSourceRow;
  /** Its term_id and title as the import reads them, which pair it with a D1 term of the same held id (`pairedHeldTerms`). */
  termId: string;
  title: string;
  /** Its cells under the names the import gives their columns, for a layout other than the file's. */
  fields: Record<string, string>;
  /** The ids of the term rows above it, in file order. */
  above: string[];
}

/**
 * The rows of `existingCsv` that publish no term, which the import makes no
 * term of (`mapGlossaryCsv`) and a publish writes back where they were. Data
 * rows are told from comment, bilingual and blank rows by the importer's own
 * classifier and paired with the importer's rows by position, as
 * `removeObjectRecord` pairs objects.csv's. A file where the two do not pair
 * throws `CsvCommentExtractionError`, since publishing would drop its held
 * rows, and so does a held row Papa refused, whose characters cannot be
 * carried.
 */
export function heldGlossaryRows(existingCsv: string, reading: CsvSourceReading): HeldGlossaryRow[] {
  const table = reading.rows.map((row) => row.cells);
  if (table.length === 0) return [];
  const isSkipped = createCsvRecordSkipDetector(false, instructionHeaderOf(table), GLOSSARY_COLUMN_ALIASES);
  const data = reading.rows.slice(1).filter((row) => !isSkipped(row.cells, table[0].length).skip);
  const imported = parseTelarCsv(existingCsv, undefined, false, GLOSSARY_CANONICAL_SCOPE);
  const cannotCarry = () =>
    new CsvCommentExtractionError(
      "The existing glossary.csv's rows could not be paired with the terms read from it, so the rows " +
        "that publish no term cannot be carried through. Publishing would drop them.",
    );
  if (data.length !== imported.length) throw cannotCarry();
  const names = importedColumnNames(table, GLOSSARY_CANONICAL_SCOPE);
  const above: string[] = [];
  const held: HeldGlossaryRow[] = [];
  data.forEach((row, i) => {
    const termId = imported[i].term_id ?? "";
    if (!isHeldTermId(termId)) above.push(termId);
    else if (row.rejected) throw cannotCarry();
    else {
      const fields = Object.create(null) as Record<string, string>;
      names.forEach((name, position) => {
        if (name !== undefined) fields[name] = row.cells[position] ?? "";
      });
      held.push({ row, fields, termId, title: imported[i].title ?? "", above: above.slice() });
    }
  });
  return held;
}

/**
 * The layout of the file `reading` was taken from for D1's `keptKeys`, with
 * `held` carried, or null when it has no header record or Papa refused it.
 */
export function fileGlossaryLayout(
  reading: CsvSourceReading,
  keptKeys: readonly string[],
  held: readonly HeldGlossaryRow[],
): SheetCsvLayout | null {
  const heldRows = new Set(held.map((h) => h.row));
  const terms = { ...reading, rows: reading.rows.filter((row) => !heldRows.has(row)) };
  const records = held.map((h) => ({ text: h.row.range.text, cells: h.row.cells }));
  return fileSheetLayout(csvSheetFor("glossary"), terms, commentRecordsOf(reading, true), keptKeys, records);
}

/**
 * The D1 term written in each held row's place, by index into `held` and into
 * `terms`: a term whose id publishes none (`isHeldTermId`), from before the
 * import held such rows aside, paired with the first unpaired held row whose
 * id opens `#` and equals its own once both are stripped, or, for a blank id,
 * whose title equals its own. Each term pairs with at most one row and each
 * row with at most one term, so a publish writes such a term once however
 * often it runs.
 */
function pairedHeldTerms(
  held: readonly HeldGlossaryRow[],
  terms: ReadonlyArray<{ term_id: string; title: string | null }>,
): Map<number, number> {
  const paired = new Map<number, number>();
  const taken = new Set<number>();
  held.forEach((h, k) => {
    const blank = pythonStrip(h.termId) === "";
    const at = terms.findIndex(
      (t, i) =>
        !taken.has(i) &&
        isHeldTermId(t.term_id) &&
        (blank ? pythonStrip(t.term_id) === "" && (t.title ?? "") === h.title : pythonStrip(t.term_id) === pythonStrip(h.termId)),
    );
    if (at < 0) return;
    taken.add(at);
    paired.set(k, at);
  });
  return paired;
}

/**
 * The data lines of glossary.csv: each term's line, with each held row after
 * the nearest term above it in the file that D1 still holds, or before every
 * term when none is.
 */
function glossaryDataLines(
  termIds: readonly string[],
  termLines: string[],
  held: readonly HeldGlossaryRow[],
  heldLines: string[],
): string[] {
  const lastAt = new Map(termIds.map((id, i) => [id, i]));
  const before: string[] = [];
  const after = new Map<number, string[]>();
  held.forEach((h, k) => {
    let at = -1;
    for (let j = h.above.length - 1; j >= 0 && at < 0; j--) at = lastAt.get(h.above[j]) ?? -1;
    if (at < 0) before.push(heldLines[k]);
    else after.set(at, [...(after.get(at) ?? []), heldLines[k]]);
  });
  return [...before, ...termLines.flatMap((line, i) => [line, ...(after.get(i) ?? [])])];
}

/**
 * Serialises glossary terms to a CSV string suitable for glossary.csv.
 *
 * Output structure mirrors serializeObjectsCsv (SSOT alignment):
 *   Line 1: English header row (column names)
 *   Line 2: Spanish bilingual row
 *   Lines 3+: Comment/instruction rows (preserved from existing CSV)
 *   Remaining: Data rows (one per term), with the existing CSV's rows that
 *              publish no term back where they were (`heldGlossaryRows`)
 *
 * With an existing file, in that file's own layout (`fileGlossaryLayout`).
 * Without one, or where `chosenSheetLayout` refuses the file's layout, or
 * when `lossy` says its bytes are not valid UTF-8 (its decoded header may hold
 * U+FFFD), the fixed columns, the kept keys, and the file's comment rows as
 * `extractCommentRows` reads them.
 *
 * Built via Papa.unparse, which quotes only fields that need it per RFC 4180.
 * This avoids the latent corruption of the prior hand-built concat, which left
 * `term_id` unquoted — a term_id containing a comma or quote broke the row.
 * Output uses LF line endings.
 *
 * @param terms Glossary terms to serialise
 * @param existingCsv Optional existing CSV content — comment rows are extracted
 *                    and preserved in the output
 * @param lossy Whether `existingCsv` is not valid UTF-8
 */
export function serializeGlossaryCsv(
  terms: Array<{
    term_id: string;
    title: string | null;
    definition: string | null;
    related_terms: string | null;
    /** The entry's kind, written as the sheet's kind column. */
    kind?: string | null;
    /** JSON passthrough blob of custom columns not mapped to first-class fields. */
    extra_columns?: string | null;
  }>,
  existingCsv?: string,
  lossy = false,
): string {
  // Parse extras once per row, then take the keys the file carries. Both steps
  // are the shared implementations serializeObjectsCsv uses, so the two files
  // order custom columns identically and read a corrupt blob identically.
  const allParsed = terms.map((t) => parseExtraColumns(glossaryKeptBlob(t)));
  const extraKeys = glossaryExtraColumnKeys(allParsed);

  const normalise = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Data rows, built column by column — never a spread of the parsed extras
  // over the fixed fields, which would let an extras key named after a fixed
  // column overwrite that column's real value. Null-prototype records, because
  // a custom column can be named `constructor` or `__proto__` and a row lacking
  // it would otherwise publish the inherited value (see `csvDataRow`).
  const dataRows = terms.map((t, i) => {
    // Null-prototype from the start: `fields["__proto__"] = v` on a plain
    // object sets the prototype instead of creating a property, so a custom
    // column by that name would be lost before csvDataRow ever saw it.
    const fields: Record<string, string> = Object.create(null);
    fields.term_id = t.term_id;
    fields.title = t.title ?? "";
    fields.definition = t.definition ?? "";
    fields.related_terms = t.related_terms ?? "";
    for (const key of extraKeys) fields[key] = allParsed[i][key] ?? "";
    return csvDataRow(fields);
  });

  const reading = existingCsv ? readCsvForComments(existingCsv) : null;
  const held = existingCsv && reading ? heldGlossaryRows(existingCsv, reading) : [];
  // A D1 term paired with a held row is written once, in that row's place
  // with D1's values; it is not also written among the terms.
  const paired = pairedHeldTerms(held, terms);
  const inHeldPlace = new Set(paired.values());
  // The plain layout writes a held row from its cells by column name, so it
  // carries every column a held row fills as well as D1's: a cell under a
  // column no term fills would otherwise have no column to go under.
  const fixedColumns = new Set<string>(GLOSSARY_CSV_COLUMNS);
  const plainKeys = glossaryExtraColumnKeys([
    ...allParsed,
    ...held.map((h) => collectExtraColumns(h.fields, fixedColumns).extras),
  ]);
  const layout = chosenSheetLayout(
    "glossary.csv",
    reading && !lossy ? fileGlossaryLayout(reading, extraKeys, held) : null,
    () => plainSheetLayout(GLOSSARY_CSV_COLUMNS, plainKeys, existingCsv ? extractCommentRows(existingCsv) : []),
    GLOSSARY_CSV_COLUMNS,
    extraKeys,
    // A term whose id publishes none is not judged: a first cell that reads as
    // a comment drops a row the framework would skip anyway.
    dataRows.filter((_, i) => !isHeldTermId(terms[i].term_id)),
  );

  // Header record. Every section of this file is unparsed as a complete record
  // set, never cut out of a larger one by splitting on a newline: a custom
  // column's header is the author's own text and a quoted CSV header may hold a
  // newline, so a section taken as the text up to the first physical newline
  // ends mid-record and the bilingual row lands inside the header's own quotes.
  const headerCsv = normalise(Papa.unparse([layout.columns.map((c) => c.header)], { header: false }));

  // Spanish bilingual second row, by the fixed column's name whatever header
  // the file gives it. A custom column gets an EMPTY cell rather than echoing
  // its key: every header detector that reads this file excludes an empty cell
  // from its known-bilingual ratio, the Compositor's own `isHeaderRow` and the
  // framework's `is_header_row` alike (a blank is skipped on the test instance
  // and never seen at the published tag, whose readers infer NA), so the ratio
  // stays 1.0 however many custom columns there are. Echoing the keys would
  // dilute it below the 0.8 threshold and the row would be ingested as a term
  // whose term_id is "id_término".
  const bilingualRow = normalise(
    Papa.unparse(
      [layout.columns.map((c) => (c.source.kind === "fixed" ? (GLOSSARY_BILINGUAL_ROW[c.source.name] ?? "") : ""))],
      { header: false },
    ),
  );

  const line = (fields: Record<string, string>) =>
    normalise(Papa.unparse([layout.columns.map((c) => cellOf(c.source, fields))], { header: false }));
  // A plain layout has no held rows of its own: each is written from its
  // cells by column name, so its id stays under term_id and is not published.
  const heldLines = (layout.heldRows ?? held.map((h) => line(h.fields))).map((text, k) => {
    const at = paired.get(k);
    return at === undefined ? text : line(dataRows[at]);
  });
  // In a file whose first column is term_id, a row whose id opens `#` reads as
  // a comment row, so a D1 term with such an id that a publish wrote there
  // comes back as one. It is written in that row's place, as a held row's
  // pair is, or each publish would add another copy.
  const commentRows =
    reading && opensWithTermId(reading)
      ? layout.commentRows.map((text) => {
          const id = pythonStrip(firstCellOf(text));
          const at = terms.findIndex(
            (t, i) => !inHeldPlace.has(i) && isCommentCell(t.term_id) && pythonStrip(t.term_id) === id,
          );
          if (at < 0) return text;
          inHeldPlace.add(at);
          return line(dataRows[at]);
        })
      : layout.commentRows;
  const termIndices = terms.map((_, i) => i).filter((i) => !inHeldPlace.has(i));
  const dataCsv = glossaryDataLines(
    termIndices.map((i) => terms[i].term_id),
    termIndices.map((i) => line(dataRows[i])),
    held,
    heldLines,
  ).join("\n");

  return [headerCsv, bilingualRow, ...commentRows, dataCsv].join("\n") + "\n";
}

/** Whether the import reads the first column of the file `reading` was taken from as term_id. */
function opensWithTermId(reading: CsvSourceReading): boolean {
  return importedColumnNames(reading.rows.map((row) => row.cells), GLOSSARY_CANONICAL_SCOPE)[0] === "term_id";
}

/** The first cell of one written CSV record. */
function firstCellOf(text: string): string {
  return Papa.parse<string[]>(text, { header: false }).data[0]?.[0] ?? "";
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
/**
 * Page markdown for a page with no kept front matter: a frontmatter map, then
 * the body. A page that keeps its block is written by
 * `KEPT_FRONTMATTER_PAGE_TEMPLATE` below instead.
 *
 * The loop always carries at least `title`, so it never renders empty and
 * never moves its whitespace toll onto the closing fence.
 */
const PAGE_MARKDOWN_TEMPLATE =
  "---\n{% for field in frontmatter %}\n{{ field.key }}: {{ field.value | yaml_string }}{% endfor %}\n---\n\n{{ body }}\n";

/**
 * Quote a value as a double-quoted YAML scalar.
 *
 * The escaping itself is `escapeYamlString`, shared with the `yaml_string`
 * knap filter, so a scalar spliced into a line here and one rendered from a
 * template escape identically. That escaper covers the code points Ruby
 * Psych — the parser Jekyll runs on this output — rejects or silently
 * corrupts, which a hand-rolled quote/backslash/newline pass does not.
 *
 * Line breaks are preserved rather than normalised, like every other path
 * here; escapeYamlString states why and what was measured.
 */
function yamlQuote(val: string): string {
  return escapeYamlString(val);
}

/**
 * A page whose front matter is kept: the block between its fences, then the
 * body, framed with the block's own line ending.
 */
const KEPT_FRONTMATTER_PAGE_TEMPLATE = "{{ fenced }}{{ eol }}{{ body }}{{ eol }}";

/** What a page with no kept block is written as. */
const TITLE_ALONE: FrontmatterWrite = { kind: "title-alone" };

/**
 * The page file. A kept block is written back with only its title changed
 * (`writePageFrontmatter`); a page with none, one never captured, or one whose
 * block does not parse is written with `title` alone. A block no edit can
 * retitle throws `UnwritablePageFrontmatterError` rather than lose a key.
 *
 * `slug` is the title a block without one already reads as, and names the
 * page in that error.
 *
 * The body is written after one blank line and ends with one newline, as the
 * import trims it: the text around it is not kept.
 */
export async function serializePageMarkdown(
  title: string,
  body: string,
  frontmatter?: string | null,
  slug = "",
): Promise<string> {
  const write = frontmatter ? writePageFrontmatter(frontmatter, title, slug) : TITLE_ALONE;
  if (write.kind === "unwritable") throw new UnwritablePageFrontmatterError(slug);
  if (write.kind === "title-alone") {
    return documentEngine.renderOrThrow(PAGE_MARKDOWN_TEMPLATE, {
      variables: { frontmatter: [{ key: "title", value: title }], body },
    });
  }
  return documentEngine.renderOrThrow(KEPT_FRONTMATTER_PAGE_TEMPLATE, {
    variables: { fenced: fenceFrontmatter(write.block), eol: frontmatterLineEnding(write.block), body },
  });
}

/**
 * The index.md a publish writes: the existing file's frontmatter kept, its
 * managed fields replaced and its body chosen, or a file built from nothing
 * when there is no existing frontmatter to keep.
 *
 * Exported so the round trip from an upgrade's frontmatter merge through a
 * publish can be tested against this path rather than a copy of it.
 */
export function indexMdForPublish(
  existingIndexMd: string | null | undefined,
  landing: Parameters<typeof buildIndexMd>[0],
): string {
  // CRLF as well as LF. A file whose frontmatter this does not match is
  // rebuilt from nothing, so a Windows-edited index.md read as LF-only would
  // lose every line it carries — `layout: index` among them.
  const match = existingIndexMd?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
  if (!match) return buildIndexMd(landing);

  const managedFrontmatterKeys = new Set([
    "stories_heading",
    "stories_intro",
    "objects_heading",
    "objects_intro",
  ]);

  // Preserve non-managed frontmatter keys, replace managed ones. Blank
  // lines drop out here so the rendered block never carries one.
  const preservedLines = match[1].split(/\r?\n/).filter((l) => {
    const key = l.match(/^([^:]+):/)?.[1]?.trim();
    return (!key || !managedFrontmatterKeys.has(key)) && l.trim() !== "";
  });

  // Fall back to the parsed body when landing.welcome_body is the
  // verbatim v1.2.1 default. CRLF-tolerant.
  const useLandingBody =
    landing.welcome_body !== null &&
    landing.welcome_body !== undefined &&
    normalizeBody(landing.welcome_body) !== normalizeBody(V121_BODIES.index);
  // A body that opens with the stock welcome block keeps it; the author's text
  // goes under it.
  const existingBlock = splitWelcomeLiquidBlock(match[2])?.block;
  const body = !useLandingBody
    ? match[2].trim()
    : existingBlock && !splitWelcomeLiquidBlock(landing.welcome_body!)
      ? [existingBlock, landing.welcome_body!.trim()].filter(Boolean).join("\n\n")
      : landing.welcome_body!;
  return renderIndexMd({
    preserved: preservedLines,
    managed: managedLandingFields(landing),
    body,
    // The file already had a frontmatter block; it keeps one even when
    // every line inside it has gone.
    keepEmptyFrontmatter: true,
  });
}

/**
 * The frontmatter fields index.md manages, gated against re-emitting the
 * verbatim v1.2.1 English defaults that survived the upgrade-time D1
 * cleanup on sites that bypassed the compositor's upgrade flow.
 *
 * Both index.md paths — first publish and republish over an existing file —
 * read their managed lines from here, so the gates cannot drift apart
 * between them.
 *
 * Comparison is `===` against the defaults, which is enough for these four
 * short strings; the welcome body needs `normalizeBody` instead and is
 * gated at each call site where the fallback body differs.
 */
function managedLandingFields(landing: {
  stories_heading: string | null;
  stories_intro: string | null;
  objects_heading: string | null;
  objects_intro: string | null;
}): string[] {
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
  return lines;
}

/**
 * Assembles index.md from whatever frontmatter lines the caller has and the
 * body it chose. Every line arrives finished; nothing is escaped here.
 *
 * `keepEmptyFrontmatter` is the republish path's contract: a file that
 * arrived with a frontmatter block keeps one even when nothing is left to
 * put in it. A first publish with no lines writes no block at all.
 */
function renderIndexMd(input: {
  preserved: string[];
  managed: string[];
  body: string;
  keepEmptyFrontmatter: boolean;
}): string {
  const lines = [...input.preserved, ...input.managed];
  if (lines.length === 0 && !input.keepEmptyFrontmatter) return input.body;
  return `---\n${lines.join("\n")}\n---\n\n${input.body}`;
}

/**
 * First-publish path: builds index.md frontmatter + body from the project_landing
 * row when the file does not yet exist on the repo.
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
  // Drop welcome_body when it equals the v1.2.1 default. First-publish
  // path has no parsed-body fallback, so emit empty string.
  const useLandingBody =
    landing.welcome_body !== null &&
    landing.welcome_body !== undefined &&
    normalizeBody(landing.welcome_body) !== normalizeBody(V121_BODIES.index);
  return renderIndexMd({
    // The framework's own lines, which a file written from nothing would
    // otherwise lack: without `layout: index` the page is not the home page.
    preserved: INDEX_MD_FRAMEWORK_LINES,
    managed: managedLandingFields(landing),
    body: useLandingBody ? landing.welcome_body! : "",
    keepEmptyFrontmatter: false,
  });
}

/**
 * The frontmatter the framework ships on `index.md`, as written when the
 * Compositor has no existing file to preserve lines from. The keys are the
 * ones `BUILT_IN_PAGES` declares for the file.
 */
const INDEX_MD_FRAMEWORK_LINES = ["layout: index", "title: Home", "title_key: navigation.home"];

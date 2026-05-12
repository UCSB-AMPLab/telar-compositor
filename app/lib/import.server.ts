/**
 * This file orchestrates the full repo import — validating the Telar site,
 * parsing CSVs (or Google Sheets), scanning for IIIF tiles, and writing
 * everything to D1 in a single batched insert.
 *
 * The entry point is `importRepo`. Every helper used along the way is
 * exported for unit testing — CSV row classifiers, the Sheets-vs-repo
 * branch, the YAML config mapper, the per-table column mappers, the
 * orphan-story detector, and the rollback cascade. They are split out
 * because the import path is the single largest surface where a
 * malformed user repo or an unreachable Google Sheet can corrupt project
 * state, and exhaustive unit coverage was easier than reasoning about
 * the end-to-end flow.
 *
 * One blocking path is critical: when `google_sheets.enabled` is true
 * and the Sheet is inaccessible, the import is aborted and the wizard
 * surfaces an error — there is no fallback to repo CSVs. For sites
 * that use Google Sheets, the Sheet is the source of truth; silently
 * importing whatever stale rows happen to sit in the repo would
 * desynchronise the user's content without them noticing.
 *
 * @version v1.2.0-beta
 */

import Papa from "papaparse";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import { getFileContent, getRepoTree, getRepoHead } from "~/lib/github.server";
import { discoverSheetTabs, fetchSheetCsv } from "~/lib/sheets.server";
import { parseYaml } from "~/lib/yaml.server";
import { isV130WelcomeLiquidBlock } from "~/lib/v130-ingest.server";
import {
  projects,
  project_config,
  project_landing,
  project_themes,
  objects,
  stories,
  steps,
  layers,
  glossary_terms,
  project_members,
  project_invites,
  project_pages,
} from "~/db/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known Spanish bilingual column values used in the second row of Telar CSVs.
 * A row where 80%+ of its non-empty values match this set is treated as the
 * bilingual header row and skipped during import.
 */
const KNOWN_BILINGUAL_VALUES = new Set([
  // objects.csv bilingual row 1 values
  "id_objeto",
  "titulo",
  "destacado",
  "creador",
  "descripcion",
  "url_fuente",
  "periodo",
  "año",
  "tipo_objeto",
  "temas",
  "fuente",
  "credito",
  "miniatura",
  "medio",
  "dimensiones",
  "ubicacion",
  "ubicación",
  // project.csv bilingual row 1 values
  "orden",
  "id_historia",
  "subtitulo",
  "firma",
  "privado",
  "privada",
  "mostrar_secciones",
  // story CSV bilingual row 1 values
  "paso",
  "objeto",
  "x",
  "y",
  "zoom",
  "pagina",
  "pregunta",
  "respuesta",
  "boton1",
  "contenido1",
  "boton2",
  "contenido2",
  // glossary.csv bilingual row 1 values
  "id_término",
  "definicion",
  "definición",
  // objects.csv alt text bilingual value
  "texto_alt",
  // story CSV clip field bilingual values (v1.0.0)
  "inicio_clip",
  "fin_clip",
  "bucle",
  // objects.csv medium_genre bilingual value (v1.0.0 column rename)
  "medio_genero",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportResult {
  valid: boolean;
  validationError?: "not_telar" | "empty_repo" | "already_connected";
  sheetsAccessError?: boolean;
  sheetsPublishedUrl?: string;
  telarVersion?: string;
  projectId?: number;
  project: { imported: boolean; storiesFound: number };
  objects: { imported: number; skipped: number; warnings: string[] };
  stories: { imported: number; warnings: string[] };
  glossary: { imported: number };
  pages: { imported: number };
  themes: {
    imported: number;
    list: Array<{ theme_id: string; name: string | null; swatch_color: string | null }>;
  };
  sheetsEnabled: boolean;
  sheetsDisabled: boolean;
  iiifObjectIds: string[];
  audioObjectIds: string[];
  videoObjectCount: number;
  configFields: Record<string, unknown>;
  /**
   * Story IDs that exist as {id}.csv in telar-content/spreadsheets/ on GitHub
   * but are absent from project.csv AND absent from .compositor-ignored.
   * Consumed by the dashboard loader to drive the orphan-stories banner.
   * Empty when google_sheets is enabled (Sheets-based sites have no per-story
   * CSV files to scan).
   */
  orphanStoryIds: string[];
}

interface ImportParams {
  token: string;
  installationId: number;
  repoFullName: string;
  userId: number;
  env: Env;
  /** Override the Google Sheets URL from _config.yml — used on retry when user corrects the URL */
  overrideGoogleSheetsUrl?: string;
}

// ---------------------------------------------------------------------------
// index.md parser
// ---------------------------------------------------------------------------

export interface LandingData {
  stories_heading?: string;
  stories_intro?: string;
  objects_heading?: string;
  objects_intro?: string;
  welcome_body?: string;
}

/**
 * Parses the content of a Telar `index.md` file and returns the structured
 * landing page data.
 *
 * Extracts four optional frontmatter fields (`stories_heading`,
 * `stories_intro`, `objects_heading`, `objects_intro`) and the markdown body
 * (`welcome_body`). Returns an empty object if the content has no frontmatter
 * delimiters or is null/undefined.
 */
export function parseIndexMd(content: string | null | undefined): LandingData {
  if (!content) return {};
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return {};
  const frontmatter = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  // Recognise the canonical v1.3.0 welcome liquid block and store
  // welcome_body: undefined so the framework default keeps rendering on the
  // live site and the editor textarea stays empty (rather than showing the
  // liquid syntax as if it were user content).
  const rawBody = match[2].trim();
  return {
    stories_heading: frontmatter.stories_heading as string | undefined,
    stories_intro: frontmatter.stories_intro as string | undefined,
    objects_heading: frontmatter.objects_heading as string | undefined,
    objects_intro: frontmatter.objects_intro as string | undefined,
    welcome_body: isV130WelcomeLiquidBlock(rawBody) ? undefined : (rawBody || undefined),
  };
}

// ---------------------------------------------------------------------------
// Page markdown parser
// ---------------------------------------------------------------------------

/**
 * Parses the content of a page markdown file and returns the title and body.
 *
 * Extracts the `title` frontmatter field and the markdown body. If no
 * frontmatter is present, the fallback slug is used as the title.
 */
export function parsePageMarkdown(
  content: string,
  fallbackSlug: string,
): { title: string; body: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { title: fallbackSlug, body: content.trim() };
  const frontmatter = fmMatch[1];
  const body = (fmMatch[2] ?? "").trim();
  const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
  const title = titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, "")
    : fallbackSlug;
  return { title, body };
}

// ---------------------------------------------------------------------------
// Repo page scan
// ---------------------------------------------------------------------------

/**
 * Scans a repository for `telar-content/texts/pages/*.md` files and returns
 * parsed page records. Used by the initial repo import path AND by the Pages
 * editor's empty-state import variant, so projects connected
 * before the page-import path landed — or repos where pages were
 * added externally — can surface their existing pages for explicit import.
 *
 * `order` matches the index in the filtered tree; entries whose content
 * cannot be fetched are skipped without re-indexing the rest, preserving the
 * original order semantics expected by the import path.
 */
export async function scanRepoPages(
  token: string,
  owner: string,
  repo: string,
): Promise<Array<{ slug: string; title: string; body: string; order: number }>> {
  const { tree } = await getRepoTree(token, owner, repo);
  const pagesTree = tree.filter(
    (entry) =>
      entry.type === "blob" &&
      entry.path.startsWith("telar-content/texts/pages/") &&
      entry.path.endsWith(".md"),
  );
  const out: Array<{ slug: string; title: string; body: string; order: number }> = [];
  for (let i = 0; i < pagesTree.length; i++) {
    const entry = pagesTree[i];
    const filename = entry.path.split("/").pop()!;
    const slug = filename.replace(/\.md$/, "");
    const content = await getFileContent(token, owner, repo, entry.path);
    if (content === null) continue;
    const { title, body } = parsePageMarkdown(content, slug);
    out.push({ slug, title, body, order: i });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orphan story detection + .compositor-ignored
// ---------------------------------------------------------------------------

/**
 * Names of CSV files inside `telar-content/spreadsheets/` that are NOT
 * per-story files (the importer treats them as registry files). Anything
 * else with a `.csv` extension in that directory is a story candidate.
 */
const SPREADSHEET_REGISTRY_FILENAMES = new Set([
  "project.csv",
  "objects.csv",
  "glossary.csv",
]);

/**
 * Parses the `.compositor-ignored` newline-delimited list of
 * story IDs that the user has explicitly told the compositor to suppress
 * (per the "Ignore" CTA in the orphan-stories banner).
 *
 * Rules:
 *  - Split on `\n` (CR-LF handled by stripping `\r` per-line via trim).
 *  - Trim each line; drop empty lines.
 *  - Drop lines starting with `#` (allows hand-edited notes in the file).
 *  - Dedupe (preserve first-seen order).
 *  - `contents === null` (missing file) → `[]` (graceful default, no throw).
 */
export function parseCompositorIgnored(contents: string | null): string[] {
  if (!contents) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * Pure orphan-detection logic.
 *
 * Given:
 *  - the story IDs in `project.csv` (the published-stories registry),
 *  - a listing of file names inside `telar-content/spreadsheets/` on GitHub,
 *  - and the IDs the user has previously chosen to ignore,
 *
 * returns the candidate orphan story IDs — those for which a
 * `{story_id}.csv` file exists on GitHub but no corresponding row sits in
 * `project.csv` and no entry sits in `.compositor-ignored`.
 *
 * The function does NOT fetch orphan content; fetches are lazy
 * and happen only when the user clicks "Restore as drafts".
 */
export function detectOrphanStoryIds(opts: {
  projectCsvStoryIds: Set<string>;
  spreadsheetDirListing: string[];
  ignoredIds: Set<string>;
}): string[] {
  const { projectCsvStoryIds, spreadsheetDirListing, ignoredIds } = opts;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const filename of spreadsheetDirListing) {
    if (SPREADSHEET_REGISTRY_FILENAMES.has(filename)) continue;
    if (!filename.endsWith(".csv")) continue;
    const storyId = filename.slice(0, -".csv".length);
    if (storyId === "") continue;
    if (projectCsvStoryIds.has(storyId)) continue;
    if (ignoredIds.has(storyId)) continue;
    if (seen.has(storyId)) continue;
    seen.add(storyId);
    out.push(storyId);
  }
  return out;
}

/**
 * Combined I/O wrapper that fetches the repo tree,
 * filters to direct children of `telar-content/spreadsheets/`, reads
 * `.compositor-ignored` from the repo root (404 = empty list), and returns
 * the orphan story IDs. The published-stories set is supplied by the
 * caller (it knows the parsed `project.csv` row set).
 *
 * Exists as a single export so the importer call site stays a one-liner
 * and the integration is unit-testable against `vi.spyOn` of the two
 * `github.server.ts` helpers.
 *
 * NO content fetch of orphan files happens here — that is lazy until the
 * user clicks "Restore as drafts" in the orphan-stories banner.
 */
export async function scanRepoOrphanStoryIds(
  token: string,
  owner: string,
  repo: string,
  projectCsvStoryIds: Set<string>,
): Promise<string[]> {
  const { tree } = await getRepoTree(token, owner, repo);
  const dirPrefix = "telar-content/spreadsheets/";
  const directChildren: string[] = [];
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    if (!entry.path.startsWith(dirPrefix)) continue;
    const rest = entry.path.slice(dirPrefix.length);
    if (rest === "" || rest.includes("/")) continue; // nested paths excluded
    directChildren.push(rest);
  }
  const ignoredRaw = await getFileContent(token, owner, repo, ".compositor-ignored");
  const ignoredIds = new Set(parseCompositorIgnored(ignoredRaw));
  return detectOrphanStoryIds({
    projectCsvStoryIds,
    spreadsheetDirListing: directChildren,
    ignoredIds,
  });
}

// ---------------------------------------------------------------------------
// D1 batch insert helper
// ---------------------------------------------------------------------------

/**
 * D1 limits bound parameters to 100 per statement. This helper chunks
 * an array of rows into batches that fit within that limit, based on the
 * number of columns each row produces.
 *
 * @param colCount - number of columns in the insert (bound params per row)
 * @param rows - array of row values to insert
 * @returns array of row-arrays, each safe for a single D1 insert
 */
function chunkForD1<T>(colCount: number, rows: T[]): T[][] {
  const maxRows = Math.floor(100 / colCount);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += maxRows) {
    chunks.push(rows.slice(i, i + maxRows));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// CSV parsing helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if 80%+ of the row's non-empty values match known bilingual
 * column names (Spanish translations of the English CSV headers).
 *
 * Mirrors the `is_header_row()` logic in Telar's csv_utils.py.
 */
export function isHeaderRow(row: Record<string, string>): boolean {
  const values = Object.values(row).filter((v) => v.trim() !== "");
  if (values.length === 0) return false;
  const matches = values.filter((v) =>
    KNOWN_BILINGUAL_VALUES.has(v.trim().toLowerCase()),
  );
  return matches.length / values.length >= 0.8;
}

/**
 * Returns true if any cell in the row starts with "#" — these are
 * template instruction rows inserted by the Telar spreadsheet template.
 */
export function isCommentRow(row: Record<string, string>): boolean {
  return Object.values(row).some((v) => v.trim().startsWith("#"));
}

/**
 * Parses a Telar CSV string, skipping bilingual header rows and comment rows.
 *
 * Uses papaparse for robust CSV handling (quoted commas, multiline cells,
 * BOM, encoding edge cases). Returns only actual data rows.
 */
export function parseTelarCsv(csvText: string): Record<string, string>[] {
  const result = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    transform: (v) => v.trim(),
  });
  return result.data.filter((row) => !isHeaderRow(row) && !isCommentRow(row));
}

// ---------------------------------------------------------------------------
// Config mapping
// ---------------------------------------------------------------------------

/**
 * Maps parsed _config.yml fields to the project_config table insert shape.
 *
 * Boolean fields from YAML are passed through as-is (js-yaml coerces
 * `true`/`false` YAML values to JS booleans). The telar.version key is
 * read-only — it is stored for display but never written back to the repo.
 */
export function mapConfigToProjectConfig(
  config: Record<string, unknown>,
): Partial<typeof project_config.$inferInsert> {
  const storyInterface = (config.story_interface ?? {}) as Record<string, unknown>;
  const collectionInterface = (config.collection_interface ?? {}) as Record<string, unknown>;
  const googleSheets = (config.google_sheets ?? {}) as Record<string, unknown>;
  const telarBlock = (config.telar ?? {}) as Record<string, unknown>;

  return {
    title: config.title as string | undefined,
    baseurl: config.baseurl as string | undefined,
    url: config.url as string | undefined,
    theme: config.telar_theme as string | undefined,
    lang: (config.telar_language as string | undefined) ?? "en",
    description: config.description as string | undefined,
    author: config.author as string | undefined,
    email: config.email as string | undefined,
    logo: config.logo as string | undefined,
    telar_version: telarBlock.version as string | undefined,
    // story_interface
    show_on_homepage: storyInterface.show_on_homepage as boolean | undefined,
    show_story_steps: storyInterface.show_story_steps as boolean | undefined,
    show_object_credits: storyInterface.show_object_credits as boolean | undefined,
    include_demo_content: storyInterface.include_demo_content as boolean | undefined,
    // collection_interface
    browse_and_search: collectionInterface.browse_and_search as boolean | undefined,
    show_link_on_homepage: collectionInterface.show_link_on_homepage as boolean | undefined,
    show_sample_on_homepage: collectionInterface.show_sample_on_homepage as boolean | undefined,
    featured_count: collectionInterface.featured_count as number | undefined,
    // story_key
    story_key: config.story_key as string | undefined,
    // google_sheets
    google_sheets_enabled: googleSheets.enabled as boolean | undefined,
    google_sheets_published_url: googleSheets.published_url as string | undefined,
    // collection_mode — top-level YAML scalar
    collection_mode: config.collection_mode as boolean | undefined,
  };
}

// ---------------------------------------------------------------------------
// CSV column mapping
// ---------------------------------------------------------------------------

/**
 * Maps parsed objects.csv rows to the objects table insert shape.
 * The `featured` column accepts "true"/"yes"/"1" — anything else is false.
 */
export function mapObjectsCsv(
  rows: Record<string, string>[],
  projectId?: number,
): Array<typeof objects.$inferInsert> {
  return rows.filter((row) => (row.object_id ?? "").trim() !== "").map((row) => {
    const featuredRaw = (row.featured ?? "").toLowerCase().trim();
    const featured = featuredRaw === "true" || featuredRaw === "yes" || featuredRaw === "1";
    return {
      project_id: projectId ?? 0,
      object_id: row.object_id ?? "",
      title: row.title || undefined,
      featured,
      creator: row.creator || undefined,
      description: row.description || undefined,
      source_url: row.source_url || undefined,
      period: row.period || undefined,
      year: row.year || undefined,
      object_type: row.medium_genre || row.object_type || undefined, // v1.0.0: medium_genre replaces object_type; legacy fallback preserved
      subjects: row.subjects || undefined,
      source: row.source || undefined,
      credit: row.credit || undefined,
      thumbnail: row.thumbnail || undefined,
      alt_text: row.alt_text || row.title || undefined,
      image_available: false,
    };
  });
}

/**
 * Maps parsed project.csv rows to the stories table insert shape.
 * `order` is parsed as integer; `private` as boolean.
 */
export function mapProjectCsv(
  rows: Record<string, string>[],
  projectId?: number,
): Array<typeof stories.$inferInsert> {
  return rows.map((row) => {
    const privateRaw = (row.private ?? "").toLowerCase().trim();
    const isPrivate = privateRaw === "true" || privateRaw === "yes" || privateRaw === "1";

    // show_sections — canonical English column wins over the Spanish
    // mostrar_secciones alias when both are present. Truthy whitelist matches
    // the framework's processors/project.py: yes/true/sí/si (case-insensitive,
    // trimmed). "1" preserved for parity with the private column convention.
    const showSectionsRaw = (row.show_sections ?? row.mostrar_secciones ?? "").toLowerCase().trim();
    const showSections =
      showSectionsRaw === "true" ||
      showSectionsRaw === "yes" ||
      showSectionsRaw === "sí" ||
      showSectionsRaw === "si" ||
      showSectionsRaw === "1";

    return {
      project_id: projectId ?? 0,
      story_id: row.story_id ?? "",
      title: row.title || undefined,
      subtitle: row.subtitle || undefined,
      byline: row.byline || undefined,
      order: parseInt(row.order ?? "0", 10) || 0,
      private: isPrivate,
      show_sections: showSections,
    };
  });
}

/**
 * Maps parsed story CSV rows to steps and layers table insert shapes.
 * step/x/y/zoom are parsed as numbers. Layers are extracted when
 * layer1_button or layer1_content exist (same for layer2).
 *
 * Note: layers use a placeholder step_id of 0 — the caller must update
 * these after inserting steps and retrieving their assigned IDs.
 */

/**
 * Extract title from YAML frontmatter and return { title, body }.
 * Frontmatter is delimited by --- on its own lines at the start of content.
 */
function extractFrontmatterTitle(
  content: string | undefined
): { title: string | undefined; body: string | undefined } {
  if (!content) return { title: undefined, body: undefined };
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { title: undefined, body: content };
  const frontmatter = match[1];
  const body = match[2];
  const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return {
    title: titleMatch ? titleMatch[1] : undefined,
    body: body.trim() || undefined,
  };
}

export function mapStoryCsv(
  rows: Record<string, string>[],
  storyDbId: number,
): { steps: Array<typeof steps.$inferInsert>; layers: Array<typeof layers.$inferInsert> } {
  const stepRows: Array<typeof steps.$inferInsert> = [];
  const layerRows: Array<typeof layers.$inferInsert> = [];

  // Filter out completely blank rows — rows where all meaningful fields are empty.
  // Matches the original Telar Python build behaviour (stories.py).
  const meaningfulFields = [
    "object",
    "question",
    "answer",
    "layer1_button",
    "layer1_content",
    "layer2_button",
    "layer2_content",
  ];
  const nonBlankRows = rows.filter((row) =>
    meaningfulFields.some((f) => row[f]?.trim()),
  );

  nonBlankRows.forEach((row, index) => {
    const stepNumber = parseInt(row.step ?? String(index + 1), 10) || index + 1;
    // Derive kind from object column emptiness. Framework signal in
    // stories.csv is that an empty `object` column on a meaningful row marks
    // the step as a section card; any non-empty object means a media step.
    const objectTrimmed = (row.object ?? "").trim();
    const stepKind: "media" | "section" = objectTrimmed === "" ? "section" : "media";
    const stepRow: typeof steps.$inferInsert = {
      story_id: storyDbId,
      step_number: stepNumber,
      kind: stepKind,
      object_id: row.object || undefined,
      x: row.x ? parseFloat(row.x) : undefined,
      y: row.y ? parseFloat(row.y) : undefined,
      zoom: row.zoom ? parseFloat(row.zoom) : undefined,
      page: row.page || undefined,
      question: row.question || undefined,
      answer: row.answer || undefined,
      clip_start: row.clip_start || undefined,
      clip_end: row.clip_end || undefined,
      loop: row.loop || undefined,
    };
    stepRows.push(stepRow);

    // Use index as placeholder step_id — caller updates after insert
    const placeholderStepId = -(index + 1);

    if (row.layer1_button || row.layer1_content) {
      const { title, body } = extractFrontmatterTitle(row.layer1_content);
      layerRows.push({
        step_id: placeholderStepId,
        layer_number: 1,
        title: title,
        button_label: row.layer1_button || undefined,
        content: body,
      });
    }

    if (row.layer2_button || row.layer2_content) {
      const { title, body } = extractFrontmatterTitle(row.layer2_content);
      layerRows.push({
        step_id: placeholderStepId,
        layer_number: 2,
        title: title,
        button_label: row.layer2_button || undefined,
        content: body,
      });
    }
  });

  return { steps: stepRows, layers: layerRows };
}

// ---------------------------------------------------------------------------
// Main import orchestrator
// ---------------------------------------------------------------------------

/**
 * Imports a Telar repo into D1 content tables.
 *
 * Flow:
 * 1. Fetch _config.yml — validate it's a Telar site (check telar.version)
 * 2. Parse config fields, map to project_config
 * 3. Fetch the full recursive repo tree
 * 4. If google_sheets.enabled: import from Sheets (CRITICAL: if Sheets are
 *    inaccessible, return sheetsAccessError and abort — do NOT fall back to
 *    repo CSVs)
 * 5. Otherwise: import from repo CSVs (objects, project, story files)
 * 6. Scan tree for IIIF object directories
 * 7. Write everything to D1 via db.batch()
 * 8. Return structured ImportResult for the wizard to render
 */

/**
 * Cascade-delete every child row for a project, in dependency order, then
 * the project row itself. Issued as a single `db.batch([...])` for
 * atomicity (D1 documents batched statements as one transaction).
 *
 * Supersedes the prior 6-table enumeration with the
 * comprehensive 12-table cascade — adds
 * `project_pages` (FK to projects, populated by importRepo at line ~1046)
 * which the historical `rollbackProjectImport` body omitted. Without
 * this, deleting a project that had imported pages would leave orphan
 * rows in `project_pages`.
 *
 * Used by:
 *   - rollbackProjectImport (partial-import cleanup; legacy path)
 *   - The delete-project action
 *   - The reimportRepo wipe step
 */
export async function deleteProjectCascade(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle DB type is route-scoped
  db: any,
  projectId: number,
): Promise<void> {
  // Resolve dependent ids first so the cascade can run as a single atomic
  // batch — a worker evicted mid-cascade no longer leaves orphan rows.
  const storyIds = await db
    .select({ id: stories.id })
    .from(stories)
    .where(eq(stories.project_id, projectId));
  const ids = storyIds.map((s: { id: number }) => s.id);

  let stepIds: { id: number }[] = [];
  if (ids.length > 0) {
    stepIds = await db
      .select({ id: steps.id })
      .from(steps)
      .where(inArray(steps.story_id, ids));
  }

  // biome-ignore lint/suspicious/noExplicitAny: drizzle batch tuple typing
  const batchOps: any[] = [];
  if (stepIds.length > 0) {
    batchOps.push(
      db
        .delete(layers)
        .where(inArray(layers.step_id, stepIds.map((s: { id: number }) => s.id))),
    );
  }
  if (ids.length > 0) {
    batchOps.push(db.delete(steps).where(inArray(steps.story_id, ids)));
  }
  batchOps.push(
    db.delete(glossary_terms).where(eq(glossary_terms.project_id, projectId)),
    db.delete(stories).where(eq(stories.project_id, projectId)),
    db.delete(objects).where(eq(objects.project_id, projectId)),
    db.delete(project_themes).where(eq(project_themes.project_id, projectId)),
    db.delete(project_landing).where(eq(project_landing.project_id, projectId)),
    db.delete(project_config).where(eq(project_config.project_id, projectId)),
    // project_pages — added to close an orphan-rows gap.
    // The legacy rollbackProjectImport body omitted this table; importRepo
    // populates it (line ~1046) so any rollback or delete that skipped it
    // left orphan rows.
    db.delete(project_pages).where(eq(project_pages.project_id, projectId)),
    db.delete(project_members).where(eq(project_members.project_id, projectId)),
    db.delete(project_invites).where(eq(project_invites.project_id, projectId)),
    db.delete(projects).where(eq(projects.id, projectId)),
  );

  await db.batch(batchOps);
}

/**
 * Rollback helper: cascade-delete every child row that may have been written
 * during a partial import, in dependency order, then delete the project row
 * itself. Exported so unit tests can record the delete-table sequence
 * directly. Mirrors the unlink cascade in app/routes/onboarding.tsx — keep
 * the two in sync.
 *
 * Now delegates to `deleteProjectCascade` (the shared helper).
 */
export async function rollbackProjectImport(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle DB type is route-scoped
  db: any,
  projectId: number,
): Promise<void> {
  await deleteProjectCascade(db, projectId);
}

export async function importRepo({
  token,
  installationId,
  repoFullName,
  userId,
  env,
  overrideGoogleSheetsUrl,
}: ImportParams): Promise<ImportResult> {
  const [owner, repo] = repoFullName.split("/");

  // -------------------------------------------------------------------------
  // Step 1: Validate Telar site via _config.yml
  // -------------------------------------------------------------------------

  const configContent = await getFileContent(token, owner, repo, "_config.yml");

  if (configContent === null) {
    return {
      valid: false,
      validationError: "empty_repo",
      project: { imported: false, storiesFound: 0 },
      objects: { imported: 0, skipped: 0, warnings: [] },
      stories: { imported: 0, warnings: [] },
      glossary: { imported: 0 },
      pages: { imported: 0 },
      themes: { imported: 0, list: [] },
      sheetsEnabled: false,
      sheetsDisabled: false,
      iiifObjectIds: [],
      audioObjectIds: [],
      videoObjectCount: 0,
      configFields: {},
      orphanStoryIds: [],
    };
  }

  const config = parseYaml(configContent);
  const telarVersion = (config?.telar as Record<string, unknown>)?.version as
    | string
    | undefined;

  if (!telarVersion) {
    return {
      valid: false,
      validationError: "not_telar",
      project: { imported: false, storiesFound: 0 },
      objects: { imported: 0, skipped: 0, warnings: [] },
      stories: { imported: 0, warnings: [] },
      glossary: { imported: 0 },
      pages: { imported: 0 },
      themes: { imported: 0, list: [] },
      sheetsEnabled: false,
      sheetsDisabled: false,
      iiifObjectIds: [],
      audioObjectIds: [],
      videoObjectCount: 0,
      configFields: {},
      orphanStoryIds: [],
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Parse config fields
  // -------------------------------------------------------------------------

  const configFields = mapConfigToProjectConfig(config);
  const googleSheetsEnabled = !!(config.google_sheets as Record<string, unknown>)?.enabled;
  const googleSheetsPublishedUrl =
    overrideGoogleSheetsUrl ||
    ((config.google_sheets as Record<string, unknown>)?.published_url as string) ||
    "";

  // -------------------------------------------------------------------------
  // Step 2b: Fetch and parse index.md for landing page data
  // -------------------------------------------------------------------------

  const indexContent = await getFileContent(token, owner, repo, "index.md");
  const landingData = parseIndexMd(indexContent);

  // -------------------------------------------------------------------------
  // Step 3: Fetch repo tree
  // -------------------------------------------------------------------------

  const { tree, truncated } = await getRepoTree(token, owner, repo);
  const treeWarnings: string[] = [];
  if (truncated) {
    treeWarnings.push("Repository tree was truncated — IIIF tile discovery may be incomplete.");
  }

  // -------------------------------------------------------------------------
  // Step 4: Discover IIIF objects
  // -------------------------------------------------------------------------

  // IIIF and audio detection happens after objectRows are populated (Step 4c below).
  const siteBase = configFields.url
    ? `${configFields.url}${configFields.baseurl ?? ""}`
    : null;
  let iiifObjectIds: string[] = [];
  const audioExtensions = ["mp3", "ogg", "m4a"];
  const audioObjectFiles = new Map<string, string>(); // objectId → filename

  // -------------------------------------------------------------------------
  // Step 4b: Discover themes from _data/themes/*.yml
  // -------------------------------------------------------------------------

  const themeFiles = tree.filter(
    (entry) =>
      entry.type === "blob" &&
      entry.path.startsWith("_data/themes/") &&
      entry.path.endsWith(".yml"),
  );

  const themeRows: Array<typeof project_themes.$inferInsert> = [];
  for (const entry of themeFiles) {
    const content = await getFileContent(token, owner, repo, entry.path);
    if (!content) continue;
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    if (!parsed) continue;
    const filename = entry.path.split("/").pop()!.replace(/\.yml$/, "");
    const colors = parsed.colors as Record<string, Record<string, string>> | undefined;
    themeRows.push({
      project_id: 0, // updated after project insert
      theme_id: filename,
      name: (parsed.name as string) || filename,
      description: (parsed.description as string) || undefined,
      creator: (parsed.creator as string) || undefined,
      creator_url: (parsed.creator_url as string) || undefined,
      swatch_color: colors?.text?.heading || undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: Import content (Sheets or repo CSVs)
  // -------------------------------------------------------------------------

  let objectRows: Array<typeof objects.$inferInsert> = [];
  let storyRows: Array<typeof stories.$inferInsert> = [];
  let stepRows: Array<typeof steps.$inferInsert> = [];
  let layerRows: Array<typeof layers.$inferInsert> = [];
  let glossaryRows: Array<typeof glossary_terms.$inferInsert> = [];
  let pageRows: Array<{ title: string; slug: string; body: string; order: number }> = [];
  let objectWarnings: string[] = [...treeWarnings];
  let storyWarnings: string[] = [];
  let sheetsDisabled = false;
  let storiesFound = 0;

  if (googleSheetsEnabled) {
    // CRITICAL: if the Sheet is inaccessible, abort — do NOT fall back to CSVs
    try {
      const publishedId = googleSheetsPublishedUrl.match(/\/d\/e\/([a-zA-Z0-9-_]+)/)?.[1] ?? "";
      const tabs = await discoverSheetTabs(googleSheetsPublishedUrl);

      // First pass: import objects, project, glossary tabs
      const storyTabs: Array<{ name: string; gid: string }> = [];
      for (const tab of tabs) {
        const csvText = await fetchSheetCsv(publishedId, tab.gid);
        const rows = parseTelarCsv(csvText);

        const tabName = tab.name.toLowerCase();
        if (tabName === "objects") {
          objectRows = mapObjectsCsv(rows);
        } else if (tabName === "project") {
          storyRows = mapProjectCsv(rows);
          storiesFound = storyRows.length;
        } else if (tabName === "glossary") {
          glossaryRows = rows.map((r) => ({
            project_id: 0,
            term_id: r.term_id ?? "",
            title: r.title || undefined,
            definition: r.definition || undefined,
          }));
        } else {
          // Candidate story tab — collect for second pass
          storyTabs.push(tab);
        }
      }

      // Second pass: match remaining tabs to story_ids and import steps/layers
      const storyIds = new Set(storyRows.map((r) => (r.story_id as string).toLowerCase()));
      for (const tab of storyTabs) {
        if (storyIds.has(tab.name.toLowerCase())) {
          const csvText = await fetchSheetCsv(publishedId, tab.gid);
          const rows = parseTelarCsv(csvText);
          const storyIndex = storyRows.findIndex(
            (r) => (r.story_id as string).toLowerCase() === tab.name.toLowerCase(),
          );
          const { steps: mappedSteps, layers: mappedLayers } = mapStoryCsv(
            rows,
            -(storyIndex + 1), // placeholder — updated after D1 insert
          );
          stepRows.push(...mappedSteps);
          layerRows.push(...mappedLayers);
        }
      }

      sheetsDisabled = true; // Auto-disable after successful Sheets import
    } catch (err) {
      // Sheet inaccessible — return error without falling back to repo CSVs
      return {
        valid: false,
        sheetsAccessError: true,
        sheetsPublishedUrl: googleSheetsPublishedUrl,
        project: { imported: false, storiesFound: 0 },
        objects: { imported: 0, skipped: 0, warnings: [] },
        stories: { imported: 0, warnings: [] },
        glossary: { imported: 0 },
        pages: { imported: 0 },
        themes: { imported: 0, list: [] },
        sheetsEnabled: true,
        sheetsDisabled: false,
        iiifObjectIds,
        audioObjectIds: [...audioObjectFiles.keys()],
        videoObjectCount: 0,
        configFields,
        orphanStoryIds: [],
      };
    }
  } else {
    // Import from repo CSVs
    const objectsContent = await getFileContent(token, owner, repo, "telar-content/spreadsheets/objects.csv");
    if (objectsContent) {
      objectRows = mapObjectsCsv(parseTelarCsv(objectsContent));
    }

    const projectContent = await getFileContent(token, owner, repo, "telar-content/spreadsheets/project.csv");
    if (projectContent) {
      const projectRows = parseTelarCsv(projectContent);
      storyRows = mapProjectCsv(projectRows);
      storiesFound = storyRows.length;

      // Find and import individual story CSV files from _data/ or root
      for (const storyRow of storyRows) {
        const storyId = storyRow.story_id as string;
        const storyContent =
          (await getFileContent(token, owner, repo, `telar-content/spreadsheets/${storyId}.csv`)) ??
          (await getFileContent(token, owner, repo, `_data/${storyId}.csv`)) ??
          (await getFileContent(token, owner, repo, `${storyId}.csv`));

        if (storyContent) {
          const storyStepRows = parseTelarCsv(storyContent);
          const storyIndex = storyRows.indexOf(storyRow);
          const { steps: mappedSteps, layers: mappedLayers } = mapStoryCsv(
            storyStepRows,
            -(storyIndex + 1), // placeholder — updated after D1 insert
          );
          stepRows.push(...mappedSteps);
          layerRows.push(...mappedLayers);
        }
      }
    }

    const glossaryContent = await getFileContent(token, owner, repo, "telar-content/spreadsheets/glossary.csv");
    if (glossaryContent) {
      glossaryRows = parseTelarCsv(glossaryContent).map((r) => ({
        project_id: 0,
        term_id: r.term_id ?? "",
        title: r.title || undefined,
        definition: r.definition || undefined,
      }));
    }

    // ---- Pages import ----
    // Reuses scanRepoPages (extracted for the Pages editor's empty-state import variant). The
    // helper preserves the original index-based order semantics that the
    // import path relies on for navigation slot assignment.
    const scannedPages = await scanRepoPages(token, owner, repo);
    for (const page of scannedPages) {
      pageRows.push({
        title: page.title,
        slug: page.slug,
        body: page.body,
        order: page.order,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 4c: Detect IIIF tiles and audio files from the PUBLISHED site
  // -------------------------------------------------------------------------
  // Tiles and large media files are generated/deployed by GitHub Actions to
  // GitHub Pages — they are NOT stored in the repo. We probe the live site.
  if (siteBase) {
    const selfHostedIds = objectRows
      .filter((o) => {
        const src = o.source_url as string | null;
        return !src || (!src.startsWith("http://") && !src.startsWith("https://"));
      })
      .map((o) => o.object_id as string);

    const probeResults = await Promise.allSettled(
      selfHostedIds.map(async (objectId) => {
        // Check IIIF tiles
        try {
          const tileRes = await fetch(`${siteBase}/iiif/objects/${objectId}/info.json`, { method: "HEAD" });
          if (tileRes.ok) return { objectId, type: "iiif" as const };
        } catch { /* site unreachable */ }

        // Check audio files
        for (const ext of audioExtensions) {
          try {
            const audioRes = await fetch(`${siteBase}/telar-content/objects/${objectId}.${ext}`, { method: "HEAD" });
            if (audioRes.ok) return { objectId, type: "audio" as const, filename: `${objectId}.${ext}` };
          } catch { /* site unreachable */ }
        }

        return { objectId, type: "unknown" as const };
      }),
    );

    for (const result of probeResults) {
      if (result.status !== "fulfilled") continue;
      const { objectId, type } = result.value;
      if (type === "iiif") iiifObjectIds.push(objectId);
      if (type === "audio") audioObjectFiles.set(objectId, (result.value as { filename: string }).filename);
    }
  }

  // Mark image availability and media type hints
  objectRows = objectRows.map((obj) => {
    const objectId = obj.object_id as string;
    const hasSelfHostedTiles = iiifObjectIds.includes(objectId);
    const hasExternalManifest = !!(obj.source_url && /manifest/.test(obj.source_url as string));
    const audioFilename = audioObjectFiles.get(objectId);
    return {
      ...obj,
      // For audio objects without a source_url, store the filename so
      // detectMediaType can identify the media type from the extension.
      // Use empty string fallback (not undefined) to ensure Drizzle writes it.
      source_url: (obj.source_url as string) || (audioFilename ?? null),
      image_available: hasSelfHostedTiles || hasExternalManifest || !!audioFilename,
    };
  });

  // -------------------------------------------------------------------------
  // Step 6: Write to D1
  // -------------------------------------------------------------------------

  const db = getDb(env.DB);

  // Check for duplicate — don't re-import a repo that's already connected
  const existingProject = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.user_id, userId),
        eq(projects.github_repo_full_name, repoFullName),
      ),
    )
    .limit(1);

  if (existingProject.length > 0) {
    return {
      valid: false,
      validationError: "already_connected",
      project: { imported: false, storiesFound: 0 },
      objects: { imported: 0, skipped: 0, warnings: [] },
      stories: { imported: 0, warnings: [] },
      glossary: { imported: 0 },
      pages: { imported: 0 },
      themes: { imported: 0, list: [] },
      sheetsEnabled: false,
      sheetsDisabled: false,
      iiifObjectIds: [],
      audioObjectIds: [],
      videoObjectCount: 0,
      configFields: {},
      orphanStoryIds: [],
    };
  }

  // Insert project record — initial import counts as a sync
  const [projectRecord] = await db
    .insert(projects)
    .values({
      user_id: userId,
      github_repo_full_name: repoFullName,
      installation_id: installationId,
      last_synced_at: new Date().toISOString(),
    })
    .returning();

  const projectId = projectRecord.id;

  // Insert convenor membership row for the new project
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: userId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });

  try {
  // Update all rows with the real project ID
  const objectsWithProjectId = objectRows.map((r) => ({ ...r, project_id: projectId }));
  const storiesWithProjectId = storyRows
    .filter((r) => r.story_id && String(r.story_id).trim() !== "")
    .map((r) => ({ ...r, project_id: projectId }));
  const glossaryWithProjectId = glossaryRows.map((r) => ({ ...r, project_id: projectId }));

  // Insert project config
  await db
    .insert(project_config)
    .values({ ...configFields, project_id: projectId });

  // Insert landing page data (null-safe: all fields are optional)
  await db
    .insert(project_landing)
    .values({ project_id: projectId, ...landingData });

  // Insert themes
  if (themeRows.length > 0) {
    const themesWithProjectId = themeRows.map((r) => ({ ...r, project_id: projectId }));
    // project_themes has 8 columns → max 12 rows per insert
    for (const chunk of chunkForD1(8, themesWithProjectId)) {
      await db.insert(project_themes).values(chunk);
    }
  }

  // Insert content tables — chunked to stay within D1's 100-variable limit
  // objects: 19 cols → max 5 rows; stories: 10 cols → max 10 rows;
  // glossary: 6 cols → max 16 rows; pages: 7 cols → max 14 rows
  for (const chunk of chunkForD1(19, objectsWithProjectId)) {
    await db.insert(objects).values(chunk);
  }
  for (const chunk of chunkForD1(10, storiesWithProjectId)) {
    await db.insert(stories).values(chunk);
  }
  for (const chunk of chunkForD1(6, glossaryWithProjectId)) {
    await db.insert(glossary_terms).values(chunk);
  }

  // Insert pages (INSERT OR REPLACE to handle re-imports)
  const now = new Date().toISOString();
  if (pageRows.length > 0) {
    const pagesWithProjectId = pageRows.map((p) => ({
      project_id: projectId,
      title: p.title,
      slug: p.slug,
      body: p.body,
      order: p.order,
      created_at: now,
      updated_at: now,
    }));
    for (const chunk of chunkForD1(7, pagesWithProjectId)) {
      for (const page of chunk) {
        await db
          .insert(project_pages)
          .values(page)
          .onConflictDoUpdate({
            target: [project_pages.project_id, project_pages.slug],
            set: {
              title: page.title,
              body: page.body,
              order: page.order,
              updated_at: page.updated_at,
            },
          });
      }
    }
  }

  // Insert steps and layers — requires real story DB IDs
  if (stepRows.length > 0 && storiesWithProjectId.length > 0) {
    // Fetch inserted story IDs ordered by the original insert order
    const insertedStories = await db
      .select({ id: stories.id, story_id: stories.story_id })
      .from(stories)
      .where(eq(stories.project_id, projectId));

    // Build index from original story order to DB ID
    const storyDbIdByIndex = new Map<number, number>();
    for (let i = 0; i < storiesWithProjectId.length; i++) {
      const storyId = storiesWithProjectId[i].story_id as string;
      const dbRow = insertedStories.find((s) => s.story_id === storyId);
      if (dbRow) {
        storyDbIdByIndex.set(-(i + 1), dbRow.id);
      }
    }

    // Update placeholder story_id refs in steps
    const stepsWithIds = stepRows.map((step) => ({
      ...step,
      story_id: storyDbIdByIndex.get(step.story_id as number) ?? step.story_id,
    }));

    // steps table has 14 columns (added clip_start, clip_end, loop) → max 7 rows per insert
    for (const chunk of chunkForD1(14, stepsWithIds)) {
      await db.insert(steps).values(chunk);
    }

    // Insert layers — needs real step IDs
    if (layerRows.length > 0) {
      const insertedSteps = await db
        .select({ id: steps.id, story_id: steps.story_id, step_number: steps.step_number })
        .from(steps)
        .where(
          inArray(
            steps.story_id,
            [...storyDbIdByIndex.values()],
          ),
        );

      const layersWithIds = layerRows
        .map((layer) => {
          // Find the step this layer belongs to via the placeholder mapping
          const realStoryId = storyDbIdByIndex.get(layer.step_id as number);
          if (!realStoryId) return null;

          // Match by step index within the story
          const placeholderIndex = layer.step_id as number; // negative index
          const stepIndex = Math.abs(placeholderIndex) - 1;
          const storySteps = insertedSteps
            .filter((s) => s.story_id === realStoryId)
            .sort((a, b) => a.step_number - b.step_number);
          const matchedStep = storySteps[stepIndex];
          if (!matchedStep) return null;

          return { ...layer, step_id: matchedStep.id };
        })
        .filter((l): l is NonNullable<typeof l> => l !== null);

      // layers table has 6 columns → max 16 rows per insert
      for (const chunk of chunkForD1(6, layersWithIds)) {
        await db.insert(layers).values(chunk);
      }
    }
  }

  } catch (importError) {
    // Clean up partial data — delete project and all child records
    await rollbackProjectImport(db, projectId);
    throw importError;
  }

  // Detect {story_id}.csv files on GitHub not referenced by project.csv
  // and not user-ignored. Returned to caller for the orphan-stories
  // banner. NO content fetch here — lazy until user clicks
  // "Restore as drafts". Skipped for Google-Sheets-backed sites: those
  // sites have no per-story CSV files in telar-content/spreadsheets/ to scan.
  let orphanStoryIds: string[] = [];
  if (!googleSheetsEnabled) {
    const projectCsvStoryIds = new Set(
      storyRows
        .map((r) => (r.story_id as string | undefined) ?? "")
        .filter((id) => id.trim() !== ""),
    );
    orphanStoryIds = await scanRepoOrphanStoryIds(token, owner, repo, projectCsvStoryIds);
  }

  return {
    valid: true,
    telarVersion,
    projectId,
    project: { imported: true, storiesFound },
    objects: {
      imported: objectRows.length,
      skipped: 0,
      warnings: objectWarnings,
    },
    stories: { imported: storyRows.filter((r) => r.story_id && String(r.story_id).trim() !== "").length, warnings: storyWarnings },
    glossary: { imported: glossaryRows.length },
    pages: { imported: pageRows.length },
    themes: {
      imported: themeRows.length,
      list: themeRows.map((r) => ({
        theme_id: r.theme_id,
        name: r.name ?? null,
        swatch_color: r.swatch_color ?? null,
      })),
    },
    sheetsEnabled: googleSheetsEnabled && !sheetsDisabled,
    sheetsDisabled,
    iiifObjectIds,
    audioObjectIds: [...audioObjectFiles.keys()],
    videoObjectCount: objectRows.filter((o) => {
      const src = o.source_url as string | null;
      return src && (/youtube|youtu\.be/.test(src) || /vimeo/.test(src) || /drive\.google/.test(src));
    }).length,
    configFields,
    orphanStoryIds,
  };
}


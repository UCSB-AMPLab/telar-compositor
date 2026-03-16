/**
 * Import pipeline for Telar Compositor.
 *
 * Orchestrates the full repo import: validates the Telar site, parses CSVs
 * or Google Sheets, scans for IIIF tiles, and writes all content to D1 in
 * a single batch insert.
 *
 * Entry point: importRepo(). All helper functions are exported for unit
 * testing. The sheetsAccessError blocking path is critical: when
 * google_sheets.enabled is true and the Sheet is inaccessible, the import
 * is aborted — there is no fallback to repo CSVs (the Sheet IS the source
 * of truth for Sheets-based sites).
 */

import Papa from "papaparse";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import { getFileContent, getRepoTree } from "~/lib/github.server";
import { discoverSheetTabs, fetchSheetCsv } from "~/lib/sheets.server";
import { parseYaml } from "~/lib/yaml.server";
import {
  projects,
  project_config,
  project_landing,
  objects,
  stories,
  steps,
  layers,
  glossary_terms,
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
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportResult {
  valid: boolean;
  validationError?: "not_telar" | "empty_repo";
  sheetsAccessError?: boolean;
  sheetsPublishedUrl?: string;
  telarVersion?: string;
  projectId?: number;
  project: { imported: boolean; storiesFound: number };
  objects: { imported: number; skipped: number; warnings: string[] };
  stories: { imported: number; warnings: string[] };
  glossary: { imported: number };
  sheetsEnabled: boolean;
  sheetsDisabled: boolean;
  iiifObjectIds: string[];
  configFields: Record<string, unknown>;
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
  return {
    stories_heading: frontmatter.stories_heading as string | undefined,
    stories_intro: frontmatter.stories_intro as string | undefined,
    objects_heading: frontmatter.objects_heading as string | undefined,
    objects_intro: frontmatter.objects_intro as string | undefined,
    welcome_body: match[2].trim() || undefined,
  };
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
  return rows.map((row) => {
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
      object_type: row.object_type || undefined,
      subjects: row.subjects || undefined,
      source: row.source || undefined,
      credit: row.credit || undefined,
      thumbnail: row.thumbnail || undefined,
      has_iiif_tiles: false,
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
    return {
      project_id: projectId ?? 0,
      story_id: row.story_id ?? "",
      title: row.title || undefined,
      subtitle: row.subtitle || undefined,
      byline: row.byline || undefined,
      order: parseInt(row.order ?? "0", 10) || 0,
      private: isPrivate,
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
export function mapStoryCsv(
  rows: Record<string, string>[],
  storyDbId: number,
): { steps: Array<typeof steps.$inferInsert>; layers: Array<typeof layers.$inferInsert> } {
  const stepRows: Array<typeof steps.$inferInsert> = [];
  const layerRows: Array<typeof layers.$inferInsert> = [];

  rows.forEach((row, index) => {
    const stepNumber = parseInt(row.step ?? String(index + 1), 10) || index + 1;
    const stepRow: typeof steps.$inferInsert = {
      story_id: storyDbId,
      step_number: stepNumber,
      object_id: row.object || undefined,
      x: row.x ? parseFloat(row.x) : undefined,
      y: row.y ? parseFloat(row.y) : undefined,
      zoom: row.zoom ? parseFloat(row.zoom) : undefined,
      page: row.page || undefined,
      question: row.question || undefined,
      answer: row.answer || undefined,
    };
    stepRows.push(stepRow);

    // Use index as placeholder step_id — caller updates after insert
    const placeholderStepId = -(index + 1);

    if (row.layer1_button || row.layer1_content) {
      layerRows.push({
        step_id: placeholderStepId,
        layer_number: 1,
        button_label: row.layer1_button || undefined,
        content: row.layer1_content || undefined,
      });
    }

    if (row.layer2_button || row.layer2_content) {
      layerRows.push({
        step_id: placeholderStepId,
        layer_number: 2,
        button_label: row.layer2_button || undefined,
        content: row.layer2_content || undefined,
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
      sheetsEnabled: false,
      sheetsDisabled: false,
      iiifObjectIds: [],
      configFields: {},
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
      sheetsEnabled: false,
      sheetsDisabled: false,
      iiifObjectIds: [],
      configFields: {},
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

  const iiifObjectIds = tree
    .filter(
      (entry) =>
        entry.type === "tree" &&
        entry.path.startsWith("iiif/objects/") &&
        entry.path.split("/").length === 3,
    )
    .map((entry) => entry.path.split("/")[2]);

  // -------------------------------------------------------------------------
  // Step 5: Import content (Sheets or repo CSVs)
  // -------------------------------------------------------------------------

  let objectRows: Array<typeof objects.$inferInsert> = [];
  let storyRows: Array<typeof stories.$inferInsert> = [];
  let stepRows: Array<typeof steps.$inferInsert> = [];
  let layerRows: Array<typeof layers.$inferInsert> = [];
  let glossaryRows: Array<typeof glossary_terms.$inferInsert> = [];
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
        sheetsEnabled: true,
        sheetsDisabled: false,
        iiifObjectIds,
        configFields,
      };
    }
  } else {
    // Import from repo CSVs
    const objectsContent = await getFileContent(token, owner, repo, "objects.csv");
    if (objectsContent) {
      objectRows = mapObjectsCsv(parseTelarCsv(objectsContent));
    }

    const projectContent = await getFileContent(token, owner, repo, "project.csv");
    if (projectContent) {
      const projectRows = parseTelarCsv(projectContent);
      storyRows = mapProjectCsv(projectRows);
      storiesFound = storyRows.length;

      // Find and import individual story CSV files from _data/ or root
      for (const storyRow of storyRows) {
        const storyId = storyRow.story_id as string;
        const storyContent =
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

    const glossaryContent = await getFileContent(token, owner, repo, "glossary.csv");
    if (glossaryContent) {
      glossaryRows = parseTelarCsv(glossaryContent).map((r) => ({
        project_id: 0,
        term_id: r.term_id ?? "",
        title: r.title || undefined,
        definition: r.definition || undefined,
      }));
    }
  }

  // Mark IIIF objects
  objectRows = objectRows.map((obj) => ({
    ...obj,
    has_iiif_tiles: iiifObjectIds.includes(obj.object_id as string),
  }));

  // -------------------------------------------------------------------------
  // Step 6: Write to D1
  // -------------------------------------------------------------------------

  const db = getDb(env.DB);

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

  // Update all rows with the real project ID
  const objectsWithProjectId = objectRows.map((r) => ({ ...r, project_id: projectId }));
  const storiesWithProjectId = storyRows.map((r) => ({ ...r, project_id: projectId }));
  const glossaryWithProjectId = glossaryRows.map((r) => ({ ...r, project_id: projectId }));

  // Insert project config
  await db
    .insert(project_config)
    .values({ ...configFields, project_id: projectId });

  // Insert landing page data (null-safe: all fields are optional)
  await db
    .insert(project_landing)
    .values({ project_id: projectId, ...landingData });

  // Insert content tables — chunked to stay within D1's 100-variable limit
  // objects: 17 cols → max 5 rows; stories: 9 cols → max 11 rows;
  // glossary: 6 cols → max 16 rows
  for (const chunk of chunkForD1(17, objectsWithProjectId)) {
    await db.insert(objects).values(chunk);
  }
  for (const chunk of chunkForD1(9, storiesWithProjectId)) {
    await db.insert(stories).values(chunk);
  }
  for (const chunk of chunkForD1(6, glossaryWithProjectId)) {
    await db.insert(glossary_terms).values(chunk);
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

    // steps table has 11 columns → max 9 rows per insert
    for (const chunk of chunkForD1(11, stepsWithIds)) {
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

  return {
    valid: true,
    telarVersion,
    projectId,
    project: { imported: true, storiesFound },
    objects: {
      imported: objectsWithProjectId.length,
      skipped: 0,
      warnings: objectWarnings,
    },
    stories: { imported: storiesWithProjectId.length, warnings: storyWarnings },
    glossary: { imported: glossaryWithProjectId.length },
    sheetsEnabled: googleSheetsEnabled && !sheetsDisabled,
    sheetsDisabled,
    iiifObjectIds,
    configFields,
  };
}

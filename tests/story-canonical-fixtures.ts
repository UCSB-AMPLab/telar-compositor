/**
 * Story fixtures for the story-files render and the canonical content tests,
 * with the D1 rows an import of each would store and a fake database that
 * serves those rows to `buildPublishFileSet`.
 *
 * Every fixture is the Telar template's or the demo content's own text:
 *
 * - `blank_template.csv` and `plantilla_en_blanco.csv` from the Telar template
 *   (`tests/fixtures/story-canonical/template/NOTES.md`):
 *   three media steps on `telar-placeholder` with no coordinates, which is the
 *   unplaced media step.
 * - `allegorical-woman.csv` and `colonial-landscapes.csv` with its six layer
 *   files from the v0.9.0 English demo bundle
 *   (`tests/fixtures/story-canonical/demo-v0.9.0-en/NOTES.md`): multiline
 *   answers and inline layer cells, and layer files whose `---` lines already
 *   stand after a blank line.
 * - `allegorical-woman-crlf`, that sheet with every line break written as
 *   CRLF, as a spreadsheet saved on Windows writes it. The demo file ends its
 *   rows with CRLF but breaks lines inside a cell with LF, so CRLF inside a
 *   multiline answer is derived from it rather than found in it.
 * - `colonial-landscapes-rules`, the same story with the blank line before
 *   each `---` of `ways_of_mapping.md` removed, which is the one shape the
 *   publisher's rule guard rewrites. No template or demo layer carries it, so
 *   the case is derived from demo text rather than written from scratch.
 *
 * No describe/it here; each test file owns its own mocks.
 *
 * @version v1.5.0-beta
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STORY_CANONICAL_SCOPE,
  mapStoryCsv,
  parseTelarCsv,
  resolveLayerFileReferences,
} from "~/lib/import.server";
import type { layers, steps } from "~/db/schema";
import type { BuildPublishParams } from "~/lib/publish.server";

const TEMPLATE_DIR = resolve(__dirname, "fixtures/story-canonical/template");
const DEMO_DIR = resolve(__dirname, "fixtures/story-canonical/demo-v0.9.0-en");

export interface StoryFixture {
  /** The story's id, which names its CSV and prefixes its layer files. */
  slug: string;
  /** The story CSV as the repository holds it. */
  csv: string;
  /** Layer files by the name a `layerN_content` cell gives them. */
  layerFiles: Record<string, string>;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const COLONIAL_LAYERS = [
  "bogota_savanna.md",
  "encomendero_biography.md",
  "legal_painting.md",
  "legal_proceeding.md",
  "maldonado_lineage.md",
  "ways_of_mapping.md",
];

function colonialLayerFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of COLONIAL_LAYERS) {
    files[`colonial-landscapes/${name}`] = read(
      resolve(DEMO_DIR, "texts/stories/colonial-landscapes", name),
    );
  }
  return files;
}

/** `ways_of_mapping.md` with every `---` in its body moved up against the line before it. */
function withRulesAgainstText(files: Record<string, string>): Record<string, string> {
  const key = "colonial-landscapes/ways_of_mapping.md";
  const text = files[key];
  const bodyStart = text.indexOf("\n---\n", 4) + 5;
  const body = text.slice(bodyStart).replace(/\n\n---\n/g, "\n---\n");
  return { ...files, [key]: text.slice(0, bodyStart) + body };
}

export function storyFixtures(): Record<string, StoryFixture> {
  const colonial = colonialLayerFiles();
  return {
    blank_template: {
      slug: "blank_template",
      csv: read(resolve(TEMPLATE_DIR, "blank_template.csv")),
      layerFiles: {},
    },
    plantilla_en_blanco: {
      slug: "plantilla_en_blanco",
      csv: read(resolve(TEMPLATE_DIR, "plantilla_en_blanco.csv")),
      layerFiles: {},
    },
    "allegorical-woman": {
      slug: "allegorical-woman",
      csv: read(resolve(DEMO_DIR, "allegorical-woman.csv")),
      layerFiles: {},
    },
    "allegorical-woman-crlf": {
      slug: "allegorical-woman",
      csv: read(resolve(DEMO_DIR, "allegorical-woman.csv")).replace(/\r?\n/g, "\r\n"),
      layerFiles: {},
    },
    "colonial-landscapes": {
      slug: "colonial-landscapes",
      csv: read(resolve(DEMO_DIR, "colonial-landscapes.csv")),
      layerFiles: colonial,
    },
    "colonial-landscapes-rules": {
      slug: "colonial-landscapes",
      csv: read(resolve(DEMO_DIR, "colonial-landscapes.csv")),
      layerFiles: withRulesAgainstText(colonial),
    },
  };
}

export type D1StepRow = typeof steps.$inferSelect;
export type D1LayerRow = typeof layers.$inferSelect;

export interface D1Story {
  story: { id: number; story_id: string };
  stepRows: D1StepRow[];
  layerRows: D1LayerRow[];
}

const STORY_DB_ID = 1;
const FIRST_STEP_ID = 100;

/**
 * The D1 rows an import of `fixture` stores: the import's own parse, layer
 * resolution and mapping, with ids assigned in row order and each layer on the
 * step it was stated with.
 */
export async function importAsD1(fixture: StoryFixture): Promise<D1Story> {
  const rows = parseTelarCsv(fixture.csv, undefined, false, STORY_CANONICAL_SCOPE, {
    severalHoldValues: "refuse",
    sheetName: `${fixture.slug}.csv`,
  });
  const resolved = await resolveLayerFileReferences(
    rows,
    async (name) => fixture.layerFiles[name] ?? null,
  );
  const mapped = mapStoryCsv(resolved, STORY_DB_ID);
  const stepRows: D1StepRow[] = mapped.steps.map((s, i) => ({
    id: FIRST_STEP_ID + i,
    story_id: STORY_DB_ID,
    step_number: s.step_number,
    order_key: null,
    kind: s.kind ?? "media",
    object_id: s.object_id ?? null,
    x: s.x ?? null,
    y: s.y ?? null,
    zoom: s.zoom ?? null,
    page: s.page ?? null,
    question: s.question ?? null,
    answer: s.answer ?? null,
    alt_text: s.alt_text ?? null,
    clip_start: s.clip_start ?? null,
    clip_end: s.clip_end ?? null,
    loop: s.loop ?? null,
    extra_columns: s.extra_columns ?? null,
    created_by: null,
    last_edited_by: null,
    created_by_actor: null,
    updated_at: null,
  }));
  const layerRows: D1LayerRow[] = mapped.layers.map((l, i) => ({
    id: 1000 + i,
    step_id: FIRST_STEP_ID + l.stepIndex,
    layer_number: l.layer_number,
    order_key: null,
    title: l.title ?? null,
    button_label: l.button_label ?? null,
    content: l.content ?? null,
    created_by: null,
    last_edited_by: null,
    created_by_actor: null,
    updated_at: null,
  }));
  return { story: { id: STORY_DB_ID, story_id: fixture.slug }, stepRows, layerRows };
}

/** The parameters that make the assembly read nothing but the story rows. */
export const STORY_ONLY_PUBLISH: BuildPublishParams = {
  token: "tok",
  owner: "owner",
  repo: "repo",
  ref: "sha",
  projectId: 1,
  env: { DB: {} } as never,
  configYml: null,
  config: null,
  pages: [],
  landing: null,
  objectsSheet: { path: "telar-content/spreadsheets/objects.csv", existingCsv: undefined },
};

/** Only the story's own files: its step CSV and its layer files. */
export function isStoryFile(path: string, slug: string): boolean {
  return path === `telar-content/spreadsheets/${slug}.csv` || path.startsWith("telar-content/texts/stories/");
}

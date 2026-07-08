/**
 * Field-registry sentinel round-trip suite.
 *
 * This is the transform-fidelity family of the field-registry coverage
 * suite. List-diff tests can prove that publish and import both DECLARE a
 * field; they cannot prove the two sides agree about its encoding. The
 * historical bug this family exists to catch: publish wrote layer-content
 * FILENAMES into the `layerN_content` CSV cell while import read the cell
 * as inline markdown — both sides "had" the field, and re-import silently
 * replaced every panel body with a literal filename string.
 *
 * Method: build one maximal entity per registry entity with a DISTINCT
 * sentinel value in every declared field, serialize it through the real
 * publish serializers, parse the emitted files back with the real import
 * mappers, then iterate FIELD_REGISTRY and assert — for every field that
 * participates on BOTH the publish and import axes — that the sentinel
 * survives modulo the declared encoding. The assertions are GENERATED from
 * the registry, so a future field added to both axes fails this suite until
 * a sentinel fixture is added for it.
 *
 * Structural encodings are covered by dedicated tests below where cheap
 * (draft file-presence, section empty-object-cell, page slug filename,
 * layer cell-pair, page "1" normalization, inline-vs-filename layer cells).
 * `navigation-yml` is NOT covered: the registry declares navigation_json as
 * one-way (publish-only, no reader of _data/navigation.yml exists), so
 * there is no import side to round-trip against.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  FIELD_REGISTRY,
  type EncodingToken,
} from "~/lib/field-registry";
import {
  serializeProjectCsv,
  serializeStory,
  serializeGlossaryCsv,
  layerFileContent,
  buildConfigManagedFields,
  buildConfigManagedBlocks,
  healConfigYaml,
  buildIndexMd,
  pageRowsToCommitFiles,
  storyPathsForPublish,
  type StepWithLayers,
} from "~/lib/publish.server";
import {
  parseTelarCsv,
  mapProjectCsv,
  mapObjectsCsv,
  mapStoryCsv,
  mapGlossaryCsv,
  mapConfigToProjectConfig,
  parseIndexMd,
  parsePageMarkdown,
  resolveLayerFileReferences,
  isLayerFileReference,
} from "~/lib/import.server";
import { serializeObjectsCsv, dbObjectToCsvRow } from "~/lib/csv-export.server";
import { parseYaml } from "~/lib/yaml.server";
import {
  V121_FRONTMATTER_DEFAULTS,
  V121_BODIES,
  normalizeBody,
} from "~/lib/v130-ingest.server";
import type { project_config } from "~/db/schema";

type ProjectConfigRow = typeof project_config.$inferSelect;

// ---------------------------------------------------------------------------
// Sentinel fixtures — one maximal entity per registry entity. Every field
// gets a unique, recognizable value. Rules observed:
//   - no bare "yes"/"true"/"1" text sentinels (they collide with the boolean
//     cell encodings);
//   - numeric sentinels avoid the viewer defaults (0.5/0.5/1) and the config
//     schema defaults (featured_count 4);
//   - landing sentinels differ from the v1.2.1 defaults so buildIndexMd's
//     default gates do not suppress emission (asserted below);
//   - quoted-yaml sentinels carry a colon, a hash, an accented character,
//     and a double quote, pinning the YAML quoting itself.
// ---------------------------------------------------------------------------

/** Hazard payload for quoted-yaml fields: colon, hash, accent, double quote. */
const yamlHazard = (base: string) => `${base}: value #hash í "quoted"`;

// --- stories ---------------------------------------------------------------

const STORY = {
  story_id: "s-stories-story-id",
  title: "S-stories-title, with a comma",
  subtitle: "S-stories-subtitle",
  byline: "S-stories-byline",
  order: 7,
  private: true,
  draft: false,
  show_sections: true,
};

/** False-side probe for the boolean encodings (yes-empty <-> bool-yes-true-si). */
const STORY_FALSE = {
  story_id: "s-stories-false-id",
  title: "S-stories-false-title",
  subtitle: null,
  byline: null,
  order: 8,
  private: false,
  draft: false,
  show_sections: false,
};

/** Draft story: file-presence encoding — absent from project.csv, file still emitted. */
const DRAFT_STORY = {
  story_id: "s-stories-draft-id",
  title: "S-stories-draft-title",
  subtitle: null,
  byline: null,
  order: 9,
  private: false,
  draft: true,
  show_sections: false,
};

// --- steps + layers ----------------------------------------------------------

const LAYER1 = {
  layer_number: 1,
  title: "S-layers-title",
  button_label: "S-layers-button",
  content: "S-layers-content first paragraph.\n\nSecond paragraph of the panel body.",
};

const LAYER2 = {
  layer_number: 2,
  title: "S-layers-second-title",
  button_label: "S-layers-second-button",
  content: "S-layers-second-content body.",
};

const MEDIA_STEP: StepWithLayers = {
  step_number: 1,
  kind: "media",
  object_id: "s-steps-object-id",
  x: 0.111,
  y: 0.222,
  zoom: 3.5,
  page: "3",
  question: "S-steps-question",
  answer: "S-steps-answer",
  alt_text: "S-steps-alt-text",
  clip_start: "S-steps-clip-start",
  clip_end: "S-steps-clip-end",
  loop: "S-steps-loop",
  layers: [LAYER1, LAYER2],
};

const SECTION_STEP: StepWithLayers = {
  step_number: 2,
  kind: "section",
  object_id: null,
  x: null,
  y: null,
  zoom: null,
  page: null,
  question: "S-steps-section-heading",
  answer: null,
  alt_text: null,
  clip_start: null,
  clip_end: null,
  loop: null,
  layers: [],
};

const STORY_SLUG = "s-story-slug";

// --- objects -----------------------------------------------------------------

const OBJECT_EXTRAS = {
  custom_alpha: "S-objects-extra-alpha",
  custom_beta: "S-objects-extra-beta",
};

const OBJECT_DB = {
  object_id: "s-objects-object-id",
  title: "S-objects-title",
  featured: true,
  creator: "S-objects-creator",
  description: 'S-objects-description, with a comma and a "quote"',
  source_url: "https://example.org/S-objects-source-url",
  period: "S-objects-period",
  year: "S-objects-year",
  object_type: "S-objects-medium-genre",
  subjects: "S-objects-subjects",
  source: "S-objects-source",
  credit: "S-objects-credit",
  thumbnail: "S-objects-thumbnail.jpg",
  alt_text: "S-objects-alt-text",
  dimensions: "S-objects-dimensions",
  extra_columns: JSON.stringify(OBJECT_EXTRAS),
};

/** False-side probe for featured (yes-empty <-> bool-yes-true-1). */
const OBJECT_FALSE = {
  object_id: "s-objects-false-id",
  title: "S-objects-false-title",
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
  alt_text: null,
  dimensions: null,
  extra_columns: null,
};

// --- glossary ----------------------------------------------------------------

const TERM = {
  term_id: "s-glossary-term-id",
  title: "S-glossary-title",
  definition: "S-glossary-definition, with a comma",
  related_terms: "s-glossary-rel-a|s-glossary-rel-b",
};

// --- config ------------------------------------------------------------------

const CONFIG_ROW: ProjectConfigRow = {
  id: 1,
  project_id: 1,
  title: yamlHazard("S-config-title"),
  lang: "es", // unquoted-yaml; differs from the import-side "en" default
  baseurl: yamlHazard("S-config-baseurl"),
  url: yamlHazard("S-config-url"),
  telar_version: null, // import-only field; probed one-sided below
  theme: yamlHazard("S-config-theme"),
  description: yamlHazard("S-config-description"),
  author: yamlHazard("S-config-author"),
  email: yamlHazard("S-config-email"),
  logo: yamlHazard("S-config-logo"),
  // Booleans deliberately mixed true/false (and off-default) so a single
  // pass probes both sides of unquoted-bool; the inverted variant below
  // probes the complementary side of every one of them.
  include_demo_content: false,
  google_sheets_enabled: null, // publish-excluded; probed one-sided below
  google_sheets_published_url: null, // publish-excluded; probed one-sided below
  show_on_homepage: false,
  show_story_steps: true,
  show_object_credits: false,
  browse_and_search: true,
  show_link_on_homepage: false,
  show_sample_on_homepage: true,
  collection_mode: true,
  featured_count: 7, // off the schema default of 4
  story_key: yamlHazard("S-config-story-key"),
  navigation_json: null, // navigation-yml is one-way (publish only); skipped
  updated_at: null,
};

const CONFIG_BOOL_KEYS = [
  "include_demo_content",
  "show_on_homepage",
  "show_story_steps",
  "show_object_credits",
  "browse_and_search",
  "show_link_on_homepage",
  "show_sample_on_homepage",
  "collection_mode",
] as const;

const CONFIG_ROW_INVERTED: ProjectConfigRow = {
  ...CONFIG_ROW,
  include_demo_content: true,
  show_on_homepage: true,
  show_story_steps: false,
  show_object_credits: true,
  browse_and_search: false,
  show_link_on_homepage: true,
  show_sample_on_homepage: false,
  collection_mode: false,
};

/**
 * Minimal repo-side _config.yml the publish heal runs against. Includes the
 * `protected:` block so story_key exercises its declared publish shape
 * (protected: -> key:) rather than the top-level append fallback.
 */
const CONFIG_TEMPLATE = [
  "# Telar site configuration",
  "title: placeholder",
  "protected:",
  "  key: placeholder",
  "telar:",
  "  version: 1.6.0",
  "",
].join("\n");

// --- landing -----------------------------------------------------------------

const LANDING = {
  stories_heading: "S-landing-stories-heading",
  stories_intro: "S-landing-stories-intro",
  objects_heading: "S-landing-objects-heading",
  objects_intro: "S-landing-objects-intro",
  welcome_body: "## S-landing-welcome-body\n\nWelcome body paragraph.",
};

// --- pages -------------------------------------------------------------------

const PAGE = {
  title: "S-pages-title",
  slug: "s-pages-slug",
  body: "S-pages-body first paragraph.\n\nSecond paragraph.",
};

// ---------------------------------------------------------------------------
// Sentinel map, keyed entity -> canonical field name. The generic loop reads
// this; a two-sided registry field with no entry here fails its test.
// ---------------------------------------------------------------------------

const sentinels: Record<string, Record<string, unknown>> = {
  stories: {
    story_id: STORY.story_id,
    title: STORY.title,
    subtitle: STORY.subtitle,
    byline: STORY.byline,
    order: STORY.order,
    private: STORY.private,
    show_sections: STORY.show_sections,
  },
  steps: {
    step_number: MEDIA_STEP.step_number,
    kind: "section", // the encoded value: empty object cell on a meaningful row
    object_id: MEDIA_STEP.object_id,
    x: MEDIA_STEP.x,
    y: MEDIA_STEP.y,
    zoom: MEDIA_STEP.zoom,
    page: MEDIA_STEP.page,
    question: MEDIA_STEP.question,
    answer: MEDIA_STEP.answer,
    alt_text: MEDIA_STEP.alt_text,
    clip_start: MEDIA_STEP.clip_start,
    clip_end: MEDIA_STEP.clip_end,
    loop: MEDIA_STEP.loop,
  },
  layers: {
    layer_number: LAYER1.layer_number,
    title: LAYER1.title,
    button_label: LAYER1.button_label,
    content: LAYER1.content,
  },
  objects: {
    object_id: OBJECT_DB.object_id,
    title: OBJECT_DB.title,
    featured: OBJECT_DB.featured,
    creator: OBJECT_DB.creator,
    description: OBJECT_DB.description,
    source_url: OBJECT_DB.source_url,
    period: OBJECT_DB.period,
    year: OBJECT_DB.year,
    object_type: OBJECT_DB.object_type,
    subjects: OBJECT_DB.subjects,
    source: OBJECT_DB.source,
    credit: OBJECT_DB.credit,
    thumbnail: OBJECT_DB.thumbnail,
    alt_text: OBJECT_DB.alt_text,
    dimensions: OBJECT_DB.dimensions,
    extra_columns: OBJECT_DB.extra_columns,
  },
  pages: {
    title: PAGE.title,
    slug: PAGE.slug,
    body: PAGE.body,
  },
  glossary: {
    term_id: TERM.term_id,
    title: TERM.title,
    definition: TERM.definition,
    related_terms: TERM.related_terms,
  },
  config: {
    title: CONFIG_ROW.title,
    lang: CONFIG_ROW.lang,
    baseurl: CONFIG_ROW.baseurl,
    url: CONFIG_ROW.url,
    theme: CONFIG_ROW.theme,
    description: CONFIG_ROW.description,
    author: CONFIG_ROW.author,
    email: CONFIG_ROW.email,
    logo: CONFIG_ROW.logo,
    include_demo_content: CONFIG_ROW.include_demo_content,
    show_on_homepage: CONFIG_ROW.show_on_homepage,
    show_story_steps: CONFIG_ROW.show_story_steps,
    show_object_credits: CONFIG_ROW.show_object_credits,
    browse_and_search: CONFIG_ROW.browse_and_search,
    show_link_on_homepage: CONFIG_ROW.show_link_on_homepage,
    show_sample_on_homepage: CONFIG_ROW.show_sample_on_homepage,
    featured_count: CONFIG_ROW.featured_count,
    collection_mode: CONFIG_ROW.collection_mode,
    story_key: CONFIG_ROW.story_key,
  },
  landing: {
    stories_heading: LANDING.stories_heading,
    stories_intro: LANDING.stories_intro,
    objects_heading: LANDING.objects_heading,
    objects_intro: LANDING.objects_intro,
    welcome_body: LANDING.welcome_body,
  },
};

// ---------------------------------------------------------------------------
// Round-trip pipelines — real publish serializers, real import mappers.
// Populated once in beforeAll; the generated tests read from `imported`.
// ---------------------------------------------------------------------------

const imported: Record<string, Record<string, unknown>> = {};

/** Extra state captured by the pipelines for the dedicated structural tests. */
const captured: {
  projectCsv?: string;
  projectRowsOut?: ReturnType<typeof mapProjectCsv>;
  storyFalseOut?: ReturnType<typeof mapProjectCsv>[number];
  storyCsvRows?: Record<string, string>[];
  stepsOut?: ReturnType<typeof mapStoryCsv>["steps"];
  layersOut?: ReturnType<typeof mapStoryCsv>["layers"];
  layerFilenames?: string[];
  objectFalseOut?: ReturnType<typeof mapObjectsCsv>[number];
  objectMaximalOut?: ReturnType<typeof mapObjectsCsv>[number];
  publishedConfigYaml?: string;
  parsedConfigYaml?: Record<string, unknown>;
  invertedConfigOut?: Partial<ProjectConfigRow>;
} = {};

beforeAll(async () => {
  // --- stories: project.csv --------------------------------------------------
  const projectCsv = serializeProjectCsv([STORY, STORY_FALSE, DRAFT_STORY]);
  const projectRowsOut = mapProjectCsv(parseTelarCsv(projectCsv), 1);
  const storyOut = projectRowsOut.find((r) => r.story_id === STORY.story_id);
  if (!storyOut) throw new Error("stories pipeline: sentinel story row did not survive re-import");
  captured.projectCsv = projectCsv;
  captured.projectRowsOut = projectRowsOut;
  captured.storyFalseOut = projectRowsOut.find((r) => r.story_id === STORY_FALSE.story_id);
  imported.stories = {
    story_id: storyOut.story_id,
    title: storyOut.title,
    subtitle: storyOut.subtitle,
    byline: storyOut.byline,
    order: storyOut.order,
    private: storyOut.private,
    show_sections: storyOut.show_sections,
  };

  // --- steps + layers: {story_id}.csv + layer .md files -----------------------
  const { csv: storyCsv, layerFiles } = serializeStory([MEDIA_STEP, SECTION_STEP], STORY_SLUG);
  // The published repo state: one .md file per CSV-referenced layer, with the
  // exact content buildPublishFileSet writes (layerFileContent = frontmatter
  // title + body).
  const layerFileMap = new Map(
    layerFiles.map((f) => [f.filename, layerFileContent(f.title, f.content)]),
  );
  captured.layerFilenames = layerFiles.map((f) => f.filename);
  const storyCsvRows = parseTelarCsv(storyCsv);
  captured.storyCsvRows = storyCsvRows;
  // Import resolves .md filename cells against the repo — here, the fake
  // fetch serves the files the publish pass just emitted.
  const resolvedRows = await resolveLayerFileReferences(storyCsvRows, async (filename) => {
    return layerFileMap.get(filename) ?? null;
  });
  const { steps: stepsOut, layers: layersOut } = mapStoryCsv(resolvedRows, 1);
  captured.stepsOut = stepsOut;
  captured.layersOut = layersOut;
  const mediaOut = stepsOut.find((s) => s.step_number === MEDIA_STEP.step_number);
  const sectionOut = stepsOut.find((s) => s.step_number === SECTION_STEP.step_number);
  if (!mediaOut || !sectionOut) {
    throw new Error("steps pipeline: media/section rows did not survive re-import");
  }
  const layer1Out = layersOut.find((l) => l.button_label === LAYER1.button_label);
  imported.steps = {
    step_number: mediaOut.step_number,
    // kind's encoding is the EMPTY object cell: the section step is the row
    // that carries the encoded value.
    kind: sectionOut.kind,
    object_id: mediaOut.object_id,
    x: mediaOut.x,
    y: mediaOut.y,
    zoom: mediaOut.zoom,
    page: mediaOut.page,
    question: mediaOut.question,
    answer: mediaOut.answer,
    alt_text: mediaOut.alt_text,
    clip_start: mediaOut.clip_start,
    clip_end: mediaOut.clip_end,
    loop: mediaOut.loop,
  };
  imported.layers = {
    layer_number: layer1Out?.layer_number,
    title: layer1Out?.title,
    button_label: layer1Out?.button_label,
    content: layer1Out?.content,
  };

  // --- objects: objects.csv ----------------------------------------------------
  const objectsCsv = serializeObjectsCsv([
    dbObjectToCsvRow(OBJECT_DB),
    dbObjectToCsvRow(OBJECT_FALSE),
  ]);
  const objectRowsOut = mapObjectsCsv(parseTelarCsv(objectsCsv), 1);
  const objectOut = objectRowsOut.find((o) => o.object_id === OBJECT_DB.object_id);
  if (!objectOut) throw new Error("objects pipeline: sentinel object row did not survive re-import");
  captured.objectMaximalOut = objectOut;
  captured.objectFalseOut = objectRowsOut.find((o) => o.object_id === OBJECT_FALSE.object_id);
  imported.objects = {
    object_id: objectOut.object_id,
    title: objectOut.title,
    featured: objectOut.featured,
    creator: objectOut.creator,
    description: objectOut.description,
    source_url: objectOut.source_url,
    period: objectOut.period,
    year: objectOut.year,
    object_type: objectOut.object_type,
    subjects: objectOut.subjects,
    source: objectOut.source,
    credit: objectOut.credit,
    thumbnail: objectOut.thumbnail,
    alt_text: objectOut.alt_text,
    dimensions: objectOut.dimensions,
    extra_columns: objectOut.extra_columns,
  };

  // --- glossary: glossary.csv ---------------------------------------------------
  const glossaryCsv = serializeGlossaryCsv([TERM]);
  const termOut = mapGlossaryCsv(parseTelarCsv(glossaryCsv))[0];
  imported.glossary = {
    term_id: termOut?.term_id,
    title: termOut?.title,
    definition: termOut?.definition,
    related_terms: termOut?.related_terms,
  };

  // --- config: _config.yml -------------------------------------------------------
  const publishedYaml = healConfigYaml(
    CONFIG_TEMPLATE,
    buildConfigManagedFields(CONFIG_ROW),
    buildConfigManagedBlocks(CONFIG_ROW),
  );
  captured.publishedConfigYaml = publishedYaml;
  const parsedYaml = parseYaml(publishedYaml);
  captured.parsedConfigYaml = parsedYaml;
  const configOut = mapConfigToProjectConfig(parsedYaml);
  imported.config = {
    title: configOut.title,
    lang: configOut.lang,
    baseurl: configOut.baseurl,
    url: configOut.url,
    theme: configOut.theme,
    description: configOut.description,
    author: configOut.author,
    email: configOut.email,
    logo: configOut.logo,
    include_demo_content: configOut.include_demo_content,
    show_on_homepage: configOut.show_on_homepage,
    show_story_steps: configOut.show_story_steps,
    show_object_credits: configOut.show_object_credits,
    browse_and_search: configOut.browse_and_search,
    show_link_on_homepage: configOut.show_link_on_homepage,
    show_sample_on_homepage: configOut.show_sample_on_homepage,
    featured_count: configOut.featured_count,
    collection_mode: configOut.collection_mode,
    story_key: configOut.story_key,
  };

  // Inverted-boolean variant: probes the complementary side of every
  // unquoted-bool config field through the same full pipeline.
  const invertedYaml = healConfigYaml(
    CONFIG_TEMPLATE,
    buildConfigManagedFields(CONFIG_ROW_INVERTED),
    buildConfigManagedBlocks(CONFIG_ROW_INVERTED),
  );
  captured.invertedConfigOut = mapConfigToProjectConfig(parseYaml(invertedYaml));

  // --- landing: index.md -----------------------------------------------------------
  const indexMd = buildIndexMd(LANDING);
  const landingOut = parseIndexMd(indexMd);
  imported.landing = {
    stories_heading: landingOut.stories_heading,
    stories_intro: landingOut.stories_intro,
    objects_heading: landingOut.objects_heading,
    objects_intro: landingOut.objects_intro,
    welcome_body: landingOut.welcome_body,
  };

  // --- pages: texts/pages/{slug}.md ---------------------------------------------------
  const pageFiles = pageRowsToCommitFiles([PAGE]);
  const pageFile = pageFiles[0];
  if (!pageFile) throw new Error("pages pipeline: sentinel page produced no commit file");
  // Import derives the slug from the filename (scanRepoPages rule:
  // filename.replace(/\.md$/, "")) and feeds it to parsePageMarkdown.
  const pageFilename = pageFile.path.split("/").pop() ?? "";
  const slugOut = pageFilename.replace(/\.md$/, "");
  const pageOut = parsePageMarkdown(pageFile.content, slugOut);
  imported.pages = {
    title: pageOut.title,
    slug: slugOut,
    body: pageOut.body,
  };
});

// ---------------------------------------------------------------------------
// Encoding expectation table. Keyed by the field's PUBLISH encoding token
// (the publish side names the transform the harness must undo). Tokens that
// never appear as a two-sided field's publish encoding (bool-yes-true-*,
// file-presence, tree-index, navigation-yml) are absent; hitting one is a
// registry-shape change the suite must be taught about.
// ---------------------------------------------------------------------------

type RoundTripExpectation = (sentinel: unknown, actual: unknown, label: string) => void;

const strictEqual: RoundTripExpectation = (sentinel, actual, label) => {
  expect(actual, `${label}: sentinel did not survive the publish -> import round trip`).toBe(
    sentinel,
  );
};

const booleanFidelity: RoundTripExpectation = (sentinel, actual, label) => {
  expect(typeof sentinel, `${label}: boolean-encoded sentinel must be a boolean`).toBe("boolean");
  expect(actual, `${label}: boolean did not survive the round trip`).toBe(sentinel);
};

const numericEqual: RoundTripExpectation = (sentinel, actual, label) => {
  expect(typeof sentinel, `${label}: numeric sentinel must be a number`).toBe("number");
  expect(actual, `${label}: number did not survive the round trip`).toBe(sentinel);
};

const EXPECT_BY_PUBLISH_ENCODING: Partial<Record<EncodingToken, RoundTripExpectation>> = {
  verbatim: strictEqual,
  "yes-empty": booleanFidelity,
  int: numericEqual,
  float: numericEqual,
  // Fixture guarantee: the sentinel step is a media step WITH an object, so
  // the coordinates are emitted rather than gated to empty cells.
  "viewer-gated-float": numericEqual,
  "page-normalized": (sentinel, actual, label) => {
    expect(sentinel, `${label}: page sentinel must not be "1" (publishes as empty)`).not.toBe("1");
    strictEqual(sentinel, actual, label);
  },
  "quoted-yaml": (sentinel, actual, label) => {
    // The quoting is only pinned if the sentinel actually carries the YAML
    // hazard characters.
    expect(sentinel, `${label}: quoted-yaml sentinel must contain a colon`).toContain(":");
    expect(sentinel, `${label}: quoted-yaml sentinel must contain a hash`).toContain("#");
    expect(sentinel, `${label}: quoted-yaml sentinel must contain an accented char`).toContain("í");
    expect(sentinel, `${label}: quoted-yaml sentinel must contain a double quote`).toContain('"');
    strictEqual(sentinel, actual, label);
  },
  "unquoted-yaml": strictEqual,
  "unquoted-bool": booleanFidelity,
  "unquoted-int": numericEqual,
  "json-spread-columns": (sentinel, actual, label) => {
    // Semantic equality: the blob is spread into individual CSV columns and
    // reassembled on import; key order is not part of the contract.
    expect(typeof actual, `${label}: reassembled extra_columns missing`).toBe("string");
    expect(
      JSON.parse(actual as string),
      `${label}: custom columns did not survive the spread -> reassembly round trip`,
    ).toEqual(JSON.parse(sentinel as string));
  },
  "filename-ref": strictEqual, // resolved file body vs original layer content
  frontmatter: strictEqual,
  "md-body": strictEqual,
  "frontmatter-of-cell": strictEqual,
  filename: strictEqual, // slug in vs filename-derived slug out
  "empty-object-cell": strictEqual, // kind "section" in vs derived kind out
  "layer-cell": strictEqual, // cell-pair position in vs layer_number/label out
};

// ---------------------------------------------------------------------------
// Generated round-trip assertions: one test per registry field that
// participates on both the publish and import axes.
// ---------------------------------------------------------------------------

describe("field-registry sentinel round trips (generated)", () => {
  for (const entity of FIELD_REGISTRY) {
    describe(entity.entity, () => {
      for (const field of entity.fields) {
        if ("excluded" in field.publish || "excluded" in field.import) continue;
        const publishEncoding = field.publish.encoding;
        const importEncoding = field.import.encoding;
        const label = `${entity.entity}.${field.name}`;

        it(`${field.name} round-trips [publish: ${publishEncoding} / import: ${importEncoding}]`, () => {
          const sentinel = sentinels[entity.entity]?.[field.name];
          expect(
            sentinel,
            `${label}: no sentinel fixture — a field was added to both axes; extend this suite`,
          ).toBeDefined();
          const check = EXPECT_BY_PUBLISH_ENCODING[publishEncoding];
          if (!check) {
            throw new Error(
              `${label}: publish encoding "${publishEncoding}" has no round-trip expectation — extend the table`,
            );
          }
          check(sentinel, imported[entity.entity]?.[field.name], label);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Boolean fidelity — the FALSE side of every boolean cell encoding. The
// generated tests above probe the true side (sentinels are true); these pin
// that publish false -> import false, so a one-sided truthy default cannot
// hide behind the sentinel pass.
// ---------------------------------------------------------------------------

describe("boolean encodings: false side", () => {
  it("stories.private and stories.show_sections publish false as empty and import back false", () => {
    expect(captured.storyFalseOut).toBeDefined();
    expect(captured.storyFalseOut?.private).toBe(false);
    expect(captured.storyFalseOut?.show_sections).toBe(false);
  });

  it("objects.featured publishes false as empty and imports back false", () => {
    expect(captured.objectFalseOut).toBeDefined();
    expect(captured.objectFalseOut?.featured).toBe(false);
  });

  it("every unquoted-bool config field round-trips its inverted value", () => {
    const inverted = captured.invertedConfigOut;
    expect(inverted).toBeDefined();
    for (const key of CONFIG_BOOL_KEYS) {
      expect(inverted?.[key], `config.${key} inverted value did not survive`).toBe(
        CONFIG_ROW_INVERTED[key],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Structural encodings — dedicated pins for shapes the generic harness
// cannot express as a scalar comparison.
// ---------------------------------------------------------------------------

describe("structural encodings", () => {
  it("stories.draft (file-presence): draft absent from project.csv, its CSV path still emitted", () => {
    // Membership side: the draft row never reaches project.csv, so re-import
    // yields only the two non-draft stories.
    expect(captured.projectCsv).not.toContain(DRAFT_STORY.story_id);
    expect(captured.projectRowsOut?.map((r) => r.story_id).sort()).toEqual(
      [STORY.story_id, STORY_FALSE.story_id].sort(),
    );
    // File side: the per-story CSV is written for ALL stories regardless of
    // draft flag (the orphans-are-drafts rule).
    expect(storyPathsForPublish([STORY, STORY_FALSE, DRAFT_STORY])).toContain(
      `telar-content/spreadsheets/${DRAFT_STORY.story_id}.csv`,
    );
  });

  it("steps.kind (empty-object-cell): section publishes an empty object cell; media keeps its object", () => {
    const sectionRow = captured.storyCsvRows?.find(
      (r) => r.step === String(SECTION_STEP.step_number),
    );
    expect(sectionRow?.object).toBe("");
    const mediaOut = captured.stepsOut?.find((s) => s.step_number === MEDIA_STEP.step_number);
    expect(mediaOut?.kind).toBe("media");
  });

  it("viewer-gated-float: a section step emits empty x/y/zoom cells (no phantom 0.5/0.5/1)", () => {
    const sectionRow = captured.storyCsvRows?.find(
      (r) => r.step === String(SECTION_STEP.step_number),
    );
    expect(sectionRow?.x).toBe("");
    expect(sectionRow?.y).toBe("");
    expect(sectionRow?.zoom).toBe("");
    const sectionOut = captured.stepsOut?.find((s) => s.step_number === SECTION_STEP.step_number);
    expect(sectionOut?.x).toBeUndefined();
    expect(sectionOut?.y).toBeUndefined();
    expect(sectionOut?.zoom).toBeUndefined();
  });

  it('steps.page (page-normalized): the value "1" publishes as an empty cell', () => {
    const { csv } = serializeStory(
      [{ ...MEDIA_STEP, page: "1", layers: [] }],
      "s-page-one-slug",
    );
    const row = parseTelarCsv(csv)[0];
    expect(row.page).toBe("");
    const { steps: stepsOut } = mapStoryCsv([row], 1);
    expect(stepsOut[0]?.page).toBeUndefined();
  });

  it("layers.layer_number (layer-cell): each layer round-trips through its own cell pair", () => {
    const layer2Out = captured.layersOut?.find((l) => l.button_label === LAYER2.button_label);
    expect(layer2Out?.layer_number).toBe(2);
    expect(layer2Out?.title).toBe(LAYER2.title);
    expect(layer2Out?.content).toBe(LAYER2.content);
  });

  it("layers.content (filename-ref): the CSV cell holds a .md filename the importer recognizes", () => {
    const mediaRow = captured.storyCsvRows?.find(
      (r) => r.step === String(MEDIA_STEP.step_number),
    );
    expect(captured.layerFilenames).toContain(mediaRow?.layer1_content);
    expect(isLayerFileReference(mediaRow?.layer1_content)).toBe(true);
    expect(isLayerFileReference(mediaRow?.layer2_content)).toBe(true);
  });

  it("layers.content (filename-ref): inline (non-.md) cells pass through untouched", async () => {
    const inlineRow = {
      step: "1",
      object: "obj-x",
      layer1_button: "More",
      layer1_content: "Inline prose panel body, not a filename.",
    };
    const fetchSpy = vi.fn(async () => null);
    const resolved = await resolveLayerFileReferences([inlineRow], fetchSpy);
    expect(resolved[0]).toEqual(inlineRow);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isLayerFileReference(inlineRow.layer1_content)).toBe(false);
  });

  it("pages.slug (filename): the commit path is derived from the slug the importer reads back", () => {
    const files = pageRowsToCommitFiles([PAGE]);
    expect(files[0]?.path).toBe(`telar-content/texts/pages/${PAGE.slug}.md`);
  });

  // config.navigation_json (navigation-yml) is deliberately NOT round-tripped:
  // the registry declares it one-way (publish-only; no reader of
  // _data/navigation.yml exists — the default nav is rebuilt from pages +
  // builtins at cold start). Its publish shape is pinned by the navigation
  // tests; nothing exists on the import side to assert against.

  // pages.order (tree-index) is import-only: order is the position in the
  // repo tree scan and never appears in the page file (page order publishes
  // via navigation_json). No publish side exists to round-trip against.
});

// ---------------------------------------------------------------------------
// Config-specific shapes: story_key's protected-block home, and the
// one-sided import reads for fields publish never writes.
// ---------------------------------------------------------------------------

describe("config: story_key protected-block shape", () => {
  it("publishes story_key under protected: -> key:, not as a top-level scalar", () => {
    const parsed = captured.parsedConfigYaml as Record<string, unknown>;
    const protectedBlock = parsed.protected as Record<string, unknown>;
    expect(protectedBlock?.key).toBe(CONFIG_ROW.story_key);
    expect(parsed.story_key).toBeUndefined();
  });

  it("import reads story_key from the protected block", () => {
    expect(imported.config?.story_key).toBe(CONFIG_ROW.story_key);
  });

  it("import falls back to a top-level story_key: line when no protected block exists", () => {
    const out = mapConfigToProjectConfig({ story_key: "S-config-story-key-top-level" });
    expect(out.story_key).toBe("S-config-story-key-top-level");
  });

  it("protected.key wins over a top-level story_key when both are present", () => {
    const out = mapConfigToProjectConfig({
      protected: { key: "S-protected-wins" },
      story_key: "S-top-level-loses",
    });
    expect(out.story_key).toBe("S-protected-wins");
  });
});

describe("config: one-sided import reads (publish-excluded fields)", () => {
  it("telar_version imports from telar.version", () => {
    const out = mapConfigToProjectConfig({ telar: { version: "S-config-telar-version" } });
    expect(out.telar_version).toBe("S-config-telar-version");
  });

  it("google_sheets_enabled and google_sheets_published_url import from the google_sheets block", () => {
    const out = mapConfigToProjectConfig({
      google_sheets: { enabled: true, published_url: "S-config-sheets-url" },
    });
    expect(out.google_sheets_enabled).toBe(true);
    expect(out.google_sheets_published_url).toBe("S-config-sheets-url");
  });

  it("objects.image_available is never read from a CSV cell (mapper sets false)", () => {
    expect(captured.objectMaximalOut?.image_available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Landing default gates: sentinels must not collide with the v1.2.1 defaults
// (which buildIndexMd suppresses), and the suppression itself is pinned so a
// silent gate change surfaces here rather than as a mystery non-emission.
// ---------------------------------------------------------------------------

describe("landing: v1.2.1 default gates", () => {
  it("sentinels differ from every v1.2.1 default the gates suppress", () => {
    expect(LANDING.stories_heading).not.toBe(V121_FRONTMATTER_DEFAULTS.stories_heading);
    expect(LANDING.objects_heading).not.toBe(V121_FRONTMATTER_DEFAULTS.objects_heading);
    expect(LANDING.objects_intro).not.toBe(V121_FRONTMATTER_DEFAULTS.objects_intro);
    expect(normalizeBody(LANDING.welcome_body)).not.toBe(normalizeBody(V121_BODIES.index));
  });

  it("buildIndexMd suppresses the verbatim v1.2.1 defaults (gate pin)", () => {
    const md = buildIndexMd({
      stories_heading: V121_FRONTMATTER_DEFAULTS.stories_heading,
      stories_intro: null,
      objects_heading: V121_FRONTMATTER_DEFAULTS.objects_heading,
      objects_intro: V121_FRONTMATTER_DEFAULTS.objects_intro,
      welcome_body: V121_BODIES.index,
    });
    expect(md).not.toContain("stories_heading");
    expect(md).not.toContain("objects_heading");
    expect(md).not.toContain("objects_intro");
    expect(normalizeBody(md)).not.toBe(normalizeBody(V121_BODIES.index));
  });
});

// ---------------------------------------------------------------------------
// Participation accounting: the exact set of registry fields that do NOT
// round-trip through the generic harness (one-sided or fully excluded on the
// publish/import axes). A new field landing in this set fails here until it
// is triaged — either given a sentinel round trip above or added with a
// justification comment.
// ---------------------------------------------------------------------------

describe("registry participation accounting", () => {
  it("the one-sided / excluded publish-import fields are exactly the known set", () => {
    const partial: string[] = [];
    for (const entity of FIELD_REGISTRY) {
      for (const field of entity.fields) {
        const publishes = !("excluded" in field.publish);
        const imports = !("excluded" in field.import);
        if (!publishes || !imports) partial.push(`${entity.entity}.${field.name}`);
      }
    }
    expect(partial.sort()).toEqual(
      [
        "stories.draft", // file-presence publish; import excluded (orphan-restore path) — pinned above
        "objects.image_available", // internal probe state, both sides excluded/derived
        "objects.missing_from_repo", // sync-derived flag, excluded both sides
        "objects.origin", // provenance classifier, excluded both sides
        "pages.order", // import-only tree-index; publishes via navigation_json
        "config.telar_version", // import-only (telar.version) — pinned one-sided above
        "config.google_sheets_enabled", // import-only — pinned one-sided above
        "config.google_sheets_published_url", // import-only — pinned one-sided above
        "config.navigation_json", // publish-only navigation-yml (one-way, declared)
      ].sort(),
    );
  });
});

/**
 * Field-registry entity-hash sensitivity probes.
 *
 * These tests are GENERATED from FIELD_REGISTRY (app/lib/field-registry.ts):
 * for every declared field, a probe builds a rich baseline fixture set for
 * buildEntityHashes and a mutated copy where ONLY that field's value changes,
 * then asserts:
 *
 *   - hash: { bucket }  -> the declared bucket's hash CHANGES, and every
 *     other bucket's hash stays byte-identical (buckets have disjoint
 *     inputs, so a single-field mutation must move exactly one bucket);
 *   - hash: excluded    -> NO bucket hash changes at all.
 *
 * Because the probes iterate the registry, declaring `hash: { bucket }` on a
 * field automatically demands that buildEntityHashes actually feed it into
 * that bucket — a declaration the code does not honor fails here.
 *
 * Notes verified against publish.server.ts while writing this suite:
 *   - The settings hash is JSON.stringify(buildConfigChangeFields(config)),
 *     which flattens buildConfigManagedFields + the story_interface /
 *     collection_interface blocks — so ALL config fields the registry
 *     declares under the settings bucket are real hash inputs, even though
 *     the per-field commit-message diff is computed separately against
 *     snapshot.config_managed ("completeness/symmetry" per the code comment).
 *   - stories.draft is membership, not content: draft stories are excluded
 *     from the stories bucket, so it gets a dedicated membership probe
 *     instead of the generic changed/unchanged probe.
 *   - Step and layer fields live inside the story fixture and land in the
 *     stories bucket, matching their registry declarations.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect, vi } from "vitest";
import { buildEntityHashes } from "~/lib/publish.server";
import type { EntityHashes } from "~/lib/publish.server";
import {
  FIELD_REGISTRY,
  type EntityDecl,
  type FieldDecl,
  type HashBucket,
} from "../app/lib/field-registry";

// ---------------------------------------------------------------------------
// Fixtures — one project with one story (one step, one layer), one object,
// one page, one glossary term, a full config row, and a landing row. Every
// field carries a non-degenerate base value so a mutation always produces a
// genuinely different input.
// ---------------------------------------------------------------------------

interface Fixtures {
  stories: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
  layers: Array<Record<string, unknown>>;
  objects: Array<Record<string, unknown>>;
  pages: Array<Record<string, unknown>>;
  glossary: Array<Record<string, unknown>>;
  config: Record<string, unknown>;
  landing: Record<string, unknown>;
}

function baseFixtures(): Fixtures {
  return {
    stories: [
      {
        id: 1,
        project_id: 1,
        story_id: "s1",
        title: "Story title",
        subtitle: "Story subtitle",
        byline: "An author",
        order: 1,
        private: false,
        draft: false,
        show_sections: false,
        updated_at: null,
      },
    ],
    steps: [
      {
        id: 10,
        story_id: 1,
        step_number: 1,
        kind: "media",
        object_id: "obj-1",
        x: 0.5,
        y: 0.5,
        zoom: 1,
        page: "2",
        question: "A question",
        answer: "An answer",
        alt_text: "Step alt",
        clip_start: "0:01",
        clip_end: "0:05",
        loop: "yes",
      },
    ],
    layers: [
      {
        id: 100,
        step_id: 10,
        layer_number: 1,
        title: "Layer title",
        button_label: "Read more",
        content: "Layer body",
      },
    ],
    objects: [
      {
        id: 1,
        project_id: 1,
        object_id: "obj-1",
        title: "Object title",
        featured: false,
        creator: "A creator",
        description: "A description",
        source_url: "https://example.org/manifest",
        period: "Colonial",
        year: "1600",
        object_type: "map",
        subjects: "cartography",
        source: "An archive",
        credit: "A credit",
        thumbnail: "thumb.jpg",
        alt_text: "Object alt",
        dimensions: "10 x 10 cm",
        extra_columns: '{"accession_number":"ACC-1"}',
        image_available: true,
        missing_from_repo: false,
        origin: "repo",
        updated_at: null,
      },
    ],
    pages: [{ title: "About", slug: "about", body: "Page body", order: 0 }],
    glossary: [
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: "mita",
      },
    ],
    config: {
      id: 1,
      project_id: 1,
      title: "Site title",
      lang: "en",
      baseurl: "/site",
      url: "https://example.github.io",
      telar_version: "1.0.0",
      theme: "trama",
      description: "Site description",
      author: "Site author",
      email: "owner@example.org",
      logo: "/assets/logo.png",
      include_demo_content: true,
      google_sheets_enabled: false,
      google_sheets_published_url: null,
      show_on_homepage: true,
      show_story_steps: true,
      show_object_credits: true,
      browse_and_search: true,
      show_link_on_homepage: true,
      show_sample_on_homepage: false,
      collection_mode: false,
      featured_count: 4,
      story_key: "secret-key",
      navigation_json: JSON.stringify([{ label: "Home", url: "/" }]),
    },
    landing: {
      id: 1,
      project_id: 1,
      stories_heading: "Stories",
      stories_intro: "Stories intro",
      objects_heading: "Objects",
      objects_intro: "Objects intro",
      welcome_body: "Welcome body",
    },
  };
}

// ---------------------------------------------------------------------------
// Sequential mock DB — buildEntityHashes runs Promise.all of six selects in
// order (stories, objects, pages, glossary, config, landing), then one steps
// select per non-draft story and one layers select per step. Same thenable
// pattern as the buildEntityHashes harness in tests/publish.server.test.ts.
// ---------------------------------------------------------------------------

function makeDb(fx: Fixtures): Parameters<typeof buildEntityHashes>[0] {
  const responses: unknown[] = [
    fx.stories,
    fx.objects,
    fx.pages,
    fx.glossary,
    [fx.config],
    [fx.landing],
  ];
  for (const story of fx.stories) {
    if (story.draft) continue;
    responses.push(fx.steps);
    for (const _step of fx.steps) responses.push(fx.layers);
  }

  let callIndex = 0;
  function makeResult() {
    const data = responses[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(data);
  }
  const db: Record<string, unknown> = {};
  function terminal() {
    return Object.assign(
      {
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(makeResult()).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e);
          }
        },
      },
      db,
    );
  }
  db.select = vi.fn(() => terminal());
  db.from = vi.fn(() => terminal());
  db.where = vi.fn(() => terminal());
  db.limit = vi.fn(() => terminal());
  db.orderBy = vi.fn(() => terminal());
  return db as unknown as Parameters<typeof buildEntityHashes>[0];
}

async function hashesFor(fx: Fixtures): Promise<EntityHashes> {
  return buildEntityHashes(makeDb(fx), 1);
}

/**
 * Comparable string per bucket. Record buckets are serialized whole so key
 * renames (story_id / object_id / term_id / slug mutations) register as a
 * bucket change too.
 */
function bucketStrings(h: EntityHashes): Record<HashBucket, string> {
  return {
    objects: JSON.stringify(h.objects),
    stories: JSON.stringify(h.stories),
    pages: JSON.stringify(h.pages),
    glossary: JSON.stringify(h.glossary),
    navigation: h.navigation,
    landing: h.landing,
    settings: h.settings,
  };
}

const ALL_BUCKETS: HashBucket[] = [
  "objects",
  "stories",
  "pages",
  "glossary",
  "navigation",
  "landing",
  "settings",
];

// ---------------------------------------------------------------------------
// Mutation engine — one mutated fixture set per registry field.
// ---------------------------------------------------------------------------

const ENTITY_ROW: Record<EntityDecl["entity"], (fx: Fixtures) => Record<string, unknown>> = {
  stories: (fx) => fx.stories[0],
  steps: (fx) => fx.steps[0],
  layers: (fx) => fx.layers[0],
  objects: (fx) => fx.objects[0],
  pages: (fx) => fx.pages[0],
  glossary: (fx) => fx.glossary[0],
  config: (fx) => fx.config,
  landing: (fx) => fx.landing,
};

/** Semantically-shaped overrides where a generic mutation would be nonsense. */
const VALUE_OVERRIDES: Record<string, unknown> = {
  "steps.kind": "section",
  "config.lang": "es",
  "config.navigation_json": JSON.stringify([{ label: "Inicio", url: "/" }]),
  "objects.extra_columns": '{"accession_number":"ACC-2"}',
};

function mutatedValue(entity: EntityDecl["entity"], field: FieldDecl, current: unknown): unknown {
  const override = VALUE_OVERRIDES[`${entity}.${field.name}`];
  if (override !== undefined) return override;
  switch (field.d1.type) {
    case "text":
      return `${String(current ?? "")}-mutated`;
    case "int":
      return (typeof current === "number" ? current : 0) + 1;
    case "real":
      return (typeof current === "number" ? current : 0) + 0.25;
    case "bool":
      return !current;
    case "json":
      return '{"mutated":"1"}';
  }
}

function mutatedFixtures(entity: EntityDecl["entity"], field: FieldDecl): Fixtures {
  const fx = baseFixtures();
  const row = ENTITY_ROW[entity](fx);
  row[field.name] = mutatedValue(entity, field, row[field.name]);
  return fx;
}

// ---------------------------------------------------------------------------
// Generated probes
// ---------------------------------------------------------------------------

const allFields: Array<{ entity: EntityDecl["entity"]; field: FieldDecl }> = FIELD_REGISTRY.flatMap(
  (e) => e.fields.map((field) => ({ entity: e.entity, field })),
);

describe("registry hash probes (generation guard)", () => {
  it("the registry yields a non-trivial field list to generate from", () => {
    expect(allFields.length).toBeGreaterThan(50);
  });
});

describe("registry hash probes — per-field bucket sensitivity", () => {
  for (const { entity, field } of allFields) {
    // Membership semantics, not content: probed separately below.
    if (entity === "stories" && field.name === "draft") continue;

    if ("bucket" in field.hash) {
      const bucket = field.hash.bucket;
      it(`${entity}.${field.name}: mutating it changes the "${bucket}" hash and no other bucket`, async () => {
        const baseline = bucketStrings(await hashesFor(baseFixtures()));
        const mutated = bucketStrings(await hashesFor(mutatedFixtures(entity, field)));

        expect(mutated[bucket], `${entity}.${field.name} must be an input to the ${bucket} hash`).not.toBe(
          baseline[bucket],
        );
        for (const other of ALL_BUCKETS) {
          if (other === bucket) continue;
          expect(mutated[other], `${entity}.${field.name} leaked into the ${other} hash`).toBe(
            baseline[other],
          );
        }
      });
    } else {
      it(`${entity}.${field.name}: declared hash-excluded — mutating it changes NO bucket hash`, async () => {
        const baseline = bucketStrings(await hashesFor(baseFixtures()));
        const mutated = bucketStrings(await hashesFor(mutatedFixtures(entity, field)));

        for (const bucket of ALL_BUCKETS) {
          expect(
            mutated[bucket],
            `${entity}.${field.name} is declared excluded but moved the ${bucket} hash`,
          ).toBe(baseline[bucket]);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// stories.draft — bucket MEMBERSHIP, not a hashed value. Flipping a story to
// draft removes its entry from the stories bucket; the surviving stories'
// hashes must be untouched.
// ---------------------------------------------------------------------------

describe("registry hash probes — stories.draft membership", () => {
  function twoStoryFixtures(s2Draft: boolean): Fixtures {
    const fx = baseFixtures();
    // No steps/layers so the per-story query accounting stays trivial: the
    // mock's default [] response covers both stories' steps selects.
    fx.steps = [];
    fx.layers = [];
    fx.stories = [
      { ...fx.stories[0] },
      { ...fx.stories[0], id: 2, story_id: "s2", title: "Second story", draft: s2Draft },
    ];
    return fx;
  }

  it("flipping draft on changes bucket membership, not other stories' hashes", async () => {
    const baseline = await hashesFor(twoStoryFixtures(false));
    const mutated = await hashesFor(twoStoryFixtures(true));

    expect(Object.keys(baseline.stories).sort()).toEqual(["s1", "s2"]);
    expect(Object.keys(mutated.stories)).toEqual(["s1"]);
    expect(mutated.stories.s1).toBe(baseline.stories.s1);
  });
});

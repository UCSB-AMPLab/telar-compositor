/**
 * Field-registry list diffs — pins the hand-maintained field-list constants
 * (CSV column lists, bilingual header rows, import header mapping, config key
 * sets) against the registry's declarations, in BOTH directions. A constant
 * entry that no registry field claims fails here, and a registry declaration
 * that the constants do not carry fails here too. This is the suite that makes
 * "added a column to the CSV writer but not the registry" (or vice versa) a
 * red test instead of a silent data gap.
 *
 * Diffed constants:
 *   - publish.server: PROJECT/STORY/GLOSSARY_CSV_COLUMNS + *_BILINGUAL_ROW,
 *     MANAGED_STRING_FIELD_KEYS, KNOWN_CONFIG_KEYS
 *   - csv-export.server: OBJECTS_CSV_COLUMNS + BILINGUAL_ROW
 *   - import.server: COLUMN_NAME_MAPPING, KNOWN_OBJECT_KEYS
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect } from "vitest";
import {
  getEntity,
  isExcluded,
  type FieldDecl,
  type PublishFile,
} from "../app/lib/field-registry";
import {
  PROJECT_CSV_COLUMNS,
  PROJECT_BILINGUAL_ROW,
  STORY_CSV_COLUMNS,
  STORY_BILINGUAL_ROW,
  GLOSSARY_CSV_COLUMNS,
  GLOSSARY_BILINGUAL_ROW,
  MANAGED_STRING_FIELD_KEYS,
  KNOWN_CONFIG_KEYS,
} from "~/lib/publish.server";
import {
  OBJECTS_CSV_COLUMNS,
  BILINGUAL_ROW as OBJECTS_BILINGUAL_ROW,
} from "~/lib/csv-export.server";
import { COLUMN_NAME_MAPPING, KNOWN_OBJECT_KEYS } from "~/lib/import.server";
import {
  STORY_SYNC_FIELDS,
  MANAGED_CONFIG_FIELDS,
  CONFIG_YAML_KEY_ALIASES,
  GLOSSARY_SYNC_FIELDS,
} from "~/lib/sync.server";

/** The five entities whose fields live in the published CSV files. */
type CsvEntity = "stories" | "steps" | "layers" | "objects" | "glossary";

const CSV_FILE: Record<CsvEntity, PublishFile> = {
  stories: "project.csv",
  steps: "story.csv",
  layers: "story.csv",
  objects: "objects.csv",
  glossary: "glossary.csv",
};

/** Steps carry exactly two layers; layer{n} templates expand to n = 1, 2. */
const LAYER_NS = [1, 2] as const;

function expandLayerTemplate(template: string): string[] {
  return LAYER_NS.map((n) => template.replace("{n}", String(n)));
}

/**
 * The concrete CSV column names a registry field claims in its entity's CSV
 * file. Structural "(...)" placeholder keys claim no column of their own
 * (draft's file-presence, kind's empty-object-cell, extra_columns' JSON
 * spread, layer_number's cell pair — each pinned by dedicated tests instead).
 *
 * Special case — layers.content: the layer BODY publishes to layer.md
 * (encoding filename-ref), but the story.csv layer{n}_content columns hold
 * the .md filename references and are claimed through content's declared
 * IMPORT headers. Deriving the columns from those headers means adding a
 * layer3_content column to STORY_CSV_COLUMNS without a registry change fails
 * this suite.
 */
function csvColumns(entity: CsvEntity, field: FieldDecl): string[] {
  if (entity === "layers" && field.name === "content") {
    if (isExcluded(field.import)) return [];
    return field.import.headers.filter((h) => /^layer\d+_content$/.test(h));
  }
  const pub = field.publish;
  if (isExcluded(pub)) return [];
  if (pub.file !== CSV_FILE[entity]) return [];
  if (pub.key.startsWith("(")) return [];
  if (pub.key.includes("{n}")) return expandLayerTemplate(pub.key);
  return [pub.key];
}

/**
 * [EN column, ES bilingual-row value] pairs a registry field contributes to
 * its file's bilingual second row. layers.content has no publish esKey (its
 * publish target is layer.md), so its contenido{n} pairing is stated here
 * directly; a dedicated test below anchors those ES names to content's
 * declared import aliases so the pairing cannot drift silently.
 */
function esEntries(entity: CsvEntity, field: FieldDecl): Array<[string, string]> {
  if (entity === "layers" && field.name === "content") {
    return LAYER_NS.map((n) => [`layer${n}_content`, `contenido${n}`]);
  }
  const pub = field.publish;
  if (isExcluded(pub)) return [];
  if (pub.file !== CSV_FILE[entity]) return [];
  const es = pub.esKey;
  if (!es) return [];
  if (pub.key.includes("{n}")) {
    return LAYER_NS.map((n) => [
      pub.key.replace("{n}", String(n)),
      es.replace("{n}", String(n)),
    ]);
  }
  return [[pub.key, es]];
}

/** All [entity, field] pairs for one CSV entity, labeled for failure output. */
function fieldsOf(entity: CsvEntity): Array<{ label: string; field: FieldDecl }> {
  return getEntity(entity).fields.map((field) => ({
    label: `${entity}.${field.name}`,
    field,
  }));
}

/**
 * Generic two-direction column diff for the single-entity CSV files
 * (project.csv, objects.csv, glossary.csv). story.csv spans two entities and
 * gets its own block below.
 */
function diffColumns(entity: CsvEntity, constantName: string, columns: readonly string[]) {
  const constant = new Set<string>(columns);
  const claimed = new Map<string, string>(); // column -> claiming field label
  for (const { label, field } of fieldsOf(entity)) {
    for (const col of csvColumns(entity, field)) {
      expect(
        constant.has(col),
        `${label} declares CSV column "${col}" but ${constantName} does not carry it`,
      ).toBe(true);
      claimed.set(col, label);
    }
  }
  for (const col of columns) {
    expect(
      claimed.has(col),
      `${constantName} carries "${col}" but no ${entity} registry declaration claims it`,
    ).toBe(true);
  }
}

function expectedBilingualRow(entities: CsvEntity[]): Record<string, string> {
  const expected: Record<string, string> = {};
  for (const entity of entities) {
    for (const { field } of fieldsOf(entity)) {
      for (const [en, es] of esEntries(entity, field)) {
        expected[en] = es;
      }
    }
  }
  return expected;
}

// ---------------------------------------------------------------------------
// project.csv
// ---------------------------------------------------------------------------

describe("project.csv vs stories registry declarations", () => {
  // stories.draft is exempt by construction: its publish declaration is the
  // structural "(membership)" file-presence encoding (a draft is a story file
  // absent from project.csv), pinned by the orphans-are-drafts publish tests.
  it("columns diff both ways against PROJECT_CSV_COLUMNS", () => {
    diffColumns("stories", "PROJECT_CSV_COLUMNS", PROJECT_CSV_COLUMNS);
  });

  it("registry esKeys equal PROJECT_BILINGUAL_ROW", () => {
    expect(PROJECT_BILINGUAL_ROW).toEqual(expectedBilingualRow(["stories"]));
  });
});

// ---------------------------------------------------------------------------
// story.csv  (steps + layers)
// ---------------------------------------------------------------------------

describe("story.csv vs steps + layers registry declarations", () => {
  it("layers.content declares the ES contenido{n} aliases its bilingual pairing relies on", () => {
    // Anchors the hardcoded contenido1/contenido2 pairing in esEntries to the
    // registry: if the ES aliases leave content's import headers, this fails
    // before the bilingual diff can pass on stale hardcoded names.
    const content = getEntity("layers").fields.find((f) => f.name === "content");
    expect(content, "layers.content missing from the registry").toBeDefined();
    const imp = content!.import;
    expect(isExcluded(imp), "layers.content import axis unexpectedly excluded").toBe(false);
    if (!isExcluded(imp)) {
      for (const n of LAYER_NS) {
        expect(
          imp.headers.includes(`contenido${n}`),
          `layers.content no longer declares the "contenido${n}" import alias`,
        ).toBe(true);
      }
    }
  });

  it("columns diff both ways against STORY_CSV_COLUMNS", () => {
    const constant = new Set<string>(STORY_CSV_COLUMNS);
    const claimed = new Map<string, string>();
    for (const entity of ["steps", "layers"] as const) {
      for (const { label, field } of fieldsOf(entity)) {
        for (const col of csvColumns(entity, field)) {
          expect(
            constant.has(col),
            `${label} declares story.csv column "${col}" but STORY_CSV_COLUMNS does not carry it`,
          ).toBe(true);
          claimed.set(col, label);
        }
      }
    }
    for (const col of STORY_CSV_COLUMNS) {
      expect(
        claimed.has(col),
        `STORY_CSV_COLUMNS carries "${col}" but no steps/layers registry declaration claims it`,
      ).toBe(true);
    }
  });

  it("registry esKeys (with {n} expansion) equal STORY_BILINGUAL_ROW", () => {
    expect(STORY_BILINGUAL_ROW).toEqual(expectedBilingualRow(["steps", "layers"]));
  });
});

// ---------------------------------------------------------------------------
// objects.csv
// ---------------------------------------------------------------------------

describe("objects.csv vs objects registry declarations", () => {
  // extra_columns is the structural "(custom columns)" JSON spread;
  // image_available, missing_from_repo, and origin are publish-excluded
  // compositor-internal state — none of them claim a fixed column.
  it("columns diff both ways against OBJECTS_CSV_COLUMNS", () => {
    diffColumns("objects", "OBJECTS_CSV_COLUMNS", OBJECTS_CSV_COLUMNS);
  });

  it("registry esKeys equal csv-export's BILINGUAL_ROW", () => {
    expect(OBJECTS_BILINGUAL_ROW).toEqual(expectedBilingualRow(["objects"]));
  });
});

// ---------------------------------------------------------------------------
// glossary.csv
// ---------------------------------------------------------------------------

describe("glossary.csv vs glossary registry declarations", () => {
  it("columns diff both ways against GLOSSARY_CSV_COLUMNS", () => {
    diffColumns("glossary", "GLOSSARY_CSV_COLUMNS", GLOSSARY_CSV_COLUMNS);
  });

  it("registry esKeys equal GLOSSARY_BILINGUAL_ROW", () => {
    expect(GLOSSARY_BILINGUAL_ROW).toEqual(expectedBilingualRow(["glossary"]));
  });
});

// ---------------------------------------------------------------------------
// COLUMN_NAME_MAPPING  (import header normalization)
// ---------------------------------------------------------------------------

describe("COLUMN_NAME_MAPPING vs registry import declarations", () => {
  const csvEntities = Object.keys(CSV_FILE) as CsvEntity[];

  it("every declared import header maps to one of its field's CSV columns", () => {
    for (const entity of csvEntities) {
      for (const { label, field } of fieldsOf(entity)) {
        if (isExcluded(field.import)) continue;
        const canonical = csvColumns(entity, field);
        // Fields with no concrete CSV column of their own (structural-import
        // fields like steps.kind, whose headers alias another field's column)
        // are pinned by their dedicated structural tests, not this diff.
        if (canonical.length === 0) continue;
        const accepted = new Set(canonical);
        if (entity === "objects" && field.name === "object_type") {
          // Legacy fallback: mapObjectsCsv reads the raw `object_type` column
          // (row.medium_genre || row.object_type), so the header is accepted
          // post-transform without being renamed to medium_genre.
          accepted.add("object_type");
        }
        for (const header of field.import.headers) {
          const lower = header.toLowerCase();
          if (entity === "objects" && field.name === "object_type" && lower === "object_type") {
            // Deliberately absent from COLUMN_NAME_MAPPING: transformHeader
            // passes it through verbatim and the mapper's legacy fallback
            // consumes it. Adding a mapping entry would rename the column to
            // medium_genre and silently change the fallback/extra_columns
            // semantics — pin the absence.
            expect(
              COLUMN_NAME_MAPPING[lower],
              `objects.object_type legacy header "object_type" gained a COLUMN_NAME_MAPPING entry`,
            ).toBeUndefined();
            continue;
          }
          const target = COLUMN_NAME_MAPPING[lower];
          expect(
            target,
            `${label} header "${header}" has no COLUMN_NAME_MAPPING entry`,
          ).toBeDefined();
          expect(
            accepted.has(target!),
            `${label} header "${header}" maps to "${target}", not one of its CSV columns [${canonical.join(", ")}]`,
          ).toBe(true);
        }
      }
    }
  });

  it("every COLUMN_NAME_MAPPING target is a CSV column claimed by some registry field", () => {
    const claimed = new Set<string>();
    for (const entity of csvEntities) {
      for (const { field } of fieldsOf(entity)) {
        for (const col of csvColumns(entity, field)) claimed.add(col);
      }
    }
    for (const [header, target] of Object.entries(COLUMN_NAME_MAPPING)) {
      expect(
        claimed.has(target),
        `COLUMN_NAME_MAPPING["${header}"] -> "${target}" targets a column no registry field claims (orphan mapping)`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// KNOWN_OBJECT_KEYS  (extra_columns passthrough boundary)
// ---------------------------------------------------------------------------

describe("KNOWN_OBJECT_KEYS vs OBJECTS_CSV_COLUMNS", () => {
  it("equals the CSV column set plus the object_type legacy fallback", () => {
    // `object_type` is not a published column (v1.0.0 renamed it to
    // medium_genre) but the mapper still reads it as a legacy fallback, so it
    // must stay a consumed first-class key — otherwise a legacy CSV's
    // object_type cell would be double-captured into extra_columns.
    const expected = new Set<string>([...OBJECTS_CSV_COLUMNS, "object_type"]);
    expect([...KNOWN_OBJECT_KEYS].sort()).toEqual([...expected].sort());
  });
});

// ---------------------------------------------------------------------------
// Config key sets  (_config.yml sweep and heal boundaries)
// ---------------------------------------------------------------------------

describe("config key sets vs config registry declarations", () => {
  it("MANAGED_STRING_FIELD_KEYS equals the quoted-yaml publish keys minus the two constrained-token exceptions", () => {
    // telar_theme (theme) and protected.key (story_key) are also quoted-yaml
    // but deliberately NOT in the free-text corruption-sweep set — their
    // values are constrained tokens, not user prose, so they are not a
    // scalar-corruption source. Everything else quoted must be swept.
    const quotedKeys = new Set(
      getEntity("config")
        .fields.map((f) => f.publish)
        .filter((pub) => !isExcluded(pub) && pub.encoding === "quoted-yaml")
        .map((pub) => (pub as { key: string }).key),
    );
    quotedKeys.delete("telar_theme");
    quotedKeys.delete("protected.key");
    expect([...MANAGED_STRING_FIELD_KEYS].sort()).toEqual([...quotedKeys].sort());
  });

  it("KNOWN_CONFIG_KEYS recognizes the top-level segment of every published config key", () => {
    // The sweep boundary must treat every managed key's top-level line as
    // structural; an unrecognized segment would be swept as prose during a
    // config heal.
    for (const field of getEntity("config").fields) {
      const pub = field.publish;
      if (isExcluded(pub) || pub.file !== "_config.yml") continue;
      const top = pub.key.split(".")[0];
      expect(
        KNOWN_CONFIG_KEYS.has(top),
        `config.${field.name} publishes under top-level key "${top}", which KNOWN_CONFIG_KEYS does not recognize`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Derivation pins — the sync module's flat field lists vs the registry
// ---------------------------------------------------------------------------

describe("sync field lists vs registry sync declarations (derivation pins)", () => {
  // These lists stay hand-written in sync.server.ts because their literal
  // union types (SyncField, ManagedConfigField, keyof StorySyncItem) are
  // load-bearing; a runtime-derived array would erode them to string. The
  // exact-equality pins below give the same drift protection as derivation:
  // adding a field to either side without the other fails here by name.
  // (The objects list, SYNC_FIELDS, is pinned by the generation guard in
  // tests/field-registry-sync-probes.test.ts.)

  function syncFields(entity: "stories" | "config" | "glossary", diff: string): string[] {
    return getEntity(entity)
      .fields.filter(
        (f) => !isExcluded(f.sync) && f.sync.diff === diff && f.sync.role !== "key",
      )
      .map((f) => (isExcluded(f.sync) ? f.name : (f.sync.itemKey ?? f.name)));
  }

  it("STORY_SYNC_FIELDS equals the registry's storyFields declarations (via itemKey)", () => {
    expect([...STORY_SYNC_FIELDS].sort()).toEqual(syncFields("stories", "storyFields").sort());
  });

  it("MANAGED_CONFIG_FIELDS equals the registry's config sync declarations", () => {
    expect([...MANAGED_CONFIG_FIELDS].sort()).toEqual(syncFields("config", "config").sort());
  });

  it("CONFIG_YAML_KEY_ALIASES equals the registry's declared yamlKey aliases", () => {
    const expected: Record<string, string> = {};
    for (const field of getEntity("config").fields) {
      if (isExcluded(field.sync) || field.sync.diff !== "config") continue;
      if (field.sync.yamlKey && field.sync.yamlKey !== field.name) {
        expected[field.name] = field.sync.yamlKey;
      }
    }
    expect({ ...CONFIG_YAML_KEY_ALIASES }).toEqual(expected);
  });

  it("GLOSSARY_SYNC_FIELDS equals the registry's glossary sync declarations", () => {
    expect([...GLOSSARY_SYNC_FIELDS].sort()).toEqual(syncFields("glossary", "glossary").sort());
  });
});

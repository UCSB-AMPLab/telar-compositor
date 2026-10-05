/**
 * The divisors in `D1_BIND_DIVISORS` must still bound the real per-row bind count.
 *
 * D1 refuses a statement carrying more than 100 bound parameters, and the
 * import batches its inserts as `Math.floor(100 / divisor)` rows at a time. The
 * divisor is therefore a claim about how many columns each mapped row has, made
 * once in a comment and never checked — so adding a column anywhere in the
 * import silently narrows the margin, and the failure only shows on a repo with
 * enough rows to fill a chunk. `last_edited_by` and `created_by_actor` both
 * arrived in one release.
 *
 * This measures the mapped rows instead of trusting the comment. Drizzle binds
 * one parameter per key present on the object, plus nothing for keys omitted,
 * so the key count of a FULLY populated row is the bind count per row.
 *
 * A failure here means either the divisor needs raising or a column needs
 * dropping from the import — not that the test needs relaxing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  D1_BIND_DIVISORS as DIVISORS,
  mapObjectsCsv,
  mapProjectCsv,
  mapGlossaryCsv,
  mapStoryCsv,
  mapThemeYaml,
} from "../app/lib/import.server";

/**
 * Keys a MappedLayer carries that are NOT columns: they name the layer's parent
 * step and are destructured off at the insert boundary. Listed here so this test
 * measures the row that actually reaches D1.
 */
const NOT_COLUMNS_ON_LAYER = ["storyPlaceholder", "stepNumber", "stepIndex"] as const;

/**
 * Columns the import adds after mapping, which the mappers themselves do not
 * put on the row. Kept explicit so this test fails when one is added rather
 * than quietly measuring the wrong shape.
 */
const ADDED_AFTER_MAPPING = {
  objects: ["project_id", "created_by_actor"],
  stories: ["project_id", "created_by_actor", "source_path"],
  glossary: ["project_id", "created_by_actor"],
  steps: ["story_id", "created_by_actor"],
  layers: ["step_id", "created_by_actor"],
} as const;

/** Every column populated, so the count is the worst case rather than a sample. */
const FULL_OBJECT_ROW: Record<string, string> = {
  object_id: "o1", title: "T", creator: "C", description: "D", alt_text: "A",
  source_url: "https://e.org/1", period: "P", year: "1600", object_type: "map",
  subjects: "s", source: "S", credit: "Cr", thumbnail: "t.jpg", dimensions: "1x1",
  featured: "true", custom_extra: "x",
};

const FULL_STORY_ROW: Record<string, string> = {
  story_id: "s1", title: "T", subtitle: "Sub", byline: "By", private: "yes",
  draft: "yes", show_sections: "yes", order: "1", custom_extra: "x",
};

const FULL_GLOSSARY_ROW: Record<string, string> = {
  term_id: "t1", title: "T", definition: "D", related_terms: "a|b",
};

const FULL_STEP_ROW: Record<string, string> = {
  step: "1", object: "o1", question: "Q", answer: "A", alt_text: "Alt",
  x: "0.5", y: "0.5", zoom: "2", page: "3", clip_start: "0", clip_end: "9",
  loop: "true", layer1_button: "More", layer1_content: "Body",
  layer2_button: "More2", layer2_content: "Body2",
};

function bindCount(
  row: object,
  added: readonly string[],
  removed: readonly string[] = [],
): number {
  const keys = new Set(Object.keys(row));
  for (const k of added) keys.add(k);
  for (const k of removed) keys.delete(k);
  return keys.size;
}

/** Every field a theme file can fill. */
const FULL_THEME: Record<string, unknown> = {
  name: "N", description: "D", creator: "C", creator_url: "https://e.org",
  colors: { text: { heading: "#000000" } },
};

describe("import inserts stay inside D1's 100-bind statement limit", () => {
  it("themes", () => {
    const row = mapThemeYaml("trama", FULL_THEME);
    const binds = bindCount(row, []);
    expect(binds).toBeLessThanOrEqual(DIVISORS.themes);
    expect(binds * Math.floor(100 / DIVISORS.themes)).toBeLessThanOrEqual(100);
  });

  it("objects", () => {
    const [row] = mapObjectsCsv([FULL_OBJECT_ROW]);
    const binds = bindCount(row, ADDED_AFTER_MAPPING.objects);
    expect(binds).toBeLessThanOrEqual(DIVISORS.objects);
    expect(binds * Math.floor(100 / DIVISORS.objects)).toBeLessThanOrEqual(100);
  });

  it("stories", () => {
    const [row] = mapProjectCsv([FULL_STORY_ROW]);
    const binds = bindCount(row, ADDED_AFTER_MAPPING.stories);
    expect(binds).toBeLessThanOrEqual(DIVISORS.stories);
    expect(binds * Math.floor(100 / DIVISORS.stories)).toBeLessThanOrEqual(100);
  });

  it("glossary terms", () => {
    const [row] = mapGlossaryCsv([FULL_GLOSSARY_ROW]);
    const binds = bindCount(row, ADDED_AFTER_MAPPING.glossary);
    expect(binds).toBeLessThanOrEqual(DIVISORS.glossary);
    expect(binds * Math.floor(100 / DIVISORS.glossary)).toBeLessThanOrEqual(100);
  });

  it("steps", () => {
    const { steps: mapped } = mapStoryCsv([FULL_STEP_ROW], -1);
    const binds = bindCount(mapped[0], ADDED_AFTER_MAPPING.steps);
    expect(binds).toBeLessThanOrEqual(DIVISORS.steps);
    expect(binds * Math.floor(100 / DIVISORS.steps)).toBeLessThanOrEqual(100);
  });

  it("pages", () => {
    // Built inline in `importRepo` rather than by a mapper, so the shape is
    // restated here. It is inserted one row per statement, which is why a
    // divisor of 7 against 8 columns never failed — but the divisor was still
    // wrong, and a future change to batch them would have found out the hard way.
    const row = {
      project_id: 1, title: "T", slug: "about", body: "B", order: 1,
      created_by_actor: "imported", created_at: "now", updated_at: "now",
    };
    const binds = bindCount(row, []);
    expect(binds).toBeLessThanOrEqual(DIVISORS.pages);
    expect(binds * Math.floor(100 / DIVISORS.pages)).toBeLessThanOrEqual(100);
  });

  it("layers", () => {
    const { layers: mapped } = mapStoryCsv([FULL_STEP_ROW], -1);
    // The parent keys never reach D1 — they are destructured off once the step
    // they name has a real id.
    for (const k of NOT_COLUMNS_ON_LAYER) expect(mapped[0]).toHaveProperty(k);
    const binds = bindCount(mapped[0], ADDED_AFTER_MAPPING.layers, NOT_COLUMNS_ON_LAYER);
    expect(binds).toBeLessThanOrEqual(DIVISORS.layers);
    expect(binds * Math.floor(100 / DIVISORS.layers)).toBeLessThanOrEqual(100);
  });
});

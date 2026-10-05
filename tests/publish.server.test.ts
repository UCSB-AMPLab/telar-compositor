/**
 * This file pins unit tests for `app/lib/publish.server.ts` — the
 * Telar Compositor publish library that serialises D1 state into the
 * CSV + markdown bundle the Jekyll site consumes.
 *
 * Tests cover:
 *   - serializeProjectCsv: CSV header, bilingual row, draft omission, private mapping, ordering
 *   - serializeStoryCsv: CSV header, bilingual row, empty step skipping, layer filename cells
 *   - layerFilename: slug-prefixed names with title-based and step/layer fallback
 *   - layerFileContent: frontmatter + body, no-frontmatter pass-through
 *   - updateConfigFields: line-based YAML mutation, comment preservation, append missing
 *   - computeChangeSummary: first-time publish, no-change, entity classification
 *   - runPrePublishValidation: stale head blocker, missing-title warning, no-position warning
 *   - storyPathsForPublish + computeStoryDeletions: draft round-trip + hard-delete cleanup
 *   - publish defensive gate: v1.2.1 frontmatter literals are stripped at publish time
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createEngine } from "knap";
import { filtersWithYamlString } from "~/lib/knap-filters.server";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  describeWithFramework,
  describeWithPythonMarkdown,
  describeWithRuby,
  splitFrontmatterViaFramework,
  splitFrontmatterViaFrameworkBatch,
} from "./helpers/framework-checkout";
import Papa from "papaparse";
import { load as loadYaml } from "js-yaml";
import {
  serializeProjectCsv,
  serializeStoryCsv,
  serializeStory,
  layerFilename,
  layerFileContent,
  guardAmbiguousRuleLines,
  updateConfigFields,
  updateConfigBlocks,
  healConfigYaml,
  buildConfigManagedFields,
  buildConfigManagedBlocks,
  buildConfigChangeFields,
  computeChangeSummary,
  runPrePublishValidation,
  buildNavigationYml,
  serializeGlossaryCsv,
  serializePageMarkdown,
  pageRowsToCommitFiles,
  buildPageContentHashes,
  isPagePublishable,
  ENTITY_HASHES_VERSION,
  buildEntityHashes,
  computeStoryDeletions,
  computePageDeletions,
  storyPathsForPublish,
  buildYmlRunsEncryptStep,
} from "~/lib/publish.server";
import type {
  PublishSnapshot,
  CurrentPublishState,
  EntityHashes,
  StepForValidation,
  ValidationResult,
} from "~/lib/publish.server";
import { parseTelarCsv, mapStoryCsv, parsePageMarkdown } from "~/lib/import.server";
import { extractConfigFields } from "~/lib/sync.server";
import { ANSWER_BUDGET, BREAK_LINES, LINE_CHARS, MAX_PARAGRAPHS } from "~/lib/answer-budget";
import { project_config } from "~/db/schema";

type ProjectConfigRow = typeof project_config.$inferSelect;

function makeConfig(overrides: Partial<ProjectConfigRow> = {}): ProjectConfigRow {
  return {
    id: 1,
    project_id: 1,
    title: null,
    lang: null,
    baseurl: null,
    url: null,
    telar_version: null,
    theme: null,
    description: null,
    author: null,
    email: null,
    logo: null,
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
    answer_word_limit: null,
    story_key: null,
    ...overrides,
  } as ProjectConfigRow;
}

// ---------------------------------------------------------------------------
// serializeProjectCsv
// ---------------------------------------------------------------------------

describe("serializeProjectCsv", () => {
  const baseStory = {
    story_id: "weavers",
    title: "The Weavers",
    subtitle: "A story",
    byline: "Jane Doe",
    order: 1,
    private: false,
    draft: false,
    show_sections: false,
  };

  it("produces header as first line", () => {
    const csv = serializeProjectCsv([baseStory]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("order,story_id,title,subtitle,byline,private,show_sections");
  });

  it("produces bilingual row as second line", () => {
    const csv = serializeProjectCsv([baseStory]);
    const lines = csv.split("\n");
    expect(lines[1]).toBe("orden,id_historia,titulo,subtitulo,firma,privada,mostrar_secciones");
  });

  it("omits draft stories entirely", () => {
    const draft = { ...baseStory, story_id: "draft-story", draft: true };
    const csv = serializeProjectCsv([baseStory, draft]);
    expect(csv).not.toContain("draft-story");
    expect(csv).toContain("weavers");
  });

  it("maps private: true to 'yes'", () => {
    const privateStory = { ...baseStory, private: true };
    const csv = serializeProjectCsv([privateStory]);
    expect(csv).toContain("yes");
  });

  it("maps private: false to empty string", () => {
    const csv = serializeProjectCsv([baseStory]);
    // Both private and show_sections are last/penultimate columns and should
    // be empty for baseStory (private:false, show_sections:false)
    const dataLine = csv.split("\n").find((l) => l.includes("weavers"));
    expect(dataLine).toBeDefined();
    // Row ends with two trailing empty columns
    expect(dataLine).toMatch(/,,$/);
  });

  it("sorts stories by order ascending", () => {
    const stories = [
      { ...baseStory, story_id: "c", order: 3 },
      { ...baseStory, story_id: "a", order: 1 },
      { ...baseStory, story_id: "b", order: 2 },
    ];
    const csv = serializeProjectCsv(stories);
    const storyLines = csv.split("\n").filter((l) => l.match(/^[0-9]/));
    const ids = storyLines.map((l) => l.split(",")[1]);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("maps null title/subtitle/byline to empty string", () => {
    const story = { ...baseStory, title: null, subtitle: null, byline: null };
    const csv = serializeProjectCsv([story]);
    // Data row after bilingual row — should have empty fields but not throw
    expect(csv).toContain("weavers");
    const dataLine = csv.split("\n").find((l) => l.includes("weavers"));
    // title, subtitle, byline, private, show_sections all empty (7 columns total)
    expect(dataLine).toBe("1,weavers,,,,,");
  });

  it("preserves comment rows from existing CSV", () => {
    const existingCsv = "order,story_id,title,subtitle,byline,private\n# This is a comment\n";
    const csv = serializeProjectCsv([baseStory], existingCsv);
    expect(csv).toContain("# This is a comment");
  });

  // --- show_sections / mostrar_secciones ---
  describe("show_sections column", () => {
    it("emits 'yes' in show_sections column when story.show_sections is true", () => {
      const story = { ...baseStory, show_sections: true };
      const csv = serializeProjectCsv([story]);
      const dataLine = csv.split("\n").find((l) => l.includes("weavers"));
      expect(dataLine).toBeDefined();
      // 7 columns: order,story_id,title,subtitle,byline,private,show_sections
      const fields = dataLine!.split(",");
      expect(fields[6]).toBe("yes");
    });

    it("emits empty string in show_sections column when story.show_sections is false", () => {
      const csv = serializeProjectCsv([baseStory]);
      const dataLine = csv.split("\n").find((l) => l.includes("weavers"));
      const fields = dataLine!.split(",");
      expect(fields[6]).toBe("");
    });

    it("preserves column order: show_sections appended at end", () => {
      const csv = serializeProjectCsv([baseStory]);
      expect(csv.split("\n")[0]).toBe(
        "order,story_id,title,subtitle,byline,private,show_sections",
      );
    });

    it("round-trips show_sections: true via mapProjectCsv", async () => {
      const story = { ...baseStory, show_sections: true };
      const csv = serializeProjectCsv([story]);
      const { parseTelarCsv, mapProjectCsv } = await import("~/lib/import.server");
      const rows = parseTelarCsv(csv);
      const mapped = mapProjectCsv(rows);
      expect(mapped).toHaveLength(1);
      expect(mapped[0].story_id).toBe("weavers");
      expect(mapped[0].show_sections).toBe(true);
    });

    it("round-trips show_sections: false via mapProjectCsv", async () => {
      const csv = serializeProjectCsv([baseStory]);
      const { parseTelarCsv, mapProjectCsv } = await import("~/lib/import.server");
      const rows = parseTelarCsv(csv);
      const mapped = mapProjectCsv(rows);
      expect(mapped).toHaveLength(1);
      expect(mapped[0].story_id).toBe("weavers");
      expect(mapped[0].show_sections).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// serializeStoryCsv
// ---------------------------------------------------------------------------

describe("serializeStoryCsv", () => {
  const emptyLayer = { layer_number: 1, title: null, button_label: null, content: null };
  const emptyLayer2 = { layer_number: 2, title: null, button_label: null, content: null };

  const baseStep = {
    step_number: 1,
    kind: "media" as "media" | "section",
    object_id: "my-object",
    x: 0.5,
    y: 0.3,
    zoom: 1.2,
    page: null,
    question: "What do you see?",
    answer: "A weaving.",
    alt_text: null as string | null,
    clip_start: null as string | null,
    clip_end: null as string | null,
    loop: null as string | null,
    layers: [] as { layer_number: number; title: string | null; button_label: string | null; content: string | null }[],
  };

  it("produces header as first line", () => {
    const csv = serializeStoryCsv([baseStep], "weavers");
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "step,object,x,y,zoom,page,question,answer,alt_text,layer1_button,layer1_content,layer2_button,layer2_content,clip_start,clip_end,loop",
    );
  });

  it("produces bilingual row as second line", () => {
    const csv = serializeStoryCsv([baseStep], "weavers");
    const lines = csv.split("\n");
    expect(lines[1]).toBe(
      "paso,objeto,x,y,zoom,pagina,pregunta,respuesta,texto_alt,boton1,contenido1,boton2,contenido2,inicio_clip,fin_clip,bucle",
    );
  });

  it("includes alt_text column after answer", () => {
    const step = { ...baseStep, alt_text: "Zoomed view of the central figure" };
    const csv = serializeStoryCsv([step], "weavers");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.alt_text).toBe("Zoomed view of the central figure");
  });

  it("emits empty alt_text for null value", () => {
    const step = { ...baseStep, alt_text: null };
    const csv = serializeStoryCsv([step], "weavers");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.alt_text).toBe("");
  });

  it("writes step_number to the step column", () => {
    const csv = serializeStoryCsv([{ ...baseStep, step_number: 3 }], "weavers");
    const dataLine = csv.split("\n").find((l) => /^3,/.test(l));
    expect(dataLine).toBeDefined();
  });

  it("null x/y/zoom use defaults (0.5, 0.5, 1)", () => {
    const step = { ...baseStep, x: null, y: null, zoom: null };
    const csv = serializeStoryCsv([step], "weavers");
    const dataLine = csv.split("\n").find((l) => /^1,/.test(l));
    // step,object,x,y,zoom -> 1,my-object,0.5,0.5,1
    expect(dataLine).toMatch(/^1,my-object,0\.5,0\.5,1,/);
  });

  // Pin the default-coordinate fallback at the parsed-column
  // level (header-keyed, not positional) so a future column reorder can't mask a
  // regression. A step with null x/y/zoom must export the string defaults
  // "0.5" / "0.5" / "1" (String(... ?? 0.5) in serializeStoryCsv).
  it("null x/y/zoom export the string defaults 0.5/0.5/1 in their named columns", () => {
    const step = { ...baseStep, x: null, y: null, zoom: null };
    const csv = serializeStoryCsv([step], "weavers");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.x).toBe("0.5");
    expect(dataRow.y).toBe("0.5");
    expect(dataRow.zoom).toBe("1");
  });

  it("skips fully empty steps", () => {
    const emptyStep = {
      step_number: 2,
      kind: "media" as "media" | "section",
      object_id: null,
      x: null,
      y: null,
      zoom: null,
      page: null,
      question: null,
      answer: null,
      alt_text: null as string | null,
      clip_start: null as string | null,
      clip_end: null as string | null,
      loop: null as string | null,
      layers: [],
    };
    const csv = serializeStoryCsv([baseStep, emptyStep], "weavers");
    // Only one data row (step 1) should appear
    const dataLines = csv.split("\n").filter((l) => /^[0-9]/.test(l));
    expect(dataLines).toHaveLength(1);
  });

  it("includes steps with question but no object", () => {
    const stepNoObj = {
      ...baseStep,
      object_id: null,
      question: "What is this?",
      answer: null,
    };
    const csv = serializeStoryCsv([stepNoObj], "weavers");
    const dataLines = csv.split("\n").filter((l) => /^[0-9]/.test(l));
    expect(dataLines).toHaveLength(1);
  });

  it("layer content cells contain the filename", () => {
    const step = {
      ...baseStep,
      layers: [
        {
          layer_number: 1,
          title: "Historical Context",
          button_label: "Learn more",
          content: "Some content here.",
        },
      ],
    };
    const csv = serializeStoryCsv([step], "weavers");
    expect(csv).toContain("weavers-historical-context.md");
  });

  it("layer button cell is populated only when content is non-empty", () => {
    const step = {
      ...baseStep,
      layers: [
        {
          layer_number: 1,
          title: null,
          button_label: "Click me",
          content: "", // empty content
        },
      ],
    };
    const csv = serializeStoryCsv([step], "weavers");
    // button should be empty when content is empty
    const dataLine = csv.split("\n").find((l) => /^1,/.test(l));
    expect(dataLine).toBeDefined();
    // layer1_button and layer1_content columns should both be empty
    const fields = dataLine!.split(",");
    // step,object,x,y,zoom,page,question,answer,layer1_button,layer1_content,...
    // indices: 0,1,2,3,4,5,6,7,8,9,...
    expect(fields[8]).toBe(""); // layer1_button
    expect(fields[9]).toBe(""); // layer1_content
  });

  it("empty layers produce empty button and content cells", () => {
    const step = {
      ...baseStep,
      layers: [emptyLayer, emptyLayer2],
    };
    const csv = serializeStoryCsv([step], "weavers");
    const dataLine = csv.split("\n").find((l) => /^1,/.test(l));
    // All 4 layer columns should be empty
    const fields = dataLine!.split(",");
    expect(fields[8]).toBe(""); // layer1_button
    expect(fields[9]).toBe(""); // layer1_content
    expect(fields[10]).toBe(""); // layer2_button
    expect(fields[11]).toBe(""); // layer2_content
  });

  // --- clip fields ---
  it("header row includes clip_start, clip_end, loop columns", () => {
    const csv = serializeStoryCsv([baseStep], "weavers");
    const header = csv.split("\n")[0];
    expect(header).toContain("clip_start");
    expect(header).toContain("clip_end");
    expect(header).toContain("loop");
  });

  it("bilingual row includes inicio_clip, fin_clip, bucle", () => {
    const csv = serializeStoryCsv([baseStep], "weavers");
    const bilingual = csv.split("\n")[1];
    expect(bilingual).toContain("inicio_clip");
    expect(bilingual).toContain("fin_clip");
    expect(bilingual).toContain("bucle");
  });

  it("data row includes clip_start, clip_end, loop values", () => {
    const step = {
      ...baseStep,
      clip_start: "12.5" as string | null,
      clip_end: "45.0" as string | null,
      loop: "true" as string | null,
    };
    const csv = serializeStoryCsv([step], "weavers");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.clip_start).toBe("12.5");
    expect(dataRow.clip_end).toBe("45.0");
    expect(dataRow.loop).toBe("true");
  });

  it("data row outputs empty string for null clip values", () => {
    const step = {
      ...baseStep,
      clip_start: null as string | null,
      clip_end: null as string | null,
      loop: null as string | null,
    };
    const csv = serializeStoryCsv([step], "weavers");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.clip_start).toBe("");
    expect(dataRow.clip_end).toBe("");
    expect(dataRow.loop).toBe("");
  });

  // --- defensive empty-object write for kind='section' ---
  // Framework signal in stories.csv: empty `object` column = section card.
  // Even if internal kind/object_id state has drifted (kind='section' with
  // a stale object_id), the writer must emit empty `object` so the framework
  // still renders the row as a section card.
  describe("kind='section' defensive empty-object write", () => {
    it("kind='section' with stale object_id => CSV `object` column is empty", () => {
      const step = {
        ...baseStep,
        kind: "section" as "media" | "section",
        object_id: "obj-A", // stale — should NOT be written to CSV
        question: "Chapter One",
      };
      const csv = serializeStoryCsv([step], "weavers");
      const parsed = Papa.parse<Record<string, string>>(csv, {
        header: true,
        skipEmptyLines: true,
      });
      const dataRow = parsed.data[1]; // skip bilingual row
      expect(dataRow.object).toBe("");
      expect(dataRow.question).toBe("Chapter One");
    });

    it("kind='media' with object_id => CSV `object` column is the object_id verbatim", () => {
      const step = {
        ...baseStep,
        kind: "media" as "media" | "section",
        object_id: "obj-A",
      };
      const csv = serializeStoryCsv([step], "weavers");
      const parsed = Papa.parse<Record<string, string>>(csv, {
        header: true,
        skipEmptyLines: true,
      });
      const dataRow = parsed.data[1];
      expect(dataRow.object).toBe("obj-A");
    });

    it("kind='section' with empty object_id => CSV `object` column is empty (idempotent on common path)", () => {
      const step = {
        ...baseStep,
        kind: "section" as "media" | "section",
        object_id: null,
        question: "Chapter Two",
      };
      const csv = serializeStoryCsv([step], "weavers");
      const parsed = Papa.parse<Record<string, string>>(csv, {
        header: true,
        skipEmptyLines: true,
      });
      const dataRow = parsed.data[1];
      expect(dataRow.object).toBe("");
      expect(dataRow.question).toBe("Chapter Two");
    });

    it("regression: existing media-step CSV output unchanged for default baseStep", () => {
      const csv = serializeStoryCsv([baseStep], "weavers");
      const parsed = Papa.parse<Record<string, string>>(csv, {
        header: true,
        skipEmptyLines: true,
      });
      const dataRow = parsed.data[1];
      expect(dataRow.object).toBe("my-object");
      expect(dataRow.question).toBe("What do you see?");
      expect(dataRow.answer).toBe("A weaving.");
    });
  });

  // --- section steps: no phantom coords and never dropped ---
  // A section step is a heading card with no IIIF
  // viewer, so it has no meaningful x/y/zoom. The writer must emit EMPTY
  // coordinate cells (not the 0.5/0.5/1 defaults) so they don't round-trip
  // wrong or churn the entity hash, and isFullyEmptyStep must never drop a
  // section step regardless of its other content.
  describe("kind='section' coords + retention", () => {
    const sectionBase = {
      step_number: 1,
      kind: "section" as "media" | "section",
      object_id: null as string | null,
      x: 0.5,
      y: 0.5,
      zoom: 1,
      page: null,
      question: "Chapter One",
      answer: null as string | null,
      alt_text: null as string | null,
      clip_start: null as string | null,
      clip_end: null as string | null,
      loop: null as string | null,
      layers: [] as {
        layer_number: number;
        title: string | null;
        button_label: string | null;
        content: string | null;
      }[],
    };

    // A section step with x/y/zoom stored in D1 must serialise to EMPTY
    // coordinate cells, because a section card has no viewer to position.
    it("section step with stored coords => empty x/y/zoom cells", () => {
      const step = { ...sectionBase, x: 0.7, y: 0.2, zoom: 3 };
      const csv = serializeStoryCsv([step], "weavers");
      const parsed = Papa.parse<Record<string, string>>(csv, {
        header: true,
        skipEmptyLines: true,
      });
      const dataRow = parsed.data[1]; // skip bilingual row
      expect(dataRow.x).toBe("");
      expect(dataRow.y).toBe("");
      expect(dataRow.zoom).toBe("");
    });

    // A section step carrying only a question (no object/answer/layers)
    // must survive serialisation — isFullyEmptyStep must return false for it.
    it("section step with only a question is not dropped", () => {
      const csv = serializeStoryCsv([sectionBase], "weavers");
      const dataLines = csv.split("\n").filter((l) => /^[0-9]/.test(l));
      expect(dataLines).toHaveLength(1);
    });

    // Even a section step with NO other content (no question, object,
    // answer or layers) survives — a titled-but-empty heading is not lost.
    it("section step with no other content is not dropped", () => {
      const step = { ...sectionBase, question: null };
      const csv = serializeStoryCsv([step], "weavers");
      const dataLines = csv.split("\n").filter((l) => /^[0-9]/.test(l));
      expect(dataLines).toHaveLength(1);
    });

    // Regression: a truly-empty MEDIA step (not a section, no content) is still
    // dropped — the retention change must be scoped to section steps only.
    it("truly-empty media step is still dropped", () => {
      const emptyMedia = { ...sectionBase, kind: "media" as "media" | "section", question: null };
      const csv = serializeStoryCsv([emptyMedia], "weavers");
      const dataLines = csv.split("\n").filter((l) => /^[0-9]/.test(l));
      expect(dataLines).toHaveLength(0);
    });

    // Round-trip: serialise a section step with coords -> parse + map back ->
    // re-imported step has no phantom 0.5/0.5/1 coordinates.
    it("round-trips a section step with no phantom coords", () => {
      const step = { ...sectionBase, x: 0.9, y: 0.1, zoom: 5 };
      const csv = serializeStoryCsv([step], "weavers");
      const rows = parseTelarCsv(csv);
      const { steps: mapped } = mapStoryCsv(rows, 1);
      expect(mapped).toHaveLength(1);
      const reimported = mapped[0];
      expect(reimported.kind).toBe("section");
      // mapStoryCsv leaves x/y/zoom undefined when the cell is empty — no
      // phantom 0.5/0.5/1 reintroduced.
      expect(reimported.x).toBeUndefined();
      expect(reimported.y).toBeUndefined();
      expect(reimported.zoom).toBeUndefined();
    });

    // No-churn at the serialisation seam: two serialisations of an unchanged
    // section step produce byte-identical CSV (the buildEntityHashes step seam
    // is DB-bound, so this stands in for it at the serialiser level).
    it("two serialisations of an unchanged section step are identical (no churn)", () => {
      const step = { ...sectionBase, x: 0.4, y: 0.6, zoom: 2 };
      const csvA = serializeStoryCsv([step], "weavers");
      const csvB = serializeStoryCsv([step], "weavers");
      expect(csvA).toBe(csvB);
    });
  });

  // --- step order survives scrambled input ---
  // Root cause: serializeStoryCsv used to write rows in the order stepRows
  // arrived (and the D1 query has no ORDER BY). Editor reorders therefore did
  // not survive publish. Section heading cards inherit the same `steps` table
  // and thus the same bug. Fix: spread-then-sort by step_number inside the
  // serialiser, mirroring serializeProjectCsv.
  describe("serializeStoryCsv — step order survives scrambled input", () => {
    // The bilingual row is parsed.data[0] when Papa.parse is called with
    // { header: true } (header line 1 is consumed as the header, Spanish
    // column-name row at line 2 becomes the first data row). Real step rows
    // therefore start at parsed.data[1]. The bilingual row's `step` cell is
    // the literal "paso" — filter on that to drop it without relying on
    // raw row indices.
    const dataRowsFrom = (csv: string) => {
      const parsed = Papa.parse<Record<string, string>>(csv, {
        header: true,
        skipEmptyLines: true,
      });
      return parsed.data.filter((row) => row.step !== "paso");
    };

    it("scrambled regular steps sort ascending by step_number", () => {
      const scrambled = [
        { ...baseStep, step_number: 3, question: "third" },
        { ...baseStep, step_number: 1, question: "first" },
        { ...baseStep, step_number: 2, question: "second" },
      ];
      const csv = serializeStoryCsv(scrambled, "weavers");
      const dataRows = dataRowsFrom(csv);
      expect(dataRows).toHaveLength(3);
      expect(dataRows.map((r) => r.step)).toEqual(["1", "2", "3"]);
      expect(dataRows.map((r) => r.question)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    it("mixed media + section steps sort together by step_number", () => {
      const scrambled = [
        { ...baseStep, step_number: 3, question: "third media" },
        {
          ...baseStep,
          step_number: 2,
          kind: "section" as "media" | "section",
          object_id: null,
          question: "Chapter Two",
        },
        { ...baseStep, step_number: 1, question: "first media" },
      ];
      const csv = serializeStoryCsv(scrambled, "weavers");
      const dataRows = dataRowsFrom(csv);
      expect(dataRows).toHaveLength(3);
      expect(dataRows.map((r) => r.step)).toEqual(["1", "2", "3"]);
      // Section heading lands second, with the framework's empty-object signal
      // (the defensive write) preserved through the sort.
      expect(dataRows[1].step).toBe("2");
      expect(dataRows[1].object).toBe("");
      expect(dataRows[1].question).toBe("Chapter Two");
      // Media steps either side keep their object_id intact.
      expect(dataRows[0].object).toBe("my-object");
      expect(dataRows[2].object).toBe("my-object");
    });

    it("caller's stepRows array is not mutated", () => {
      const input = [
        { ...baseStep, step_number: 3, question: "third" },
        { ...baseStep, step_number: 1, question: "first" },
        { ...baseStep, step_number: 2, question: "second" },
      ];
      const orderBefore = input.map((s) => s.step_number);
      serializeStoryCsv(input, "weavers");
      const orderAfter = input.map((s) => s.step_number);
      expect(orderAfter).toEqual(orderBefore);
      expect(orderAfter).toEqual([3, 1, 2]);
    });
  });

  // --- single source of truth for layer filenames (publish-correctness bug) ---
  // The CSV records, per step, which markdown file holds each layer's content.
  // The publish loop must write those exact files. Before the single-source
  // refactor the CSV and the file-writing loop recomputed filenames in
  // DIFFERENT orders (CSV: sorted by step_number + empty-filtered; file loop:
  // raw query/array order, unfiltered) with SEPARATE usedFilenames Sets.
  //
  // layerFilename is order-dependent: a title-based name is preferred but falls
  // back to a positional name once that title-based name is already taken. So
  // when two layers SHARE a title and the two loops iterate in different order
  // (which happens after a step reorder — step_number order != array/id order),
  // the collision resolves to different steps: the CSV points step A at file Y
  // while file Y receives step B's content. serializeStory closes this by
  // computing each filename exactly once and returning the layer files in the
  // same pass.
  describe("serializeStory — CSV references and written files cannot diverge", () => {
    // Helper: map serializeStory's layerFiles to the on-disk path/content the
    // publish loop now produces, so the test asserts against what is actually
    // written.
    const writtenFilesFrom = (layerFiles: ReturnType<typeof serializeStory>["layerFiles"]) =>
      Promise.all(
        layerFiles.map(async (lf) => ({
          filename: lf.filename,
          // mirrors the publish loop: layerFileContent(title, content)
          content: await layerFileContent(lf.title, lf.content),
          rawContent: lf.content,
        })),
      );

    it("two layers sharing a title on reordered steps: every CSV reference has a matching written file with the correct step's content", async () => {
      // Simulate a post-reorder state: array order (the raw D1 query order,
      // which has no ORDER BY) does NOT match step_number order.
      //   - array[0]: step_number 2, layer1 content "BODY-FOR-STEP-2"
      //   - array[1]: step_number 1, layer1 content "BODY-FOR-STEP-1"
      // Both layers share the free-text title "Notes".
      const steps = [
        {
          ...baseStep,
          step_number: 2,
          question: "second",
          layers: [
            {
              layer_number: 1,
              title: "Notes",
              button_label: "More",
              content: "BODY-FOR-STEP-2",
            },
          ],
        },
        {
          ...baseStep,
          step_number: 1,
          question: "first",
          layers: [
            {
              layer_number: 1,
              title: "Notes",
              button_label: "More",
              content: "BODY-FOR-STEP-1",
            },
          ],
        },
      ];

      const { csv, layerFiles } = serializeStory(steps, "weavers");
      const written = await writtenFilesFrom(layerFiles);

      // Parse the CSV's layer1_content references keyed by step_number.
      const parsed = Papa.parse<Record<string, string>>(csv, {
        header: true,
        skipEmptyLines: true,
      });
      const dataRows = parsed.data.filter((r) => r.step !== "paso");

      const writtenByFilename = new Map(written.map((w) => [w.filename, w]));

      // For EVERY step, the file the CSV references must have actually been
      // written, and must contain THAT step's content.
      const expectedContentByStep: Record<string, string> = {
        "1": "BODY-FOR-STEP-1",
        "2": "BODY-FOR-STEP-2",
      };
      for (const row of dataRows) {
        const referenced = row.layer1_content;
        expect(referenced).not.toBe("");
        const file = writtenByFilename.get(referenced);
        // The referenced file must exist among the written files.
        expect(file, `CSV step ${row.step} references ${referenced} but no such file was written`).toBeDefined();
        // And it must carry the correct step's body.
        expect(file!.rawContent).toBe(expectedContentByStep[row.step]);
      }

      // No orphan file: every written file is referenced by exactly one CSV cell.
      const allReferenced = new Set(dataRows.map((r) => r.layer1_content));
      for (const w of written) {
        expect(allReferenced.has(w.filename)).toBe(true);
      }
      // The two colliding titles must resolve to two DISTINCT filenames.
      expect(new Set(written.map((w) => w.filename)).size).toBe(written.length);
    });

    it("empty steps are excluded from layerFiles (no referenced layer dropped, no orphan written)", () => {
      const steps = [
        {
          ...baseStep,
          step_number: 1,
          layers: [
            {
              layer_number: 1,
              title: "Intro",
              button_label: null,
              content: "REAL",
            },
          ],
        },
        {
          // fully empty step — must not produce a layer file
          step_number: 2,
          kind: "media" as "media" | "section",
          object_id: null,
          x: null,
          y: null,
          zoom: null,
          page: null,
          question: null,
          answer: null,
          alt_text: null as string | null,
          clip_start: null as string | null,
          clip_end: null as string | null,
          loop: null as string | null,
          layers: [],
        },
      ];

      const { csv, layerFiles } = serializeStory(steps, "weavers");
      expect(layerFiles).toHaveLength(1);
      expect(layerFiles[0].filename).toBe("weavers-intro.md");
      expect(csv).toContain("weavers-intro.md");
    });

    it("serializeStory.csv is byte-identical to serializeStoryCsv for the same input", () => {
      const steps = [
        {
          ...baseStep,
          step_number: 2,
          layers: [
            { layer_number: 1, title: "Notes", button_label: "More", content: "B2" },
          ],
        },
        {
          ...baseStep,
          step_number: 1,
          layers: [
            { layer_number: 1, title: "Notes", button_label: "More", content: "B1" },
          ],
        },
      ];
      expect(serializeStory(steps, "weavers").csv).toBe(serializeStoryCsv(steps, "weavers"));
    });
  });
});

// ---------------------------------------------------------------------------
// layerFilename
// ---------------------------------------------------------------------------

describe("layerFilename", () => {
  it("uses slugified title when provided", () => {
    const name = layerFilename("weavers", 1, 1, "Historical Context");
    expect(name).toBe("weavers-historical-context.md");
  });

  it("falls back to step/layer numbering when no title", () => {
    const name = layerFilename("weavers", 1, 1);
    expect(name).toBe("weavers-step1-layer1.md");
  });

  it("falls back to step/layer numbering when title is empty string", () => {
    const name = layerFilename("weavers", 2, 1, "");
    expect(name).toBe("weavers-step2-layer1.md");
  });

  it("falls back when duplicate title detected in usedFilenames", () => {
    const used = new Set<string>(["weavers-context.md"]);
    const name = layerFilename("weavers", 3, 2, "Context", used);
    // Collision detected — falls back to step/layer
    expect(name).toBe("weavers-step3-layer2.md");
  });

  it("adds result to usedFilenames set", () => {
    const used = new Set<string>();
    layerFilename("weavers", 1, 1, "Historical Context", used);
    expect(used.has("weavers-historical-context.md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// layerFileContent
// ---------------------------------------------------------------------------
//
// An untitled layer's file must always carry a frontmatter block
// (even an empty-title one), because the framework's frontmatter match only
// anchors correctly against a non-empty block — an unwrapped body opening
// with its own `---` is otherwise read as the file's own delimiters.
//
// The cases that prove that drive the framework's real `_split_frontmatter`
// (scripts/telar/markdown.py) against what layerFileContent writes, rather
// than reimplementing its semantics as a JS fixture, so they need the
// framework checked out and live in their own describeWithFramework block
// below. The cases above it assert emitted bytes and need nothing.

describe("layerFileContent", () => {
  it("produces frontmatter + body when title provided", async () => {
    const content = await layerFileContent("Context", "# Hello");
    expect(content).toBe('---\ntitle: "Context"\n---\n\n# Hello');
  });

  it("always writes a frontmatter block when there is no title", async () => {
    const content = await layerFileContent(null, "Just content");
    expect(content).toBe('---\ntitle: ""\n---\n\nJust content');
  });

  it("writes an empty-title block when title is an empty string", async () => {
    const content = await layerFileContent("", "Body text");
    expect(content).toBe('---\ntitle: ""\n---\n\nBody text');
  });
});

describeWithFramework("layerFileContent, read back by the framework", () => {
  it("preserves an untitled body that opens with a rule", async () => {
    const original = "---\nfoo\n---\nbar";
    const file = await layerFileContent(null, original);
    const { title, body } = splitFrontmatterViaFramework(file);
    expect(title).toBe("");
    // The second rule directly follows "foo" with no blank line, so
    // guardAmbiguousRuleLines inserts one — the body is not byte-identical
    // to `original`, but nothing the author wrote is lost.
    expect(body).toBe(guardAmbiguousRuleLines(original));
    expect(body).toBe("---\nfoo\n\n---\nbar");
  });

  it("preserves a titled body that opens with a rule", async () => {
    const original = "---\nfoo\n---\nbar";
    const file = await layerFileContent("Context", original);
    const { title, body } = splitFrontmatterViaFramework(file);
    expect(title).toBe("Context");
    expect(body).toBe(guardAmbiguousRuleLines(original));
  });

  it("preserves a rule appearing only in the middle of the body", async () => {
    const original = "Some intro text.\n\n---\n\nMore text after the rule.";
    const file = await layerFileContent(null, original);
    const { title, body } = splitFrontmatterViaFramework(file);
    expect(title).toBe("");
    expect(body).toBe(original);
  });

  it("preserves a body with no rules at all", async () => {
    const original = "Just plain body text, nothing special.";
    const file = await layerFileContent(null, original);
    const { title, body } = splitFrontmatterViaFramework(file);
    expect(title).toBe("");
    expect(body).toBe(original);
  });

  it("preserves an empty body", async () => {
    const file = await layerFileContent(null, "");
    const { title, body } = splitFrontmatterViaFramework(file);
    expect(title).toBe("");
    expect(body).toBe("");
  });

  it("parses identically to unwrapped content for untitled bodies that don't open with a rule", async () => {
    const original = "Some prose.\n\nA second paragraph.";
    // The safety argument for always wrapping: for content the old
    // no-frontmatter output already parsed correctly, wrapping it in an
    // empty-title block must resolve to the same (title, body).
    const unwrapped = splitFrontmatterViaFramework(original);
    const wrapped = splitFrontmatterViaFramework(await layerFileContent(null, original));
    expect(wrapped).toEqual(unwrapped);
  });
});

// ---------------------------------------------------------------------------
// guardAmbiguousRuleLines
// ---------------------------------------------------------------------------
//
// A `---` line directly following non-blank text is, to
// markdown, a setext-heading underline, not a horizontal rule — the
// preceding line becomes a heading and the rule itself is never rendered.
// The editor's live preview never forms that heading (it decorates ATX
// headings and horizontal rules only), so an author who pastes a frontmatter
// block sees a rule and plain text while the published page silently turns
// it into `<hr>` + `<h2>`. guardAmbiguousRuleLines inserts a blank line to
// keep every `---` the author typed rendering as a rule.
//
// This is deliberately NOT a reserved-marker scheme: a marker is a string
// the compositor claims for itself but that any author's own content can
// also contain, and stripping every line that matches it on import means an
// author's own line is silently deleted if it happens to collide. A blank
// line has no such claim to make — there is nothing added that later has
// to be recognised and removed, so there is nothing to forge.

describe("guardAmbiguousRuleLines", () => {
  it("inserts a blank line before a rule that directly follows non-blank text", () => {
    const out = guardAmbiguousRuleLines("title: X\n---\nSome text");
    expect(out).toBe("title: X\n\n---\nSome text");
  });

  it("does not guard a rule already separated by a blank line", () => {
    const original = "Some intro text.\n\n---\n\nMore text after the rule.";
    expect(guardAmbiguousRuleLines(original)).toBe(original);
  });

  it("does not guard a rule at the very start of the content", () => {
    const original = "---\nfoo\n---\nbar";
    // Only the SECOND rule (directly after "foo") is ambiguous.
    expect(guardAmbiguousRuleLines(original)).toBe("---\nfoo\n\n---\nbar");
  });

  it("converges: re-running the guard against its own output adds nothing further", () => {
    const original = "Real text.\n---\nMore text.";
    const oncePublished = guardAmbiguousRuleLines(original);
    expect(oncePublished).toBe("Real text.\n\n---\nMore text.");
    // The blank line just inserted already satisfies the check (the rule's
    // original previous line is now blank), so a second pass is a no-op.
    const republished = guardAmbiguousRuleLines(oncePublished);
    expect(republished).toBe(oncePublished);
  });

  it("leaves an author's own literal rule-guard-shaped line as ordinary text", () => {
    // There is no reserved marker any more, so nothing recognises or
    // special-cases this line — it is content like any other.
    const authored = "Real text.\n<!--telar:rule-guard-->\nMore text.";
    expect(guardAmbiguousRuleLines(authored)).toBe(authored);
  });
});

describeWithPythonMarkdown("the guarded shape as a markdown renderer sees it", () => {
  it("renders as rule, plain text, rule — never a setext heading", () => {
    const guarded = guardAmbiguousRuleLines("---\ntitle: X\n---\nSome text");
    const script = [
      "import markdown",
      `print(markdown.markdown(${JSON.stringify(guarded)}, extensions=['extra', 'nl2br']))`,
    ].join("\n");
    const html = execFileSync("python3", ["-c", script], { encoding: "utf-8" });
    expect(html).toContain("<hr");
    expect(html).toContain("<p>title: X</p>");
    expect(html).not.toContain("<h2>");
  });
});

// ---------------------------------------------------------------------------
// updateConfigFields
// ---------------------------------------------------------------------------

describe("updateConfigFields", () => {
  const yaml = `# Site title
title: "Old Title"
baseurl: "/mysite"
url: "https://example.com"
# End of basic settings
protected:
  key: oldkey
custom_field: keep-this
`;

  it("replaces existing field value", () => {
    const result = updateConfigFields(yaml, { title: '"New Title"' });
    expect(result).toContain('title: "New Title"');
    expect(result).not.toContain('title: "Old Title"');
  });

  it("preserves comments on other lines", () => {
    const result = updateConfigFields(yaml, { title: '"Updated"' });
    expect(result).toContain("# Site title");
    expect(result).toContain("# End of basic settings");
  });

  it("does not touch unmanaged fields", () => {
    const result = updateConfigFields(yaml, { title: '"Updated"' });
    expect(result).toContain("custom_field: keep-this");
  });

  it("appends field that doesn't exist in the YAML", () => {
    const result = updateConfigFields(yaml, { new_field: "new_value" });
    expect(result).toContain("new_field: new_value");
  });

  // The top-level line takes the write wherever it sits relative to a
  // `protected:` block, and the block's own key is left as its owner wrote it.
  it("writes the top-level line and leaves a later protected: block alone", () => {
    const topFirst = [
      "story_key: OLDTOP",
      "protected:",
      "  key: OLDPROT",
      "url: https://example.com",
    ].join("\n");
    const result = updateConfigFields(topFirst, { story_key: '"newkey"' });
    expect(result).toContain('story_key: "newkey"');
    expect(result).toContain("  key: OLDPROT");
  });

  it("writes the top-level line and leaves an earlier protected: block alone", () => {
    const protectedFirst = [
      "protected:",
      "  key: OLDPROT",
      "story_key: OLDTOP",
      "url: https://example.com",
    ].join("\n");
    const result = updateConfigFields(protectedFirst, { story_key: '"newkey"' });
    expect(result).toContain('story_key: "newkey"');
    expect(result).not.toContain("OLDTOP");
    expect(result).toContain("  key: OLDPROT");
  });

  // No framework version reads a nested key: story_key has been a top-level
  // scalar since v0.8.0-beta, so a `protected:` block in a repo is somebody
  // else's data and the publish must leave it exactly as it found it.
  it("writes story_key at the top level and leaves a protected: block alone", () => {
    const input = [
      "protected:",
      "  key: OLDPROT",
      "url: https://example.com",
    ].join("\n");
    const result = updateConfigFields(input, { story_key: '"newkey"' });
    expect(result).toContain('story_key: "newkey"');
    expect(result).toContain("  key: OLDPROT");
    expect(result.match(/^\s+key:/gm)?.length).toBe(1);
  });

  it("appends story_key at the top level rather than into the protected block", () => {
    const result = updateConfigFields(yaml, { story_key: "newkey" });
    expect(result).toContain("story_key: newkey");
    expect(result).toContain("  key: oldkey");
    expect(result.match(/^story_key:/gm)?.length).toBe(1);
  });

  // Regression: every publish was appending a duplicate top-level story_key:
  // line because the main field-matcher skipped story_key entirely, leaving
  // the append path to fire on every run. Discovered on juancobo/telar-test
  // (10 duplicates accumulated). The fix updates the first top-level
  // story_key: in place AND drops any subsequent duplicates as cleanup.
  it("updates an existing top-level story_key when no protected block exists", () => {
    const input = `title: "My Site"
story_key: "old"
custom_field: keep
`;
    const result = updateConfigFields(input, { story_key: "new" });
    expect(result).toContain("story_key: new");
    expect(result).not.toContain('story_key: "old"');
    // Must not append a second story_key: line
    expect(result.match(/^story_key:/gm)?.length).toBe(1);
  });

  it("is idempotent on top-level story_key — re-running yields no growth", () => {
    const input = `title: "My Site"
story_key: test
`;
    const once = updateConfigFields(input, { story_key: "test" });
    const twice = updateConfigFields(once, { story_key: "test" });
    expect(once).toBe(twice);
    expect(twice.match(/^story_key:/gm)?.length).toBe(1);
  });

  it("collapses duplicate top-level story_key lines into one (self-heal)", () => {
    const input = `title: "My Site"
story_key: "test"
custom_field: keep
story_key: test
story_key: test
story_key: test
`;
    const result = updateConfigFields(input, { story_key: "test" });
    expect(result.match(/^story_key:/gm)?.length).toBe(1);
    expect(result).toContain("custom_field: keep");
  });

  it("prefers first occurrence when both protected key: and top-level story_key: exist", () => {
    const input = `title: "My Site"
story_key: oldtop
protected:
  key: oldprotected
custom_field: keep
`;
    const result = updateConfigFields(input, { story_key: "new" });
    // First match wins — top-level appears first here
    expect(result).toContain("story_key: new");
    expect(result).not.toContain("story_key: oldtop");
    // Only one story_key: line total
    expect(result.match(/^story_key:/gm)?.length).toBe(1);
  });

  it("preserves indentation and quotes", () => {
    const result = updateConfigFields(yaml, { baseurl: '"/newsite"' });
    expect(result).toContain('baseurl: "/newsite"');
  });

  // Silent v-prefix heal on telar.version
  it("strips leading v from telar.version line (heal)", () => {
    const input = `title: "My Site"
telar:
  version: v1.2.0
  key: abc
`;
    const result = updateConfigFields(input, {});
    expect(result).toContain("version: 1.2.0");
    expect(result).not.toContain("version: v1.2.0");
  });

  it("is idempotent when telar.version has no v prefix", () => {
    const input = `title: "My Site"
telar:
  version: 1.2.0
  key: abc
`;
    const result = updateConfigFields(input, {});
    expect(result).toContain("version: 1.2.0");
    // Guard against an over-eager replace producing e.g. ".2.0"
    expect(result).not.toContain("version: .2.0");
    expect(result).not.toContain("version: ersion");
  });

  it("does not touch a top-level version: line outside the telar: block", () => {
    const input = `title: "My Site"
version: v9.9.9
telar:
  key: abc
`;
    const result = updateConfigFields(input, {});
    expect(result).toContain("version: v9.9.9");
  });

  // Regression (production incident 2026-05-28): editing the site description
  // wrote bare newlines into _config.yml, producing a multi-line double-quoted
  // scalar. A re-edit then replaced only the first physical line and orphaned
  // the old continuation lines outside the closing quote, so every Jekyll build
  // died with `yaml.scanner.ScannerError: could not find expected ':'`.
  // updateConfigFields must self-heal: replacing a field whose existing value
  // opens an unterminated quote sweeps the orphaned continuation lines.
  it("heals an orphaned multi-line description scalar (real-world corruption)", () => {
    const corrupt = [
      'title: "Site"',
      'description: "First paragraph here.',
      "",
      'Second paragraph ends. "',
      "",
      'Second paragraph ends. "',
      "",
      'Second paragraph ends. "',
      'url: "https://example.com"',
      'baseurl: "/test"',
    ].join("\n");
    // The corrupt input is itself invalid YAML (the bug).
    expect(() => loadYaml(corrupt)).toThrow();

    const result = updateConfigFields(corrupt, { description: '"Fresh description."' });

    const parsed = loadYaml(result) as Record<string, unknown>;
    expect(parsed.description).toBe("Fresh description.");
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.baseurl).toBe("/test");
    // No orphaned prose lines survived.
    expect(result).not.toContain("Second paragraph ends.");
  });

  it("does not consume following lines when the replaced value is a balanced single-line scalar", () => {
    const input = `title: "Old"
description: "single line"
url: "https://example.com"
`;
    const result = updateConfigFields(input, { description: '"new single line"' });
    const parsed = loadYaml(result) as Record<string, unknown>;
    expect(parsed.description).toBe("new single line");
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.title).toBe("Old");
  });

  // A multi-paragraph description with capitalised sentences is the common
  // real-world corruption. The hardened sweep must not mistake "This site…"
  // for a key, even when a sentence contains an inner colon.
  it("sweeps capitalised multi-paragraph prose continuation", () => {
    const corrupt = [
      'title: "Site"',
      'description: "Intro paragraph.',
      "",
      "This site explores something. Note that HSSB: built in 1996. ",
      "",
      "This site explores something. Note that HSSB: built in 1996. ",
      'url: "https://example.com"',
    ].join("\n");
    const result = updateConfigFields(corrupt, { description: '"Clean."' });
    const parsed = loadYaml(result) as Record<string, unknown>;
    expect(parsed.description).toBe("Clean.");
    expect(parsed.url).toBe("https://example.com");
    expect(result).not.toContain("This site explores");
  });
});

// ---------------------------------------------------------------------------
// healConfigYaml — guarantees a valid _config.yml for the publish commit
// ---------------------------------------------------------------------------

describe("healConfigYaml", () => {
  it("returns the surgically-updated config when it is already valid (preserves comments + unmanaged keys)", () => {
    const input = `# Site Settings
title: "Old"
description: "A description"
url: "https://example.com"
telar_theme: "trama"
story_interface:
  show_on_homepage: true
  show_story_steps: false
`;
    const out = healConfigYaml(input, { title: '"New"', description: '"Desc"' });
    const parsed = loadYaml(out) as Record<string, unknown>;
    expect(parsed.title).toBe("New");
    expect(parsed.description).toBe("Desc");
    expect(parsed.telar_theme).toBe("trama");
    expect((parsed.story_interface as Record<string, unknown>).show_story_steps).toBe(false);
    expect(out).toContain("# Site Settings");
  });

  it("heals the newline + duplicate-paragraph corruption (kftruitt shape)", () => {
    const corrupt = [
      'title: "Site"',
      'description: "Para one.',
      "",
      'Para two ends. "',
      "",
      'Para two ends. "',
      'url: "https://u.example"',
      'telar_theme: "trama"',
    ].join("\n");
    expect(() => loadYaml(corrupt)).toThrow();
    const out = healConfigYaml(corrupt, { description: '"Fresh."' });
    const parsed = loadYaml(out) as Record<string, unknown>;
    expect(parsed.description).toBe("Fresh.");
    expect(parsed.url).toBe("https://u.example");
    expect(parsed.telar_theme).toBe("trama");
  });

  it("heals the embedded-quote corruption (hafw1t shape)", () => {
    const corrupt =
      'title: "Site"\n' +
      'description: "A Chimu "Double Chamber Whistle Vessel", an artifact. "\n' +
      'url: "https://u.example"\n';
    expect(() => loadYaml(corrupt)).toThrow();
    const fields = buildConfigManagedFields(
      makeConfig({ description: 'A Chimu "Double Chamber Whistle Vessel", an artifact.' }),
    );
    const out = healConfigYaml(corrupt, fields);
    const parsed = loadYaml(out) as Record<string, unknown>;
    expect(parsed.description).toBe('A Chimu "Double Chamber Whistle Vessel", an artifact.');
    expect(parsed.url).toBe("https://u.example");
  });

  // A description paragraph that itself starts with a lowercase `word:`
  // (e.g. "usage:") must not be mistaken for a config key and stop the sweep.
  // The known-key allowlist sweeps it as prose, so the heal stays on the
  // settings-preserving surgical path. Also asserts the duplicate-paragraph
  // corruption is cleared and unmanaged framework settings survive untouched.
  it("heals a description whose prose starts with a lowercase word+colon, preserving settings", () => {
    const corrupt = [
      'title: "Site"',
      'description: "Intro paragraph.',
      "",
      'usage: it whistles loudly. "',
      "",
      'This sentence has no key and breaks the YAML. "',
      'url: "https://u.example"',
      'telar_theme: "paisajes"',
      "story_interface:",
      "  show_on_homepage: false",
      "  featured_count: 9",
    ].join("\n");
    expect(() => loadYaml(corrupt)).toThrow();
    const out = healConfigYaml(corrupt, { description: '"Fresh."' });
    const parsed = loadYaml(out) as Record<string, unknown>;
    expect(parsed.description).toBe("Fresh.");
    expect(parsed.url).toBe("https://u.example");
    // User's non-default framework settings survive untouched.
    expect(parsed.telar_theme).toBe("paisajes");
    expect((parsed.story_interface as Record<string, unknown>).show_on_homepage).toBe(false);
    expect((parsed.story_interface as Record<string, unknown>).featured_count).toBe(9);
    expect(out).not.toContain("usage: it whistles");
  });

  // story_content is no longer written by this publish, and the sweep still
  // has to stop at it: an unrecognised top-level line is swept as prose, and a
  // key nobody manages any more is exactly the line that must survive
  // verbatim. Deleting a site's own setting is not ours to do.
  it("stops the sweep at a story_content block nobody manages, keeping the line verbatim", () => {
    const corrupt = [
      'title: "Site"',
      'description: "Intro paragraph.',
      "",
      'A second paragraph. "',
      "",
      'This sentence has no key and breaks the YAML. "',
      "story_content:",
      "  answer_word_limit: 60",
      'url: "https://u.example"',
    ].join("\n");
    expect(() => loadYaml(corrupt)).toThrow();

    const out = healConfigYaml(corrupt, { description: '"Fresh."' });

    const parsed = loadYaml(out) as Record<string, unknown>;
    expect((parsed.story_content as Record<string, unknown>).answer_word_limit).toBe(60);
    expect(parsed.url).toBe("https://u.example");
  });
});

// ---------------------------------------------------------------------------
// buildConfigManagedFields
// ---------------------------------------------------------------------------

describe("buildConfigManagedFields", () => {
  it("threads telar_language from config.lang (regression: previously omitted)", () => {
    const fields = buildConfigManagedFields(makeConfig({ lang: "es" }));
    expect(fields.telar_language).toBe("es");
  });

  it("threads telar_language as 'en' when config.lang is 'en'", () => {
    const fields = buildConfigManagedFields(makeConfig({ lang: "en" }));
    expect(fields.telar_language).toBe("en");
  });

  it("omits telar_language entirely when config.lang is null", () => {
    const fields = buildConfigManagedFields(makeConfig({ lang: null }));
    expect(fields).not.toHaveProperty("telar_language");
  });

  it("emits telar_language unquoted (template format)", () => {
    const fields = buildConfigManagedFields(makeConfig({ lang: "es" }));
    expect(fields.telar_language).not.toMatch(/^".*"$/);
  });

  it("wraps string fields in double quotes", () => {
    const fields = buildConfigManagedFields(
      makeConfig({
        title: "My Site",
        url: "https://example.com",
        baseurl: "/site",
        description: "A description",
        author: "Author",
        email: "author@example.com",
        logo: "/assets/logo.png",
      }),
    );
    expect(fields.title).toBe('"My Site"');
    expect(fields.url).toBe('"https://example.com"');
    expect(fields.baseurl).toBe('"/site"');
    expect(fields.description).toBe('"A description"');
    expect(fields.author).toBe('"Author"');
    expect(fields.email).toBe('"author@example.com"');
    expect(fields.logo).toBe('"/assets/logo.png"');
  });

  it("emits collection_mode as unquoted boolean string", () => {
    expect(buildConfigManagedFields(makeConfig({ collection_mode: true })).collection_mode).toBe(
      "true",
    );
    expect(buildConfigManagedFields(makeConfig({ collection_mode: false })).collection_mode).toBe(
      "false",
    );
  });

  it("wraps story_key in double quotes", () => {
    // story_key is user-supplied free text and may contain YAML metacharacters
    // (# opens a comment, : opens a mapping), so it must be quoted like the
    // other managed string fields — otherwise the value round-trips truncated.
    const fields = buildConfigManagedFields(makeConfig({ story_key: "secret-key-value" }));
    expect(fields.story_key).toBe('"secret-key-value"');
  });

  it("escapes YAML metacharacters in story_key so it survives a write round-trip", () => {
    // A key containing `#` and `:` would, if written unquoted, parse back
    // truncated (at the #) or malformed (the : opens a mapping). Quoting makes
    // the exact value survive a js-yaml round-trip.
    const key = "ab#cd: ef";
    const fields = buildConfigManagedFields(makeConfig({ story_key: key }));
    const yaml = updateConfigFields("title: \"Site\"\n", fields);
    const parsed = loadYaml(yaml) as Record<string, unknown>;
    expect(parsed.story_key).toBe(key);
  });

  it("preserves a #-containing story_key alongside an untouched protected block", () => {
    // Quoting must keep the value intact, and a repo's own `protected:` block
    // must come back exactly as it went in.
    const key = "p@ss#word";
    const fields = buildConfigManagedFields(makeConfig({ story_key: key }));
    const input = ["title: \"Site\"", "protected:", "  key: old"].join("\n");
    const out = updateConfigFields(input, fields);
    const parsed = loadYaml(out) as Record<string, unknown>;
    expect(parsed.story_key).toBe(key);
    expect((parsed.protected as Record<string, unknown>).key).toBe("old");
  });

  it("omits null string fields", () => {
    const fields = buildConfigManagedFields(makeConfig({ title: null, lang: null, url: null }));
    expect(fields).not.toHaveProperty("title");
    expect(fields).not.toHaveProperty("url");
    expect(fields).not.toHaveProperty("telar_language");
  });

  it("round-trips through updateConfigFields to flip telar_language in an existing _config.yml", () => {
    const yaml = `# Site config
title: "Site"
telar_language: "en"
baseurl: "/site"
`;
    const fields = buildConfigManagedFields(makeConfig({ title: "Site", lang: "es" }));
    const result = updateConfigFields(yaml, fields);
    expect(result).toContain("telar_language: es");
    expect(result).not.toContain('telar_language: "en"');
  });

  it("appends telar_language when missing from existing _config.yml", () => {
    const ymlSrc = `# Site config
title: "Site"
baseurl: "/site"
`;
    const fields = buildConfigManagedFields(makeConfig({ lang: "es" }));
    const result = updateConfigFields(ymlSrc, fields);
    expect(result).toContain("telar_language: es");
  });

  // Regression (production incident 2026-05-28): naive `"${value}"` wrapping
  // emitted bare newlines and unescaped quotes, corrupting _config.yml. String
  // fields must route through yamlQuote so the emitted value is always a valid
  // single physical line.
  it("escapes a multi-line description into a single-line YAML scalar", () => {
    const desc = "Paragraph one.\n\nParagraph two ends here.";
    const fields = buildConfigManagedFields(makeConfig({ description: desc }));
    expect(fields.description).not.toMatch(/\n/);
    expect(fields.description).toBe('"Paragraph one.\\n\\nParagraph two ends here."');
  });

  it("escapes embedded double quotes and backslashes in string fields", () => {
    const fields = buildConfigManagedFields(makeConfig({ title: 'A "quoted" \\ title' }));
    expect(fields.title).not.toMatch(/\n/);
    expect(fields.title).toBe('"A \\"quoted\\" \\\\ title"');
  });

  it("round-trips a multi-line description through updateConfigFields back to the original value", () => {
    const desc = "Line one.\n\nLine two.";
    const fields = buildConfigManagedFields(makeConfig({ title: "T", description: desc }));
    const base = `title: "old"\ndescription: "old"\nurl: "u"\n`;
    const out = updateConfigFields(base, fields);
    const parsed = loadYaml(out) as Record<string, unknown>;
    expect(parsed.description).toBe(desc);
  });

  // Both triggers in a single value: embedded quotes AND line breaks (the
  // kftruitt + hafw1t failure modes combined). One escaping primitive handles
  // both — the value must survive verbatim through a full emit + parse cycle.
  it("escapes a value containing BOTH embedded quotes and line breaks", () => {
    const desc =
      'The "Double Chamber" vessel.\n\nIt is described as a "whistle vessel" by scholars.';
    const fields = buildConfigManagedFields(makeConfig({ description: desc }));
    // Emitted as a single physical line (no raw newline, inner quotes escaped).
    expect(fields.description).not.toMatch(/\n/);
    // Round-trips back to the exact original through a real YAML parse.
    const base = `title: "t"\ndescription: "old"\nurl: "u"\n`;
    const out = updateConfigFields(base, fields);
    const parsed = loadYaml(out) as Record<string, unknown>;
    expect(parsed.description).toBe(desc);
    expect(parsed.url).toBe("u");
  });

  it("keeps inline links but strips block tags from the description", () => {
    const fields = buildConfigManagedFields(
      makeConfig({ description: "<p>Lead <a href='https://x.org'>link</a></p><script>alert(1)</script>" }),
    );
    // yamlQuote wraps in double quotes; sanitiseInlineHtml has already removed block + script tags.
    expect(fields["description"]).toContain("<a href=");
    expect(fields["description"]).toContain("link");
    expect(fields["description"]).not.toContain("<p>");
    expect(fields["description"]).not.toContain("<script");
    expect(fields["description"]).not.toContain("alert(1)");
  });

  it("leaves a plain description unchanged (still yaml-quoted)", () => {
    const fields = buildConfigManagedFields(makeConfig({ description: "Just text" }));
    expect(fields["description"]).toBe('"Just text"');
  });
});

// ---------------------------------------------------------------------------
// computeChangeSummary
// ---------------------------------------------------------------------------

describe("computeChangeSummary", () => {
  // Helper: empty entity hashes (everything blank) for fixtures that
  // don't care about hash content. Tests that DO care override the
  // relevant fields. Version defaults to current; tests covering
  // version-mismatch back-compat override it explicitly.
  function makeEntityHashes(overrides: Partial<EntityHashes> = {}): EntityHashes {
    return {
      version: ENTITY_HASHES_VERSION,
      pages: {},
      stories: {},
      objects: {},
      glossary: {},
      navigation: "",
      landing: "",
      settings: "",
      objectOrder: "",
      ...overrides,
    };
  }

  // Top-level fixture — two stories, two objects, no pages/glossary, no
  // nav. Tests override `entityHashes` and entity arrays as needed.
  const baseEntityHashes: EntityHashes = makeEntityHashes({
    stories: { weavers: "h-weavers", painters: "h-painters" },
    objects: { "obj-1": "h-obj-1", "obj-2": "h-obj-2" },
    landing: JSON.stringify({ stories_heading: "Stories" }),
    settings: JSON.stringify({ title: `"My Site"` }),
  });

  const currentState: CurrentPublishState = {
    entityHashes: baseEntityHashes,
    config: makeConfig({ title: "My Site" }),
    stories: [
      { story_id: "weavers", title: "The Weavers" },
      { story_id: "painters", title: "The Painters" },
    ],
    objects: [
      { object_id: "obj-1", title: "Object 1" },
      { object_id: "obj-2", title: "Object 2" },
    ],
    pages: [],
    glossary: [],
    allStoryIds: ["weavers", "painters"],
  };

  // Mirror the currentState's config so the per-field settings diff sees
  // a clean match by default (collection_mode is non-nullable, so it
  // always lands in the managed-fields map — drop one of these and the
  // diff fires a spurious "settings changed" entry).
  const baseConfigManaged = buildConfigChangeFields(makeConfig({ title: "My Site" }));

  // Snapshot in entity-hashing mode (entity_hashes populated). Defaults
  // mirror baseEntityHashes so this represents "no changes since last
  // publish" out of the box.
  function makeSnapshot(overrides: Partial<PublishSnapshot> = {}): PublishSnapshot {
    return {
      story_ids: ["weavers", "painters"],
      object_ids: ["obj-1", "obj-2"],
      config_hash: JSON.stringify(baseConfigManaged),
      config_managed: baseConfigManaged,
      landing_hash: JSON.stringify({ stories_heading: "Stories" }),
      entity_hashes: baseEntityHashes,
      ...overrides,
    };
  }

  // Back-compat snapshot — same legacy fields, no entity_hashes. Used by
  // tests that pin the back-compat flood behaviour.
  function makeLegacySnapshot(overrides: Partial<PublishSnapshot> = {}): PublishSnapshot {
    return {
      story_ids: ["weavers", "painters"],
      object_ids: ["obj-1", "obj-2"],
      config_hash: JSON.stringify(baseConfigManaged),
      config_managed: baseConfigManaged,
      landing_hash: JSON.stringify({ stories_heading: "Stories" }),
      ...overrides,
    };
  }

  it("first-time publish with null snapshot: all entities are new, isUpToDate false", () => {
    const summary = computeChangeSummary(currentState, null);
    expect(summary.isUpToDate).toBe(false);
    expect(summary.backCompatBootstrap).toBe(false);
    expect(summary.stories.new).toHaveLength(2);
    expect(summary.stories.modified).toHaveLength(0);
    expect(summary.stories.deleted).toHaveLength(0);
    expect(summary.objects.new).toHaveLength(2);
    expect(summary.glossary.new).toHaveLength(0);
  });

  it("no changes (entity_hashes match): all diff arrays empty, isUpToDate true", () => {
    // Entity-hashing mode: snapshot's entity_hashes match currentState's,
    // every diff bucket is empty, isUpToDate is true. This is the precision
    // win that the pre-rewrite "no changes" test couldn't assert (without
    // per-story hashing the function had to stay conservatively false).
    const summary = computeChangeSummary(currentState, makeSnapshot());
    expect(summary.isUpToDate).toBe(true);
    expect(summary.backCompatBootstrap).toBe(false);
    expect(summary.stories.new).toHaveLength(0);
    expect(summary.stories.modified).toHaveLength(0);
    expect(summary.stories.deleted).toHaveLength(0);
    expect(summary.objects.modified).toHaveLength(0);
    expect(summary.pages.modified).toHaveLength(0);
    expect(summary.glossary.modified).toHaveLength(0);
  });

  it("new story added appears in stories.new", () => {
    // Snapshot has only weavers; current has weavers+painters → painters
    // is new.
    const snapshot = makeSnapshot({
      story_ids: ["weavers"],
      entity_hashes: makeEntityHashes({
        stories: { weavers: "h-weavers" },
        objects: { "obj-1": "h-obj-1", "obj-2": "h-obj-2" },
        landing: baseEntityHashes.landing,
        settings: baseEntityHashes.settings,
      }),
    });
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.stories.new.map((s) => s.story_id)).toEqual(["painters"]);
    expect(summary.stories.modified).toHaveLength(0);
    expect(summary.isUpToDate).toBe(false);
  });

  it("story content edited appears in stories.modified (entity-hashing precision win)", () => {
    // Hash for weavers differs between snapshot and current → modified.
    // Painters' hash matches → not in any bucket. This was impossible to
    // detect pre-rewrite (stories.modified was always empty); the entity-
    // hashing rewrite is what closes that false-negative.
    const snapshot = makeSnapshot({
      entity_hashes: {
        ...baseEntityHashes,
        stories: { weavers: "h-weavers-OLD", painters: "h-painters" },
      },
    });
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.stories.modified.map((s) => s.story_id)).toEqual(["weavers"]);
    expect(summary.stories.new).toHaveLength(0);
    expect(summary.stories.deleted).toHaveLength(0);
    expect(summary.isUpToDate).toBe(false);
  });

  it("story deleted appears in stories.deleted", () => {
    const stateWithout: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        stories: { weavers: "h-weavers" },
      },
      stories: [{ story_id: "weavers", title: "The Weavers" }],
    };
    const summary = computeChangeSummary(stateWithout, makeSnapshot());
    expect(summary.stories.deleted.map((s) => s.story_id)).toEqual(["painters"]);
  });

  it("object added appears in objects.new", () => {
    const snapshot = makeSnapshot({
      object_ids: ["obj-1"],
      entity_hashes: {
        ...baseEntityHashes,
        objects: { "obj-1": "h-obj-1" },
      },
    });
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.objects.new.map((o) => o.object_id)).toEqual(["obj-2"]);
  });

  it("object metadata edited appears in objects.modified", () => {
    const snapshot = makeSnapshot({
      entity_hashes: {
        ...baseEntityHashes,
        objects: { "obj-1": "h-obj-1-OLD", "obj-2": "h-obj-2" },
      },
    });
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.objects.modified.map((o) => o.object_id)).toEqual(["obj-1"]);
  });

  it("object removed appears in objects.deleted", () => {
    const stateWithout: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        objects: { "obj-1": "h-obj-1" },
      },
      objects: [{ object_id: "obj-1", title: "Object 1" }],
    };
    const summary = computeChangeSummary(stateWithout, makeSnapshot());
    expect(summary.objects.deleted.map((o) => o.object_id)).toEqual(["obj-2"]);
  });

  it("config field changed is detected via per-field diff", () => {
    const snapshot = makeSnapshot({
      config_hash: JSON.stringify({ title: `"Old Site"` }),
      config_managed: { title: `"Old Site"` },
    });
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.settings.changed.length).toBeGreaterThan(0);
    expect(summary.isUpToDate).toBe(false);
  });

  it("a snapshot carrying only a retired managed key reports no settings change", () => {
    // Stored snapshots can carry `story_content.answer_word_limit`, a key
    // nothing produces. Unioning current and snapshot keys would compare
    // `undefined` against the stored number and name a setting that has no
    // presence in the product and no entry in the label mapping.
    const snapshot = makeSnapshot({
      config_managed: { ...baseConfigManaged, "story_content.answer_word_limit": "60" },
    });
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.settings.changed).toHaveLength(0);
    expect(summary.isUpToDate).toBe(true);
  });

  it("a snapshot carrying an unknown key that is not retired still reports a change", () => {
    // Retirement is a named list, not a blanket amnesty for unknown keys: a key
    // this version does not understand means the snapshot holds something the
    // author should see.
    const snapshot = makeSnapshot({
      config_managed: { ...baseConfigManaged, "story_interface.some_future_toggle": "true" },
    });
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.settings.changed.map((e) => e.key)).toEqual([
      "story_interface.some_future_toggle",
    ]);
    expect(summary.isUpToDate).toBe(false);
  });

  it("nested block toggle carries its post-change value for on/off label resolution", () => {
    // Demo content flipped off: the changed entry must expose the dotted key
    // AND the new boolean value so settingsChangeI18nKey can pick the _off
    // variant (regression guard: without `value`, the commit message leaked
    // the raw i18n key — telar-compositor #10/#17 follow-up).
    const stateDemoOff: CurrentPublishState = {
      ...currentState,
      config: makeConfig({ title: "My Site", include_demo_content: false }),
    };
    const summary = computeChangeSummary(stateDemoOff, makeSnapshot());
    const demo = summary.settings.changed.find(
      (e) => e.key === "story_interface.include_demo_content",
    );
    expect(demo).toBeDefined();
    expect(demo?.value).toBe("false");
  });

  it("landing content changed is detected via entity_hashes.landing", () => {
    const snapshot = makeSnapshot({
      entity_hashes: {
        ...baseEntityHashes,
        landing: JSON.stringify({ stories_heading: "Old Heading" }),
      },
    });
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.landing.changed).toBe(true);
    expect(summary.isUpToDate).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Pages — entity-hashing-aware coverage. Pages were the first bucket to
  // get per-entity hashing (commits ffa2844, 19d6ed0); the rewrite
  // generalises the same shape across stories, objects, glossary.
  // -------------------------------------------------------------------------

  it("first-time publish lists all pages as new", () => {
    const stateWithPages: CurrentPublishState = {
      ...currentState,
      entityHashes: makeEntityHashes({
        pages: { about: "h-about", team: "h-team" },
      }),
      pages: [
        { slug: "about", title: "About" },
        { slug: "team", title: "Team" },
      ],
    };
    const summary = computeChangeSummary(stateWithPages, null);
    expect(summary.pages.new).toHaveLength(2);
    expect(summary.pages.new.map((p) => p.slug)).toEqual(["about", "team"]);
    expect(summary.pages.modified).toHaveLength(0);
    expect(summary.pages.deleted).toHaveLength(0);
  });

  it("new page appears in pages.new, existing-but-edited page appears in pages.modified", () => {
    const snapshot = makeSnapshot({
      page_slugs: ["about"],
      page_hashes: { about: "h-about-old" },
      entity_hashes: {
        ...baseEntityHashes,
        pages: { about: "h-about-old" },
      },
    });
    const stateWithPages: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        pages: { about: "h-about-new", team: "h-team" },
      },
      pages: [
        { slug: "about", title: "About" },
        { slug: "team", title: "Team" },
      ],
    };
    const summary = computeChangeSummary(stateWithPages, snapshot);
    expect(summary.pages.new.map((p) => p.slug)).toEqual(["team"]);
    expect(summary.pages.modified.map((p) => p.slug)).toEqual(["about"]);
    expect(summary.pages.deleted).toHaveLength(0);
    expect(summary.isUpToDate).toBe(false);
  });

  it("deleted page appears in pages.deleted", () => {
    const snapshot = makeSnapshot({
      page_slugs: ["about", "team"],
      entity_hashes: {
        ...baseEntityHashes,
        pages: { about: "h-about", team: "h-team" },
      },
    });
    const stateWithFewerPages: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        pages: { about: "h-about" },
      },
      pages: [{ slug: "about", title: "About" }],
    };
    const summary = computeChangeSummary(stateWithFewerPages, snapshot);
    expect(summary.pages.deleted.map((p) => p.slug)).toEqual(["team"]);
  });

  it("page with same hash as snapshot is NOT marked modified", () => {
    const snapshot = makeSnapshot({
      page_slugs: ["about"],
      page_hashes: { about: "hash-A" },
      entity_hashes: {
        ...baseEntityHashes,
        pages: { about: "hash-A" },
      },
    });
    const stateWithSameHash: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        pages: { about: "hash-A" },
      },
      pages: [{ slug: "about", title: "About" }],
    };
    const summary = computeChangeSummary(stateWithSameHash, snapshot);
    expect(summary.pages.modified).toHaveLength(0);
    expect(summary.pages.new).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Glossary — first time it gets diff coverage. Pre-rewrite glossary
  // changes never appeared in the change summary at all.
  // -------------------------------------------------------------------------

  it("new glossary term appears in glossary.new", () => {
    const snapshot = makeSnapshot({
      entity_hashes: {
        ...baseEntityHashes,
        glossary: { encomienda: "h-enc" },
      },
    });
    const stateWithGlossary: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        glossary: { encomienda: "h-enc", repartimiento: "h-rep" },
      },
      glossary: [
        { term_id: "encomienda", title: "Encomienda" },
        { term_id: "repartimiento", title: "Repartimiento" },
      ],
    };
    const summary = computeChangeSummary(stateWithGlossary, snapshot);
    expect(summary.glossary.new.map((g) => g.term_id)).toEqual(["repartimiento"]);
    expect(summary.glossary.modified).toHaveLength(0);
  });

  it("glossary term definition edited appears in glossary.modified", () => {
    const snapshot = makeSnapshot({
      entity_hashes: {
        ...baseEntityHashes,
        glossary: { encomienda: "h-enc-old" },
      },
    });
    const stateWithGlossary: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        glossary: { encomienda: "h-enc-new" },
      },
      glossary: [{ term_id: "encomienda", title: "Encomienda" }],
    };
    const summary = computeChangeSummary(stateWithGlossary, snapshot);
    expect(summary.glossary.modified.map((g) => g.term_id)).toEqual(["encomienda"]);
  });

  it("deleted glossary term appears in glossary.deleted", () => {
    const snapshot = makeSnapshot({
      entity_hashes: {
        ...baseEntityHashes,
        glossary: { encomienda: "h-enc", repartimiento: "h-rep" },
      },
    });
    const stateWithFewer: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        glossary: { encomienda: "h-enc" },
      },
      glossary: [{ term_id: "encomienda", title: "Encomienda" }],
    };
    const summary = computeChangeSummary(stateWithFewer, snapshot);
    expect(summary.glossary.deleted.map((g) => g.term_id)).toEqual(["repartimiento"]);
  });

  // -------------------------------------------------------------------------
  // Back-compat — snapshots written before entity-hashing landed have no
  // entity_hashes field. Mark every existing entity as modified for that
  // one publish (one wave of noise then accurate forever — same trade-off
  // as the page-hash back-compat fallback in commit 19d6ed0).
  // -------------------------------------------------------------------------

  it("back-compat (no entity_hashes): every existing story flagged as modified, backCompatBootstrap=true", () => {
    const summary = computeChangeSummary(currentState, makeLegacySnapshot());
    expect(summary.backCompatBootstrap).toBe(true);
    expect(summary.stories.modified.map((s) => s.story_id).sort()).toEqual([
      "painters",
      "weavers",
    ]);
    expect(summary.stories.new).toHaveLength(0);
    expect(summary.stories.deleted).toHaveLength(0);
    expect(summary.isUpToDate).toBe(false);
  });

  it("back-compat: every existing object flagged as modified", () => {
    const summary = computeChangeSummary(currentState, makeLegacySnapshot());
    expect(summary.objects.modified.map((o) => o.object_id).sort()).toEqual([
      "obj-1",
      "obj-2",
    ]);
    expect(summary.objects.new).toHaveLength(0);
    expect(summary.objects.deleted).toHaveLength(0);
  });

  it("back-compat: pages flagged via legacy page_hashes when present", () => {
    // Snapshots written between commit ffa2844 (page hashing) and the
    // entity-hashing rewrite have page_hashes but no entity_hashes —
    // back-compat falls back to page_hashes keys for legacy IDs.
    const snapshot = makeLegacySnapshot({
      page_slugs: ["about", "team"],
      page_hashes: { about: "any", team: "any" },
    });
    const stateWithPages: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        pages: { about: "h-about", team: "h-team" },
      },
      pages: [
        { slug: "about", title: "About" },
        { slug: "team", title: "Team" },
      ],
    };
    const summary = computeChangeSummary(stateWithPages, snapshot);
    expect(summary.pages.modified.map((p) => p.slug).sort()).toEqual([
      "about",
      "team",
    ]);
  });

  it("version mismatch (snapshot has entity_hashes but stale version) fires back-compat path", () => {
    // Hash format evolves over time (a prior release went from v1 → v2 when we
    // dropped `order` from object and page hashes). Without a version
    // field, an old-format snapshot's hashes look "present but wrong" and
    // every entity silently flags as Modified — confusing the user with
    // no banner explaining why. With the version check, a mismatched
    // version fires the same back-compat path as missing entity_hashes:
    // banner in the modal, modify_X parts suppressed in the commit.
    const staleVersionSnapshot: PublishSnapshot = makeSnapshot({
      entity_hashes: {
        ...baseEntityHashes,
        version: ENTITY_HASHES_VERSION - 1,
      },
    });
    const summary = computeChangeSummary(currentState, staleVersionSnapshot);
    expect(summary.backCompatBootstrap).toBe(true);
    // Existing entities flagged as modified per the standard back-compat
    // contract — same as if entity_hashes were missing entirely.
    expect(summary.stories.modified.map((s) => s.story_id).sort()).toEqual([
      "painters",
      "weavers",
    ]);
  });

  it("back-compat: glossary terms surface as MODIFIED, not Added", () => {
    // Glossary was never tracked in pre-rewrite snapshots, so legacyIds is
    // empty for the glossary bucket. The naive interpretation of "empty
    // legacy" would be "definitely none existed" → all current → New.
    // That's wrong: the empty really means "we never tracked them" — terms
    // bundled with the template predate anything the user did. Calling
    // them "Added" on the bootstrap commit would be a definitive claim
    // the system can't back up. Match stories/objects/pages by flagging
    // every current term as Modified instead — same back-compat principle:
    // we can't separate signal from noise, so we acknowledge it uniformly.
    const stateWithGlossary: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        glossary: { encomienda: "h-enc" },
      },
      glossary: [{ term_id: "encomienda", title: "Encomienda" }],
    };
    const summary = computeChangeSummary(stateWithGlossary, makeLegacySnapshot());
    expect(summary.glossary.modified.map((g) => g.term_id)).toEqual(["encomienda"]);
    expect(summary.glossary.new).toHaveLength(0);
    expect(summary.glossary.deleted).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  it("navigation hash change is detected as navigation.changed", () => {
    const snapshot = makeSnapshot({
      navigation_hash: "old-nav-hash",
      entity_hashes: {
        ...baseEntityHashes,
        navigation: "old-nav-hash",
      },
    });
    const stateWithNewNav: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        navigation: "new-nav-hash",
      },
    };
    const summary = computeChangeSummary(stateWithNewNav, snapshot);
    expect(summary.navigation.changed).toBe(true);
    expect(summary.isUpToDate).toBe(false);
  });

  it("navigation hash unchanged means navigation.changed is false", () => {
    const snapshot = makeSnapshot({
      navigation_hash: "same-nav-hash",
      entity_hashes: {
        ...baseEntityHashes,
        navigation: "same-nav-hash",
      },
    });
    const stateWithSameNav: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        navigation: "same-nav-hash",
      },
    };
    const summary = computeChangeSummary(stateWithSameNav, snapshot);
    expect(summary.navigation.changed).toBe(false);
  });

  it("back-compat (no entity_hashes): non-empty current nav surfaces as a change", () => {
    const stateWithNav: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        navigation: "current-nav-hash",
      },
    };
    const summary = computeChangeSummary(stateWithNav, makeLegacySnapshot());
    expect(summary.navigation.changed).toBe(true);
  });

  it("back-compat AND empty current nav means no change (defensive)", () => {
    // A project with no navigation + a back-compat snapshot must NOT
    // spuriously flag navigation as changed; otherwise every legacy
    // project's first post-upgrade publish would falsely claim a nav
    // change.
    const stateWithoutNav: CurrentPublishState = {
      ...currentState,
      entityHashes: {
        ...baseEntityHashes,
        navigation: "",
      },
    };
    const summary = computeChangeSummary(stateWithoutNav, makeLegacySnapshot());
    expect(summary.navigation.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildNavigationYml
// ---------------------------------------------------------------------------

describe("buildNavigationYml", () => {
  it("generates correct YAML for page items", () => {
    const result = buildNavigationYml([
      { type: "page", slug: "about", label: "About", visible: true },
    ]);
    expect(result).toContain('title_en: "About"');
    expect(result).toContain('titulo_es: "About"');
    expect(result).toContain('url: "/about/"');
  });

  it("writes the address the site serves for a page imported from a file name that is not a slug", () => {
    const result = buildNavigationYml([
      { type: "page", slug: "Credits", label: "Credits", visible: true },
      { type: "page", slug: "credits_two", label: "Credits two", visible: true },
    ]);
    expect(result).toContain('url: "/credits/"');
    expect(result).toContain('url: "/credits-two/"');
    expect(result).not.toContain("/Credits/");
    expect(result).not.toContain("/credits_two/");
  });

  it("generates correct YAML for builtin glossary item", () => {
    const result = buildNavigationYml([
      { type: "builtin", key: "glossary", label: "Glossary", visible: true },
    ]);
    expect(result).toContain('title_en: "Glossary"');
    expect(result).toContain('titulo_es: "Glosario"');
    expect(result).toContain('url: "/glossary/"');
  });

  it("generates correct YAML for builtin collection item", () => {
    const result = buildNavigationYml([
      { type: "builtin", key: "collection", label: "Collection", visible: true },
    ]);
    expect(result).toContain('url: "/objects/"');
    // Canonical bilingual labels, NOT the stored "Collection" label
    expect(result).toContain('title_en: "Objects"');
    expect(result).toContain('titulo_es: "Objetos"');
  });

  it("emits canonical bilingual builtin labels, ignoring the stored English label", () => {
    // Builtins are not user-renameable; the stored label is the English seed.
    // The serializer must emit the framework's canonical pair so the published
    // titulo_es is Spanish on es sites (the original moravia leak).
    const result = buildNavigationYml([
      { type: "builtin", key: "glossary", label: "Glossary", visible: true },
      { type: "builtin", key: "collection", label: "Objects", visible: true },
    ]);
    expect(result).toContain('titulo_es: "Glosario"');
    expect(result).toContain('titulo_es: "Objetos"');
    // The English seed must never land in titulo_es
    expect(result).not.toContain('titulo_es: "Glossary"');
    expect(result).not.toContain('titulo_es: "Objects"');
  });

  it("does not emit a Home builtin (navbar-brand links home)", () => {
    const result = buildNavigationYml([
      { type: "builtin", key: "home", label: "Home", visible: true },
      { type: "builtin", key: "glossary", label: "Glossary", visible: true },
    ]);
    // Home produces no menu entry; only glossary remains
    expect(result).not.toContain('url: "/"\n');
    expect(result).not.toContain('title_en: "Home"');
    expect(result).not.toContain('titulo_es: "Inicio"');
    expect(result).toContain('url: "/glossary/"');
  });

  it("ignores prototype-chain keys (e.g. __proto__) without crashing", () => {
    const result = buildNavigationYml([
      { type: "builtin", key: "__proto__", label: "x", visible: true },
      { type: "builtin", key: "glossary", label: "Glossary", visible: true },
    ]);
    // The bogus key resolves to no own entry → skipped, no crash, no "undefined"
    expect(result).toContain('url: "/glossary/"');
    expect(result).not.toContain("undefined");
  });

  it("generates correct YAML for external link items", () => {
    const result = buildNavigationYml([
      { type: "external", url: "https://example.com", label: "Partner", visible: true },
    ]);
    expect(result).toContain('title_en: "Partner"');
    expect(result).toContain('url: "https://example.com"');
    expect(result).toContain("external: true");
  });

  it("excludes hidden items (visible: false)", () => {
    const result = buildNavigationYml([
      { type: "page", slug: "team", label: "Team", visible: false },
      { type: "page", slug: "about", label: "About", visible: true },
    ]);
    expect(result).not.toContain("Team");
    expect(result).toContain("About");
  });

  it("writes both title_en and titulo_es with same label for monolingual sites", () => {
    const result = buildNavigationYml([
      { type: "page", slug: "about", label: "About Us", visible: true },
    ]);
    expect(result).toContain('title_en: "About Us"');
    expect(result).toContain('titulo_es: "About Us"');
  });
});

// ---------------------------------------------------------------------------
// glossary and pages publish
// ---------------------------------------------------------------------------

describe("glossary and pages publish", () => {
  it("serialises glossary_terms to glossary.csv", () => {
    // Papa.unparse emits the header automatically and quotes only fields that
    // need it — so a plain row carries no spurious quotes (comp1 T3 change).
    // A Spanish bilingual second row now follows the English header, mirroring
    // objects.csv (SSOT alignment).
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: null,
      },
    ]);
    expect(result).toBe(
      "term_id,title,definition,related_terms\n" +
        "id_término,titulo,definición,términos_relacionados\n" +
        "enc,Encomienda,A labor system,\n",
    );
  });

  it("serializeGlossaryCsv emits the Spanish bilingual row as row 2", () => {
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: null,
      },
    ]);
    expect(result.split("\n")[1]).toBe(
      "id_término,titulo,definición,términos_relacionados",
    );
  });

  it("serializeGlossaryCsv preserves comment rows from the existing CSV", () => {
    const existing =
      "term_id,title,definition,related_terms\n" +
      "id_término,titulo,definición,términos_relacionados\n" +
      "# Add one term per row. The term_id must be unique.\n" +
      "enc,Encomienda,A labor system,\n";
    const result = serializeGlossaryCsv(
      [
        {
          term_id: "enc",
          title: "Encomienda",
          definition: "A labor system",
          related_terms: null,
        },
      ],
      existing,
    );
    const lines = result.split("\n");
    expect(lines[0]).toBe("term_id,title,definition,related_terms");
    expect(lines[1]).toBe("id_término,titulo,definición,términos_relacionados");
    expect(lines[2]).toBe("# Add one term per row. The term_id must be unique.");
    expect(lines[3]).toBe("enc,Encomienda,A labor system,");
  });

  // -------------------------------------------------------------------------
  // Custom-column passthrough. The invariant under test alongside the columns
  // themselves: a custom column's bilingual cell is EMPTY, never its own key.
  // Both header detectors exclude empty cells from the known-bilingual ratio,
  // so empties hold the ratio at 1.0; echoing the keys would drop it below 0.8
  // and the row would re-import as a phantom term.
  // -------------------------------------------------------------------------

  it("serializeGlossaryCsv appends custom columns after the fixed ones, sorted", () => {
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: null,
        extra_columns: JSON.stringify({ zeta_note: "Z", alpha_note: "A" }),
      },
    ]);
    expect(result.split("\n")[0]).toBe(
      "term_id,title,definition,related_terms,alpha_note,zeta_note",
    );
    // The bilingual row stands between the header and the data at every width,
    // its two custom cells empty.
    expect(result.split("\n")[1]).toBe(
      "id_término,titulo,definición,términos_relacionados,,",
    );
    expect(result.split("\n")[2]).toBe("enc,Encomienda,A labor system,,A,Z");
  });

  it("serializeGlossaryCsv emits an EMPTY bilingual cell for a custom column", () => {
    // No detector counts an empty cell, so the custom cell must be empty rather
    // than echo the key: echoing it would put the ratio under the threshold.
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: null,
        extra_columns: JSON.stringify({ alpha_note: "A" }),
      },
    ]);
    expect(result.split("\n")[1]).toBe(
      "id_término,titulo,definición,términos_relacionados,",
    );
  });

  it("serializeGlossaryCsv writes one file with the union of columns, blank where a term lacks one", () => {
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: null,
        extra_columns: JSON.stringify({ source_note: "Museo" }),
      },
      { term_id: "loom", title: "Loom", definition: "A device", related_terms: null },
    ]);
    const lines = result.split("\n");
    expect(lines[0]).toBe("term_id,title,definition,related_terms,source_note");
    expect(lines[2]).toBe("enc,Encomienda,A labor system,,Museo");
    expect(lines[3]).toBe("loom,Loom,A device,,");
  });

  it("serializeGlossaryCsv degrades a corrupt extra_columns blob to no custom columns", () => {
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: null,
        extra_columns: "{not json",
      },
    ]);
    expect(result.split("\n")[0]).toBe("term_id,title,definition,related_terms");
  });

  // A custom column can be named after an Object.prototype member. On a plain
  // row object a term LACKING that column reads the inherited value, so the
  // published cell carries "[object Object]" or a function's source instead of
  // a blank. Null-prototype rows have nothing to inherit.
  it("emits a blank cell, not an inherited value, for a prototype-named custom column", () => {
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: null,
        // Written as raw JSON: in an object literal `__proto__` is the
        // prototype setter, so JSON.stringify would drop it. JSON.parse makes
        // it a genuine own key, which is exactly the hazard under test.
        extra_columns: '{"constructor":"mine","__proto__":"also mine"}',
      },
      // This term declares neither custom column.
      { term_id: "loom", title: "Loom", definition: "A device", related_terms: null },
    ]);
    const lines = result.split("\n");
    expect(lines[0]).toBe(
      "term_id,title,definition,related_terms,__proto__,constructor",
    );
    expect(lines[1]).toBe(
      "id_término,titulo,definición,términos_relacionados,,",
    );
    expect(lines[2]).toBe("enc,Encomienda,A labor system,,also mine,mine");
    // The term without the columns publishes two empty cells.
    expect(lines[3]).toBe("loom,Loom,A device,,,");
    expect(result).not.toContain("[object Object]");
    expect(result).not.toContain("function Object");
  });

  // -------------------------------------------------------------------------
  // The bilingual row goes out on every glossary.csv, as it does on every
  // objects.csv.
  //
  // Every detector that reads the file counts known tokens over its POPULATED
  // cells, so a custom column's empty cell never enters the ratio and five
  // tokens over five cells stays 1.0 at any width. The row is what keeps the
  // Spanish header names readable, and a file without it hands the detector the
  // first real term to judge instead.
  // -------------------------------------------------------------------------

  it("emits the bilingual row with no custom columns", () => {
    const result = serializeGlossaryCsv([
      { term_id: "enc", title: "E", definition: "d", related_terms: null },
    ]);
    expect(result.split("\n")[1]).toBe(
      "id_término,titulo,definición,términos_relacionados",
    );
  });

  it("emits it with one custom column, its cell empty", () => {
    const result = serializeGlossaryCsv([
      {
        term_id: "enc", title: "E", definition: "d", related_terms: null,
        extra_columns: JSON.stringify({ source_note: "Museo" }),
      },
    ]);
    expect(result.split("\n")[1]).toBe(
      "id_término,titulo,definición,términos_relacionados,",
    );
  });

  it("emits it at two custom columns, both cells empty", () => {
    const result = serializeGlossaryCsv([
      {
        term_id: "enc", title: "E", definition: "d", related_terms: null,
        extra_columns: JSON.stringify({ a_note: "1", b_note: "2" }),
      },
    ]);
    const lines = result.split("\n");
    expect(lines[0]).toBe(
      "term_id,title,definition,related_terms,a_note,b_note",
    );
    expect(lines[1]).toBe(
      "id_término,titulo,definición,términos_relacionados,,",
    );
    expect(lines[2]).toBe("enc,E,d,,1,2");
  });

  it("keeps comment rows after the bilingual row", () => {
    const existing = "term_id,title\n# Add one term per row.\nenc,E\n";
    const result = serializeGlossaryCsv(
      [
        {
          term_id: "enc", title: "E", definition: "d", related_terms: null,
          extra_columns: JSON.stringify({ a_note: "1", b_note: "2" }),
        },
      ],
      existing,
    );
    const lines = result.split("\n");
    expect(lines[1]).toBe(
      "id_término,titulo,definición,términos_relacionados,,",
    );
    expect(lines[2]).toBe("# Add one term per row.");
    expect(lines[3]).toBe("enc,E,d,,1,2");
  });

  it("never emits a fixed column twice when an extras key repeats its name", () => {
    // The blocker refuses this before publish; the serializer must still not be
    // able to write a duplicate header, and the first-class value must win.
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: "real-value",
        extra_columns: JSON.stringify({ related_terms: "from-extras", Title: "also" }),
      },
    ]);
    const header = result.split("\n")[0].split(",");
    expect(header.filter((c) => c === "related_terms")).toHaveLength(1);
    expect(header.filter((c) => c.toLowerCase() === "title")).toHaveLength(1);
    // The first-class value, not the extras one.
    expect(result).toContain("real-value");
    expect(result).not.toContain("from-extras");
  });

  it("serializeGlossaryCsv escapes double quotes in values", () => {
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: 'Say "hello"',
        definition: 'Has "quotes"',
        related_terms: null,
      },
    ]);
    expect(result).toContain('"Say ""hello"""');
    expect(result).toContain('"Has ""quotes"""');
  });

  it("serializeGlossaryCsv handles null title and definition", () => {
    const result = serializeGlossaryCsv([
      { term_id: "enc", title: null, definition: null, related_terms: null },
    ]);
    // Empty cells are unquoted under correct CSV (Papa only quotes when needed).
    expect(result).toBe(
      "term_id,title,definition,related_terms\n" +
        "id_término,titulo,definición,términos_relacionados\n" +
        "enc,,,\n",
    );
  });

  it("serializeGlossaryCsv emits a related_terms column with the pipe list preserved", () => {
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: "loom|weaving",
      },
    ]);
    expect(result).toBe(
      "term_id,title,definition,related_terms\n" +
        "id_término,titulo,definición,términos_relacionados\n" +
        "enc,Encomienda,A labor system,loom|weaving\n",
    );
  });

  it("serializeGlossaryCsv round-trips a custom header carrying a newline, byte for byte", async () => {
    const { parseTelarCsv, mapGlossaryCsv } = await import("~/lib/import.server");
    // A quoted header may hold a newline, and RFC 4180 says nothing against it.
    // Every section of the file is a whole record set, so the bilingual row can
    // only land after the header record, never inside its second physical line.
    const term = {
      term_id: "enc",
      title: "Encomienda",
      definition: "A labor system",
      related_terms: null,
      extra_columns: JSON.stringify({ "editor\nnote": "v" }),
    };
    const first = serializeGlossaryCsv([term]);
    const second = serializeGlossaryCsv(
      mapGlossaryCsv(parseTelarCsv(first)).map((t) => ({
        term_id: t.term_id,
        title: t.title ?? null,
        definition: t.definition ?? null,
        related_terms: t.related_terms ?? null,
        extra_columns: t.extra_columns ?? null,
      })),
    );
    expect(second).toBe(first);
    // The bilingual row is the second RECORD, whatever the header's line count.
    const records = Papa.parse<string[]>(first.trimEnd()).data;
    expect(records[0]).toEqual([
      "term_id", "title", "definition", "related_terms", "editor\nnote",
    ]);
    expect(records[1]).toEqual([
      "id_término", "titulo", "definición", "términos_relacionados", "",
    ]);
    expect(records[2]).toEqual(["enc", "Encomienda", "A labor system", "", "v"]);
  });

  it("serializeGlossaryCsv quotes a term_id containing a comma and round-trips it (comp1 T3 fix)", async () => {
    const { parseTelarCsv, mapGlossaryCsv } = await import(
      "~/lib/import.server"
    );
    const result = serializeGlossaryCsv([
      {
        term_id: "a,b",
        title: "Comma id",
        definition: "Has a comma in its id",
        related_terms: null,
      },
    ]);
    // The term_id must be quoted so the row doesn't gain a spurious column.
    expect(result).toContain('"a,b"');
    const mapped = mapGlossaryCsv(parseTelarCsv(result));
    expect(mapped).toHaveLength(1);
    expect(mapped[0].term_id).toBe("a,b");
  });

  it("serializeGlossaryCsv handles a definition with a comma and a double-quote and round-trips it", async () => {
    const { parseTelarCsv, mapGlossaryCsv } = await import(
      "~/lib/import.server"
    );
    const def = 'A system, with "quotes" too';
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: def,
        related_terms: null,
      },
    ]);
    const mapped = mapGlossaryCsv(parseTelarCsv(result));
    expect(mapped[0].definition).toBe(def);
  });

  it("serializeGlossaryCsv round-trips related_terms through parse + map", async () => {
    const { parseTelarCsv, mapGlossaryCsv } = await import(
      "~/lib/import.server"
    );
    const result = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: "Encomienda",
        definition: "A labor system",
        related_terms: "loom|weaving",
      },
    ]);
    const mapped = mapGlossaryCsv(parseTelarCsv(result));
    expect(mapped[0].related_terms).toBe("loom|weaving");
  });

  it("serializeGlossaryCsv round-trips with bilingual + comment rows skipped (no phantom rows)", async () => {
    const { parseTelarCsv, mapGlossaryCsv } = await import(
      "~/lib/import.server"
    );
    const existing =
      "term_id,title,definition,related_terms\n" +
      "id_término,titulo,definición,términos_relacionados\n" +
      "# Add one term per row.\n";
    const result = serializeGlossaryCsv(
      [
        {
          term_id: "enc",
          title: "Encomienda",
          definition: "A labor system",
          related_terms: "loom|weaving",
        },
      ],
      existing,
    );
    // The bilingual row (row 2) and the preserved comment row must both be
    // skipped on re-import, leaving exactly the data term — no phantom row.
    const mapped = mapGlossaryCsv(parseTelarCsv(result));
    expect(mapped).toHaveLength(1);
    expect(mapped[0].term_id).toBe("enc");
    expect(mapped[0].title).toBe("Encomienda");
    expect(mapped[0].definition).toBe("A labor system");
    expect(mapped[0].related_terms).toBe("loom|weaving");
  });

  it("serialises pages to markdown files with frontmatter", async () => {
    const result = await serializePageMarkdown("About", "Welcome to the site.");
    expect(result).toBe('---\ntitle: "About"\n---\n\nWelcome to the site.\n');
  });

  it("serializePageMarkdown handles empty body", async () => {
    const result = await serializePageMarkdown("Contact", "");
    expect(result).toBe('---\ntitle: "Contact"\n---\n\n\n');
  });
});

// ---------------------------------------------------------------------------
// runPrePublishValidation
// ---------------------------------------------------------------------------

describe("runPrePublishValidation", () => {
  const validParams = {
    headSha: "abc123",
    currentRepoHead: "abc123",
    stories: [{ story_id: "weavers", title: "The Weavers" }],
    steps: [
      {
        id: 1,
        step_number: 1,
        object_id: "obj-1",
        x: 0.5,
        y: 0.3,
        zoom: 1.2,
        question: null,
        answer: null,
      },
    ],
    objects: [{ object_id: "obj-1", title: "My Object" }],
    pages: [{ slug: "about", title: "About" }],
    glossary: [{ term_id: "backstrap-loom" }],
  };

  it("returns stale_head blocker when SHAs mismatch", () => {
    const result = runPrePublishValidation({
      ...validParams,
      currentRepoHead: "different-sha",
    });
    expect(result.blockers.map((b) => b.code)).toContain("stale_head");
  });

  it("returns no blockers when SHAs match", () => {
    const result = runPrePublishValidation(validParams);
    expect(result.blockers).toHaveLength(0);
  });

  it("returns object_no_title warning for objects without titles", () => {
    const result = runPrePublishValidation({
      ...validParams,
      objects: [{ object_id: "obj-1", title: null }],
    });
    expect(result.warnings.map((w) => w.code)).toContain("object_no_title");
  });

  it("returns object_no_title warning for objects with empty title", () => {
    const result = runPrePublishValidation({
      ...validParams,
      objects: [{ object_id: "obj-1", title: "" }],
    });
    expect(result.warnings.map((w) => w.code)).toContain("object_no_title");
  });

  // ---------------------------------------------------------------------------
  // object_reserved_column blocker
  //
  // serializeObjectsCsv writes every extra_columns key back out as a real
  // objects.csv column, and the framework's own build (scripts/telar/
  // csv_utils.py's _refuse_reserved_columns) refuses any sheet carrying a
  // reserved name. Shipping one would commit a file the site's very next
  // build cannot process, so this blocks rather than warns.
  //
  // The reserved set is pinned here as a literal ("_metadata"), never by
  // importing RESERVED_COLUMN_NAMES — a test parametrised over the set it
  // pins would still pass if the set were emptied.
  // ---------------------------------------------------------------------------
  describe("object_reserved_column blocker", () => {
    it("blocks an object whose extra_columns carries the reserved name, naming the object and column", () => {
      const result = runPrePublishValidation({
        ...validParams,
        objects: [
          { object_id: "obj-1", title: "My Object", extra_columns: JSON.stringify({ _metadata: "x" }) },
        ],
      });
      const blockers = result.blockers.filter((b) => b.code === "object_reserved_column");
      expect(blockers).toHaveLength(1);
      expect(blockers[0].entityId).toBe("obj-1");
      expect(blockers[0].params).toEqual({ id: "obj-1", column: "_metadata" });
    });

    it.each(["_Metadata", "_METADATA", "_metadata ", " _metadata"])(
      "blocks the reserved name %j regardless of case or surrounding whitespace",
      (columnName) => {
        const result = runPrePublishValidation({
          ...validParams,
          objects: [
            { object_id: "obj-1", title: "My Object", extra_columns: JSON.stringify({ [columnName]: "x" }) },
          ],
        });
        expect(result.blockers.map((b) => b.code)).toContain("object_reserved_column");
      },
    );

    it.each(["my_metadata", "metadata", "_metadatas", "object_metadata"])(
      "does not block a column that merely contains the word (%j is not an exact match)",
      (columnName) => {
        const result = runPrePublishValidation({
          ...validParams,
          objects: [
            { object_id: "obj-1", title: "My Object", extra_columns: JSON.stringify({ [columnName]: "x" }) },
          ],
        });
        expect(result.blockers.map((b) => b.code)).not.toContain("object_reserved_column");
      },
    );

    it("does not block an objects CSV without the reserved column", () => {
      const result = runPrePublishValidation({
        ...validParams,
        objects: [
          { object_id: "obj-1", title: "My Object", extra_columns: JSON.stringify({ procedencia: "Bogotá" }) },
        ],
      });
      expect(result.blockers.map((b) => b.code)).not.toContain("object_reserved_column");
    });

    it("does not block an object with no extra_columns at all", () => {
      const result = runPrePublishValidation(validParams);
      expect(result.blockers.map((b) => b.code)).not.toContain("object_reserved_column");
    });

    it("emits one blocker per affected object, and none for a clean one", () => {
      const result = runPrePublishValidation({
        ...validParams,
        objects: [
          { object_id: "obj-1", title: "A", extra_columns: JSON.stringify({ _metadata: "x" }) },
          { object_id: "obj-2", title: "B", extra_columns: JSON.stringify({ notes: "fine" }) },
          { object_id: "obj-3", title: "C", extra_columns: JSON.stringify({ _METADATA: "y" }) },
        ],
      });
      const blockers = result.blockers.filter((b) => b.code === "object_reserved_column");
      expect(blockers).toHaveLength(2);
      expect(blockers.map((b) => b.entityId).sort()).toEqual(["obj-1", "obj-3"]);
    });

    it("degrades a corrupt extra_columns blob to no blocker, never throws", () => {
      expect(() =>
        runPrePublishValidation({
          ...validParams,
          objects: [{ object_id: "obj-1", title: "A", extra_columns: "{not json" }],
        }),
      ).not.toThrow();
      const result = runPrePublishValidation({
        ...validParams,
        objects: [{ object_id: "obj-1", title: "A", extra_columns: "{not json" }],
      });
      expect(result.blockers.map((b) => b.code)).not.toContain("object_reserved_column");
    });
  });

  // ---------------------------------------------------------------------------
  // object_id_comment_row / glossary_id_comment_row blockers
  //
  // object_id is OBJECTS_CSV_COLUMNS[0] and term_id is GLOSSARY_CSV_COLUMNS[0]
  // (csv-export.server.ts), so a published row's first cell is always its id.
  // telar.core.csv_to_json drops any row whose first cell, CPython-stripped,
  // starts with "#" (scripts/telar/core.py:99), and generate_collections.py
  // drops a glossary term by the same test applied to term_id directly (:347)
  // — so an id opening "#" turns the row into a comment the instant it is
  // published, and the object or term disappears from the site.
  // ---------------------------------------------------------------------------
  describe("object_id_comment_row / glossary_id_comment_row blockers", () => {
    it("blocks an object whose object_id opens '#', naming the object", () => {
      const result = runPrePublishValidation({
        ...validParams,
        objects: [{ object_id: "#obj-1", title: "My Object" }],
      });
      const blockers = result.blockers.filter((b) => b.code === "object_id_comment_row");
      expect(blockers).toHaveLength(1);
      expect(blockers[0].entityId).toBe("#obj-1");
      expect(blockers[0].params).toEqual({ id: "#obj-1" });
    });

    it("blocks a glossary term whose term_id opens '#', naming the term", () => {
      const result = runPrePublishValidation({
        ...validParams,
        glossary: [{ term_id: "#backstrap-loom" }],
      });
      const blockers = result.blockers.filter((b) => b.code === "glossary_id_comment_row");
      expect(blockers).toHaveLength(1);
      expect(blockers[0].entityId).toBe("#backstrap-loom");
      expect(blockers[0].params).toEqual({ id: "#backstrap-loom" });
    });

    // The trap: csv-export.server.ts's extractCommentRows/repairCommentRecord
    // deliberately preserve a sheet's own "#"-led template instruction rows
    // through republish. A check that fired on every "#" it saw would flag
    // every publish of a project that has ever carried one of those rows.
    // This pins the actual reason it does not: a comment row never becomes an
    // ObjectForValidation in the first place. parseTelarCsv drops it (its row
    // detector -> isCommentRow, by POSITION — testing the sheet's first cell
    // regardless of which named column that is), so mapObjectsCsv
    // never emits a record for it and params.objects never carries one. The
    // blocker has nothing to see, structurally, not by luck of the fixture.
    it("does not raise a blocker for a preserved comment row, because comment rows never become objects", async () => {
      const { parseTelarCsv, mapObjectsCsv } = await import("~/lib/import.server");
      // Column order matters here: "title" first, "object_id" second — the
      // exact shape the comment-row blocker is about. The comment row's first CELL ("#Please
      // fill in your objects below") is what makes it a comment, not which
      // column it happens to sit under.
      const csv = [
        "title,object_id",
        '"#Please fill in your objects below",ignored',
        "Real Object,#obj-1",
      ].join("\n");

      const rows = parseTelarCsv(csv);
      const mapped = mapObjectsCsv(rows);

      // The comment row never reached the parsed rows at all.
      expect(mapped).toHaveLength(1);
      expect(mapped[0].object_id).toBe("#obj-1");

      const result = runPrePublishValidation({
        ...validParams,
        objects: mapped.map((o) => ({
          object_id: o.object_id,
          title: o.title ?? null,
          extra_columns: o.extra_columns ?? null,
        })),
      });

      // The one real object's bad id still blocks...
      expect(result.blockers.map((b) => b.code)).toContain("object_id_comment_row");
      // ...but there is exactly one such blocker: the comment row raised none.
      expect(
        result.blockers.filter((b) => b.code === "object_id_comment_row"),
      ).toHaveLength(1);
    });

    // The trap above puts "title" in the sheet's first cell, so a check that
    // classifies by the title column and one that classifies by position give
    // the same answer there — it cannot tell a positional detector from a
    // title-only one. This fixture puts the id first instead — the
    // Compositor's own canonical column order (OBJECTS_CSV_COLUMNS[0]) — which
    // is where the two disagree: positional detection reads cell zero
    // ("#instruction") and drops the row; title-only detection would read
    // "Instructions", find no "#", and import the row as a real object whose
    // id then blocks publishing.
    it("drops a template instruction row by position when object_id sits first, not by the title cell", async () => {
      const { parseTelarCsv, mapObjectsCsv } = await import("~/lib/import.server");
      const csv = ["object_id,title", "#instruction,Instructions"].join("\n");
      const mapped = mapObjectsCsv(parseTelarCsv(csv));
      expect(mapped).toHaveLength(0);
    });

    it("drops a template instruction row by position when term_id sits first, not by the title cell", async () => {
      const { parseTelarCsv, mapGlossaryCsv } = await import("~/lib/import.server");
      const csv = [
        "term_id,title,definition",
        "#instruction,Instructions,Fill in one term per row",
      ].join("\n");
      const mapped = mapGlossaryCsv(parseTelarCsv(csv));
      expect(mapped).toHaveLength(0);
    });

    // The framework's row rule is CPython's strip(), not JavaScript's trim() —
    // and the two disagree over exactly these two code points, in opposite
    // directions. isCommentCell (csv-records.ts) is what the blocker has to
    // call to land on the framework's side of both; a trim()-based test gets
    // both backwards.
    it("does not block an object_id opening U+FEFF then '#' — CPython's strip() does not remove the mark, so the framework reads the row as data and builds it", () => {
      const result = runPrePublishValidation({
        ...validParams,
        objects: [{ object_id: "\uFEFF#obj-1", title: "My Object" }],
      });
      expect(result.blockers.map((b) => b.code)).not.toContain("object_id_comment_row");
    });

    it("blocks an object_id opening U+0085 then '#' — CPython's strip() removes the mark, so the framework reads the row as a comment and drops it", () => {
      const result = runPrePublishValidation({
        ...validParams,
        objects: [{ object_id: "\u0085#obj-1", title: "My Object" }],
      });
      expect(result.blockers.map((b) => b.code)).toContain("object_id_comment_row");
    });

    // The two Unicode fixtures above only exercise objects. commentRowIdBlockers
    // is shared, but idOf is not: a change to the glossary call alone (passing
    // a JS-trimmed term_id into the shared isCommentCell check, say) could move
    // only the glossary side off the framework's rule while every object test
    // above kept passing. These pin the glossary side independently.
    it("does not block a term_id opening U+FEFF then '#' - CPython's strip() does not remove the mark, so the framework reads the row as data and builds it", () => {
      const result = runPrePublishValidation({
        ...validParams,
        glossary: [{ term_id: "\uFEFF#backstrap-loom" }],
      });
      expect(result.blockers.map((b) => b.code)).not.toContain("glossary_id_comment_row");
    });

    it("blocks a term_id opening U+0085 then '#' - CPython's strip() removes the mark, so the framework reads the row as a comment and drops it", () => {
      const result = runPrePublishValidation({
        ...validParams,
        glossary: [{ term_id: "\u0085#backstrap-loom" }],
      });
      expect(result.blockers.map((b) => b.code)).toContain("glossary_id_comment_row");
    });

    // commentRowIdBlockers promises one blocker per affected row. Every test
    // above carries exactly one bad id, so a version that stopped at the
    // first match would satisfy all of them; this needs two bad ids on one
    // sheet to catch it.
    it("blocks every object whose object_id opens '#', not just the first", () => {
      const result = runPrePublishValidation({
        ...validParams,
        objects: [
          { object_id: "#obj-1", title: "One" },
          { object_id: "#obj-2", title: "Two" },
        ],
      });
      const blockers = result.blockers.filter((b) => b.code === "object_id_comment_row");
      expect(blockers).toHaveLength(2);
      expect(blockers.map((b) => b.entityId)).toEqual(["#obj-1", "#obj-2"]);
    });
  });

  it("returns step_no_position warning for steps with object but no position", () => {
    const result = runPrePublishValidation({
      ...validParams,
      steps: [
        {
          ...validParams.steps[0],
          x: null,
          y: null,
          zoom: null,
          object_id: "obj-1",
        },
      ],
    });
    expect(result.warnings.map((w) => w.code)).toContain("step_no_position");
  });

  it("does not warn for fully empty steps", () => {
    const result = runPrePublishValidation({
      ...validParams,
      steps: [
        {
          id: 1,
          step_number: 1,
          object_id: null,
          x: null,
          y: null,
          zoom: null,
          question: null,
          answer: null,
        },
      ],
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("step_no_position");
  });

  it("does not warn for steps with no object even if no position (valid content-only steps)", () => {
    const result = runPrePublishValidation({
      ...validParams,
      steps: [
        {
          id: 1,
          step_number: 1,
          object_id: null,
          x: null,
          y: null,
          zoom: null,
          question: "What is this?",
          answer: "A thing.",
        },
      ],
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("step_no_position");
  });

  it("returns no warnings for a fully valid setup", () => {
    const result = runPrePublishValidation(validParams);
    expect(result.warnings).toHaveLength(0);
    expect(result.blockers).toHaveLength(0);
  });

  // Pages without titles surface as BLOCKERS, not warnings.
  // Distinct from object_no_title: an untitled page can't be published
  // (no usable URL/menu entry — pageRowsToCommitFiles excludes it), so
  // gating here forces the user to either name or delete the row before
  // any publish proceeds.
  it("returns page_no_title blocker for pages with null title", () => {
    const result = runPrePublishValidation({
      ...validParams,
      pages: [{ slug: "untitled", title: null }],
    });
    const pageBlockers = result.blockers.filter((b) => b.code === "page_no_title");
    expect(pageBlockers).toHaveLength(1);
    // The blocker no longer derives identity from a (possibly empty) slug.
    // entityId is a 1-based ordinal among untitled pages, and there is no
    // slug param (the reworded copy does not interpolate it).
    expect(pageBlockers[0].entityId).toBe("untitled-1");
    expect(pageBlockers[0].params).toBeUndefined();
    // Must NOT also surface as a warning (single source of truth)
    expect(result.warnings.map((w) => w.code)).not.toContain("page_no_title");
  });

  it("returns page_no_title blocker for pages with empty title", () => {
    const result = runPrePublishValidation({
      ...validParams,
      pages: [{ slug: "untitled-3", title: "" }],
    });
    expect(result.blockers.map((b) => b.code)).toContain("page_no_title");
  });

  it("returns page_no_title blocker for pages with whitespace-only title", () => {
    const result = runPrePublishValidation({
      ...validParams,
      pages: [{ slug: "blank", title: "   " }],
    });
    expect(result.blockers.map((b) => b.code)).toContain("page_no_title");
  });

  it("does not block for pages with valid titles", () => {
    const result = runPrePublishValidation({
      ...validParams,
      pages: [
        { slug: "about", title: "About" },
        { slug: "team", title: "Team" },
      ],
    });
    expect(result.blockers.map((b) => b.code)).not.toContain("page_no_title");
  });

  it("emits one page_no_title blocker per untitled page", () => {
    const result = runPrePublishValidation({
      ...validParams,
      pages: [
        { slug: "about", title: "About" },
        { slug: "untitled-1", title: null },
        { slug: "untitled-2", title: "" },
      ],
    });
    expect(result.blockers.filter((b) => b.code === "page_no_title")).toHaveLength(2);
  });

  // Stories without titles surface as BLOCKERS, not warnings.
  // `serializeProjectCsv` (:399) does not drop an untitled story the way it
  // drops drafts — it writes title: "" — so a published, untitled story ships
  // as a blank entry in the story index, with nothing telling the user why.
  // The message names the story by its story_id, since that is the only
  // identifier an untitled story has.
  it("returns story_no_title blocker for stories with null title", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "weavers", title: null }],
    });
    const storyBlockers = result.blockers.filter((b) => b.code === "story_no_title");
    expect(storyBlockers).toHaveLength(1);
    expect(storyBlockers[0].entityId).toBe("weavers");
    expect(storyBlockers[0].params).toEqual({ id: "weavers" });
  });

  it("returns story_no_title blocker for stories with empty title", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "weavers", title: "" }],
    });
    expect(result.blockers.map((b) => b.code)).toContain("story_no_title");
  });

  it("returns story_no_title blocker for stories with whitespace-only title", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "weavers", title: "   " }],
    });
    expect(result.blockers.map((b) => b.code)).toContain("story_no_title");
  });

  it("does not block for stories with valid titles", () => {
    const result = runPrePublishValidation(validParams);
    expect(result.blockers.map((b) => b.code)).not.toContain("story_no_title");
  });

  it.each(["objects", "project", "glosario", "Weavers", "a b", "a/b", ""])(
    "returns a story_id_refused blocker for the story ID %j",
    (storyId) => {
      const result = runPrePublishValidation({
        ...validParams,
        stories: [{ story_id: storyId, title: "A story", draft: true }],
      });
      const refused = result.blockers.filter((b) => b.code === "story_id_refused");
      expect(refused).toHaveLength(1);
      expect(refused[0].params).toEqual({ id: storyId });
    },
  );

  it("does not block a story ID the framework reads", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "the-river_2", title: "The River" }],
    });
    expect(result.blockers.map((b) => b.code)).not.toContain("story_id_refused");
  });

  it("emits one story_no_title blocker per untitled story, naming each by id", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [
        { story_id: "weavers", title: "The Weavers" },
        { story_id: "untitled-1", title: null },
        { story_id: "untitled-2", title: "" },
      ],
    });
    const storyBlockers = result.blockers.filter((b) => b.code === "story_no_title");
    expect(storyBlockers).toHaveLength(2);
    expect(storyBlockers.map((b) => b.entityId).sort()).toEqual(["untitled-1", "untitled-2"]);
  });

  it("does not block for a draft story with no title (never reaches the published index)", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "draft-story", title: null, draft: true }],
    });
    expect(result.blockers.map((b) => b.code)).not.toContain("story_no_title");
  });

  // An answer whose lines pass the budget the BUILD cuts at blocks the
  // publish. The budget is a constant; a site cannot move it.
  describe("step_answer_over_limit", () => {
    const stepWith = (answer: string, over: Partial<StepForValidation> = {}) => ({
      id: 7,
      step_number: 3,
      object_id: "obj-1",
      x: 0.5,
      y: 0.3,
      zoom: 1.2,
      question: null,
      answer,
      story_id: "weavers",
      story_title: "The Weavers",
      ...over,
    });
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    /** One paragraph of n lines: n words of LINE_CHARS - 1 characters. */
    const lines = (n: number) => Array.from({ length: n }, () => "x".repeat(LINE_CHARS - 1)).join(" ");
    const overLimit = (r: ReturnType<typeof runPrePublishValidation>) =>
      r.blockers.filter((x) => x.code === "step_answer_over_limit");

    it("blocks an answer past the budget, naming step, story, lines and the rule's figures", () => {
      const b = overLimit(runPrePublishValidation({ ...validParams, steps: [stepWith(lines(ANSWER_BUDGET + 1))] }));
      expect(b).toHaveLength(1);
      expect(b[0].entityId).toBe("7");
      expect(b[0].params).toEqual({
        number: "3",
        story: "The Weavers",
        lines: ANSWER_BUDGET + 1,
        count: 1,
        budget: String(ANSWER_BUDGET),
        max_paragraphs: String(MAX_PARAGRAPHS),
        line_chars: String(LINE_CHARS),
        break_lines: String(BREAK_LINES),
      });
    });

    it("blocks six one-word paragraphs, which count under the budget, and passes five", () => {
      const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join("\n\n");
      const run = (n: number) => overLimit(runPrePublishValidation({ ...validParams, steps: [stepWith(paragraphs(n))] }));
      expect(run(5)).toEqual([]);
      expect(run(6)).toHaveLength(1);
      expect(run(6)[0].params).toMatchObject({ lines: 16, count: 6 });
    });

    // The site publishes an answer of exactly the budget in full.
    it("does not block an answer exactly at the budget", () => {
      expect(overLimit(runPrePublishValidation({ ...validParams, steps: [stepWith(lines(ANSWER_BUDGET))] }))).toEqual([]);
    });

    it("counts BREAK_LINES for each paragraph after the first", () => {
      const answer = `${lines(10)}\n\n${lines(7)}`;
      const b = overLimit(runPrePublishValidation({ ...validParams, steps: [stepWith(answer)] }));
      expect(b[0]?.params?.lines).toBe(17 + BREAK_LINES);
    });

    it("counts the characters a glossary link shows", () => {
      const glossary = [{ term_id: "iiif", title: "International Image Interoperability Framework" }];
      const answer = `${lines(ANSWER_BUDGET - 1)} ${"x".repeat(10)} [[iiif]]`;
      const b = overLimit(runPrePublishValidation({ ...validParams, glossary, steps: [stepWith(answer)] }));
      expect(b[0]?.params?.lines).toBe(ANSWER_BUDGET + 1);
    });

    it("counts the answer only, never the question", () => {
      expect(overLimit(runPrePublishValidation({ ...validParams, steps: [stepWith(words(10), { question: words(500) })] }))).toEqual([]);
    });

    it("treats a null answer as no words", () => {
      expect(overLimit(runPrePublishValidation({ ...validParams, steps: [stepWith("", { answer: null })] }))).toEqual([]);
    });

    it("emits one blocker per offending step", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [
          stepWith(lines(ANSWER_BUDGET + 1), { id: 1, step_number: 1 }),
          stepWith(words(10), { id: 2, step_number: 2 }),
          stepWith(lines(ANSWER_BUDGET + 50), { id: 3, step_number: 3 }),
        ],
      });
      expect(overLimit(result)).toHaveLength(2);
    });

    it("names the story by its id when it has no title", () => {
      const result = runPrePublishValidation({ ...validParams, steps: [stepWith(lines(ANSWER_BUDGET + 1), { story_title: "   " })] });
      expect(overLimit(result)[0]?.params?.story).toBe("weavers");
    });

    // Written, the answer is four characters over the budget; published, it is exactly at it.
    it("counts what the build publishes, markup not counted as characters", () => {
      const result = runPrePublishValidation({ ...validParams, steps: [stepWith(`**bold** ${lines(ANSWER_BUDGET).slice(5)}`)] });
      expect(overLimit(result)).toEqual([]);
    });

    // The budget is the only number: there is no recommended length below it.
    it.each([1, 84, 85, 100, 1000])("raises no warning about length at %i words", (n) => {
      const r = runPrePublishValidation({ ...validParams, steps: [stepWith(words(n))] });
      expect(r.warnings.map((x) => x.code).filter((c) => c.startsWith("step_answer_over"))).toEqual([]);
    });
  });

  describe("step_answer_has_image and step_answer_has_embed", () => {
    const stepWith = (answer: string, over: Partial<StepForValidation> = {}) => ({
      id: 7,
      step_number: 3,
      object_id: "obj-1",
      x: 0.5,
      y: 0.3,
      zoom: 1.2,
      question: null,
      answer,
      story_id: "weavers",
      story_title: "The Weavers",
      ...over,
    });
    const codes = (r: ValidationResult) => r.blockers.map((x) => x.code);

    it("blocks an answer holding a markdown image, naming step, story and count", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [stepWith("The loom ![a loom](loom.jpg) at dawn")],
      });
      const b = result.blockers.filter((x) => x.code === "step_answer_has_image");
      expect(b).toHaveLength(1);
      expect(b[0].entityId).toBe("7");
      expect(b[0].params).toEqual({ number: "3", story: "The Weavers", count: 1 });
    });

    it("blocks an answer holding an img tag", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [stepWith('<img src="loom.jpg">')],
      });
      expect(codes(result)).toContain("step_answer_has_image");
    });

    it.each(["iframe", "video", "audio", "embed", "object"])(
      "blocks an answer holding a %s element",
      (tag) => {
        const result = runPrePublishValidation({
          ...validParams,
          steps: [stepWith(`<${tag} src="x"></${tag}>`)],
        });
        const b = result.blockers.filter((x) => x.code === "step_answer_has_embed");
        expect(b).toHaveLength(1);
        expect(b[0].params).toEqual({ number: "3", story: "The Weavers", count: 1 });
      },
    );

    it("carries the count as a number, which is what i18next plurals need", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [stepWith("![one](a.jpg) ![two](b.jpg) ![three](c.jpg)")],
      });
      const b = result.blockers.find((x) => x.code === "step_answer_has_image");
      expect(b?.params?.count).toBe(3);
    });

    it("emits one blocker per kind per step, never one per match", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [stepWith('![a](a.jpg) <img src="b.jpg"> <video src="c"></video>')],
      });
      expect(result.blockers.filter((x) => x.code === "step_answer_has_image")).toHaveLength(1);
      expect(result.blockers.filter((x) => x.code === "step_answer_has_embed")).toHaveLength(1);
    });

    it("leaves a bare image URL and a link alone", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [stepWith("See https://example.org/a.jpg and [a photo](https://example.org/b.jpg)")],
      });
      expect(codes(result)).not.toContain("step_answer_has_image");
      expect(codes(result)).not.toContain("step_answer_has_embed");
    });

    it("treats a null answer as holding nothing", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [stepWith("", { answer: null })],
      });
      expect(codes(result)).not.toContain("step_answer_has_image");
      expect(codes(result)).not.toContain("step_answer_has_embed");
    });

    it("emits one blocker per offending step", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [
          stepWith("![a](a.jpg)", { id: 1, step_number: 1 }),
          stepWith("plain prose", { id: 2, step_number: 2 }),
          stepWith('<img src="c.jpg">', { id: 3, step_number: 3 }),
        ],
      });
      expect(result.blockers.filter((x) => x.code === "step_answer_has_image")).toHaveLength(2);
    });

    it("names the story by its id when it has no title", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [stepWith("![a](a.jpg)", { story_title: "   " })],
      });
      expect(
        result.blockers.find((x) => x.code === "step_answer_has_image")?.params?.story,
      ).toBe("weavers");
    });

    it("looks at the answer only, never the question", () => {
      const result = runPrePublishValidation({
        ...validParams,
        steps: [stepWith("plain prose", { question: "![a](a.jpg)" })],
      });
      expect(codes(result)).not.toContain("step_answer_has_image");
    });
  });

  describe("the answer's other blocked kinds and its formatting warning", () => {
    const stepWith = (answer: string, over: Partial<StepForValidation> = {}) => ({
      id: 7,
      step_number: 3,
      object_id: "obj-1",
      x: 0.5,
      y: 0.3,
      zoom: 1.2,
      question: null,
      answer,
      story_id: "weavers",
      story_title: "The Weavers",
      ...over,
    });
    const check = (answer: string, over: Partial<StepForValidation> = {}) =>
      runPrePublishValidation({ ...validParams, steps: [stepWith(answer, over)] });
    const blocker = (r: ValidationResult, code: string) =>
      r.blockers.find((x) => x.code === code);
    const warning = (r: ValidationResult, code: string) =>
      r.warnings.find((x) => x.code === code);

    it("blocks a footnote, counting a reference and its definition as one each", () => {
      const r = check("A claim[^1].\n\n[^1]: The source\n");
      const b = blocker(r, "step_answer_has_footnote");
      expect(b?.entityId).toBe("7");
      expect(b?.params).toEqual({ number: "3", story: "The Weavers", count: 2 });
    });

    // With no definition the build publishes the reference as the text it is.
    it("does not block a footnote reference with no definition", () => {
      expect(blocker(check("A claim[^1] stands."), "step_answer_has_footnote")).toBeUndefined();
    });

    it("blocks a table", () => {
      const r = check("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
      expect(blocker(r, "step_answer_has_table")?.params).toEqual({
        number: "3",
        story: "The Weavers",
        count: 1,
      });
    });

    it("blocks two tables with a count of two", () => {
      const two = "| a |\n| --- |\n\nProse\n\n| b |\n| --- |\n";
      expect(blocker(check(two), "step_answer_has_table")?.params?.count).toBe(2);
    });

    it("blocks a fenced code block", () => {
      const r = check("Before\n```js\nconst a = 1;\n```\nAfter");
      expect(blocker(r, "step_answer_has_code_block")?.params).toEqual({
        number: "3",
        story: "The Weavers",
        count: 1,
      });
    });

    it("blocks a widget", () => {
      const r = check("Before.\n\n:::glossary\nentry: carta\nalign: left\n:::\n\nAfter.");
      expect(blocker(r, "step_answer_has_widget")?.params).toEqual({
        number: "3",
        story: "The Weavers",
        count: 1,
      });
    });

    it("blocks a carousel as one widget, and not as the images or rules inside it", () => {
      const r = check(
        "Before.\n\n:::carousel\nimage: a.jpg\ncaption: ![a](a.jpg)\n---\nimage: b.jpg\n:::\nAfter.",
      );
      expect(r.blockers.map((x) => x.code)).toEqual(["step_answer_has_widget"]);
      expect(r.warnings.map((x) => x.code)).not.toContain("step_answer_has_formatting");
    });

    it("blocks two widgets with a count of two", () => {
      const two = ":::glossary\nentry: carta\n:::\n\nProse\n\n:::glossary\nentry: telar\n:::\n";
      expect(blocker(check(two), "step_answer_has_widget")?.params?.count).toBe(2);
    });

    it("does not block a widget line with no closing line, which the build keeps as text", () => {
      const r = check("Before.\n\n:::glossary\nentry: carta\n\nAfter.");
      expect(blocker(r, "step_answer_has_widget")).toBeUndefined();
    });

    it("carries every count as a number, which is what i18next plurals need", () => {
      const r = check("```\nx\n```\n\n```\ny\n```\n");
      expect(blocker(r, "step_answer_has_code_block")?.params?.count).toBe(2);
    });

    it("warns, and never blocks, on a kind the build only flattens", () => {
      const r = check("# Title\n- one\n- two");
      expect(r.blockers.map((x) => x.code)).not.toContain("step_answer_has_formatting");
      expect(r.blockers).toHaveLength(0);
      expect(warning(r, "step_answer_has_formatting")?.params).toEqual({
        number: "3",
        story: "The Weavers",
        kinds: ["list", "heading"],
      });
    });

    it("names one kind when only one is present", () => {
      const r = check("> A quoted line");
      expect(warning(r, "step_answer_has_formatting")?.params?.kinds).toEqual(["blockquote"]);
    });

    it("names the kinds in one fixed order however they fall in the answer", () => {
      const r = check("---\n\n> quoted\n\n## Title\n\n- item");
      expect(warning(r, "step_answer_has_formatting")?.params?.kinds).toEqual([
        "list",
        "heading",
        "blockquote",
        "rule",
      ]);
    });

    it("warns about a horizontal rule, which the build removes but which holds no words", () => {
      const r = check("Before\n\n---\n\nAfter");
      expect(r.blockers).toHaveLength(0);
      expect(warning(r, "step_answer_has_formatting")?.params?.kinds).toEqual(["rule"]);
    });

    it("emits no warning for an answer with no formatting at all", () => {
      expect(warning(check("The weavers worked at dawn."), "step_answer_has_formatting"))
        .toBeUndefined();
    });

    it("emits the blockers and the warning together when an answer has both", () => {
      const r = check("# Title\n\n![a](a.jpg)\n\n| a |\n| --- |\n");
      expect(r.blockers.map((x) => x.code).sort()).toEqual([
        "step_answer_has_image",
        "step_answer_has_table",
      ]);
      expect(warning(r, "step_answer_has_formatting")?.params?.kinds).toEqual(["heading"]);
    });

    it("emits one warning per step, not one per kind", () => {
      const r = runPrePublishValidation({
        ...validParams,
        steps: [
          stepWith("# One\n- item", { id: 1, step_number: 1 }),
          stepWith("plain prose", { id: 2, step_number: 2 }),
          stepWith("> quoted", { id: 3, step_number: 3 }),
        ],
      });
      expect(r.warnings.filter((x) => x.code === "step_answer_has_formatting")).toHaveLength(2);
    });

    it("counts the length after the rules, so a bulleted answer is its words", () => {
      const r = runPrePublishValidation({
        ...validParams,
        steps: [stepWith("- one\n- two\n- three")],
      });
      expect(r.blockers.map((x) => x.code)).not.toContain("step_answer_over_limit");
    });
  });

  // private_story_no_key is a WARNING (never a blocker): a private story with no
  // site-wide story key would fail the published build on Telar >=1.6, but we
  // let the publish proceed and name the offending stories.
  it("warns when a private story has no story key, naming the story", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "weavers", title: "The Weavers", private: true }],
      storyKey: null,
    });
    const warning = result.warnings.find((w) => w.code === "private_story_no_key");
    expect(warning).toBeDefined();
    expect(warning?.params?.stories).toBe("The Weavers");
    // Advisory only — must never gate the publish.
    expect(result.blockers.map((b) => b.code)).not.toContain("private_story_no_key");
  });

  it("names all private stories, falling back to story_id when title is missing", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [
        { story_id: "weavers", title: "The Weavers", private: true },
        { story_id: "untitled-priv", title: null, private: true },
        { story_id: "public-one", title: "Public", private: false },
      ],
      storyKey: "",
    });
    const warning = result.warnings.find((w) => w.code === "private_story_no_key");
    expect(warning?.params?.stories).toBe("The Weavers, untitled-priv");
  });

  it("does not warn when a story key is set, even with private stories", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "weavers", title: "The Weavers", private: true }],
      storyKey: "s3cret",
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("private_story_no_key");
  });

  it("does not warn when there are no private stories, even with no key", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "weavers", title: "The Weavers", private: false }],
      storyKey: null,
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("private_story_no_key");
  });

  it("does not warn for a private story that is a draft", () => {
    // Drafts never reach the published stories index (orphans-are-drafts), so
    // the framework's interlock cannot fail the build on their account.
    const result = runPrePublishValidation({
      ...validParams,
      stories: [
        { story_id: "wip", title: "Work in Progress", private: true, draft: true },
      ],
      storyKey: null,
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("private_story_no_key");
  });

  it("still warns when private stories mix drafts and non-drafts, naming only the non-drafts", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [
        { story_id: "wip", title: "Work in Progress", private: true, draft: true },
        { story_id: "weavers", title: "The Weavers", private: true, draft: false },
      ],
      storyKey: null,
    });
    const warning = result.warnings.find((w) => w.code === "private_story_no_key");
    expect(warning?.params?.stories).toBe("The Weavers");
  });

  it("treats a whitespace-only story key as unset", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "weavers", title: "The Weavers", private: true }],
      storyKey: "   ",
    });
    expect(result.warnings.map((w) => w.code)).toContain("private_story_no_key");
  });

  // private_story_workflow_stale is the sibling of private_story_no_key: the
  // framework's second prerequisite for a private story is a build.yml that
  // runs the encryption step. It is a warning, never a blocker.
  const WORKFLOW_WITH_MARKER = [
    "      - name: Encrypt protected stories",
    "        run: python3 scripts/encrypt_protected_stories.py",
  ].join("\n");

  const privateStories = [
    { story_id: "weavers", title: "The Weavers", private: true, draft: false },
    { story_id: "untitled-priv", title: null, private: true, draft: false },
    { story_id: "public-one", title: "Public", private: false, draft: false },
  ];

  it("does not warn when build.yml reads ok and runs the encrypt step", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: privateStories,
      storyKey: "s3cret",
      buildWorkflow: { status: "ok", content: WORKFLOW_WITH_MARKER },
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("private_story_workflow_stale");
  });

  it("warns when build.yml reads ok without the encrypt step, naming the private non-draft stories", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: privateStories,
      storyKey: "s3cret",
      buildWorkflow: { status: "ok", content: "jobs:\n  build:\n    runs-on: ubuntu-latest\n" },
    });
    const warning = result.warnings.find((w) => w.code === "private_story_workflow_stale");
    expect(warning).toBeDefined();
    expect(warning?.params?.stories).toBe("The Weavers, untitled-priv");
    // Advisory only — the framework refuses the build; the compositor must not
    // hold every other publish behind a file it cannot always fix.
    expect(result.blockers.map((b) => b.code)).not.toContain("private_story_workflow_stale");
  });

  it("warns when build.yml reads ok but is empty", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: privateStories,
      storyKey: "s3cret",
      buildWorkflow: { status: "ok", content: "" },
    });
    expect(result.warnings.map((w) => w.code)).toContain("private_story_workflow_stale");
  });

  it("warns when build.yml is absent, the state the framework also fails in", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: privateStories,
      storyKey: "s3cret",
      buildWorkflow: { status: "absent" },
    });
    expect(result.warnings.map((w) => w.code)).toContain("private_story_workflow_stale");
  });

  it("does not warn when the build.yml read errored — the state is indeterminate", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: privateStories,
      storyKey: "s3cret",
      buildWorkflow: { status: "error" },
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("private_story_workflow_stale");
  });

  it("does not warn when build.yml was not read at all", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: privateStories,
      storyKey: "s3cret",
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("private_story_workflow_stale");
  });

  it("does not warn when every private story is a draft, even with build.yml absent", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: [{ story_id: "wip", title: "Work in Progress", private: true, draft: true }],
      storyKey: "s3cret",
      buildWorkflow: { status: "absent" },
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("private_story_workflow_stale");
  });

  it("emits both prerequisite warnings over the same story list when key and step are both missing", () => {
    const result = runPrePublishValidation({
      ...validParams,
      stories: privateStories,
      storyKey: null,
      buildWorkflow: { status: "absent" },
    });
    const noKey = result.warnings.find((w) => w.code === "private_story_no_key");
    const stale = result.warnings.find((w) => w.code === "private_story_workflow_stale");
    expect(noKey?.params?.stories).toBe("The Weavers, untitled-priv");
    expect(stale?.params?.stories).toBe(noKey?.params?.stories);
  });
});

// ---------------------------------------------------------------------------
// buildYmlRunsEncryptStep
// ---------------------------------------------------------------------------

describe("buildYmlRunsEncryptStep", () => {
  it("accepts a workflow that runs the encryption script", () => {
    expect(
      buildYmlRunsEncryptStep("        run: python3 scripts/encrypt_protected_stories.py\n"),
    ).toBe(true);
  });

  it("counts the marker inside a commented-out line, which is the framework's rule", () => {
    // The framework's check is `ENCRYPT_SCRIPT_MARKER not in workflow_text`, so
    // a commented marker satisfies it. The compositor mirrors that gate exactly
    // rather than being stricter: it must never warn on a file the framework
    // accepts.
    expect(
      buildYmlRunsEncryptStep("        # run: python3 scripts/encrypt_protected_stories.py\n"),
    ).toBe(true);
  });

  it("rejects a workflow with no mention of the script", () => {
    expect(buildYmlRunsEncryptStep("jobs:\n  build:\n    runs-on: ubuntu-latest\n")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(buildYmlRunsEncryptStep("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeChangeSummary — per-field config diff
// ---------------------------------------------------------------------------

describe("computeChangeSummary — per-field config diff", () => {
  // Minimal fixture: only the fields the diff cares about. Stories/objects
  // arrays are empty so they don't contaminate the assertions.
  const baseLandingHash = JSON.stringify({ stories_heading: "Stories" });

  function makeState(configOverrides: Partial<ProjectConfigRow>): CurrentPublishState {
    const config = makeConfig(configOverrides);
    return {
      entityHashes: {
        version: ENTITY_HASHES_VERSION,
        pages: {},
        stories: {},
        objects: {},
        glossary: {},
        navigation: "",
        landing: baseLandingHash,
        settings: JSON.stringify(buildConfigManagedFieldsForTest(config)),
        objectOrder: "",
      },
      config,
      stories: [],
      objects: [],
      pages: [],
      glossary: [],
      allStoryIds: [],
    };
  }

  // Local helper that mirrors buildConfigManagedFields without re-exporting it
  // — keeps fixtures readable and avoids hand-formatting quoted strings.
  function buildConfigManagedFieldsForTest(c: ProjectConfigRow): Record<string, string> {
    return buildConfigManagedFields(c);
  }

  function makeSnapshot(configOverrides: Partial<ProjectConfigRow>): PublishSnapshot {
    const config = makeConfig(configOverrides);
    const managed = buildConfigChangeFields(config);
    return {
      story_ids: [],
      object_ids: [],
      config_hash: JSON.stringify(managed),
      config_managed: managed,
      landing_hash: baseLandingHash,
    };
  }

  it("title-only change emits a single 'title' entry", () => {
    const current = makeState({ title: "New" });
    const snapshot = makeSnapshot({ title: "Old" });
    const summary = computeChangeSummary(current, snapshot);
    expect(summary.settings.changed).toHaveLength(1);
    expect(summary.settings.changed[0].key).toBe("title");
  });

  it("lang-only change emits 'lang' entry with post-change value as label", () => {
    const current = makeState({ lang: "es" });
    const snapshot = makeSnapshot({ lang: "en" });
    const summary = computeChangeSummary(current, snapshot);
    expect(summary.settings.changed).toHaveLength(1);
    expect(summary.settings.changed[0].key).toBe("lang");
    // Label carries post-change value so the route helper can resolve
    // target-language commit-message keys without needing the full config.
    expect(summary.settings.changed[0].label).toBe("es");
  });

  it("multi-field change (title + lang) emits both entries", () => {
    const current = makeState({ title: "New", lang: "es" });
    const snapshot = makeSnapshot({ title: "Old", lang: "en" });
    const summary = computeChangeSummary(current, snapshot);
    expect(summary.settings.changed).toHaveLength(2);
    const keys = new Set(summary.settings.changed.map((e) => e.key));
    expect(keys).toEqual(new Set(["title", "lang"]));
  });

  it("no change produces an empty settings.changed array", () => {
    const current = makeState({ title: "Same", lang: "en" });
    const snapshot = makeSnapshot({ title: "Same", lang: "en" });
    const summary = computeChangeSummary(current, snapshot);
    expect(summary.settings.changed).toHaveLength(0);
  });

  it("first publish (snapshot===null) emits a single 'all' entry", () => {
    const current = makeState({ title: "Whatever" });
    const summary = computeChangeSummary(current, null);
    expect(summary.settings.changed).toHaveLength(1);
    expect(summary.settings.changed[0].key).toBe("all");
  });

  it("collection_mode change is detected (was silently dropped pre-fix)", () => {
    const current = makeState({ collection_mode: true });
    const snapshot = makeSnapshot({ collection_mode: false });
    const summary = computeChangeSummary(current, snapshot);
    expect(summary.settings.changed).toHaveLength(1);
    expect(summary.settings.changed[0].key).toBe("collection_mode");
  });

  // Review-modal humanization: collection_mode label carries
  // the post-change value as "on"/"off" so the renderer can pick a
  // value-specific i18n string (change_collection_mode_on/off), mirror
  // of how lang threads "en"/"es".
  it("collection_mode false→true labels the change as 'on'", () => {
    const current = makeState({ collection_mode: true });
    const snapshot = makeSnapshot({ collection_mode: false });
    const summary = computeChangeSummary(current, snapshot);
    const entry = summary.settings.changed.find((e) => e.key === "collection_mode");
    expect(entry?.label).toBe("on");
  });

  it("collection_mode true→false labels the change as 'off'", () => {
    const current = makeState({ collection_mode: false });
    const snapshot = makeSnapshot({ collection_mode: true });
    const summary = computeChangeSummary(current, snapshot);
    const entry = summary.settings.changed.find((e) => e.key === "collection_mode");
    expect(entry?.label).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// pageRowsToCommitFiles — empty-slug guard
// ---------------------------------------------------------------------------

describe("pageRowsToCommitFiles — empty-slug guard", () => {
  it("empty-slug row produces no commit file", async () => {
    const files = await pageRowsToCommitFiles([{ title: "Untitled", slug: "", body: "" }]);
    expect(files).toHaveLength(0);
  });

  it("null-slug row produces no commit file", async () => {
    const files = await pageRowsToCommitFiles([
      { title: "Untitled", slug: null as unknown as string, body: "" },
    ]);
    expect(files).toHaveLength(0);
  });

  it("whitespace-only-slug row produces no commit file", async () => {
    const files = await pageRowsToCommitFiles([{ title: "Untitled", slug: "   ", body: "" }]);
    expect(files).toHaveLength(0);
  });

  it("valid-slug row produces exactly one commit file at the expected path", async () => {
    const files = await pageRowsToCommitFiles([
      { title: "About", slug: "about", body: "Welcome." },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("telar-content/texts/pages/about.md");
    expect(files[0].content).toContain('title: "About"');
    expect(files[0].content).toContain("Welcome.");
  });

  it("mixed input emits one file for the valid row only", async () => {
    const files = await pageRowsToCommitFiles([
      { title: "About", slug: "about", body: "Welcome." },
      { title: "Untitled", slug: "", body: "" },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("telar-content/texts/pages/about.md");
  });

  // The actual regression: editor auto-derives a slug like `untitled` when
  // the title is empty, so the original empty-slug check never fires for
  // these rows. Discovered during late UAT (2026-05-10) — the empty-
  // title page surfaced as "New" in the Review modal and got past Checks.
  it("auto-slugged empty-title row (slug=untitled) produces no commit file", async () => {
    const files = await pageRowsToCommitFiles([{ title: "", slug: "untitled", body: "" }]);
    expect(files).toHaveLength(0);
  });

  it("auto-slugged null-title row produces no commit file", async () => {
    const files = await pageRowsToCommitFiles([
      { title: null as unknown as string, slug: "untitled-3", body: "" },
    ]);
    expect(files).toHaveLength(0);
  });

  it("whitespace-only-title row produces no commit file", async () => {
    const files = await pageRowsToCommitFiles([{ title: "   ", slug: "untitled", body: "x" }]);
    expect(files).toHaveLength(0);
  });
});

// isPagePublishable — single source of truth used by
// pageRowsToCommitFiles AND buildPageContentHashes so both surfaces
// (commit emission + entity-hashing diff) treat the same rows as
// "ready to publish".
describe("isPagePublishable", () => {
  it("returns false for null title", () => {
    expect(isPagePublishable({ title: null, slug: "about" })).toBe(false);
  });

  it("returns false for empty title", () => {
    expect(isPagePublishable({ title: "", slug: "about" })).toBe(false);
  });

  it("returns false for whitespace-only title", () => {
    expect(isPagePublishable({ title: "   ", slug: "about" })).toBe(false);
  });

  it("returns false for null slug", () => {
    expect(isPagePublishable({ title: "About", slug: null })).toBe(false);
  });

  it("returns false for empty slug", () => {
    expect(isPagePublishable({ title: "About", slug: "" })).toBe(false);
  });

  it("returns true when both title and slug are populated", () => {
    expect(isPagePublishable({ title: "About", slug: "about" })).toBe(true);
  });
});

// buildPageContentHashes shares the same skip rule so the
// entity-hashing diff cannot disagree with the commit file set — an
// empty-title page must not appear in the hashes (otherwise it would
// surface as "New" in the change-review modal even though no file is
// being committed).
describe("buildPageContentHashes — empty-title guard", () => {
  it("excludes empty-title pages from hashes (auto-slug=untitled regression)", () => {
    const hashes = buildPageContentHashes([
      { title: "", slug: "untitled", body: "" },
      { title: "About", slug: "about", body: "Welcome." },
    ]);
    expect(Object.keys(hashes)).toEqual(["about"]);
  });

  it("excludes empty-slug pages from hashes (legacy guard preserved)", () => {
    const hashes = buildPageContentHashes([{ title: "Untitled", slug: "", body: "" }]);
    expect(hashes).toEqual({});
  });

  it("includes a fully populated page", () => {
    const hashes = buildPageContentHashes([
      { title: "About", slug: "about", body: "Welcome." },
    ]);
    expect(Object.keys(hashes)).toEqual(["about"]);
    expect(hashes.about).toContain('"title":"About"');
    expect(hashes.about).toContain('"slug":"about"');
  });
});

// ---------------------------------------------------------------------------
// Publish-time defensive gate against v1.2.1 English literals
// ---------------------------------------------------------------------------
//
// Each test dynamically imports `V121_FRONTMATTER_DEFAULTS` and
// `V121_BODIES` from `~/lib/v130-ingest.server`, plus `buildIndexMd`
// from `~/lib/publish.server`.
// ---------------------------------------------------------------------------

interface PublishServerWithBuildIndexMd {
  buildIndexMd: (landing: {
    stories_heading: string | null;
    stories_intro: string | null;
    objects_heading: string | null;
    objects_intro: string | null;
    welcome_body: string | null;
  }) => string;
}

async function loadV130Defaults() {
  const mod = (await import("~/lib/v130-ingest.server")) as {
    V121_FRONTMATTER_DEFAULTS: {
      stories_heading: string;
      objects_heading: string;
      objects_intro: string;
    };
    V121_BODIES: { index: string };
  };
  return mod;
}

async function loadBuildIndexMd() {
  const mod = (await import("~/lib/publish.server")) as unknown as PublishServerWithBuildIndexMd;
  return mod.buildIndexMd;
}

describe("publish defensive gate", () => {
  it("omits stories_heading when value matches V121_FRONTMATTER_DEFAULTS literal", async () => {
    const { V121_FRONTMATTER_DEFAULTS } = await loadV130Defaults();
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: V121_FRONTMATTER_DEFAULTS.stories_heading,
      stories_intro: null,
      objects_heading: null,
      objects_intro: null,
      welcome_body: null,
    });
    expect(out).not.toMatch(
      new RegExp(`stories_heading:\\s*"?${V121_FRONTMATTER_DEFAULTS.stories_heading}"?`),
    );
  });

  it("emits stories_heading when value is user-customised", async () => {
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: "My Stories",
      stories_intro: null,
      objects_heading: null,
      objects_intro: null,
      welcome_body: null,
    });
    expect(out).toMatch(/stories_heading:\s*"My Stories"/);
  });

  it("omits objects_heading when value matches V121_FRONTMATTER_DEFAULTS literal", async () => {
    const { V121_FRONTMATTER_DEFAULTS } = await loadV130Defaults();
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: null,
      stories_intro: null,
      objects_heading: V121_FRONTMATTER_DEFAULTS.objects_heading,
      objects_intro: null,
      welcome_body: null,
    });
    expect(out).not.toMatch(
      new RegExp(`objects_heading:\\s*"?${V121_FRONTMATTER_DEFAULTS.objects_heading}"?`),
    );
  });

  it("emits objects_heading when value is user-customised", async () => {
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: null,
      stories_intro: null,
      objects_heading: "Featured Items",
      objects_intro: null,
      welcome_body: null,
    });
    expect(out).toMatch(/objects_heading:\s*"Featured Items"/);
  });

  it("omits objects_intro when value matches V121_FRONTMATTER_DEFAULTS literal", async () => {
    const { V121_FRONTMATTER_DEFAULTS } = await loadV130Defaults();
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: null,
      stories_intro: null,
      objects_heading: null,
      objects_intro: V121_FRONTMATTER_DEFAULTS.objects_intro,
      welcome_body: null,
    });
    // Pinned literal contains `{count}` — escape for regex
    const escaped = V121_FRONTMATTER_DEFAULTS.objects_intro.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    expect(out).not.toMatch(new RegExp(`objects_intro:\\s*"?${escaped}"?`));
  });

  it("emits objects_intro when value is user-customised", async () => {
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: null,
      stories_intro: null,
      objects_heading: null,
      objects_intro: "User-customised intro.",
      welcome_body: null,
    });
    expect(out).toMatch(/objects_intro:\s*"User-customised intro\."/);
  });

  it("welcome_body falls back to parsed body when matches V121_BODIES.index", async () => {
    const { V121_BODIES } = await loadV130Defaults();
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: null,
      stories_intro: null,
      objects_heading: null,
      objects_intro: null,
      welcome_body: V121_BODIES.index,
    });
    // Defensive gate: V121 default body is dropped (output omits it)
    expect(out).not.toContain("Welcome to the Telar Demo Site");
  });

  it("welcome_body uses landing.welcome_body when customised", async () => {
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: null,
      stories_intro: null,
      objects_heading: null,
      objects_intro: null,
      welcome_body: "# My Custom Welcome\n\nUser-edited content.",
    });
    expect(out).toContain("# My Custom Welcome");
  });
});

// ---------------------------------------------------------------------------
// Drafts round-trip + hard-delete cleanup
// ---------------------------------------------------------------------------
//
// The drafts/hard-delete contract introduces two pipeline behaviours:
//   1. {story_id}.csv files are emitted for ALL D1 stories — draft + non-draft
//      project.csv continues to exclude drafts, but the per-story
//      files now round-trip draft state via the "orphans-are-drafts" rule.
//   2. Stories hard-deleted from D1 since the last publish produce deletion
//      entries for commitFilesToRepo's deletions[] parameter.
//   3. Re-publishing without any D1 change emits zero deletions and zero file
//      writes (idempotency).
//
// The first contract is locked here via the pure helper `storyPathsForPublish`,
// extracted from buildPublishFileSet's file-set assembly site. The second/third
// contracts are locked via `computeStoryDeletions`. The project.csv-excludes-
// drafts invariant continues to be locked by the existing serializeProjectCsv
// tests above ("omits draft stories entirely") which act as the regression
// guard against accidentally widening the project.csv membership.

describe("drafts round-trip + hard-delete cleanup", () => {
  describe("storyPathsForPublish", () => {
    it("emits telar-content/spreadsheets/{id}.csv for both draft and non-draft stories", () => {
      const paths = storyPathsForPublish([
        { story_id: "weavers", draft: false },
        { story_id: "secret-draft", draft: true },
      ]);
      expect(paths).toContain("telar-content/spreadsheets/weavers.csv");
      expect(paths).toContain("telar-content/spreadsheets/secret-draft.csv");
    });

    it("returns one path per story regardless of draft flag (file-set parity)", () => {
      // Three stories — one draft. All three must produce a file path. This
      // is the contract that lets the importer recover drafts via the
      // orphans-are-drafts rule.
      const paths = storyPathsForPublish([
        { story_id: "a", draft: false },
        { story_id: "b", draft: true },
        { story_id: "c", draft: false },
      ]);
      expect(paths).toHaveLength(3);
      expect(paths).toEqual([
        "telar-content/spreadsheets/a.csv",
        "telar-content/spreadsheets/b.csv",
        "telar-content/spreadsheets/c.csv",
      ]);
    });
  });

  describe("computeStoryDeletions", () => {
    const baseSnapshot: PublishSnapshot = {
      story_ids: ["a", "b", "c"],
      object_ids: [],
      config_hash: "",
      landing_hash: "",
    };

    it("emits a deletion entry for a story removed from D1 since the last publish", () => {
      // Prior publish wrote files for [a, b, c]; current D1 has [a, b]; c was
      // hard-deleted → its file must be deleted on this publish.
      const deletions = computeStoryDeletions(["a", "b"], baseSnapshot);
      expect(deletions).toEqual(["telar-content/spreadsheets/c.csv"]);
    });

    it("emits multiple deletion entries when several stories were hard-deleted", () => {
      const deletions = computeStoryDeletions(["a"], baseSnapshot);
      expect(deletions).toEqual([
        "telar-content/spreadsheets/b.csv",
        "telar-content/spreadsheets/c.csv",
      ]);
    });

    it("does NOT emit a deletion when a story is toggled to draft but remains in D1", () => {
      // The draft is still in D1 — its row just isn't in project.csv. The
      // {story_id}.csv file is still written (per storyPathsForPublish), so no
      // deletion. This is the "orphans-are-drafts" contract: only the absence
      // of the file from publish output indicates a hard-delete.
      const deletions = computeStoryDeletions(["a", "b", "c"], baseSnapshot);
      expect(deletions).toEqual([]);
    });

    it("emits zero deletions when the snapshot is null (first publish)", () => {
      // No prior snapshot ⇒ nothing has ever been published ⇒ nothing to
      // delete. Without this guard, a first-publish would incorrectly try to
      // delete files that don't exist on GitHub.
      const deletions = computeStoryDeletions(["a", "b"], null);
      expect(deletions).toEqual([]);
    });

    it("emits zero deletions when D1 state matches the snapshot exactly (idempotency)", () => {
      // Re-publishing without any D1 change must produce no deletions. The
      // entity-hashing diff already guarantees no file writes (no story
      // bucket changes → no per-story file re-emission); this guarantees the
      // deletion side is equally idempotent.
      const deletions = computeStoryDeletions(["a", "b", "c"], baseSnapshot);
      expect(deletions).toEqual([]);
    });

    it("treats snapshots written before story_ids tracking as no-op (missing-field back-compat)", () => {
      // snapshot.story_ids has been populated since an earlier release, but the field is
      // typed `string[]` not `string[] | undefined` — the type system would
      // catch a missing one. We exercise the empty-array path explicitly here
      // so an empty prior snapshot doesn't accidentally claim everything was
      // deleted on the next publish.
      const emptySnapshot: PublishSnapshot = {
        ...baseSnapshot,
        story_ids: [],
      };
      const deletions = computeStoryDeletions(["a", "b"], emptySnapshot);
      expect(deletions).toEqual([]);
    });
  });

  describe("computePageDeletions", () => {
    const baseSnapshot: PublishSnapshot = {
      story_ids: [],
      object_ids: [],
      page_slugs: ["about", "team"],
      config_hash: "",
      landing_hash: "",
    };

    it("emits a deletion for a page slug removed/renamed since the last publish", () => {
      // Prior publish wrote about.md + team.md; current committable slugs are
      // [about, crew] (team renamed to crew) → team.md must be deleted so the
      // stale page does not linger live.
      const deletions = computePageDeletions(["about", "crew"], baseSnapshot);
      expect(deletions).toEqual(["telar-content/texts/pages/team.md"]);
    });

    it("emits zero deletions when the current slugs still contain all prior slugs", () => {
      const deletions = computePageDeletions(["about", "team", "extra"], baseSnapshot);
      expect(deletions).toEqual([]);
    });

    it("emits zero deletions when the snapshot is null (first publish)", () => {
      const deletions = computePageDeletions(["about"], null);
      expect(deletions).toEqual([]);
    });

    it("treats a snapshot predating page_slugs tracking as a no-op (back-compat)", () => {
      // Old snapshots have no page_slugs field (it is optional). A missing/empty
      // prior set must not claim every current page was deleted.
      const noPagesSnapshot: PublishSnapshot = { ...baseSnapshot, page_slugs: undefined };
      expect(computePageDeletions(["about", "team"], noPagesSnapshot)).toEqual([]);
      const emptyPagesSnapshot: PublishSnapshot = { ...baseSnapshot, page_slugs: [] };
      expect(computePageDeletions(["about", "team"], emptyPagesSnapshot)).toEqual([]);
    });
  });

  describe("computeChangeSummary fileChanges (45-01.1-HOTFIX)", () => {
    // Minimal helpers — local to this describe so they don't disturb the
    // existing computeChangeSummary fixtures above. The publishable-view
    // arrays (stories/objects/pages/glossary) are kept empty unless a test
    // explicitly populates `stories` (non-drafts) to exercise the dedup
    // path against storiesDiff.{new,deleted}.
    function makeEH(stories: Record<string, string> = {}): EntityHashes {
      return {
        version: ENTITY_HASHES_VERSION,
        pages: {},
        stories,
        objects: {},
        glossary: {},
        navigation: "",
        landing: "",
        settings: "",
        objectOrder: "",
      };
    }

    function makeState(opts: {
      allStoryIds: string[];
      stories?: { story_id: string; title: string | null }[];
      storyHashes?: Record<string, string>;
    }): CurrentPublishState {
      return {
        entityHashes: makeEH(opts.storyHashes ?? {}),
        config: null,
        stories: opts.stories ?? [],
        objects: [],
        pages: [],
        glossary: [],
        allStoryIds: opts.allStoryIds,
      };
    }

    function makeSnap(opts: {
      story_ids?: string[];
      all_story_ids?: string[];
      storyHashes?: Record<string, string>;
    }): PublishSnapshot {
      return {
        story_ids: opts.story_ids ?? [],
        all_story_ids: opts.all_story_ids,
        object_ids: [],
        config_hash: JSON.stringify({}),
        config_managed: {},
        landing_hash: "",
        entity_hashes: makeEH(opts.storyHashes ?? {}),
      };
    }

    it("Case B fix: hard-delete of an always-draft surfaces in fileChanges.removedStoryFiles and flips isUpToDate", () => {
      // Prior publish: snapshot tracked both `a` (non-draft) and `b-draft`
      // (always-draft). Current D1: only `a` exists; `b-draft` was hard-deleted.
      // The publishable view (storiesDiff) cannot see this — `b-draft` was
      // never in story_ids — so without fileChanges the Review modal would
      // claim "up to date" while a stale draft file lingers on GitHub.
      const snapshot = makeSnap({
        story_ids: ["a"],
        all_story_ids: ["a", "b-draft"],
        storyHashes: { a: "h-a" },
      });
      const state = makeState({
        allStoryIds: ["a"],
        stories: [{ story_id: "a", title: "A" }],
        storyHashes: { a: "h-a" },
      });
      const summary = computeChangeSummary(state, snapshot);
      expect(summary.stories.deleted).toEqual([]);
      expect(summary.fileChanges.addedStoryFiles).toEqual([]);
      expect(summary.fileChanges.removedStoryFiles).toEqual(["b-draft"]);
      expect(summary.isUpToDate).toBe(false);
    });

    it("symmetric: a new draft created since last publish surfaces in fileChanges.addedStoryFiles and flips isUpToDate", () => {
      // Snapshot tracks only `a`. Current D1 has `a` plus a new draft. The
      // publishable view doesn't see the draft — fileChanges must.
      const snapshot = makeSnap({
        story_ids: ["a"],
        all_story_ids: ["a"],
        storyHashes: { a: "h-a" },
      });
      const state = makeState({
        allStoryIds: ["a", "new-draft"],
        stories: [{ story_id: "a", title: "A" }],
        storyHashes: { a: "h-a" },
      });
      const summary = computeChangeSummary(state, snapshot);
      expect(summary.stories.new).toEqual([]);
      expect(summary.fileChanges.addedStoryFiles).toEqual(["new-draft"]);
      expect(summary.fileChanges.removedStoryFiles).toEqual([]);
      expect(summary.isUpToDate).toBe(false);
    });

    it("non-draft hard-delete is not double-rendered: shows in storiesDiff.deleted only", () => {
      // `b` was a non-draft in the prior publish. Hard-deleted since.
      // storiesDiff.deleted carries it; fileChanges must dedup it out.
      const snapshot = makeSnap({
        story_ids: ["a", "b"],
        all_story_ids: ["a", "b"],
        storyHashes: { a: "h-a", b: "h-b" },
      });
      const state = makeState({
        allStoryIds: ["a"],
        stories: [{ story_id: "a", title: "A" }],
        storyHashes: { a: "h-a" },
      });
      const summary = computeChangeSummary(state, snapshot);
      expect(summary.stories.deleted.map((s) => s.story_id)).toEqual(["b"]);
      expect(summary.fileChanges.addedStoryFiles).toEqual([]);
      expect(summary.fileChanges.removedStoryFiles).toEqual([]);
      expect(summary.isUpToDate).toBe(false);
    });

    it("toggling non-draft to draft leaves no fileChanges entry (story still has a file)", () => {
      // `b` was a non-draft in the prior publish and is now toggled to draft —
      // its row still exists in D1 (still in allStoryIds), and its file is
      // still written on this publish. No fileChanges entry either side.
      // The publishable view will flag `b` as deleted (gone from non-draft
      // stories), but fileChanges must not re-render it as removed.
      const snapshot = makeSnap({
        story_ids: ["a", "b"],
        all_story_ids: ["a", "b"],
        storyHashes: { a: "h-a", b: "h-b" },
      });
      const state = makeState({
        allStoryIds: ["a", "b"],
        stories: [{ story_id: "a", title: "A" }],
        storyHashes: { a: "h-a" }, // b excluded from hashes when draft
      });
      const summary = computeChangeSummary(state, snapshot);
      expect(summary.stories.deleted.map((s) => s.story_id)).toEqual(["b"]);
      expect(summary.fileChanges.addedStoryFiles).toEqual([]);
      expect(summary.fileChanges.removedStoryFiles).toEqual([]);
    });

    it("idempotency: nothing changed since last publish keeps fileChanges empty and isUpToDate true", () => {
      // Snapshot and current state agree on the full file set; entity hashes
      // match. isUpToDate must stay true.
      const snapshot = makeSnap({
        story_ids: ["a"],
        all_story_ids: ["a", "b-draft"],
        storyHashes: { a: "h-a" },
      });
      const state = makeState({
        allStoryIds: ["a", "b-draft"],
        stories: [{ story_id: "a", title: "A" }],
        storyHashes: { a: "h-a" },
      });
      const summary = computeChangeSummary(state, snapshot);
      expect(summary.fileChanges.addedStoryFiles).toEqual([]);
      expect(summary.fileChanges.removedStoryFiles).toEqual([]);
      expect(summary.isUpToDate).toBe(true);
    });

    it("back-compat: snapshot without all_story_ids falls back to story_ids — no false positives when state matches", () => {
      // Pre-Phase-45 snapshot: only `story_ids` is populated. Current D1
      // matches exactly (no drafts). fileChanges must stay empty.
      const snapshot = makeSnap({
        story_ids: ["a"],
        // all_story_ids: undefined
        storyHashes: { a: "h-a" },
      });
      const state = makeState({
        allStoryIds: ["a"],
        stories: [{ story_id: "a", title: "A" }],
        storyHashes: { a: "h-a" },
      });
      const summary = computeChangeSummary(state, snapshot);
      expect(summary.fileChanges.addedStoryFiles).toEqual([]);
      expect(summary.fileChanges.removedStoryFiles).toEqual([]);
      expect(summary.isUpToDate).toBe(true);
    });

    it("back-compat: snapshot without all_story_ids still detects a new draft via the story_ids fallback", () => {
      // Same pre-Phase-45 snapshot shape but a new draft has appeared in D1.
      // The fallback set is `story_ids` (non-drafts only); the new draft is
      // not in it, so addedStoryFiles must surface it.
      const snapshot = makeSnap({
        story_ids: ["a"],
        // all_story_ids: undefined
        storyHashes: { a: "h-a" },
      });
      const state = makeState({
        allStoryIds: ["a", "new-draft"],
        stories: [{ story_id: "a", title: "A" }],
        storyHashes: { a: "h-a" },
      });
      const summary = computeChangeSummary(state, snapshot);
      expect(summary.fileChanges.addedStoryFiles).toEqual(["new-draft"]);
      expect(summary.fileChanges.removedStoryFiles).toEqual([]);
      expect(summary.isUpToDate).toBe(false);
    });

    it("first publish (snapshot null): fileChanges.addedStoryFiles lists drafts not already in stories.new", () => {
      // No prior snapshot. Non-drafts land in stories.new; drafts are not
      // named there but their files will be written, so they must surface
      // in fileChanges.addedStoryFiles (dedup against stories.new).
      const state = makeState({
        allStoryIds: ["a", "b-draft"],
        stories: [{ story_id: "a", title: "A" }],
        storyHashes: { a: "h-a" },
      });
      const summary = computeChangeSummary(state, null);
      expect(summary.stories.new.map((s) => s.story_id)).toEqual(["a"]);
      expect(summary.fileChanges.addedStoryFiles).toEqual(["b-draft"]);
      expect(summary.fileChanges.removedStoryFiles).toEqual([]);
      expect(summary.isUpToDate).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// commit SUBJECT carries no "Telar Compositor" signature.
// The subject is assembled by autoGenerateCommitMessage
// purely from the change-summary parts + the `auto_commit.*` keys (excluding
// `footer`); the signature lives ONLY in the body footer appended by
// autoGenerateCommitBody (`auto_commit.footer`). autoGenerateCommitMessage is a
// private function inside the route module, so we lock the contract at its
// source-of-truth — the i18n keys the subject is built from. This passes
// against the current locales and would fire if anyone moved the signature
// into a subject key.
// ---------------------------------------------------------------------------

describe("auto_commit subject keys carry no 'Telar Compositor' signature", () => {
  // The subject is built from every auto_commit.* key EXCEPT `footer` (which is
  // body-only). If any of those leaked the signature, the rendered subject
  // would contain it.
  const subjectKeys = (block: Record<string, string>) =>
    Object.entries(block).filter(([key]) => key !== "footer");

  it("no EN auto_commit subject key contains 'Telar Compositor'", async () => {
    const en = (await import("~/i18n/locales/en/publish.json")).default as {
      auto_commit: Record<string, string>;
    };
    for (const [key, value] of subjectKeys(en.auto_commit)) {
      expect(value, `en auto_commit.${key}`).not.toContain("Telar Compositor");
    }
  });

  it("no ES auto_commit subject key contains 'Compositor de Telar' / 'Telar Compositor'", async () => {
    const es = (await import("~/i18n/locales/es/publish.json")).default as {
      auto_commit: Record<string, string>;
    };
    for (const [key, value] of subjectKeys(es.auto_commit)) {
      expect(value, `es auto_commit.${key}`).not.toContain("Compositor de Telar");
      expect(value, `es auto_commit.${key}`).not.toContain("Telar Compositor");
    }
  });

  it("the signature IS present in the body footer key (confirming it lives there, not in the subject)", async () => {
    const en = (await import("~/i18n/locales/en/publish.json")).default as {
      auto_commit: Record<string, string>;
    };
    const es = (await import("~/i18n/locales/es/publish.json")).default as {
      auto_commit: Record<string, string>;
    };
    expect(en.auto_commit.footer).toContain("Telar Compositor");
    expect(es.auto_commit.footer).toContain("Compositor de Telar");
  });
});

describe("private_story_workflow_stale copy is the settled string in both locales", () => {
  // The renderer test drives ValidationChecks with a short fixture, so the
  // production strings are pinned here instead: the wording is settled, the
  // `<0>…</0>` segment is what the renderer turns into the docs link, and
  // `{{stories}}` is the only value the validator supplies.
  const EN =
    "These stories are private, but your site's build workflow is out of date and does not include the step that protects them: {{stories}}. The published site build will fail until you replace .github/workflows/build.yml with the current one from the Telar repository. <0>The upgrade notes explain how.</0>";
  const ES =
    "Estas historias son privadas, pero el flujo de trabajo que construye tu sitio está desactualizado y no incluye el paso que las protege: {{stories}}. La construcción del sitio fallará hasta que reemplaces .github/workflows/build.yml por el más reciente del repositorio de Telar. <0>Las notas de actualización explican cómo hacerlo.</0>";

  it("EN and ES carry the settled wording verbatim", async () => {
    const en = (await import("~/i18n/locales/en/publish.json")).default as { checks: Record<string, string> };
    const es = (await import("~/i18n/locales/es/publish.json")).default as { checks: Record<string, string> };
    expect(en.checks.private_story_workflow_stale).toBe(EN);
    expect(es.checks.private_story_workflow_stale).toBe(ES);
  });

  it("each string has one link segment and the stories placeholder", () => {
    for (const text of [EN, ES]) {
      expect(text.match(/<0>[^<]+<\/0>/g)).toHaveLength(1);
      expect(text).toContain("{{stories}}");
    }
  });
});

describe("workflow-repair copy is the settled string in both locales", () => {
  // The five strings the repair button and its status line render. Settled
  // wording, pinned here rather than in the renderer test, which drives the
  // component through a key-passthrough `t`.
  const EN: Record<string, string> = {
    workflow_repair_action: "Update the build workflow",
    workflow_repair_running: "Updating the build workflow…",
    workflow_repair_done: "The build workflow is up to date.",
    workflow_repair_permission:
      "GitHub did not let the Compositor update the workflow. <0>Review the Telar Compositor app's permissions on GitHub</0> and try again, or replace the file by hand as the upgrade notes explain.",
    workflow_repair_failed:
      "The workflow could not be updated. Try again in a moment, or replace the file by hand as the upgrade notes explain.",
  };
  const ES: Record<string, string> = {
    workflow_repair_action: "Actualizar el flujo de trabajo",
    workflow_repair_running: "Actualizando el flujo de trabajo…",
    workflow_repair_done: "El flujo de trabajo quedó actualizado.",
    workflow_repair_permission:
      "GitHub no permitió que el Compositor actualizara el flujo de trabajo. <0>Revisa los permisos de la App de GitHub del Compositor de Telar</0> y vuelve a intentarlo, o reemplaza el archivo a mano como explican las notas de actualización.",
    workflow_repair_failed:
      "No se pudo actualizar el flujo de trabajo. Inténtalo de nuevo en un momento, o reemplaza el archivo a mano como explican las notas de actualización.",
  };

  it("EN and ES carry the settled wording verbatim", async () => {
    const en = (await import("~/i18n/locales/en/publish.json")).default as { checks: Record<string, string> };
    const es = (await import("~/i18n/locales/es/publish.json")).default as { checks: Record<string, string> };
    for (const [key, value] of Object.entries(EN)) {
      expect(en.checks[key], `en checks.${key}`).toBe(value);
    }
    for (const [key, value] of Object.entries(ES)) {
      expect(es.checks[key], `es checks.${key}`).toBe(value);
    }
  });

  it("only the permission string carries a link segment, and exactly one", () => {
    for (const block of [EN, ES]) {
      expect(block.workflow_repair_permission.match(/<0>[^<]+<\/0>/g)).toHaveLength(1);
      for (const key of ["workflow_repair_action", "workflow_repair_running", "workflow_repair_done", "workflow_repair_failed"]) {
        expect(block[key], key).not.toContain("<0>");
      }
    }
  });
});

describe("the repair's build-status copy is the settled string in both locales", () => {
  // What the status line says while the repair's own rebuild runs, and when it
  // ends. Settled wording, pinned here rather than in the renderer test, which
  // drives the component through a key-passthrough `t`.
  const EN: Record<string, string> = {
    workflow_repair_building: "The build workflow is up to date. Your site is rebuilding…",
    workflow_repair_watch: "Watch the build on GitHub",
    workflow_repair_rebuilt: "The build workflow is up to date and your site has been rebuilt.",
    workflow_repair_build_failed:
      "The build workflow is up to date, but the rebuild failed. <0>See the build details on GitHub</0>.",
    workflow_repair_build_cancelled:
      "The build workflow is up to date, but the rebuild was cancelled on GitHub. <0>See the build details on GitHub</0>.",
  };
  const ES: Record<string, string> = {
    workflow_repair_building:
      "El flujo de trabajo quedó actualizado. Tu sitio se está reconstruyendo…",
    workflow_repair_watch: "Seguir la construcción en GitHub",
    workflow_repair_rebuilt: "El flujo de trabajo está actualizado y tu sitio ya quedó reconstruido.",
    workflow_repair_build_failed:
      "El flujo de trabajo quedó actualizado, pero la reconstrucción falló. <0>Revisa los detalles en GitHub</0>.",
    workflow_repair_build_cancelled:
      "El flujo de trabajo quedó actualizado, pero la reconstrucción se canceló en GitHub. <0>Revisa los detalles en GitHub</0>.",
  };

  it("EN and ES carry the settled wording verbatim", async () => {
    const en = (await import("~/i18n/locales/en/publish.json")).default as { checks: Record<string, string> };
    const es = (await import("~/i18n/locales/es/publish.json")).default as { checks: Record<string, string> };
    for (const [key, value] of Object.entries(EN)) {
      expect(en.checks[key], `en checks.${key}`).toBe(value);
    }
    for (const [key, value] of Object.entries(ES)) {
      expect(es.checks[key], `es checks.${key}`).toBe(value);
    }
  });

  it("only the two ended-build strings carry a link segment, and exactly one each", () => {
    for (const block of [EN, ES]) {
      for (const key of ["workflow_repair_build_failed", "workflow_repair_build_cancelled"]) {
        expect(block[key].match(/<0>[^<]+<\/0>/g), key).toHaveLength(1);
      }
      for (const key of ["workflow_repair_building", "workflow_repair_watch", "workflow_repair_rebuilt"]) {
        expect(block[key], key).not.toContain("<0>");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// reworded page_no_title blocker no longer depends on slug.
// A titleless page has an empty/temp slug, so the old `Page "{{slug}}"…` copy
// rendered the unhelpful `Page ""…`. The blocker is reworked to a recovery-
// oriented message that does NOT interpolate slug and drops `params: { slug }`.
// ---------------------------------------------------------------------------

describe("page_no_title blocker is slug-independent", () => {
  it("an untitled page produces a page_no_title blocker that does NOT carry a slug param", () => {
    const result = runPrePublishValidation({
      headSha: "abc",
      currentRepoHead: "abc",
      stories: [],
      steps: [],
      objects: [],
      pages: [{ slug: "", title: "" }],
      glossary: [],
    });
    const blocker = result.blockers.find((b) => b.code === "page_no_title");
    expect(blocker).toBeDefined();
    // The reworded blocker must not interpolate a (missing) slug.
    expect(blocker?.params?.slug).toBeUndefined();
  });

  it("the page_no_title blocker does not set an empty-string entityId from a missing slug", () => {
    const result = runPrePublishValidation({
      headSha: "abc",
      currentRepoHead: "abc",
      stories: [],
      steps: [],
      objects: [],
      pages: [{ slug: "", title: "" }],
      glossary: [],
    });
    const blocker = result.blockers.find((b) => b.code === "page_no_title");
    expect(blocker).toBeDefined();
    // An empty entityId is harmless for rendering (keyed by code+idx), but
    // the blocker no longer derives identity from a non-existent slug.
    expect(blocker?.entityId).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildEntityHashes — object hash covers dimensions + extra_columns
// ---------------------------------------------------------------------------
//
// The publish change-detection hash must include every D1 field a published
// objects.csv row depends on. dimensions and extra_columns (the custom-column
// passthrough blob) were added to the objects table and to import/export, but
// were missing from the object hash — so editing them would not be detected as
// a change and publish would skip re-emitting them. These tests pin that they
// are now part of the hash, and that extra_columns is canonicalised so that
// equivalent custom-column data hashes identically regardless of stored key
// order.
// ---------------------------------------------------------------------------

describe("buildEntityHashes — object hash includes dimensions + extra_columns", () => {
  // Sequential mock db: buildEntityHashes runs Promise.all of six selects in
  // this order — stories, objects, pages, glossary, config, landing. With an
  // empty stories array there are no further per-story step/layer queries, so
  // six responses suffice. Each chain node is a thenable that resolves to the
  // next queued response and also returns the db so chaining keeps working.
  function makeMockDb(objectRows: Array<Record<string, unknown>>) {
    const responses: unknown[] = [
      [], // stories
      objectRows, // objects
      [], // pages
      [], // glossary
      [], // config
      [], // landing
    ];
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
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => {
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

  function baseObject(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      object_id: "obj-1",
      title: "An Object",
      featured: false,
      creator: "",
      description: "",
      source_url: "",
      period: "",
      year: "",
      object_type: "",
      subjects: "",
      source: "",
      credit: "",
      thumbnail: "",
      alt_text: "",
      dimensions: "",
      extra_columns: null,
      ...overrides,
    };
  }

  async function hashFor(obj: Record<string, unknown>): Promise<string> {
    const hashes = await buildEntityHashes(makeMockDb([obj]), 1);
    return hashes.objects[obj.object_id as string];
  }

  it("differs when only dimensions differ", async () => {
    const a = await hashFor(baseObject({ dimensions: "10 x 20 cm" }));
    const b = await hashFor(baseObject({ dimensions: "30 x 40 cm" }));
    expect(a).not.toBe(b);
  });

  it("differs when extra_columns CONTENT differs", async () => {
    const a = await hashFor(baseObject({ extra_columns: '{"a":"1"}' }));
    const b = await hashFor(baseObject({ extra_columns: '{"a":"2"}' }));
    expect(a).not.toBe(b);
  });

  it("is EQUAL for the same extras in different key ORDER (canonicalised)", async () => {
    const a = await hashFor(baseObject({ extra_columns: '{"a":"1","b":"2"}' }));
    const b = await hashFor(baseObject({ extra_columns: '{"b":"2","a":"1"}' }));
    expect(a).toBe(b);
  });

  it("treats extra_columns null and absent the same for the hash", async () => {
    const withNull = await hashFor(baseObject({ extra_columns: null }));
    const absent = baseObject();
    delete absent.extra_columns;
    const withAbsent = await hashFor(absent);
    expect(withNull).toBe(withAbsent);
  });

  it("does not throw on corrupt extra_columns and hashes it as empty", async () => {
    const corrupt = await hashFor(baseObject({ extra_columns: "{bad" }));
    const empty = await hashFor(baseObject({ extra_columns: null }));
    // Corrupt JSON canonicalises to "" — same as no extras at all.
    expect(corrupt).toBe(empty);
  });

  it("hash-format version is 4", () => {
    expect(ENTITY_HASHES_VERSION).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Glossary hash now includes related_terms. Without it, editing a term's
// related_terms would not be detected as a change and publish would skip
// re-emitting the row.
// ---------------------------------------------------------------------------

describe("buildEntityHashes — glossary hash includes related_terms", () => {
  // Sequential mock db: buildEntityHashes runs Promise.all of six selects in
  // order — stories, objects, pages, glossary, config, landing. Glossary is the
  // fourth response.
  function makeMockDb(glossaryRows: Array<Record<string, unknown>>) {
    const responses: unknown[] = [
      [], // stories
      [], // objects
      [], // pages
      glossaryRows, // glossary
      [], // config
      [], // landing
    ];
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
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => {
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

  function baseTerm(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      term_id: "enc",
      title: "Encomienda",
      definition: "A labor system",
      related_terms: "",
      ...overrides,
    };
  }

  async function hashFor(term: Record<string, unknown>): Promise<string> {
    const hashes = await buildEntityHashes(makeMockDb([term]), 1);
    return hashes.glossary[term.term_id as string];
  }

  it("differs when only related_terms differ", async () => {
    const a = await hashFor(baseTerm({ related_terms: "loom|weaving" }));
    const b = await hashFor(baseTerm({ related_terms: "loom" }));
    expect(a).not.toBe(b);
  });

  it("is EQUAL when related_terms are identical", async () => {
    const a = await hashFor(baseTerm({ related_terms: "loom|weaving" }));
    const b = await hashFor(baseTerm({ related_terms: "loom|weaving" }));
    expect(a).toBe(b);
  });

  // extra_columns joins the hash the way it joined the objects hash: without
  // it, an edit to a custom column is not an unpublished change and the
  // publish never re-emits glossary.csv. It is canonicalised first, so a blob
  // the sheet merely reserialised in a different key order is the same data —
  // the sync diff judges it the same way, and a disagreement between the two
  // would make an unchanged term oscillate across a publish/sync cycle.
  it("differs when only an extra_columns VALUE differs", async () => {
    const a = await hashFor(baseTerm({ extra_columns: JSON.stringify({ source_note: "Museo" }) }));
    const b = await hashFor(baseTerm({ extra_columns: JSON.stringify({ source_note: "Archivo" }) }));
    expect(a).not.toBe(b);
  });

  it("is EQUAL when two extra_columns blobs differ only in key ORDER", async () => {
    const a = await hashFor(baseTerm({ extra_columns: '{"alpha":"1","zeta":"2"}' }));
    const b = await hashFor(baseTerm({ extra_columns: '{"zeta":"2","alpha":"1"}' }));
    expect(a).toBe(b);
  });

  it("differs when a custom column is added", async () => {
    const a = await hashFor(baseTerm({ extra_columns: null }));
    const b = await hashFor(baseTerm({ extra_columns: JSON.stringify({ source_note: "Museo" }) }));
    expect(a).not.toBe(b);
  });

});

// ---------------------------------------------------------------------------
// glossary_colliding_columns — two headers the framework reads as one field
//
// Measured against the framework on 14 September: `normalize_column_names`
// raises ColumnCollisionError and it propagates uncaught out of
// `generate_collections._generate_glossary_from_csv`, so the build fails.
// ---------------------------------------------------------------------------

describe("runPrePublishValidation — glossary_colliding_columns", () => {
  const base = {
    headSha: "abc123",
    currentRepoHead: "abc123",
    stories: [],
    steps: [],
    objects: [],
    pages: [],
  };

  const blockersFor = (extras: Record<string, string> | null) =>
    runPrePublishValidation({
      ...base,
      glossary: [
        { term_id: "enc", extra_columns: extras ? JSON.stringify(extras) : null },
      ],
    }).blockers.filter((b) => b.code === "glossary_colliding_columns");

  // The case reproduced against the framework: the Compositor renames neither
  // header, so both survive as custom columns and are published side by side;
  // the framework renames `crédito` onto `credit` and refuses the sheet. This
  // is the collision a check keyed only on the Compositor's own table cannot
  // see, because that parser de-duplicates every collision it does know about.
  it("blocks a pair only the framework's table renames together", () => {
    const blockers = blockersFor({ credit: "a", "crédito": "b" });
    expect(blockers).toHaveLength(1);
    expect(blockers[0].params?.columns).toBe('"credit", "crédito"');
  });

  it("blocks a custom column that renames onto a FIXED glossary column", () => {
    // `título` -> `title`, and `title` is already emitted.
    const blockers = blockersFor({ "título": "b" });
    expect(blockers).toHaveLength(1);
    expect(blockers[0].params?.columns).toBe('"title", "título"');
  });

  it("matches the framework's trim-and-lowercase reading", () => {
    expect(blockersFor({ "  TÍTULO  ": "b" })).toHaveLength(1);
  });

  // The framework renames `object_type`, `medium_genre`, `medio` and the rest
  // of that family onto `medium`. All of them are ordinary custom columns to
  // the Compositor, so a predictor built on OUR targets would pass a sheet the
  // framework refuses.
  it("blocks the medium family, which only the framework's targets unify", () => {
    expect(blockersFor({ medium: "a", object_type: "b" })[0]?.params?.columns)
      .toBe('"medium", "object_type"');
    expect(blockersFor({ medium: "a", medium_genre: "b" })[0]?.params?.columns)
      .toBe('"medium", "medium_genre"');
    expect(blockersFor({ object_type: "a", tipo_objeto: "b" })).toHaveLength(1);
  });

  it("blocks the protection family on the framework's target too", () => {
    // `private` and `protegida` both become `protected` there; to us they are
    // two unrelated custom columns on a glossary sheet.
    expect(blockersFor({ private: "a", protegida: "b" })).toHaveLength(1);
  });

  // Every header is folded before the rename, renamed or not: the generator
  // lowercases and trims the whole frame first, and the collision guard folds
  // unrenamed names too. So case and whitespace differences collide.
  it("blocks two custom columns that differ only in case", () => {
    expect(blockersFor({ Note: "a", note: "b" })[0]?.params?.columns)
      .toBe('"Note", "note"');
  });

  it.each(["Title", "TITLE", " title "])(
    "blocks a fixed column against %j beside its Spanish spelling",
    (spelling) => {
      expect(blockersFor({ [spelling]: "a", "título": "b" })).toHaveLength(1);
    },
  );

  it("does not block the suffixed name the parser mints for a duplicate", () => {
    expect(blockersFor({ title_1: "a" })).toHaveLength(0);
  });

  // An extras key that FOLDS onto a fixed column is one the serializer drops,
  // so the file it writes carries that header once and builds. A blocker here
  // would refuse a correct file, and its message would name a single spelling
  // the author cannot act on — there is no second column in the sheet to
  // delete. The check reads the same surviving-key rule the serializer does.
  it("does not block an extras key the serializer drops for folding onto a fixed column", () => {
    expect(blockersFor({ related_terms: "loom" })).toHaveLength(0);
    expect(blockersFor({ Term_ID: "x" })).toHaveLength(0);
  });

  it("emits that column once, which is why nothing is blocked", () => {
    const csv = serializeGlossaryCsv([
      {
        term_id: "enc",
        title: null,
        definition: null,
        related_terms: null,
        extra_columns: JSON.stringify({ related_terms: "loom" }),
      },
    ]);
    expect(csv.split("\n")[0]).toBe("term_id,title,definition,related_terms");
  });

  it("does not block an ordinary custom column", () => {
    expect(blockersFor({ source_note: "Museo del Oro" })).toHaveLength(0);
  });

  it("does not block a glossary with no custom columns at all", () => {
    expect(blockersFor(null)).toHaveLength(0);
  });

  it("reports the emitted column set once, not once per term", () => {
    const blockers = runPrePublishValidation({
      ...base,
      glossary: [
        { term_id: "enc", extra_columns: JSON.stringify({ "título": "a" }) },
        { term_id: "loom", extra_columns: JSON.stringify({ "título": "b" }) },
      ],
    }).blockers.filter((b) => b.code === "glossary_colliding_columns");
    expect(blockers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildConfigManagedBlocks / telar_theme / buildConfigChangeFields
// ---------------------------------------------------------------------------

describe("buildConfigManagedBlocks", () => {
  it("emits story_interface + collection_interface with UNQUOTED bool/int values", () => {
    const blocks = buildConfigManagedBlocks(makeConfig({ include_demo_content: false }));
    expect(blocks.story_interface.include_demo_content).toBe("false");
    expect(blocks.story_interface.show_on_homepage).toBe("true");
    expect(blocks.collection_interface.browse_and_search).toBe("true");
    expect(blocks.collection_interface.featured_count).toBe("4");
    for (const block of Object.values(blocks))
      for (const v of Object.values(block)) expect(v).not.toMatch(/["']/);
  });
  it("omits null fields and drops empty blocks", () => {
    const blocks = buildConfigManagedBlocks(
      makeConfig({ browse_and_search: null, show_link_on_homepage: null,
            show_sample_on_homepage: null, featured_count: null }),
    );
    expect(blocks.collection_interface).toBeUndefined();
    expect(blocks.story_interface).toBeDefined();
  });

  // `story_content:` is no longer a managed block. Its one key was the answer
  // word limit, and the limit stopped being a per-site setting, so nothing
  // here has a value to write into it — and a site whose file already carries
  // the block keeps every line of it untouched.
  it("emits no story_content block, whatever the retired column holds", () => {
    for (const held of [null, 0, 60]) {
      const blocks = buildConfigManagedBlocks(makeConfig({ answer_word_limit: held }));
      expect(blocks.story_content).toBeUndefined();
    }
  });
});

// Silently rewriting a key out of somebody's _config.yml is the failure this
// whole area exists to avoid. We stopped WRITING the key; we never delete it.
// Once it is nobody's managed child the writer copies its lines like any other
// unmanaged line, which is what these pin — byte for byte, comment and all.
describe("a site's own story_content line survives a publish untouched", () => {
  const SITE = [
    'title: "Their site"',
    "story_content:",
    "  # they chose this by hand",
    "  answer_word_limit: 40   # keep me",
    "  something_of_theirs: keep",
    'url: "https://u.example"',
    "",
  ].join("\n");

  const publish = (config = makeConfig({ title: "Their site", answer_word_limit: null })) =>
    healConfigYaml(SITE, buildConfigManagedFields(config), buildConfigManagedBlocks(config));

  it("keeps the block's every line exactly as it was written", () => {
    const out = publish();
    expect(out).toContain("  # they chose this by hand");
    expect(out).toContain("  answer_word_limit: 40   # keep me");
    expect(out).toContain("  something_of_theirs: keep");
  });

  it("writes no second copy of the key, and no default over theirs", () => {
    const parsed = loadYaml(publish()) as any;
    expect(parsed.story_content.answer_word_limit).toBe(40);
    expect(publish().match(/answer_word_limit/g)).toHaveLength(1);
  });

  // A column still holding a number from before the retirement changes
  // nothing: no reader takes it and no writer emits it.
  it("is untouched whatever the retired column still holds", () => {
    for (const held of [null, 0, 60, 200]) {
      const out = publish(makeConfig({ title: "Their site", answer_word_limit: held }));
      expect(out).toContain("  answer_word_limit: 40   # keep me");
    }
  });

  it("leaves the block alone even when the publish rewrites the keys around it", () => {
    const out = healConfigYaml(
      SITE,
      buildConfigManagedFields(makeConfig({ title: "Renamed", url: "https://new.example" })),
      buildConfigManagedBlocks(makeConfig({ show_on_homepage: false })),
    );
    expect(out).toContain('title: "Renamed"');
    expect(out).toContain("  answer_word_limit: 40   # keep me");
    expect(out).toContain("  something_of_theirs: keep");
  });
});

describe("buildConfigManagedFields — telar_theme", () => {
  it("writes telar_theme from config.theme (quoted top-level scalar)", () => {
    expect(buildConfigManagedFields(makeConfig({ theme: "trama" })).telar_theme).toBe('"trama"');
  });
  it("omits telar_theme when theme is null", () => {
    expect(buildConfigManagedFields(makeConfig({ theme: null })).telar_theme).toBeUndefined();
  });
});

describe("buildConfigChangeFields", () => {
  it("flattens block fields under dotted keys alongside top-level managed fields", () => {
    const f = buildConfigChangeFields(makeConfig({ title: "T", include_demo_content: false }));
    expect(f.title).toBe('"T"');
    expect(f["story_interface.include_demo_content"]).toBe("false");
    expect(f["collection_interface.featured_count"]).toBe("4");
  });

  it("carries no story_content key, since the publish writes that block no more", () => {
    const f = buildConfigChangeFields(makeConfig({ answer_word_limit: 60 }));
    expect(f["story_content.answer_word_limit"]).toBeUndefined();
  });
});

describe("updateConfigBlocks", () => {
  const blocks = { story_interface: { include_demo_content: "false" } };

  it("replaces an existing nested key in place, preserving indent + trailing comment", () => {
    const yaml = `title: "x"\nstory_interface:\n  include_demo_content: true # keep me\n`;
    const out = updateConfigBlocks(yaml, blocks);
    expect(out).toContain("  include_demo_content: false # keep me");
    expect((loadYaml(out) as any).story_interface.include_demo_content).toBe(false);
  });

  // The same writer serves every managed block, so the rule that a managed
  // child is a plain scalar on its key's line reaches story_interface and
  // collection_interface with it. A block scalar is a value this line writer
  // cannot replace, and taking it on published "false" folded into the text
  // beneath it.
  it("refuses a block scalar under a managed child of story_interface", () => {
    const yaml = `story_interface:\n  include_demo_content: |\n    true\n  show_on_homepage: true\n`;

    expect(() => updateConfigBlocks(yaml, blocks)).toThrow(/story_interface/);
  });

  it("rewrites the last duplicate child in collection_interface and drops the dead one", () => {
    const yaml = `collection_interface:\n  featured_count: 3\n  featured_count: 7\n`;

    const out = updateConfigBlocks(yaml, { collection_interface: { featured_count: "9" } });

    expect((loadYaml(out, { json: true }) as any).collection_interface.featured_count).toBe(9);
    expect(out.match(/featured_count/g)).toHaveLength(1);
  });

  it("inserts a missing managed key into an existing block", () => {
    const yaml = `story_interface:\n  show_on_homepage: true\nprotected:\n  key: abc\n`;
    const out = updateConfigBlocks(yaml, { story_interface: { include_demo_content: "false" } });
    const p = loadYaml(out) as any;
    expect(p.story_interface.include_demo_content).toBe(false);
    expect(p.story_interface.show_on_homepage).toBe(true);
    expect(p.protected.key).toBe("abc");
  });

  it("appends the whole block at EOF when absent", () => {
    const yaml = `title: "x"\n`;
    const out = updateConfigBlocks(yaml, { collection_interface: { featured_count: "6" } });
    expect((loadYaml(out) as any).collection_interface.featured_count).toBe(6);
  });

  it("emits booleans/ints unquoted so js-yaml types them correctly", () => {
    const out = updateConfigBlocks(`story_interface:\n  a: 1\n`, {
      story_interface: { include_demo_content: "false" },
      collection_interface: { featured_count: "4" },
    });
    const p = loadYaml(out) as any;
    expect(typeof p.story_interface.include_demo_content).toBe("boolean");
    expect(typeof p.collection_interface.featured_count).toBe("number");
  });

  it("is idempotent", () => {
    const yaml = `story_interface:\n  include_demo_content: true\n`;
    const once = updateConfigBlocks(yaml, blocks);
    expect(updateConfigBlocks(once, blocks)).toBe(once);
  });

  // Inverted three times. It first pinned a silent refusal, then a re-emission
  // in block style; the re-emission lost quoted keys and merge entries, broke a
  // mapping that spanned lines, and mistook a brace in a comment for the end of
  // one. A line writer cannot take a flow mapping apart — and leaving the file
  // alone in silence ships settings that disagree with D1, so it refuses out
  // loud. See tests/config-block-unwritable.test.ts.
  it("refuses a flow-style block rather than editing it or passing it over", () => {
    const yaml = `story_interface: {include_demo_content: true, keep_me: "a, b"}\n`;

    expect(() => updateConfigBlocks(yaml, blocks)).toThrow(/story_interface/);
  });

  it("updates the LAST duplicate block key (matches js-yaml/framework read order)", () => {
    const yaml = `story_interface:\n  include_demo_content: true\nstory_interface:\n  include_demo_content: true\n`;
    const out = updateConfigBlocks(yaml, blocks);
    // js-yaml's default schema REFUSES duplicate keys outright; the framework
    // (Jekyll/Ruby YAML) reads last-wins. `json: true` selects the same
    // duplicate-tolerant last-wins semantics, which is what this case asserts.
    expect((loadYaml(out, { json: true }) as any).story_interface.include_demo_content).toBe(false);
  });

  it("preserves a consistent CRLF line ending", () => {
    const yaml = `title: "x"\r\nstory_interface:\r\n  include_demo_content: true\r\n`;
    const out = updateConfigBlocks(yaml, blocks);
    expect(out).not.toMatch(/[^\r]\n/);
    expect((loadYaml(out) as any).story_interface.include_demo_content).toBe(false);
  });

  it("does not treat a commented child as the managed key (inserts the real one)", () => {
    const yaml = `story_interface:\n  # include_demo_content: true (disabled)\n  show_on_homepage: true\n`;
    const out = updateConfigBlocks(yaml, blocks);
    expect(out).toContain("# include_demo_content: true (disabled)");
    expect((loadYaml(out) as any).story_interface.include_demo_content).toBe(false);
  });

  // The managed key is the DIRECT child of the block. A key of the same name
  // sitting under an unmanaged child is a different key, and every reader of
  // the file takes it as one: editing it writes a value nothing reads and
  // leaves the real setting where it was.
  it.each([
    ["include_demo_content", "true", "false"],
    ["show_on_homepage", "false", "true"],
  ])("creates %s as a direct child rather than editing a nested key of that name", (
    key,
    nested,
    write,
  ) => {
    const yaml = `story_interface:\n  other:\n    ${key}: ${nested} # keep\n`;

    const out = updateConfigBlocks(yaml, { story_interface: { [key]: write } });

    expect(out).toContain(`    ${key}: ${nested} # keep`);
    expect((loadYaml(out) as any).story_interface[key]).toBe(write === "true");
  });

  // YAML reads the last of two duplicate keys, so rewriting the first changes a
  // line nothing reads and publishes the old value. Whitespace before the colon
  // is a key like any other — every parser of this file reads it as one — so
  // the same rule has to see it.
  it("rewrites the last of two duplicate children when the second is spaced before its colon", () => {
    const yaml = `story_interface:\n  include_demo_content: true\n  include_demo_content : true\n`;

    const out = updateConfigBlocks(yaml, blocks);

    expect((loadYaml(out) as any).story_interface.include_demo_content).toBe(false);
    expect(out.match(/include_demo_content/g)).toHaveLength(1);
  });

  // A comment deeper than the key is a comment, not part of the value: YAML
  // ignores it wherever it sits, and an author put it there on purpose.
  it("keeps a standalone comment indented under the child it explains", () => {
    const yaml = `story_interface:\n  include_demo_content: true\n    # retain this explanation\n  show_on_homepage: true\n`;

    const out = updateConfigBlocks(yaml, blocks);

    expect(out).toContain("    # retain this explanation");
    expect(out).toContain("  show_on_homepage: true");
    expect((loadYaml(out) as any).story_interface.include_demo_content).toBe(false);
  });

  // A leading `-` makes a scalar a sequence item only when what follows is not
  // a digit. `-1` is a value an author can perfectly well have typed, and
  // refusing to replace it blocks a publish over a value the writer can read.
  it("rewrites a negative number, which is a plain scalar like any other", () => {
    const yaml = `story_interface:\n  include_demo_content: -1\n`;

    const out = updateConfigBlocks(yaml, blocks);

    expect(out).toContain("  include_demo_content: false");
    expect((loadYaml(out) as any).story_interface.include_demo_content).toBe(false);
  });

  // A hash with a space before it is a comment, and the spacing around it is
  // the author's. An empty value is still a value position: the comment after
  // it survives the number arriving in front of it.
  it.each([
    [
      "no space after the hash",
      `story_interface:\n  include_demo_content: true #c\n`,
      "  include_demo_content: false #c",
    ],
    [
      "the spacing it was written with",
      `story_interface:\n  include_demo_content: true   # keep\n`,
      "  include_demo_content: false   # keep",
    ],
    [
      "no value at all before it",
      `story_interface:\n  include_demo_content: # keep\n`,
      "  include_demo_content: false # keep",
    ],
  ])("keeps a trailing comment with %s", (_name, yaml, expected) => {
    expect(updateConfigBlocks(yaml, blocks)).toContain(expected);
  });

  // A publish that changed the file again on every run would show a diff to
  // every author on every publish.
  it.each([
    ["an empty value", `story_interface:\n  include_demo_content:\n`],
    ["whitespace before the colon", `story_interface:\n  include_demo_content : true\n`],
    ["a missing child", `story_interface:\n  show_on_homepage: true\n`],
    ["no block at all", `title: "x"\n`],
  ])("writes %s the same way twice", (_name, yaml) => {
    const once = updateConfigBlocks(yaml, blocks);

    expect(updateConfigBlocks(once, blocks)).toBe(once);
  });

  // The writer copies an unmanaged child's lines without reading them, so a
  // value spanning several lines comes through as its author wrote it.
  it("leaves a block scalar belonging to an unmanaged sibling alone", () => {
    const yaml = `story_interface:\n  note: |\n    keep every word\n    of this\n  include_demo_content: true\n`;

    const out = updateConfigBlocks(yaml, blocks);

    expect(out).toContain("    keep every word");
    expect(out).toContain("    of this");
    expect((loadYaml(out) as any).story_interface.include_demo_content).toBe(false);
  });
});

describe("healConfigYaml — nested blocks", () => {
  const blocks = { story_interface: { include_demo_content: "false" } };

  it("applies blocks on the normal (already-valid) path", () => {
    const input = `title: "x"\nstory_interface:\n  include_demo_content: true\n`;
    const out = healConfigYaml(input, {}, blocks);
    expect((loadYaml(out) as any).story_interface.include_demo_content).toBe(false);
  });

  it("applies blocks on the rescue path (input has the multi-line-scalar corruption)", () => {
    const corrupt = [
      'title: "Para one.', "", 'Para two. "', "", 'Para two. "',
      'url: "https://u.example"', "story_interface:", "  include_demo_content: true",
    ].join("\n");
    expect(() => loadYaml(corrupt)).toThrow();
    // Real callers pass every managed field (buildConfigManagedFields), so the
    // rescue path can re-emit url cleanly after the strip drops the corrupt one.
    const out = healConfigYaml(
      corrupt,
      { description: '"Fresh."', url: '"https://u.example"' },
      blocks,
    );
    const p = loadYaml(out) as any;
    expect(p.story_interface.include_demo_content).toBe(false);
    expect(p.url).toBe("https://u.example");
  });

  // The tier that dropped the block write and returned the rest is the silence
  // being removed: it committed a file whose managed settings disagreed with
  // D1 and told nobody. A block the writer cannot edit now fails the publish.
  it("refuses a flow-style block rather than dropping the block write", () => {
    const input = `title: "x"\nstory_interface: {}\n`;
    expect(() => healConfigYaml(input, { title: '"y"' }, blocks)).toThrow(/story_interface/);
  });

  it("defaults blocks to {} (existing 2-arg callers unaffected)", () => {
    const input = `title: "x"\n`;
    expect(healConfigYaml(input, { title: '"y"' })).toContain('title: "y"');
  });
});

describe("config blocks round-trip against real _config.yml fixtures", () => {
  const TEMPLATE = `title: "Demo"\nstory_interface:\n  show_on_homepage: true # c\n  show_story_steps: true # c\n  show_object_credits: true # c\n  include_demo_content: true # c\n\n# Collection Interface Settings\ncollection_interface:\n  browse_and_search: true # c\n  show_link_on_homepage: true # c\n  show_sample_on_homepage: true # c\n  featured_count: 4 # c\n`;
  const PARTIAL = `title: "AIH"\nstory_interface:\n  show_story_steps: true # c\n  show_object_credits: true # c\n  include_demo_content: false # c\n`;

  it("turns demo off in the framework template, preserving comments + typing", () => {
    const blocks = { story_interface: { include_demo_content: "false" } };
    const out = healConfigYaml(TEMPLATE, {}, blocks);
    const p = loadYaml(out) as Record<string, unknown>;
    expect((p.story_interface as Record<string, unknown>).include_demo_content).toBe(false);
    expect((p.story_interface as Record<string, unknown>).show_on_homepage).toBe(true);
    expect((p.collection_interface as Record<string, unknown>).featured_count).toBe(4);
    expect(out).toContain("# Collection Interface Settings");
  });

  it("inserts missing keys + appends the absent collection_interface (aiforhistory)", () => {
    const blocks = {
      story_interface: { show_on_homepage: "false", include_demo_content: "false" },
      collection_interface: { featured_count: "8" },
    };
    const out = healConfigYaml(PARTIAL, {}, blocks);
    const p = loadYaml(out) as Record<string, unknown>;
    expect((p.story_interface as Record<string, unknown>).show_on_homepage).toBe(false);
    expect((p.story_interface as Record<string, unknown>).include_demo_content).toBe(false);
    expect((p.story_interface as Record<string, unknown>).show_story_steps).toBe(true);
    expect((p.collection_interface as Record<string, unknown>).featured_count).toBe(8);
  });
});

describe("settings change-detection includes block fields", () => {
  it("buildConfigChangeFields differs when only a nested toggle changes", () => {
    const a = JSON.stringify(buildConfigChangeFields(makeConfig({ include_demo_content: true })));
    const b = JSON.stringify(buildConfigChangeFields(makeConfig({ include_demo_content: false })));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Psych-unsafe code points through every builder
// ---------------------------------------------------------------------------
//
// `yamlQuote` delegates to `escapeYamlString`, the escaper the `yaml_string`
// knap filter also uses, so every scalar the publish path writes — layer
// titles, page titles, navigation labels, `_config.yml` managed fields —
// escapes the code points Ruby Psych rejects or silently corrupts. The
// hand-rolled quote/backslash/newline pass this replaced let a raw NEL
// through, and Psych turns a raw NEL into a plain space with no error at
// all, so the corruption reached the published site unannounced.
//
// Each case asserts the EXACT emitted scalar rather than "raw character
// absent" plus "escape substring present". That pair stays green when the
// encoder doubles its backslashes, which turns the value Psych reads from one
// control character into six literal ASCII ones — a doubled backslash.
//
// The round-trips run under Ruby Psych as well as js-yaml because js-yaml
// accepts every one of these code points raw and unchanged, so a js-yaml
// assertion alone cannot tell an escaped scalar from an unescaped one.

/**
 * Parses YAML with Ruby Psych — the parser Jekyll builds this front matter
 * with — via a ruby subprocess, handing the value back as JSON so it crosses
 * the process boundary without a second YAML round-trip.
 *
 * Fails loudly when ruby is absent rather than falling back to js-yaml: a
 * fallback would leave these assertions passing while testing nothing, which
 * is the failure the block exists to prevent.
 */
function parseYamlViaPsych(yamlText: string): unknown {
  const out = execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "print JSON.dump(YAML.load(STDIN.read))"],
    { input: yamlText, encoding: "utf-8" },
  );
  return JSON.parse(out) as unknown;
}

/** The YAML text between a document's `---` fences, as the builders write it. */
function frontmatterOf(fileContent: string): string {
  const match = fileContent.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`no frontmatter block in: ${JSON.stringify(fileContent)}`);
  return `${match[1]}\n`;
}

const PSYCH_HAZARD_CASES: Array<{
  label: string;
  input: string;
  /** The exact double-quoted scalar every builder must emit for `input`. */
  scalar: string;
  /** The value a YAML parser must read back out of that scalar. */
  value: string;
}> = [
  {
    label: "NEL, which Psych silently turns into a space when raw",
    input: "a\u0085b",
    scalar: '"a\\u0085b"',
    value: "a\u0085b",
  },
  {
    label: "DEL, which Psych rejects outright when raw",
    input: "a\u007fb",
    scalar: '"a\\u007fb"',
    value: "a\u007fb",
  },
  {
    label: "U+2028, the Unicode line separator",
    input: "a\u2028b",
    scalar: '"a\\u2028b"',
    value: "a\u2028b",
  },
  {
    // No YAML escape represents a lone surrogate, so this one is replaced
    // with U+FFFD rather than escaped — a deliberate, documented loss that
    // keeps a site publishable when upstream data is already malformed.
    label: "a lone high surrogate, replaced rather than escaped",
    input: "a\ud800b",
    scalar: '"a\ufffdb"',
    value: "a\ufffdb",
  },
];

describeWithRuby("Psych-unsafe code points, through every builder", () => {
    describe.each(PSYCH_HAZARD_CASES)("$label", ({ input, scalar, value }) => {
    it("layerFileContent escapes it in the title", async () => {
      const file = await layerFileContent(input, "body");
      expect(file).toBe(`---\ntitle: ${scalar}\n---\n\nbody`);
      expect(loadYaml(frontmatterOf(file))).toEqual({ title: value });
      expect(parseYamlViaPsych(frontmatterOf(file))).toEqual({ title: value });
    });

    it("serializePageMarkdown escapes it in the title", async () => {
      const file = await serializePageMarkdown(input, "body");
      expect(file).toBe(`---\ntitle: ${scalar}\n---\n\nbody\n`);
      expect(loadYaml(frontmatterOf(file))).toEqual({ title: value });
      expect(parseYamlViaPsych(frontmatterOf(file))).toEqual({ title: value });
    });

    it("buildNavigationYml escapes it in both label columns", () => {
      const yml = buildNavigationYml([{ type: "page", slug: "about", label: input, visible: true }]);
      expect(yml).toBe(`menu:\n  - title_en: ${scalar}\n    titulo_es: ${scalar}\n    url: "/about/"\n`);
      const expected = { menu: [{ title_en: value, titulo_es: value, url: "/about/" }] };
      expect(loadYaml(yml)).toEqual(expected);
      expect(parseYamlViaPsych(yml)).toEqual(expected);
    });

    it("buildConfigManagedFields escapes it in every free-text field", () => {
      const fields = buildConfigManagedFields(makeConfig({ title: input, author: input }));
      expect(fields.title).toBe(scalar);
      expect(fields.author).toBe(scalar);
      // The managed fields are spliced into `_config.yml` one line each, so the
      // line is what has to parse, not the bare scalar.
      const line = `title: ${fields.title}\n`;
      expect(loadYaml(line)).toEqual({ title: value });
      expect(parseYamlViaPsych(line)).toEqual({ title: value });
    });
  });
});

// The framework parses the frontmatter block as YAML, so an escaped title
// reaches it as the character the escape stands for, not as the escape text.
// Its reader used to strip one pair of quotes with a regex and hand back
// whatever was between them, which returned the six literal characters of
// `\u0085` and doubled a backslash on every republish; these assert the
// decoded value so a return to the regex reader shows up here.
describeWithFramework("the framework decodes an escaped layer title", () => {
  it("returns the NEL character, not its escape text", async () => {
    const { title } = splitFrontmatterViaFramework(await layerFileContent("a\u0085b", "body"));
    expect(title).toBe("a\u0085b");
  });

  it("returns the replacement character for a lone surrogate", async () => {
    const { title } = splitFrontmatterViaFramework(await layerFileContent("a\ud800b", "body"));
    expect(title).toBe("a\ufffdb");
  });

  it("returns a quoted title without doubling its quotes", async () => {
    const { title } = splitFrontmatterViaFramework(await layerFileContent('a "q" b', "body"));
    expect(title).toBe('a "q" b');
  });
});

// ---------------------------------------------------------------------------
// Document rendering
// ---------------------------------------------------------------------------
//
// The layer file and the page markdown render through knap; navigation.yml
// and index.md are built as strings. Both halves write their scalars with the
// same escaper, so these assertions cover all four either way.

// A Telar body legitimately contains Jekyll Liquid: the framework's own
// templates are Liquid, and authors paste includes and conditionals into
// layer and page bodies. Those bodies are VALUES, never template source, so
// every one of these must come out byte for byte as it went in. A body
// re-parsed as a template would lose the tag, or fail on an unknown include,
// or — worst — resolve `{{ title }}` against the Compositor's own variables
// and publish the wrong text. The index.md case is here because the body it
// carries has to survive whether or not that builder is ever templated.
const LIQUID_BODY = [
  "Intro paragraph.",
  "",
  "{{ title }} and {{ site.title }}",
  "{% if page.draft %}draft{% endif %}",
  "{% include foo.html param='x' %}",
  "{%- raw -%}",
  "{{ not_a_variable }}",
  "{%- endraw -%}",
].join("\n");

describe("bodies are values, never template source", () => {
  it("layerFileContent publishes a Liquid body verbatim", async () => {
    const file = await layerFileContent("Context", LIQUID_BODY);
    expect(file).toBe(`---\ntitle: "Context"\n---\n\n${LIQUID_BODY}`);
  });

  it("serializePageMarkdown publishes a Liquid body verbatim", async () => {
    const file = await serializePageMarkdown("About", LIQUID_BODY);
    expect(file).toBe(`---\ntitle: "About"\n---\n\n${LIQUID_BODY}\n`);
  });

  it("buildIndexMd publishes a Liquid welcome body verbatim", async () => {
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: "Our stories",
      stories_intro: null,
      objects_heading: null,
      objects_intro: null,
      welcome_body: LIQUID_BODY,
    });
    expect(out).toBe(
      `---\nlayout: index\ntitle: Home\ntitle_key: navigation.home\nstories_heading: "Our stories"\n---\n\n${LIQUID_BODY}`,
    );
  });

  it("a title carrying Liquid is escaped as text, not resolved", async () => {
    const file = await serializePageMarkdown("{{ site.title }}", "body");
    expect(file).toBe('---\ntitle: "{{ site.title }}"\n---\n\nbody\n');
    expect(loadYaml(frontmatterOf(file))).toEqual({ title: "{{ site.title }}" });
  });
});

// The render limits are set explicitly rather than inherited, and a limit set
// too low fails the publish instead of writing a short file. A pasted body is
// the shape that would hit a default, so it is the shape tested — at a size
// the limits allow, and at one they do not.
describe("render limits", () => {
  const LAYER_HEADER = '---\ntitle: "Big"\n---\n\n';

  // Asserted by prefix, length and tail rather than against one concatenated
  // expectation, so a multi-megabyte case does not build a second copy of
  // itself to compare with. The three together are byte identity.
  function expectLayerCarries(file: string, body: string): void {
    expect(file.startsWith(LAYER_HEADER)).toBe(true);
    expect(file.length).toBe(LAYER_HEADER.length + body.length);
    expect(file.slice(LAYER_HEADER.length)).toBe(body);
  }

  it("renders a 2 MiB layer body without truncation", async () => {
    const body = "x".repeat(2 * 1024 * 1024);
    expectLayerCarries(await layerFileContent("Big", body), body);
  });

  it("renders a 2 MiB page body without truncation", async () => {
    const body = "y".repeat(2 * 1024 * 1024);
    const file = await serializePageMarkdown("Big", body);
    expect(file.length).toBe(LAYER_HEADER.length + body.length + 1);
    expect(file.slice(LAYER_HEADER.length)).toBe(`${body}\n`);
  });

  // knap's own defaults would carry 2 MiB and reject 33 MiB on their own, so
  // the two sizes above and below prove nothing about the explicit limits.
  // 6 MiB is past the 5,000,000-character default and inside the 32 MiB set
  // here: it renders only because the limits in this module are the ones in
  // force.
  it("renders a 6 MiB layer body, which knap's default limits would refuse", async () => {
    const body = "w".repeat(6 * 1024 * 1024);
    expectLayerCarries(await layerFileContent("Big", body), body);
  });

  it("throws naming the limit that fired, rather than truncating", async () => {
    // A layer file written short is data loss the author would not see until
    // the published page was missing its end, so the failure has to be an
    // error and not a shorter string. Naming the limit in the assertion keeps
    // it honest: raising only maxValueLength would make this pass again for
    // the wrong reason, and the 6 MiB case above would still hold.
    const body = "z".repeat(33 * 1024 * 1024);
    await expect(layerFileContent("Huge", body)).rejects.toThrow(/maxValueLength/);
  });
});

// A menu is the one document here whose length is driven by the user rather
// than by a single pasted value, so its whole length is asserted rather than
// its first entry.
describe("a large navigation", () => {
  it("serialises 500 items in full", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      type: "page" as const,
      slug: `page-${i}`,
      label: `Page ${i}`,
      visible: true,
    }));
    const yml = buildNavigationYml(items);
    const parsed = loadYaml(yml) as { menu: Array<{ title_en: string; url: string }> };
    expect(parsed.menu).toHaveLength(500);
    expect(parsed.menu[0]).toEqual({ title_en: "Page 0", titulo_es: "Page 0", url: "/page-0/" });
    expect(parsed.menu[499]).toEqual({
      title_en: "Page 499",
      titulo_es: "Page 499",
      url: "/page-499/",
    });
  });
});

// Every front-matter scalar the Compositor writes is a string, whatever it
// looks like. YAML 1.1 and 1.2 disagree about which bare words are booleans,
// so the assertion is on the PARSED value and its type, over each builder
// that writes one.
const TYPE_BAIT: string[] = [
  "1234",
  "true",
  "false",
  "null",
  "~",
  "yes",
  "no",
  "on",
  "off",
  "3.14",
  "1e5",
  " leading space",
  "trailing space ",
  "#hash",
  "*star",
  "&anchor",
  "!tag",
  "- dash",
  ": colon",
  "2026-09-14",
  "12:30",
  ".inf",
  ".nan",
  "",
];

/** What a first publish of index.md writes above the managed fields. */
const INDEX_FRAMEWORK_FRONTMATTER = { layout: "index", title: "Home", title_key: "navigation.home" };

describe.each(TYPE_BAIT)("a title of %j stays a string", (title) => {
  it("through layerFileContent", async () => {
    const parsed = loadYaml(frontmatterOf(await layerFileContent(title, "body")));
    expect(parsed).toEqual({ title });
  });

  it("through serializePageMarkdown", async () => {
    const parsed = loadYaml(frontmatterOf(await serializePageMarkdown(title, "body")));
    expect(parsed).toEqual({ title });
  });

  it("through buildNavigationYml", () => {
    const yml = buildNavigationYml([
      { type: "page", slug: "about", label: title, visible: true },
    ]);
    expect(loadYaml(yml)).toEqual({
      menu: [{ title_en: title, titulo_es: title, url: "/about/" }],
    });
  });

  it("through buildNavigationYml as an external URL", () => {
    const yml = buildNavigationYml([
      { type: "external", url: title, label: "Partner", visible: true },
    ]);
    expect(loadYaml(yml)).toEqual({
      menu: [{ title_en: "Partner", url: title, external: true }],
    });
  });

  it("through buildIndexMd", async () => {
    const buildIndexMd = await loadBuildIndexMd();
    const out = buildIndexMd({
      stories_heading: title,
      stories_intro: null,
      objects_heading: null,
      objects_intro: null,
      welcome_body: "body",
    });
    // An empty heading is dropped by the gate rather than written, so there
    // is no scalar to read back for that one case — only the framework's own
    // lines, which a first publish always writes.
    if (title === "") {
      expect(loadYaml(frontmatterOf(out))).toEqual(INDEX_FRAMEWORK_FRONTMATTER);
      return;
    }
    expect(loadYaml(frontmatterOf(out))).toEqual({
      ...INDEX_FRAMEWORK_FRONTMATTER,
      stories_heading: title,
    });
  });
});

// ---------------------------------------------------------------------------
// The shared front-matter scalar corpus
// ---------------------------------------------------------------------------
//
// The framework and the Compositor serialise the same fields on two different
// publish paths, so they share one list of scalars an author can type into a
// cell. The framework keeps the file; both sides maintain the union, in the
// manner of tests/fixtures/column-headers.json.
//
// `expected_yaml` in that file is deliberately ignored here. It records the
// framework's own quoting — PyYAML's single quotes — and this side writes
// double-quoted scalars. The agreed property is not the bytes: it is that the
// value parses back as the identical string, with the type the author's input
// had. `1234` is text in a spreadsheet cell and must be text in the published
// front matter, whichever quote character got it there.
const SCALAR_CORPUS_PATH = new URL("./fixtures/frontmatter-scalars.json", import.meta.url);

interface ScalarCorpusEntry {
  source: string;
  intended_type: string;
  expected_yaml?: string;
  note?: string;
}

/**
 * Reads this repo's vendored copy of the corpus. Vendored rather than read
 * from the framework checkout so the suite runs anywhere; the copy is
 * compared against the framework's below, on machines that have it.
 */
function loadScalarCorpus(): ScalarCorpusEntry[] {
  const parsed = JSON.parse(readFileSync(SCALAR_CORPUS_PATH, "utf-8")) as {
    scalars: ScalarCorpusEntry[];
  };
  return parsed.scalars;
}

const SCALAR_CORPUS = loadScalarCorpus();

/**
 * Scalars this side tests that the shared file does not carry. The framework
 * took sixteen of the Compositor's nineteen contributions and left these:
 * PyYAML will not emit a lone surrogate at all, and the framework preserves
 * carriage returns where this side used to normalise them, so neither could
 * be given an `expected_yaml` on that side. The normalisation is gone and
 * these now round-trip here, which is what these entries record. They stay
 * out of the vendored file so the drift comparison below stays exact.
 */
const COMPOSITOR_ONLY_SCALARS: ScalarCorpusEntry[] = [
  { source: "a\rb", intended_type: "string", note: "Bare carriage return, preserved rather than folded into a line feed" },
  { source: "a\r\nb", intended_type: "string", note: "CRLF, which must come back as two characters and not one" },
];

/** A second engine, built here so the test exercises the filter as a render does. */
const corpusEngine = createEngine({ filters: filtersWithYamlString });

describeWithFramework("the vendored scalar corpus matches the framework's", () => {
  it("carries exactly the framework's sources", () => {
    const frameworkPath = `${FRAMEWORK_SCRIPTS_DIR}/../tests/fixtures/frontmatter-scalars.json`;
    const theirs = JSON.parse(readFileSync(frameworkPath, "utf-8")) as {
      scalars: ScalarCorpusEntry[];
    };
    // Sources only: `expected_yaml` is each side's own quoting and is expected
    // to differ, and a note may be reworded on either side without drift.
    expect(new Set(SCALAR_CORPUS.map((e) => e.source))).toEqual(
      new Set(theirs.scalars.map((e) => e.source)),
    );
  });
});

describeWithRuby("shared front-matter scalar corpus", () => {
  it("is the corpus the framework published, all strings", () => {
    expect(SCALAR_CORPUS.length).toBeGreaterThanOrEqual(58);
    for (const entry of SCALAR_CORPUS) expect(entry.intended_type).toBe("string");
  });

  it.each([...SCALAR_CORPUS, ...COMPOSITOR_ONLY_SCALARS].map((e) => [e.source, e] as const))(
    "round-trips %j as the identical string",
    async (source, entry) => {
      // yamlQuote's output, reached through the one builder that writes with
      // it — the _config.yml line splicer.
      const spliced = buildConfigManagedFields(makeConfig({ title: source })).title;
      // The same value through the yaml_string filter, rendered by an engine.
      const rendered = await corpusEngine.renderOrThrow("title: {{ value | yaml_string }}", {
        variables: { value: source },
      });

      for (const line of [`title: ${spliced}\n`, `${rendered}\n`]) {
        const parsed = loadYaml(line) as { title: unknown };
        expect(parsed.title).toBe(source);
        expect(typeof parsed.title).toBe("string");
        expect(parseYamlViaPsych(line)).toEqual({ title: source });
      }
      // `note` is the corpus's own record of what the case catches; reading it
      // here keeps the field from silently going unused on this side.
      expect(entry.note === undefined || typeof entry.note === "string").toBe(true);
    },
  );
});

/**
 * The corpus sources the framework cannot return as themselves, named rather
 * than filtered out silently: a title that is only whitespace loses it, because
 * the reader strips the line's trailing whitespace before parsing — a property
 * of reading a line, not of the escaping. The list is asserted against the
 * filter below, so a corpus entry that joined this set would fail the test
 * rather than quietly stop being checked.
 */
const WHITESPACE_ONLY_SOURCES = [" "];

describeWithFramework("the framework reads back every corpus scalar", () => {
  it(
    "recovers every one of them from a layer file, bar the whitespace-only",
    async () => {
      const sources = [...SCALAR_CORPUS, ...COMPOSITOR_ONLY_SCALARS].map((e) => e.source);
      const excluded = sources.filter((s) => s.trim() === "" && s !== "");
      expect(excluded).toEqual(WHITESPACE_ONLY_SOURCES);

      const checked = sources.filter((s) => !(s.trim() === "" && s !== ""));
      // A floor on the corpus itself, not on `sources`: a length derived from
      // the very array under test passes against an empty fixture, and this
      // assertion exists to prove the reader was given the whole corpus.
      expect(SCALAR_CORPUS.length).toBeGreaterThanOrEqual(58);
      expect(checked).toHaveLength(sources.length - WHITESPACE_ONLY_SOURCES.length);

      const files = await Promise.all(checked.map((s) => layerFileContent(s, "body")));
      // One python3 for the whole corpus; the comparison stays here, one per
      // entry, so a failure names the scalars that failed.
      const read = splitFrontmatterViaFrameworkBatch(files);
      expect(read).toHaveLength(checked.length);
      // The framework parses the block as YAML, so every scalar comes back as
      // itself — including the escaped ones a regex reader mangles.
      //
      // Collected rather than asserted one at a time: an expectation inside the
      // loop throws on the first mismatch, so a change that breaks twenty
      // scalars reports one and the other nineteen are found a run at a time.
      const mismatched = checked
        .map((source, i) => ({ source, read: read[i].title }))
        .filter((pair) => pair.read !== pair.source);
      expect(mismatched).toEqual([]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Line breaks are preserved, not normalised
// ---------------------------------------------------------------------------
//
// One policy across the publish path: a carriage return is written as the
// escape `\r` and a line feed as `\n`, and both come back as themselves.
// Nothing folds CRLF into LF. The escaper's own comment states the rule; this
// asserts it on all four builders, because the divergence that mattered was
// one builder normalising while the others did not.
const LINE_BREAK_CASES: Array<[label: string, value: string]> = [
  ["a bare carriage return", "a\rb"],
  ["a CRLF pair", "a\r\nb"],
  ["a line feed", "a\nb"],
];

describeWithRuby("line breaks, through every builder", () => {
    describe.each(LINE_BREAK_CASES)("%s survives", (_label, value) => {
    it("through layerFileContent", async () => {
      const file = await layerFileContent(value, "body");
      expect(loadYaml(frontmatterOf(file))).toEqual({ title: value });
      expect(parseYamlViaPsych(frontmatterOf(file))).toEqual({ title: value });
    });

    it("through serializePageMarkdown", async () => {
      const file = await serializePageMarkdown(value, "body");
      expect(loadYaml(frontmatterOf(file))).toEqual({ title: value });
      expect(parseYamlViaPsych(frontmatterOf(file))).toEqual({ title: value });
    });

    it("through buildNavigationYml", () => {
      const yml = buildNavigationYml([
        { type: "page", slug: "about", label: value, visible: true },
      ]);
      const expected = { menu: [{ title_en: value, titulo_es: value, url: "/about/" }] };
      expect(loadYaml(yml)).toEqual(expected);
      expect(parseYamlViaPsych(yml)).toEqual(expected);
    });

    it("through buildConfigManagedFields, round-tripped by the config reader", () => {
      const fields = buildConfigManagedFields(makeConfig({ title: value }));
      // This reader is why the normalisation existed: it walks _config.yml a
      // line at a time, so a value carrying a real line break would be cut.
      // An escaped one is two ASCII characters and is not.
      const yml = updateConfigFields(`title: "old"\n`, fields);
      expect(extractConfigFields(yml).title).toBe(value);
    });
  });
});

// ---------------------------------------------------------------------------
// Publish -> import -> publish is a fixed point for a page title
// ---------------------------------------------------------------------------
//
// parsePageMarkdown reads the title as YAML, not by stripping a pair of
// quotes off the line. Stripping quotes returns the escape text rather than
// the value, so a title with a quote in it comes back carrying backslashes
// and the next publish escapes those again — a backslash added per cycle.
// Parsing makes one round trip identity, and every round trip after it.
describe("a published page title survives re-import unchanged", () => {
  const TITLES: Array<[label: string, title: string]> = [
    ["a quoted title", 'a "q" b'],
    ["a backslash", "a \\ b"],
    ["both together", 'a \\ "q" b'],
    ["NEL", "ab"],
    ["a tab", "a\tb"],
    ["a carriage return", "a\rb"],
    ["a colon", "Title: with a colon"],
  ];

  it.each(TITLES)("%s is unchanged by publish, import, publish", async (_label, title) => {
    const published = await serializePageMarkdown(title, "Body text.");
    const imported = parsePageMarkdown(published, "fallback-slug");
    expect(imported.title).toBe(title);
    expect(imported.body).toBe("Body text.");
    // And the file the second publish writes is the file the first wrote.
    expect(await serializePageMarkdown(imported.title, imported.body)).toBe(published);
  });

  it("a lone surrogate settles after one cycle and then holds", async () => {
    // The escaper replaces a lone surrogate with U+FFFD, which is a real
    // character: the first publish changes the title, and nothing after it
    // does. A fixed point reached on the second cycle, not the first.
    const first = await serializePageMarkdown("a\ud800b", "Body text.");
    const imported = parsePageMarkdown(first, "fallback-slug");
    expect(imported.title).toBe("a�b");
    const second = await serializePageMarkdown(imported.title, imported.body);
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Titles the frontmatter reader has to parse rather than unquote
// ---------------------------------------------------------------------------
//
// One reader now serves pages and layers, and it parses the whole block as
// YAML. These are the shapes a regex that strips a pair of quotes gets wrong:
// a quoted scalar carrying escapes, a block scalar, and a value that is not a
// string at all.
//
// A non-string title comes back as the raw text of the line, never as a
// stringified value. `title: ~` is `~` and not `null`; `title: 2024` is
// `2024` and not the number. That is what makes the cycle settle: the next
// publish quotes the text, and every publish after it writes the same bytes.

describe("a title parsed from a hand-authored frontmatter block", () => {
  const cases: Array<[label: string, block: string, expected: string]> = [
    ["a quoted title with escapes", 'title: "a \\"q\\" b"', 'a "q" b'],
    ["a quoted title with a backslash", 'title: "a \\\\ b"', "a \\ b"],
    ["a quoted title with a carriage return", 'title: "a\\rb"', "a\rb"],
    ["a single-quoted title", "title: 'it''s here'", "it's here"],
    // A block scalar's clip chomping keeps one trailing newline; `|-` is how
    // an author asks for it stripped, so it is not this reader's to remove.
    ["a literal block scalar", "title: |\n  Alpha\n  Beta", "Alpha\nBeta\n"],
    ["a folded block scalar", "title: >\n  Alpha\n  Beta", "Alpha Beta\n"],
    ["a stripped literal block scalar", "title: |-\n  Alpha\n  Beta", "Alpha\nBeta"],
    // Non-strings: the raw line text, as typed.
    ["a bare number", "title: 2024", "2024"],
    ["a bare float", "title: 3.14", "3.14"],
    ["a tilde", "title: ~", "~"],
    ["a bare null", "title: null", "null"],
  ];

  // A sequence or a mapping is not one piece of text. A page takes its
  // fallback. A layer title is the text the framework displays, which for a
  // title YAML does not type as a string is TITLE_PATTERN's capture, as typed
  // (the framework's scripts/telar/markdown.py:135). The pattern's `\s*`
  // crosses the line end, so a block sequence's capture is its first item.
  const NO_SINGLE_TEXT: Array<[label: string, block: string, layerTitle: string | undefined]> = [
    ["a flow sequence", "title: [a]", "[a]"],
    ["a flow mapping", "title: {a: 1}", "{a: 1}"],
    ["a block sequence", "title:\n  - a\n  - b", "- a"],
    ["an empty value", "title:", undefined],
  ];

  it.each(NO_SINGLE_TEXT)("%s falls back for a page", (_label, block) => {
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("fallback");
  });

  it.each(NO_SINGLE_TEXT)("%s is the capture as typed for a layer", (_label, block, layerTitle) => {
    const rows = parseTelarCsv("step_number,kind,layer1_content\n1,media,PLACEHOLDER\n");
    rows[0].layer1_content = `---\n${block}\n---\n\nBody.`;
    const { layers } = mapStoryCsv(rows, 1);
    expect(layers[0]?.title).toBe(layerTitle);
  });

  it.each(cases)("%s imports as a page title", (_label, block, expected) => {
    const page = parsePageMarkdown(`---\n${block}\n---\n\nBody text.`, "fallback");
    expect(page.title).toBe(expected);
    expect(typeof page.title).toBe("string");
  });

  // A layer's block reaches PyYAML without the line break after its last
  // line (markdown.py:103), and PyYAML's clip chomping keeps only the breaks
  // the text has, so a block scalar ending the block has no final `\n` in the
  // title the framework shows (markdown.py:129). Measured by running
  // `_split_frontmatter` on these blocks with the framework's Python environment (PyYAML
  // 6.0.3): 'Alpha\nBeta' and 'Alpha Beta'.
  const LAYER_TITLE_DIFFERS: Record<string, string> = {
    "a literal block scalar": "Alpha\nBeta",
    "a folded block scalar": "Alpha Beta",
  };

  it.each(cases)("%s imports as a layer title", (label, block, expected) => {
    const rows = parseTelarCsv(
      "step_number,kind,layer1_content\n1,media,PLACEHOLDER\n",
    );
    rows[0].layer1_content = `---\n${block}\n---\n\nBody text.`;
    const { layers } = mapStoryCsv(rows, 1);
    expect(layers[0]?.title).toBe(LAYER_TITLE_DIFFERS[label] ?? expected);
  });

  it.each(cases)("%s is a fixed point after one publish", async (_label, block, expected) => {
    // A hand-authored bare `2024` becomes `"2024"` on the first publish and
    // holds from there; a title that was already a quoted string is a fixed
    // point from the start.
    const imported = parsePageMarkdown(`---\n${block}\n---\n\nBody text.`, "fallback");
    const first = await serializePageMarkdown(imported.title, imported.body);
    const second = parsePageMarkdown(first, "fallback");
    expect(second.title).toBe(expected);
    expect(await serializePageMarkdown(second.title, second.body)).toBe(first);
  });

  it("falls back to the raw line when the block is not valid YAML", () => {
    // An unbalanced quote elsewhere in the block makes the whole document
    // unparseable; the title still has to arrive, because an import that
    // dropped the page would be worse than one that reads its title the old
    // way.
    const page = parsePageMarkdown(
      '---\ntitle: "Recoverable"\nbroken: "unterminated\n---\n\nBody text.',
      "fallback",
    );
    expect(page.title).toBe("Recoverable");
  });

  it("uses the fallback slug when the block carries no title", () => {
    expect(parsePageMarkdown("---\nlayout: page\n---\n\nBody.", "about").title).toBe("about");
  });

  it("keeps an untitled layer untitled", () => {
    const rows = parseTelarCsv("step_number,kind,layer1_content\n1,media,PLACEHOLDER\n");
    rows[0].layer1_content = '---\ntitle: ""\n---\n\nBody text.';
    const { layers } = mapStoryCsv(rows, 1);
    expect(layers[0]?.title).toBeUndefined();
  });
});

// The layer half of the page fixed-point test above: a layer title published
// by the Compositor and read back by its own importer must be the title that
// went in, and the file the next publish writes must be the same file.
describe("a published layer title survives re-import unchanged", () => {
  const TITLES: Array<[label: string, title: string]> = [
    ["a quoted title", 'a "q" b'],
    ["a backslash", "a \\ b"],
    ["both together", 'a \\ "q" b'],
    ["NEL", "ab"],
    ["a tab", "a\tb"],
    ["a carriage return", "a\rb"],
    ["CRLF", "a\r\nb"],
    ["a colon", "Title: with a colon"],
    ["a number-shaped title", "2024"],
    ["a tilde", "~"],
  ];

  it.each(TITLES)("%s is unchanged by publish, import, publish", async (_label, title) => {
    const published = await layerFileContent(title, "Body text.");
    const rows = parseTelarCsv("step_number,kind,layer1_content\n1,media,PLACEHOLDER\n");
    rows[0].layer1_content = published;
    const { layers } = mapStoryCsv(rows, 1);
    expect(layers[0]?.title).toBe(title);
    expect(await layerFileContent(layers[0]?.title ?? null, layers[0]?.content ?? "")).toBe(
      published,
    );
  });
});

// ---------------------------------------------------------------------------
// The title comes from the parse, not from hunting its line
// ---------------------------------------------------------------------------
//
// Matching `^title:` against the block text reads whatever the regex lands on,
// which is not always the title. Two shapes show it: a block that carries the
// key twice, where the parser takes the last and a line hunt takes the first,
// and a title the parser has to resolve — an alias or a merge — which a hunt
// cannot see at all. The answer comes from parsing the block.
describe("the title is read by parsing, not by matching its line", () => {
  it("is unmoved by a title line inside another key's value", () => {
    // Physical newlines, not the `\n` escapes an earlier version of this test
    // used, which put the text on one line and so tested nothing.
    //
    // This one is an equivalence, not a discriminator, and it is here to
    // record why: a line hunt anchored at `^` can only match column zero, and
    // inside a valid block every line belonging to another key's value is
    // indented under it, so the text can never sit at column zero. The
    // reachable instances of the same defect are the duplicate keys below and
    // the resolved titles in the next block; both discriminate.
    const block = ['other: "hello', "  title: 999", '  world"', "title: 2024"].join("\n");
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("2024");
  });

  it("takes the last of two title keys, as the parser does", () => {
    const block = "title: Old\ntitle: 2024";
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("2024");
  });

  it("takes the last of two title keys whatever their types", () => {
    // The precedence must not depend on the value's shape. Both orders agree
    // with the parser.
    expect(
      parsePageMarkdown('---\ntitle: 2024\ntitle: "Real"\n---\n\nBody.', "fallback").title,
    ).toBe("Real");
    expect(
      parsePageMarkdown('---\ntitle: "Real"\ntitle: 2024\n---\n\nBody.', "fallback").title,
    ).toBe("2024");
  });

  it("reads an aliased title", () => {
    // Anchors and aliases are syntax, so the failsafe schema still resolves
    // them; a line hunt would have returned `*x`.
    const block = "seed: &x Hello\ntitle: *x";
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// A block that will not parse still yields its title properly
// ---------------------------------------------------------------------------
//
// One malformed key should not cost the title its escape decoding or its
// block scalar. When the whole block is refused, the `title:` entry alone —
// the key line plus the lines indented under it — is parsed the same way.
describe("a malformed frontmatter block beside a good title", () => {
  const BROKEN = 'broken: "unterminated';
  const CUSTOM_TAG = "other: !custom x";

  it.each([
    ["an unterminated quote", BROKEN],
    ["an unknown tag", CUSTOM_TAG],
  ])("%s leaves an escaped title decoded", (_label, bad) => {
    const page = parsePageMarkdown(`---\ntitle: "a\\rb"\n${bad}\n---\n\nBody.`, "fallback");
    expect(page.title).toBe("a\rb");
  });

  it.each([
    ["an unterminated quote", BROKEN],
    ["an unknown tag", CUSTOM_TAG],
  ])("%s leaves a block-scalar title folded", (_label, bad) => {
    const page = parsePageMarkdown(
      `---\ntitle: |\n  Alpha\n  Beta\n${bad}\n---\n\nBody.`,
      "fallback",
    );
    expect(page.title).toBe("Alpha\nBeta\n");
  });

  it.each([
    ["an unterminated quote", BROKEN],
    ["an unknown tag", CUSTOM_TAG],
  ])("%s leaves a plain title alone", (_label, bad) => {
    const page = parsePageMarkdown(`---\ntitle: Plain title\n${bad}\n---\n\nBody.`, "fallback");
    expect(page.title).toBe("Plain title");
  });

  // A layer's block that YAML cannot parse gives the framework's raw capture,
  // quotes trimmed and escapes left as typed (markdown.py:139). The next
  // publish writes a well-formed block that parses to the same text.
  it("reads a layer title out of a malformed block as the framework's capture", () => {
    const rows = parseTelarCsv("step_number,kind,layer1_content\n1,media,PLACEHOLDER\n");
    rows[0].layer1_content = `---\ntitle: "a \\"q\\" b"\n${BROKEN}\n---\n\nBody.`;
    const { layers } = mapStoryCsv(rows, 1);
    expect(layers[0]?.title).toBe('a \\"q\\" b');
  });
});

// ---------------------------------------------------------------------------
// A file written on Windows is the same file
// ---------------------------------------------------------------------------
//
// The page reader kept an LF-only precheck in front of the shared reader, so
// a CRLF file never reached it: the page came back with its fallback title
// and its whole frontmatter block still sitting in the body, while the layer
// reader handled the same bytes correctly.
describe("CRLF frontmatter", () => {
  const CRLF_FILE = '---\r\ntitle: "Hello"\r\n---\r\nBody text.';

  it("is read by the page reader", () => {
    const page = parsePageMarkdown(CRLF_FILE, "fallback");
    expect(page.title).toBe("Hello");
    expect(page.body).toBe("Body text.");
  });

  it("is read by the layer reader", () => {
    const rows = parseTelarCsv("step_number,kind,layer1_content\n1,media,PLACEHOLDER\n");
    rows[0].layer1_content = CRLF_FILE;
    const { layers } = mapStoryCsv(rows, 1);
    expect(layers[0]?.title).toBe("Hello");
    expect(layers[0]?.content).toBe("Body text.");
  });

  it("is read the same way as the LF file it mirrors, its kept block aside", () => {
    // The kept front matter is the file's own bytes, line endings included,
    // so only the title and body are the same.
    const { frontmatter: crlfBlock, ...crlf } = parsePageMarkdown(CRLF_FILE, "fallback");
    const { frontmatter: lfBlock, ...lf } = parsePageMarkdown('---\ntitle: "Hello"\n---\nBody text.', "fallback");
    expect(crlf).toEqual(lf);
    expect(crlfBlock).toBe('\r\ntitle: "Hello"\r\n');
    expect(lfBlock).toBe('\ntitle: "Hello"\n');
  });

  it("tolerates trailing spaces on a fence line", () => {
    expect(parsePageMarkdown('---  \ntitle: "Hello"\n---  \nBody.', "fallback").title).toBe(
      "Hello",
    );
  });
});

// ---------------------------------------------------------------------------
// Titles the resolving schema has to answer for
// ---------------------------------------------------------------------------
//
// The failsafe schema cannot be the only read. It resolves nothing: a merge
// key is an ordinary key called `<<` there, and an aliased or merged title is
// invisible to it. Both are valid YAML and the framework reads both. The
// default schema answers what the title IS; failsafe is consulted only to
// recover the text behind a title that resolved to a non-string. The standard
// scalar tags are carried through it as text, so one `!!int` beside the title
// no longer costs the whole read.
describe("a title the parser has to resolve", () => {
  const TAG = "other: !!int 1";

  it("follows an alias, past a standard tag elsewhere", () => {
    const block = `seed: &x Hello\ntitle: *x\n${TAG}`;
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("Hello");
  });

  it("takes the last duplicate key, past a standard tag elsewhere", () => {
    const block = `title: Old\ntitle: New\n${TAG}`;
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("New");
  });

  it("reads a title interrupted by a comment, past a standard tag elsewhere", () => {
    const block = `title: Hello\n# a note about the page\n${TAG}`;
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("Hello");
  });

  it("reads a title that arrives through a merge key", () => {
    // `<<` is a mapping merge under the default schema and an ordinary key
    // under failsafe, so a failsafe-only read loses this title entirely.
    const block = "seed: &x\n  title: Hello\n<<: *x";
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("Hello");
  });

  it("still types a bare number beside a standard tag", () => {
    // The default schema resolves this to the number 2024, which is not the
    // text to write back; the failsafe read carries the tag beside it through
    // as text and hands back "2024".
    const block = `title: 2024\n${TAG}`;
    const page = parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback");
    expect(page.title).toBe("2024");
    expect(typeof page.title).toBe("string");
  });

  it("types a tilde the same way", () => {
    const block = `title: ~\n${TAG}`;
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("~");
  });

  // `!!binary` and `!!timestamp` are two of the six standard scalar tags the
  // failsafe schema does not know, and each is declared so a tag on a key
  // nobody asked about does not refuse the whole document. A refusal there is
  // not silent: the reader falls back to the `title:` entry alone, which sees
  // the FIRST of two duplicate keys, so the tag beside the title decides which
  // of them the file is read as having. The title is a bare number because
  // only a non-string scalar reaches the failsafe read at all.
  it.each([
    ["a binary value on an unrelated key", "logo: !!binary aGk="],
    ["a timestamp on an unrelated key", "published: !!timestamp 2026-01-01"],
  ])("still takes the last duplicate title past %s", (_name, unrelated) => {
    const block = `title: 2023\ntitle: 2024\n${unrelated}`;
    expect(parsePageMarkdown(`---\n${block}\n---\n\nBody.`, "fallback").title).toBe("2024");
  });

  it("reads an aliased title for a layer too", () => {
    const rows = parseTelarCsv("step_number,kind,layer1_content\n1,media,PLACEHOLDER\n");
    rows[0].layer1_content = `---\nseed: &x Hello\ntitle: *x\n${TAG}\n---\n\nBody.`;
    const { layers } = mapStoryCsv(rows, 1);
    expect(layers[0]?.title).toBe("Hello");
  });
});

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
 * @version v1.3.5-beta
 */

import { describe, it, expect, vi } from "vitest";
import Papa from "papaparse";
import { load as loadYaml } from "js-yaml";
import {
  serializeProjectCsv,
  serializeStoryCsv,
  serializeStory,
  layerFilename,
  layerFileContent,
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
} from "~/lib/publish.server";
import type { PublishSnapshot, CurrentPublishState, EntityHashes } from "~/lib/publish.server";
import { parseTelarCsv, mapStoryCsv } from "~/lib/import.server";
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
      layerFiles.map((lf) => ({
        filename: lf.filename,
        // mirrors the publish loop: layerFileContent(title, content)
        content: layerFileContent(lf.title, lf.content),
        rawContent: lf.content,
      }));

    it("two layers sharing a title on reordered steps: every CSV reference has a matching written file with the correct step's content", () => {
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
      const written = writtenFilesFrom(layerFiles);

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

describe("layerFileContent", () => {
  it("produces frontmatter + body when title provided", () => {
    const content = layerFileContent("Context", "# Hello");
    expect(content).toBe('---\ntitle: "Context"\n---\n\n# Hello');
  });

  it("produces content only when no title", () => {
    const content = layerFileContent(null, "Just content");
    expect(content).toBe("Just content");
  });

  it("produces content only when title is empty string", () => {
    const content = layerFileContent("", "Body text");
    expect(content).toBe("Body text");
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

  it("handles story_key under protected block", () => {
    const result = updateConfigFields(yaml, { story_key: "newkey" });
    expect(result).toContain("  key: newkey");
    expect(result).not.toContain("  key: oldkey");
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

  it("emits story_key unquoted", () => {
    const fields = buildConfigManagedFields(makeConfig({ story_key: "secret-key-value" }));
    expect(fields.story_key).toBe("secret-key-value");
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
    expect(result).toContain("url: /about/");
  });

  it("generates correct YAML for builtin glossary item", () => {
    const result = buildNavigationYml([
      { type: "builtin", key: "glossary", label: "Glossary", visible: true },
    ]);
    expect(result).toContain('title_en: "Glossary"');
    expect(result).toContain('titulo_es: "Glosario"');
    expect(result).toContain("url: /glossary/");
  });

  it("generates correct YAML for builtin collection item", () => {
    const result = buildNavigationYml([
      { type: "builtin", key: "collection", label: "Collection", visible: true },
    ]);
    expect(result).toContain("url: /objects/");
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
    expect(result).not.toContain("url: /\n");
    expect(result).not.toContain('title_en: "Home"');
    expect(result).not.toContain('titulo_es: "Inicio"');
    expect(result).toContain("url: /glossary/");
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

  it("serialises pages to markdown files with frontmatter", () => {
    const result = serializePageMarkdown("About", "Welcome to the site.");
    expect(result).toBe('---\ntitle: "About"\n---\n\nWelcome to the site.\n');
  });

  it("serializePageMarkdown handles empty body", () => {
    const result = serializePageMarkdown("Contact", "");
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
  it("empty-slug row produces no commit file", () => {
    const files = pageRowsToCommitFiles([{ title: "Untitled", slug: "", body: "" }]);
    expect(files).toHaveLength(0);
  });

  it("null-slug row produces no commit file", () => {
    const files = pageRowsToCommitFiles([
      { title: "Untitled", slug: null as unknown as string, body: "" },
    ]);
    expect(files).toHaveLength(0);
  });

  it("whitespace-only-slug row produces no commit file", () => {
    const files = pageRowsToCommitFiles([{ title: "Untitled", slug: "   ", body: "" }]);
    expect(files).toHaveLength(0);
  });

  it("valid-slug row produces exactly one commit file at the expected path", () => {
    const files = pageRowsToCommitFiles([
      { title: "About", slug: "about", body: "Welcome." },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("telar-content/texts/pages/about.md");
    expect(files[0].content).toContain('title: "About"');
    expect(files[0].content).toContain("Welcome.");
  });

  it("mixed input emits one file for the valid row only", () => {
    const files = pageRowsToCommitFiles([
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
  it("auto-slugged empty-title row (slug=untitled) produces no commit file", () => {
    const files = pageRowsToCommitFiles([{ title: "", slug: "untitled", body: "" }]);
    expect(files).toHaveLength(0);
  });

  it("auto-slugged null-title row produces no commit file", () => {
    const files = pageRowsToCommitFiles([
      { title: null as unknown as string, slug: "untitled-3", body: "" },
    ]);
    expect(files).toHaveLength(0);
  });

  it("whitespace-only-title row produces no commit file", () => {
    const files = pageRowsToCommitFiles([{ title: "   ", slug: "untitled", body: "x" }]);
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
});

describe("updateConfigBlocks", () => {
  const blocks = { story_interface: { include_demo_content: "false" } };

  it("replaces an existing nested key in place, preserving indent + trailing comment", () => {
    const yaml = `title: "x"\nstory_interface:\n  include_demo_content: true # keep me\n`;
    const out = updateConfigBlocks(yaml, blocks);
    expect(out).toContain("  include_demo_content: false # keep me");
    expect((loadYaml(out) as any).story_interface.include_demo_content).toBe(false);
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

  it("REFUSES flow-style blocks (leaves them untouched → caller stays valid)", () => {
    const yaml = `story_interface: {}\n`;
    const out = updateConfigBlocks(yaml, blocks);
    expect(out).toBe(yaml);
    expect(() => loadYaml(out)).not.toThrow();
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

  it("never returns invalid YAML even for a flow-style block (drops the block write)", () => {
    const input = `title: "x"\nstory_interface: {}\n`;
    const out = healConfigYaml(input, { title: '"y"' }, blocks);
    expect(() => loadYaml(out)).not.toThrow();
    expect((loadYaml(out) as any).title).toBe("y");
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

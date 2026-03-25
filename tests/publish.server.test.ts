/**
 * Unit tests for publish.server.ts — Telar Compositor publish library.
 *
 * Tests cover:
 *   - serializeProjectCsv: CSV header, bilingual row, draft omission, private mapping, ordering
 *   - serializeStoryCsv: CSV header, bilingual row, empty step skipping, layer filename cells
 *   - layerFilename: slug-prefixed names with title-based and step/layer fallback
 *   - layerFileContent: frontmatter + body, no-frontmatter pass-through
 *   - updateConfigFields: line-based YAML mutation, comment preservation, append missing
 *   - computeChangeSummary: first-time publish, no-change, entity classification
 *   - runPrePublishValidation: stale head blocker, missing-title warning, no-position warning
 */

import { describe, it, expect } from "vitest";
import Papa from "papaparse";
import {
  serializeProjectCsv,
  serializeStoryCsv,
  layerFilename,
  layerFileContent,
  updateConfigFields,
  computeChangeSummary,
  runPrePublishValidation,
} from "~/lib/publish.server";
import type { PublishSnapshot, CurrentPublishState } from "~/lib/publish.server";

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
  };

  it("produces header as first line", () => {
    const csv = serializeProjectCsv([baseStory]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("order,story_id,title,subtitle,byline,private");
  });

  it("produces bilingual row as second line", () => {
    const csv = serializeProjectCsv([baseStory]);
    const lines = csv.split("\n");
    expect(lines[1]).toBe("orden,id_historia,titulo,subtitulo,firma,privada");
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
    // The private cell should be empty (last column)
    const dataLine = csv.split("\n").find((l) => l.includes("weavers"));
    expect(dataLine).toBeDefined();
    // Row ends with comma then empty (private is empty)
    expect(dataLine).toMatch(/,$/);
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
    // title, subtitle, byline, private columns should all be empty (6 columns total)
    expect(dataLine).toBe("1,weavers,,,,");
  });

  it("preserves comment rows from existing CSV", () => {
    const existingCsv = "order,story_id,title,subtitle,byline,private\n# This is a comment\n";
    const csv = serializeProjectCsv([baseStory], existingCsv);
    expect(csv).toContain("# This is a comment");
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
    object_id: "my-object",
    x: 0.5,
    y: 0.3,
    zoom: 1.2,
    page: null,
    question: "What do you see?",
    answer: "A weaving.",
    alt_text: null as string | null,
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

  it("skips fully empty steps", () => {
    const emptyStep = {
      step_number: 2,
      object_id: null,
      x: null,
      y: null,
      zoom: null,
      page: null,
      question: null,
      answer: null,
      alt_text: null as string | null,
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

  it("preserves indentation and quotes", () => {
    const result = updateConfigFields(yaml, { baseurl: '"/newsite"' });
    expect(result).toContain('baseurl: "/newsite"');
  });
});

// ---------------------------------------------------------------------------
// computeChangeSummary
// ---------------------------------------------------------------------------

describe("computeChangeSummary", () => {
  const currentState: CurrentPublishState = {
    storyIds: ["weavers", "painters"],
    objectIds: ["obj-1", "obj-2"],
    configHash: JSON.stringify({ title: "My Site" }),
    landingHash: JSON.stringify({ stories_heading: "Stories" }),
    stories: [
      { story_id: "weavers", title: "The Weavers" },
      { story_id: "painters", title: "The Painters" },
    ],
    objects: [
      { object_id: "obj-1", title: "Object 1" },
      { object_id: "obj-2", title: "Object 2" },
    ],
  };

  it("first-time publish with null snapshot: all entities are new, isUpToDate false", () => {
    const summary = computeChangeSummary(currentState, null);
    expect(summary.isUpToDate).toBe(false);
    expect(summary.stories.new).toHaveLength(2);
    expect(summary.stories.modified).toHaveLength(0);
    expect(summary.stories.deleted).toHaveLength(0);
    expect(summary.objects.new).toHaveLength(2);
  });

  it("no changes since last publish: existing stories treated as modified (no per-entity hashes)", () => {
    const snapshot: PublishSnapshot = {
      story_ids: ["weavers", "painters"],
      object_ids: ["obj-1", "obj-2"],
      config_hash: JSON.stringify({ title: "My Site" }),
      landing_hash: JSON.stringify({ stories_heading: "Stories" }),
    };
    const summary = computeChangeSummary(currentState, snapshot);
    // Without per-entity hashes, existing stories are conservatively
    // treated as modified, so isUpToDate is false
    expect(summary.isUpToDate).toBe(false);
    expect(summary.stories.new).toHaveLength(0);
    expect(summary.stories.modified).toHaveLength(2);
    expect(summary.stories.deleted).toHaveLength(0);
  });

  it("new story added appears in stories.new", () => {
    const snapshot: PublishSnapshot = {
      story_ids: ["weavers"],
      object_ids: ["obj-1", "obj-2"],
      config_hash: JSON.stringify({ title: "My Site" }),
      landing_hash: JSON.stringify({ stories_heading: "Stories" }),
    };
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.stories.new.map((s) => s.story_id)).toContain("painters");
    expect(summary.isUpToDate).toBe(false);
  });

  it("story deleted appears in stories.deleted", () => {
    const stateWithout: CurrentPublishState = {
      ...currentState,
      storyIds: ["weavers"],
      stories: [{ story_id: "weavers", title: "The Weavers" }],
    };
    const snapshot: PublishSnapshot = {
      story_ids: ["weavers", "painters"],
      object_ids: ["obj-1", "obj-2"],
      config_hash: JSON.stringify({ title: "My Site" }),
      landing_hash: JSON.stringify({ stories_heading: "Stories" }),
    };
    const summary = computeChangeSummary(stateWithout, snapshot);
    expect(summary.stories.deleted.map((s) => s.story_id)).toContain("painters");
  });

  it("object added appears in objects.new", () => {
    const snapshot: PublishSnapshot = {
      story_ids: ["weavers", "painters"],
      object_ids: ["obj-1"],
      config_hash: JSON.stringify({ title: "My Site" }),
      landing_hash: JSON.stringify({ stories_heading: "Stories" }),
    };
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.objects.new.map((o) => o.object_id)).toContain("obj-2");
  });

  it("object removed appears in objects.deleted", () => {
    const stateWithout: CurrentPublishState = {
      ...currentState,
      objectIds: ["obj-1"],
      objects: [{ object_id: "obj-1", title: "Object 1" }],
    };
    const snapshot: PublishSnapshot = {
      story_ids: ["weavers", "painters"],
      object_ids: ["obj-1", "obj-2"],
      config_hash: JSON.stringify({ title: "My Site" }),
      landing_hash: JSON.stringify({ stories_heading: "Stories" }),
    };
    const summary = computeChangeSummary(stateWithout, snapshot);
    expect(summary.objects.deleted.map((o) => o.object_id)).toContain("obj-2");
  });

  it("config field changed is detected", () => {
    const snapshot: PublishSnapshot = {
      story_ids: ["weavers", "painters"],
      object_ids: ["obj-1", "obj-2"],
      config_hash: JSON.stringify({ title: "Old Site" }),
      landing_hash: JSON.stringify({ stories_heading: "Stories" }),
    };
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.settings.changed.length).toBeGreaterThan(0);
    expect(summary.isUpToDate).toBe(false);
  });

  it("landing content changed is detected", () => {
    const snapshot: PublishSnapshot = {
      story_ids: ["weavers", "painters"],
      object_ids: ["obj-1", "obj-2"],
      config_hash: JSON.stringify({ title: "My Site" }),
      landing_hash: JSON.stringify({ stories_heading: "Old Heading" }),
    };
    const summary = computeChangeSummary(currentState, snapshot);
    expect(summary.landing.changed).toBe(true);
    expect(summary.isUpToDate).toBe(false);
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
});

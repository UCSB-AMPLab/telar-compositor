/**
 * The heading of a panel with no title of its own, and what a publish writes
 * for it.
 *
 * The site heads a panel with its title, else its button label, else the
 * site language's default label (the framework's panels.js `getPanelContent`).
 * A layer with neither title nor text is not published, and neither is its
 * button. A layer 1 with neither, under a layer 2 that is published, is
 * written with the heading the site would show as its title, since layer 2's
 * button is drawn only inside layer 1's content; the import reads that title
 * back as no title, so a publish and an import store nothing the author did
 * not write. The read needs no language: it takes the layer's own button
 * label, or the default layer-1 label in any language the framework ships,
 * as a derived heading.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { renderStoryFiles } from "~/lib/publish.server";
import type { StoryLayerRow, StoryStepRow } from "~/lib/publish.server";
import { mapStoryCsv } from "~/lib/import.server";
import {
  canonicalForCompareFromD1,
  canonicalForCompareFromFiles,
  parseCommittedStory,
  rowsFromContent,
} from "~/lib/story-content.server";
import { derivedHeadingOf, panelHeading, siteLanguageOf } from "~/lib/panel-heading";

const SLUG = "story";
const TEXTS = "telar-content/texts/stories/";

function mediaStep(id: number): StoryStepRow {
  return {
    id,
    step_number: id,
    kind: "media",
    object_id: "telar-placeholder",
    x: null,
    y: null,
    zoom: null,
    page: null,
    question: "question",
    answer: "answer",
    alt_text: null,
    clip_start: null,
    clip_end: null,
    loop: null,
    extra_columns: null,
  };
}

function layer(n: number, extra: Partial<StoryLayerRow> = {}): StoryLayerRow {
  return { step_id: 1, layer_number: n, title: null, button_label: null, content: null, ...extra };
}

function layerFilesOf(files: Array<{ path: string; content: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) if (f.path.startsWith(TEXTS)) out[f.path.slice(TEXTS.length)] = f.content;
  return out;
}

async function roundTrip(layers: StoryLayerRow[], lang = "en") {
  const files = await renderStoryFiles(SLUG, [mediaStep(1)], layers, lang);
  const parsed = await parseCommittedStory(SLUG, files);
  return { files, layers: parsed[0]?.layers ?? [] };
}

describe("panelHeading", () => {
  it("is the title, else the button label, else the site language's default label", () => {
    expect(panelHeading(1, "Context", "More", "en")).toBe("Context");
    expect(panelHeading(1, null, "More", "en")).toBe("More");
    expect(panelHeading(1, null, null, "en")).toBe("Learn more");
    expect(panelHeading(2, null, "", "en")).toBe("Go deeper");
    expect(panelHeading(1, "", null, "es")).toBe("Saber más");
    expect(panelHeading(2, null, null, "es")).toBe("Profundizar");
  });

  it("passes over a title or label of only whitespace", () => {
    expect(panelHeading(1, "  ", "  ", "en")).toBe("Learn more");
  });

  it("reads any language but Spanish as English, as the framework's layouts do", () => {
    expect(siteLanguageOf("es")).toBe("es");
    expect(siteLanguageOf("fr")).toBe("en");
    expect(siteLanguageOf(null)).toBe("en");
    expect(derivedHeadingOf(1, null, "fr")).toBe("Learn more");
  });
});

describe("a layer with no title and no text", () => {
  it("is not published, nor its button, with no layer 2", async () => {
    const { files } = await roundTrip([layer(1, { button_label: "More" })]);
    expect(files.map((f) => f.path)).toEqual([`telar-content/spreadsheets/${SLUG}.csv`]);
    expect(files[0].content).not.toContain("More");
  });

  it("as layer 1 under a published layer 2, is written with its button label as its title", async () => {
    const { files } = await roundTrip([layer(1, { button_label: "More" }), layer(2, { content: "Deeper text" })]);
    const layerFiles = layerFilesOf(files);
    expect(Object.values(layerFiles)).toContain('---\ntitle: "More"\n---\n\n');
    // Layer 2 is reachable: layer 1's file is named, with its button.
    const csv = files[0].content;
    expect(csv).toContain("More");
    expect(csv).toContain(`${SLUG}-more.md`);
  });

  it.each([
    ["en", "Learn more"],
    ["es", "Saber más"],
  ])("as layer 1 with no button label, is headed by the %s default label", async (lang, heading) => {
    const { files } = await roundTrip([layer(1), layer(2, { content: "Deeper text" })], lang);
    expect(Object.values(layerFilesOf(files))).toContain(`---\ntitle: ${JSON.stringify(heading)}\n---\n\n`);
  });

  it("comes back from the import with no title", async () => {
    for (const [lang, label] of [["en", "More"], ["en", null], ["es", null]] as const) {
      const { layers } = await roundTrip([layer(1, { button_label: label }), layer(2, { content: "Deeper text" })], lang);
      expect(layers.find((l) => l.layer_number === 1)?.title, `${lang} ${label}`).toBeUndefined();
    }
  });

  it("publishes the same files again after the round trip", async () => {
    const layers = [layer(1, { button_label: "More" }), layer(2, { content: "Deeper text" })];
    const once = await renderStoryFiles(SLUG, [mediaStep(1)], layers, "en");
    const rows = rowsFromContent(await parseCommittedStory(SLUG, once));
    if ("unreadable" in rows) throw new Error(JSON.stringify(rows.unreadable));
    expect(await renderStoryFiles(SLUG, rows.stepRows, rows.layerRows, "en")).toEqual(once);
  });

  it("compares equal to its own files", async () => {
    const layers = [layer(1, { button_label: "More" }), layer(2, { content: "Deeper text" })];
    const files = await renderStoryFiles(SLUG, [mediaStep(1)], layers, "es");
    const d1 = await canonicalForCompareFromD1(SLUG, [mediaStep(1)], layers);
    expect(await canonicalForCompareFromFiles(SLUG, files[0].content, layerFilesOf(files))).toEqual(d1);
    if (!d1.readable) throw new Error(JSON.stringify(d1.reason));
    expect(d1.steps[0].layers.find((l) => l.layer_number === 1)?.title).toBe("");
  });
});

describe("an authored title", () => {
  it("is kept through a round trip", async () => {
    const { layers } = await roundTrip([layer(1, { title: "Context", button_label: "More" }), layer(2, { content: "Deeper" })]);
    expect(layers.find((l) => l.layer_number === 1)?.title).toBe("Context");
  });

  it("equal to the derived heading on a layer 1 with text is kept", async () => {
    const { layers } = await roundTrip([
      layer(1, { title: "More", button_label: "More", content: "Some text" }),
      layer(2, { content: "Deeper" }),
    ]);
    expect(layers.find((l) => l.layer_number === 1)?.title).toBe("More");
  });

  it("equal to the derived heading on a panel of title alone with no layer 2 is kept, so the panel stays published", async () => {
    const { files, layers } = await roundTrip([layer(1, { title: "More", button_label: "More" })]);
    expect(Object.keys(layerFilesOf(files))).toHaveLength(1);
    expect(layers.find((l) => l.layer_number === 1)?.title).toBe("More");
  });

  it("equal to the derived heading on a layer 2 with no text is kept", async () => {
    const { layers } = await roundTrip([
      layer(1, { content: "Text" }),
      layer(2, { title: "Go deeper", button_label: null }),
    ]);
    expect(layers.find((l) => l.layer_number === 2)?.title).toBe("Go deeper");
  });

  it("other than the layer's own label or a default label, on a layer 1 with no text, is kept", async () => {
    const { layers } = await roundTrip([layer(1, { title: "Context", button_label: "More" }), layer(2, { content: "Deeper" })], "es");
    expect(layers.find((l) => l.layer_number === 1)?.title).toBe("Context");
  });

  it("equal to a default label, on a layer 1 with no text whose button has a label, is kept: the site would derive the label", async () => {
    for (const title of ["Learn more", "Saber más"]) {
      const { layers } = await roundTrip([layer(1, { title, button_label: "More" }), layer(2, { content: "Deeper" })], "en");
      expect(layers.find((l) => l.layer_number === 1)?.title, title).toBe(title);
    }
  });

  it("equal to the heading the site derives is read as none, the same on D1's side of a comparison as on the files'", async () => {
    for (const [title, label] of [["Learn more", null], ["Saber más", ""], ["More", "More"]] as const) {
      const layers = [layer(1, { title, button_label: label }), layer(2, { content: "Deeper" })];
      const { files, layers: read } = await roundTrip(layers, "en");
      expect(read.find((l) => l.layer_number === 1)?.title, title).toBeUndefined();
      const d1 = await canonicalForCompareFromD1(SLUG, [mediaStep(1)], layers);
      expect(await canonicalForCompareFromFiles(SLUG, files[0].content, layerFilesOf(files))).toEqual(d1);
      if (!d1.readable) throw new Error(JSON.stringify(d1.reason));
      expect(d1.steps[0].layers.find((l) => l.layer_number === 1)?.title, title).toBe("");
    }
  });
});

describe("mapStoryCsv, as sync and the dashboard's restore read a new story", () => {
  const row = (layer1: string, button = "") => ({
    step: "1",
    object: "obj",
    question: "Q",
    answer: "A",
    layer1_button: button,
    layer1_content: layer1,
    layer2_button: "",
    layer2_content: "Deeper",
  });
  const layer1Title = (r: Record<string, string>) => mapStoryCsv([r], 0).layers.find((l) => l.layer_number === 1)?.title;

  it("reads the heading the site derives on an empty layer 1 as no title: its button's label, else a default label in any shipped language", () => {
    expect(layer1Title(row('---\ntitle: "Learn more"\n---\n\n'))).toBeUndefined();
    expect(layer1Title(row('---\ntitle: "Saber más"\n---\n\n'))).toBeUndefined();
    expect(layer1Title(row('---\ntitle: "More"\n---\n\n', "More"))).toBeUndefined();
  });

  it("keeps any other title, a default label under a button with a label of its own included", () => {
    expect(layer1Title(row('---\ntitle: "Context"\n---\n\n', "More"))).toBe("Context");
    expect(layer1Title(row('---\ntitle: "Learn more"\n---\n\n', "More"))).toBe("Learn more");
  });
});

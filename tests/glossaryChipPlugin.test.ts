// @vitest-environment jsdom
/**
 * glossaryChipPlugin.test.ts — contract spec for the `[[term]]` chip
 * decoration builder.
 *
 * The contract is `buildChipDecorations(state, resolutionMap)` returning a
 * CodeMirror `DecorationSet`:
 *   - resolved term + cursor OUTSIDE the [[...]] range → a replace decoration
 *     whose widget exposes the resolved TITLE (not the slug);
 *   - cursor INSIDE the range → NO replace decoration for that range (raw
 *     brackets revealed — reveal on range overlap);
 *   - unresolved term_id (absent from the map) → a mark decoration with class
 *     `cm-glossary-unresolved` (wavy underline), NOT a chip;
 *   - the regex captures group 1 as term_id for the alias form
 *     `[[term_id|display]]`.
 *
 * `@vitest-environment jsdom` mirrors `livePreviewPlugin.test.ts`: building
 * decorations is headless, but a chip widget's `toDOM()` constructs a DOM
 * element, so jsdom is provided to keep the widget contract assertable. The
 * global vitest environment is `node` (vitest.config.ts), so this pragma is
 * the per-file opt-in.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import type { Decoration, DecorationSet } from "@codemirror/view";
import { buildChipDecorations } from "~/components/ui/markdown-editor/glossaryChipPlugin";

interface DecoHit {
  from: number;
  to: number;
  spec: Decoration["spec"];
}

// Flatten a DecorationSet into plain {from,to,spec} records for assertions.
function collect(set: DecorationSet): DecoHit[] {
  const hits: DecoHit[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    hits.push({ from: cursor.from, to: cursor.to, spec: cursor.value.spec });
    cursor.next();
  }
  return hits;
}

const RESOLUTION = new Map<string, string>([["mit-a", "Mita"]]);

describe("buildChipDecorations — resolved term, cursor OUTSIDE range", () => {
  it("produces a replace decoration whose widget exposes the resolved TITLE", () => {
    const doc = "See [[mit-a]] here.";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length }, // cursor at end, outside the link
    });

    const set = buildChipDecorations(state, RESOLUTION);
    const from = doc.indexOf("[[mit-a]]");
    const to = from + "[[mit-a]]".length;

    const chip = collect(set).find((h) => h.from === from && h.to === to);
    expect(chip).toBeDefined();
    // Replace decorations carry a widget; the widget must expose the title.
    const widget = chip!.spec.widget as { title?: string; termId?: string } | undefined;
    expect(widget).toBeDefined();
    expect(widget!.title).toBe("Mita");
    expect(widget!.title).not.toBe("mit-a"); // title, not the slug
  });
});

describe("buildChipDecorations — cursor INSIDE range reveals raw brackets", () => {
  it("produces NO replace decoration for the range the cursor sits inside", () => {
    const doc = "See [[mit-a]] here.";
    const from = doc.indexOf("[[mit-a]]");
    const state = EditorState.create({
      doc,
      selection: { anchor: from + 3 }, // head within [from,to]
    });

    const set = buildChipDecorations(state, RESOLUTION);
    const to = from + "[[mit-a]]".length;
    const chip = collect(set).find(
      (h) => h.from === from && h.to === to && h.spec.widget,
    );
    expect(chip).toBeUndefined();
  });
});

describe("buildChipDecorations — unresolved term", () => {
  it("produces a `cm-glossary-unresolved` mark, not a chip widget", () => {
    const doc = "A [[ghost]] term.";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
    });

    const set = buildChipDecorations(state, RESOLUTION);
    const from = doc.indexOf("[[ghost]]");
    const to = from + "[[ghost]]".length;

    const hit = collect(set).find((h) => h.from === from && h.to === to);
    expect(hit).toBeDefined();
    expect(hit!.spec.class).toBe("cm-glossary-unresolved");
    expect(hit!.spec.widget).toBeUndefined(); // a mark, not a replace-with-widget
  });
});

describe("buildChipDecorations — display-alias regex", () => {
  it("resolves the chip by group-1 term_id for `[[term_id|display]]`", () => {
    const doc = "An alias [[mit-a|the mita]] here.";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
    });

    const set = buildChipDecorations(state, RESOLUTION);
    const from = doc.indexOf("[[mit-a|the mita]]");
    const to = from + "[[mit-a|the mita]]".length;

    const chip = collect(set).find((h) => h.from === from && h.to === to);
    expect(chip).toBeDefined();
    const widget = chip!.spec.widget as { title?: string } | undefined;
    expect(widget?.title).toBe("Mita"); // resolved via group-1 term_id "mit-a"
  });
});

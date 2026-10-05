/**
 * What the story renderer guarantees, and the layer-file reading it relies on.
 *
 * The renderer guarantees two things, each tested over generated rows:
 *
 * 1. Compare equality, for any D1 rows, edge whitespace included: the compare
 *    form of the rows equals the compare form of the files they render to.
 *    The import strips cell edges on both sides alike. The change check
 *    relies on this.
 * 2. Byte idempotence, render(parse(render(x))) = render(x), for rows whose
 *    text cells, once cleaned, have no whitespace at their edges. CSV cells
 *    are published as they stand, because the framework reads an answer
 *    unstripped (the framework's scripts/telar/processors/stories.py:666-676)
 *    and the import strips it.
 *
 * The import's row filter drops rows the framework keeps, so a
 * section step with no text is outside both, and the generator does not make
 * one.
 *
 * The layer-file reading follows the framework's `_split_frontmatter`
 * (the framework's scripts/telar/markdown.py:64-132): a leading `---` block is
 * front matter only when it carries a `title:` key, and otherwise it is
 * content the framework shows.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { guardAmbiguousRuleLines, renderStoryFiles } from "~/lib/publish.server";
import type { StoryLayerRow, StoryStepRow } from "~/lib/publish.server";
import { cleanText } from "~/lib/unsafe-text";
import { pythonStrip } from "~/lib/column-mapping";
import {
  canonicalForCompareFromD1,
  canonicalForCompareFromFiles,
  parseCommittedStory,
  parseStoryFiles,
  rowsFromContent,
} from "~/lib/story-content.server";

const SLUG = "story";

async function renderTwice(stepRows: StoryStepRow[], layerRows: StoryLayerRow[]) {
  const once = await renderStoryFiles(SLUG, stepRows, layerRows);
  const rows = rowsFromContent(await parseCommittedStory(SLUG, once));
  if ("unreadable" in rows) throw new Error(JSON.stringify(rows.unreadable));
  const twice = await renderStoryFiles(SLUG, rows.stepRows, rows.layerRows);
  return { once, twice };
}

function mediaStep(id: number, extra: Partial<StoryStepRow> = {}): StoryStepRow {
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
    ...extra,
  };
}

function layer(stepId: number, n: number, content: string | null, extra: Partial<StoryLayerRow> = {}): StoryLayerRow {
  return { step_id: stepId, layer_number: n, title: null, button_label: "More", content, ...extra };
}

// ---------------------------------------------------------------------------
// Layer files: front matter only where the framework takes it (markdown.py)
// ---------------------------------------------------------------------------

const CSV = "step,object,question,answer,layer1_button,layer1_content\n1,telar-placeholder,q,a,More,panel.md\n";

function panel(intro: string): string {
  return `---\nsummary: ${intro}\n---\n\nThe panel's text.\n`;
}

describe("a layer file whose leading block has no title: key", () => {
  it("imports the block as content, as the framework shows it (markdown.py:105-111)", async () => {
    const steps = await parseStoryFiles(SLUG, CSV, { "panel.md": panel("Old introduction") });
    expect(steps[0].layers[0].content).toBe("---\nsummary: Old introduction\n---\n\nThe panel's text.");
    expect(steps[0].layers[0].title).toBeUndefined();
  });

  it("compares different when only the block changed", async () => {
    const old = await canonicalForCompareFromFiles(SLUG, CSV, { "panel.md": panel("Old introduction") });
    const edited = await canonicalForCompareFromFiles(SLUG, CSV, { "panel.md": panel("New introduction") });
    expect(old.readable && edited.readable).toBe(true);
    expect(edited).not.toEqual(old);
  });

  // Compatibility check: this held before the framework's rule was ported,
  // and has to go on holding.
  it("compatibility: still reads a block with a title: key as front matter", async () => {
    const steps = await parseStoryFiles(SLUG, CSV, {
      "panel.md": "---\ntitle: A panel\nsummary: x\n---\n\nThe panel's text.\n",
    });
    expect(steps[0].layers[0]).toMatchObject({ title: "A panel", content: "The panel's text." });
  });

  it("reads a closing fence with nothing after it as no front matter, as the framework's pattern does", async () => {
    const steps = await parseStoryFiles(SLUG, CSV, { "panel.md": "---\ntitle: A panel\n---" });
    expect(steps[0].layers[0]).toMatchObject({ title: undefined, content: "---\ntitle: A panel\n---" });
  });
});

// ---------------------------------------------------------------------------
// Layer titles: _split_frontmatter's title, fallback included (markdown.py)
// ---------------------------------------------------------------------------

/** A story whose one layer is the inline cell `cell`. */
function inlineCsv(cell: string): string {
  const quoted = `"${cell.replace(/"/g, '""')}"`;
  return `step,object,question,answer,layer1_button,layer1_content\n1,telar-placeholder,q,a,More,${quoted}\n`;
}

function titled(block: string): string {
  return `---\n${block}\n---\n\nThe panel's text.\n`;
}

describe("a layer title the YAML does not type as a string", () => {
  // markdown.py:126-131: a title that parses to anything but a string is the
  // TITLE_PATTERN capture, the text as typed.
  it("is the text as typed, in a layer file and in an inline cell", async () => {
    const file = await parseStoryFiles(SLUG, CSV, { "panel.md": titled("title: [one]") });
    expect(file[0].layers[0]).toMatchObject({ title: "[one]", content: "The panel's text." });

    const inline = await parseStoryFiles(SLUG, inlineCsv(titled("title: [one]")), {});
    expect(inline[0].layers[0]).toMatchObject({ title: "[one]", content: "The panel's text." });
  });

  // TITLE_PATTERN's `\s*` crosses the line end, so an empty `title:` takes the
  // next line as its capture; the YAML reads the title as null, not a string.
  it("takes the next line for an empty title:, as the framework's pattern does", async () => {
    const file = await parseStoryFiles(SLUG, CSV, { "panel.md": titled("title:\nsummary: next") });
    expect(file[0].layers[0]).toMatchObject({ title: "summary: next", content: "The panel's text." });

    const inline = await parseStoryFiles(SLUG, inlineCsv(titled("title:\nsummary: next")), {});
    expect(inline[0].layers[0]).toMatchObject({ title: "summary: next" });
  });

  it("compares different when only such a title changed, in a layer file and in an inline cell", async () => {
    const one = await canonicalForCompareFromFiles(SLUG, CSV, { "panel.md": titled("title: [one]") });
    const two = await canonicalForCompareFromFiles(SLUG, CSV, { "panel.md": titled("title: [two]") });
    expect(one.readable && two.readable).toBe(true);
    expect(two).not.toEqual(one);

    const inlineOne = await canonicalForCompareFromFiles(SLUG, inlineCsv(titled("title: [one]")), {});
    const inlineTwo = await canonicalForCompareFromFiles(SLUG, inlineCsv(titled("title: [two]")), {});
    expect(inlineOne.readable && inlineTwo.readable).toBe(true);
    expect(inlineTwo).not.toEqual(inlineOne);
  });
});

// ---------------------------------------------------------------------------
// Whether a layer title is a string, decided as PyYAML's SafeLoader decides it
// ---------------------------------------------------------------------------

async function layerTitleOf(block: string): Promise<string | undefined> {
  const steps = await parseStoryFiles(SLUG, CSV, { "panel.md": titled(block) });
  return steps[0].layers[0]?.title ?? undefined;
}

describe("a layer title typed as PyYAML types it (YAML 1.1)", () => {
  it.each([
    ["title: yes # note", "yes # note"],
    ["title: &label yes", "&label yes"],
    ["title: on # one", "on # one"],
    ["title: 1:20 # time", "1:20 # time"],
  ])("%s is the text as typed", async (block, expected) => {
    expect(await layerTitleOf(block)).toBe(expected);
  });

  it("compares different when only the comment of a 1.1 boolean changed", async () => {
    const one = await canonicalForCompareFromFiles(SLUG, CSV, { "panel.md": titled("title: yes # one") });
    const two = await canonicalForCompareFromFiles(SLUG, CSV, { "panel.md": titled("title: yes # two") });
    expect(one.readable && two.readable).toBe(true);
    expect(two).not.toEqual(one);
  });

  // One per resolver SafeLoader registers (PyYAML 6.0.3 yaml/resolver.py:170-219).
  // A trailing comment separates the value YAML reads from the text as typed.
  it.each([
    ["bool", "title: No # c", "No # c"],
    ["int, sexagesimal", "title: 190:20:30 # c", "190:20:30 # c"],
    ["float, sexagesimal", "title: 190:20:30.15 # c", "190:20:30.15 # c"],
    ["null", "title: ~ # c", "~ # c"],
    ["timestamp", "title: 2024-05-01 # c", "2024-05-01 # c"],
    ["merge", "title: << # c", "<< # c"],
    ["value", "title: = # c", "= # c"],
  ])("%s: the text as typed", async (_resolver, block, expected) => {
    expect(await layerTitleOf(block)).toBe(expected);
  });

  it("reads a quoted yes as a string", async () => {
    expect(await layerTitleOf('title: "yes" # c')).toBe("yes");
  });

  it("reads !!str yes as a string", async () => {
    expect(await layerTitleOf("title: !!str yes # c")).toBe("yes");
  });
});

// ---------------------------------------------------------------------------
// The compare form: a title only where the writer fixed the block's meaning
// ---------------------------------------------------------------------------

/** The step CSV states, as D1 holds it. */
const CSV_STEP = mediaStep(1, { question: "q", answer: "a" });

function compareBlock(block: string) {
  return canonicalForCompareFromFiles(SLUG, CSV, { "panel.md": titled(block) });
}

describe("the compare form of a layer's front matter", () => {
  // Inputs each edited in a way the framework displays
  // (checked with the framework's Python environment, PyYAML 6.0.3). The $ case and the
  // three construction errors were read as equal by 2854263b's port.
  it.each([
    ["the $ case", 'title: ! "1\\n"', 'title: ! "1\\x0a"'],
    ["a !!str sequence elsewhere", 'title: "a \\"q\\" b"\nother: !!str [one]', 'title: "a \\x22q\\x22 b"\nother: !!str [one]'],
    ["a !!binary elsewhere", 'title: "a \\"q\\" b"\nother: !!binary a', 'title: "a \\x22q\\x22 b"\nother: !!binary a'],
    ["a !!omap elsewhere", 'title: "a \\"q\\" b"\nother: !!omap [one]', 'title: "a \\x22q\\x22 b"\nother: !!omap [one]'],
    // 2854263b's port read both as "!!str"; the framework shows "!!str" and "".
    ["a tagged empty scalar beside a construction error", "title: !!str\nother: =", "title: !!str"],
    // 2854263b's port read both as "!!str {=: Hello}"; the framework shows
    // "Hello" and "!!str {=: Hello}".
    ["a mapping read as a string through =", "title: !!str {=: Hello}", 'title: "!!str {=: Hello}"'],
  ])("%s: an edit compares different", async (_case, before, after) => {
    const a = await compareBlock(before);
    const b = await compareBlock(after);
    expect(a.readable && b.readable).toBe(true);
    expect(b).not.toEqual(a);
  });

  // Checks that an edit still shows. 2854263b compared these different too; no
  // edit it read as equal was found that the framework displays differently
  // (a tagged block scalar at the end differs only by a trailing line break,
  // and the port read every alias-after-comment shape tried as the framework
  // does).
  it.each([
    ["a tagged empty scalar", "title: !!str", "title: !!str x"],
    ["a tagged block scalar at the end of the block", "title: !!str |\n  Alpha", "title: !!str |\n  Beta"],
    ["an alias after a comment", "base: &b Hello\ntitle: # c\n  *b", "base: &b Goodbye\ntitle: # c\n  *b"],
    ["a mapping read as a string through =, value edited", "title: !!str {=: Hello}", "title: !!str {=: Goodbye}"],
  ])("still shows an edit to %s", async (_case, before, after) => {
    const a = await compareBlock(before);
    const b = await compareBlock(after);
    expect(a.readable && b.readable).toBe(true);
    expect(b).not.toEqual(a);
  });

  // Compatibility check: holds under 2854263b's port as well.
  it("compatibility: compares a block in the writer's form by its title", async () => {
    const title = 'A "quoted" panel: yes\\no';
    const rows = [CSV_STEP];
    const layers = [layer(1, 1, "The panel's text.", { title })];
    const d1 = await canonicalForCompareFromD1(SLUG, rows, layers);
    const github = await compareBlock(`title: ${JSON.stringify(title)}`);
    expect(d1.readable).toBe(true);
    expect(github).toEqual(d1);
  });

  // Accepted: an unusual block that means what D1's title says still compares
  // different, because only the writer's own form is read for its meaning.
  it.each([["plain", "title: A panel"], ["single-quoted", "title: 'A panel'"]])(
    "compares a %s block that means D1's title as different",
    async (_style, block) => {
      const d1 = await canonicalForCompareFromD1(SLUG, [CSV_STEP], [
        layer(1, 1, "The panel's text.", { title: "A panel" }),
      ]);
      const writer = await compareBlock('title: "A panel"');
      expect(writer).toEqual(d1);
      expect(await compareBlock(block)).not.toEqual(d1);
    },
  );
});

describe("the import's PyYAML port", () => {
  // Python's $ also matches before a final newline, so "1\n" is an int to
  // the int resolver and the framework shows the capture.
  it("types a bare-tagged \"1\\n\" as an int, as Python's $ does", async () => {
    expect(await layerTitleOf('title: ! "1\\n"')).toBe('! "1\\n');
  });
});

/**
 * The framework's own answers, from `layer-titles/generate.py` run with
 * the framework's interpreter (the command is in that file). A case the
 * framework raises on is left out: it shows no panel at all.
 */
describe("layer titles against the framework's _split_frontmatter", () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, "fixtures/story-canonical/layer-titles/titles.json"), "utf8"),
  ) as { pyyaml: string; cases: Array<{ block: string; title?: string; body?: string; error?: string }> };

  it("was generated with the PyYAML the resolvers are ported from", () => {
    expect(fixture.pyyaml).toBe("6.0.3");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(50);
  });

  it.each(fixture.cases.filter((c) => !c.error).map((c) => [c.block, c] as const))(
    "%j",
    async (_block, c) => {
      const steps = await parseStoryFiles(SLUG, CSV, { "panel.md": `---\n${c.block}\n---\n\nBody.\n` });
      const layer = steps[0].layers[0];
      expect(layer.title ?? "").toBe(c.title);
      expect(layer.content ?? "").toBe(c.body);
    },
  );
});

// ---------------------------------------------------------------------------
// A layer with a title and no body is a panel (R-A7)
// ---------------------------------------------------------------------------

function csvWithButton(button: string): string {
  return `step,object,question,answer,layer1_button,layer1_content\n1,telar-placeholder,q,a,${button},panel.md\n`;
}

describe("a layer whose file holds only a title", () => {
  // The framework shows a panel when its title or its text is non-empty:
  // the Layer 1 trigger (the framework's _includes/story-step.html:66), the
  // Layer 2 trigger (assets/js/telar-story/panels.js:292) and the keyboard
  // checks (panels.js:360-376). _split_frontmatter gives ("Alpha", "") here.
  const RAW = (t: string) => `---\ntitle: ${t}\n---\n`;
  const WRITER = (t: string) => `---\ntitle: ${JSON.stringify(t)}\n---\n\n`;
  it.each([
    ["raw/raw", RAW("Alpha"), RAW("Beta")],
    ["writer/writer", WRITER("Alpha"), WRITER("Beta")],
    ["raw/writer", RAW("Alpha"), WRITER("Beta")],
  ])("%s: a title edit compares different, with and without a button label", async (_pairing, before, after) => {
    for (const button of ["More", ""]) {
      const a = await canonicalForCompareFromFiles(SLUG, csvWithButton(button), { "panel.md": before });
      const b = await canonicalForCompareFromFiles(SLUG, csvWithButton(button), { "panel.md": after });
      expect(a.readable && b.readable, button).toBe(true);
      expect(b, `button ${JSON.stringify(button)}`).not.toEqual(a);
    }
  });

  it("is published from D1, and compares equal to its own files", async () => {
    const rows = [mediaStep(1)];
    const layers = [layer(1, 1, null, { title: "Alpha" })];
    const files = await renderStoryFiles(SLUG, rows, layers);
    const md = files.find((f) => f.path.endsWith(".md"));
    expect(md?.content).toBe('---\ntitle: "Alpha"\n---\n\n');
    expect(files[0].content).toContain(md!.path.split("/").pop());

    const layerFiles: Record<string, string> = {};
    for (const f of files.slice(1)) layerFiles[f.path.slice("telar-content/texts/stories/".length)] = f.content;
    const d1 = await canonicalForCompareFromD1(SLUG, rows, layers);
    expect(await canonicalForCompareFromFiles(SLUG, files[0].content, layerFiles)).toEqual(d1);
    if (!d1.readable) throw new Error(JSON.stringify(d1.reason));
    expect(d1.steps[0].layers).toEqual([
      { layer_number: 1, title: "Alpha", button_label: "More", content: "", frontmatter: "" },
    ]);
  });

  // Accepted: the framework's `title != ""` (story-step.html:66) would render
  // an empty trigger for a blank title; the Compositor publishes panels with
  // visible text only, so a blank title is no panel and no content.
  it.each([["blank", "   "], ["U+FFFE-only", "\uFFFE"]])(
    "with a %s title and no body, publishes no layer",
    async (_kind, title) => {
      const files = await renderStoryFiles(SLUG, [mediaStep(1)], [layer(1, 1, null, { title })]);
      expect(files.map((f) => f.path)).toEqual([`telar-content/spreadsheets/${SLUG}.csv`]);
    },
  );

  it("compares title: \"\" and title: \" \" with no body as equal, as accepted", async () => {
    const empty = await canonicalForCompareFromFiles(SLUG, csvWithButton("More"), { "panel.md": '---\ntitle: ""\n---\n\n' });
    const space = await canonicalForCompareFromFiles(SLUG, csvWithButton("More"), { "panel.md": '---\ntitle: " "\n---\n\n' });
    expect(empty.readable && space.readable).toBe(true);
    expect(space).toEqual(empty);
  });

  it("with only a button label, is not a panel and is not published", async () => {
    const files = await renderStoryFiles(SLUG, [mediaStep(1)], [layer(1, 1, null, { title: null })]);
    expect(files.map((f) => f.path)).toEqual([`telar-content/spreadsheets/${SLUG}.csv`]);
  });
});

// ---------------------------------------------------------------------------
// Layer filenames never collide
// ---------------------------------------------------------------------------

describe("layer filenames", () => {
  // Step 3's title collides with step 1's, and its fallback
  // name is the name step 2's title already took.
  const rows = [mediaStep(1), mediaStep(2), mediaStep(3)];
  const layers = [
    layer(1, 1, "", { title: "X" }),
    layer(2, 1, "Second body", { title: "step3 layer1" }),
    layer(3, 1, "Third body", { title: "X" }),
  ];

  it("gives every layer of a story its own path", async () => {
    const files = await renderStoryFiles(SLUG, rows, layers);
    const paths = files.filter((f) => f.path.endsWith(".md")).map((f) => f.path);
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
  });

  it("shows an edit to the layer whose name a fallback would have taken", async () => {
    const files = await renderStoryFiles(SLUG, rows, layers);
    const layerFiles: Record<string, string> = {};
    for (const f of files.slice(1)) {
      layerFiles[f.path.slice("telar-content/texts/stories/".length)] = f.content.replace("Second body", "Second body, edited");
    }
    const d1 = await canonicalForCompareFromD1(SLUG, rows, layers);
    const edited = await canonicalForCompareFromFiles(SLUG, files[0].content, layerFiles);
    expect(edited.readable).toBe(true);
    expect(edited).not.toEqual(d1);
  });
});

// ---------------------------------------------------------------------------
// The rule guard reads CRLF as a line end
// ---------------------------------------------------------------------------

describe("the rule guard and CRLF", () => {
  it("separates a CRLF rule from its text with a CRLF blank line, and changes nothing else", () => {
    expect(guardAmbiguousRuleLines("text\r\n---\r\nmore")).toBe("text\r\n\r\n---\r\nmore");
    expect(guardAmbiguousRuleLines("text\n---\nmore")).toBe("text\n\n---\nmore");
    expect(guardAmbiguousRuleLines("text\r\n\r\n---\r\nmore")).toBe("text\r\n\r\n---\r\nmore");
  });

  it("makes a CRLF body and an LF body compare equal", async () => {
    const lf = await canonicalForCompareFromD1(SLUG, [mediaStep(1)], [layer(1, 1, "text\n---\nmore")]);
    const crlf = await canonicalForCompareFromD1(SLUG, [mediaStep(1)], [layer(1, 1, "text\r\n---\r\nmore")]);
    expect(lf.readable).toBe(true);
    expect(crlf).toEqual(lf);
  });
});

// ---------------------------------------------------------------------------
// render(parse(render(x))) = render(x)
// ---------------------------------------------------------------------------

describe("the renderer is idempotent", () => {
  it("drops a whitespace-only layer body on the first render, as the parse would", async () => {
    const { once, twice } = await renderTwice([mediaStep(1)], [layer(1, 1, "  \n\t ")]);
    expect(twice).toEqual(once);
    expect(once.map((f) => f.path)).toEqual([`telar-content/spreadsheets/${SLUG}.csv`]);
  });

  it("reads a media step whose object cleans or strips away as the parse will", async () => {
    for (const object_id of [" ", "\uFFFE"]) {
      const rows = [mediaStep(1, { object_id, question: "A step", answer: "Its text" })];
      const files = await renderStoryFiles(SLUG, rows, []);
      const d1 = await canonicalForCompareFromD1(SLUG, rows, []);
      const github = await canonicalForCompareFromFiles(SLUG, files[0].content, {});
      expect(d1.readable, JSON.stringify(object_id)).toBe(true);
      expect(github, JSON.stringify(object_id)).toEqual(d1);
    }
    const { once, twice } = await renderTwice([mediaStep(1, { object_id: "\uFFFE", question: "A step" })], []);
    expect(twice).toEqual(once);
  });

  it("guards a rule that cleaning makes", async () => {
    const { once, twice } = await renderTwice([mediaStep(1)], [layer(1, 1, "text\n-￾--\nmore")]);
    expect(twice).toEqual(once);
    expect(once[1].content).toContain("text\n\n---\nmore");
  });

  // A consistency property: it holds for any publisher that the parse reads
  // back the same way, including the one before R-A7. The fixed cases above
  // pin what the framework displays.
  it("holds over generated rows whose text cells have no edge whitespace", async () => {
    const random = seeded(0x7e1364);
    // What the cases reached, so a generator that stopped producing a shape
    // fails here rather than passing on easier input.
    const seen = { cases: 0, objectless: 0, titleOnly: 0, rule: 0, crlfLayer: 0, cleanedRule: 0, blankBody: 0, buttonOnly: 0, unplaced: 0, section: 0 };
    for (let i = 0; i < 600; i++) {
      const { stepRows, layerRows } = generateStory(random);
      if (!withoutEdgeWhitespace(stepRows, layerRows)) continue;
      seen.cases++;
      if (stepRows.some((s) => s.kind === "media" && pythonStrip(cleanText(s.object_id ?? "")) === "")) seen.objectless++;
      const { once, twice } = await renderTwice(stepRows, layerRows);
      expect(twice, `case ${i}: ${JSON.stringify({ stepRows, layerRows })}`).toEqual(once);

      const bodies = once.filter((f) => f.path.endsWith(".md")).map((f) => f.content);
      if (bodies.some((b) => /\n\r?\n---/.test(b.slice(b.indexOf("\n---\n") + 5)))) seen.rule++;
      if (bodies.some((b) => b.includes("\r\n"))) seen.crlfLayer++;
      if (layerRows.some((l) => (l.content ?? "").includes("-\uFFFE--"))) seen.cleanedRule++;
      if (layerRows.some((l) => l.content !== null && l.content.trim() === "")) seen.blankBody++;
      if (layerRows.some((l) => !(l.content ?? "").trim() && !(l.title ?? "").trim() && l.button_label)) seen.buttonOnly++;
      if (layerRows.some((l) => !(l.content ?? "").trim() && (l.title ?? "").trim())) seen.titleOnly++;
      if (stepRows.some((s) => s.kind === "media" && s.x === null)) seen.unplaced++;
      if (stepRows.some((s) => s.kind === "section")) seen.section++;
    }
    for (const [shape, count] of Object.entries(seen)) expect(count, shape).toBeGreaterThan(10);
  });
});

describe("the compare form of rows equals the compare form of their files", () => {
  // A consistency property: it holds for any publisher that the parse reads
  // back the same way, including the one before R-A7. The fixed cases pin
  // what the framework displays. The unique-path check is not only
  // consistency: two files at one path is a defect whatever the parse reads.
  it("holds over generated rows, edge whitespace included", async () => {
    const random = seeded(0x364c0de);
    const seen = { cases: 0, edgeWhitespace: 0, objectless: 0, titleOnly: 0, collidingTitles: 0, stepShapedTitle: 0, rule: 0, cleanedRule: 0, blankBody: 0, buttonOnly: 0, unplaced: 0, section: 0 };
    for (let i = 0; i < 400; i++) {
      const { stepRows, layerRows } = generateStory(random);
      const files = await renderStoryFiles(SLUG, stepRows, layerRows);
      const paths = files.map((f) => f.path);
      expect(new Set(paths).size, `case ${i}: two files at one path`).toBe(paths.length);
      const csv = files[0].content;
      const layerFiles: Record<string, string> = {};
      for (const f of files.slice(1)) layerFiles[f.path.slice("telar-content/texts/stories/".length)] = f.content;

      const d1 = await canonicalForCompareFromD1(SLUG, stepRows, layerRows);
      const github = await canonicalForCompareFromFiles(SLUG, csv, layerFiles);
      expect(d1.readable, `case ${i}`).toBe(true);
      expect(github, `case ${i}: ${JSON.stringify({ stepRows, layerRows })}`).toEqual(d1);

      seen.cases++;
      if (!withoutEdgeWhitespace(stepRows, layerRows)) seen.edgeWhitespace++;
      const titles = layerRows.map((l) => (l.title ?? "").toLowerCase()).filter((t) => t.trim() !== "");
      if (new Set(titles).size < titles.length) seen.collidingTitles++;
      if (titles.some((t) => /^step \d+ layer \d+$|^step\d+ layer\d+$/.test(t))) seen.stepShapedTitle++;
      if (stepRows.some((s) => s.kind === "media" && pythonStrip(cleanText(s.object_id ?? "")) === "")) seen.objectless++;
      if (files.some((f) => f.path.endsWith(".md") && /\S\r?\n\r?\n---/.test(f.content))) seen.rule++;
      if (layerRows.some((l) => (l.content ?? "").includes("-\uFFFE--"))) seen.cleanedRule++;
      if (layerRows.some((l) => l.content !== null && l.content.trim() === "")) seen.blankBody++;
      if (layerRows.some((l) => !(l.content ?? "").trim() && !(l.title ?? "").trim() && l.button_label)) seen.buttonOnly++;
      if (layerRows.some((l) => !(l.content ?? "").trim() && (l.title ?? "").trim())) seen.titleOnly++;
      if (stepRows.some((s) => s.kind === "media" && s.x === null)) seen.unplaced++;
      if (stepRows.some((s) => s.kind === "section")) seen.section++;
    }
    for (const [shape, count] of Object.entries(seen)) expect(count, shape).toBeGreaterThan(10);
  });
});

/** Whether every CSV text cell, once cleaned, is free of edge whitespace. */
function withoutEdgeWhitespace(stepRows: StoryStepRow[], layerRows: StoryLayerRow[]): boolean {
  const cells = [
    ...stepRows.flatMap((s) => [s.object_id, s.page, s.question, s.answer, s.alt_text, s.clip_start, s.clip_end, s.loop]),
    ...layerRows.map((l) => l.button_label),
  ];
  return cells.every((v) => {
    const cleaned = cleanText(v ?? "");
    return pythonStrip(cleaned) === cleaned;
  });
}

/** mulberry32: a small seeded generator, so a failing case is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "", " ", "\t", "\n", "\r\n", "\n\n", "text", "more text", "---", "===", "----", "-￾--",
  "￾", "**bold**", "# heading", "title: x", "- item", "a,b", "\"quoted\"", " ",
];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

/** Text with `---` and every other piece at any position. */
function text(random: () => number): string {
  const n = Math.floor(random() * 7);
  let out = "";
  for (let i = 0; i < n; i++) out += pick(random, PIECES) + pick(random, ["", "\n", "\r\n", " "]);
  return out;
}

function maybe<T>(random: () => number, value: T): T | null {
  return random() < 0.5 ? value : null;
}

const EDGES = ["", "", " ", "\t", "  ", "\n", " \r\n", "\u00a0", "    "];

function generateStory(random: () => number): { stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] } {
  const count = 1 + Math.floor(random() * 4);
  // Half the stories put whitespace at the edges of their cells; the other
  // half keep every cell free of it, once cleaned, so the byte property has
  // cases to run on.
  const edgy = random() < 0.5;
  const edge = (v: string | null): string | null => {
    if (v === null) return v;
    if (edgy) return pick(random, EDGES) + v + pick(random, EDGES);
    const stripped = pythonStrip(v);
    const cleaned = cleanText(stripped);
    return pythonStrip(cleaned) === cleaned ? stripped : null;
  };
  const stepRows: StoryStepRow[] = [];
  const layerRows: StoryLayerRow[] = [];
  for (let id = 1; id <= count; id++) {
    const section = random() < 0.2;
    const objectId = edge(pick(random, [`object-${id}`, `object-${id}`, `object-${id}`, " ", "\uFFFE", " \uFFFE\t"]));
    const objectless = !section && pythonStrip(cleanText(objectId ?? "")) === "";
    stepRows.push({
      id,
      step_number: id,
      kind: section ? "section" : "media",
      // Whitespace-only and cleaned-away ids too: the parse reads such a step
      // as a section, and gives it a heading so the import keeps it.
      object_id: section ? null : objectId,
      x: maybe(random, Math.round(random() * 1000) / 1000),
      y: maybe(random, Math.round(random() * 1000) / 1000),
      zoom: maybe(random, 1 + Math.round(random() * 40) / 10),
      page: pick(random, [null, "", "1", "2"]),
      // A section card is kept by the import only when it has text.
      question: section || objectless
        ? (edge(`Heading ${text(random)}`) ?? "Heading")
        : edge(maybe(random, text(random))),
      answer: edge(maybe(random, text(random))),
      alt_text: edge(maybe(random, text(random))),
      clip_start: null,
      clip_end: null,
      loop: null,
      extra_columns: null,
    });
    for (const n of [1, 2]) {
      if (random() < 0.5) continue;
      layerRows.push({
        step_id: id,
        layer_number: n,
        // Title-only layers come from here and the empty bodies below.
        // Colliding titles, and titles slugged like a fallback name.
        title: pick(random, [null, "", "  ", "A title", "A title", "Panel￾", "￾", `Layer ${n}`,
          `step${1 + Math.floor(random() * 4)} layer${1 + Math.floor(random() * 2)}`,
          `Step ${1 + Math.floor(random() * 4)} Layer ${1 + Math.floor(random() * 2)}`]),
        button_label: edge(pick(random, [null, "", "  ", "More", "b￾"])),
        // Empty, whitespace-only and button-only layers all come from here.
        content: pick(random, [null, "", "  \n", text(random), text(random)]),
      });
    }
  }
  // Rows arrive in no particular order, as D1 returns them.
  return { stepRows: stepRows.sort(() => random() - 0.5), layerRows };
}

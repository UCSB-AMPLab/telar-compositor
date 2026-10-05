/**
 * The canonical content of a story: what two readings of it have to agree on
 * for the story to be the same story.
 *
 * Steps come in the order the framework renders them, not the order they were
 * handed in: `process_story` sorts by the numeric `step` value, stably
 * (the framework's scripts/telar/processors/stories.py:897-909). A sheet whose
 * steps the framework cannot pair with their content unambiguously is
 * unreadable rather than given a value: the browser finds a step's card and
 * panels by its `step` value, first match (assets/js/telar-story/panels.js:281,
 * navigation.js:599, card-pool.js:808), so a repeated value shows one step's
 * content in place of another's.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { canonicalRaw, contentFromRows, frameworkStepOrder } from "~/lib/story-canonical";
import type { CanonicalStory, StoryContentStep } from "~/lib/story-canonical";

function step(stepCell: string | undefined, question: string, extra: Partial<StoryContentStep> = {}): StoryContentStep {
  return {
    step: stepCell,
    kind: "media",
    object_id: "telar-placeholder",
    x: 0.5,
    y: 0.5,
    zoom: 1,
    page: undefined,
    question,
    answer: `${question} answer`,
    alt_text: undefined,
    clip_start: undefined,
    clip_end: undefined,
    loop: undefined,
    extra_columns: undefined,
    layers: [],
    ...extra,
  };
}

function readable(result: CanonicalStory) {
  if (!result.readable) throw new Error(`unreadable: ${JSON.stringify(result.reason)}`);
  return result;
}

async function questions(steps: StoryContentStep[]) {
  return readable(await canonicalRaw(steps)).steps.map((s) => s.question);
}

describe("step order: the framework's stable numeric sort (stories.py:897-909)", () => {
  it("orders by the step value, not by the row", async () => {
    expect(await questions([step("3", "c"), step("1", "a"), step("2", "b")])).toEqual(["a", "b", "c"]);
  });

  it("orders numerically, not as text", async () => {
    expect(await questions([step("10", "ten"), step("9", "nine")])).toEqual(["nine", "ten"]);
  });

  it("reads gaps as nothing but order", async () => {
    expect(await questions([step("30", "c"), step("1", "a"), step("7", "b")])).toEqual(["a", "b", "c"]);
  });

  it("places a decimal step between its neighbours, as pd.to_numeric reads it", async () => {
    expect(await questions([step("2", "b"), step("1.5", "ab"), step("1", "a")])).toEqual(["a", "ab", "b"]);
  });

  it("gives the same content for a renumbered story", async () => {
    const a = readable(await canonicalRaw([step("1", "a"), step("2", "b")]));
    const b = readable(await canonicalRaw([step("10", "a"), step("20", "b")]));
    expect(b).toEqual(a);
  });

  it("answers the order as row indices", () => {
    expect(frameworkStepOrder([{ step: "2" }, { step: "1" }, { step: "3" }])).toEqual({ order: [1, 0, 2] });
  });
});

describe("what the framework cannot render unambiguously is unreadable", () => {
  it("a repeated step value, named in the reason", async () => {
    const result = await canonicalRaw([step("1", "a"), step("2", "b"), step("2", "c")]);
    expect(result.readable).toBe(false);
    if (!result.readable) expect(result.reason).toEqual({ code: "step_repeated", step: "2", earlier: "2" });
  });

  it("two spellings of one number, which the framework reads as one", async () => {
    const result = await canonicalRaw([step("2", "b"), step("2.0", "c")]);
    expect(result.readable).toBe(false);
  });

  it("a row with no step value", async () => {
    expect((await canonicalRaw([step("1", "a"), step("", "b")])).readable).toBe(false);
    expect((await canonicalRaw([step("1", "a"), step(undefined, "b")])).readable).toBe(false);
  });

  it("two values JavaScript tells apart and pandas does not", async () => {
    // pd.to_numeric reads both as 0.3; Number() keeps them distinct.
    const result = await canonicalRaw([step("0.3", "a"), step("0.30000000000000004", "b")]);
    expect(result.readable).toBe(false);
    if (!result.readable) expect(result.reason).toEqual({ code: "step_too_precise", step: "0.30000000000000004", row: 2 });
  });

  it("a decimal of more than 15 significant digits, alone", async () => {
    expect((await canonicalRaw([step("1.0000000000000001", "a")])).readable).toBe(false);
    expect((await canonicalRaw([step("0.123456789012345", "a")])).readable).toBe(true);
    expect((await canonicalRaw([step("123456789012345678", "a")])).readable).toBe(true);
  });

  it("a step value that is not a plain number", async () => {
    for (const cell of ["two", "1e2", " 3", "0x10", "٣"]) {
      const result = await canonicalRaw([step("1", "a"), step(cell, "b")]);
      expect(result.readable, cell).toBe(false);
      if (!result.readable) expect(result.reason, cell).toEqual({ code: "step_not_plain", step: cell, row: 2 });
    }
  });

  it("each reason is a code with the values it concerns, never text", async () => {
    const unreadableReasonOfSteps = async (steps: StoryContentStep[]) => {
      const result = await canonicalRaw(steps);
      return result.readable ? null : result.reason;
    };
    expect(await unreadableReasonOfSteps([step("2", "a"), step("2.0", "b")])).toEqual({ code: "step_repeated", step: "2.0", earlier: "2" });
    expect(await unreadableReasonOfSteps([step("1", "a"), step("", "b")])).toEqual({ code: "step_missing", row: 2 });
    expect(await unreadableReasonOfSteps([step("1.0000000000000001", "a")])).toEqual({ code: "step_too_precise", step: "1.0000000000000001", row: 1 });
    const layer = { layer_number: 1, title: "t", button_label: "b", content: "p" };
    expect(await unreadableReasonOfSteps([step("1", "a"), step("2", "b", { layers: [layer, layer] })])).toEqual({
      code: "layer_number_repeated",
      row: 2,
      layer: 1,
    });
  });
});

describe("line endings", () => {
  it("reads CRLF and a lone CR as \\n in every text field", async () => {
    const lf = step("1", "q\nq", {
      answer: "one\n\ntwo",
      alt_text: "alt\nalt",
      extra_columns: JSON.stringify({ note: "a\nb" }),
      layers: [{ layer_number: 1, title: "t", button_label: "b", content: "p\n\np" }],
    });
    const crlf = step("1", "q\r\nq", {
      answer: "one\r\n\r\ntwo",
      alt_text: "alt\ralt",
      extra_columns: JSON.stringify({ note: "a\r\nb" }),
      layers: [{ layer_number: 1, title: "t", button_label: "b", content: "p\r\n\r\np" }],
    });
    const a = readable(await canonicalRaw([lf]));
    const b = readable(await canonicalRaw([crlf]));
    expect(b.steps[0].answer).toBe("one\n\ntwo");
    expect(b.steps[0].layers[0].content).toBe("p\n\np");
    expect(b.hash).toBe(a.hash);
  });
});

describe("the hash", () => {
  const base = step("1", "q", {
    page: "2",
    alt_text: "alt",
    clip_start: "0:10",
    clip_end: "0:20",
    loop: "yes",
    extra_columns: JSON.stringify({ note: "n" }),
    layers: [
      { layer_number: 1, title: "one", button_label: "More", content: "first" },
      { layer_number: 2, title: "two", button_label: "Deeper", content: "second" },
    ],
  });

  it("is stable across calls, key order in the kept columns and empty spellings", async () => {
    const a = readable(await canonicalRaw([base]));
    const b = readable(await canonicalRaw([{ ...base }]));
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);

    const twoKeys = async (blob: string) => readable(await canonicalRaw([{ ...base, extra_columns: blob }]));
    expect((await twoKeys(JSON.stringify({ a: "1", b: "2" }))).hash).toBe(
      (await twoKeys(JSON.stringify({ b: "2", a: "1" }))).hash,
    );

    const empties = [undefined, null, ""];
    const hashes = new Set<string>();
    for (const v of empties) {
      hashes.add(readable(await canonicalRaw([{ ...base, alt_text: v, extra_columns: v }])).hash);
    }
    hashes.add(readable(await canonicalRaw([{ ...base, alt_text: "", extra_columns: "{}" }])).hash);
    expect(hashes.size).toBe(1);
  });

  const stepChanges: Array<[string, Partial<StoryContentStep>]> = [
    ["kind", { kind: "section" }],
    ["object_id", { object_id: "other" }],
    ["x", { x: 0.25 }],
    ["y", { y: 0.25 }],
    ["zoom", { zoom: 2 }],
    ["page", { page: "3" }],
    ["question", { question: "other" }],
    ["answer", { answer: "other" }],
    ["alt_text", { alt_text: "other" }],
    ["clip_start", { clip_start: "0:11" }],
    ["clip_end", { clip_end: "0:21" }],
    ["loop", { loop: "no" }],
    ["extra_columns", { extra_columns: JSON.stringify({ note: "other" }) }],
  ];

  it.each(stepChanges)("changes with the step's %s", async (_field, change) => {
    const a = readable(await canonicalRaw([base]));
    const b = readable(await canonicalRaw([{ ...base, ...change }]));
    expect(b.hash).not.toBe(a.hash);
  });

  const layerChanges: Array<[string, Record<string, unknown>]> = [
    ["layer_number", { layer_number: 3 }],
    ["title", { title: "other" }],
    ["button_label", { button_label: "other" }],
    ["content", { content: "other" }],
  ];

  it.each(layerChanges)("changes with a layer's %s", async (_field, change) => {
    const a = readable(await canonicalRaw([base]));
    const layers = [{ ...base.layers[0], ...change }, base.layers[1]];
    const b = readable(await canonicalRaw([{ ...base, layers }]));
    expect(b.hash).not.toBe(a.hash);
  });

  it("changes when two layers trade places", async () => {
    const a = readable(await canonicalRaw([base]));
    const [one, two] = base.layers;
    const swapped = [
      { ...two, layer_number: 1 },
      { ...one, layer_number: 2 },
    ];
    const b = readable(await canonicalRaw([{ ...base, layers: swapped }]));
    expect(b.hash).not.toBe(a.hash);
  });

  it("changes when two steps trade places", async () => {
    const a = readable(await canonicalRaw([step("1", "a"), step("2", "b")]));
    const b = readable(await canonicalRaw([step("1", "b"), step("2", "a")]));
    expect(b.hash).not.toBe(a.hash);
  });

  it("changes when a step is added", async () => {
    const a = readable(await canonicalRaw([step("1", "a")]));
    const b = readable(await canonicalRaw([step("1", "a"), step("2", "a")]));
    expect(b.hash).not.toBe(a.hash);
  });
});

describe("D1's rows as the raw form reads them", () => {
  it("takes steps and layers in order_key order, numbered by rank, whatever numbers they store", () => {
    const content = contentFromRows(
      [
        { id: 7, step_number: 1, order_key: "a1", question: "second" },
        { id: 8, step_number: 2, order_key: "a0", question: "first" },
      ],
      [
        { step_id: 8, layer_number: 1, order_key: "a1", title: "later" },
        { step_id: 8, layer_number: 2, order_key: "a0", title: "earlier" },
      ],
    );
    expect(content.map((s) => [s.step, s.question])).toEqual([["1", "first"], ["2", "second"]]);
    expect(content[0].layers.map((l) => [l.layer_number, l.title])).toEqual([[1, "earlier"], [2, "later"]]);
  });
});

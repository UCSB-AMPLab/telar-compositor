/**
 * An imported panel belongs to the step that stated it.
 *
 * It did not. A layer carried its step's index WITHIN its story as a negative
 * placeholder, and `importRepo` resolved that placeholder against a map keyed by
 * story index — so a step index was read as a story index. Panels landed on
 * whichever story sat at that position and every panel past the project's story
 * count was dropped. A single-story site kept only the panels on its first step.
 * `mapStoryCsv` runs once per story and discarded which story it ran for, so the
 * information needed to pair a layer correctly was not on the row at all.
 *
 * The fix is a shape, not a calculation: `step_id` is absent from a MappedLayer,
 * so the compiler refuses one whose step has not been resolved, and the parent
 * keys travel on the layer itself.
 *
 * These exercise the pairing rather than the SQL, because the pairing is where
 * it went wrong. They call `pairLayersWithSteps` — the function `importRepo`
 * itself calls — rather than a reimplementation of it: a test that replays the
 * algorithm it is checking passes whatever production does, which is how the
 * original defect survived. The resolution was extracted for exactly this
 * reason, being otherwise reachable only through a full import with GitHub and
 * a database behind it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { mapStoryCsv, pairLayersWithSteps } from "../app/lib/import.server";
import type { MappedLayer } from "../app/lib/import.server";
import { AUTHOR_ACTORS } from "../app/lib/authorship";

/** One CSV row per step, each carrying one panel naming its own step. */
function storyRows(tag: string, stepCount: number): Record<string, string>[] {
  return Array.from({ length: stepCount }, (_, i) => ({
    step: String(i + 1),
    object: "img",
    question: `${tag}-q${i + 1}`,
    layer1_button: "More",
    layer1_content: `${tag}-panel-step${i + 1}`,
  }));
}

/**
 * Call the real resolution, then report what landed where and what it dropped.
 *
 * `landed` reads the paired rows; `dropped` is derived by difference, since
 * `pairLayersWithSteps` simply omits what it cannot place — so a panel silently
 * vanishing is visible here rather than showing up as a shorter array nobody
 * counted.
 */
function pair(
  mapped: MappedLayer[],
  storyDbIdByPlaceholder: Map<number, number>,
  insertedSteps: Array<{ id: number; story_id: number; step_number: number }>,
): {
  landed: Array<{ content: string; storyId: number; stepId: number }>;
  dropped: string[];
} {
  const paired = pairLayersWithSteps(
    mapped,
    storyDbIdByPlaceholder,
    insertedSteps,
  );
  const stepToStory = new Map(insertedSteps.map((s) => [s.id, s.story_id]));
  const landed = paired.map((l) => ({
    content: String(l.content),
    storyId: stepToStory.get(l.step_id)!,
    stepId: l.step_id,
  }));
  const landedContent = new Set(landed.map((l) => l.content));
  const dropped = mapped
    .map((l) => String(l.content))
    .filter((c) => !landedContent.has(c));
  return { landed, dropped };
}

describe("pairing imported panels with their steps", () => {
  it("keeps every panel of a multi-story import on its own story and step", () => {
    // Two stories of three steps each — the case that used to send story A's
    // second panel to story B and drop both third panels.
    const a = mapStoryCsv(storyRows("A", 3), -1);
    const b = mapStoryCsv(storyRows("B", 3), -2);

    const storyDbIdByPlaceholder = new Map([[-1, 100], [-2, 200]]);
    const insertedSteps = [
      { id: 11, story_id: 100, step_number: 1 },
      { id: 12, story_id: 100, step_number: 2 },
      { id: 13, story_id: 100, step_number: 3 },
      { id: 21, story_id: 200, step_number: 1 },
      { id: 22, story_id: 200, step_number: 2 },
      { id: 23, story_id: 200, step_number: 3 },
    ];

    const { landed, dropped } = pair(
      [...a.layers, ...b.layers],
      storyDbIdByPlaceholder,
      insertedSteps,
    );

    expect(dropped).toEqual([]);
    expect(landed).toEqual([
      { content: "A-panel-step1", storyId: 100, stepId: 11 },
      { content: "A-panel-step2", storyId: 100, stepId: 12 },
      { content: "A-panel-step3", storyId: 100, stepId: 13 },
      { content: "B-panel-step1", storyId: 200, stepId: 21 },
      { content: "B-panel-step2", storyId: 200, stepId: 22 },
      { content: "B-panel-step3", storyId: 200, stepId: 23 },
    ]);
  });

  it("keeps every panel of a single-story import, past the first step", () => {
    // The narrowest case, and the one that made this worth fixing before the
    // contributions view: a site with one story used to lose every panel except
    // those on step one, because no story existed at index 1 or 2.
    const only = mapStoryCsv(storyRows("S", 4), -1);

    const { landed, dropped } = pair(
      only.layers,
      new Map([[-1, 500]]),
      [1, 2, 3, 4].map((n) => ({ id: 90 + n, story_id: 500, step_number: n })),
    );

    expect(dropped).toEqual([]);
    expect(landed.map((l) => l.stepId)).toEqual([91, 92, 93, 94]);
  });

  it("pairs on the step number the CSV states, not on row position", () => {
    // A sheet whose `step` cells are not 1..N in order. Position and number
    // diverge, and D1 stores the number — so pairing on position would put each
    // panel on a different step than the one that stated it.
    const rows = [
      { step: "7", object: "img", question: "q7", layer1_button: "M", layer1_content: "panel-for-7" },
      { step: "3", object: "img", question: "q3", layer1_button: "M", layer1_content: "panel-for-3" },
    ];
    const { steps, layers } = mapStoryCsv(rows, -1);

    expect(steps.map((s) => s.step_number)).toEqual([7, 3]);
    expect(layers.map((l) => l.stepNumber)).toEqual([7, 3]);

    const { landed, dropped } = pair(layers, new Map([[-1, 700]]), [
      { id: 71, story_id: 700, step_number: 7 },
      { id: 73, story_id: 700, step_number: 3 },
    ]);

    expect(dropped).toEqual([]);
    expect(landed).toEqual([
      { content: "panel-for-7", storyId: 700, stepId: 71 },
      { content: "panel-for-3", storyId: 700, stepId: 73 },
    ]);
  });

  it("carries both parent keys, because two consumers need different ones", () => {
    // D1 pairs on the step number it stores; the Durable Object's restore path
    // threads layers by position into the step array it was handed. Deriving
    // either from the other is where the pairing goes wrong, so both are stated.
    const rows = [
      { step: "7", object: "img", question: "q", layer1_button: "M", layer1_content: "p1" },
      { step: "3", object: "img", question: "q", layer1_button: "M", layer1_content: "p2" },
    ];
    const { layers } = mapStoryCsv(rows, -1);

    expect(layers.map((l) => l.stepNumber)).toEqual([7, 3]);
    expect(layers.map((l) => l.stepIndex)).toEqual([0, 1]);
  });

  it("keeps a step's two panels together on that step", () => {
    const rows: Record<string, string>[] = [
      { step: "1", object: "img", question: "q", layer1_button: "A", layer1_content: "first", layer2_button: "B", layer2_content: "second" },
      { step: "2", object: "img", question: "q", layer1_button: "C", layer1_content: "third" },
    ];
    const { layers } = mapStoryCsv(rows, -1);

    const { landed } = pair(layers, new Map([[-1, 800]]), [
      { id: 81, story_id: 800, step_number: 1 },
      { id: 82, story_id: 800, step_number: 2 },
    ]);

    expect(landed).toEqual([
      { content: "first", storyId: 800, stepId: 81 },
      { content: "second", storyId: 800, stepId: 81 },
      { content: "third", storyId: 800, stepId: 82 },
    ]);
    expect(layers.map((l) => l.layer_number)).toEqual([1, 2, 1]);
  });

  it("drops a panel whose story never made it into D1, rather than guessing", () => {
    // The honest failure: a story that failed to insert has no id to pair
    // against, and attaching its panels to some other story is what this fixes.
    const orphan = mapStoryCsv(storyRows("X", 2), -9);

    const { landed, dropped } = pair(orphan.layers, new Map([[-1, 100]]), [
      { id: 11, story_id: 100, step_number: 1 },
    ]);

    expect(landed).toEqual([]);
    expect(dropped).toEqual(["X-panel-step1", "X-panel-step2"]);
  });
});

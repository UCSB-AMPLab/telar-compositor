/**
 * The file set judges the story CSV it writes with the story column blockers,
 * on the steps and layers it read itself.
 *
 * The publish validates one read of the steps and layers and assembles from a
 * second. A step or a panel saved between the two can give the CSV written a
 * pair of columns the framework reads as one, which the validation never saw
 * and the build refuses. So the assembly re-runs the check on what it read,
 * and refuses the publish with nothing written (`StoryColumnsBlockedError`).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getFileAtRef, getSubtreeOids, listSubtreeEntries } = vi.hoisted(() => ({
  getFileAtRef: vi.fn(),
  getSubtreeOids: vi.fn(),
  listSubtreeEntries: vi.fn(),
}));

vi.mock("~/lib/db.server", async () => {
  const { fakeGetDb } = await import("./story-canonical-fakedb");
  return { getDb: vi.fn(() => fakeGetDb()) };
});
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getFileAtRef, getSubtreeOids, listSubtreeEntries, getFileContent: vi.fn(async () => null) };
});

import { StoryColumnsBlockedError, buildPublishFileSet } from "~/lib/publish.server";
import { STORY_ONLY_PUBLISH, importAsD1 } from "./story-canonical-fixtures";
import type { D1LayerRow, D1Story } from "./story-canonical-fixtures";
import { serveStory } from "./story-canonical-fakedb";

const SLUG = "historia";
const CSV = "step,object,x,y,zoom,question,answer\n1,obj-1,0.5,0.5,1,Q,A\n";

let story: D1Story;

/** The story with a second step, empty but for a kept cell whose column collides with step 1's. */
async function storyWithCollidingStep(): Promise<D1Story> {
  const imported = await importAsD1({ slug: SLUG, csv: CSV, layerFiles: {} });
  const [first] = imported.stepRows;
  const withExample = { ...first, extra_columns: JSON.stringify({ Example: "a" }) };
  const empty = {
    ...first,
    id: first.id + 1,
    step_number: 2,
    object_id: null,
    x: null,
    y: null,
    zoom: null,
    question: null,
    answer: null,
    extra_columns: JSON.stringify({ example: "b" }),
  };
  return { ...imported, stepRows: [withExample, empty] };
}

function panelOn(stepId: number): D1LayerRow {
  return { id: 900, step_id: stepId, layer_number: 1, title: null, button_label: null, content: "Panel" } as D1LayerRow;
}

beforeEach(async () => {
  vi.clearAllMocks();
  getSubtreeOids.mockResolvedValue({ ok: true, at: () => ({ kind: "absent" }) });
  getFileAtRef.mockResolvedValue({ status: "absent" });
  story = await storyWithCollidingStep();
});

describe("the file set's story column check", () => {
  it("writes the story when the colliding step is not written, having no content and no panel", async () => {
    serveStory(story);
    const files = await buildPublishFileSet({ ...STORY_ONLY_PUBLISH });
    expect(files.some((f) => f.path === `telar-content/spreadsheets/${SLUG}.csv`)).toBe(true);
  });

  it("refuses when a panel it read makes the colliding step written", async () => {
    serveStory({ ...story, layerRows: [panelOn(story.stepRows[1].id)] });
    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toBeInstanceOf(StoryColumnsBlockedError);
  });

  it("refuses when a step it read carries a column colliding with another written step's", async () => {
    serveStory({ ...story, stepRows: [story.stepRows[0], { ...story.stepRows[1], question: "Q2" }] });
    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({
      name: "StoryColumnsBlockedError",
      storyId: SLUG,
    });
  });
});

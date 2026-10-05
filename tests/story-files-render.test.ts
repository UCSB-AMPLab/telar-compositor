/**
 * A story's committed files come from one function, and the publish commits
 * exactly what it renders.
 *
 * The change check has to compare a story in D1 with the files on GitHub, and
 * that comparison is only sound if D1's side is rendered byte for byte as a
 * publish would write it. So the step CSV and the layer files are rendered by
 * one function that `buildPublishFileSet` also calls, and this file pins both:
 * the publish's story files for every fixture against a golden captured from
 * the publish before the function was factored out, and the function's output
 * against what the commit primitive would send.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", async () => {
  const { fakeGetDb } = await import("./story-canonical-fakedb");
  return { getDb: vi.fn(() => fakeGetDb()) };
});
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getFileAtRef: vi.fn(async () => ({ status: "absent" })),
    getFileContent: vi.fn(async () => null),
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});

import { buildPublishFileSet, renderStoryFiles } from "~/lib/publish.server";
import { cleanCommitContent } from "~/lib/commit.server";
import {
  STORY_ONLY_PUBLISH,
  importAsD1,
  isStoryFile,
  storyFixtures,
} from "./story-canonical-fixtures";
import type { D1Story } from "./story-canonical-fixtures";
import { serveStory } from "./story-canonical-fakedb";

const fixtures = storyFixtures();

/**
 * The fixtures the golden was captured for, from the publish as it stood
 * before `renderStoryFiles` existed. A fixture added later is covered by the
 * comparison with the publish below, not by the golden.
 */
const GOLDEN_FIXTURES = [
  "blank_template",
  "plantilla_en_blanco",
  "allegorical-woman",
  "colonial-landscapes",
  "colonial-landscapes-rules",
];

async function publishedStoryFiles(story: D1Story) {
  serveStory(story);
  const files = await buildPublishFileSet({ ...STORY_ONLY_PUBLISH });
  return files.filter((f) => isStoryFile(f.path, story.story.story_id));
}

beforeEach(() => serveStory(null));

describe("the story files a publish writes", () => {
  it("are byte-identical to the golden captured before the render was factored out", async () => {
    const out: Record<string, Array<{ path: string; content: string }>> = {};
    for (const name of GOLDEN_FIXTURES) {
      out[name] = await publishedStoryFiles(await importAsD1(fixtures[name]));
    }
    await expect(JSON.stringify(out, null, 2) + "\n").toMatchFileSnapshot(
      "./fixtures/story-canonical/publish-story-files.golden.json",
    );
  });
});

describe("renderStoryFiles", () => {
  it.each(Object.keys(fixtures))("renders %s exactly as the publish commits it", async (name) => {
    const story = await importAsD1(fixtures[name]);
    const committed = (await publishedStoryFiles(story)).map((f) => ({
      path: f.path,
      content: cleanCommitContent(f.path, f.content),
    }));

    const rendered = await renderStoryFiles(story.story.story_id, story.stepRows, story.layerRows);

    expect(rendered).toEqual(committed);
  });

  it("cleans what the commit would clean, so its bytes are the commit's", async () => {
    // Template text with the noncharacter a Telar build rejects written into
    // it, in a step answer, a layer body and a layer title.
    const story = await importAsD1(fixtures.blank_template);
    story.stepRows[0].answer = "answer￾";
    story.layerRows.push({
      id: 2000,
      step_id: story.stepRows[0].id,
      layer_number: 1,
      order_key: null,
      title: "Panel￾",
      button_label: null,
      content: "Body￾",
      created_by: null,
      last_edited_by: null,
      created_by_actor: null,
      updated_at: null,
    });
    const committed = (await publishedStoryFiles(story)).map((f) => ({
      path: f.path,
      content: cleanCommitContent(f.path, f.content),
    }));

    const rendered = await renderStoryFiles(story.story.story_id, story.stepRows, story.layerRows);

    expect(rendered).toEqual(committed);
    expect(rendered.map((f) => f.content).join("")).not.toContain("￾");
    expect(rendered.find((f) => f.path.endsWith(".md"))?.content).toContain("Body");
  });
});

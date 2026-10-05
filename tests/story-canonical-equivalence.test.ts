/**
 * The compare form of a story's content, on both sides of the comparison.
 *
 * The change check asks one question: does the Compositor's version of a story
 * differ from GitHub's? Both sides answer it through the same render and
 * parse: D1's rows rendered as a publish writes them and parsed back, and
 * GitHub's files parsed, rendered as a publish would write that parse, and
 * parsed again. A difference only the publisher would erase is then no
 * difference, and a story published and untouched since reads as unchanged.
 *
 * The raw form, D1's rows canonicalised with none of the publisher's
 * transformations, is the other job: its hash is what the collaboration object
 * checks its live maps against. The two agree except where the publisher
 * transforms something.
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

import { buildPublishFileSet } from "~/lib/publish.server";
import { cleanCommitContent } from "~/lib/commit.server";
import {
  canonicalForCompareFromD1,
  canonicalForCompareFromFiles,
  rawCanonicalFromD1,
} from "~/lib/story-content.server";
import type { CanonicalStory } from "~/lib/story-canonical";
import { STORY_ONLY_PUBLISH, importAsD1, storyFixtures } from "./story-canonical-fixtures";
import type { D1Story } from "./story-canonical-fixtures";
import { serveStory } from "./story-canonical-fakedb";
import Papa from "papaparse";

const fixtures = storyFixtures();
const names = Object.keys(fixtures);

/** What a publish of `story` commits, as the commit primitive sends it. */
async function committedFiles(story: D1Story) {
  serveStory(story);
  return (await buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).map((f) => ({
    path: f.path,
    content: cleanCommitContent(f.path, f.content),
  }));
}

function compareOfD1(story: D1Story): Promise<CanonicalStory> {
  return canonicalForCompareFromD1(story.story.story_id, story.stepRows, story.layerRows);
}

function hashOf(result: CanonicalStory): string {
  if (!result.readable) throw new Error(`unreadable: ${JSON.stringify(result.reason)}`);
  return result.hash;
}

beforeEach(() => serveStory(null));

describe("compare form: D1 against what publish commits", () => {
  it.each(names)("%s", async (name) => {
    const story = await importAsD1(fixtures[name]);
    const files = await committedFiles(story);
    const slug = story.story.story_id;
    const csv = files.find((f) => f.path === `telar-content/spreadsheets/${slug}.csv`)!.content;
    const layerFiles: Record<string, string> = {};
    for (const f of files) {
      if (f.path.startsWith("telar-content/texts/stories/")) {
        layerFiles[f.path.slice("telar-content/texts/stories/".length)] = f.content;
      }
    }

    const d1 = await compareOfD1(story);
    const github = await canonicalForCompareFromFiles(slug, csv, layerFiles);

    expect(d1.readable).toBe(true);
    expect(github).toEqual(d1);
  });

  it("covers the three cases the design names", async () => {
    const blank = await importAsD1(fixtures.blank_template);
    expect(blank.stepRows.some((s) => s.kind === "media" && s.object_id && s.x === null)).toBe(true);

    const rules = await importAsD1(fixtures["colonial-landscapes-rules"]);
    expect(rules.layerRows.some((l) => /\S\n---\n/.test(l.content ?? ""))).toBe(true);

    const crlf = await importAsD1(fixtures["allegorical-woman-crlf"]);
    expect(crlf.stepRows.some((s) => /\r\n/.test(s.answer ?? ""))).toBe(true);
  });
});

/** Fixtures whose layer files carry hand-authored front matter. */
const HAND_AUTHORED_BLOCKS = ["colonial-landscapes", "colonial-landscapes-rules"];

/** The steps with every layer's title and front matter text blanked. */
function withoutFrontMatter(story: CanonicalStory) {
  if (!story.readable) return story;
  return story.steps.map((s) => ({
    ...s,
    layers: s.layers.map((l) => ({ ...l, title: "", frontmatter: "" })),
  }));
}

describe("compare form: GitHub's own files against D1 imported from them", () => {
  // A template story on GitHub, with blank coordinates, compares equal to the
  // same story freshly imported into D1, which publishes 0.5/0.5/1; so does a
  // layer whose rule the publisher would separate from its text.
  it.each(names.filter((n) => !HAND_AUTHORED_BLOCKS.includes(n)))("%s compares equal", async (name) => {
    const fixture = fixtures[name];
    const github = await canonicalForCompareFromFiles(fixture.slug, fixture.csv, fixture.layerFiles);
    expect(github.readable).toBe(true);
    expect(github).toEqual(await compareOfD1(await importAsD1(fixture)));
  });

  // The demo's layer files open with `title: A Legal Proceeding`, a block not
  // in the writer's form, so each is compared as its text and differs from
  // D1's title until a publish writes the writer's form. That is the accepted
  // cost of comparing only writer-form blocks by title; nothing else differs.
  it.each(HAND_AUTHORED_BLOCKS)("%s differs in its layers' front matter only", async (name) => {
    const fixture = fixtures[name];
    const github = await canonicalForCompareFromFiles(fixture.slug, fixture.csv, fixture.layerFiles);
    const d1 = await compareOfD1(await importAsD1(fixture));
    expect(github.readable).toBe(true);
    expect(github).not.toEqual(d1);
    expect(withoutFrontMatter(github)).toEqual(withoutFrontMatter(d1));
  });
});

describe("compare form: GitHub's rows out of step order", () => {
  // The demo sheet with its data rows reversed: the framework renders it in
  // step order, so it is the same story as the sheet in order.
  it("compares equal to the sheet in order", async () => {
    const fixture = fixtures["allegorical-woman"];
    const table = Papa.parse<string[]>(fixture.csv, { skipEmptyLines: true }).data;
    const [header, instructions, ...data] = table;
    const reversed = Papa.unparse([header, instructions, ...data.reverse()]);

    const github = await canonicalForCompareFromFiles(fixture.slug, reversed, fixture.layerFiles);
    expect(github.readable).toBe(true);
    expect(github).toEqual(await compareOfD1(await importAsD1(fixture)));
  });
});

describe("raw form against compare form", () => {
  it.each(["blank_template", "plantilla_en_blanco", "colonial-landscapes-rules"])(
    "%s: the hashes differ, because the publisher transforms it",
    async (name) => {
      const story = await importAsD1(fixtures[name]);
      const raw = rawCanonicalFromD1(story.stepRows, story.layerRows);
      expect(hashOf(await raw)).not.toBe(hashOf(await compareOfD1(story)));
    },
  );

  it.each(["allegorical-woman", "allegorical-woman-crlf", "colonial-landscapes"])(
    "%s: the hashes are equal, because the publisher writes it as it stands",
    async (name) => {
      const story = await importAsD1(fixtures[name]);
      const raw = rawCanonicalFromD1(story.stepRows, story.layerRows);
      expect(hashOf(await raw)).toBe(hashOf(await compareOfD1(story)));
    },
  );
});

/**
 * The change check for a story whose recorded base (the revision last synced)
 * has two colliding columns that both hold values. The base is read
 * keeping the last of them rather than refused, and since it cannot say which
 * column the Compositor holds, a difference between D1 and HEAD is a conflict
 * with GitHub's version the default; HEAD, which an accept imports, is still
 * refused while it collides.
 *
 * `checkStoryContent` and `readStoriesForAccept` run against the real
 * `github.server` module and a stubbed `fetch` holding the commits' files.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Papa from "papaparse";
import { checkStoryContent, readStoriesForAccept } from "~/lib/story-content.server";
import type { StoryCheckInput, StoryContentCheck } from "~/lib/story-content.server";
import { __clearStoryBlobCacheForTest } from "~/lib/story-files.server";
import { storyMaskFor } from "~/lib/story-collided-fields.server";
import { renderStoryFiles } from "~/lib/publish.server";
import { buildThreeWayChanges, contentChoiceOf, emptySelections } from "~/components/features/dashboard/sync-changes";
import { withRowDefaults } from "~/lib/sync.server";
import type { FullSyncDiff, StorySyncChangedItem } from "~/lib/sync.server";
import { importAsD1, storyFixtures } from "./story-canonical-fixtures";
import type { D1Story } from "./story-canonical-fixtures";
import { SHEETS, TEXTS, addStoryCommit, emptyStoryRepo, storyRepoAnswer } from "./helpers/story-repo-fetch";
import type { StoryRepo } from "./helpers/story-repo-fetch";

// The demo's colonial-landscapes story, whose steps name layer files, as a
// publish of its import commits it.
const fixture = storyFixtures()["colonial-landscapes"];
const STORY = fixture.slug;
const PROJECT_CSV = `order,story_id,title\n1,${STORY},Colonial Landscapes\n`;

let repo: StoryRepo;
let d1: D1Story;
let published: Record<string, string>;

function storyCsv(files: Record<string, string>): string {
  return files[`${SHEETS}/${STORY}.csv`];
}

function input(): StoryCheckInput {
  return {
    token: "tok",
    owner: "owner",
    repo: "repo",
    base: "base",
    head: "head",
    d1: [{ story_id: STORY, loadRows: async () => ({ stepRows: d1.stepRows, layerRows: d1.layerRows }) }],
    deletedHere: [],
    headRowIds: new Set([STORY]),
  };
}

function conclusive(check: StoryContentCheck) {
  if (!check.conclusive) throw new Error(`inconclusive: ${check.reason}`);
  return check;
}

/** A three-way diff holding the story content check and its row changes, as the modal's builder takes it. */
function diffOf(check: StoryContentCheck, changedStories: StorySyncChangedItem[] = []): FullSyncDiff {
  return {
    objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null },
    stories: { newStories: [], changedStories, missingStories: [], content: check },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], removed: [], changed: [] },
    hasConflicts: true,
    classification: "three-way",
    suppressedEditorOnly: 0,
    unreadableFiles: [],
  };
}

/**
 * The story's project.csv row as the diff lists it when the author retitled it
 * in the Compositor and GitHub changed its subtitle: a conflict with the
 * author's row the default.
 */
function authorDefaultRow(): StorySyncChangedItem {
  return {
    story_id: STORY,
    title: "Retitled here",
    changedFields: ["title", "subtitle"],
    conflictFields: ["title", "subtitle"],
    conflict: true,
    d1Values: { title: "Retitled here", subtitle: "" },
    repoValues: { title: "Colonial Landscapes", subtitle: "Subtitled on GitHub" },
  };
}

/** The published layer files by the name the step CSV gives them. */
function publishedLayerFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, text] of Object.entries(published)) if (p.startsWith(`${TEXTS}/`)) out[p.slice(TEXTS.length + 1)] = text;
  return out;
}

/** `csv` with `column` set to `value` in the `nth` data row that holds a value there. */
function setCell(csv: string, column: string, nth: "first" | "last", value: string): string {
  const table = Papa.parse<string[]>(csv, { skipEmptyLines: true }).data;
  const at = table[0].indexOf(column);
  expect(at).toBeGreaterThan(-1);
  const rows = table.map((_, i) => i).filter((i) => i > 1 && table[i][at]);
  const row = nth === "first" ? rows[0] : rows[rows.length - 1];
  expect(row).toBeDefined();
  table[row][at] = value;
  return Papa.unparse(table, { newline: "\n" });
}

beforeEach(async () => {
  __clearStoryBlobCacheForTest();
  repo = emptyStoryRepo();
  vi.stubGlobal("fetch", vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const answer = await storyRepoAnswer(repo, req, init);
    if (!answer) throw new Error(`unexpected request: ${String(req)}`);
    return answer;
  }));
  d1 = await importAsD1(fixture);
  published = { [`${SHEETS}/project.csv`]: PROJECT_CSV };
  for (const f of await renderStoryFiles(d1.story.story_id, d1.stepRows, d1.layerRows)) published[f.path] = f.content;
});

afterEach(() => vi.unstubAllGlobals());

// The import refuses such a sheet, so D1 holds the story as published before
// the collision (`d1`, the demo story's import). Which of the base's columns
// that was cannot be read from the base, so a difference from HEAD is a
// conflict with GitHub's version the default, whichever column HEAD keeps.
describe("a recorded base whose step CSV has two colliding columns that both hold values", () => {
  interface Column {
    header: "question" | "pregunta";
    text: (question: string) => string;
  }
  const english: Column = { header: "question", text: (q) => q };
  const spanish: Column = { header: "pregunta", text: (q) => `(es) ${q}` };

  /**
   * The published step CSV with its question column given as `columns`: the
   * first in the column's place, the others appended. The second, bilingual
   * header row keeps its cell in each.
   */
  function withQuestions(...columns: Column[]): string {
    const table = Papa.parse<string[]>(storyCsv(published), { skipEmptyLines: true }).data;
    const question = table[0].indexOf("question");
    expect(question).toBeGreaterThan(-1);
    return Papa.unparse(
      table.map((row, i) => {
        const cell = (c: Column) => (i === 0 ? c.header : i === 1 || !row[question] ? row[question] : c.text(row[question]));
        const out = [...row];
        out[question] = cell(columns[0]);
        for (const c of columns.slice(1)) out.push(cell(c));
        return out;
      }),
      { newline: "\n" },
    );
  }

  async function commitStory(name: string, csv: string): Promise<void> {
    await addStoryCommit(repo, name, { ...published, [`${SHEETS}/${STORY}.csv`]: csv });
  }

  /** The one change listed, which must be a conflict with GitHub's version the default, and what accepting it imports. */
  async function expectRepoDefaultConflict(): Promise<void> {
    const check = conclusive(await checkStoryContent(input()));
    expect(check.changes).toHaveLength(1);
    const [change] = check.changes;
    expect(change).toMatchObject({ story_id: STORY, kind: "conflict", acceptByDefault: true });
    expect(contentChoiceOf(change, emptySelections())).toBe("repo");
    // What an untouched modal posts: GitHub's content for the story.
    const posted = buildThreeWayChanges(diffOf(check), emptySelections());
    expect(posted.stories.acceptContent).toEqual([STORY]);
    expect(posted.stories.contentExpected).toEqual({ [STORY]: change.expected });
    const rows = (await readStoriesForAccept(input(), "head", [STORY])).get(STORY)!;
    const questions = rows.stepRows.map((r) => r.question).filter((q) => q);
    expect(questions).toContain(spanish.text("Why was this map drawn?"));
    // The layers, read from the files the step CSV names, are D1's.
    const contents = (layers: Array<{ content: string | null }>) => layers.map((l) => l.content ?? "").sort();
    expect(contents(rows.layerRows)).toEqual(contents(d1.layerRows));
  }

  describe("the alias in first position, D1's column last", () => {
    beforeEach(() => commitStory("base", withQuestions(spanish, english)));

    it("HEAD keeps the first column: a conflict, GitHub's version the default", async () => {
      await commitStory("head", withQuestions(spanish));
      await expectRepoDefaultConflict();
    });

    // The accept takes the story's content and row on one choice, so a row
    // that defaults to the author's makes the author's the default for both.
    it("with the story's row a conflict defaulting to the author's: nothing of GitHub's posted", async () => {
      await commitStory("head", withQuestions(spanish));
      const check = withRowDefaults(conclusive(await checkStoryContent(input())), [authorDefaultRow()]);
      expect(check.conclusive && check.changes).toMatchObject([{ story_id: STORY, kind: "conflict", acceptByDefault: false }]);
      const posted = buildThreeWayChanges(diffOf(check, [authorDefaultRow()]), emptySelections());
      expect(posted.stories.acceptContent).toEqual([]);
      expect(posted.stories.accept).toEqual([]);
      expect(posted.stories.reject).toEqual([STORY]);
    });

    it("HEAD keeps the column whose values equal D1: nothing", async () => {
      await commitStory("head", withQuestions(english));
      const check = conclusive(await checkStoryContent(input()));
      expect(check.changes).toEqual([]);
      expect(check.suppressedEditorOnly).toBe(0);
    });
  });

  describe("D1's column first, the alias last", () => {
    beforeEach(() => commitStory("base", withQuestions(english, spanish)));

    it("HEAD keeps the last column: a conflict, GitHub's version the default", async () => {
      await commitStory("head", withQuestions(spanish));
      await expectRepoDefaultConflict();
    });

    it("HEAD keeps the column whose values equal D1: nothing", async () => {
      await commitStory("head", withQuestions(english));
      const check = conclusive(await checkStoryContent(input()));
      expect(check.changes).toEqual([]);
      expect(check.suppressedEditorOnly).toBe(0);
    });

    // The accept replaces the whole story, so an edit the Compositor made
    // outside the collided column keeps the Compositor's story the default.
    it("HEAD keeps the last column, and the Compositor edited another step's answer: the Compositor's story the default", async () => {
      const edited = d1.stepRows.findIndex((r) => r.answer);
      expect(edited).toBeGreaterThan(-1);
      d1 = {
        ...d1,
        stepRows: d1.stepRows.map((r, i) => (i === edited ? { ...r, answer: "Edited in the Compositor" } : r)),
      };
      await commitStory("head", withQuestions(spanish));
      const [change] = conclusive(await checkStoryContent(input())).changes;
      expect(change).toMatchObject({ story_id: STORY, kind: "conflict", acceptByDefault: false });
      expect(contentChoiceOf(change, emptySelections())).toBe("d1");
    });

    // HEAD changed only the collided column, to the value D1 already holds,
    // so what differs is the author's own edit: left to the author.
    /** D1 holding the last column's questions, with the first step's answer edited in the Compositor. */
    async function heldWithEditedAnswer(): Promise<D1Story> {
      const held = await importAsD1({ slug: STORY, csv: withQuestions(spanish), layerFiles: publishedLayerFiles() });
      const edited = held.stepRows.findIndex((r) => r.answer);
      return {
        ...held,
        stepRows: held.stepRows.map((r, i) => (i === edited ? { ...r, answer: "Edited in the Compositor" } : r)),
      };
    }

    it("HEAD keeps the column D1 holds, and the Compositor edited another step's answer: the author's edit, not listed", async () => {
      d1 = await heldWithEditedAnswer();
      await commitStory("head", withQuestions(spanish));
      const check = conclusive(await checkStoryContent(input()));
      expect(check.changes).toEqual([]);
      expect(check.suppressedEditorOnly).toBe(1);
    });

    // GitHub changed a field the collision does not feed, so the difference is
    // not the author's alone.
    it("as above, and GitHub edited the last step's answer: a conflict, the author's story the default", async () => {
      d1 = await heldWithEditedAnswer();
      await commitStory("head", setCell(withQuestions(spanish), "answer", "last", "Edited on GitHub"));
      const [change] = conclusive(await checkStoryContent(input())).changes;
      expect(change).toMatchObject({ story_id: STORY, kind: "conflict", acceptByDefault: false });
    });

    // A layer's front matter beyond its title is not in the rows, so the
    // layer files themselves are compared.
    it("as above, and GitHub added a key to a layer file's front matter: a conflict, the author's story the default", async () => {
      d1 = await heldWithEditedAnswer();
      const [name, text] = Object.entries(publishedLayerFiles())[0];
      const edited = text.replace(/^---\n/, "---\nicon: map\n");
      expect(edited).not.toBe(text);
      await addStoryCommit(repo, "head", {
        ...published,
        [`${SHEETS}/${STORY}.csv`]: withQuestions(spanish),
        [`${TEXTS}/${name}`]: edited,
      });
      const [change] = conclusive(await checkStoryContent(input())).changes;
      expect(change).toMatchObject({ story_id: STORY, kind: "conflict", acceptByDefault: false });
    });

    it("HEAD still colliding is refused, in the check and in the accept", async () => {
      const edited = withQuestions(english, spanish).replace("Why was this map drawn?", "Why was this map made?");
      await commitStory("head", edited);
      const [change] = conclusive(await checkStoryContent(input())).changes;
      expect(change).toMatchObject({ story_id: STORY, kind: "unreadable", acceptByDefault: false });
      expect(change.reason).toMatchObject({ code: "columns_collide" });
      expect((change.reason as { headers: string[] }).headers).toContain("pregunta");
      await expect(readStoriesForAccept(input(), "head", [STORY])).rejects.toMatchObject({
        name: "CollidingColumnsRefusal",
      });
    });
  });
});

// A collision on the object column cannot be masked: a step without its
// object is written with no coordinates, so a Compositor edit to one would be
// hidden. The author's story is the default.
describe("a recorded base whose object column collides", () => {
  function withObjeto(): string {
    const table = Papa.parse<string[]>(storyCsv(published), { skipEmptyLines: true }).data;
    const object = table[0].indexOf("object");
    expect(object).toBeGreaterThan(-1);
    return Papa.unparse(
      table.map((row, i) => [...row, i === 0 ? "objeto" : row[object]]),
      { newline: "\n" },
    );
  }

  it("with the Compositor's edit to one step's x: a conflict, the author's story the default", async () => {
    await addStoryCommit(repo, "base", { ...published, [`${SHEETS}/${STORY}.csv`]: withObjeto() });
    await addStoryCommit(repo, "head", published);
    const moved = d1.stepRows.findIndex((r) => r.object_id && r.x !== null);
    expect(moved).toBeGreaterThan(-1);
    d1 = { ...d1, stepRows: d1.stepRows.map((r, i) => (i === moved ? { ...r, x: 0.123 } : r)) };
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ story_id: STORY, kind: "conflict", acceptByDefault: false });
    expect(contentChoiceOf(change, emptySelections())).toBe("d1");
  });

  it("with GitHub's edit to one step's x: a conflict, the author's story the default, not left out", async () => {
    await addStoryCommit(repo, "base", { ...published, [`${SHEETS}/${STORY}.csv`]: withObjeto() });
    await addStoryCommit(repo, "head", { ...published, [`${SHEETS}/${STORY}.csv`]: setCell(storyCsv(published), "x", "first", "0.123") });
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ story_id: STORY, kind: "conflict", acceptByDefault: false });
  });
});

// A story whose row the author changed and whose content GitHub alone
// changed: the card's GitHub default gives way to the row's author default.
describe("a story whose row is a conflict defaulting to the author's", () => {
  it("with a step edited on GitHub only: nothing of GitHub's posted", async () => {
    await addStoryCommit(repo, "base", published);
    await addStoryCommit(repo, "head", { ...published, [`${SHEETS}/${STORY}.csv`]: setCell(storyCsv(published), "answer", "last", "Edited on GitHub") });
    const plain = conclusive(await checkStoryContent(input()));
    expect(plain.changes).toMatchObject([{ story_id: STORY, kind: "github-only", acceptByDefault: true }]);
    const check = withRowDefaults(plain, [authorDefaultRow()]);
    expect(check.conclusive && check.changes).toMatchObject([{ kind: "github-only", acceptByDefault: false }]);
    const posted = buildThreeWayChanges(diffOf(check, [authorDefaultRow()]), emptySelections());
    expect(posted.stories.acceptContent).toEqual([]);
    expect(posted.stories.accept).toEqual([]);
    expect(posted.stories.reject).toEqual([STORY]);
    // Taking GitHub's content on the card still takes the row with it.
    const chosen = { ...emptySelections(), storyContentChoices: { [STORY]: "repo" as const } };
    const taken = buildThreeWayChanges(diffOf(check, [authorDefaultRow()]), chosen);
    expect(taken.stories.acceptContent).toEqual([STORY]);
    expect(taken.stories.accept).toEqual([STORY]);
  });
});

// The fields a collided column of a step CSV feeds, read through the import's
// mapper; a column whose reach cannot be read leaves nothing to mask.
describe("the story fields a collided column feeds", () => {
  it("question feeds the step's question alone", () => {
    const mask = storyMaskFor(new Set(["question"]));
    expect(mask && [...mask.steps]).toEqual(["question"]);
    expect(mask && [...mask.layers]).toEqual([]);
  });

  it("x feeds the step's x, read as a number", () => {
    expect([...(storyMaskFor(new Set(["x"]))?.steps ?? [])]).toEqual(["x"]);
  });

  it("layer1_button feeds layer 1's button label", () => {
    expect([...(storyMaskFor(new Set(["layer1_button"]))?.layers ?? [])]).toEqual(["1.button_label"]);
  });

  it("a layer cell or the step column cannot be masked", () => {
    expect(storyMaskFor(new Set(["layer1_content"]))).toBeNull();
    expect(storyMaskFor(new Set(["step"]))).toBeNull();
  });

  it("the object column cannot be masked: it feeds the step's kind and object", () => {
    expect(storyMaskFor(new Set(["object"]))).toBeNull();
  });

  it("a custom column cannot be masked: it feeds the custom-column blob the accept writes whole", () => {
    expect(storyMaskFor(new Set(["catalogue_note"]))).toBeNull();
  });
});

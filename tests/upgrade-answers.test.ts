/**
 * The answers an upgrade to 1.8.0 lists: which steps, read
 * from which sheets, checked by publish's own answer check with the glossary
 * the build links them to, and which upgrades list them at all.
 *
 * @version v1.5.0-beta
 */
import { describe, expect, it } from "vitest";

import { answersPublishedDifferently, upgradeStartsCuttingAnswers } from "~/lib/upgrade-answers.server";
import { markdownGlossaryTerms, readGlossaryFiles } from "~/lib/upgrade-glossary-files.server";
import { runSheetStage, type FinalSheet } from "~/lib/upgrade-sheets.server";

const DIR = "telar-content/spreadsheets";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
/** One paragraph of n lines: n words of 52 characters. */
const lines = (n: number) => Array.from({ length: n }, () => "x".repeat(52)).join(" ");
/** An answer that fits with a short link at its end and not with a term title of ten words. */
const NEAR_BUDGET = `${lines(17)} ${"x".repeat(40)}`;
const storySheet = (text: string, name = "my-story.csv"): FinalSheet => ({ name, role: "story", text });
const listedChecks = (sheets: FinalSheet[]) =>
  answersPublishedDifferently(sheets).map((a) => [a.story, a.step, a.checks.map((c) => c.code)]);

describe("answersPublishedDifferently", () => {
  it("lists an answer over the budget as cut, naming the story by its sheet and the step by its cell", () => {
    expect(listedChecks([storySheet(`step,answer\n1,Short.\n2,${lines(19)}\n`)])).toEqual([["my-story", "2", ["step_answer_over_limit"]]]);
  });

  it("lists an answer holding a table as losing it", () => {
    const answer = '"Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"';
    expect(listedChecks([storySheet(`step,answer\n1,${answer}\n`)])).toEqual([["my-story", "1", ["step_answer_has_table"]]]);
  });

  it("lists an answer holding a list as flattened, with the kinds the message names", () => {
    const [listed] = answersPublishedDifferently([storySheet('step,answer\n3,"- one\n- two\n"\n')]);
    expect(listed.checks).toMatchObject([{ code: "step_answer_has_formatting", params: { number: "3", story: "my-story", kinds: ["list"] } }]);
  });

  it("lists nothing for a site whose answers publish as written, a blank answer among them", () => {
    expect(answersPublishedDifferently([storySheet("step,answer\n1,Here.\n2,   \n"), storySheet("step,question\n1,Why?\n", "other.csv")])).toEqual([]);
  });

  it("reads the answer under `respuesta` and the step under `paso`, the first column claiming each", () => {
    const sheet = storySheet(`paso,respuesta,answer\n4,${lines(19)},Short.\n`);
    expect(listedChecks([sheet])).toEqual([["my-story", "4", ["step_answer_over_limit"]]]);
  });

  it("counts a glossary link as the build counts it, by the term's title from the glossary sheet", () => {
    const answer = `${NEAR_BUDGET} [[t1]]`;
    const glossary: FinalSheet = {
      name: "glossary.csv",
      role: "glossary",
      text: `term_id,title,definition\nt1,${words(10)},A term.\n`,
    };
    expect(listedChecks([storySheet(`step,answer\n1,${answer}\n`)])).toEqual([]);
    expect(listedChecks([glossary, storySheet(`step,answer\n1,${answer}\n`)])).toEqual([["my-story", "1", ["step_answer_over_limit"]]]);
  });

  it("leaves out the project and objects sheets", () => {
    const long = `step,answer\n1,${lines(19)}\n`;
    expect(answersPublishedDifferently([{ name: "project.csv", role: "project", text: long }, { name: "objects.csv", role: "objects", text: long }])).toEqual([]);
  });
});

describe("a row wider than its header", () => {
  const dropped = (sheets: FinalSheet[]) => answersPublishedDifferently(sheets).map((a) => [a.story, a.step, a.cellsDropped, a.checks.length]);

  it("is listed for the cells it loses, on a story sheet", () => {
    expect(dropped([storySheet("step,answer\n1,Here.,SECRET\n2,Fine.\n")])).toEqual([["my-story", "1", true, 0]]);
  });

  it("is listed on a glossary sheet too", () => {
    const sheet: FinalSheet = { name: "glossary.csv", role: "glossary", text: "term_id,title,definition,answer\nt1,T,D,Here.,SECRET\n" };
    expect(dropped([sheet])).toEqual([["glossary", "unknown", true, 0]]);
  });

  it("is listed on a story sheet that has no answer column", () => {
    expect(dropped([storySheet("step,question\n1,Why?,SECRET\n")])).toEqual([["my-story", "1", true, 0]]);
  });

  it("is not listed when the cells past the header are empty", () => {
    expect(dropped([storySheet("step,answer\n1,Here.,  \n")])).toEqual([]);
  });
});

describe("a step's place in the editor", () => {
  const table = '"A.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"';
  const TABLE = "A.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const listed = (text: string, editor: (string | null)[] | null = null, story = "my-story") =>
    answersPublishedDifferently([storySheet(text)], editor === null ? new Map() : new Map([[story, editor]]));
  const position = (text: string, editor: (string | null)[] | null) => listed(text, editor).map((a) => a.position);

  it("is its place among the story's steps, not its number: a sheet numbered 3 with one row is step 1", () => {
    expect(position(`step,answer\n3,${table}\n`, [TABLE])).toEqual([1]);
  });

  it("counts from the step after a comment row, and sorts by number", () => {
    expect(position(`step,answer\n#note,x\n5,Fine.\n3,${table}\n`, ["Fine.", TABLE].reverse())).toEqual([1]);
  });

  it("leaves out a row the import does not make a step", () => {
    expect(position(`step,answer,question\n1,Fine.,\n2,,\n7,${table},\n`, ["Fine.", TABLE])).toEqual([2]);
  });

  it("gives no place to a step the editor does not list, and counts only the ones it does", () => {
    expect(position(`step,answer\n-1,${table}\n1,Short.,extra\n`, ["Short."])).toEqual([null, 1]);
  });

  it("links a story the project holds without a step when the step is beyond the editor's list", () => {
    const other = '"B.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"';
    const text = `step,answer\n1,${table}\n2,${other}\n`;
    expect(listed(text, [TABLE]).map((a) => [a.position, a.storyHeld])).toEqual([[1, true], [null, true]]);
  });

  it("is none for a story the project does not hold", () => {
    expect(listed(`step,answer\n3,${table}\n`).map((a) => [a.position, a.storyHeld])).toEqual([[null, false]]);
  });

  describe("after an unpublished reorder", () => {
    const text = `step,answer\n1,${table}\n2,Second.\n3,Third.\n`;

    it("finds the step by its answer in the editor's order, not by the sheet's number", () => {
      expect(position(text, ["Second.", "Third.", TABLE])).toEqual([3]);
    });

    it("gives no place to a step whose answer the editor holds more than once", () => {
      expect(position(text, ["Second.", TABLE, TABLE])).toEqual([null]);
    });

    it("gives no place to a step whose answer was edited as well, and still links its story", () => {
      const [only] = listed(text, ["Second.", "Third.", "Edited."]);
      expect([only.position, only.storyHeld]).toEqual([null, true]);
    });
  });
});

describe("upgradeStartsCuttingAnswers", () => {
  it.each([
    ["1.7.0", "v1.8.0", true],
    ["1.6.1", "v1.8.0-rc.1", true],
    ["unknown", "v1.8.0", true],
    ["1.8.0", "v1.8.1", false],
    ["1.6.1", "v1.7.0", false],
  ])("from %s to %s: %s", (site, target, expected) => {
    expect(upgradeStartsCuttingAnswers(site, target)).toBe(expected);
  });
});

describe("the sheets as the commit leaves them", () => {
  it("are the repaired text where the stage writes one, the chain's edit where it makes one, and the head's text otherwise", async () => {
    const files: Record<string, string> = {
      [`${DIR}/a.csv`]: "step,answer,note,Note\n1,Here.,,x\n",
      [`${DIR}/b.csv`]: "step,answer\n1,Old.\n",
      [`${DIR}/c.csv`]: "step,answer\n1,Head.\n",
    };
    const result = await runSheetStage({
      listEntries: async () => Object.keys(files).map((path) => ({ path, mode: "100644", sha: `s-${path}` })),
      readRaw: async (path) => files[path] ?? null,
      targetExists: async () => true,
      readLinkTarget: async () => "",
      readTabs: async () => {
        throw new Error("a site that reads no published sheet");
      },
      chainFiles: new Map([[`${DIR}/b.csv`, "step,answer\n1,New.\n"]]),
      targetTag: "v1.8.0",
      headOid: "head-1",
      challenge: null,
      submitted: null,
    });
    if (result.kind !== "ready") throw new Error(result.kind);
    expect(result.finalSheets).toEqual([
      { name: "a.csv", role: "story", text: "step,answer,Note\n1,Here.,x\n" },
      { name: "b.csv", role: "story", text: "step,answer\n1,New.\n" },
      { name: "c.csv", role: "story", text: "step,answer\n1,Head.\n" },
    ]);
  });
});

describe("a site with Markdown glossary files", () => {
  const answer = `${NEAR_BUDGET} [[t1]]`;
  const story = storySheet(`step,answer\n1,${answer}\n`);
  const termFile = (id: string, title: string) => ({ name: `${id}.md`, text: `---\nterm_id: ${id}\ntitle: ${title}\n---\nBody.\n` });

  it("counts a link as its term's title from the glossary file", () => {
    const files = [termFile("t1", words(10))];
    expect(answersPublishedDifferently([story]).length).toBe(0);
    expect(answersPublishedDifferently([story], new Map(), files).map((a) => a.checks.map((c) => c.code))).toEqual([["step_answer_over_limit"]]);
  });

  it("uses the glossary sheet, and not the files, when the site has one", () => {
    const glossary: FinalSheet = { name: "glossary.csv", role: "glossary", text: "term_id,title,definition\nt1,Short,A term.\n" };
    expect(answersPublishedDifferently([glossary, story], new Map(), [termFile("t1", words(10))])).toEqual([]);
  });

  it("reads no term from a file without front matter or a term_id, and a term shows its id without a title", () => {
    const terms = markdownGlossaryTerms([
      { name: "a.md", text: "term_id: a\nno front matter\n" },
      { name: "b.md", text: "---\ntitle: No id\n---\nBody\n" },
      { name: "c.md", text: "---\nterm_id: c\n---\nBody\n" },
    ]);
    expect([...terms]).toEqual([["c", "c"]]);
    expect(answersPublishedDifferently([story], new Map(), [{ name: "b.md", text: `---\ntitle: ${words(10)}\n---\nBody\n` }])).toEqual([]);
  });

  it("keeps the first file at an address", () => {
    expect([...markdownGlossaryTerms([termFile("Loom", "First"), termFile("loom", "Second")])]).toEqual([["Loom", "First"]]);
  });

  it("lists the folder's direct .md files from the tree, in name order, and from a listing when the tree is truncated", async () => {
    const entry = (path: string, type: "blob" | "tree" = "blob") => ({ path, mode: "100644", type, sha: "x" });
    const dir = "telar-content/texts/glossary";
    const tree = [entry(`${dir}/b.md`), entry(`${dir}/a.md`), entry(`${dir}/notes.txt`), entry(`${dir}/sub/c.md`), entry("other/d.md")];
    const read = async (path: string) => `text of ${path}`;
    expect((await readGlossaryFiles(tree, false, async () => [], read)).map((f) => f.name)).toEqual(["a.md", "b.md"]);
    expect((await readGlossaryFiles([], true, async () => [entry(`${dir}/z.md`)], read)).map((f) => f.name)).toEqual(["z.md"]);
  });

  it("orders file names by code point, as Python does", async () => {
    const entry = (path: string) => ({ path, mode: "100644", type: "blob" as const, sha: "x" });
    const dir = "telar-content/texts/glossary";
    const read = async (path: string) => `text of ${path}`;
    const names = (await readGlossaryFiles([entry(`${dir}/\u{1F600}.md`), entry(`${dir}/\uE000.md`)], false, async () => [], read)).map((f) => f.name);
    expect(names).toEqual(["\uE000.md", "\u{1F600}.md"]);
  });
});

/**
 * The upgrade's sheet stage: which sheets it reads, what it
 * writes, when it asks the author to choose, how a later prepare replays the
 * author's choices against the sheets as first read, and when the upgrade
 * leaves the recorded head where it was.
 *
 * @version v1.5.0-beta
 */
import { describe, expect, it } from "vitest";

import type { TreeEntry } from "~/lib/github.server";
import {
  fileAtHead,
  listSpreadsheetEntries,
  runSheetStage,
  type SheetStageInput,
  type SpreadsheetEntry,
} from "~/lib/upgrade-sheets.server";
import { UpgradeFileNotTextError, UpgradeFileUnreadableError } from "~/lib/upgrade-reads.server";

const DIR = "telar-content/spreadsheets";
const BOM = "﻿";

const file = (name: string, sha = `sha-${name}`): SpreadsheetEntry => ({ path: `${DIR}/${name}`, mode: "100644", sha });
const link = (name: string, sha: string): SpreadsheetEntry => ({ path: `${DIR}/${name}`, mode: "120000", sha });

interface Site {
  files: Record<string, string>;
  links?: Record<string, string>;
  chain?: Record<string, string>;
}

function sheetStageInput(site: Site, extra: Partial<SheetStageInput> = {}): SheetStageInput {
  const entries: SpreadsheetEntry[] = [
    ...Object.keys(site.files)
      .filter((path) => path.startsWith(`${DIR}/`) && !path.slice(DIR.length + 1).includes("/"))
      .map((path) => file(path.slice(DIR.length + 1))),
    ...Object.keys(site.links ?? {}).map((name) => link(name, `link-${name}`)),
  ];
  return {
    listEntries: async () => entries,
    readRaw: async (path) => site.files[path] ?? null,
    targetExists: async (path) => path in site.files,
    readLinkTarget: async (entry) => (site.links ?? {})[entry.path.slice(DIR.length + 1)],
    readTabs: async () => {
      throw new Error("a site that reads no published sheet");
    },
    chainFiles: new Map(Object.entries(site.chain ?? {})),
    targetTag: "v1.8.0",
    headOid: "head-1",
    challenge: null,
    submitted: null,
    ...extra,
  };
}

const story = (text: string): Site => ({ files: { [`${DIR}/my-story.csv`]: text } });

const EMPTY_DUPLICATE = "step,answer,note,Note\n1,Here.,,x\n";
const BOTH_HOLD = "step,answer,note,Note\n1,Here.,a,b\n";
const TWO_ROUNDS = "step,answer,note,Note,note\n1,Here.,a,b,c\n";

async function asked(site: Site, extra: Partial<SheetStageInput> = {}) {
  const result = await runSheetStage(sheetStageInput(site, extra));
  if (result.kind !== "needs_choices") throw new Error(`expected needs_choices, got ${result.kind}`);
  return result;
}

async function ready(site: Site, extra: Partial<SheetStageInput> = {}) {
  const result = await runSheetStage(sheetStageInput(site, extra));
  if (result.kind !== "ready") throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  return result;
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

describe("listSpreadsheetEntries", () => {
  const entry = (path: string, mode = "100644", type = "blob"): TreeEntry => ({ path, mode, type, sha: `s-${path}` }) as TreeEntry;

  it("takes the direct children of the spreadsheets directory from the tree, links included", async () => {
    const tree = [
      entry(`${DIR}/project.csv`),
      entry(`${DIR}/story.csv`, "120000"),
      entry(`${DIR}/old/story.csv`),
      entry(`${DIR}/old`, "040000", "tree"),
      entry("index.md"),
    ];
    const listed = await listSpreadsheetEntries(tree, false, async () => {
      throw new Error("not listed on its own when the tree is whole");
    });
    expect(listed.map((e) => [e.path, e.mode])).toEqual([
      [`${DIR}/project.csv`, "100644"],
      [`${DIR}/story.csv`, "120000"],
    ]);
  });

  it("lists the directory on its own when the tree was truncated, so no sheet is missed", async () => {
    const listed = await listSpreadsheetEntries([], true, async (dir) => {
      expect(dir).toBe(DIR);
      return [{ path: `${DIR}/story.csv`, mode: "100644", sha: "s1", type: "blob" } as TreeEntry];
    });
    expect(listed.map((e) => e.path)).toEqual([`${DIR}/story.csv`]);
  });

  it("stops by name when the directory cannot be listed", async () => {
    await expect(
      listSpreadsheetEntries([], true, async () => {
        throw new Error("500");
      }),
    ).rejects.toEqual(new UpgradeFileUnreadableError(DIR));
  });
});

// ---------------------------------------------------------------------------
// Repairs the framework makes on its own
// ---------------------------------------------------------------------------

describe("the repair, with nothing to choose", () => {
  it("a clean site writes nothing, advances the head and is clean", async () => {
    const result = await ready(story("step,answer\n1,Here.\n"));
    expect(result).toMatchObject({ writes: [], report: [], clean: true, advancesHead: true });
  });

  it("an empty duplicate column is dropped, written verbatim, and the head still advances", async () => {
    const result = await ready(story(EMPTY_DUPLICATE));
    expect(result.writes).toEqual([{ path: `${DIR}/my-story.csv`, content: "step,answer,Note\n1,Here.,x\n", verbatim: true }]);
    expect(result.report).toMatchObject([{ kind: "dropped", column: "note", keeper: "Note", chosen: false, file: `${DIR}/my-story.csv` }]);
    expect(result).toMatchObject({ clean: false, advancesHead: true });
  });

  it("writes the repaired text as the framework writes it, uncleaned: a byte-order mark, CRLF, quoting and a control character stay", async () => {
    const text = `${BOM}step,answer,"note",Note\r\n1,"Here, \u000b there",,x\r\n`;
    const result = await ready(story(text));
    expect(result.writes[0].content).toBe(`${BOM}step,answer,Note\r\n1,"Here, \u000b there",x\r\n`);
    expect(result.writes[0].verbatim).toBe(true);
  });

  it("keeps an empty first column under # so the step stays, and the head advances", async () => {
    const result = await ready(story("note,Note,step,answer\n,#kept,1,Here.\n"));
    expect(result.writes[0].content).toBe("#note,Note,step,answer\n,#kept,1,Here.\n");
    expect(result.report).toMatchObject([{ kind: "marked", column: "note", markedAs: "#note", chosen: false }]);
    expect(result.advancesHead).toBe(true);
  });

  it("repairs a story and a glossary sheet, each read with its own scope", async () => {
    const result = await ready({
      files: {
        [`${DIR}/glossary.csv`]: "term_id,title,definition,kind,tipo\ncord,Cord,A cord,term,\n",
        [`${DIR}/my-story.csv`]: EMPTY_DUPLICATE,
      },
    });
    expect(result.writes.map((w) => w.path)).toEqual([`${DIR}/glossary.csv`, `${DIR}/my-story.csv`]);
  });

  it("repairs the chain's project.csv as the commit would write it, cleaned and with its mark", async () => {
    const result = await ready({
      files: { [`${DIR}/project.csv`]: `${BOM}order,story_id,title,protected,privado\n1,s,T,yes,\n` },
      chain: { [`${DIR}/project.csv`]: "order,story_id,title,protected,privado,show_sections\n1,s,T\u0001,yes,,\n" },
    });
    expect(result.writes).toEqual([
      { path: `${DIR}/project.csv`, content: `${BOM}order,story_id,title,protected,show_sections\n1,s,T,yes,\n`, verbatim: true },
    ]);
  });

  it("reports a sheet pandas reads with another number of columns, writes nothing, and goes on", async () => {
    const result = await ready({
      files: { [`${DIR}/a.csv`]: `${BOM}${BOM}\na,a\n`, [`${DIR}/b.csv`]: EMPTY_DUPLICATE },
    });
    expect(result.report.map((e) => [e.kind, e.file])).toEqual([
      ["unreadable", `${DIR}/a.csv`],
      ["dropped", `${DIR}/b.csv`],
    ]);
    expect(result.writes.map((w) => w.path)).toEqual([`${DIR}/b.csv`]);
  });
});

describe("which sheets", () => {
  // The framework's own selection over this directory (sheets_to_check,
  // scripts/migrations/v180_sheets.py:360-395, run on a real directory with
  // these links): glosario.csv, objects.csv, proyecto.csv, story.csv. A
  // preferred name counts only when it is a file once its links are followed
  // (`os.path.isfile`); every name listed is otherwise in the running.
  it("picks the project and objects sheets as the framework does, links followed", async () => {
    const result = await ready({
      files: {
        [`${DIR}/proyecto.csv`]: "order,story_id,title,protected,privado\n1,s,T,yes,\n",
        [`${DIR}/objetos.csv`]: "object_id,title,medium,object_type\nm,A,Ink,\n",
        [`${DIR}/glosario.csv`]: "term_id,title\ncord,Cord\n",
        "data/objs.csv": "object_id,title,medium,object_type\nm,A,Ink,\n",
      },
      links: { "project.csv": "missing.csv", "objects.csv": "../../data/objs.csv", "story.csv": "nowhere.csv" },
    });
    expect(result.writes.map((w) => w.path)).toEqual(["data/objs.csv", `${DIR}/proyecto.csv`]);
    expect(result.report.map((line) => [line.kind, line.file])).toEqual([
      ["dropped", `${DIR}/objects.csv`],
      ["dropped", `${DIR}/proyecto.csv`],
      ["unreadable", `${DIR}/story.csv`],
    ]);
  });

  it.each(["v1.7.0", "v1.8.0-beta"])("reads and changes nothing for a target, %s, whose build reads colliding columns", async (targetTag) => {
    const reads: string[] = [];
    const input = sheetStageInput(story(BOTH_HOLD), { targetTag });
    const result = await runSheetStage({ ...input, readRaw: async (path) => (reads.push(path), null) });
    expect(result).toEqual({ kind: "ready", writes: [], report: [], clean: true, decisions: { sheets: null, rounds: [] }, advancesHead: true, finalSheets: [], tabsChecked: false, sheetsOff: null });
    expect(reads).toEqual([]);
  });

  it("never reads the other language's project sheet, which the build does not open", async () => {
    const reads: string[] = [];
    const input = sheetStageInput({
      files: {
        [`${DIR}/project.csv`]: "order,story_id,title,protected,privado\n1,s,T,yes,\n",
        [`${DIR}/proyecto.csv`]: "not read",
      },
    });
    const readRaw = input.readRaw;
    input.readRaw = async (path) => {
      reads.push(path);
      if (path.endsWith("proyecto.csv")) throw new UpgradeFileNotTextError(path);
      return readRaw(path);
    };
    const result = await runSheetStage(input);
    expect(result).toMatchObject({ kind: "ready", writes: [{ path: `${DIR}/project.csv` }] });
    expect(reads).toEqual([`${DIR}/project.csv`]);
  });

  it("does not list the sheets for a target whose build reads colliding columns", async () => {
    const input = sheetStageInput(story(BOTH_HOLD), { targetTag: "v1.7.0" });
    input.listEntries = async () => {
      throw new UpgradeFileUnreadableError(DIR);
    };
    expect(await runSheetStage(input)).toMatchObject({ kind: "ready", writes: [] });
  });

  it("stops by name when a sheet the tree lists cannot be read", async () => {
    const input = sheetStageInput(story(EMPTY_DUPLICATE));
    const listed = await input.listEntries();
    input.listEntries = async () => [...listed, file("gone.csv")];
    await expect(runSheetStage(input)).rejects.toEqual(new UpgradeFileUnreadableError(`${DIR}/gone.csv`));
  });
});

describe("fileAtHead", () => {
  const tree = [
    { path: "data/real.csv", mode: "100644", type: "blob", sha: "a" },
    { path: "data/link.csv", mode: "120000", type: "blob", sha: "b" },
    { path: "data", mode: "040000", type: "tree", sha: "c" },
  ] as TreeEntry[];

  it("answers from a whole tree without reading, and reads only behind a link or a truncated listing", async () => {
    const reads: string[] = [];
    const readRaw = async (path: string) => (reads.push(path), path === "data/link.csv" || path === "elsewhere.csv" ? "x" : null);
    const whole = fileAtHead(tree, false, readRaw);
    expect([await whole("data/real.csv"), await whole("data"), await whole("missing.csv")]).toEqual([true, false, false]);
    expect(reads).toEqual([]);
    expect(await whole("data/link.csv")).toBe(true);
    const truncated = fileAtHead(tree, true, readRaw);
    expect([await truncated("elsewhere.csv"), await truncated("gone.csv")]).toEqual([true, false]);
    expect(reads).toEqual(["data/link.csv", "elsewhere.csv", "gone.csv"]);
  });
});

describe("symbolic links", () => {
  it("repairs a link's target inside the site, and writes the target, as the framework writes through the link", async () => {
    const result = await ready({ files: { "data/real.csv": EMPTY_DUPLICATE }, links: { "my-story.csv": "../../data/real.csv" } });
    expect(result.writes).toEqual([{ path: "data/real.csv", content: "step,answer,Note\n1,Here.,x\n", verbatim: true }]);
    expect(result.report[0]).toMatchObject({ kind: "dropped", sheet: "my-story.csv", file: `${DIR}/my-story.csv` });
  });

  it("follows a link to a link", async () => {
    const result = await ready({
      files: { "data/real.csv": EMPTY_DUPLICATE },
      links: { "my-story.csv": "other.csv", "other.csv": "../../data/real.csv" },
    });
    expect(result.writes.map((w) => w.path)).toEqual(["data/real.csv"]);
  });

  it.each([
    ["out of the site", "../../../outside.csv"],
    ["absolute", "/etc/outside.csv"],
    ["dangling", "missing.csv"],
  ])("reports a link %s as unreadable, writes nothing, and goes on", async (_label, target) => {
    // A file at each path the link would name if it were resolved past the
    // site's root, or taken as relative, so reading one would show.
    const decoys = { "outside.csv": EMPTY_DUPLICATE, [`${DIR}/etc/outside.csv`]: EMPTY_DUPLICATE };
    const result = await ready({ files: decoys, links: { "my-story.csv": target } });
    expect(result.report).toMatchObject([{ kind: "unreadable", sheet: "my-story.csv" }]);
    expect(result.writes).toEqual([]);
  });

  it("reports a loop of links as unreadable", async () => {
    const result = await ready({ files: {}, links: { "a.csv": "b.csv", "b.csv": "a.csv" } });
    expect(result.report.map((e) => e.kind)).toEqual(["unreadable", "unreadable"]);
  });
});

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

describe("the stops", () => {
  it("a _metadata column stops the upgrade, naming the sheet and column", async () => {
    const result = await runSheetStage(sheetStageInput(story("step,answer,_metadata\n1,Here.,x\n")));
    expect(result).toEqual({ kind: "failed", error: "sheet_reserved_column", detail: { sheet: "my-story.csv", column: "_metadata" } });
  });

  it("a removal that would change the rows stops, naming the sheet, the column and why", async () => {
    const result = await runSheetStage(sheetStageInput(story("step,paso,note,Note\n1,,x,y\n,\n")));
    expect(result).toEqual({
      kind: "failed",
      error: "sheet_rows_changed",
      detail: { sheet: "my-story.csv", columns: "paso", reason: "rows_changed" },
    });
  });

  it("a removal that would keep the bilingual header row from being dropped deletes that row and goes on", async () => {
    const text = "note,Note,step,answer,object,extra\npregunta,,paso,respuesta,objeto,libre\n,x,1,Here.,map-1,e\n";
    const result = await ready(story(text));
    expect(result.writes.map((w) => w.content)).toEqual(["Note,step,answer,object,extra\nx,1,Here.,map-1,e\n"]);
    expect(result.report.map((e) => e.kind)).toEqual(["dropped", "header_row_deleted"]);
  });

  it("a removal that would keep the bilingual header row, and whose deletion would change a published cell, stops with that reason", async () => {
    const text = "note,Note,step,answer,object,extra\npregunta,,paso,respuesta,objeto,libre\n,x,1,001,map-1,e\n";
    const result = await runSheetStage(sheetStageInput(story(text)));
    expect(result).toMatchObject({ kind: "failed", error: "sheet_rows_changed", detail: { reason: "header_row", columns: "note" } });
  });

  it("an unsplittable sheet with something to repair stops, naming the columns to keep one of", async () => {
    const result = await runSheetStage(sheetStageInput(story('a,A\nx,"y"z\n')));
    expect(result).toEqual({ kind: "failed", error: "sheet_unreadable_for_repair", detail: { sheet: "my-story.csv", columns: "a, A" } });
  });

  it("a stop in any sheet comes before a choice in another", async () => {
    const result = await runSheetStage(
      sheetStageInput({ files: { [`${DIR}/a.csv`]: BOTH_HOLD, [`${DIR}/b.csv`]: "step,_metadata\n1,x\n" } }),
    );
    expect(result).toMatchObject({ kind: "failed", error: "sheet_reserved_column" });
  });
});

// ---------------------------------------------------------------------------
// The author's choices
// ---------------------------------------------------------------------------

describe("choices", () => {
  it("asks about a group in which two columns hold values, with its columns by first-read position and some values", async () => {
    const result = await asked(story(BOTH_HOLD));
    expect(result.notice).toBeNull();
    expect(result.groups).toEqual([
      {
        file: `${DIR}/my-story.csv`,
        sheet: "my-story.csv",
        claim: "note",
        positions: [2, 3],
        columns: [
          { position: 2, header: "note", values: ["a"] },
          { position: 3, header: "Note", values: ["b"] },
        ],
        needsChoice: false,
      },
    ]);
    const content = result.challenge;
    expect(content).toMatchObject({
      v: 1,
      targetTag: "v1.8.0",
      headOid: "head-1",
      tabs: null,
      decisions: { sheets: null, rounds: [] },
      pending: [{ file: `${DIR}/my-story.csv`, claim: "note", positions: [2, 3] }],
    });
    expect(content.sheets).toEqual([{ file: `${DIR}/my-story.csv`, source: "repo", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });

  it("binds every sheet, not only the ones asked about", async () => {
    const result = await asked({ files: { [`${DIR}/a.csv`]: BOTH_HOLD, [`${DIR}/b.csv`]: "step,answer\n1,x\n" } });
    expect(result.challenge.sheets.map((s) => s.file)).toEqual([`${DIR}/a.csv`, `${DIR}/b.csv`]);
  });

  it("replays a valid choice: the author's column is kept, the others dropped, and the head is not advanced", async () => {
    const site = story(BOTH_HOLD);
    const first = await asked(site);
    const result = await ready(site, {
      challenge: first.challenge,
      submitted: [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 }],
    });
    expect(result.writes[0].content).toBe("step,answer,Note\n1,Here.,b\n");
    expect(result.report).toMatchObject([{ kind: "dropped", column: "note", keeper: "Note", chosen: true }]);
    expect(result.decisions).toEqual({
      sheets: null,
      rounds: [{ choices: [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 }] }],
    });
    expect(result.advancesHead).toBe(false);
  });

  it("a choice that keeps a later column over a first one holding values keeps the first under #, and the head is not advanced", async () => {
    const site = story("note,Note,step,answer\na,#kept,1,Here.\n");
    const first = await asked(site);
    const result = await ready(site, {
      challenge: first.challenge,
      submitted: [{ file: `${DIR}/my-story.csv`, positions: [0, 1], keep: 1 }],
    });
    expect(result.report).toMatchObject([{ kind: "marked", chosen: true, heldValues: true }]);
    expect(result.advancesHead).toBe(false);
  });

  it("a group a choice exposes in a later pass comes back to the picker, with the whole history in the challenge", async () => {
    const site = story(TWO_ROUNDS);
    const first = await asked(site);
    const round1 = [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 }];
    const second = await asked(site, { challenge: first.challenge, submitted: round1 });
    expect(second.notice).toBe("further_choices");
    expect(second.groups.map((g) => g.positions)).toEqual([[3, 4]]);
    expect(second.challenge.decisions.rounds).toEqual([{ choices: round1 }]);
    const done = await ready(site, {
      challenge: second.challenge,
      submitted: [{ file: `${DIR}/my-story.csv`, positions: [3, 4], keep: 4 }],
    });
    expect(done.writes[0].content).toBe("step,answer,note\n1,Here.,c\n");
    expect(done.decisions.rounds).toHaveLength(2);
  });

  it("a second-pass group with two columns holding values goes to the picker", async () => {
    const result = await asked(story("step,answer,note,note,Note\n1,Here.,,x,y\n"));
    expect(result.groups.map((g) => g.positions)).toEqual([[3, 4]]);
  });

  describe("an answer the challenge does not allow", () => {
    const site = story(BOTH_HOLD);
    const cases: [string, unknown][] = [
      ["no choice", []],
      ["two choices for one group", [
        { file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 2 },
        { file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 },
      ]],
      ["a column outside the group", [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 1 }]],
      ["a group not asked about", [{ file: `${DIR}/my-story.csv`, positions: [1, 3], keep: 3 }]],
      ["another sheet", [{ file: `${DIR}/other.csv`, positions: [2, 3], keep: 3 }]],
      ["not a list", "keep 3"],
    ];
    it.each(cases)("%s returns the same question, saying which group needs a choice", async (_label, submitted) => {
      const first = await asked(site);
      const again = await asked(site, { challenge: first.challenge, submitted: submitted as never });
      expect(again.notice).toBe("choice_needed");
      expect(again.groups[0].needsChoice).toBe(true);
      expect(again.challenge).toEqual(first.challenge);
    });
  });

  it("refuses a valid choice sent with one for a group not asked about", async () => {
    const site = story(BOTH_HOLD);
    const first = await asked(site);
    const again = await asked(site, {
      challenge: first.challenge,
      submitted: [
        { file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 },
        { file: `${DIR}/my-story.csv`, positions: [0, 1], keep: 0 },
      ],
    });
    expect(again.notice).toBe("choice_needed");
    expect(again.challenge).toEqual(first.challenge);
  });

  describe("sheets that changed since the question", () => {
    it.each([
      ["the head moved", { headOid: "head-2" }],
      ["the release changed", { targetTag: "v1.8.1" }],
    ])("%s: the choices are void and the question starts again", async (_label, change) => {
      const site = story(BOTH_HOLD);
      const first = await asked(site);
      const again = await asked(site, {
        ...change,
        challenge: first.challenge,
        submitted: [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 }],
      });
      expect(again.notice).toBe("sheets_changed");
      expect(again.challenge.decisions.rounds).toEqual([]);
    });

    it("a sheet whose bytes changed voids the choices", async () => {
      const first = await asked(story(BOTH_HOLD));
      const again = await asked(story("step,answer,note,Note\n1,Here.,a,c\n"), {
        challenge: first.challenge,
        submitted: [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 }],
      });
      expect(again.notice).toBe("sheets_changed");
    });

    it("a sheet added since the question voids the choices", async () => {
      const first = await asked(story(BOTH_HOLD));
      const again = await asked(
        { files: { [`${DIR}/my-story.csv`]: BOTH_HOLD, [`${DIR}/new.csv`]: "a\n1\n" } },
        { challenge: first.challenge, submitted: [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 }] },
      );
      expect(again.notice).toBe("sheets_changed");
    });

    it("changed sheets that no longer need a choice are ready, with no choice made", async () => {
      const first = await asked(story(BOTH_HOLD));
      const result = await ready(story(EMPTY_DUPLICATE), {
        challenge: first.challenge,
        submitted: [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 }],
      });
      expect(result.decisions.rounds).toEqual([]);
      expect(result.advancesHead).toBe(true);
    });
  });
});

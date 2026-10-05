/**
 * The change check for step and layer files:
 * which stories are read, how each is classified, and that every read of one
 * check is at one commit and strict.
 *
 * `checkStoryContent` runs against the real `github.server` module and a
 * stubbed `fetch` holding two commits' files, so each read is counted at the
 * network. The pinning of the rest of `computeFullSyncDiff` is checked with
 * its readers stood in for, recording the ref of every read.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  canonicalForCompareFromFiles,
  checkStoryContent,
  rawCanonicalFromD1,
  readStoriesForAccept,
} from "~/lib/story-content.server";
import {
  __clearStoryBlobCacheForTest,
  __storyBlobCacheForTest,
  gitBlobSha,
} from "~/lib/story-files.server";
import type { StoryCheckInput, StoryContentCheck } from "~/lib/story-content.server";
import type { SheetWarning } from "~/lib/sheet-warnings";
import { hasDivergentChanges } from "~/lib/sync.server";
import type { FullSyncDiff } from "~/lib/sync.server";
import { importAsD1, storyFixtures } from "./story-canonical-fixtures";
import { renderStoryFiles } from "~/lib/publish.server";
import Papa from "papaparse";
import type { D1Story } from "./story-canonical-fixtures";

const SHEETS = "telar-content/spreadsheets";
const TEXTS = "telar-content/texts/stories";

// ---------------------------------------------------------------------------
// A repository of commits, at the network
// ---------------------------------------------------------------------------

interface Commit {
  sheets: string | null;
  texts: string | null;
}

interface Repo {
  commits: Record<string, Commit>;
  listings: Record<string, { truncated: boolean; tree: Array<{ path: string; sha: string; type: string; mode: string }> }>;
  /** File text by "<commit>:<path>". */
  files: Record<string, string>;
  /** "<commit>:<path>" reads that fail with a server error. */
  failing: Set<string>;
  /** "<commit>:<path>" files served as these bytes rather than their text's UTF-8. */
  bytes?: Record<string, Uint8Array>;
}

let repo: Repo;
let contentReads: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  // Read as a server reads the URL: a `#` starts the fragment and a `?` the
  // query, so a filename holding either reaches the path only when encoded.
  const parsed = new URL(url);
  const contents = /^\/repos\/owner\/repo\/contents\/(.+)$/.exec(parsed.pathname);
  if (contents) {
    const path = contents[1].split("/").map(decodeURIComponent).join("/");
    const key = `${parsed.searchParams.get("ref")}:${path}`;
    contentReads.push(key);
    if (repo.failing.has(key)) return json({ message: "boom" }, 500);
    const raw = repo.bytes?.[key];
    if (raw) return json({ encoding: "base64", content: Buffer.from(raw).toString("base64"), size: raw.length });
    const text = repo.files[key];
    return text === undefined ? json({ message: "Not Found" }, 404) : json({ encoding: "base64", content: base64(text), size: Buffer.byteLength(text, "utf8") });
  }
  if (url === "https://api.github.com/graphql") {
    const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, string> };
    const answer: Record<string, unknown> = {};
    for (const [name, expression] of Object.entries(variables)) {
      if (name === "owner" || name === "repo") continue;
      const [commit, path] = expression.split(":");
      const c = repo.commits[commit];
      if (path === undefined) {
        answer[name] = c ? { __typename: "Commit" } : null;
        continue;
      }
      const oid = c ? (path === SHEETS ? c.sheets : path === TEXTS ? c.texts : null) : null;
      answer[name] = oid ? { __typename: "Tree", oid } : null;
    }
    return json({ data: { repository: answer } });
  }
  const tree = /\/repos\/owner\/repo\/git\/trees\/([^?]+)\?recursive=1$/.exec(url);
  if (tree) {
    const listing = repo.listings[decodeURIComponent(tree[1])];
    return listing ? json({ sha: tree[1], ...listing }) : json({ message: "Not Found" }, 404);
  }
  throw new Error(`unexpected request: ${url}`);
}

/** Adds a commit holding `files` (full paths) to the repository. */
async function commit(name: string, files: Record<string, string>): Promise<void> {
  const listFor = async (dir: string) => {
    const entries = Object.entries(files).filter(([p]) => p.startsWith(`${dir}/`));
    if (entries.length === 0) return null;
    const tree = [];
    // Every directory under the subtree is an entry of its own, as in
    // GitHub's recursive listing.
    const dirs = new Set<string>();
    for (const [p] of entries) {
      const parts = p.slice(dir.length + 1).split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    for (const d of [...dirs].sort()) tree.push({ path: d, sha: `dir-${d}`, type: "tree", mode: "040000" });
    for (const [p, text] of entries) {
      tree.push({ path: p.slice(dir.length + 1), sha: await gitBlobSha(text), type: "blob", mode: "100644" });
    }
    const oid = `tree-${await gitBlobSha(JSON.stringify(tree))}`;
    repo.listings[oid] = { truncated: false, tree };
    return oid;
  };
  repo.commits[name] = { sheets: await listFor(SHEETS), texts: await listFor(TEXTS) };
  for (const [p, text] of Object.entries(files)) repo.files[`${name}:${p}`] = text;
}

// ---------------------------------------------------------------------------
// Fixtures: the demo's colonial-landscapes story and its layer files
// ---------------------------------------------------------------------------

// The base is what a publish of the imported demo story commits, so the
// Compositor and the base agree until one side edits: the demo's own layer
// files carry hand-authored front matter, which the compare form reads as
// text and a publish rewrites in the writer's form.
const fixture = storyFixtures()["colonial-landscapes"];
const STORY = fixture.slug;
const PROJECT_CSV = `order,story_id,title\n1,${STORY},Colonial Landscapes\n`;
let published: Record<string, string>;
let LAYER: string;

async function publishedFiles(story: D1Story): Promise<Record<string, string>> {
  const files: Record<string, string> = { [`${SHEETS}/project.csv`]: PROJECT_CSV };
  for (const f of await renderStoryFiles(story.story.story_id, story.stepRows, story.layerRows)) files[f.path] = f.content;
  return files;
}

function demoFiles(): Record<string, string> {
  return { ...published };
}

function storyCsv(files: Record<string, string>, id = STORY): string {
  return files[`${SHEETS}/${id}.csv`];
}

function editAnswer(csv: string, from: string, to: string): string {
  expect(csv).toContain(from);
  return csv.replace(from, to);
}

let d1: D1Story;

/** Layer files by the name a step CSV gives them, out of a set of full paths. */
function layerFilesOf(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, text] of Object.entries(files)) if (p.startsWith(`${TEXTS}/`)) out[p.slice(TEXTS.length + 1)] = text;
  return out;
}

function input(overrides: Partial<StoryCheckInput> = {}): StoryCheckInput {
  return {
    token: "tok",
    owner: "owner",
    repo: "repo",
    base: "base",
    head: "head",
    d1: [{ story_id: STORY, loadRows: async () => ({ stepRows: d1.stepRows, layerRows: d1.layerRows }) }],
    deletedHere: [],
    headRowIds: new Set([STORY]),
    ...overrides,
  };
}

function conclusive(check: StoryContentCheck) {
  if (!check.conclusive) throw new Error(`inconclusive: ${check.reason}`);
  return check;
}

beforeEach(async () => {
  __clearStoryBlobCacheForTest();
  repo = { commits: {}, listings: {}, files: {}, failing: new Set() };
  contentReads = [];
  vi.stubGlobal("fetch", vi.fn(route));
  d1 = await importAsD1(fixture);
  published = await publishedFiles(d1);
  LAYER = Object.keys(published).find((p) => p.includes("legal-proceeding"))!.slice(TEXTS.length + 1);
  await commit("base", demoFiles());
});

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

describe("which stories are read", () => {
  it("reads nothing when neither the step CSV nor a named layer file changed", async () => {
    await commit("head", demoFiles());
    const check = conclusive(await checkStoryContent(input()));
    expect(check.changes).toEqual([]);
    expect(contentReads).toEqual([]);
  });

  it("a step CSV edit makes the story a candidate", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(storyCsv(published), "Why was this map drawn?", "Why was this map made?");
    await commit("head", files);
    const check = conclusive(await checkStoryContent(input()));
    expect(check.changes.map((c) => [c.story_id, c.kind])).toEqual([[STORY, "github-only"]]);
  });

  it("a layer file edit makes the story whose CSV names it a candidate", async () => {
    const files = demoFiles();
    files[`${TEXTS}/${LAYER}`] = published[`${TEXTS}/${LAYER}`] + "\n\nA sentence added on GitHub.";
    await commit("head", files);
    const check = conclusive(await checkStoryContent(input()));
    expect(check.changes.map((c) => [c.story_id, c.kind])).toEqual([[STORY, "github-only"]]);
  });

  it("a named layer file removed makes the story a candidate, and reads as a layer with no text", async () => {
    const files = demoFiles();
    delete files[`${TEXTS}/${LAYER}`];
    await commit("head", files);
    const check = conclusive(await checkStoryContent(input()));
    expect(check.changes.map((c) => [c.story_id, c.kind])).toEqual([[STORY, "github-only"]]);
  });

  it("a named layer file added makes the story a candidate", async () => {
    // Step 2 names a second panel no commit held at the base.
    const table = Papa.parse<string[]>(storyCsv(published)).data;
    const header = table[0];
    const row = table.findIndex((r) => r[0] === "2");
    table[row][header.indexOf("layer2_button")] = "Added";
    table[row][header.indexOf("layer2_content")] = "added.md";
    const csv = Papa.unparse(table, { newline: "\n" });
    const baseFiles = { ...demoFiles(), [`${SHEETS}/${STORY}.csv`]: csv };
    await commit("base", baseFiles);
    await commit("head", { ...baseFiles, [`${TEXTS}/added.md`]: '---\ntitle: "Added"\n---\n\nNew panel.' });
    // D1 is what an import of the base stores, the missing file's name
    // included, so the Compositor has not changed it; only HEAD's new file has.
    d1 = await importAsD1({ slug: STORY, csv, layerFiles: layerFilesOf(baseFiles) });
    const check = conclusive(await checkStoryContent(input()));
    expect(check.changes.map((c) => [c.story_id, c.kind])).toEqual([[STORY, "github-only"]]);
  });

  it("reads a layer file two stories share once", async () => {
    const files = demoFiles();
    files[`${SHEETS}/second.csv`] = storyCsv(published);
    await commit("base", files);
    const head = { ...files, [`${TEXTS}/${LAYER}`]: published[`${TEXTS}/${LAYER}`] + "\n\nEdited." };
    await commit("head", head);
    const second = await importAsD1({ slug: "second", csv: storyCsv(published), layerFiles: layerFilesOf(files) });
    const check = conclusive(
      await checkStoryContent(
        input({
          d1: [
            { story_id: STORY, loadRows: async () => ({ stepRows: d1.stepRows, layerRows: d1.layerRows }) },
            { story_id: "second", loadRows: async () => ({ stepRows: second.stepRows, layerRows: second.layerRows }) },
          ],
          headRowIds: new Set([STORY, "second"]),
        }),
      ),
    );
    expect(check.changes.map((c) => c.story_id).sort()).toEqual(["colonial-landscapes", "second"]);
    expect(contentReads.filter((r) => r === `head:${TEXTS}/${LAYER}`)).toHaveLength(1);
    expect(contentReads.filter((r) => r === `base:${TEXTS}/${LAYER}`)).toHaveLength(1);
  });

  it("lists a reformatting that parses the same as nothing", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = storyCsv(published).replace(/\r?\n/g, "\r\n").replace("demo-bogota-1614,0.5", '"demo-bogota-1614",0.5');
    expect(files[`${SHEETS}/${STORY}.csv`]).not.toBe(storyCsv(published));
    await commit("head", files);
    const check = conclusive(await checkStoryContent(input()));
    expect(check.changes).toEqual([]);
    expect(contentReads.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Strictness
// ---------------------------------------------------------------------------

describe("strict reads", () => {
  // A read that failed is not an unreadable story: keeping the Compositor's
  // version of one records the checked commit, which would acknowledge a
  // change nobody read. The check is inconclusive, which holds head_sha.
  it("makes the check inconclusive when a layer read fails, naming the file", async () => {
    const files = demoFiles();
    files[`${TEXTS}/${LAYER}`] = published[`${TEXTS}/${LAYER}`] + "\n\nEdited.";
    await commit("head", files);
    repo.failing.add(`head:${TEXTS}/${LAYER}`);
    const check = await checkStoryContent(input());
    expect(check.conclusive).toBe(false);
    expect(check.conclusive === false && check.reason).toContain(LAYER);
  });

  it("makes the check inconclusive when a step CSV read fails", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(storyCsv(published), "Why was this map drawn?", "Why was this map made?");
    await commit("head", files);
    repo.failing.add(`head:${SHEETS}/${STORY}.csv`);
    const check = await checkStoryContent(input());
    expect(check.conclusive).toBe(false);
    expect(check.conclusive === false && check.reason).toContain(`${STORY}.csv`);
  });

  it("the accept's read of a story file that fails throws SheetUnreadableError, naming the file", async () => {
    await commit("head", demoFiles());
    repo.failing.add(`head:${TEXTS}/${LAYER}`);
    await expect(readStoriesForAccept(input(), "head", [STORY])).rejects.toMatchObject({
      name: "SheetUnreadableError",
      path: `${TEXTS}/${LAYER}`,
    });
  });

  it("makes the check inconclusive when the read of a story deleted here fails", async () => {
    const files = demoFiles();
    files[`${TEXTS}/${LAYER}`] = published[`${TEXTS}/${LAYER}`] + "\n\nEdited.";
    await commit("head", files);
    repo.failing.add(`base:${SHEETS}/${STORY}.csv`);
    const check = await checkStoryContent(input({ d1: [], deletedHere: [STORY] }));
    expect(check.conclusive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer references resolved as the framework resolves them
// ---------------------------------------------------------------------------

describe("layer references", () => {
  const csvNaming = (name: string) =>
    `step,object,question,answer,layer1_button,layer1_content\n1,obj,Q,A,More,${name}\n`;

  // An unchanged CSV names PANEL.md, GitHub holds panel.md, and the
  // body changes. The framework reads panel.md (images.py
  // resolve_path_case_insensitive: exact, then the filename lowercased, then
  // the whole path lowercased).
  it("follows a mixed-case reference to the file the framework reads", async () => {
    const csv = csvNaming("PANEL.md");
    const base = { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv };
    await commit("base", { ...base, [`${TEXTS}/panel.md`]: '---\ntitle: "P"\n---\n\nBefore.' });
    await commit("head", { ...base, [`${TEXTS}/panel.md`]: '---\ntitle: "P"\n---\n\nAfter.' });
    d1 = await importAsD1({ slug: STORY, csv, layerFiles: {} });
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ story_id: STORY, kind: "github-only" });
  });

  it("follows a reference whose directory is also in another case", async () => {
    const csv = csvNaming("Notes/PANEL.md");
    const base = { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv };
    await commit("base", { ...base, [`${TEXTS}/notes/panel.md`]: '---\ntitle: "P"\n---\n\nBefore.' });
    await commit("head", { ...base, [`${TEXTS}/notes/panel.md`]: '---\ntitle: "P"\n---\n\nAfter.' });
    d1 = await importAsD1({ slug: STORY, csv, layerFiles: {} });
    expect(conclusive(await checkStoryContent(input())).changes).toHaveLength(1);
  });

  async function checkNaming(name: string, target: string) {
    const csv = csvNaming(name);
    const base = { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv };
    await commit("base", { ...base, [`${TEXTS}/${target}`]: '---\ntitle: "P"\n---\n\nBefore.' });
    await commit("head", { ...base, [`${TEXTS}/${target}`]: '---\ntitle: "P"\n---\n\nAfter.' });
    // D1 as the import stored it: the import fetches the exact name only.
    const imported = name === target ? { [name]: '---\ntitle: "P"\n---\n\nBefore.' } : {};
    d1 = await importAsD1({ slug: STORY, csv, layerFiles: imported });
    return conclusive(await checkStoryContent(input())).changes;
  }

  // Python's Path reads these as Folder/PANEL.md or panel.md; only the
  // plain form is resolved here, and the rest are shown as unreadable.
  it.each([
    ["./panel.md", "panel.md"],
    ["Folder//PANEL.md", "Folder/panel.md"],
    ["Folder/./PANEL.md", "Folder/panel.md"],
  ])("a reference that is not a plain path (%s) makes the story unreadable when its target changes", async (name, target) => {
    const [change] = await checkNaming(name, target);
    expect(change).toMatchObject({ story_id: STORY, kind: "unreadable", acceptByDefault: false });
    expect(change.reason).toEqual({ code: "layer_reference_not_plain", reference: name });
  });

  // A directory at the exact name makes the framework take the
  // directory, and fall back to the cell's text, while panel.md is there.
  it("a directory at a path the framework would try makes the story unreadable", async () => {
    const csv = csvNaming("PANEL.md");
    const base = { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv, [`${TEXTS}/panel.md`]: '---\ntitle: "P"\n---\n\nText.' };
    await commit("base", base);
    await commit("head", { ...base, [`${TEXTS}/PANEL.md/child.txt`]: "x" });
    d1 = await importAsD1({ slug: STORY, csv, layerFiles: {} });
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ story_id: STORY, kind: "unreadable" });
    expect(change.reason).toEqual({ code: "layer_reference_directory", reference: "PANEL.md" });
  });

  // U+A7CE lowercases in Node's Unicode tables and not in Python's, so
  // a non-ASCII reference is resolved only by an exact match.
  it("a non-ASCII reference that matches no file exactly makes the story unreadable", async () => {
    const [change] = await checkNaming("\uA7CE.md", "\uA7CF.md");
    expect(change).toMatchObject({ story_id: STORY, kind: "unreadable" });
    expect(change.reason).toEqual({ code: "layer_reference_non_ascii", reference: "\uA7CE.md" });
  });

  it("a story whose read fails for no named reason is unreadable with the general code, never the error's text", async () => {
    const csv = csvNaming("panel.md");
    const base = { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv };
    await commit("base", base);
    await commit("head", { ...base, [`${SHEETS}/${STORY}.csv`]: csv.replace(",A,", ",B,") });
    const failing = [{ story_id: STORY, loadRows: async () => Promise.reject(new Error("D1 said something in English")) }];
    const [change] = conclusive(await checkStoryContent(input({ d1: failing }))).changes;
    expect(change).toMatchObject({ kind: "unreadable" });
    expect(change.reason).toEqual({ code: "files_unreadable" });
  });

  it("compatibility: a non-ASCII reference that matches a file exactly resolves", async () => {
    const [change] = await checkNaming("Café.md", "Café.md");
    expect(change).toMatchObject({ story_id: STORY, kind: "github-only" });
  });

  // markdown.py:187-191 and stories.py:593-597: a file the resolver cannot
  // find is read as the cell's own text, inline.
  it("reads a reference the framework cannot resolve as its own text, as the framework does", async () => {
    const csv = csvNaming("missing.md");
    const read = await canonicalForCompareFromFiles(STORY, csv, {});
    if (!read.readable) throw new Error(JSON.stringify(read.reason));
    expect(read.steps[0].layers[0].content).toBe("missing.md");
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classification", () => {
  function d1WithAnswer(from: string, to: string) {
    return importAsD1({ slug: STORY, csv: editAnswer(storyCsv(published), from, to), layerFiles: layerFilesOf(published) });
  }

  it("GitHub only: listed, accepted by default, with D1's raw-form hash", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(storyCsv(published), "Why was this map drawn?", "Why was this map made?");
    await commit("head", files);
    const [change] = conclusive(await checkStoryContent(input())).changes;
    const raw = await rawCanonicalFromD1(d1.stepRows, d1.layerRows);
    expect(change).toMatchObject({ kind: "github-only", acceptByDefault: true, expected: raw.readable ? raw.hash : "?" });
    expect(change.summary).toEqual({ d1Steps: 5, headSteps: 5, changedSteps: 1 });
  });

  it("Compositor only: not listed", async () => {
    // HEAD's CSV is a reformatting of the base's, so it is a candidate, while
    // D1 changed a step.
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = storyCsv(published).replace(/\r?\n/g, "\r\n");
    await commit("head", files);
    d1 = await d1WithAnswer("Why was this map drawn?", "Edited in the Compositor");
    const check = conclusive(await checkStoryContent(input()));
    expect(check.changes).toEqual([]);
    expect(check.suppressedEditorOnly).toBe(1);
  });

  it("both: a conflict, not accepted by default", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(storyCsv(published), "Why was this map drawn?", "Edited on GitHub");
    await commit("head", files);
    d1 = await d1WithAnswer("What does the map show?", "Edited in the Compositor");
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ kind: "conflict", acceptByDefault: false });
    expect(change.summary.changedSteps).toBe(2);
  });

  it("the same edit on both sides: nothing", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(storyCsv(published), "Why was this map drawn?", "The same edit");
    await commit("head", files);
    d1 = await d1WithAnswer("Why was this map drawn?", "The same edit");
    expect(conclusive(await checkStoryContent(input())).changes).toEqual([]);
  });

  it("a step CSV deleted on GitHub while its project.csv row remains: listed, not accepted by default", async () => {
    const files = demoFiles();
    delete files[`${SHEETS}/${STORY}.csv`];
    await commit("head", files);
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ kind: "steps-deleted", acceptByDefault: false });
  });

  it("a step CSV deleted together with its project.csv row is left to the row diff", async () => {
    const files = demoFiles();
    delete files[`${SHEETS}/${STORY}.csv`];
    await commit("head", files);
    expect(conclusive(await checkStoryContent(input({ headRowIds: new Set() }))).changes).toEqual([]);
  });

  it("deleted here, edited there: the restore / keep-deleted choice", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(storyCsv(published), "Why was this map drawn?", "Edited on GitHub");
    await commit("head", files);
    const [change] = conclusive(await checkStoryContent(input({ d1: [], deletedHere: [STORY] }))).changes;
    expect(change).toMatchObject({ story_id: STORY, kind: "restore-choice", acceptByDefault: false, expected: null });
  });

  it("deleted here and unchanged there: nothing", async () => {
    await commit("head", demoFiles());
    expect(conclusive(await checkStoryContent(input({ d1: [], deletedHere: [STORY] }))).changes).toEqual([]);
  });

  // The status refresh reads this same change as divergent, since the blob
  // differs (github-status-story-files.test.ts, "one differing byte"), so the
  // check's empty answer is what lets the change check clear a first sync.
  it("with no base, a layer file's trailing space, which a publish writes without, is nothing", async () => {
    const files = demoFiles();
    const layer = Object.keys(files).find((path) => path.startsWith(`${TEXTS}/`))!;
    files[layer] = `${files[layer]} `;
    await commit("head", files);
    expect(conclusive(await checkStoryContent(input({ base: null }))).changes).toEqual([]);
  });

  it("with no base, a difference is a conflict, and none is nothing", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(storyCsv(published), "Why was this map drawn?", "Edited on GitHub");
    await commit("head", files);
    const [change] = conclusive(await checkStoryContent(input({ base: null }))).changes;
    expect(change).toMatchObject({ kind: "conflict", acceptByDefault: false });

    await commit("head", demoFiles());
    __clearStoryBlobCacheForTest();
    expect(conclusive(await checkStoryContent(input({ base: null }))).changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// An imported story whose layer files carry hand-written front matter
// ---------------------------------------------------------------------------

describe("an imported story with hand-written front matter, never published", () => {
  // The base is the demo's own files, the commit D1 was imported from.
  function originalFiles(): Record<string, string> {
    const files: Record<string, string> = {
      [`${SHEETS}/project.csv`]: PROJECT_CSV,
      [`${SHEETS}/${STORY}.csv`]: fixture.csv,
    };
    for (const [name, text] of Object.entries(fixture.layerFiles)) files[`${TEXTS}/${name}`] = text;
    return files;
  }

  beforeEach(async () => {
    await commit("base", originalFiles());
  });

  it("edited on GitHub only: github-only, accepted by default", async () => {
    const files = originalFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(fixture.csv, "Why was this map drawn?", "Edited on GitHub");
    await commit("head", files);
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ kind: "github-only", acceptByDefault: true });
  });

  it("edited in D1 only: Compositor only, not listed", async () => {
    // HEAD reformats the CSV, so the story is read, while D1 changed a step.
    const files = originalFiles();
    files[`${SHEETS}/${STORY}.csv`] = fixture.csv.replace("demo-bogota-1614,0.5,0.5", '"demo-bogota-1614",0.5,0.5');
    expect(files[`${SHEETS}/${STORY}.csv`]).not.toBe(fixture.csv);
    await commit("head", files);
    d1 = await importAsD1({ ...fixture, csv: editAnswer(fixture.csv, "Why was this map drawn?", "Edited in the Compositor") });
    const check = conclusive(await checkStoryContent(input()));
    expect(check.changes).toEqual([]);
    expect(check.suppressedEditorOnly).toBe(1);
  });

  it("edited on both sides: a conflict", async () => {
    const files = originalFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(fixture.csv, "Why was this map drawn?", "Edited on GitHub");
    await commit("head", files);
    d1 = await importAsD1({ ...fixture, csv: editAnswer(fixture.csv, "What does the map show?", "Edited in the Compositor") });
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ kind: "conflict", acceptByDefault: false });
  });
});

describe("a story subtree at one commit only", () => {
  it("lists the stories whose CSVs name the files of a site's first texts/stories directory", async () => {
    // The base names panel.md but has no texts/stories at all; HEAD adds it.
    const csv = "step,object,question,answer,layer1_button,layer1_content\n1,obj,Q,A,More,panel.md\n";
    const baseFiles = { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv };
    await commit("base", baseFiles);
    await commit("head", { ...baseFiles, [`${TEXTS}/panel.md`]: '---\ntitle: "Panel"\n---\n\nThe panel.' });
    expect(repo.commits.base.texts).toBeNull();
    d1 = await importAsD1({ slug: STORY, csv, layerFiles: {} });
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ story_id: STORY, kind: "github-only" });
  });

  it("reads every file as removed when a subtree is gone at HEAD", async () => {
    const files = demoFiles();
    for (const p of Object.keys(files)) if (p.startsWith(`${TEXTS}/`)) delete files[p];
    await commit("head", files);
    expect(repo.commits.head.texts).toBeNull();
    const [change] = conclusive(await checkStoryContent(input())).changes;
    expect(change).toMatchObject({ story_id: STORY, kind: "github-only" });
  });
});

describe("no base, and no step CSV at HEAD", () => {
  it("lists steps deleted when HEAD's project.csv still holds the row", async () => {
    const files = demoFiles();
    delete files[`${SHEETS}/${STORY}.csv`];
    await commit("head", files);
    const [change] = conclusive(await checkStoryContent(input({ base: null }))).changes;
    expect(change).toMatchObject({ story_id: STORY, kind: "steps-deleted", acceptByDefault: false });
  });

  it("compatibility: skips the story when HEAD's project.csv has no row for it either: it was never published", async () => {
    const files = demoFiles();
    delete files[`${SHEETS}/${STORY}.csv`];
    await commit("head", files);
    expect(conclusive(await checkStoryContent(input({ base: null, headRowIds: new Set() }))).changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Filenames holding URL delimiters
// ---------------------------------------------------------------------------

describe("a layer filename holding a URL delimiter or non-ASCII text", () => {
  it.each([
    ["intro#notes.md", ""],
    ["a?b.md", ""],
    ["50% off.md", ""],
    // fetch percent-encodes non-ASCII itself, so this held before the fix.
    ["café-ñandú.md", "compatibility: "],
  ])(
    "%2$sreads %1$s at its own path, at the pinned commit",
    async (name, _label) => {
      const csv = `step,object,question,answer,layer1_button,layer1_content\n1,obj,Q,A,More,${name}\n`;
      const base = { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv };
      await commit("base", { ...base, [`${TEXTS}/${name}`]: '---\ntitle: "P"\n---\n\nBefore.' });
      await commit("head", { ...base, [`${TEXTS}/${name}`]: '---\ntitle: "P"\n---\n\nAfter.' });
      d1 = await importAsD1({ slug: STORY, csv, layerFiles: { [name]: '---\ntitle: "P"\n---\n\nBefore.' } });
      const [change] = conclusive(await checkStoryContent(input())).changes;
      expect(change).toMatchObject({ kind: "github-only" });
      expect(contentReads).toEqual(expect.arrayContaining([`head:${TEXTS}/${name}`, `base:${TEXTS}/${name}`]));
    },
  );
});

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

describe("the per-isolate cache", () => {
  // 20 layer files of 500,000 bytes (250,000 UTF-16 units) each, 10 MB in all,
  // against a budget of 8 MiB: the oldest are dropped, the newest kept. Each
  // file's text is distinct, so each is its own blob and its own cache entry.
  // Both claims are read from the state one full check leaves, the last file
  // first: reading it cannot bring the first file back.
  // Timeout: they push more than the 8 MiB budget through the cache, so their runtime scales with machine load.
  it("drops the oldest files past its byte budget", { timeout: 30_000 }, async () => {
    const names = Array.from({ length: 20 }, (_, i) => `f${i}.md`);
    const rows = Array.from({ length: 10 }, (_, i) => `${i + 1},obj,Q${i},A,One,${names[2 * i]},Two,${names[2 * i + 1]}`);
    const csv = (a: string) => `step,object,question,answer,layer1_button,layer1_content,layer2_button,layer2_content\n${rows.join("\n").replace("A,One", a + ",One")}\n`;
    const layers: Record<string, string> = {};
    names.forEach((n, i) => (layers[`${TEXTS}/${n}`] = `${i}`.padEnd(250_000, "x")));
    await commit("base", { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv("A"), ...layers });
    await commit("head", { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv("B"), ...layers });
    d1 = await importAsD1({ slug: STORY, csv: csv("A"), layerFiles: Object.fromEntries(names.map((n) => [n, layers[`${TEXTS}/${n}`]])) });
    await checkStoryContent(input());
    const kept = __storyBlobCacheForTest();
    expect(kept.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(kept.entries).toBeLessThan(22);

    /** Commits a story naming only `name`, as base and HEAD, and returns the reads a check of it makes. */
    const readsOfStoryNaming = async (name: string) => {
      const path = `${TEXTS}/${name}`;
      const oneCsv = `step,object,question,answer,layer1_button,layer1_content\n1,obj,Q,A,More,${name}\n`;
      await commit("base", { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: oneCsv, [path]: layers[path] });
      await commit("head", { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: oneCsv.replace(",A,", ",B,"), [path]: layers[path] });
      contentReads = [];
      await checkStoryContent(input());
      return contentReads.filter((r) => r.endsWith(`/${name}`));
    };

    // The file read last is still kept: a check that reads only it reads nothing.
    expect(await readsOfStoryNaming(names[19])).toEqual([]);
    // Oldest first: the first file read is gone.
    expect((await readsOfStoryNaming(names[0])).length).toBeGreaterThan(0);
  });

  // Timeout: it pushes a file past the 512 KiB cap through the cache twice, so its runtime scales with machine load.
  it("reads a file over 512 KiB but does not keep it", { timeout: 30_000 }, async () => {
    const big = "y".repeat(300_000); // 600,000 bytes as UTF-16
    const csv = (a: string) => `step,object,question,answer,layer1_button,layer1_content\n1,obj,Q,${a},More,big.md\n`;
    await commit("base", { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv("A"), [`${TEXTS}/big.md`]: big });
    await commit("head", { [`${SHEETS}/project.csv`]: PROJECT_CSV, [`${SHEETS}/${STORY}.csv`]: csv("B"), [`${TEXTS}/big.md`]: big });
    d1 = await importAsD1({ slug: STORY, csv: csv("A"), layerFiles: { "big.md": big } });
    await checkStoryContent(input());
    expect(__storyBlobCacheForTest().entries).toBe(2); // the two step CSVs only
    contentReads = [];
    await checkStoryContent(input());
    // Read again at both commits; the CSVs come from the cache.
    expect(contentReads.filter((r) => r.endsWith("big.md"))).toHaveLength(2);
    expect(contentReads.filter((r) => r.endsWith(`${STORY}.csv`))).toEqual([]);
  });

  it("makes a second check over unchanged blobs read no content", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = editAnswer(storyCsv(published), "Why was this map drawn?", "Why was this map made?");
    await commit("head", files);
    const first = conclusive(await checkStoryContent(input()));
    expect(contentReads.length).toBeGreaterThan(0);
    contentReads = [];
    const second = conclusive(await checkStoryContent(input()));
    expect(contentReads).toEqual([]);
    expect(second.changes).toEqual(first.changes);
  });
});

// ---------------------------------------------------------------------------
// A check that cannot conclude
// ---------------------------------------------------------------------------

describe("a tree the check cannot conclude from", () => {
  it("reports a truncated listing, and the diff stays divergent", async () => {
    await commit("head", demoFiles());
    const headTexts = repo.commits.head.texts!;
    repo.listings[`${headTexts}-t`] = { ...repo.listings[headTexts], truncated: true };
    repo.commits.head = { ...repo.commits.head, texts: `${headTexts}-t` };
    const check = await checkStoryContent(input());
    expect(check.conclusive).toBe(false);
    expect(hasDivergentChanges(diffWith(check))).toBe(true);
  });

  it("reports a base that no longer resolves", async () => {
    await commit("head", demoFiles());
    delete repo.commits.base;
    const check = await checkStoryContent(input());
    expect(check.conclusive).toBe(false);
  });

  it("compatibility: an empty conclusive check leaves the diff not divergent", () => {
    expect(hasDivergentChanges(diffWith({ conclusive: true, changes: [], suppressedEditorOnly: 0 }))).toBe(false);
  });
});

function diffWith(content: StoryContentCheck): FullSyncDiff {
  return {
    objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] } as never,
    stories: { newStories: [], changedStories: [], missingStories: [], content },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], removed: [], changed: [] },
    hasConflicts: false,
    classification: "three-way",
    suppressedEditorOnly: 0,
    unreadableFiles: [],
  };
}

// ---------------------------------------------------------------------------
// What the check tells the author about HEAD's step files
// ---------------------------------------------------------------------------

describe("the warnings a check raises from the step files it reads", () => {
  /** The published step CSV with step 1's x unreadable and a value past the last column. */
  function malformed(csv: string): string {
    const table = Papa.parse<string[]>(csv).data;
    const header = table[0];
    const row = table.findIndex((r) => r[0] === "1");
    table[row][header.indexOf("x")] = "abc";
    table[row].push("surplus");
    return Papa.unparse(table, { newline: "\n" });
  }

  it("names HEAD's step sheet on a cut-off row and an invalid coordinate", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = malformed(storyCsv(published));
    await commit("head", files);
    const warnings: SheetWarning[] = [];
    await checkStoryContent(input({ warnings }));
    // The published sheet's second, Spanish header row is wholly header
    // tokens, so its skip is not reported.
    expect(warnings).toEqual([
      { code: "ragged_row", row: { label: "1" }, sheet: `${STORY}.csv` },
      { code: "coordinate_invalid", step: 1, column: "x", value: "abc", sheet: `${STORY}.csv` },
    ]);
  });

  it("names a heading the site misreads in HEAD's step sheet", async () => {
    const files = demoFiles();
    files[`${SHEETS}/${STORY}.csv`] = storyCsv(published).replace(/^step,/, "Step,");
    await commit("head", files);
    const warnings: SheetWarning[] = [];
    await checkStoryContent(input({ warnings }));
    expect(warnings).toEqual([{ code: "header_spelling", headers: ["Step"], names: ["step"], sheet: `${STORY}.csv` }]);
  });

  it("raises nothing from the base's step files", async () => {
    const baseFiles = demoFiles();
    baseFiles[`${SHEETS}/${STORY}.csv`] = malformed(storyCsv(published));
    await commit("base", baseFiles);
    const headFiles = demoFiles();
    headFiles[`${SHEETS}/${STORY}.csv`] = editAnswer(storyCsv(published), "Why was this map drawn?", "Why was this map made?");
    await commit("head", headFiles);
    const warnings: SheetWarning[] = [];
    await checkStoryContent(input({ warnings }));
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Files whose bytes are not valid UTF-8
// ---------------------------------------------------------------------------

describe("a step or layer file read lossily at HEAD", () => {
  const R = "\uFFFD";

  /** The file's text as UTF-8, with every U+FFFD written as the invalid byte FF. */
  function invalidBytes(text: string): Uint8Array {
    const bytes = [...Buffer.from(text, "utf8")];
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) {
        out.push(0xff);
        i += 2;
      } else out.push(bytes[i]);
    }
    return Uint8Array.from(out);
  }

  /** Commits `files`, serving each path in `lossy` as its text with U+FFFD as FF. */
  async function commitLossy(name: string, files: Record<string, string>, lossy: string[]): Promise<void> {
    await commit(name, files);
    repo.bytes = repo.bytes ?? {};
    for (const path of lossy) repo.bytes[`${name}:${path}`] = invalidBytes(files[path]);
  }

  const unreadable = (warnings: SheetWarning[]) => warnings.filter((w) => w.code === "unreadable_characters");

  it("names a changed step CSV", async () => {
    const files = demoFiles();
    const path = `${SHEETS}/${STORY}.csv`;
    files[path] = editAnswer(storyCsv(published), "Why was this map drawn?", `Why was this map drawn${R}`);
    await commitLossy("head", files, [path]);
    const warnings: SheetWarning[] = [];
    await checkStoryContent(input({ warnings }));
    expect(unreadable(warnings)).toEqual([
      { code: "unreadable_characters", file: `${STORY}.csv`, effect: "left_out", repair: "publish" },
    ]);
  });

  it("names a changed layer file by its path", async () => {
    const files = demoFiles();
    const path = `${TEXTS}/${LAYER}`;
    files[path] = published[path] + `\n\nA sentence${R} added on GitHub.`;
    await commitLossy("head", files, [path]);
    const warnings: SheetWarning[] = [];
    await checkStoryContent(input({ warnings }));
    expect(unreadable(warnings)).toEqual([
      { code: "unreadable_characters", file: path, effect: "name_shown", repair: "publish" },
    ]);
  });

  it("does not name a file lossy only at the base", async () => {
    const path = `${SHEETS}/${STORY}.csv`;
    const baseFiles = demoFiles();
    baseFiles[path] = editAnswer(storyCsv(published), "Why was this map drawn?", `Why was this map drawn${R}`);
    await commitLossy("base", baseFiles, [path]);
    const headFiles = demoFiles();
    headFiles[path] = editAnswer(storyCsv(published), "Why was this map drawn?", "Why was this map made?");
    await commit("head", headFiles);
    const warnings: SheetWarning[] = [];
    await checkStoryContent(input({ warnings }));
    expect(contentReads).toContain(`base:${path}`);
    expect(unreadable(warnings)).toEqual([]);
  });

  it("neither reads nor names a lossy step CSV whose blob is unchanged since the base", async () => {
    const path = `${SHEETS}/${STORY}.csv`;
    const files = demoFiles();
    files[path] = editAnswer(storyCsv(published), "Why was this map drawn?", `Why was this map drawn${R}`);
    await commitLossy("base", files, [path]);
    await commitLossy("head", files, [path]);
    const warnings: SheetWarning[] = [];
    await checkStoryContent(input({ warnings }));
    expect(contentReads).toEqual([]);
    expect(unreadable(warnings)).toEqual([]);
  });

  it("names a lossy blob read twice again from the cache", async () => {
    const files = demoFiles();
    const path = `${SHEETS}/${STORY}.csv`;
    files[path] = editAnswer(storyCsv(published), "Why was this map drawn?", `Why was this map drawn${R}`);
    await commitLossy("head", files, [path]);
    await checkStoryContent(input({ warnings: [] }));
    contentReads = [];
    const warnings: SheetWarning[] = [];
    await checkStoryContent(input({ warnings }));
    expect(contentReads).toEqual([]);
    expect(unreadable(warnings)).toHaveLength(1);
  });
});

// Each row is mapped alone, so the step a warning names has to come from the
// row's place in the sheet when the sheet gives it no step number.
describe("the step a step-file warning names", () => {
  it("is the row's place among the steps when the sheet has no step column", async () => {
    const warnings: SheetWarning[] = [];
    await canonicalForCompareFromFiles(
      "no-steps",
      "object,x,question\nobj-001,0.5,First?\nobj-001,0.5,Second?\nobj-001,abc,Third?\n",
      {},
      warnings,
    );
    expect(warnings).toEqual([
      { code: "coordinate_invalid", step: 3, column: "x", value: "abc", sheet: "no-steps.csv" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// A layer 1 with no text under a layer 2: a publish writes
// the heading the site derives for it as its title, and every read takes a
// title a publish could have derived, in any language, as no title. So the
// check reads the same whatever language the Compositor or the repository
// states, and D1 keeps a title an author wrote that the files cannot tell
// from a derived one.
// ---------------------------------------------------------------------------

describe("a layer 1 with no text under a layer 2", () => {
  const SLUG = "panels";
  const PANELS_PROJECT = `order,story_id,title\n1,${SLUG},Panels\n`;

  function csvOf(layer1File: string, layer2File: string, button1 = "") {
    return [
      "step,object,x,y,zoom,question,answer,layer1_button,layer1_content,layer2_button,layer2_content",
      `1,obj,0.5,0.5,1,Question,Answer,${button1},${layer1File},,${layer2File}`,
    ].join("\n");
  }
  const file = (title: string, body = "") => `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}`;

  /** A commit of the story, layer 1 titled `layer1Title` with no text, layer 2 with `layer2Text`. */
  async function commitPanels(name: string, layer1Title: string, layer2Text: string, button1 = "", csvAfter = "") {
    await commit(name, {
      [`${SHEETS}/project.csv`]: PANELS_PROJECT,
      [`${SHEETS}/${SLUG}.csv`]: csvOf("panels-l1.md", "panels-l2.md", button1) + csvAfter,
      [`${TEXTS}/panels-l1.md`]: file(layer1Title),
      [`${TEXTS}/panels-l2.md`]: file("", layer2Text),
    });
  }

  /** D1's rows for the story as an import of the base stores them, layer 1 titled `title`. */
  async function d1Panels(title: string | null, button1 = ""): Promise<D1Story> {
    const story = await importAsD1({
      slug: SLUG,
      csv: csvOf("panels-l1.md", "panels-l2.md", button1),
      layerFiles: { "panels-l1.md": file("Learn more"), "panels-l2.md": file("", "Deeper") },
    });
    return {
      ...story,
      layerRows: story.layerRows.map((l) => (l.layer_number === 1 ? { ...l, title } : l)),
    };
  }

  const check = (story: D1Story) =>
    checkStoryContent(
      input({
        d1: [{ story_id: SLUG, loadRows: async () => ({ stepRows: story.stepRows, layerRows: story.layerRows }) }],
        headRowIds: new Set([SLUG]),
      }),
    );

  beforeEach(async () => {
    repo = { commits: {}, listings: {}, files: {}, failing: new Set() };
    // Published from an English site: layer 1's derived heading.
    await commitPanels("base", "Learn more", "Deeper");
  });

  it("an import reads the derived heading as no title, in either language", async () => {
    expect((await d1Panels(null)).layerRows.find((l) => l.layer_number === 1)!.title).toBeNull();
    const imported = await importAsD1({
      slug: SLUG,
      csv: csvOf("panels-l1.md", "panels-l2.md"),
      layerFiles: { "panels-l1.md": file("Saber más"), "panels-l2.md": file("", "Deeper") },
    });
    expect(imported.layerRows.find((l) => l.layer_number === 1)!.title ?? null).toBeNull();
  });

  it("a title equal to the heading the site derives reads as none on both sides: a GitHub edit to layer 2 is github-only", async () => {
    await commitPanels("head", "Learn more", "Deeper, edited on GitHub");
    const [change] = conclusive(await check(await d1Panels("Learn more"))).changes;
    expect(change).toMatchObject({ story_id: SLUG, kind: "github-only", acceptByDefault: true });
  });

  describe("an authored \"Learn more\" on a layer 1 whose button says \"More\"", () => {
    beforeEach(async () => {
      repo = { commits: {}, listings: {}, files: {}, failing: new Set() };
      await commitPanels("base", "Learn more", "Deeper", "More");
    });

    it("is kept by the import", async () => {
      expect((await d1Panels("Learn more", "More")).layerRows.find((l) => l.layer_number === 1)!.title).toBe("Learn more");
      const imported = await importAsD1({
        slug: SLUG,
        csv: csvOf("panels-l1.md", "panels-l2.md", "More"),
        layerFiles: { "panels-l1.md": file("Learn more"), "panels-l2.md": file("", "Deeper") },
      });
      expect(imported.layerRows.find((l) => l.layer_number === 1)!.title).toBe("Learn more");
    });

    it("a blank line added to the repository's CSV: nothing, and no change of the Compositor's", async () => {
      await commitPanels("head", "Learn more", "Deeper", "More", "\n");
      const result = conclusive(await check(await d1Panels("Learn more", "More")));
      expect(result.changes).toEqual([]);
      expect(result.suppressedEditorOnly).toBe(0);
    });

    it("a GitHub edit to layer 2's text: github-only", async () => {
      await commitPanels("head", "Learn more", "Deeper, edited on GitHub", "More");
      const [change] = conclusive(await check(await d1Panels("Learn more", "More"))).changes;
      expect(change).toMatchObject({ story_id: SLUG, kind: "github-only", acceptByDefault: true });
    });
  });

  it("no title of its own, with a GitHub edit to layer 2: github-only", async () => {
    await commitPanels("head", "Learn more", "Deeper, edited on GitHub");
    const [change] = conclusive(await check(await d1Panels(null))).changes;
    expect(change).toMatchObject({ story_id: SLUG, kind: "github-only", acceptByDefault: true });
  });

  it("the repository turned Spanish, with a body edit, against untouched D1: github-only, no false conflict", async () => {
    // The Spanish site's own heading for layer 1, and layer 2's text edited.
    await commitPanels("head", "Saber más", "Más profundo");
    const [change] = conclusive(await check(await d1Panels(null))).changes;
    expect(change).toMatchObject({ story_id: SLUG, kind: "github-only", acceptByDefault: true });
    expect(change.summary.changedSteps).toBe(1);
  });

  it("the repository turned Spanish, and nothing else changed: nothing", async () => {
    await commitPanels("head", "Saber más", "Deeper");
    expect(conclusive(await check(await d1Panels(null))).changes).toEqual([]);
  });

  it("the accept reads layer 1 with no title", async () => {
    await commitPanels("head", "Saber más", "Más profundo");
    const rows = (await readStoriesForAccept({ token: "tok", owner: "owner", repo: "repo" }, "head", [SLUG])).get(SLUG)!;
    expect(rows.layerRows.find((l) => l.layer_number === 1)!.title).toBeNull();
    expect(rows.layerRows.find((l) => l.layer_number === 2)!.content).toBe("Más profundo");
  });
});

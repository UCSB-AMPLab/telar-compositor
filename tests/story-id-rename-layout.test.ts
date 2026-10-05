/**
 * A publish writes a renamed story in the layout of the file it was last
 * written to: its comment row, header text and column order, as
 * a publish keeps them for a story at its own path. The story's CSV at its
 * new path is absent, so the publish reads the file its `source_path` names in
 * the spreadsheets folder, when the listing at the publish ref holds it.
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

import { buildPublishFileSet, computeStoryDeletions, renderStoryFiles, type PublishSnapshot } from "~/lib/publish.server";
import { STORY_ONLY_PUBLISH, importAsD1 } from "./story-canonical-fixtures";
import type { D1Story } from "./story-canonical-fixtures";
import { serveOtherStories, serveStory } from "./story-canonical-fakedb";
import { deletedStoryLayerFiles, renamedStorySheets, sheetsOfStoriesWritten } from "~/lib/story-left-files.server";

const SHEETS = "telar-content/spreadsheets";
const OLD_PATH = `${SHEETS}/blank_template.csv`;
const NEW_PATH = `${SHEETS}/fluidity.csv`;

/** The author's file under the old ID: a comment row and a column order of its own. */
const AUTHOR_FILE = "step,question,answer,object\n#,the heading,the text,the object\n1,Q,A,obj-1\n";

let story: D1Story;

function listedSheets(...names: string[]) {
  getSubtreeOids.mockResolvedValue({ ok: true, at: () => ({ kind: "tree", oid: "tree-oid" }) });
  listSubtreeEntries.mockResolvedValue({ files: new Map(names.map((n) => [n, "blob-of-" + n])), dirs: new Set() });
}

/** The renamed story as D1 holds it after the snapshot, with the file it was last written to. */
async function serveRenamed(sourcePath: string | null) {
  story = await importAsD1({ slug: "blank_template", csv: AUTHOR_FILE, layerFiles: {} });
  serveStory({ ...story, story: { ...story.story, story_id: "fluidity", source_path: sourcePath } as D1Story["story"] });
}

async function publishedNewCsv(): Promise<string> {
  const files = await buildPublishFileSet({ ...STORY_ONLY_PUBLISH });
  return files.find((f) => f.path === NEW_PATH)!.content;
}

/** The CSVs one publish writes at `paths`. */
async function publishedCsvs(...paths: string[]): Promise<string[]> {
  const files = await buildPublishFileSet({ ...STORY_ONLY_PUBLISH });
  return paths.map((path) => files.find((f) => f.path === path)!.content);
}

async function plainNewCsv(): Promise<string> {
  const files = await renderStoryFiles("fluidity", story.stepRows, story.layerRows);
  return files.find((f) => f.path === NEW_PATH)!.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  serveOtherStories([]);
  getFileAtRef.mockImplementation(async (_t: string, _o: string, _r: string, path: string) =>
    path === OLD_PATH ? { status: "ok", content: AUTHOR_FILE } : { status: "absent" });
});

describe("publishing a renamed story", () => {
  it("writes the new CSV with the old file's comment row and column order", async () => {
    await serveRenamed(OLD_PATH);
    listedSheets("blank_template.csv");

    const lines = (await publishedNewCsv()).split("\n");

    expect(lines[0].startsWith("step,question,answer,object,")).toBe(true);
    expect(lines[2]).toBe("#,the heading,the text,the object");
    const oldReads = getFileAtRef.mock.calls.filter((c) => c[3] === OLD_PATH);
    expect(oldReads).toHaveLength(1);
    expect(oldReads[0][4]).toBe(STORY_ONLY_PUBLISH.ref);
    expect(oldReads[0][5]).toEqual({ strict: true });
  });

  it("writes the plain render when the old file is not in the listing", async () => {
    await serveRenamed(OLD_PATH);
    listedSheets();
    expect(await publishedNewCsv()).toBe(await plainNewCsv());
    expect(getFileAtRef.mock.calls.filter((c) => c[3] === OLD_PATH)).toHaveLength(0);
  });

  it("reads no other path than the spreadsheets folder's", async () => {
    await serveRenamed("_data/blank_template.csv");
    listedSheets("blank_template.csv");
    expect(await publishedNewCsv()).toBe(await plainNewCsv());
    expect(getFileAtRef.mock.calls.filter((c) => c[3] === OLD_PATH)).toHaveLength(0);
  });
});

describe("publishing a story whose new ID is another file's name", () => {
  // Story B's file, at the ID story A takes: its own comment row.
  const B_FILE = "step,question,answer,object\n#,B heading,B text,B object\n1,BQ,BA,obj-9\n";
  const A_PATH = `${SHEETS}/blank_template.csv`;
  const B_PATH = `${SHEETS}/fluidity.csv`;

  beforeEach(() => {
    getFileAtRef.mockImplementation(async (_t: string, _o: string, _r: string, path: string) =>
      path === A_PATH ? { status: "ok", content: AUTHOR_FILE }
        : path === B_PATH ? { status: "ok", content: B_FILE }
          : { status: "absent" });
  });

  const other = (story_id: string, source_path: string | null) => ({ id: 99, story_id, source_path });

  // A chain: A takes the ID B leaves, and B records that file as its own.
  it("lays the story out from its own file when another story records the file at its ID", async () => {
    await serveRenamed(A_PATH);
    serveOtherStories([other("river", B_PATH)]);
    listedSheets("blank_template.csv", "fluidity.csv");

    const csv = await publishedNewCsv();

    expect(csv.split("\n")[2]).toBe("#,the heading,the text,the object");
    expect(csv).not.toContain("B heading");
  });

  it("deletes the file it was laid out from, and no file another story writes", () => {
    const chain = [
      { story_id: "fluidity", source_path: A_PATH },
      { story_id: "river", source_path: B_PATH },
    ];
    expect(renamedStorySheets(chain)).toEqual([A_PATH]);
  });

  // The post-publish source_path update is non-fatal, so it can be stale: the
  // story was published to its ID, and another story now holds the old file.
  it("lays the story out from the file at its ID when its recorded file is another story's now", async () => {
    await serveRenamed(A_PATH);
    serveOtherStories([other("blank_template", A_PATH)]);
    listedSheets("blank_template.csv", "fluidity.csv");

    const csv = await publishedNewCsv();

    expect(csv.split("\n")[2]).toBe("#,B heading,B text,B object");
  });

  // A story never published records no file and claims none, so A's record stands.
  it("lays the story out from its recorded file when the story now at that ID records none", async () => {
    await serveRenamed(A_PATH);
    serveOtherStories([other("blank_template", null), { id: 98, story_id: "river", source_path: B_PATH }]);
    listedSheets("blank_template.csv", "fluidity.csv");
    expect((await publishedNewCsv()).split("\n")[2]).toBe("#,the heading,the text,the object");
  });

  it("lays out a story that took its own recorded file from the file at its ID", async () => {
    await serveRenamed(B_PATH);
    listedSheets("fluidity.csv");
    expect((await publishedNewCsv()).split("\n")[2]).toBe("#,B heading,B text,B object");
  });

  it("uses the file at the new ID when the file the story was written to is gone", async () => {
    await serveRenamed(A_PATH);
    listedSheets("fluidity.csv");
    expect((await publishedNewCsv()).split("\n")[2]).toBe("#,B heading,B text,B object");
  });
});

describe("which story a file at an ID belongs to", () => {
  // A is the served story: blank_template -> fluidity, its record A's old file.
  const B_FILE = "step,question,answer,object\n#,B heading,B text,B object\n1,BQ,BA,obj-9\n";
  const A_PATH = `${SHEETS}/blank_template.csv`;
  const B_PATH = `${SHEETS}/fluidity.csv`;
  const A_ROW = "#,the heading,the text,the object";
  const B_ROW = "#,B heading,B text,B object";

  beforeEach(() => {
    getFileAtRef.mockImplementation(async (_t: string, _o: string, _r: string, path: string) =>
      path === A_PATH ? { status: "ok", content: AUTHOR_FILE }
        : path === B_PATH ? { status: "ok", content: B_FILE }
          : { status: "absent" });
  });

  // Case 1: story B, at fluidity, is deleted and A takes its ID; no record names B's file.
  it("lays a story out from its own file, not that of a deleted story whose ID it took", async () => {
    await serveRenamed(A_PATH);
    listedSheets("blank_template.csv", "fluidity.csv");

    const csv = await publishedNewCsv();

    expect(csv.split("\n")[2]).toBe(A_ROW);
    expect(csv).not.toContain("B heading");
  });

  // Case 2: B moved fluidity -> river and records nothing.
  it("lays a story out from its own file when the story that left the ID records none", async () => {
    await serveRenamed(A_PATH);
    serveOtherStories([{ id: 98, story_id: "river", source_path: null }]);
    listedSheets("blank_template.csv", "fluidity.csv");

    const csv = await publishedNewCsv();

    expect(csv.split("\n")[2]).toBe(A_ROW);
    expect(csv).not.toContain("B heading");
  });

  it("lays each of two stories that exchanged IDs out from its own file", async () => {
    await serveRenamed(A_PATH);
    serveOtherStories([{ id: 98, story_id: "blank_template", source_path: B_PATH }]);
    listedSheets("blank_template.csv", "fluidity.csv");

    const [aCsv, bCsv] = await publishedCsvs(B_PATH, A_PATH);

    expect(aCsv).toContain(A_ROW);
    expect(aCsv).not.toContain("B heading");
    expect(bCsv).toContain(B_ROW);
    expect(bCsv).not.toContain("the heading");
  });

  it("renders plain a new story at the ID another story left, which keeps its file", async () => {
    await serveRenamed(A_PATH);
    serveOtherStories([{ id: 98, story_id: "blank_template", source_path: null }]);
    listedSheets("blank_template.csv");

    const [aCsv, cCsv] = await publishedCsvs(B_PATH, A_PATH);

    expect(aCsv).toContain(A_ROW);
    const plainC = (await renderStoryFiles("blank_template", [], [])).find((f) => f.path === A_PATH)!.content;
    expect(cCsv).toBe(plainC);
    expect(getFileAtRef.mock.calls.filter((c) => c[3] === A_PATH)).toHaveLength(1);
  });

  // A was published at fluidity, but the record of that failed; C has since
  // been published at blank_template and records it.
  it("reads a stale record as yielding to the story whose own file it is", async () => {
    await serveRenamed(A_PATH);
    serveOtherStories([{ id: 98, story_id: "blank_template", source_path: A_PATH }]);
    listedSheets("blank_template.csv", "fluidity.csv");

    const [aCsv, cCsv] = await publishedCsvs(B_PATH, A_PATH);
    expect(aCsv).toContain(B_ROW);
    expect(cCsv).toContain(A_ROW);
  });
});

describe("a publish after a story takes the ID of one deleted", () => {
  const A_PATH = `${SHEETS}/blank_template.csv`;
  const B_PATH = `${SHEETS}/fluidity.csv`;
  const TEXTS = "telar-content/texts/stories";
  const A_FILE = [
    "step,question,answer,object,layer1_button,layer1_content",
    "#,the heading,the text,the object,,",
    "1,Q,A,obj-1,More,blank_template-intro.md",
  ].join("\n") + "\n";
  const B_FILE = "step,question,answer,object,layer1_content\n#,B heading,B text,B object,\n1,BQ,BA,obj-9,fluidity-old.md\n";
  const heads: Record<string, string> = {
    [A_PATH]: A_FILE,
    [B_PATH]: B_FILE,
    [`${TEXTS}/blank_template-intro.md`]: "Intro",
    [`${TEXTS}/fluidity-old.md`]: "Old",
  };

  it("writes the story from its own file and deletes its old file and both stories' layer files", async () => {
    story = await importAsD1({ slug: "blank_template", csv: A_FILE, layerFiles: { "blank_template-intro.md": "Intro" } });
    serveStory({ ...story, story: { ...story.story, story_id: "fluidity", source_path: A_PATH } as D1Story["story"] });
    getFileAtRef.mockImplementation(async (_t: string, _o: string, _r: string, path: string) =>
      heads[path] === undefined ? { status: "absent" } : { status: "ok", content: heads[path] });
    getSubtreeOids.mockResolvedValue({ ok: true, at: (_ref: string, dir: string) => ({ kind: "tree", oid: dir }) });
    listSubtreeEntries.mockImplementation(async (_t: string, _o: string, _r: string, oid: string) => ({
      files: new Map(Object.keys(heads).filter((p) => p.startsWith(`${oid}/`)).map((p) => [p.slice(oid.length + 1), `blob-${p}`])),
      dirs: new Set(),
    }));

    const files = await buildPublishFileSet({ ...STORY_ONLY_PUBLISH });
    const rows = [{ story_id: "fluidity", source_path: A_PATH }];
    const snapshot = { story_ids: ["blank_template", "fluidity"], all_story_ids: ["blank_template", "fluidity"] } as unknown as PublishSnapshot;
    const storyDeletions = [...new Set([...computeStoryDeletions(["fluidity"], snapshot), ...renamedStorySheets(rows)])];
    const layerDeletions = await deletedStoryLayerFiles(
      { token: "tok", owner: "owner", repo: "repo", ref: "sha" },
      [...storyDeletions, ...sheetsOfStoriesWritten(rows, files)],
      files,
    );

    const written = files.find((f) => f.path === B_PATH)!.content;
    expect(written).toContain("#,the heading,the text,the object");
    expect(written).not.toContain("B heading");
    expect(storyDeletions).toEqual([A_PATH]);
    expect(layerDeletions.sort()).toEqual([`${TEXTS}/blank_template-intro.md`, `${TEXTS}/fluidity-old.md`]);
  });
});

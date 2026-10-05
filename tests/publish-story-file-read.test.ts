/**
 * What a publish reads of the step CSVs on GitHub before it rewrites them.
 *
 * The spreadsheets subtree is listed once at the publish ref. A story whose
 * file's blob is the blob of the plain render holds nothing the render does
 * not, so it is not read; any other is read strictly at the ref and rendered
 * in its own layout. A listing or a read that fails refuses the publish, naming
 * the story, because a file that cannot be read is never overwritten.
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

import { UnreadablePublishFileError, buildPublishFileSet, renderStoryFiles } from "~/lib/publish.server";
import { gitBlobSha } from "~/lib/story-files.server";
import { STORY_ONLY_PUBLISH, importAsD1 } from "./story-canonical-fixtures";
import type { D1Story } from "./story-canonical-fixtures";
import { serveStory } from "./story-canonical-fakedb";

const SHEETS = "telar-content/spreadsheets";
const SLUG = "historia";
const PATH = `${SHEETS}/${SLUG}.csv`;
const TREE_OID = "tree-oid";

/** The author's file: a comment row and a column order of its own. */
const AUTHOR_FILE = "step,question,answer,object\n#,the heading,the text,the object\n1,Q,A,obj-1\n";

let story: D1Story;

async function plainCsv(): Promise<string> {
  const files = await renderStoryFiles(SLUG, story.stepRows, story.layerRows);
  return files.find((f) => f.path === PATH)!.content;
}

/** The subtree listed with `historia.csv` at `sha`, or without it when `sha` is undefined. */
function listed(sha: string | undefined) {
  getSubtreeOids.mockResolvedValue({ ok: true, at: () => ({ kind: "tree", oid: TREE_OID }) });
  const files = new Map<string, string>();
  if (sha !== undefined) files.set(`${SLUG}.csv`, sha);
  listSubtreeEntries.mockResolvedValue({ files, dirs: new Set() });
}

function storyReads() {
  return getFileAtRef.mock.calls.filter((call) => call[3] === PATH);
}

async function publishedCsv(): Promise<string> {
  const files = await buildPublishFileSet({ ...STORY_ONLY_PUBLISH });
  return files.find((f) => f.path === PATH)!.content;
}

beforeEach(async () => {
  vi.clearAllMocks();
  story = await importAsD1({ slug: SLUG, csv: AUTHOR_FILE, layerFiles: {} });
  serveStory(story);
  getFileAtRef.mockImplementation(async (_t: string, _o: string, _r: string, path: string) =>
    path === PATH ? { status: "ok", content: AUTHOR_FILE } : { status: "absent" });
});

describe("a story whose file is the plain render", () => {
  it("is not read, and publishes the plain render", async () => {
    listed(await gitBlobSha(await plainCsv()));

    expect(await publishedCsv()).toBe(await plainCsv());
    expect(storyReads()).toHaveLength(0);
  });
});

describe("a story with no file", () => {
  it("is not read, and publishes the plain render", async () => {
    listed(undefined);

    expect(await publishedCsv()).toBe(await plainCsv());
    expect(storyReads()).toHaveLength(0);
  });
});

describe("a story whose file differs from the plain render", () => {
  it("is read strictly at the publish ref and published in its own layout", async () => {
    listed("some-other-blob");

    const csv = await publishedCsv();

    expect(storyReads()).toHaveLength(1);
    const [, , , , ref, options] = storyReads()[0];
    expect(ref).toBe(STORY_ONLY_PUBLISH.ref);
    expect(options).toEqual({ strict: true });
    const lines = csv.split("\n");
    expect(lines[0].startsWith("step,question,answer,object,")).toBe(true);
    expect(lines[2]).toBe("#,the heading,the text,the object");
  });

  it("lists the spreadsheets subtree once, at the publish ref", async () => {
    listed("some-other-blob");

    await publishedCsv();

    expect(getSubtreeOids).toHaveBeenCalledTimes(1);
    expect(getSubtreeOids.mock.calls[0][3]).toEqual([STORY_ONLY_PUBLISH.ref]);
    expect(getSubtreeOids.mock.calls[0][4]).toEqual([SHEETS]);
    expect(listSubtreeEntries).toHaveBeenCalledWith("tok", "owner", "repo", TREE_OID);
  });
});

describe("a publish whose story files cannot be read", () => {
  it("is refused when the subtree cannot be resolved", async () => {
    getSubtreeOids.mockResolvedValue({ ok: false, reason: "malformed" });

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({
      name: "UnreadablePublishFileError",
      file: "stories",
    });
  });

  it("is refused when the request for the subtree fails", async () => {
    getSubtreeOids.mockRejectedValue(new Error("GitHub GraphQL error: 502"));

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({ file: "stories", path: SHEETS });
  });

  it("is refused when the subtree cannot be listed completely", async () => {
    getSubtreeOids.mockResolvedValue({ ok: true, at: () => ({ kind: "tree", oid: TREE_OID }) });
    listSubtreeEntries.mockResolvedValue(null);

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toBeInstanceOf(UnreadablePublishFileError);
  });

  it("is refused when the spreadsheets path is not a directory", async () => {
    getSubtreeOids.mockResolvedValue({ ok: true, at: () => ({ kind: "other", type: "Blob" }) });

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toBeInstanceOf(UnreadablePublishFileError);
  });

  it("is refused, naming the story, when its file cannot be read", async () => {
    listed("some-other-blob");
    getFileAtRef.mockImplementation(async (_t: string, _o: string, _r: string, path: string) =>
      path === PATH ? { status: "error" } : { status: "absent" });

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({
      name: "UnreadablePublishFileError",
      file: "stories",
      path: PATH,
    });
  });

  it("is refused when a listed file reads as absent", async () => {
    listed("some-other-blob");
    getFileAtRef.mockResolvedValue({ status: "absent" });

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({ file: "stories", path: PATH });
  });
});

describe("a publish with no stories", () => {
  it("lists nothing", async () => {
    serveStory(null);

    await buildPublishFileSet({ ...STORY_ONLY_PUBLISH });

    expect(getSubtreeOids).not.toHaveBeenCalled();
  });
});

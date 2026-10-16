/**
 * What a publish reads of the step CSVs on GitHub before it rewrites them.
 *
 * The spreadsheets folder is listed once at the publish ref, without
 * recursion. A story whose file's blob is the blob of the plain render holds
 * nothing the render does not, so it is not read; any other is read strictly
 * at the ref and rendered in its own layout. A listing or a read that fails
 * refuses the publish, naming the story, because a file that cannot be read is
 * never overwritten; so does a story's own CSV that is not a regular file. What
 * else the folder holds that is not a regular file refuses nothing.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getFileAtRef, getSubtreeOids, listDirectoryEntries } = vi.hoisted(() => ({
  getFileAtRef: vi.fn(),
  getSubtreeOids: vi.fn(),
  listDirectoryEntries: vi.fn(),
}));

vi.mock("~/lib/db.server", async () => {
  const { fakeGetDb } = await import("./story-canonical-fakedb");
  return { getDb: vi.fn(() => fakeGetDb()) };
});
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getFileAtRef, getSubtreeOids, listDirectoryEntries, getFileContent: vi.fn(async () => null) };
});

import { UnreadablePublishFileError, buildPublishFileSet, renderStoryFiles } from "~/lib/publish.server";
import { gitBlobSha } from "~/lib/story-files.server";
import { STORY_ONLY_PUBLISH, importAsD1 } from "./story-canonical-fixtures";
import type { D1Story } from "./story-canonical-fixtures";
import { serveStory } from "./story-canonical-fakedb";

const SHEETS = "telar-content/spreadsheets";
const SLUG = "historia";
const PATH = `${SHEETS}/${SLUG}.csv`;

/** The author's file: a comment row and a column order of its own. */
const AUTHOR_FILE = "step,question,answer,object\n#,the heading,the text,the object\n1,Q,A,obj-1\n";

let story: D1Story;

async function plainCsv(): Promise<string> {
  const files = await renderStoryFiles(SLUG, story.stepRows, story.layerRows);
  return files.find((f) => f.path === PATH)!.content;
}

/** A regular file in the folder, as the listing gives it. */
function file(name: string, sha: string) {
  return { path: `${SHEETS}/${name}`, mode: "100644", type: "blob", sha };
}

/** The folder listed with `historia.csv` at `sha`, or without it when `sha` is undefined, beside `others`. */
function listed(sha: string | undefined, others: unknown[] = [file("objects.csv", "objects-blob")]) {
  listDirectoryEntries.mockResolvedValue([...(sha === undefined ? [] : [file(`${SLUG}.csv`, sha)]), ...others]);
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

  it("lists the spreadsheets folder once, at the publish ref", async () => {
    listed("some-other-blob");

    await publishedCsv();

    expect(listDirectoryEntries).toHaveBeenCalledTimes(1);
    expect(listDirectoryEntries).toHaveBeenCalledWith("tok", "owner", "repo", STORY_ONLY_PUBLISH.ref, SHEETS);
  });
});

describe("a spreadsheets folder holding what is not a regular file", () => {
  it("publishes when a symbolic link, a submodule and a subfolder there are not a story's own CSV", async () => {
    listed("some-other-blob", [
      { path: `${SHEETS}/elsewhere.csv`, mode: "120000", type: "blob", sha: "link-blob" },
      { path: `${SHEETS}/vendor`, mode: "160000", type: "commit", sha: "submodule-commit" },
      { path: `${SHEETS}/old`, mode: "040000", type: "tree", sha: "old-tree" },
    ]);

    const csv = await publishedCsv();

    expect(csv.split("\n")[2]).toBe("#,the heading,the text,the object");
  });

  it("is refused, naming the story's CSV, when that CSV is a symbolic link", async () => {
    listed(undefined, [{ path: PATH, mode: "120000", type: "blob", sha: "link-blob" }]);

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({ file: "stories", path: PATH });
    expect(storyReads()).toHaveLength(0);
  });

  it("is refused, naming the story's CSV, when a folder stands at its path", async () => {
    listed(undefined, [{ path: PATH, mode: "040000", type: "tree", sha: "a-tree" }]);

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({ file: "stories", path: PATH });
  });
});

describe("a publish whose story files cannot be read", () => {
  it("is refused when the request for the listing fails", async () => {
    listDirectoryEntries.mockRejectedValue(new Error("GitHub API error listing telar-content/spreadsheets: 502"));

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({
      name: "UnreadablePublishFileError",
      file: "stories",
      path: SHEETS,
    });
  });

  it("is refused when the folder cannot be listed completely", async () => {
    listDirectoryEntries.mockRejectedValue(new Error(`the listing of ${SHEETS} is incomplete`));

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toBeInstanceOf(UnreadablePublishFileError);
  });

  it("is refused when the spreadsheets path is not a directory", async () => {
    listDirectoryEntries.mockResolvedValue([]);
    getSubtreeOids.mockResolvedValue({ ok: true, at: () => ({ kind: "other", type: "Blob" }) });

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({ file: "stories", path: SHEETS });
  });

  it("is refused when an empty listing cannot be told from a path that is not a directory", async () => {
    listDirectoryEntries.mockResolvedValue([]);
    getSubtreeOids.mockRejectedValue(new Error("GitHub GraphQL error: 502"));

    await expect(buildPublishFileSet({ ...STORY_ONLY_PUBLISH })).rejects.toMatchObject({ file: "stories", path: SHEETS });
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

describe("a site with no spreadsheets folder", () => {
  it("publishes the plain render", async () => {
    listDirectoryEntries.mockResolvedValue([]);
    getSubtreeOids.mockResolvedValue({ ok: true, at: () => ({ kind: "absent" }) });

    expect(await publishedCsv()).toBe(await plainCsv());
  });
});

describe("a publish with no stories", () => {
  it("lists nothing", async () => {
    serveStory(null);

    await buildPublishFileSet({ ...STORY_ONLY_PUBLISH });

    expect(listDirectoryEntries).not.toHaveBeenCalled();
    expect(getSubtreeOids).not.toHaveBeenCalled();
  });
});

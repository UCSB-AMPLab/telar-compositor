/**
 * A publish that writes a story imported from an older path deletes the older
 * copy in the same commit.
 *
 * An older copy at `_data/<id>.csv` or `<id>.csv` is deleted only when it is
 * the file the Compositor read the story from (`stories.source_path`),
 * so a story made in the Compositor, or imported before the path was recorded,
 * has no older copy deleted however its id matches a file. It is deleted only
 * when it is also one of the files the unreadable-characters warning covers: present at the
 * head the publish is built on, the story's CSV in the spreadsheets folder
 * absent there, and its bytes not valid UTF-8. A readable older copy is never
 * deleted: a story the sync inserted, a Google Sheets import, or a story whose
 * id matches an unrelated CSV may sit beside one that holds the only copy of
 * something. The root copy is read by the import only when there is no
 * `_data` copy, so it is deleted only when `_data/<id>.csv` is absent too. A
 * read of a selected copy that fails refuses the commit, so a retry can still
 * find it; a copy gone by the time it is read is left alone. No other id's file
 * is ever named.
 *
 * An unreadable `_data/<id>.csv` stops the build, so it is deleted whatever
 * the path the story was read from, NULL included, under the same guards; only
 * the root copy, which the site does not read, waits on `source_path`.
 *
 * A story deleted before the publish has no CSV written for it; its `_data`
 * copy is named on the same terms for each id GitHub's project.csv lists, read
 * as the import reads it, that no D1 story has, and its root copy
 * never is, since no path it was read from is recorded. project.csv absent, or
 * one the import cannot parse, names nothing; one that cannot be read refuses
 * the publish.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnreadableOlderCopyError, commitFilesToRepo } from "~/lib/commit.server";
import { UnreadableProjectCsvError, deletedStoryDataCopies, olderStoryCopies } from "~/lib/publish.server";

const SHEETS = "telar-content/spreadsheets";

describe("olderStoryCopies", () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, content: "" }));
  const story = (source_path: string | null, story_id = "story-one") => ({ story_id, source_path });
  const WRITTEN = files(`${SHEETS}/story-one.csv`, `${SHEETS}/objects.csv`);

  it("names the _data copy, unless the spreadsheets CSV is there, for a story read from it", () => {
    expect(olderStoryCopies(WRITTEN, [story("_data/story-one.csv")])).toEqual([
      { path: "_data/story-one.csv", unlessPresent: [`${SHEETS}/story-one.csv`], onlyIfUnreadable: true },
    ]);
  });

  it("names the root copy, unless the spreadsheets CSV or a _data copy is there, beside the _data copy, for a story read from it", () => {
    expect(olderStoryCopies(WRITTEN, [story("story-one.csv")])).toEqual([
      { path: "_data/story-one.csv", unlessPresent: [`${SHEETS}/story-one.csv`], onlyIfUnreadable: true },
      { path: "story-one.csv", unlessPresent: [`${SHEETS}/story-one.csv`, "_data/story-one.csv"], onlyIfUnreadable: true },
    ]);
  });

  it("names the _data copy and not the root copy for a story with no recorded path, or read from the spreadsheets folder", () => {
    expect(olderStoryCopies(WRITTEN, [story(null)])).toEqual([{ path: "_data/story-one.csv", unlessPresent: [`${SHEETS}/story-one.csv`], onlyIfUnreadable: true }]);
    expect(olderStoryCopies(WRITTEN, [story(`${SHEETS}/story-one.csv`)])).toEqual([{ path: "_data/story-one.csv", unlessPresent: [`${SHEETS}/story-one.csv`], onlyIfUnreadable: true }]);
  });

  it("names no root copy for a path that is another story's copy", () => {
    expect(olderStoryCopies(WRITTEN, [story("story-two.csv")])).toEqual([{ path: "_data/story-one.csv", unlessPresent: [`${SHEETS}/story-one.csv`], onlyIfUnreadable: true }]);
  });

  it("names nothing for a story the publish does not write, or for another id", () => {
    expect(olderStoryCopies(files(`${SHEETS}/story-one.csv`), [story("_data/story-two.csv", "story-two")])).toEqual([]);
    expect(olderStoryCopies(files(`${SHEETS}/objects.csv`, `${SHEETS}/project.csv`), [story("_data/story-one.csv")])).toEqual([]);
  });
});

describe("commitFilesToRepo with older copies", () => {
  let present: Set<string>;
  /** The bytes each path's contents read answers, or "fail" for a server error. */
  let blobs: Record<string, Uint8Array | "fail">;
  let contentReads: string[];
  let mutation: { variables: { input: { fileChanges: { deletions?: Array<{ path: string }> } } } } | null;

  beforeEach(() => {
    mutation = null;
    blobs = {};
    contentReads = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      const contents = /\/repos\/o\/r\/contents\/([^?]+)\?ref=head-sha$/.exec(String(url));
      if (contents) {
        const path = contents[1].split("/").map(decodeURIComponent).join("/");
        contentReads.push(path);
        const blob = blobs[path];
        if (blob === "fail") return new Response("boom", { status: 502 });
        if (!blob) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        return new Response(
          JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(blob).toString("base64"), size: blob.length }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
      if (body.query.includes("CheckPaths")) {
        const repository: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(body.variables)) {
          if (!/^p\d+$/.test(key)) continue;
          repository[key] = present.has(value.slice(value.indexOf(":") + 1)) ? { __typename: "Blob" } : null;
        }
        return new Response(JSON.stringify({ data: { repository } }), { status: 200 });
      }
      if (body.query.includes("CreateCommit")) {
        mutation = body as never;
        return new Response(
          JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: "new", url: "u" } } } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected query ${body.query}`);
    }) as unknown as typeof fetch;
  });

  const READABLE = new TextEncoder().encode("step,object\n1,bell\n");
  const LOSSY = Uint8Array.of(...new TextEncoder().encode("step,object\n1,bell"), 0xff, 0x0a);

  /** The deletions a publish of story-one commits, the story read from `source` (`_data` unless given). */
  async function commit(deletions?: string[], source: string | null = "_data/story-one.csv") {
    const files = [{ path: `${SHEETS}/story-one.csv`, content: "step\n1\n" }];
    const older = olderStoryCopies(files, [{ story_id: "story-one", source_path: source }]);
    await commitFilesToRepo("tok", "o", "r", "main", files, "Publish site", undefined, deletions, undefined, "head-sha", older);
    return (mutation?.variables.input.fileChanges.deletions ?? []).map((d) => d.path);
  }

  it("with both copies unreadable, deletes the _data copy and keeps the root one, which the import did not read", async () => {
    present = new Set(["_data/story-one.csv", "story-one.csv"]);
    blobs = { "_data/story-one.csv": LOSSY, "story-one.csv": LOSSY };
    expect(await commit()).toEqual(["_data/story-one.csv"]);
  });

  it("keeps an unreadable root copy with no _data copy when the story was not read from it, and does not read it", async () => {
    present = new Set(["story-one.csv"]);
    blobs = { "story-one.csv": LOSSY };
    expect(await commit(undefined, null)).toEqual([]);
    expect(await commit(undefined, "_data/story-one.csv")).toEqual([]);
    expect(contentReads).toEqual([]);
  });

  it("deletes an unreadable root copy with no _data copy when the story was read from it", async () => {
    present = new Set(["story-one.csv"]);
    blobs = { "story-one.csv": LOSSY };
    expect(await commit(undefined, "story-one.csv")).toEqual(["story-one.csv"]);
  });

  it("deletes the unreadable _data copy of a story with no recorded path, since it stops the build, and never reads the root copy", async () => {
    present = new Set(["_data/story-one.csv", "story-one.csv"]);
    blobs = { "_data/story-one.csv": LOSSY, "story-one.csv": LOSSY };
    expect(await commit(undefined, null)).toEqual(["_data/story-one.csv"]);
    expect(contentReads).toEqual(["_data/story-one.csv"]);
  });

  it("deletes the copy the story was read from once: the next publish, with the spreadsheets CSV written, deletes and reads nothing", async () => {
    present = new Set(["_data/story-one.csv"]);
    blobs = { "_data/story-one.csv": LOSSY };
    expect(await commit()).toEqual(["_data/story-one.csv"]);
    present = new Set([`${SHEETS}/story-one.csv`, "_data/story-one.csv"]);
    contentReads = [];
    expect(await commit()).toEqual([]);
    expect(contentReads).toEqual([]);
  });

  it("keeps a readable _data copy with the spreadsheets CSV absent, as a story the sync inserted has", async () => {
    present = new Set(["_data/story-one.csv"]);
    blobs = { "_data/story-one.csv": READABLE };
    expect(await commit()).toEqual([]);
  });

  it("deletes an unreadable _data copy", async () => {
    present = new Set(["_data/story-one.csv"]);
    blobs = { "_data/story-one.csv": LOSSY };
    expect(await commit()).toEqual(["_data/story-one.csv"]);
  });

  it("keeps an unreadable root copy beside a readable _data copy, and does not read it", async () => {
    present = new Set(["_data/story-one.csv", "story-one.csv"]);
    blobs = { "_data/story-one.csv": READABLE, "story-one.csv": LOSSY };
    expect(await commit()).toEqual([]);
    expect(contentReads).toEqual(["_data/story-one.csv"]);
  });

  it("keeps an unreadable older copy when the story's spreadsheets CSV is there, and reads nothing", async () => {
    present = new Set(["_data/story-one.csv", "story-one.csv", `${SHEETS}/story-one.csv`]);
    blobs = { "_data/story-one.csv": LOSSY, "story-one.csv": LOSSY };
    expect(await commit()).toEqual([]);
    expect(contentReads).toEqual([]);
  });

  it("refuses the commit, naming the file, when a selected copy's read fails", async () => {
    present = new Set(["_data/story-one.csv"]);
    blobs = { "_data/story-one.csv": "fail" };
    const attempt = commit();
    await expect(attempt).rejects.toBeInstanceOf(UnreadableOlderCopyError);
    await expect(attempt).rejects.toThrow("_data/story-one.csv");
    expect(mutation).toBeNull();
  });

  it("deletes nothing and refuses nothing when a selected copy is gone by the time it is read", async () => {
    present = new Set(["_data/story-one.csv"]);
    expect(await commit()).toEqual([]);
    expect(mutation).not.toBeNull();
  });

  it("deletes nothing and reads nothing when no older copy is there", async () => {
    present = new Set();
    expect(await commit()).toEqual([]);
    expect(contentReads).toEqual([]);
  });

  it("keeps the other deletions as they were", async () => {
    present = new Set(["_data/story-one.csv", `${SHEETS}/gone.csv`]);
    blobs = { "_data/story-one.csv": LOSSY };
    expect(await commit([`${SHEETS}/gone.csv`, `${SHEETS}/never.csv`])).toEqual([
      `${SHEETS}/gone.csv`,
      "_data/story-one.csv",
    ]);
  });
});

/**
 * A story deleted in the Compositor before the next publish has no CSV written
 * for it, so its `_data` copy is named from GitHub's project.csv at the head
 * the publish is built on: each story id it lists, read as the
 * import reads it, that no D1 story has. Its root copy is never named: with the
 * story's row gone, no path it was read from is known.
 */
describe("the _data copy of a story project.csv lists and D1 no longer has", () => {
  let present: Set<string>;
  let blobs: Record<string, Uint8Array | "fail">;
  let contentReads: string[];
  let mutation: { variables: { input: { fileChanges: { deletions?: Array<{ path: string }> } } } } | null;

  const PROJECT = `${SHEETS}/project.csv`;
  const SOURCE = { token: "tok", owner: "o", repo: "r", ref: "head-sha" };
  const text = (s: string) => new TextEncoder().encode(s);
  const READABLE = text("step,object\n1,bell\n");
  const LOSSY = Uint8Array.of(...text("step,object\n1,bell"), 0xff, 0x0a);

  beforeEach(() => {
    mutation = null;
    blobs = {};
    present = new Set();
    contentReads = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      const contents = /\/repos\/o\/r\/contents\/([^?]+)\?ref=head-sha$/.exec(String(url));
      if (contents) {
        const path = contents[1].split("/").map(decodeURIComponent).join("/");
        contentReads.push(path);
        const blob = blobs[path];
        if (blob === "fail") return new Response("boom", { status: 502 });
        if (!blob) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        return new Response(
          JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(blob).toString("base64"), size: blob.length }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
      if (body.query.includes("CheckPaths")) {
        const repository: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(body.variables)) {
          if (!/^p\d+$/.test(key)) continue;
          repository[key] = present.has(value.slice(value.indexOf(":") + 1)) ? { __typename: "Blob" } : null;
        }
        return new Response(JSON.stringify({ data: { repository } }), { status: 200 });
      }
      if (body.query.includes("CreateCommit")) {
        mutation = body as never;
        return new Response(
          JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: "new", url: "u" } } } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected query ${body.query}`);
    }) as unknown as typeof fetch;
  });

  const listing = (header: string, ...ids: string[]) => text(`${header},title\n${ids.map((id) => `${id},T`).join("\n")}\n`);

  /** The deletions a publish of `d1Ids` commits, with project.csv as `blobs` holds it. */
  async function publishDeletions(d1Ids: string[]) {
    const older = await deletedStoryDataCopies(SOURCE, d1Ids);
    await commitFilesToRepo(
      "tok", "o", "r", "main",
      [{ path: PROJECT, content: "story_id,title\n" }],
      "Publish site", undefined, undefined, undefined, "head-sha", older,
    );
    return (mutation?.variables.input.fileChanges.deletions ?? []).map((d) => d.path);
  }

  it("deletes the unreadable _data copy of a deleted story with no spreadsheets CSV", async () => {
    blobs = { [PROJECT]: listing("story_id", "gone"), "_data/gone.csv": LOSSY };
    present = new Set([PROJECT, "_data/gone.csv"]);
    expect(await publishDeletions([])).toEqual(["_data/gone.csv"]);
  });

  it("keeps a readable _data copy of a deleted story", async () => {
    blobs = { [PROJECT]: listing("story_id", "gone"), "_data/gone.csv": READABLE };
    present = new Set([PROJECT, "_data/gone.csv"]);
    expect(await publishDeletions([])).toEqual([]);
  });

  it("keeps the _data copy of a deleted story whose spreadsheets CSV is there, and reads none of its copies", async () => {
    blobs = { [PROJECT]: listing("story_id", "gone"), "_data/gone.csv": LOSSY, "gone.csv": LOSSY };
    present = new Set([PROJECT, "_data/gone.csv", "gone.csv", `${SHEETS}/gone.csv`]);
    expect(await publishDeletions([])).toEqual([]);
    expect(contentReads).toEqual([PROJECT]);
  });

  it("keeps an unreadable root copy of a deleted story with no _data copy, and does not read it", async () => {
    blobs = { [PROJECT]: listing("story_id", "gone"), "gone.csv": LOSSY };
    present = new Set([PROJECT, "gone.csv"]);
    expect(await publishDeletions([])).toEqual([]);
    expect(contentReads).toEqual([PROJECT]);
  });

  it("keeps an unreadable root copy of a deleted story beside a _data copy", async () => {
    blobs = { [PROJECT]: listing("story_id", "gone"), "_data/gone.csv": READABLE, "gone.csv": LOSSY };
    present = new Set([PROJECT, "_data/gone.csv", "gone.csv"]);
    expect(await publishDeletions([])).toEqual([]);
  });

  it("names nothing when project.csv is absent", async () => {
    expect(await deletedStoryDataCopies(SOURCE, [])).toEqual([]);
    expect(contentReads).toEqual([PROJECT, `${SHEETS}/proyecto.csv`]);
  });

  it("refuses, naming project.csv, when its read fails", async () => {
    blobs = { [PROJECT]: "fail" };
    const attempt = deletedStoryDataCopies(SOURCE, []);
    await expect(attempt).rejects.toBeInstanceOf(UnreadableProjectCsvError);
    await expect(attempt).rejects.toThrow(PROJECT);
  });

  it("an unparseable project.csv names no extra copies and the commit goes through", async () => {
    // Two columns resolving to story_id, both holding values: the import refuses this sheet.
    blobs = { [PROJECT]: text("story_id,id_historia,title\na,b,T\n"), "_data/a.csv": LOSSY, "_data/b.csv": LOSSY };
    present = new Set([PROJECT, "_data/a.csv", "_data/b.csv"]);
    expect(await deletedStoryDataCopies(SOURCE, [])).toEqual([]);
    expect(await publishDeletions([])).toEqual([]);
    expect(mutation).not.toBeNull();
  });

  it("finds an id under a column header the import takes as an alias of story_id", async () => {
    blobs = { [PROJECT]: listing("id_historia", "gone") };
    expect(await deletedStoryDataCopies(SOURCE, [])).toEqual([
      { path: "_data/gone.csv", unlessPresent: [`${SHEETS}/gone.csv`], onlyIfUnreadable: true },
    ]);
  });

  it("names nothing for a story still in D1, which olderStoryCopies covers", async () => {
    blobs = { [PROJECT]: listing("story_id", "kept", "gone") };
    const older = await deletedStoryDataCopies(SOURCE, ["kept"]);
    expect(older.map((c) => c.path)).toEqual(["_data/gone.csv"]);
  });

  it("names each path once for an id project.csv lists twice", async () => {
    blobs = { [PROJECT]: listing("story_id", "gone", "gone") };
    const older = await deletedStoryDataCopies(SOURCE, []);
    expect(older.map((c) => c.path)).toEqual(["_data/gone.csv"]);
  });
});

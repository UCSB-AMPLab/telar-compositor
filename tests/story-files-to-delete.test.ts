/**
 * The story files a first publish owes the repository a deletion of.
 *
 * A story deleted before any publish leaves its CSV (and the layer files that
 * CSV names) on GitHub, because no publish snapshot names it. The import and a
 * sync that inserts a story record the CSV they read, with the blob they read
 * it at (`projects.story_files_to_delete_json`); the next publish deletes each
 * recorded file whose story D1 does not hold, only while the file still has
 * that blob, and names a changed file it leaves.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(),
    getDefaultBranchHead: vi.fn(),
    getRepoTree: vi.fn(),
    getFileContent: vi.fn(),
    getFileAtRef: vi.fn(),
    getSubtreeOids: vi.fn(),
    listSubtreeEntries: vi.fn(),
  };
});

import { importRepo } from "~/lib/import.server";
import { getDb } from "~/lib/db.server";
import { gitBlobSha } from "~/lib/story-files.server";
import {
  owedStoryDeletions,
  parseOwedStoryFiles,
  recordStoryFileReads,
} from "~/lib/story-files-to-delete.server";
import {
  getFileAtRef,
  getFileContent,
  getRepoHead,
  getDefaultBranchHead,
  getRepoTree,
  getSubtreeOids,
  listSubtreeEntries,
} from "~/lib/github.server";

const HEAD = "head-sha";
const SHEETS = "telar-content/spreadsheets";
const STORY_CSV = "step,object,x,y,zoom,question,answer\n1,bell,0.5,0.5,1,Q,A\n";

let memory: MemoryD1;
let files: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  files = {
    "_config.yml": 'title: "Site"\ntelar:\n  version: "1.0.0"\n',
    "index.md": "---\ntitle: Home\n---\nWelcome.\n",
    "_data/themes/trama.yml": "name: Trama\n",
    [`${SHEETS}/objects.csv`]: "object_id,title\nbell,Bell\n",
    [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n2,story-two,Second\n",
    [`${SHEETS}/story-one.csv`]: STORY_CSV,
    "_data/story-two.csv": STORY_CSV,
  };
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: "main", oid: HEAD });
  vi.mocked(getRepoTree).mockImplementation(async () => ({
    tree: Object.keys(files).map((path) => ({ path, mode: "100644", type: "blob", sha: `sha-${path}` })),
    truncated: false,
  }));
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) =>
    path in files ? { status: "ok", content: files[path] } : { status: "absent" });
  vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) => (path in files ? files[path] : null));
  vi.mocked(getSubtreeOids).mockResolvedValue({ ok: true, at: () => ({ kind: "tree", oid: "sheets-oid" }) });
  vi.mocked(listSubtreeEntries).mockImplementation(async () => ({
    files: new Map(Object.keys(files).filter((p) => p.startsWith(`${SHEETS}/`)).map((p) => [p.slice(SHEETS.length + 1), "x"])),
    dirs: new Set<string>(),
  }));
});

afterEach(() => memory.close());

function recorded(): unknown {
  const row = memory.raw.prepare("SELECT story_files_to_delete_json AS j FROM projects").get() as { j: string | null };
  return row.j === null ? null : JSON.parse(row.j);
}

describe("the import records the story CSV it read, at the blob it read it", () => {
  it("hashes the file as stored, a leading byte-order mark kept", async () => {
    const bom = `\uFEFF${STORY_CSV}`;
    files[`${SHEETS}/story-one.csv`] = bom;
    await importRepo({
      token: "t", installationId: 1, repoFullName: "owner/repo", userId: 1,
      env: { DB: asD1(memory), ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
    });
    expect(recorded()).toEqual([{ path: `${SHEETS}/story-one.csv`, sha: await gitBlobSha(bom) }]);
  });

  it("records a CSV read in the spreadsheets folder, and none read from _data", async () => {
    await importRepo({
      token: "t", installationId: 1, repoFullName: "owner/repo", userId: 1,
      env: { DB: asD1(memory), ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
    });
    expect(recorded()).toEqual([{ path: `${SHEETS}/story-one.csv`, sha: await gitBlobSha(STORY_CSV) }]);
  });
});

describe("a sync's read is recorded beside the import's, and only before any publish", () => {
  async function project(snapshot: string | null): Promise<number> {
    memory.raw
      .prepare("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, publish_snapshot) VALUES (1, 1, 'o/r', 1, ?)")
      .run(snapshot);
    return 1;
  }

  it("adds a path, replaces a path read again, and keeps the others", async () => {
    const id = await project(null);
    const db = getDb(asD1(memory));
    await recordStoryFileReads(db, id, [{ path: `${SHEETS}/a.csv`, sha: "1" }, { path: `${SHEETS}/b.csv`, sha: "2" }]);
    await recordStoryFileReads(db, id, [{ path: `${SHEETS}/a.csv`, sha: "3" }]);
    expect(recorded()).toEqual([{ path: `${SHEETS}/b.csv`, sha: "2" }, { path: `${SHEETS}/a.csv`, sha: "3" }]);
  });

  it("records nothing once a publish snapshot exists", async () => {
    const id = await project('{"story_ids":[]}');
    await recordStoryFileReads(getDb(asD1(memory)), id, [{ path: `${SHEETS}/a.csv`, sha: "1" }]);
    expect(recorded()).toBeNull();
  });
});

describe("the publish's deletion of the recorded files", () => {
  const OWED = [{ path: `${SHEETS}/gone.csv`, sha: "blob-a" }];
  const at = (blobs: Record<string, string>) => async (path: string) =>
    path in blobs ? ({ status: "ok", content: blobs[path] } as const) : ({ status: "absent" } as const);

  it("deletes a recorded CSV whose story D1 does not hold, while the file is the blob read", async () => {
    const content = "the csv\n";
    const owed = [{ path: `${SHEETS}/gone.csv`, sha: await gitBlobSha(content) }];
    expect(await owedStoryDeletions(owed, ["other"], at({ [`${SHEETS}/gone.csv`]: content }))).toEqual({
      paths: [`${SHEETS}/gone.csv`], changed: [],
    });
  });

  it("keeps a story D1 holds again, as a sync inserting it back does", async () => {
    const content = "the csv\n";
    const owed = [{ path: `${SHEETS}/gone.csv`, sha: await gitBlobSha(content) }];
    expect(await owedStoryDeletions(owed, ["gone"], at({ [`${SHEETS}/gone.csv`]: content }))).toEqual({ paths: [], changed: [] });
  });

  it("leaves a file changed on GitHub and names it", async () => {
    expect(await owedStoryDeletions(OWED, [], at({ [`${SHEETS}/gone.csv`]: "edited\n" }))).toEqual({
      paths: [], changed: [`${SHEETS}/gone.csv`],
    });
  });

  it("owes nothing for a file already gone, and nothing when nothing is recorded", async () => {
    expect(await owedStoryDeletions(OWED, [], at({}))).toEqual({ paths: [], changed: [] });
    expect(await owedStoryDeletions(parseOwedStoryFiles(null), [], at({}))).toEqual({ paths: [], changed: [] });
  });

  it("refuses to decide when the file cannot be read", async () => {
    await expect(owedStoryDeletions(OWED, [], async () => ({ status: "error" }))).rejects.toThrow();
  });
});

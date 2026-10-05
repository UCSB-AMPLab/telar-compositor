/**
 * A renamed story keeps the layout of the file it was last written to. When
 * the snapshot writes a story's new ID, it records that file as the story's
 * `source_path`: `telar-content/spreadsheets/<old id>.csv`. A story renamed
 * again before a publish keeps the first of those, which is the file the
 * repository holds; a publish then records each story it wrote at its own
 * path (`publishedStorySheetWrites`), so the next rename starts from there,
 * and a story re-inserted under its document `_id` keeps the record.
 *
 * Run against SQLite with the repository's migrations, through the Durable
 * Object's own snapshot.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { getFileAtRef, getSubtreeOids, listSubtreeEntries } = vi.hoisted(() => ({
  getFileAtRef: vi.fn(),
  getSubtreeOids: vi.fn(),
  listSubtreeEntries: vi.fn(),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getFileAtRef, getSubtreeOids, listSubtreeEntries, getFileContent: vi.fn(async () => null) };
});

import { ProjectCollaborationDO } from "../workers/collaboration";
import { buildPublishFileSet } from "~/lib/publish.server";
import { renamedStorySheets } from "~/lib/story-left-files.server";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { getDb } from "~/lib/db.server";
import { publishedStorySheetWrites } from "~/lib/story-source-path.server";

const PROJECT_ID = 1;
const SHEETS = "telar-content/spreadsheets";

/** What the publish's record of a landed commit writes for these stories. */
async function recordPublishedStorySheets(memory: MemoryD1, written: ReadonlyArray<{ id: number; story_id: string }>): Promise<void> {
  const db = getDb(asD1(memory));
  const [first, ...rest] = publishedStorySheetWrites(db, PROJECT_ID, written);
  await db.batch([first, ...rest]);
}

function renameCtx() {
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
}

function seedRenameProject(memory: MemoryD1, sourcePath: string | null): void {
  memory.raw.exec("INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')");
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)");
  memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");
  memory.raw
    .prepare('INSERT INTO stories (project_id, story_id, title, "order", order_key, source_path) VALUES (?, ?, ?, ?, ?, ?)')
    .run(PROJECT_ID, "blank_template", "The Fluidity of Process", 0, "a01", sourcePath);
}

function storyRow(memory: MemoryD1): { id: number; story_id: string; source_path: string | null } {
  return memory.raw.prepare("SELECT id, story_id, source_path FROM stories WHERE project_id = ?").get(PROJECT_ID) as {
    id: number;
    story_id: string;
    source_path: string | null;
  };
}

function storyRows(memory: MemoryD1): Array<{ id: number; story_id: string; source_path: string | null }> {
  return memory.raw.prepare("SELECT id, story_id, source_path FROM stories WHERE project_id = ? ORDER BY id").all(PROJECT_ID) as Array<{
    id: number;
    story_id: string;
    source_path: string | null;
  }>;
}

let nextOrderKey = 2;

function addStory(memory: MemoryD1, storyId: string, sourcePath: string | null): void {
  memory.raw
    .prepare('INSERT INTO stories (project_id, story_id, title, "order", order_key, source_path) VALUES (?, ?, ?, ?, ?, ?)')
    .run(PROJECT_ID, storyId, storyId, 1, `a${String(nextOrderKey++).padStart(2, "0")}`, sourcePath);
}

/**
 * The database as the snapshot sees it when the story's row is missing from
 * its listing of the project's stories, though the row is still there when
 * the re-INSERT reads it: the stale-`_id` branch with a surviving row.
 */
let unlisted = 0;

function withStoryUnlisted(memory: MemoryD1): D1Database {
  const listing = "SELECT id, story_id FROM stories WHERE project_id = ? ORDER BY id";
  const db = Object.create(memory) as MemoryD1;
  db.prepare = (sql: string) => {
    if (sql === listing) unlisted++;
    return memory.prepare(sql === listing ? "SELECT id, story_id FROM stories WHERE project_id = ? AND 0" : sql);
  };
  return asD1(db);
}

/** Loads the document from D1, applies `edit` to its stories, and snapshots. */
async function editAndSnapshot(memory: MemoryD1, edit: (stories: Y.Array<Y.Map<unknown>>) => void): Promise<void> {
  const editor = new ProjectCollaborationDO(
    renameCtx() as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: "s", COLLABORATION: {} as unknown } as unknown as Env,
  );
  (editor as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (editor as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  const ydoc = (editor as unknown as { ydoc: Y.Doc }).ydoc;
  ydoc.transact(() => edit(ydoc.getArray<Y.Map<unknown>>("stories")), null);
  await (editor as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

function renameStory(from: string, to: string) {
  return (stories: Y.Array<Y.Map<unknown>>) => {
    stories.toArray().find((m) => String(m.get("story_id")) === from)!.set("story_id", to);
  };
}

/** A new story in the document, shaped as the first one is, at `storyId`. */
function newStory(storyId: string, orderKey = "a02") {
  return (stories: Y.Array<Y.Map<unknown>>) => {
    const like = stories.get(0);
    const map = new Y.Map<unknown>();
    for (const [key, value] of like.entries()) {
      map.set(key, value instanceof Y.Text ? new Y.Text(String(value)) : value instanceof Y.Array ? new Y.Array() : value);
    }
    map.set("_id", null);
    map.set("story_id", storyId);
    map.set("order_key", orderKey);
    stories.push([map]);
  };
}

/** Loads the document from D1, renames the story to `to`, and snapshots. */
async function renameAndSnapshot(memory: MemoryD1, to: string, db: D1Database = asD1(memory)): Promise<void> {
  const editor = new ProjectCollaborationDO(
    renameCtx() as unknown as DurableObjectState,
    { DB: db, SESSION_SECRET: "s", COLLABORATION: {} as unknown } as unknown as Env,
  );
  (editor as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (editor as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  const ydoc = (editor as unknown as { ydoc: Y.Doc }).ydoc;
  ydoc.transact(() => { ydoc.getArray<Y.Map<unknown>>("stories").get(0).set("story_id", to); }, null);
  await (editor as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

describe("the file a renamed story was last written to", () => {
  let memory: MemoryD1;
  beforeEach(() => { memory = createMemoryD1(); });
  afterEach(() => { memory.close(); });

  it("is recorded when the snapshot writes the new ID", async () => {
    seedRenameProject(memory, null);
    await renameAndSnapshot(memory, "fluidity");
    expect(storyRow(memory)).toMatchObject({ story_id: "fluidity", source_path: `${SHEETS}/blank_template.csv` });
  });

  it("replaces an older copy's path the story was imported from", async () => {
    seedRenameProject(memory, "_data/blank_template.csv");
    await renameAndSnapshot(memory, "fluidity");
    expect(storyRow(memory).source_path).toBe(`${SHEETS}/blank_template.csv`);
  });

  it("stays the first file when the story is renamed again before a publish", async () => {
    seedRenameProject(memory, null);
    await renameAndSnapshot(memory, "fluidity");
    await renameAndSnapshot(memory, "process");
    expect(storyRow(memory)).toMatchObject({ story_id: "process", source_path: `${SHEETS}/blank_template.csv` });
  });

  it("is left alone by a snapshot that renames nothing", async () => {
    seedRenameProject(memory, "_data/blank_template.csv");
    await renameAndSnapshot(memory, "blank_template");
    expect(storyRow(memory).source_path).toBe("_data/blank_template.csv");
  });

  it("moves to the published file after a publish, so the next rename starts there", async () => {
    seedRenameProject(memory, null);
    await renameAndSnapshot(memory, "fluidity");
    await recordPublishedStorySheets(memory, [storyRow(memory)]);
    expect(storyRow(memory).source_path).toBe(`${SHEETS}/fluidity.csv`);

    await renameAndSnapshot(memory, "process");
    expect(storyRow(memory).source_path).toBe(`${SHEETS}/fluidity.csv`);
  });

  it("records every story a publish wrote at its file: one never recorded, an older copy's, a renamed one", async () => {
    seedRenameProject(memory, null);
    addStory(memory, "maps", "_data/maps.csv");
    addStory(memory, "river", `${SHEETS}/delta.csv`);
    await recordPublishedStorySheets(memory, storyRows(memory));
    expect(storyRows(memory).map((r) => [r.story_id, r.source_path])).toEqual([
      ["blank_template", `${SHEETS}/blank_template.csv`],
      ["maps", `${SHEETS}/maps.csv`],
      ["river", `${SHEETS}/river.csv`],
    ]);
  });

  it("records no file for a story renamed since the publish read it, nor for one that took its ID", async () => {
    seedRenameProject(memory, null);
    await renameAndSnapshot(memory, "fluidity");
    const read = storyRows(memory);
    await renameAndSnapshot(memory, "process");
    addStory(memory, "fluidity", null);

    await recordPublishedStorySheets(memory, read);

    expect(storyRows(memory).map((r) => [r.story_id, r.source_path])).toEqual([
      ["process", `${SHEETS}/blank_template.csv`],
      ["fluidity", null],
    ]);
  });
});

describe("a story row the snapshot re-inserts under its document _id", () => {
  let memory: MemoryD1;
  beforeEach(() => { memory = createMemoryD1(); unlisted = 0; });
  afterEach(() => { expect(unlisted).toBeGreaterThan(0); memory.close(); });

  const reinserted = () => storyRows(memory).find((r) => r.story_id === "fluidity");

  it("keeps the surviving row's file in the spreadsheets folder", async () => {
    seedRenameProject(memory, `${SHEETS}/blank_template.csv`);
    await renameAndSnapshot(memory, "fluidity", withStoryUnlisted(memory));
    expect(reinserted()?.source_path).toBe(`${SHEETS}/blank_template.csv`);
  });

  it("records the old ID's file across a rename when the surviving row has none", async () => {
    seedRenameProject(memory, null);
    await renameAndSnapshot(memory, "fluidity", withStoryUnlisted(memory));
    expect(reinserted()?.source_path).toBe(`${SHEETS}/blank_template.csv`);
  });

  it("records none across a rename when another story records the old ID's file", async () => {
    seedRenameProject(memory, null);
    addStory(memory, "river", `${SHEETS}/blank_template.csv`);
    await renameAndSnapshot(memory, "fluidity", withStoryUnlisted(memory));
    expect(reinserted()?.source_path).toBeNull();
  });
});

describe("a story made at an ID another story left, renamed before a publish", () => {
  let memory: MemoryD1;
  beforeEach(() => { memory = createMemoryD1(); });
  afterEach(() => { memory.close(); });

  const A_PATH = `${SHEETS}/blank_template.csv`;
  const A_FILE = "step,question,answer,object\n#,the heading,the text,the object\n";

  it("records no file for it, so the story that left the ID keeps its own file and layout", async () => {
    // A was published at blank_template, renamed to fluidity; C is then made at
    // blank_template and renamed to river.
    seedRenameProject(memory, A_PATH);
    await editAndSnapshot(memory, renameStory("blank_template", "fluidity"));
    await editAndSnapshot(memory, newStory("blank_template"));
    expect(storyRows(memory).map((r) => [r.story_id, r.source_path])).toEqual([["fluidity", A_PATH], ["blank_template", null]]);
    await editAndSnapshot(memory, renameStory("blank_template", "river"));

    const rows = storyRows(memory);
    expect(rows.map((r) => [r.story_id, r.source_path])).toEqual([["fluidity", A_PATH], ["river", null]]);

    getSubtreeOids.mockResolvedValue({ ok: true, at: (_ref: string, dir: string) => ({ kind: "tree", oid: dir }) });
    listSubtreeEntries.mockImplementation(async (_t: string, _o: string, _r: string, oid: string) => ({
      files: new Map(oid === SHEETS ? [["blank_template.csv", "blob-a"]] : []),
      dirs: new Set(),
    }));
    getFileAtRef.mockImplementation(async (_t: string, _o: string, _r: string, path: string) =>
      path === A_PATH ? { status: "ok", content: A_FILE } : { status: "absent" });
    const files = await buildPublishFileSet({
      token: "tok", owner: "o", repo: "r", ref: "sha", projectId: PROJECT_ID, env: { DB: asD1(memory) } as never,
    });

    expect(files.find((f) => f.path === `${SHEETS}/fluidity.csv`)!.content).toContain("#,the heading,the text,the object");
    expect(files.find((f) => f.path === `${SHEETS}/river.csv`)!.content).not.toContain("the heading");
    expect(renamedStorySheets(rows)).toEqual([A_PATH]);
  });

  it("records none for it when it exchanges IDs with another story in one snapshot", async () => {
    seedRenameProject(memory, A_PATH);
    await editAndSnapshot(memory, renameStory("blank_template", "fluidity"));
    await editAndSnapshot(memory, newStory("blank_template"));
    await editAndSnapshot(memory, newStory("river", "a03"));
    await editAndSnapshot(memory, (stories) => {
      const [c, d] = ["blank_template", "river"].map((id) => stories.toArray().find((m) => String(m.get("story_id")) === id)!);
      c.set("story_id", "river");
      d.set("story_id", "blank_template");
    });
    expect(storyRows(memory).map((r) => [r.story_id, r.source_path])).toEqual([
      ["fluidity", A_PATH],
      ["river", null],
      ["blank_template", `${SHEETS}/river.csv`],
    ]);
  });
});

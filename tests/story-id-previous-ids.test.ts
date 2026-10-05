/**
 * Every ID a story leaves is recorded against its row, so an editor
 * address with any earlier ID finds the story, before a publish and after
 * one. The snapshot writes the record in the batch that renames the story;
 * an ID another story leaves later is pointed at that story, and a story's
 * records go with it.
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

import { ProjectCollaborationDO } from "../workers/collaboration";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

const PROJECT_ID = 1;

function ctx() {
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

let memory: MemoryD1;
let nextOrderKey = 1;
/** How many listings `withStoriesUnlisted` emptied, so a test can show it ran. */
let unlisted = 0;

function addStory(storyId: string): number {
  const row = memory.raw
    .prepare('INSERT INTO stories (project_id, story_id, title, "order", order_key) VALUES (?, ?, ?, 0, ?) RETURNING id')
    .get(PROJECT_ID, storyId, storyId, `a${String(nextOrderKey++).padStart(2, "0")}`) as { id: number };
  return row.id;
}

function seedProject(): void {
  memory.raw.exec("INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')");
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)");
  memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");
}

/** Every recorded earlier ID, as `<id>→<row>`, in ID order. */
function records(): string[] {
  return (memory.raw
    .prepare("SELECT story_id, story_row_id FROM story_previous_ids WHERE project_id = ? ORDER BY story_id")
    .all(PROJECT_ID) as Array<{ story_id: string; story_row_id: number }>)
    .map((r) => `${r.story_id}→${r.story_row_id}`);
}

function liveIds(): string[] {
  return (memory.raw.prepare("SELECT story_id FROM stories WHERE project_id = ? ORDER BY id").all(PROJECT_ID) as Array<{ story_id: string }>)
    .map((r) => r.story_id);
}

/** The story an editor address with `storyId` opens, as the loader finds it. */
function opens(storyId: string): string | null {
  const live = memory.raw.prepare("SELECT story_id FROM stories WHERE project_id = ? AND story_id = ?").get(PROJECT_ID, storyId) as
    | { story_id: string }
    | undefined;
  if (live) return live.story_id;
  const held = memory.raw
    .prepare(
      "SELECT stories.story_id FROM story_previous_ids JOIN stories ON stories.id = story_previous_ids.story_row_id " +
        "WHERE story_previous_ids.project_id = ? AND story_previous_ids.story_id = ?",
    )
    .get(PROJECT_ID, storyId) as { story_id: string } | undefined;
  return held?.story_id ?? null;
}

/** Loads the document from `db`, applies `edit` to its stories, and snapshots. */
async function editAndSnapshot(edit: (stories: Y.Array<Y.Map<unknown>>) => void, db: D1Database = asD1(memory)): Promise<void> {
  const editor = new ProjectCollaborationDO(
    ctx() as unknown as DurableObjectState,
    { DB: db, SESSION_SECRET: "s", COLLABORATION: {} as unknown } as unknown as Env,
  );
  (editor as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (editor as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  const ydoc = (editor as unknown as { ydoc: Y.Doc }).ydoc;
  ydoc.transact(() => edit(ydoc.getArray<Y.Map<unknown>>("stories")), null);
  await (editor as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

const storyAt = (stories: Y.Array<Y.Map<unknown>>, id: string) =>
  stories.toArray().find((m) => String(m.get("story_id")) === id)!;

function rename(...pairs: Array<[string, string]>) {
  return (stories: Y.Array<Y.Map<unknown>>) => {
    const maps = pairs.map(([from]) => storyAt(stories, from));
    pairs.forEach(([, to], i) => maps[i].set("story_id", to));
  };
}

/** A new story in the document, shaped as the first one is, at `storyId`. */
function newStory(storyId: string) {
  return (stories: Y.Array<Y.Map<unknown>>) => {
    const like = stories.get(0);
    const map = new Y.Map<unknown>();
    for (const [key, value] of like.entries()) {
      map.set(key, value instanceof Y.Text ? new Y.Text(String(value)) : value instanceof Y.Array ? new Y.Array() : value);
    }
    map.set("_id", null);
    map.set("story_id", storyId);
    map.set("order_key", `a${String(nextOrderKey++).padStart(2, "0")}`);
    stories.push([map]);
  };
}

/**
 * The database as the snapshot sees it when the story's row is missing from
 * its listing of the project's stories, though the row is still there when
 * the re-INSERT reads it: the stale-`_id` branch with a surviving row.
 */
function withStoriesUnlisted(): D1Database {
  const listing = "SELECT id, story_id FROM stories WHERE project_id = ? ORDER BY id";
  const db = Object.create(memory) as MemoryD1;
  db.prepare = (sql: string) => {
    if (sql === listing) unlisted++;
    return memory.prepare(sql === listing ? "SELECT id, story_id FROM stories WHERE project_id = ? AND 0" : sql);
  };
  return asD1(db);
}

/** The database with story row `rowId` deleted just before the snapshot's batch runs. */
function withRowGoneBeforeBatch(rowId: number): D1Database {
  const db = Object.create(memory) as MemoryD1;
  db.batch = async (statements) => {
    memory.raw.prepare("DELETE FROM stories WHERE id = ?").run(rowId);
    return memory.batch(statements);
  };
  return asD1(db);
}

beforeEach(() => {
  memory = createMemoryD1();
  nextOrderKey = 1;
  unlisted = 0;
  seedProject();
});
afterEach(() => { memory.close(); });

describe("the snapshot records the IDs a story leaves", () => {
  it("records the old ID against the row when it writes the new one", async () => {
    const row = addStory("blank_template");

    await editAndSnapshot(rename(["blank_template", "fluidity"]));

    expect(liveIds()).toEqual(["fluidity"]);
    expect(records()).toEqual([`blank_template→${row}`]);
    expect(opens("blank_template")).toBe("fluidity");
  });

  it("records nothing for a snapshot that renames nothing", async () => {
    addStory("blank_template");

    await editAndSnapshot((stories) => { stories.get(0).set("title", "Changed"); });

    expect(records()).toEqual([]);
  });

  it("keeps every ID across two renames, each resolving to the story", async () => {
    const row = addStory("a");

    await editAndSnapshot(rename(["a", "b"]));
    await editAndSnapshot(rename(["b", "c"]));

    expect(records()).toEqual([`a→${row}`, `b→${row}`]);
    expect([opens("a"), opens("b"), opens("c")]).toEqual(["c", "c", "c"]);
  });

  it("opens the live story at an ID it returned to, and keeps the one between", async () => {
    const row = addStory("a");

    await editAndSnapshot(rename(["a", "b"]));
    await editAndSnapshot(rename(["b", "a"]));

    expect(liveIds()).toEqual(["a"]);
    expect(records()).toEqual([`a→${row}`, `b→${row}`]);
    expect([opens("a"), opens("b")]).toEqual(["a", "a"]);
  });

  it("opens another story that takes an old ID, and points the ID at it once it leaves", async () => {
    const first = addStory("a");
    await editAndSnapshot(rename(["a", "b"]));
    await editAndSnapshot(newStory("a"));
    const second = (memory.raw.prepare("SELECT id FROM stories WHERE story_id = 'a'").get() as { id: number }).id;

    expect(opens("a")).toBe("a");
    expect(records()).toEqual([`a→${first}`]);

    await editAndSnapshot(rename(["a", "c"]));

    expect(records()).toEqual([`a→${second}`]);
    expect([opens("a"), opens("b"), opens("c")]).toEqual(["c", "b", "c"]);
  });

  it("records both real old IDs when two stories exchange IDs in one snapshot", async () => {
    const one = addStory("a");
    const two = addStory("b");

    await editAndSnapshot(rename(["a", "b"], ["b", "a"]));

    const rows = memory.raw.prepare("SELECT id, story_id FROM stories ORDER BY id").all();
    expect(rows).toEqual([{ id: one, story_id: "b" }, { id: two, story_id: "a" }]);
    expect(records()).toEqual([`a→${one}`, `b→${two}`]);
  });

  it("removes a story's records with the story", async () => {
    addStory("a");
    const other = addStory("keep");
    await editAndSnapshot(rename(["a", "b"], ["keep", "kept"]));

    await editAndSnapshot((stories) => {
      const at = stories.toArray().findIndex((m) => String(m.get("story_id")) === "b");
      stories.delete(at, 1);
    });

    expect(liveIds()).toEqual(["kept"]);
    expect(records()).toEqual([`keep→${other}`]);
    expect(opens("a")).toBeNull();
  });

  it("records the surviving row's ID for a story re-inserted under its document _id", async () => {
    addStory("blank_template");

    await editAndSnapshot(rename(["blank_template", "fluidity"]), withStoriesUnlisted());

    expect(unlisted).toBeGreaterThan(0);
    expect(liveIds()).toEqual(["blank_template", "fluidity"]);
    const reinserted = (memory.raw.prepare("SELECT id FROM stories WHERE story_id = 'fluidity'").get() as { id: number }).id;
    expect(records()).toEqual([`blank_template→${reinserted}`]);
  });

  it("records nothing for a row gone before the batch, and the batch still lands", async () => {
    const gone = addStory("a");
    addStory("other");

    await editAndSnapshot((stories) => {
      storyAt(stories, "a").set("story_id", "b");
      storyAt(stories, "other").set("title", "Landed");
    }, withRowGoneBeforeBatch(gone));

    expect(records()).toEqual([]);
    expect(memory.raw.prepare("SELECT story_id, title FROM stories").all()).toEqual([{ story_id: "other", title: "Landed" }]);
  });
});

/**
 * A page's slug is unique within a project in D1: project_pages(project_id,
 * slug), migration 0021. The snapshot batch is atomic, so a swap of two
 * slugs, a chain of renames, or a new page taking the slug of a page deleted
 * in the same window has to reach D1 in an order the index accepts: one
 * refused statement discards every entity's writes, and every retry issues
 * it again.
 *
 * Every case runs the real object against the migration chain in memory.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
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

import { asD1, createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";
import { PROJECT_ID, SECRET, proseFields, seedEmptyProject, snapshot } from "./helpers/collaboration-fixture";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { isPagePublishable } from "~/lib/publish.server";

let opened: MemoryD1[] = [];
afterEach(() => {
  for (const memory of opened) memory.close();
  opened = [];
});

function database(): MemoryD1 {
  const memory = createMemoryD1();
  opened.push(memory);
  seedEmptyProject(memory);
  return memory;
}

type Entry = { id: number | null; slug: string; title?: string; createdBy?: number };

function pageMap(e: Entry, order: number): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", e.id);
  m.set("_temp_id", `temp-${order}`);
  m.set("slug", e.slug);
  m.set("order_key", `a${String(order).padStart(5, "0")}`);
  if (e.createdBy !== undefined) m.set("created_by", e.createdBy);
  for (const { key } of proseFields("pages")) m.set(key, new Y.Text(key === "title" ? (e.title ?? e.slug) : ""));
  return m;
}

function blob(pages: Entry[]): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>("pages").push(pages.map((p, i) => pageMap(p, i + 1)));
  });
  return Y.encodeStateAsUpdate(doc);
}

function seedPages(memory: MemoryD1, rows: Array<[number, string]>): void {
  const insert = memory.raw.prepare(
    "INSERT INTO project_pages (id, project_id, slug, order_key, title) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [id, slug] of rows) insert.run(id, PROJECT_ID, slug, `a${String(id).padStart(5, "0")}`, slug);
}

const heldPages = (memory: MemoryD1) =>
  (memory.raw.prepare("SELECT id, slug, title FROM project_pages ORDER BY id").all() as Array<{ id: number; slug: string; title: string }>)
    .map((r) => `${r.id}:${r.slug}:${r.title}`);

async function loadProject(memory: MemoryD1, state: Uint8Array): Promise<ProjectCollaborationDO> {
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(state, PROJECT_ID);
  const ctx = {
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
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  return doInstance;
}

const ydocOf = (d: ProjectCollaborationDO) => (d as unknown as { ydoc: Y.Doc }).ydoc;
const pagesOf = (d: ProjectCollaborationDO) => ydocOf(d).getArray<Y.Map<unknown>>("pages");

describe("the snapshot under the page slug index", () => {
  it("lands two pages exchanging slugs", async () => {
    const memory = database();
    seedPages(memory, [[1, "about"], [2, "credits"]]);
    const d = await loadProject(memory, blob([{ id: 1, slug: "about" }, { id: 2, slug: "credits" }]));
    const [one, two] = pagesOf(d).toArray();
    ydocOf(d).transact(() => { one.set("slug", "credits"); two.set("slug", "about"); }, null);

    await snapshot(d);

    expect(heldPages(memory)).toEqual(["1:credits:about", "2:about:credits"]);
  });

  it("lets a new page take the slug of a page deleted in the same window", async () => {
    const memory = database();
    seedPages(memory, [[1, "about"]]);
    const d = await loadProject(memory, blob([{ id: 1, slug: "about" }]));
    const pages = pagesOf(d);
    ydocOf(d).transact(() => {
      pages.delete(0, 1);
      pages.push([pageMap({ id: null, slug: "about", title: "New" }, 2)]);
    }, null);

    await snapshot(d);

    // The new page is written to about.md, the file page 1 had, so it takes
    // page 1's row over.
    expect(heldPages(memory)).toEqual(["1:about:New"]);
    expect(pages.get(0).get("_id")).toBe(1);
  });

  it("credits a page re-created at a deleted page's slug to the person who made it", async () => {
    const memory = database();
    memory.raw.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (2, 2, 'v', 'e', 'e', '2099-01-01', '2099-01-01')",
    );
    seedPages(memory, [[1, "about"]]);
    memory.raw.exec("UPDATE project_pages SET created_by = 1 WHERE id = 1");
    const d = await loadProject(memory, blob([{ id: 1, slug: "about" }]));
    const pages = pagesOf(d);
    ydocOf(d).transact(() => {
      pages.delete(0, 1);
      pages.push([pageMap({ id: null, slug: "about", title: "New", createdBy: 2 }, 2)]);
    }, null);

    await snapshot(d);

    expect(memory.raw.prepare("SELECT id, created_by FROM project_pages").all()).toEqual([{ id: 1, created_by: 2 }]);
  });

  it("credits the adopting page to its creator when the first batch is refused", async () => {
    const memory = database();
    memory.raw.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (2, 2, 'v', 'e', 'e', '2099-01-01', '2099-01-01')",
    );
    seedPages(memory, [[1, "about"]]);
    memory.raw.exec("UPDATE project_pages SET created_by = 1 WHERE id = 1");
    const d = await loadProject(memory, blob([{ id: 1, slug: "about" }]));
    const pages = pagesOf(d);
    ydocOf(d).transact(() => {
      pages.delete(0, 1);
      pages.push([pageMap({ id: null, slug: "about", title: "New", createdBy: 2 }, 2)]);
    }, null);
    const env = (d as unknown as { env: { DB: D1Database } }).env;
    const real = env.DB;
    let refused = false;
    env.DB = {
      prepare: (sql: string) => real.prepare(sql),
      batch: async (s: D1PreparedStatement[]) => {
        if (!refused) {
          refused = true;
          throw new Error("D1_ERROR: batch failed");
        }
        return real.batch(s);
      },
      exec: (sql: string) => real.exec(sql),
    } as unknown as D1Database;

    await expect(snapshot(d)).rejects.toThrow(/batch failed/);
    expect(pages.get(0).get("_id")).toBe(1);
    await snapshot(d);

    expect(memory.raw.prepare("SELECT id, created_by FROM project_pages").all()).toEqual([{ id: 1, created_by: 2 }]);
    expect(pages.get(0).get("_adopted")).toBeUndefined();
  });

  it("gives a page whose `_id` an evicted instance lost its row back, rather than replacing it", async () => {
    const memory = database();
    seedPages(memory, [[1, "about"]]);
    memory.raw.prepare("UPDATE project_pages SET frontmatter_source = ? WHERE id = 1").run("---\nlayout: page\n---\n");
    const d = await loadProject(memory, blob([{ id: null, slug: "about", title: "About" }]));

    await snapshot(d);

    expect(heldPages(memory)).toEqual(["1:about:About"]);
    expect(memory.raw.prepare("SELECT frontmatter_source FROM project_pages WHERE id = 1").get()).toEqual({ frontmatter_source: "---\nlayout: page\n---\n" });
    expect(pagesOf(d).get(0).get("_id")).toBe(1);
  });

  it("lets a new page take the slug of a page renamed away in the same window", async () => {
    const memory = database();
    seedPages(memory, [[1, "about"]]);
    const d = await loadProject(memory, blob([{ id: 1, slug: "about" }]));
    const pages = pagesOf(d);
    ydocOf(d).transact(() => {
      pages.get(0).set("slug", "history");
      pages.push([pageMap({ id: null, slug: "about", title: "New" }, 2)]);
    }, null);

    await snapshot(d);

    const rows = heldPages(memory);
    expect(rows[0]).toBe("1:history:about");
    expect(rows[1]).toMatch(/^\d+:about:New$/);
  });

  it("leaves a page at a placeholder parked while another page holds the empty slug, and publish writes no file for it", async () => {
    const memory = database();
    seedPages(memory, [[1, "about"], [2, ""], [3, "~new-0f0e1d2c-3b4a-4596-8877-665544332211"]]);
    const d = await loadProject(memory, blob([{ id: 1, slug: "about" }, { id: 2, slug: "", title: "Draft" }, { id: 3, slug: "", title: "New" }]));

    await snapshot(d);

    expect(heldPages(memory)).toEqual(["1:about:about", "2::Draft", "3:~new-0f0e1d2c-3b4a-4596-8877-665544332211:New"]);
    expect(isPagePublishable({ title: "New", slug: "~new-0f0e1d2c-3b4a-4596-8877-665544332211" })).toBe(false);
    expect(isPagePublishable({ title: "New", slug: "~park-0123456789abcdef" })).toBe(false);
    expect(isPagePublishable({ title: "About", slug: "about" })).toBe(true);
    // A page imported from a file whose name only begins like one publishes.
    expect(isPagePublishable({ title: "New history", slug: "~new-history" })).toBe(true);
    expect(isPagePublishable({ title: "Parked", slug: "~park-notes" })).toBe(true);
  });

  it("keeps the slug of an unkeyed page whose slug only looks like a parking key", async () => {
    const memory = database();
    seedPages(memory, [[1, "~park-abcdefghijklmnop"]]);
    const d = await loadProject(memory, blob([{ id: 1, slug: "", title: "Imported" }]));

    await snapshot(d);

    expect(heldPages(memory)).toEqual(["1:~park-abcdefghijklmnop:Imported"]);
  });

  it("gives an unkeyed page left at a placeholder by a failed batch the empty slug", async () => {
    const memory = database();
    seedPages(memory, [[1, "about"], [2, "~new-0f0e1d2c-3b4a-4596-8877-665544332211"]]);
    const d = await loadProject(memory, blob([{ id: 1, slug: "about" }, { id: 2, slug: "" , title: "New" }]));

    await snapshot(d);

    expect(heldPages(memory)).toEqual(["1:about:about", "2::New"]);
  });

  it("lands a chain of renames onto the slug of a deleted page", async () => {
    const memory = database();
    seedPages(memory, [[1, "a"], [2, "b"], [3, "c"]]);
    const d = await loadProject(memory, blob([{ id: 1, slug: "a" }, { id: 2, slug: "b" }, { id: 3, slug: "c" }]));
    const pages = pagesOf(d);
    ydocOf(d).transact(() => {
      pages.get(0).set("slug", "b");
      pages.get(1).set("slug", "c");
      pages.delete(2, 1);
    }, null);

    await snapshot(d);

    expect(heldPages(memory)).toEqual(["1:b:a", "2:c:b"]);
  });

  it("keeps the slug D1 holds for a page the document leaves unkeyed, beside a swap", async () => {
    const memory = database();
    seedPages(memory, [[1, "a"], [2, "b"], [3, "c"]]);
    const d = await loadProject(memory, blob([{ id: 1, slug: "a" }, { id: 2, slug: "b" }, { id: 3, slug: "c" }]));
    const pages = pagesOf(d);
    ydocOf(d).transact(() => {
      pages.get(0).set("slug", "b");
      pages.get(1).set("slug", "a");
      pages.get(2).set("slug", "");
      (pages.get(2).get("title") as Y.Text).insert(0, "edited ");
    }, null);

    await snapshot(d);

    expect(heldPages(memory)).toEqual(["1:b:a", "2:a:b", "3:c:edited c"]);
  });

  it("leaves no placeholder in D1 when a new page's slug stays held through the batch", async () => {
    const memory = database();
    seedPages(memory, [[1, "about"]]);
    const d = await loadProject(memory, blob([]));
    const pages = ydocOf(d).getArray<unknown>("pages");
    // An entry the snapshot cannot read suspends the orphan sweep, so page 1
    // keeps `about` though the document no longer holds it.
    ydocOf(d).transact(() => {
      pages.push(["not a page"]);
      pages.push([pageMap({ id: null, slug: "about", title: "New" }, 2)]);
    }, null);

    await snapshot(d);

    expect(heldPages(memory)).toEqual(["1:about:about"]);
  });
});

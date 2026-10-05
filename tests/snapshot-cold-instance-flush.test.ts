/**
 * `POST /snapshot` on a Durable Object that woke with no live sockets.
 *
 * The route used to read a null `projectId` as "nothing to flush" and answer
 * 200 without loading anything. That reads a fact about the INSTANCE as a fact
 * about D1, and the two come apart at `doSnapshot`, which writes the
 * `yjs_state` blob standalone and BEFORE its UPDATE/DELETE batch: a batch that
 * fails leaves the blob carrying edits the rows do not have. Evict the
 * instance — an author publishing with no editor open is exactly that — and
 * the 200 shipped those lagging rows under the success banner the route's own
 * 503 work existed to remove.
 *
 * These run the real snapshot against the repository's migration chain
 * replayed into an in-memory SQLite (tests/helpers/d1-memory.ts), so the
 * divergence under test is the one production D1 would hold, not a stand-in.
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
import { signInternalMarker } from "../workers/auth";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { markLoaded } from "./helpers/claimed-document";
import { plantHalt } from "./helpers/halted-document";

const PROJECT_ID = 1;
const SECRET = "test-session-secret";

function makeCtx() {
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => { /* no-op */ },
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
}

/** A DO with no sockets: `projectId` is null and the doc is unloaded, which is
 *  the state an evicted instance answers a publish in. */
function makeColdDo(db: D1Database) {
  return new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: db, SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
}

/** The binding with its row batch refused. INSERTs and the blob write still
 *  land, which is what makes the blob outrun the rows. */
function withFailingBatch(memory: MemoryD1): D1Database {
  return {
    prepare: (sql: string) => memory.prepare(sql),
    batch: async () => { throw new Error("D1_ERROR: batch failed"); },
    exec: (sql: string) => memory.exec(sql),
  } as unknown as D1Database;
}

async function snapshotRequest(): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, SECRET, "snapshot");
  return new Request("https://internal/snapshot", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(PROJECT_ID),
    },
  });
}

function seedProject(memory: MemoryD1, slugs: string[]): void {
  memory.raw.exec("INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')");
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)");
  memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");
  slugs.forEach((slug, i) => {
    memory.raw
      .prepare('INSERT INTO stories (project_id, story_id, title, "order", order_key) VALUES (?, ?, ?, ?, ?)')
      .run(PROJECT_ID, slug, slug, i, `a0000${i + 1}1`);
  });
}

function titleOf(memory: MemoryD1, slug: string): string {
  const row = memory.raw
    .prepare("SELECT title FROM stories WHERE project_id = ? AND story_id = ?")
    .get(PROJECT_ID, slug) as { title: string } | undefined;
  return row?.title ?? "";
}

function blobHoldsTitle(memory: MemoryD1, slug: string): string {
  const row = memory.raw
    .prepare("SELECT yjs_state FROM projects WHERE id = ?")
    .get(PROJECT_ID) as { yjs_state: Uint8Array | null } | undefined;
  if (!row?.yjs_state) return "";
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.yjs_state));
  const map = doc
    .getArray<Y.Map<unknown>>("stories")
    .toArray()
    .find((m) => m.get("story_id") === slug);
  return String(map?.get("title") ?? "");
}

/**
 * Put D1 into the state a failed row batch leaves: a blob carrying a rename
 * the `stories` row never received. The rename reaches D1 only through the
 * batch (`snapshotStories` pushes an UPDATE), so refusing the batch is enough.
 */
async function divergeBlobFromRows(memory: MemoryD1): Promise<void> {
  const editor = makeColdDo(withFailingBatch(memory));
  (editor as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (editor as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  const ydoc = (editor as unknown as { ydoc: Y.Doc }).ydoc;
  const map = ydoc
    .getArray<Y.Map<unknown>>("stories")
    .toArray()
    .find((m) => m.get("story_id") === "a")!;
  ydoc.transact(() => {
    const text = map.get("title") as Y.Text;
    text.delete(0, text.length);
    text.insert(0, "Renamed");
  }, null);
  await expect(
    (editor as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1(),
  ).rejects.toThrow(/batch failed/);
}

describe("POST /snapshot on an evicted instance", () => {
  let memory: MemoryD1;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    memory = createMemoryD1();
    seedProject(memory, ["a", "b"]);
    error = vi.spyOn(console, "error").mockImplementation(() => { /* silence */ });
  });

  afterEach(() => {
    error.mockRestore();
    memory.close();
  });

  it("loads and flushes rather than answering 200 over rows that lag the blob", async () => {
    await divergeBlobFromRows(memory);
    // The state the publish path would have committed from.
    expect(titleOf(memory, "a")).toBe("a");
    expect(blobHoldsTitle(memory, "a")).toBe("Renamed");

    const cold = makeColdDo(asD1(memory));
    const res = await cold.fetch(await snapshotRequest());

    expect(res.status).toBe(200);
    // The row the publish pipeline reads now carries what the blob held.
    expect(titleOf(memory, "a")).toBe("Renamed");
  });

  it("refuses with a 500 the publish path can see when the flush cannot land", async () => {
    await divergeBlobFromRows(memory);

    const cold = makeColdDo(withFailingBatch(memory));
    const res = await cold.fetch(await snapshotRequest());

    // `app/routes/_app.publish.tsx` fails closed on any non-200, so this is
    // the difference between a refused publish and one committed from rows
    // the blob had already superseded.
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("snapshot_failed");
    expect(res.ok).toBe(false);
    expect(titleOf(memory, "a")).toBe("a");
  });

  it("still succeeds when D1 is not stale, having actually flushed", async () => {
    // A clean snapshot first, so blob and rows agree — the ordinary case, which
    // must not become an error now that the cold path does real work.
    const warm = makeColdDo(asD1(memory));
    (warm as unknown as { projectId: number }).projectId = PROJECT_ID;
    await (warm as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
    await (warm as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    memory.raw.exec("UPDATE projects SET updated_at = '1999-01-01T00:00:00.000Z' WHERE id = 1");

    const cold = makeColdDo(asD1(memory));
    const res = await cold.fetch(await snapshotRequest());

    expect(res.status).toBe(200);
    expect(titleOf(memory, "a")).toBe("a");
    expect(titleOf(memory, "b")).toBe("b");
    // A 200 the route earned: the blob write stamps `updated_at`, so the old
    // value surviving would mean nothing ran.
    const stamp = memory.raw
      .prepare("SELECT updated_at FROM projects WHERE id = ?")
      .get(PROJECT_ID) as { updated_at: string };
    expect(stamp.updated_at).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("keeps answering 503 on a halted project, so the halt is not dressed as a failure", async () => {
    // Enforcement halts persistence in the instance that refused the delete, so
    // this one is warm by construction. Its answer must not change: 503 is a
    // retry the convenor resolves with /reset, not a broken snapshot.
    const halted = makeColdDo(asD1(memory));
    (halted as unknown as { projectId: number }).projectId = PROJECT_ID;
    markLoaded(halted);
    plantHalt(halted);

    const res = await halted.fetch(await snapshotRequest());

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("persistence_halted");
  });
});

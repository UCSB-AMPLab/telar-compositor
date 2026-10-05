/**
 * Page import as a DO-routed write.
 *
 * `project_pages(project_id, slug)` is UNIQUE, and the snapshot's re-key path
 * mints a suffixed slug from a `fetchEntityKeys` read taken at the top of the
 * pass — many statements before the batch that carries the resulting UPDATE.
 * Any writer of that table outside the DO can take the minted slug inside that
 * window; the UPDATE then aborts, D1 discards the whole batch, and because the
 * `yjs_state` blob write precedes the batch the re-keyed document is durable —
 * so every retry re-issues the identical colliding UPDATE. The project's
 * snapshot is dead until someone renames the page by hand.
 *
 * The window is closed by removing the outside writer, not by widening the
 * read: `import-pages` posts a `pages.insert` arm to `/ingest-sync`, which
 * mutates the Y.Doc and snapshots inside `blockConcurrencyWhile`. Three
 * properties carry that, and each fails silently if wrong:
 *
 *   - NO DIRECT WRITE. The action must INSERT no `project_pages` row itself.
 *     One surviving direct insert re-opens the whole window.
 *   - SERIALISATION. An ingest delivered while a snapshot is running must not
 *     reach D1 until that snapshot's batch has completed. The gate is what
 *     provides this; the assertion is on the observed statement order.
 *   - COLLISION-FREE MINT. With the page in the document, the re-key's
 *     `takenKeys` (document keys UNION D1 keys) already covers it, so the two
 *     cannot converge on one slug from either running order.
 *
 * The import flow itself is ordinary and frequently used, so the shapes that
 * must keep working are pinned alongside: a cold DO with no `yjs_state`, a repo
 * with no pages, a repo whose pages all already exist, and a partial overlap.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

// ---------------------------------------------------------------------------
// Route-level mocks (mirror tests/pages.action.test.ts)
// ---------------------------------------------------------------------------

const insertCalls: Array<{ table: unknown; values: unknown }> = [];
let existingPagesInD1: Array<{ slug: string }> = [];

const dbMock = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => existingPagesInD1),
    })),
  })),
  insert: vi.fn((table: unknown) => ({
    values: vi.fn((values: unknown) => {
      insertCalls.push({ table, values });
      const builder = Promise.resolve(undefined) as Promise<undefined> & {
        returning: () => Promise<Array<{ id: number }>>;
      };
      builder.returning = async () => [{ id: insertCalls.length }];
      return builder;
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  })),
};

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => dbMock) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 42, github_repo_full_name: "owner/repo" },
    userRole: "convenor",
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));

const { scanRepoPagesMock } = vi.hoisted(() => ({ scanRepoPagesMock: vi.fn() }));
vi.mock("~/lib/import.server", () => ({ scanRepoPages: scanRepoPagesMock }));
// With no head recorded, the import reads at the head of main.
vi.mock("~/lib/github.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getRepoHead: vi.fn(async () => "main-head"),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.pages";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const TEST_SECRET = "sess-secret";

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

interface DoCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function buildRequest(intent: string, fields: Record<string, string | string[]> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  // import-pages is refused unless the posted siteId matches the session's
  // active project (PROJECT_ID, per the resolveActiveProject mock above).
  form.set("siteId", String(PROJECT_ID));
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) form.append(key, v);
    else form.set(key, value);
  }
  return new Request("https://compositor.telar.org/pages", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

/**
 * Context whose COLLABORATION binding records the ingest instead of reaching a
 * real DO. `ingestResponse` stands in for the endpoint's JSON answer so the
 * action's reporting can be exercised without a document.
 */
function buildContext(
  ingestResponse: {
    applied?: Record<string, number>;
    skipped?: Record<string, string[]>;
    failed?: Record<string, string[]>;
  } = {},
  status = 200,
) {
  const calls: DoCall[] = [];
  const user = { id: 7, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: TEST_SECRET,
    DB: {},
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (req: Request) => {
          calls.push({
            url: req.url,
            body: JSON.parse(await req.text()) as Record<string, unknown>,
            headers: Object.fromEntries(req.headers.entries()),
          });
          return new Response(
            JSON.stringify({
              applied: ingestResponse.applied ?? {},
              skipped: ingestResponse.skipped ?? {},
              failed: ingestResponse.failed ?? {},
            }),
            { status },
          );
        },
      }),
    },
  };
  return {
    calls,
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"],
  };
}

function runAction(request: Request, context: Parameters<typeof action>[0]["context"]) {
  return action({ request, context, params: {} } as unknown as Parameters<typeof action>[0]);
}

/**
 * A COLLABORATION binding whose fetch REJECTS rather than answering — the
 * shape of an exception escaping a DO's `blockConcurrencyWhile` callback
 * (the instance is terminated and the in-flight fetch rejects), as distinct
 * from the DO answering with a non-2xx `Response`.
 */
function buildRejectingContext() {
  const user = { id: 7, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: TEST_SECRET,
    DB: {},
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          throw new Error("Durable Object reset because its code was updated.");
        },
      }),
    },
  };
  return {
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"],
  };
}

// ---------------------------------------------------------------------------
// DO harness
// ---------------------------------------------------------------------------

interface DbSeed {
  /** Rows `SELECT ... FROM project_pages` reports. */
  pages?: Array<{ id: number; slug: string }>;
  stories?: Array<{ id: number; story_id: string }>;
  /** When set, `ensureDocLoaded` takes the cold-start branch and builds from D1. */
  yjsState?: ArrayBuffer | null;
}

interface Op {
  kind: "select" | "run" | "batch";
  sql: string;
  binds: unknown[];
}

/**
 * A D1 fake that ENFORCES `UNIQUE(project_id, slug)` at execution time against
 * live row state, so a colliding write fails here exactly where it fails in
 * production — and a batch containing one discards the whole batch.
 */
function makeDb(seed: DbSeed) {
  const ops: Op[] = [];
  const pageRows = new Map<number, string>();
  for (const p of seed.pages ?? []) pageRows.set(p.id, p.slug);
  let nextId = 5000;

  const slugOwner = (slug: string): number | undefined => {
    for (const [id, s] of pageRows) if (s === slug) return id;
    return undefined;
  };

  function resolve(sql: string): unknown[] {
    if (/FROM stories WHERE project_id/.test(sql)) return seed.stories ?? [];
    if (/FROM steps WHERE story_id/.test(sql)) return [];
    if (/FROM layers WHERE step_id/.test(sql)) return [];
    if (/FROM objects WHERE project_id/.test(sql)) return [];
    if (/FROM glossary_terms WHERE project_id/.test(sql)) return [];
    if (/FROM project_pages WHERE project_id/.test(sql)) {
      return [...pageRows].map(([id, slug]) => ({ id, slug, title: "", body: "", order: 0, order_key: null, created_by: null }));
    }
    if (/FROM project_members/.test(sql)) return [];
    return [];
  }

  /** Apply one statement to the row state, throwing on a UNIQUE violation. */
  function apply(sql: string, binds: unknown[]): number | null {
    const insertPage = /^INSERT INTO project_pages \(([^)]*)\)/.exec(sql);
    if (insertPage) {
      const cols = insertPage[1].split(",").map((c) => c.trim().replace(/"/g, ""));
      const slug = String(binds[cols.indexOf("slug")] ?? "");
      if (slugOwner(slug) !== undefined) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: project_pages.project_id, project_pages.slug");
      }
      const idCol = cols.indexOf("id");
      const id = idCol >= 0 ? Number(binds[idCol]) : (nextId += 1);
      pageRows.set(id, slug);
      return id;
    }
    if (/^UPDATE project_pages SET/.test(sql)) {
      const slug = String(binds[1] ?? "");
      const targetId = Number(binds[binds.length - 1]);
      const owner = slugOwner(slug);
      if (owner !== undefined && owner !== targetId) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: project_pages.project_id, project_pages.slug");
      }
      if (pageRows.has(targetId)) pageRows.set(targetId, slug);
      return null;
    }
    if (/^DELETE FROM project_pages/.test(sql)) {
      pageRows.delete(Number(binds[0]));
      return null;
    }
    return null;
  }

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return bound; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); bound = args; return stmt; },
      async run() {
        ops.push({ kind: "run", sql, binds: bound });
        const id = apply(sql, bound);
        return { meta: { last_row_id: id ?? (nextId += 1), changes: 1 }, success: true as const };
      },
      async all<T = unknown>() {
        ops.push({ kind: "select", sql, binds: bound });
        return { results: resolve(sql) as T[], success: true as const };
      },
      async first<T = unknown>() {
        ops.push({ kind: "select", sql, binds: bound });
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) return { id: 1 } as T;
        if (/^SELECT yjs_state/.test(sql)) {
          // A seeded blob comes back tagged at the current generation and
          // claimable; an absent one is the cold build.
          return (seed.yjsState === undefined
            ? { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 }
            : { yjs_state: seed.yjsState, yjs_generation: 0, yjs_seq: 0, yjs_write: 0 }) as T;
        }
        return ((resolve(sql) as T[])[0] ?? null) as T | null;
      },
    };
    return stmt;
  }

  const DB = {
    prepare,
    async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
      ops.push({ kind: "batch", sql: "BATCH", binds: [] });
      // One transaction: a snapshot of the row state is restored if any
      // statement fails, so nothing in a failed batch is observable.
      const restore = new Map(pageRows);
      try {
        for (const s of statements) apply(s.sql, s.boundArgs);
      } catch (err) {
        pageRows.clear();
        for (const [k, v] of restore) pageRows.set(k, v);
        throw err;
      }
      for (const s of statements) ops.push({ kind: "run", sql: s.sql, binds: s.boundArgs });
      return statements.map(() => ({ success: true }));
    },
  };

  return {
    DB,
    ops,
    liveSlugs: () => [...pageRows.values()].sort(),
    indexOfFirst: (re: RegExp) => ops.findIndex((o) => re.test(o.sql)),
    indexOfFirstMatching: (re: RegExp, bind: string) =>
      ops.findIndex((o) => re.test(o.sql) && o.binds.some((b) => b === bind)),
  };
}

/**
 * A ctx whose `blockConcurrencyWhile` is a real serialising mutex — the
 * property the fix leans on. A gate modelled as a pass-through would let the
 * ordering test pass while the production race stayed open.
 */
function makeCtx() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(() => fn());
      chain = run.catch(() => {});
      return run;
    },
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
}

function makeDo(seed: DbSeed, opts: { docLoaded?: boolean } = {}) {
  const db = makeDb(seed);
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: db.DB as unknown, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  if (opts.docLoaded ?? true) markLoaded(doInstance);
  return { doInstance, db, ydoc: (doInstance as unknown as { ydoc: Y.Doc }).ydoc };
}

async function postIngest(doInstance: ProjectCollaborationDO, body: unknown): Promise<Response> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, TEST_SECRET, "ingest-sync");
  return doInstance.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

function seedPage(ydoc: Y.Doc, fields: { _id: number | null; slug: string; title?: string }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("slug", fields.slug);
  m.set("created_by", 1);
  m.set("title", new Y.Text(fields.title ?? ""));
  m.set("body", new Y.Text(""));
  ydoc.getArray<Y.Map<unknown>>("pages").push([m]);
}

function slugsOf(ydoc: Y.Doc): string[] {
  return ydoc.getArray<Y.Map<unknown>>("pages").toArray().map((m) => String(m.get("slug")));
}

beforeEach(() => {
  insertCalls.length = 0;
  existingPagesInD1 = [];
  scanRepoPagesMock.mockReset();
});

// ---------------------------------------------------------------------------
// 1. The action writes no project_pages row of its own
// ---------------------------------------------------------------------------

describe("import-pages routes its writes through the DO", () => {
  it("posts a pages.insert ingest and INSERTs no row directly", async () => {
    scanRepoPagesMock.mockResolvedValue([
      { slug: "about", title: "About", body: "About body.", order: 0 },
      { slug: "team", title: "Team", body: "Team body.", order: 1 },
    ]);
    const { context, calls } = buildContext({ applied: { pageInsert: 2 } });

    const result = await runAction(buildRequest("import-pages"), context);

    // The direct write is the whole hole: one surviving INSERT re-opens it.
    expect(insertCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/ingest-sync");
    expect(calls[0].headers["x-internal-project"]).toBe(String(PROJECT_ID));
    expect(calls[0].body).toEqual({
      pages: {
        insert: [
          { slug: "about", title: "About", body: "About body.", created_by: 7 },
          { slug: "team", title: "Team", body: "Team body.", created_by: 7 },
        ],
      },
    });
    expect(result).toMatchObject({ ok: true, intent: "import-pages", imported: 2, already_present: [] });
  });

  it("sends only the requested slugs", async () => {
    scanRepoPagesMock.mockResolvedValue([
      { slug: "about", title: "About", body: "A", order: 0 },
      { slug: "team", title: "Team", body: "T", order: 1 },
      { slug: "credits", title: "Credits", body: "C", order: 2 },
    ]);
    const { context, calls } = buildContext({ applied: { pageInsert: 2 } });

    await runAction(buildRequest("import-pages", { slugs: ["about", "credits"] }), context);

    const sent = (calls[0].body as { pages: { insert: Array<{ slug: string }> } }).pages.insert;
    expect(sent.map((p) => p.slug)).toEqual(["about", "credits"]);
    expect(insertCalls).toHaveLength(0);
  });

  it("reports already_present from the DO's skip list, not from a pre-read", async () => {
    scanRepoPagesMock.mockResolvedValue([
      { slug: "about", title: "About", body: "A", order: 0 },
      { slug: "team", title: "Team", body: "T", order: 1 },
    ]);
    const { context } = buildContext({
      applied: { pageInsert: 1 },
      skipped: { pageInsert: ["about"] },
    });

    const result = await runAction(buildRequest("import-pages"), context);

    expect(result).toMatchObject({ ok: true, imported: 1, already_present: ["about"] });
    expect((result as { pages: Array<{ slug: string }> }).pages.map((p) => p.slug)).toEqual(["team"]);
  });

  // The endpoint reports a refused INSERT in its own bucket — a row D1 does not
  // hold is neither imported nor already present. Listing it among the imported
  // pages would tell the author their page arrived when it did not.
  it("does not list a page whose insert the endpoint reported as failed", async () => {
    scanRepoPagesMock.mockResolvedValue([
      { slug: "about", title: "About", body: "A", order: 0 },
      { slug: "team", title: "Team", body: "T", order: 1 },
    ]);
    const { context } = buildContext({
      applied: { pageInsert: 1 },
      failed: { pageInsert: ["team"] },
    });

    const result = await runAction(buildRequest("import-pages"), context);

    expect((result as { pages: Array<{ slug: string }> }).pages.map((p) => p.slug)).toEqual(["about"]);
    expect(result).toMatchObject({ ok: true, imported: 1, already_present: [] });
  });

  it("reports every page as already present when the repo's pages all exist", async () => {
    scanRepoPagesMock.mockResolvedValue([
      { slug: "about", title: "About", body: "A", order: 0 },
      { slug: "team", title: "Team", body: "T", order: 1 },
    ]);
    const { context } = buildContext({
      applied: { pageInsert: 0 },
      skipped: { pageInsert: ["about", "team"] },
    });

    const result = await runAction(buildRequest("import-pages"), context);

    expect(result).toMatchObject({ ok: true, imported: 0, already_present: ["about", "team"] });
    expect((result as { pages: unknown[] }).pages).toEqual([]);
  });

  it("makes no DO call at all when the repo has no pages", async () => {
    scanRepoPagesMock.mockResolvedValue([]);
    const { context, calls } = buildContext();

    const result = await runAction(buildRequest("import-pages"), context);

    expect(calls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, imported: 0, pages: [], already_present: [] });
  });

  it("fails open with no DO call when the repo tree can't be fetched", async () => {
    scanRepoPagesMock.mockRejectedValue(new Error("GitHub API error fetching tree: 404"));
    const { context, calls } = buildContext();

    const result = await runAction(buildRequest("import-pages"), context);

    expect(calls).toHaveLength(0);
    expect(result).toEqual({
      ok: false, intent: "import-pages", imported: 0, pages: [], already_present: [],
    });
  });

  it("reports a failed ingest as a failure rather than a silent success", async () => {
    scanRepoPagesMock.mockResolvedValue([{ slug: "about", title: "About", body: "A", order: 0 }]);
    const { context } = buildContext({}, 503);

    const result = await runAction(buildRequest("import-pages"), context);

    expect(result).toMatchObject({ ok: false, intent: "import-pages", imported: 0 });
  });

  it("reports a rejected ingest fetch as a structured failure rather than throwing", async () => {
    // A DO whose blockConcurrencyWhile callback throws is terminated by
    // Cloudflare, and the in-flight fetch rejects rather than answering — a
    // live path, not a theoretical one, since that behaviour has driven
    // several fixes elsewhere in this codebase. The rejection must land in
    // the same structured shape as a non-2xx answer, not escape the action
    // for React Router's error boundary to catch.
    scanRepoPagesMock.mockResolvedValue([{ slug: "about", title: "About", body: "A", order: 0 }]);
    const { context } = buildRejectingContext();

    const result = await runAction(buildRequest("import-pages"), context);

    expect(result).toEqual({
      ok: false, intent: "import-pages", imported: 0, pages: [], already_present: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The DO's pages.insert arm
// ---------------------------------------------------------------------------

describe("/ingest-sync pages.insert", () => {
  it("appends the page to the document and the enclosing snapshot INSERTs the row", async () => {
    const { doInstance, db, ydoc } = makeDo({ pages: [{ id: 42, slug: "about" }] });
    ydoc.transact(() => {
      ydoc.getMap<unknown>("config").set("lang", "en");
      seedPage(ydoc, { _id: 42, slug: "about", title: "About" });
    }, null);

    const res = await postIngest(doInstance, {
      pages: { insert: [{ slug: "team", title: "Team", body: "Team body.", created_by: 7 }] },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: { pageInsert: 1 } });
    expect(slugsOf(ydoc)).toEqual(["about", "team"]);

    // The row exists because the snapshot wrote it — not because the arm did.
    expect(db.liveSlugs()).toEqual(["about", "team"]);
    const inserted = db.ops.find((o) => /^INSERT INTO project_pages/.test(o.sql));
    expect(inserted).toBeDefined();
    expect(inserted!.binds).toContain("team");

    // The Y.Map carries the shape buildFromD1Rows builds, with the id backfilled.
    const teamMap = ydoc.getArray<Y.Map<unknown>>("pages").get(1);
    expect(typeof teamMap.get("_id")).toBe("number");
    expect(teamMap.get("title")).toBeInstanceOf(Y.Text);
    expect(teamMap.get("body")).toBeInstanceOf(Y.Text);
    expect(String(teamMap.get("title"))).toBe("Team");
    expect(teamMap.get("created_by")).toBe(7);
    expect(typeof teamMap.get("order_key")).toBe("string");
  });

  it("skips a slug the document already holds and reports it (idempotent retry)", async () => {
    const { doInstance, db, ydoc } = makeDo({ pages: [{ id: 42, slug: "about" }] });
    ydoc.transact(() => {
      ydoc.getMap<unknown>("config").set("lang", "en");
      seedPage(ydoc, { _id: 42, slug: "about", title: "About" });
    }, null);

    const res = await postIngest(doInstance, {
      pages: { insert: [{ slug: "about", title: "About", body: "A", created_by: 7 }] },
    });

    expect(await res.json()).toMatchObject({
      applied: { pageInsert: 0 },
      skipped: { pageInsert: ["about"] },
    });
    expect(slugsOf(ydoc)).toEqual(["about"]);
    expect(db.liveSlugs()).toEqual(["about"]);
  });

  it("works on a cold DO with no yjs_state — the doc is built from D1 first", async () => {
    // docLoaded false and no blob: ensureDocLoaded inside the gate takes the
    // cold-start branch, so the skip check sees D1's pages.
    const { doInstance, db, ydoc } = makeDo(
      { pages: [{ id: 42, slug: "about" }] },
      { docLoaded: false },
    );

    const res = await postIngest(doInstance, {
      pages: { insert: [
        { slug: "about", title: "About", body: "A", created_by: 7 },
        { slug: "team", title: "Team", body: "T", created_by: 7 },
      ] },
    });

    expect(await res.json()).toMatchObject({
      applied: { pageInsert: 1 },
      skipped: { pageInsert: ["about"] },
    });
    expect(slugsOf(ydoc)).toEqual(["about", "team"]);
    expect(db.liveSlugs()).toEqual(["about", "team"]);
  });

  it("names the id of each page it inserts, and none for a page it skips", async () => {
    const { doInstance, db, ydoc } = makeDo({ pages: [{ id: 42, slug: "about" }] });
    ydoc.transact(() => {
      ydoc.getMap<unknown>("config").set("lang", "en");
      seedPage(ydoc, { _id: 42, slug: "about", title: "About" });
    }, null);

    const res = await postIngest(doInstance, {
      pages: { insert: [
        { slug: "about", title: "About", body: "A", created_by: 7 },
        { slug: "team", title: "Team", body: "T", created_by: 7 },
      ] },
    });

    const body = (await res.json()) as { insertedPages?: Record<string, number> };
    const teamId = ydoc.getArray<Y.Map<unknown>>("pages").get(1).get("_id");
    expect(typeof teamId).toBe("number");
    expect(body.insertedPages).toEqual({ team: teamId });
    expect(db.liveSlugs()).toEqual(["about", "team"]);
  });

  it("accepts an empty arm without touching the pages array", async () => {
    const { doInstance, ydoc } = makeDo({ pages: [] });
    ydoc.transact(() => { ydoc.getMap<unknown>("config").set("lang", "en"); }, null);

    const res = await postIngest(doInstance, { pages: { insert: [] } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: { pageInsert: 0 } });
    expect(slugsOf(ydoc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The window itself
// ---------------------------------------------------------------------------

describe("an ingest cannot land inside the seed-read/batch window", () => {
  /**
   * Two collaborators have renamed their pages onto `about`, so the snapshot
   * re-keys the loser to `about-2` — the slug the repo's `about-2.md` also
   * carries. The import is issued while the snapshot is mid-flight, which is
   * exactly the interleaving that killed the batch when the import wrote D1
   * itself.
   */
  function collidingProject() {
    const { doInstance, db, ydoc } = makeDo({
      stories: [],
      pages: [{ id: 42, slug: "about" }, { id: 43, slug: "notes" }],
    });
    ydoc.transact(() => {
      const c = ydoc.getMap<unknown>("config");
      c.set("title", new Y.Text("Demo"));
      c.set("lang", "en");
      seedPage(ydoc, { _id: 42, slug: "about", title: "Mine" });
      seedPage(ydoc, { _id: 43, slug: "about", title: "Theirs" });
    }, null);
    return { doInstance, db, ydoc };
  }

  it("serialises behind the running snapshot: the page INSERT follows the batch", async () => {
    const { doInstance, db, ydoc } = collidingProject();

    // Snapshot first, ingest delivered while it runs. The imported slug is one
    // the re-key will not mint, so the ingest has a row to write and its
    // position in the statement log is observable.
    const snapshotRun = (doInstance as unknown as { forceSnapshot: () => Promise<void> }).forceSnapshot();
    const ingestRun = postIngest(doInstance, {
      pages: { insert: [{ slug: "contact", title: "Contact", body: "", created_by: 7 }] },
    });

    await expect(snapshotRun).resolves.toBeUndefined();
    const res = await ingestRun;
    expect(res.status).toBe(200);

    const batchAt = db.indexOfFirst(/^BATCH$/);
    const insertAt = db.indexOfFirstMatching(/^INSERT INTO project_pages/, "contact");
    expect(batchAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThanOrEqual(0);
    // The ingest's D1 write is strictly after the snapshot's batch — never
    // between that snapshot's seed read and it.
    expect(insertAt).toBeGreaterThan(batchAt);

    // The re-key landed and nothing collided.
    expect(slugsOf(ydoc)).toEqual(["about", "about-2", "contact"]);
    expect(db.liveSlugs()).toEqual(["about", "about-2", "contact"]);
  });

  it("reports the minted slug as already present rather than colliding with it", async () => {
    const { doInstance, db, ydoc } = collidingProject();

    // The repo's page carries the very slug the re-key mints. Delivered while
    // the snapshot runs, this is the interleaving that killed the batch.
    const snapshotRun = (doInstance as unknown as { forceSnapshot: () => Promise<void> }).forceSnapshot();
    const ingestRun = postIngest(doInstance, {
      pages: { insert: [{ slug: "about-2", title: "About 2", body: "", created_by: 7 }] },
    });

    await expect(snapshotRun).resolves.toBeUndefined();
    const res = await ingestRun;
    expect(res.status).toBe(200);
    // The re-key got there first, so the import is a no-op the user is told
    // about — the same answer an already-present slug has always produced.
    expect(await res.json()).toMatchObject({
      applied: { pageInsert: 0 },
      skipped: { pageInsert: ["about-2"] },
    });
    expect(slugsOf(ydoc)).toEqual(["about", "about-2"]);
    expect(db.liveSlugs()).toEqual(["about", "about-2"]);
  });

  it("mints around a slug the document gained from an earlier import", async () => {
    const { doInstance, db, ydoc } = collidingProject();

    // The import lands first this time; the re-key must avoid its slug.
    const res = await postIngest(doInstance, {
      pages: { insert: [{ slug: "about-2", title: "About 2", body: "", created_by: 7 }] },
    });
    expect(res.status).toBe(200);
    await (doInstance as unknown as { forceSnapshot: () => Promise<void> }).forceSnapshot();

    // Three distinct pages: the keeper, the import, and a loser re-keyed
    // AROUND the import's slug rather than onto it.
    expect(slugsOf(ydoc)).toEqual(["about", "about-3", "about-2"]);
    expect(db.liveSlugs()).toEqual(["about", "about-2", "about-3"]);
  });
});

// ---------------------------------------------------------------------------
// The scan names a page whose bytes are not valid UTF-8
// ---------------------------------------------------------------------------

describe("scan-repo-pages answers the warnings its scan raised", () => {
  const WARNING = {
    code: "unreadable_characters",
    file: "telar-content/texts/pages/about.md",
    effect: "build_stops",
    repair: "import_then_publish",
  };

  it("names a page read lossily, with the repair for a page not yet imported", async () => {
    scanRepoPagesMock.mockImplementation(
      async (_t: string, _o: string, _r: string, _head: unknown, report?: { warnings: unknown[]; repair?: string }) => {
        report?.warnings.push({ ...WARNING, repair: report.repair });
        return [{ slug: "about", title: "About", body: "A�", order: 0 }];
      },
    );
    const { context } = buildContext();

    const result = await runAction(buildRequest("scan-repo-pages"), context);

    expect(result).toMatchObject({ ok: true, intent: "scan-repo-pages", warnings: [WARNING] });
    expect(scanRepoPagesMock.mock.calls[0][4]).toMatchObject({ repair: "import_then_publish" });
  });

  it("answers no warnings when the scan fails", async () => {
    scanRepoPagesMock.mockRejectedValue(new Error("GitHub API error fetching tree: 404"));
    const { context } = buildContext();

    const result = await runAction(buildRequest("scan-repo-pages"), context);

    expect(result).toEqual({ ok: true, intent: "scan-repo-pages", pages: [], warnings: [] });
  });

  it("the import's own scan is given no list: the scan the author saw already named the file", async () => {
    scanRepoPagesMock.mockResolvedValue([{ slug: "about", title: "About", body: "A", order: 0 }]);
    const { context } = buildContext({ applied: { pageInsert: 1 } });

    await runAction(buildRequest("import-pages"), context);

    expect(scanRepoPagesMock.mock.calls[0]).toHaveLength(4);
    expect(scanRepoPagesMock.mock.calls[0][4]).toBeUndefined();
  });
});

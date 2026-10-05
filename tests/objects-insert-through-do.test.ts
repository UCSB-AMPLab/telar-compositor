/**
 * Pending-object registration as a DO-routed write.
 *
 * `insert-pending-objects` read
 * `SELECT id, object_id FROM objects WHERE project_id = ?` and then INSERTed
 * the rows it had not seen, with no Durable Object between the read and the
 * write. `objects` carries NO UNIQUE index on `(project_id, object_id)`, so
 * nothing aborts when the two writers converge: the snapshot's own INSERT (a
 * Y.Map whose `_id` is still null) or its dedupe re-key can mint the very
 * `object_id` the action is about to take, and D1 ends up holding two rows
 * under one key. Both are claimed by the document, both survive the orphan
 * sweep, and both are published into objects.csv — with no failure anywhere to
 * report.
 *
 * The window is closed by removing the outside writer: the action posts an
 * `objects.insert` arm to `/ingest-sync`, which mutates the Y.Doc and
 * snapshots inside `blockConcurrencyWhile`. Three properties carry that:
 *
 *   - NO DIRECT WRITE. The action must INSERT no `objects` row itself. One
 *     surviving direct insert re-opens the whole window.
 *   - SERIALISATION. A registration delivered while a snapshot is running must
 *     not reach D1 until that snapshot's batch has completed.
 *   - COLLISION-FREE MINT. With the object in the document, the re-key's
 *     `takenKeys` (document keys UNION D1 keys) already covers it, so the two
 *     cannot converge on one object_id from either running order.
 *
 * `origin` and `missing_from_repo` are the reason this is not the pages arm
 * with the nouns changed. Neither column is carried by the Y.Map on the
 * general path — `origin` is a D1-only provenance classifier that sync reads
 * ("compositor" excludes an object from missing-object flagging) — so the
 * ingest cannot rebuild them from the document. The "compositor" and "repo"
 * values ride the Y.Map, the two `buildObjectYMap` accepts; every other value
 * is patched into D1 after the ingest.
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
// Route-level mocks (mirror tests/insert-pending-objects-hardening.test.ts)
// ---------------------------------------------------------------------------

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
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
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
// The operation lock is granted: these cases are about what the
// action does once it holds it.
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "op-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "head-sha"),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/sync.server", () => ({
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
  computeSyncDiff: vi.fn(),
  applySyncChanges: vi.fn(),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn(),
  verifySiteUrl: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn() }));
vi.mock("~/lib/csv-export.server", () => ({
  serializeObjectsCsv: vi.fn(),
  dbObjectToCsvRow: vi.fn(),
}));
vi.mock("~/lib/upload.server", () => ({
  createImageBlobs: vi.fn(async () => []),
  commitMultipleBinaryFilesWithCsv: vi.fn(),
  arrayBufferToBase64: vi.fn(),
  validateUploadFile: vi.fn(),
}));
vi.mock("~/lib/slugify", () => ({
  generateUniqueObjectSlug: vi.fn(),
  slugify: vi.fn(),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({
  findYMapById: vi.fn(),
  findYMapByIdOrTempId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.objects";
import { getDb } from "~/lib/db.server";
import { registerCommittedObjects } from "~/lib/register-objects.server";
import type { PendingObject } from "~/lib/sync.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const TEST_SECRET = "sess-secret";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

interface PendingFields {
  origin?: string;
  title?: string;
  alt_text?: string | null;
}

function pending(objectId: string, extra: PendingFields = {}): Record<string, unknown> {
  return {
    object_id: objectId,
    title: extra.title ?? `Title ${objectId}`,
    featured: false,
    creator: null,
    description: null,
    source_url: null,
    period: null,
    year: null,
    object_type: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    alt_text: extra.alt_text === undefined ? `Alt ${objectId}` : extra.alt_text,
    dimensions: null,
    extra_columns: null,
    image_available: true,
    ...(extra.origin === undefined ? {} : { origin: extra.origin }),
  };
}

/** The modal's retry, naming an operation by id. */
function buildRequest(operationId: string): Request {
  const form = new URLSearchParams();
  form.set("intent", "insert-pending-objects");
  form.set("projectId", "42");
  form.set("operationId", operationId);
  return new Request("https://compositor.telar.org/objects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function runAction(request: Request, context: Parameters<typeof action>[0]["context"]) {
  return action({ request, context, params: {} } as unknown as Parameters<typeof action>[0]);
}

/**
 * The registration every committing action and every completion runs, with
 * the objects as the client sent them: the committing action records them
 * as they arrive and hands the record's objects to this call.
 */
function runRegistration(
  pendingObjects: unknown,
  context: Parameters<typeof action>[0]["context"],
) {
  const env = (context as unknown as { cloudflare: { env: Env } }).cloudflare.env;
  return registerCommittedObjects(env, getDb(env.DB), PROJECT_ID, 7, pendingObjects as PendingObject[]);
}

/**
 * Pull every bound string out of a Drizzle condition tree. The residue write
 * targets one object_id per statement and the condition is the only place that
 * name appears, so the assertion has to read it back out of the builder's
 * opaque node graph. Cycle-guarded: a column node references its table, which
 * references its columns.
 */
function boundStrings(node: unknown, seen = new WeakSet<object>(), out: string[] = []): string[] {
  if (node === null || typeof node !== "object") return out;
  if (seen.has(node as object)) return out;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (const child of node) boundStrings(child, seen, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.value === "string") out.push(record.value);
  for (const child of Object.values(record)) boundStrings(child, seen, out);
  return out;
}

// ---------------------------------------------------------------------------
// Route harness — a recording DO stub, no document
// ---------------------------------------------------------------------------

interface DoCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

interface UpdateCall {
  values: Record<string, unknown>;
  targets: string[];
}

/** A db mock that records writes; reads answer with `existingRows`. */
function makeRecordingDb(existingRows: Array<{ id: number; object_id: string }> = []) {
  const insertCalls: Record<string, unknown>[][] = [];
  const updateCalls: UpdateCall[] = [];
  const selectCalls: number[] = [];
  let nextId = 900;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          selectCalls.push(selectCalls.length);
          return existingRows;
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((rows: Record<string, unknown>[]) => {
        insertCalls.push(rows);
        return {
          returning: vi.fn(async () =>
            rows.map((r) => ({ id: (nextId += 1), object_id: r.object_id })),
          ),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async (condition: unknown) => {
          updateCalls.push({ values, targets: boundStrings(condition) });
        }),
      })),
    })),
  };
  return { db, insertCalls, updateCalls, selectCalls };
}

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

/**
 * A COLLABORATION binding whose fetch REJECTS rather than answering — the shape
 * of an exception escaping a DO's `blockConcurrencyWhile` callback, as distinct
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
// World harness — one D1 shared by the route and a live DO
// ---------------------------------------------------------------------------

interface ObjectRowState {
  id: number;
  object_id: string;
  title: string;
  origin: string;
  missing_from_repo: number;
  created_by: number | null;
}

interface Op {
  kind: "select" | "run" | "batch";
  sql: string;
  binds: unknown[];
}

/**
 * A D1 fake over a live `objects` row map. There is deliberately NO UNIQUE
 * constraint on `(project_id, object_id)` — that absence is the defect's whole
 * character, and a fake that enforced one would turn a silent duplicate into a
 * loud abort the production database never raises.
 */
function makeWorld(seed: { objects?: ObjectRowState[] } = {}) {
  const ops: Op[] = [];
  const rows = new Map<number, ObjectRowState>();
  for (const o of seed.objects ?? []) rows.set(o.id, { ...o });
  // Above every seeded id: a minted id that collided with one would silently
  // overwrite a seeded row and read as a lost object.
  let nextId = Math.max(5000, ...[...rows.keys()], 0);

  const allRows = () => [...rows.values()];

  // High-water mark of rows per object_id, sampled after every mutation. The
  // final row set is not enough to see this defect: an orphan sweep on the very
  // next snapshot removes whichever duplicate no Y.Map claims, so a test that
  // only reads the end state calls a window closed that was open. Publish reads
  // D1 directly, so a duplicate that exists at all is a duplicate objects.csv
  // can ship.
  const peak = new Map<string, number>();
  function sample() {
    const counts = new Map<string, number>();
    for (const row of rows.values()) {
      counts.set(row.object_id, (counts.get(row.object_id) ?? 0) + 1);
    }
    for (const [key, n] of counts) peak.set(key, Math.max(peak.get(key) ?? 0, n));
  }
  sample();

  function resolve(sql: string): unknown[] {
    if (/FROM objects WHERE project_id/.test(sql)) {
      return allRows().map((r) => ({
        ...r,
        creator: "",
        description: "",
        alt_text: "",
        source_url: "",
        period: "",
        year: "",
        object_type: "",
        subjects: "",
        source: "",
        credit: "",
        thumbnail: "",
        dimensions: "",
        extra_columns: "",
        featured: 0,
        image_available: 1,
        order_key: null,
        course_project_id: null,
      }));
    }
    if (/FROM stories WHERE project_id/.test(sql)) return [];
    if (/FROM steps WHERE story_id/.test(sql)) return [];
    if (/FROM layers WHERE step_id/.test(sql)) return [];
    if (/FROM glossary_terms WHERE project_id/.test(sql)) return [];
    if (/FROM project_pages WHERE project_id/.test(sql)) return [];
    if (/FROM project_members/.test(sql)) return [];
    return [];
  }

  /** Apply one statement to the row state. */
  function apply(sql: string, binds: unknown[]): number | null {
    const insertObject = /^INSERT INTO objects \(([^)]*)\)/.exec(sql);
    if (insertObject) {
      const cols = insertObject[1].split(",").map((c) => c.trim().replace(/"/g, ""));
      const at = (name: string) => {
        const i = cols.indexOf(name);
        return i < 0 ? undefined : binds[i];
      };
      const idCol = cols.indexOf("id");
      const id = idCol >= 0 ? Number(binds[idCol]) : (nextId += 1);
      rows.set(id, {
        id,
        object_id: String(at("object_id") ?? ""),
        title: String(at("title") ?? ""),
        origin: String(at("origin") ?? "repo"),
        missing_from_repo: Number(at("missing_from_repo") ?? 0),
        created_by: (at("created_by") as number | null) ?? null,
      });
      return id;
    }
    if (/^UPDATE objects SET title = \?, object_id = \?/.test(sql)) {
      const targetId = Number(binds[binds.length - 1]);
      const row = rows.get(targetId);
      if (row) {
        row.title = String(binds[0] ?? "");
        row.object_id = String(binds[1] ?? "");
      }
      return null;
    }
    if (/^DELETE FROM objects WHERE id/.test(sql)) {
      rows.delete(Number(binds[0]));
      return null;
    }
    return null;
  }

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() {
        return bound;
      },
      bind(...args: unknown[]) {
        checkD1Bind(sql, args);
        bound = args;
        return stmt;
      },
      async run() {
        ops.push({ kind: "run", sql, binds: bound });
        const id = apply(sql, bound);
        sample();
        return { meta: { last_row_id: id ?? (nextId += 1), changes: 1 }, success: true as const };
      },
      async all<T = unknown>() {
        ops.push({ kind: "select", sql, binds: bound });
        return { results: resolve(sql) as T[], success: true as const };
      },
      async first<T = unknown>() {
        ops.push({ kind: "select", sql, binds: bound });
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) {
          return { id: 1 } as T;
        }
        // The base row: no blob and no tags, which is the cold build.
        if (/^SELECT yjs_state/.test(sql)) {
          return { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 } as T;
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
      for (const s of statements) {
        apply(s.sql, s.boundArgs);
        sample();
      }
      for (const s of statements) ops.push({ kind: "run", sql: s.sql, binds: s.boundArgs });
      return statements.map(() => ({ success: true }));
    },
  };

  // A ctx whose blockConcurrencyWhile is a real serialising mutex — the
  // property the fix leans on. A pass-through gate would let the ordering
  // assertions pass while the production race stayed open.
  let chain: Promise<unknown> = Promise.resolve();
  const ctx = {
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

  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: DB as unknown, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;

  // The route's Drizzle handle over the SAME rows, so a direct write and a
  // snapshot write are visible to each other exactly as they are in production.
  const insertCalls: Record<string, unknown>[][] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => allRows().map((r) => ({ id: r.id, object_id: r.object_id }))),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>[]) => {
        insertCalls.push(values);
        return {
          returning: vi.fn(async () =>
            values.map((v) => {
              const id = (nextId += 1);
              rows.set(id, {
                id,
                object_id: String(v.object_id ?? ""),
                title: String(v.title ?? ""),
                origin: String(v.origin ?? "repo"),
                missing_from_repo: v.missing_from_repo ? 1 : 0,
                created_by: (v.created_by as number | null) ?? null,
              });
              sample();
              return { id, object_id: String(v.object_id ?? "") };
            }),
          ),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async (condition: unknown) => {
          const targets = new Set(boundStrings(condition));
          for (const row of rows.values()) {
            if (!targets.has(row.object_id)) continue;
            if (typeof values.origin === "string") row.origin = values.origin;
          }
        }),
      })),
    })),
  };

  const user = { id: 7, encrypted_access_token: "enc-token" };
  const context = {
    get: vi.fn(() => user),
    cloudflare: {
      env: {
        ENCRYPTION_KEY: "key",
        SESSION_SECRET: TEST_SECRET,
        DB,
        COLLABORATION: {
          idFromName: (name: string) => name,
          get: () => doInstance,
        },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];

  return {
    doInstance,
    ydoc,
    db,
    context,
    insertCalls,
    ops,
    liveRows: () => allRows().map((r) => r.object_id).sort(),
    peakRowsFor: (objectId: string) => peak.get(objectId) ?? 0,
    rowsFor: (objectId: string) => allRows().filter((r) => r.object_id === objectId),
    originOf: (objectId: string) => allRows().find((r) => r.object_id === objectId)?.origin,
    indexOfFirst: (re: RegExp) => ops.findIndex((o) => re.test(o.sql)),
    indexOfFirstMatching: (re: RegExp, bind: string) =>
      ops.findIndex((o) => re.test(o.sql) && o.binds.some((b) => b === bind)),
    forceSnapshot: () =>
      (doInstance as unknown as { forceSnapshot: () => Promise<void> }).forceSnapshot(),
  };
}

function seedObject(
  ydoc: Y.Doc,
  fields: { _id: number | null; objectId: string; title?: string },
) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("object_id", fields.objectId);
  m.set("title", new Y.Text(fields.title ?? ""));
  m.set("creator", new Y.Text(""));
  m.set("description", new Y.Text(""));
  m.set("alt_text", new Y.Text(""));
  m.set("period", new Y.Text(""));
  m.set("year", new Y.Text(""));
  m.set("object_type", new Y.Text(""));
  m.set("subjects", new Y.Text(""));
  m.set("source", new Y.Text(""));
  m.set("credit", new Y.Text(""));
  m.set("source_url", "");
  m.set("thumbnail", "");
  m.set("dimensions", "");
  m.set("extra_columns", "");
  m.set("featured", false);
  m.set("image_available", true);
  m.set("_validation_state", "valid");
  m.set("created_by", 1);
  ydoc.getArray<Y.Map<unknown>>("objects").push([m]);
}

function objectIdsOf(ydoc: Y.Doc): string[] {
  return ydoc
    .getArray<Y.Map<unknown>>("objects")
    .toArray()
    .map((m) => String(m.get("object_id")));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: PROJECT_ID, github_repo_full_name: "owner/repo" } as never,
    userRole: "convenor",
  });
});

// ---------------------------------------------------------------------------
// 1. The action writes no objects row of its own
// ---------------------------------------------------------------------------

describe("registration routes its writes through the DO", () => {
  it("posts an objects.insert ingest and INSERTs no row directly", async () => {
    const { db, insertCalls, selectCalls } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context, calls } = buildContext({ applied: { objectInsert: 2 } });

    const result = (await runRegistration([pending("bell"), pending("drum")],
      context,
    )) as { ok: boolean; insertedCount: number };

    // The direct write is the whole hole: one surviving INSERT re-opens it.
    expect(insertCalls).toHaveLength(0);
    // And the read that preceded it goes with it — presence is the document's
    // answer now, not a pre-read D1 can invalidate before the write lands.
    expect(selectCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/ingest-sync");
    expect(calls[0].headers["x-internal-project"]).toBe(String(PROJECT_ID));
    expect(result).toMatchObject({ ok: true, insertedCount: 2 });
  });

  it("sends every column the object Y.Map carries", async () => {
    const { db } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context, calls } = buildContext({ applied: { objectInsert: 1 } });

    await runRegistration([pending("bell", { title: "Mission Bell" })], context);

    const sent = (calls[0].body as { objects: { insert: Array<Record<string, unknown>> } })
      .objects.insert;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      object_id: "bell",
      title: "Mission Bell",
      alt_text: "Alt bell",
      featured: false,
      image_available: true,
      created_by: 7,
    });
  });

  it("reports the DO's skip list rather than a pre-read of D1", async () => {
    const { db } = makeRecordingDb([{ id: 7, object_id: "bell" }]);
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context } = buildContext({
      applied: { objectInsert: 1 },
      skipped: { objectInsert: ["bell"] },
    });

    const result = (await runRegistration([pending("bell"), pending("drum")],
      context,
    )) as { ok: boolean; insertedCount: number; alreadyPresent: string[] };

    expect(result.ok).toBe(true);
    expect(result.insertedCount).toBe(1);
    expect(result.alreadyPresent).toEqual(["bell"]);
  });

  it("makes no DO call at all when the pending list is empty", async () => {
    const { db } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context, calls } = buildContext();

    const result = (await runRegistration([], context)) as { ok: boolean };

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. D1-only residue
// ---------------------------------------------------------------------------

describe("registration preserves the D1-only residue", () => {
  // "compositor" is the one origin the Y.Map carries, so it reaches D1 through
  // the snapshot's own INSERT and needs no patch. Sync reads that value as a
  // classifier — a compositor-origin object is never flagged missing from the
  // repo — so losing it would put an author's upload on the "(removed)" list
  // the first time a CSV commit failed.
  it("carries the compositor origin on the ingest and writes no residue for it", async () => {
    const { db, updateCalls } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context, calls } = buildContext({ applied: { objectInsert: 1 } });

    await runRegistration([pending("bell")], context);

    const sent = (calls[0].body as { objects: { insert: Array<Record<string, unknown>> } })
      .objects.insert;
    expect(sent[0].origin).toBe("compositor");
    expect(updateCalls).toHaveLength(0);
  });

  // "repo" rides the ingest as well, so a row D1 refused at the flush and
  // inserted by a later snapshot still has it; no patch follows.
  it("carries a repo origin on the ingest and writes no residue for it", async () => {
    const { db, updateCalls } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context, calls } = buildContext({ applied: { objectInsert: 1 } });

    await runRegistration([pending("bell", { origin: "repo" })], context);

    const sent = (calls[0].body as { objects: { insert: Array<Record<string, unknown>> } })
      .objects.insert;
    expect(sent[0].origin).toBe("repo");
    expect(updateCalls).toHaveLength(0);
  });

  // An origin the insert cannot carry is still patched into D1 once the row
  // exists, and kept off the wire.
  it("patches an origin the insert cannot carry into D1 after the ingest", async () => {
    const { db, updateCalls } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context, calls } = buildContext({ applied: { objectInsert: 1 } });

    await runRegistration([pending("bell", { origin: "imported" })], context);

    const sent = (calls[0].body as { objects: { insert: Array<Record<string, unknown>> } })
      .objects.insert;
    expect(sent[0].origin).toBeUndefined();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].values).toMatchObject({ origin: "imported" });
    expect(updateCalls[0].targets).toContain("bell");
  });

  // A row the ingest skipped already existed with an origin of its own. The
  // direct-write action never touched such a row, and neither may this one:
  // patching it would reclassify an object nobody asked to change.
  it("writes no residue for an object the ingest skipped or refused", async () => {
    const { db, updateCalls } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context } = buildContext({
      applied: { objectInsert: 1 },
      skipped: { objectInsert: ["bell"] },
      failed: { objectInsert: ["drum"] },
    });

    await runRegistration([
        pending("bell", { origin: "imported" }),
        pending("drum", { origin: "imported" }),
        pending("flute", { origin: "imported" }),
      ],
      context,
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].targets).toContain("flute");
  });

  it("does not count a refused insert among the registered objects", async () => {
    const { db } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context } = buildContext({
      applied: { objectInsert: 1 },
      failed: { objectInsert: ["drum"] },
    });

    const result = (await runRegistration([pending("bell"), pending("drum")],
      context,
    )) as { ok: boolean; insertedCount: number; failed: string[] };

    expect(result.insertedCount).toBe(1);
    expect(result.failed).toEqual(["drum"]);
  });

  it("answers ok: false on a refused insert so the modal offers its retry", async () => {
    // The modal reads `ok` alone to choose between its success and
    // `insert_failed` steps. Answering ok on a refusal showed the author a
    // success banner for an object D1 does not hold — and the images for it are
    // already committed to the repo, which is what makes the retry the right
    // offer rather than a discard.
    const { db } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context } = buildContext({
      applied: { objectInsert: 1 },
      failed: { objectInsert: ["drum"] },
    });

    const result = (await runRegistration([pending("bell"), pending("drum")],
      context,
    )) as { ok: boolean; error?: string; failed: string[] };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("insert_failed");
    expect(result.failed).toEqual(["drum"]);
  });

  it("answers ok: true when every insert landed", async () => {
    const { db } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context } = buildContext({ applied: { objectInsert: 2 }, failed: {} });

    const result = (await runRegistration([pending("bell"), pending("drum")],
      context,
    )) as { ok: boolean; insertedCount: number };

    expect(result.ok).toBe(true);
    expect(result.insertedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Failure reporting (the telar-compositor#24 hardening, on the new path)
// ---------------------------------------------------------------------------

describe("registration failure reporting", () => {
  it("reports a non-2xx ingest as insert_failed rather than a silent success", async () => {
    const { db } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context } = buildContext({}, 503);

    const result = (await runRegistration([pending("bell")], context)) as {
      ok: boolean;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("insert_failed");
  });

  it("reports a rejected ingest fetch as a structured failure rather than throwing", async () => {
    const { db } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context } = buildRejectingContext();

    const result = (await runRegistration([pending("bell")], context)) as {
      ok: boolean;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("insert_failed");
  });

  it("the retry still answers missing_data without an operation id and no_project without a project", async () => {
    const { db } = makeRecordingDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const { context } = buildContext();

    const malformed = (await runAction(buildRequest("{not json"), context)) as {
      ok: boolean;
      error: string;
    };
    expect(malformed).toMatchObject({ ok: false, error: "missing_data" });

    vi.mocked(resolveActiveProject).mockResolvedValue(null);
    const noProject = (await runAction(buildRequest("5"), context)) as {
      ok: boolean;
      error: string;
    };
    expect(noProject).toMatchObject({ ok: false, error: "no_project" });
  });
});

// ---------------------------------------------------------------------------
// 4. The window itself
// ---------------------------------------------------------------------------

describe("a registration cannot mint a second row for one object_id", () => {
  /**
   * The plainest form of the defect, and the one that needs no interleaving at
   * all: the document already holds the object with a null `_id` (a peer added
   * it, or an earlier registration reached the document and not yet D1), so the
   * next snapshot will INSERT it. A registration that writes D1 itself puts a
   * second row under the same key, and nothing in the schema objects.
   */
  it("registers an object the document already holds without duplicating its row", async () => {
    const world = makeWorld();
    vi.mocked(getDb).mockReturnValue(world.db as never);
    world.ydoc.transact(() => {
      world.ydoc.getMap<unknown>("config").set("lang", "en");
      seedObject(world.ydoc, { _id: null, objectId: "bell", title: "Mission Bell" });
    }, null);

    await runRegistration([pending("bell")], world.context);
    await world.forceSnapshot();

    // One row at the end is not the claim. `bell` must never have had two, or a
    // publish between the direct write and the sweep ships the object twice.
    expect(world.peakRowsFor("bell")).toBe(1);
    expect(world.rowsFor("bell")).toHaveLength(1);
    expect(objectIdsOf(world.ydoc)).toEqual(["bell"]);
  });

  /**
   * The re-key form. Two collaborators have renamed their objects onto `bell`,
   * so the dedupe pass re-keys the loser to `bell-2` — the very object_id a
   * registration is carrying, because the id was minted against a D1 read that
   * could not see a re-key still living in the document. Whichever order the
   * two run in, one object_id must end up owning one row.
   */
  it("does not converge with a dedupe re-key on one object_id", async () => {
    const world = makeWorld({
      objects: [
        { id: 5001, object_id: "bell", title: "Mine", origin: "repo", missing_from_repo: 0, created_by: null },
      ],
    });
    vi.mocked(getDb).mockReturnValue(world.db as never);
    world.ydoc.transact(() => {
      world.ydoc.getMap<unknown>("config").set("lang", "en");
      seedObject(world.ydoc, { _id: 5001, objectId: "bell", title: "Mine" });
      seedObject(world.ydoc, { _id: null, objectId: "bell", title: "Theirs" });
    }, null);

    const registration = runRegistration([pending("bell-2")], world.context);
    await world.forceSnapshot();
    await registration;
    await world.forceSnapshot();

    expect(world.rowsFor("bell-2")).toHaveLength(1);
    expect(world.peakRowsFor("bell-2")).toBe(1);
    // Every live object_id is distinct — the re-keyed loser found a free key.
    const ids = world.liveRows();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serialises behind a running snapshot: the object INSERT follows the batch", async () => {
    const world = makeWorld({
      objects: [
        { id: 5001, object_id: "bell", title: "Bell", origin: "repo", missing_from_repo: 0, created_by: null },
      ],
    });
    vi.mocked(getDb).mockReturnValue(world.db as never);
    world.ydoc.transact(() => {
      world.ydoc.getMap<unknown>("config").set("lang", "en");
      seedObject(world.ydoc, { _id: 5001, objectId: "bell", title: "Bell" });
    }, null);

    const snapshotRun = world.forceSnapshot();
    const registration = runRegistration([pending("drum")], world.context);

    await expect(snapshotRun).resolves.toBeUndefined();
    await registration;

    const batchAt = world.indexOfFirst(/^BATCH$/);
    const insertAt = world.indexOfFirstMatching(/^INSERT INTO objects/, "drum");
    expect(batchAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThanOrEqual(0);
    // The registration's D1 write is strictly after the snapshot's batch —
    // never between that snapshot's seed read and it.
    expect(insertAt).toBeGreaterThan(batchAt);
    expect(world.rowsFor("drum")).toHaveLength(1);
  });

  it("lands the compositor origin on the row the snapshot writes", async () => {
    const world = makeWorld();
    vi.mocked(getDb).mockReturnValue(world.db as never);
    world.ydoc.transact(() => {
      world.ydoc.getMap<unknown>("config").set("lang", "en");
    }, null);

    await runRegistration([pending("bell")], world.context);

    expect(world.originOf("bell")).toBe("compositor");
    expect(world.rowsFor("bell")[0].missing_from_repo).toBe(0);
  });

  it("lands a repo origin on the row through the snapshot's INSERT", async () => {
    const world = makeWorld();
    vi.mocked(getDb).mockReturnValue(world.db as never);
    world.ydoc.transact(() => {
      world.ydoc.getMap<unknown>("config").set("lang", "en");
    }, null);

    await runRegistration([pending("bell", { origin: "repo" })], world.context);

    expect(world.originOf("bell")).toBe("repo");
  });
});

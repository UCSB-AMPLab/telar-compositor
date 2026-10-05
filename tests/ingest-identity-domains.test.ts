/**
 * Identity value domains at the ingest boundary.
 *
 * The identity value domain is closed against client-origin transactions:
 * a collaborator who writes `object_id: []` onto a Y.Map has the write reverted
 * by `extractIdentityDomainViolations`, because a one-element array renders to
 * a neighbour's key in `deduplicateYArray` and so IS that key as far as the
 * snapshot's reconciliation is concerned.
 *
 * That pass never sees the ingest. `/ingest-sync` mutates the document in a
 * NULL-ORIGIN transaction, and null origin is precisely what the entry passes
 * exempt — it is how the runtime marks its own writes. The origin check was
 * never about data quality, so a server-origin transaction carrying
 * client-supplied values inherits an exemption meant for values the runtime
 * minted itself. `insert-pending-objects` validates only that the submitted
 * JSON is an array, so `object_id: []` reaches `buildObjectYMap` verbatim,
 * lands in the document unkeyed, and publishes that way: `objects.object_id`
 * is `text NOT NULL` with no UNIQUE index, so D1 accepts the empty string the
 * snapshot derives from it.
 *
 * The boundary is therefore the payload, not the transaction. These tests pin
 * that every arm stating an identity value is judged by
 * `isIdentityValueInDomain` BEFORE anything is written to the document, and
 * that a refusal is reported rather than dropped.
 *
 * A refused entry is named by its INDEX in the arm it arrived on, never by its
 * value. Rendering an untrusted value to describe it — `String(value)` — is the
 * move that creates this class of defect in the first place, and a report is
 * not a good enough reason to make it.
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
// Route-level mocks (mirror tests/objects-insert-through-do.test.ts)
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
import { resolveActiveProject } from "~/lib/membership.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const TEST_SECRET = "sess-secret";

// ---------------------------------------------------------------------------
// DO harness — a permissive D1 the snapshot can complete against
// ---------------------------------------------------------------------------
//
// The claim under test is what reaches the DOCUMENT, so D1 only has to answer
// well enough for `flushSnapshotNow` to finish: empty reads, accepted writes.
// Rows are kept per table so an assertion can ask what the snapshot persisted.

interface Op {
  kind: "select" | "run" | "batch";
  sql: string;
  binds: unknown[];
}

function makeDb() {
  const ops: Op[] = [];
  const objectRows: Array<{ id: number; object_id: unknown }> = [];
  let nextId = 5000;

  function resolve(sql: string): unknown[] {
    if (/FROM (stories|steps|layers|objects|glossary_terms|project_pages|project_members)\b/.test(sql)) {
      return [];
    }
    return [];
  }

  function apply(sql: string, binds: unknown[]): number | null {
    const insertObject = /^INSERT INTO objects \(([^)]*)\)/.exec(sql);
    if (insertObject) {
      const cols = insertObject[1].split(",").map((c) => c.trim().replace(/"/g, ""));
      const i = cols.indexOf("object_id");
      const id = (nextId += 1);
      objectRows.push({ id, object_id: i < 0 ? undefined : binds[i] });
      return id;
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
      for (const s of statements) apply(s.sql, s.boundArgs);
      for (const s of statements) ops.push({ kind: "run", sql: s.sql, binds: s.boundArgs });
      return statements.map(() => ({ success: true }));
    },
  };

  return { DB, ops, objectRows };
}

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

function makeDo() {
  const db = makeDb();
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: db.DB as unknown, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  // A config key so the snapshot has something to write for the project even
  // when every content arm is refused.
  ydoc.transact(() => {
    ydoc.getMap<unknown>("config").set("lang", "en");
  }, null);
  return { doInstance, db, ydoc };
}

interface IngestReport {
  applied: Record<string, number>;
  skipped: Record<string, unknown[]>;
  failed: Record<string, unknown[]>;
  refused: Record<string, number[]>;
}

async function postIngest(
  doInstance: ProjectCollaborationDO,
  body: unknown,
): Promise<{ status: number; report: IngestReport }> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, TEST_SECRET, "ingest-sync");
  const res = await doInstance.fetch(
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
  return { status: res.status, report: (await res.json()) as IngestReport };
}

const rootOf = (ydoc: Y.Doc, root: string) =>
  ydoc.getArray<Y.Map<unknown>>(root).toArray();

/** Raw identity values held by a root, unrendered — the assertion is on shape. */
const rawKeys = (ydoc: Y.Doc, root: string, key: string): unknown[] =>
  rootOf(ydoc, root).map((m) => m.get(key));

function seedObject(ydoc: Y.Doc, objectId: string, id: number | null = null) {
  const m = new Y.Map<unknown>();
  m.set("_id", id);
  m.set("object_id", objectId);
  m.set("title", new Y.Text(objectId));
  m.set("created_by", 1);
  ydoc.getArray<Y.Map<unknown>>("objects").push([m]);
}

function seedStory(ydoc: Y.Doc, storyId: string) {
  const m = new Y.Map<unknown>();
  m.set("_id", 1);
  m.set("story_id", storyId);
  m.set("title", new Y.Text(storyId));
  m.set("subtitle", new Y.Text(""));
  m.set("byline", new Y.Text(""));
  m.set("steps", new Y.Array<Y.Map<unknown>>());
  ydoc.getArray<Y.Map<unknown>>("stories").push([m]);
}

function seedTerm(ydoc: Y.Doc, termId: string) {
  const m = new Y.Map<unknown>();
  m.set("_id", 1);
  m.set("term_id", termId);
  m.set("title", new Y.Text(termId));
  m.set("definition", new Y.Text(""));
  ydoc.getArray<Y.Map<unknown>>("glossary").push([m]);
}

// The values the domain rule refuses, each standing for a different way in.
// `[]` and `["x"]` are the structural forms `deduplicateYArray` renders to a
// key; `""` is the value it reads as "not yet keyed" and skips; `{}` and a
// number are the remaining JSON shapes a payload can carry.
const OUT_OF_DOMAIN: Array<[string, unknown]> = [
  ["an empty array", []],
  ["a one-element array", ["victim"]],
  ["an empty string", ""],
  ["an object", {}],
  ["a number", 7],
];

// ---------------------------------------------------------------------------
// 1. objects.insert — the reported arm
// ---------------------------------------------------------------------------

const objectInsert = (objectId: unknown) => ({
  object_id: objectId,
  title: "Forged",
  featured: false,
  created_by: 7,
  image_available: true,
});

describe("/ingest-sync objects.insert refuses an out-of-domain object_id", () => {
  for (const [label, value] of OUT_OF_DOMAIN) {
    it(`refuses ${label} without writing it to the document`, async () => {
      const { doInstance, db, ydoc } = makeDo();

      const { status, report } = await postIngest(doInstance, {
        objects: { insert: [objectInsert(value)] },
      });

      expect(status).toBe(200);
      // Not in the document at all — the arm is judged before the transaction.
      expect(rootOf(ydoc, "objects")).toHaveLength(0);
      // And so never in D1: no row is minted for a key that never landed.
      expect(db.objectRows).toHaveLength(0);
      expect(report.applied.objectInsert).toBe(0);
      // Reported, not dropped — by position, never by rendering the value.
      expect(report.refused.objectInsert).toEqual([0]);
      // And not misreported as either of the buckets that already have meanings.
      expect(report.skipped.objectInsert ?? []).toEqual([]);
      expect(report.failed.objectInsert ?? []).toEqual([]);
    });
  }

  it("refuses an absent object_id — the arm exists to state one", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      objects: { insert: [{ title: "No key", featured: false, created_by: 7 }] },
    });

    expect(rootOf(ydoc, "objects")).toHaveLength(0);
    expect(report.refused.objectInsert).toEqual([0]);
  });

  it("keeps the valid neighbours of a refused entry, and reports its index", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      objects: {
        insert: [objectInsert("bell"), objectInsert([]), objectInsert("drum")],
      },
    });

    expect(rawKeys(ydoc, "objects", "object_id")).toEqual(["bell", "drum"]);
    expect(report.applied.objectInsert).toBe(2);
    expect(report.refused.objectInsert).toEqual([1]);
  });

  it("cannot land a structural key that renders onto a neighbour's", async () => {
    // The reconciliation reading, spelled out: `["bell"]` is not the string
    // "bell" to `===`, so no arm skips it as present — but it IS "bell" to
    // `deduplicateYArray`, which would collapse the two onto one row.
    const { doInstance, ydoc } = makeDo();
    ydoc.transact(() => seedObject(ydoc, "bell", 5001), null);

    const { report } = await postIngest(doInstance, {
      objects: { insert: [objectInsert(["bell"])] },
    });

    expect(rawKeys(ydoc, "objects", "object_id")).toEqual(["bell"]);
    expect(report.refused.objectInsert).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// 2. The other arms — nothing about this defect is objects-specific
// ---------------------------------------------------------------------------

describe("/ingest-sync glossary.insert refuses an out-of-domain term_id", () => {
  it("refuses a structural term_id without writing it", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      glossary: { insert: [{ termId: [], title: "Forged", definition: "" }] },
    });

    expect(rootOf(ydoc, "glossary")).toHaveLength(0);
    expect(report.applied.glossaryInsert).toBe(0);
    expect(report.refused.glossaryInsert).toEqual([0]);
  });

  it("refuses an empty-string term_id by the same rule", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      glossary: { insert: [{ termId: "", title: "Forged", definition: "" }] },
    });

    expect(rootOf(ydoc, "glossary")).toHaveLength(0);
    expect(report.refused.glossaryInsert).toEqual([0]);
  });
});

describe("/ingest-sync pages.insert refuses an out-of-domain slug", () => {
  it("refuses a structural slug rather than rendering it to a string", async () => {
    // Deciding presence from a RENDERED slug while writing the raw one is the
    // shape of the defect: `["about"]` renders to "about" for the skip check
    // and lands as an array in the document. Neither half may touch it.
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      pages: { insert: [{ slug: ["about"], title: "Forged", body: "", created_by: 7 }] },
    });

    expect(rootOf(ydoc, "pages")).toHaveLength(0);
    expect(report.applied.pageInsert).toBe(0);
    expect(report.refused.pageInsert).toEqual([0]);
  });

  it("refuses an empty slug as a refusal, not as a skip", async () => {
    // `skipped` is the caller's "the project already has this page", which an
    // empty slug is not: no page holds it and none ever will.
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      pages: { insert: [{ slug: "", title: "Forged", body: "", created_by: 7 }] },
    });

    expect(rootOf(ydoc, "pages")).toHaveLength(0);
    expect(report.refused.pageInsert).toEqual([0]);
    expect(report.skipped.pageInsert ?? []).toEqual([]);
  });
});

describe("/ingest-sync stories.insert refuses an out-of-domain story_id", () => {
  it("refuses a structural story_id without pushing the story", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      stories: {
        insert: [{
          storyId: [], title: "Forged", subtitle: "", byline: "",
          isPrivate: false, showSections: false, steps: [], layers: [],
        }],
      },
    });

    expect(rootOf(ydoc, "stories")).toHaveLength(0);
    expect(report.applied.storyInsert).toBe(0);
    expect(report.refused.storyInsert).toEqual([0]);
  });

  it("leaves a story the payload would otherwise have replaced", async () => {
    // buildStoryYMap deletes every same-story_id entry before pushing. The
    // comparison is `===`, so a structural key deletes nothing — but the arm
    // must not run at all, or the forged story is pushed beside the real one.
    const { doInstance, ydoc } = makeDo();
    ydoc.transact(() => seedStory(ydoc, "opening"), null);

    const { report } = await postIngest(doInstance, {
      stories: {
        insert: [{
          storyId: ["opening"], title: "Forged", subtitle: "", byline: "",
          isPrivate: false, showSections: false, steps: [], layers: [],
        }],
      },
    });

    expect(rawKeys(ydoc, "stories", "story_id")).toEqual(["opening"]);
    expect(report.refused.storyInsert).toEqual([0]);
  });
});

describe("/ingest-sync update and remove arms refuse an out-of-domain key", () => {
  // These arms only LOOK UP by the key, and `indexByKey` compares with `===`,
  // so a structural key matches nothing today. They are covered because the
  // report is the point: a lookup that silently found nothing is reported as
  // `skipped`, which the callers read as "the entity is absent from the
  // document" — a claim the DO has not established for a key it never
  // compared honestly.
  it("refuses a structural objectId on objects.update", async () => {
    const { doInstance, ydoc } = makeDo();
    ydoc.transact(() => seedObject(ydoc, "bell", 5001), null);

    const { report } = await postIngest(doInstance, {
      objects: { update: [{ objectId: ["bell"], fields: { title: "Forged" } }] },
    });

    expect(String(rootOf(ydoc, "objects")[0].get("title"))).toBe("bell");
    expect(report.refused.objectUpdate).toEqual([0]);
    expect(report.skipped.objectUpdate ?? []).toEqual([]);
  });

  it("refuses a structural storyId on stories.update", async () => {
    const { doInstance, ydoc } = makeDo();
    ydoc.transact(() => seedStory(ydoc, "opening"), null);

    const { report } = await postIngest(doInstance, {
      stories: {
        update: [{
          storyId: ["opening"], title: "Forged", subtitle: "", byline: "",
          isPrivate: false, showSections: false,
        }],
      },
    });

    expect(String(rootOf(ydoc, "stories")[0].get("title"))).toBe("opening");
    expect(report.refused.storyUpdate).toEqual([0]);
    expect(report.skipped.storyUpdate ?? []).toEqual([]);
  });

  it("refuses a structural termId on glossary.update", async () => {
    const { doInstance, ydoc } = makeDo();
    ydoc.transact(() => seedTerm(ydoc, "encomienda"), null);

    const { report } = await postIngest(doInstance, {
      glossary: { update: [{ termId: ["encomienda"], title: "Forged", definition: "" }] },
    });

    expect(String(rootOf(ydoc, "glossary")[0].get("title"))).toBe("encomienda");
    expect(report.refused.glossaryUpdate).toEqual([0]);
    expect(report.skipped.glossaryUpdate ?? []).toEqual([]);
  });

  it("refuses a structural entry on objects.remove", async () => {
    const { doInstance, ydoc } = makeDo();
    ydoc.transact(() => seedObject(ydoc, "bell", 5001), null);

    const { report } = await postIngest(doInstance, {
      objects: { remove: [["bell"]] },
    });

    expect(rawKeys(ydoc, "objects", "object_id")).toEqual(["bell"]);
    expect(report.applied.objectRemove).toBe(0);
    expect(report.refused.objectRemove).toEqual([0]);
    expect(report.skipped.objectRemove ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. No regression — an ordinary ingest still applies
// ---------------------------------------------------------------------------

describe("/ingest-sync still applies an ordinary payload", () => {
  it("applies every arm and refuses nothing", async () => {
    const { doInstance, ydoc } = makeDo();
    ydoc.transact(() => {
      seedObject(ydoc, "bell", 5001);
      seedStory(ydoc, "opening");
      seedTerm(ydoc, "encomienda");
    }, null);

    const { status, report } = await postIngest(doInstance, {
      config: [{ key: "title", value: "A Project" }, { key: "lang", value: "es" }],
      stories: {
        update: [{
          storyId: "opening", title: "Opening", subtitle: "s", byline: "b",
          isPrivate: false, showSections: true,
        }],
        insert: [{
          storyId: "closing", title: "Closing", subtitle: "", byline: "",
          isPrivate: false, showSections: false, steps: [], layers: [],
        }],
      },
      objects: {
        update: [{ objectId: "bell", fields: { title: "Mission Bell" } }],
        insert: [objectInsert("drum")],
        remove: [],
      },
      glossary: {
        update: [{ termId: "encomienda", title: "Encomienda", definition: "d" }],
        insert: [{ termId: "mita", title: "Mita", definition: "d" }],
      },
      pages: { insert: [{ slug: "about", title: "About", body: "b", created_by: 7 }] },
    });

    expect(status).toBe(200);
    expect(report.applied).toMatchObject({
      config: 2, storyUpdate: 1, storyInsert: 1, objectUpdate: 1,
      objectInsert: 1, glossaryUpdate: 1, glossaryInsert: 1, pageInsert: 1,
    });
    for (const [bucket, indexes] of Object.entries(report.refused)) {
      expect([bucket, indexes]).toEqual([bucket, []]);
    }
    expect(rawKeys(ydoc, "objects", "object_id")).toEqual(["bell", "drum"]);
    expect(rawKeys(ydoc, "stories", "story_id")).toEqual(["opening", "closing"]);
    expect(rawKeys(ydoc, "glossary", "term_id")).toEqual(["encomienda", "mita"]);
    expect(rawKeys(ydoc, "pages", "slug")).toEqual(["about"]);
  });

  it("removes an object by an in-domain key", async () => {
    const { doInstance, ydoc } = makeDo();
    ydoc.transact(() => seedObject(ydoc, "bell", 5001), null);

    const { report } = await postIngest(doInstance, {
      objects: { remove: ["bell"] },
    });

    expect(rootOf(ydoc, "objects")).toHaveLength(0);
    expect(report.applied.objectRemove).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The route — defence in depth at the outermost boundary
// ---------------------------------------------------------------------------
//
// The DO check is the fix: a route is not the only way into the ingest, and
// `/ingest-sync` is reachable by anything holding the internal marker. But
// the client's JSON arrives through `commit-objects`, and validating only that
// it parsed to an array is what let this through, so the arm is closed in the
// registration that every route path runs as well.

function pendingObject(objectId: unknown): Record<string, unknown> {
  return {
    object_id: objectId,
    title: "Forged",
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
    alt_text: null,
    dimensions: null,
    extra_columns: null,
    image_available: true,
  };
}

/**
 * The registration the committing actions and every completion run, with the
 * objects as the client sent them to `commit-objects`, which records them as
 * they arrive.
 */
function runRegistration(
  pendingObjects: unknown,
  context: Parameters<typeof action>[0]["context"],
) {
  const env = (context as unknown as { cloudflare: { env: Env } }).cloudflare.env;
  return registerCommittedObjects(env, getDb(env.DB), PROJECT_ID, 7, pendingObjects as never);
}

function buildRouteContext() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const user = { id: 7, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: TEST_SECRET,
    DB: {},
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (req: Request) => {
          calls.push({ url: req.url, body: JSON.parse(await req.text()) as Record<string, unknown> });
          return new Response(
            JSON.stringify({
              applied: { objectInsert: 1 },
              skipped: {},
              failed: {},
              refused: {},
            }),
            { status: 200 },
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

function stubDb() {
  return {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => []) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: PROJECT_ID, github_repo_full_name: "owner/repo" } as never,
    userRole: "convenor",
  });
});

describe("registration refuses an out-of-domain object_id", () => {
  for (const [label, value] of OUT_OF_DOMAIN) {
    it(`keeps ${label} off the ingest wire and answers a failure`, async () => {
      vi.mocked(getDb).mockReturnValue(stubDb() as never);
      const { context, calls } = buildRouteContext();

      const result = (await runRegistration([pendingObject(value)], context)) as {
        ok: boolean;
        error?: string;
        insertedCount: number;
      };

      // Nothing was worth sending, so the DO is not woken at all.
      expect(calls).toHaveLength(0);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("insert_failed");
      expect(result.insertedCount).toBe(0);
    });
  }

  it("sends the valid objects and drops only the refused one", async () => {
    vi.mocked(getDb).mockReturnValue(stubDb() as never);
    const { context, calls } = buildRouteContext();

    const result = (await runRegistration([pendingObject("bell"), pendingObject([]), pendingObject("drum")], context)) as { ok: boolean; error?: string };

    expect(calls).toHaveLength(1);
    const sent = (calls[0].body as { objects: { insert: Array<Record<string, unknown>> } })
      .objects.insert;
    expect(sent.map((s) => s.object_id)).toEqual(["bell", "drum"]);
    // The refusal is still the author's answer: one of their objects did not
    // register, and the images for it are already committed to the repo.
    expect(result.ok).toBe(false);
    expect(result.error).toBe("insert_failed");
  });

  it("leaves an ordinary registration untouched", async () => {
    vi.mocked(getDb).mockReturnValue(stubDb() as never);
    const { context, calls } = buildRouteContext();

    const result = (await runRegistration([pendingObject("bell")], context)) as { ok: boolean; insertedCount: number };

    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.insertedCount).toBe(1);
  });
});

/**
 * An object deletion finishes on the server.
 *
 * `delete-object` holds the `objects` lease in both of its modes and does the
 * document half itself, before it answers: the removal goes through the
 * collaboration object's ingest by the object's D1 id, which removes the
 * Y.Map and lets the flush take the row. The page writes nothing to the
 * document: a deletion that waited on the page would leave an object deleted
 * from the repository and standing in the Compositor whenever the tab closed
 * after the answer, or a publish read D1 before the page's write.
 *
 * From the repository, the deletion is an operation with a record: a `remove`
 * record is written before the commit, a stale-head refusal deletes it, any
 * other throw leaves it prepared, a landed commit marks it committed, and the
 * ingest with the record's id finishes it. An ingest that fails after the
 * commit landed answers ok and pending, and the record finishes it later.
 *
 * A removal with no commit to wait for — from the Compositor alone, or from a
 * repository that holds nothing for the object — has a record too, written
 * straight away as committed, so the ingest carries an operation id and the
 * collaboration object verifies the removal against D1 before answering. An
 * ingest that fails, or whose outcome is unknown, answers pending with the
 * record kept: the ingest may already have changed the document. Only a
 * record that could not be written, before anything changed, answers failed.
 *
 * D1 is the repository's migration chain in memory. Most cases use a stand-in
 * collaboration object whose ingest removes the object's row, which is what
 * the real one's flush does; the cases the stand-in cannot see run against the
 * real collaboration object and its snapshot.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const OBJECT_DB_ID = 10;
const OBJECT_ID = "plano";
const CONVENOR = 7;
const CAPTURED_HEAD = "captured-head";

const events: string[] = [];
let memory: MemoryD1;
/** When set, a `pending_object_ops` INSERT persists and its answer is lost. */
let recordWriteLost = false;

/** The database, with each record INSERT run for real and its promise then rejected. */
function losingRecordWrites(): MemoryD1 {
  const lose = (sql: string) => /^insert into "pending_object_ops"/i.test(sql);
  const wrap = (statement: ReturnType<MemoryD1["prepare"]>, sql: string): ReturnType<MemoryD1["prepare"]> =>
    new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "bind") {
          return (...args: unknown[]) => wrap((value as (...a: unknown[]) => ReturnType<MemoryD1["prepare"]>).apply(target, args), sql);
        }
        if (!lose(sql)) return (value as (...a: unknown[]) => unknown).bind(target);
        return async (...args: unknown[]) => {
          await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          throw new Error("D1 answer lost");
        };
      },
    });
  return { ...memory, prepare: (sql: string) => wrap(memory.prepare(sql), sql) };
}

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
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: () => drizzle(asD1(recordWriteLost ? losingRecordWrites() : memory), { schema }) }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/upgrade-gate.server", () => ({ readRepoWriteRefusal: vi.fn(async () => null) }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
  getInstallationInfo: vi.fn(),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn(async () => true) }));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => CAPTURED_HEAD),
  getRepoTree: vi.fn(async () => ({
    tree: [{ path: "telar-content/objects/plano.jpg", mode: "100644", type: "blob", sha: "x" }],
    truncated: false,
  })),
  getFileAtRef: vi.fn(async () => ({ status: "ok", content: "object_id,title\nplano,Plano\notro,Otro\n" })),
  getFileContent: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

// Client-side deps the route module pulls in but these action cases never run.
vi.mock("~/lib/iiif-types", () => ({ deriveStatus: vi.fn() }));
vi.mock("~/lib/media-type", () => ({ detectMediaType: vi.fn(() => "image"), extractVideoId: vi.fn() }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), getYText: vi.fn() }));
vi.mock("~/components/features/objects/IiifViewer", () => ({ IiifViewer: vi.fn() }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({ CommitAndBuildModal: vi.fn() }));
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: vi.fn() }));
vi.mock("~/components/features/editor/AudioPlayer", () => ({ AudioPlayer: vi.fn() }));
vi.mock("~/components/ui/Switch", () => ({ Switch: vi.fn() }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: vi.fn() }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: vi.fn() }));

import { action } from "~/routes/_app.objects.$objectId";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { commitFilesToRepo, StaleHeadError } from "~/lib/commit.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { completePendingObjectOps } from "~/lib/pending-object-ops.server";
import * as Y from "yjs";
import { ProjectCollaborationDO } from "../workers/collaboration";
import {
  PROJECT_ID as DO_PROJECT_ID,
  SECRET,
  buildDoc,
  seedProject,
} from "./helpers/collaboration-fixture";

type IngestAnswer = (body: Record<string, unknown>) => Response;
let ingestAnswer: IngestAnswer;
const ingestBodies: Array<Record<string, unknown>> = [];

/** The collaboration object: an ingest removes the named row, as its flush does. */
function removingIngest(body: Record<string, unknown>): Response {
  const removes = (body.objects as { remove: Array<{ objectId: string; docId: number }> }).remove;
  for (const r of removes) memory.raw.prepare("DELETE FROM objects WHERE id = ?").run(r.docId);
  return Response.json({
    applied: { objectRemove: removes.length },
    removals: { applied: removes.map((r) => r.objectId), absent: [], superseded: [], course: [] },
  });
}

function context() {
  const stub = {
    fetch: async (req: Request) => {
      const body = JSON.parse(await req.text()) as Record<string, unknown>;
      ingestBodies.push(body);
      events.push(`ingest:${objectRows().length}`);
      return ingestAnswer(body);
    },
  };
  return {
    get: vi.fn(() => ({ id: CONVENOR, encrypted_access_token: "enc" })),
    cloudflare: {
      env: {
        ENCRYPTION_KEY: "k",
        SESSION_SECRET: "s",
        DB: {},
        GITHUB_APP_ID: "a",
        GITHUB_PRIVATE_KEY: "p",
        COLLABORATION: { idFromName: (n: string) => n, get: () => stub },
      },
    },
  } as never;
}

async function deleteObject(fromRepo: boolean): Promise<Record<string, unknown>> {
  const form = new URLSearchParams({
    intent: "delete-object",
    objectDbId: String(OBJECT_DB_ID),
    fromRepo: String(fromRepo),
  });
  return (await action({
    request: new Request(`https://compositor.telar.org/objects/${OBJECT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: context(),
    params: { objectId: OBJECT_ID },
  } as never)) as Record<string, unknown>;
}

type Row = { id: number; kind: string; state: string; payload: string; parent_sha: string | null; commit_sha: string | null };

function records(): Row[] {
  return memory.raw.prepare("SELECT * FROM pending_object_ops ORDER BY id").all() as Row[];
}

function objectRows(): number[] {
  return (memory.raw.prepare("SELECT id FROM objects").all() as Array<{ id: number }>).map((r) => r.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  events.length = 0;
  ingestBodies.length = 0;
  recordWriteLost = false;
  ingestAnswer = removingIngest;
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      `VALUES (${CONVENOR}, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')`,
  );
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, ${CONVENOR}, 'owner/repo', 5)`,
  );
  memory.raw.exec(
    `INSERT INTO objects (id, project_id, object_id, order_key, title, created_by) VALUES (${OBJECT_DB_ID}, ${PROJECT_ID}, '${OBJECT_ID}', 'a00001', 'Plano', ${CONVENOR})`,
  );
  memory.raw.exec(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (${PROJECT_ID}, ${CONVENOR}, 'convenor')`,
  );
  vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue({
    project: { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5 },
    userRole: "convenor",
  } as never);
  vi.mocked(controlFreezeLease).mockImplementation(async (_e, _p, _u, control) => {
    events.push(control.op === "begin" ? `lease:begin:${control.kind}` : `lease:end:${(control as { outcome?: string }).outcome}`);
    return "applied";
  });
  vi.mocked(commitFilesToRepo).mockImplementation((async () => {
    events.push(`commit:${records().map((r) => r.state).join(",")}`);
    return { newHeadSha: "sha-after-delete" };
  }) as never);
});

afterEach(() => {
  memory.close();
});

describe("both modes hold the objects lease", () => {
  it.each([true, false])("fromRepo=%s takes the lease around the deletion", async (fromRepo) => {
    const res = await deleteObject(fromRepo);
    expect(res).toMatchObject({ ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID });
    expect(events[0]).toBe("lease:begin:objects");
    expect(events.at(-1)).toBe("lease:end:succeeded");
  });

  it.each([true, false])("fromRepo=%s: a refused lease deletes nothing", async (fromRepo) => {
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");
    const res = await deleteObject(fromRepo);
    expect(res).toMatchObject({ ok: false, error: "operation_in_progress", objectDbId: OBJECT_DB_ID });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(ingestBodies).toEqual([]);
    expect(objectRows()).toEqual([OBJECT_DB_ID]);
    expect(records()).toEqual([]);
  });
});

describe("deleting from the repository", () => {
  it("writes the remove record before the commit, and removes the object from D1 before answering", async () => {
    const res = await deleteObject(true);
    expect(res).toMatchObject({ ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID });
    expect(res).not.toHaveProperty("pending", true);
    expect(events).toContain("commit:prepared");
    expect(objectRows()).toEqual([]);
    expect(records()).toEqual([]);
    expect(ingestBodies).toHaveLength(1);
    expect(ingestBodies[0]).toMatchObject({
      opId: expect.any(Number),
      objects: { remove: [{ objectId: OBJECT_ID, docId: OBJECT_DB_ID }] },
    });
  });

  it("names the object by its D1 id in the record, with the head the commit was built on", async () => {
    ingestAnswer = () => new Response("snapshot_failed", { status: 503 });
    await deleteObject(true);
    const [record] = records();
    expect(record).toMatchObject({ kind: "remove", parent_sha: CAPTURED_HEAD });
    expect(JSON.parse(record.payload)).toEqual([{ object_id: OBJECT_ID, doc_id: OBJECT_DB_ID }]);
    expect(ingestBodies[0].opId).toBe(record.id);
  });

  it("deletes the record it wrote before the commit when the head is stale", async () => {
    vi.mocked(commitFilesToRepo).mockImplementationOnce((async () => {
      events.push(`commit:${records().map((r) => r.state).join(",")}`);
      throw new StaleHeadError("moved");
    }) as never);
    const res = await deleteObject(true);
    expect(res).toMatchObject({ ok: false, error: "stale_head" });
    // The record existed when the commit was sent, and is gone after.
    expect(events).toContain("commit:prepared");
    expect(records()).toEqual([]);
    expect(ingestBodies).toEqual([]);
    expect(objectRows()).toEqual([OBJECT_DB_ID]);
  });

  it("leaves the record prepared when the commit throws, since it may have landed", async () => {
    vi.mocked(commitFilesToRepo).mockRejectedValueOnce(new Error("socket hang up"));
    const res = await deleteObject(true);
    expect(res).toMatchObject({ ok: false, error: "delete_failed" });
    expect(records()).toEqual([expect.objectContaining({ state: "prepared", commit_sha: null })]);
    expect(ingestBodies).toEqual([]);
    expect(objectRows()).toEqual([OBJECT_DB_ID]);
  });

  // A compatibility check: the delete before this change wrote no record
  // either. It pins that a refusal before the commit still writes none.
  it("writes no record when a read refuses before the commit (compatibility)", async () => {
    const { getRepoTree } = await import("~/lib/github.server");
    vi.mocked(getRepoTree).mockResolvedValueOnce({ tree: [], truncated: true });
    const res = await deleteObject(true);
    expect(res).toMatchObject({ ok: false, error: "delete_failed" });
    expect(records()).toEqual([]);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("answers ok and pending when the ingest fails after the commit landed, keeping the record committed", async () => {
    ingestAnswer = () => new Response("snapshot_failed", { status: 503 });
    const res = await deleteObject(true);
    expect(res).toMatchObject({ ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: true });
    expect(records()).toEqual([
      expect.objectContaining({ kind: "remove", state: "committed", commit_sha: "sha-after-delete" }),
    ]);
    expect(events.at(-1)).toBe("lease:end:succeeded");
  });
});

describe("deleting from the Compositor alone", () => {
  it("removes the object from D1 before answering, as a committed record's operation", async () => {
    const res = await deleteObject(false);
    expect(res).toMatchObject({ ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: false });
    expect(objectRows()).toEqual([]);
    expect(ingestBodies).toEqual([
      { opId: expect.any(Number), objects: { remove: [{ objectId: OBJECT_ID, docId: OBJECT_DB_ID }] } },
    ]);
    expect(events).toContain(`ingest:1`);
    expect(records()).toEqual([]);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("writes the record committed, with no heads, before the ingest", async () => {
    let seen: Row[] = [];
    ingestAnswer = (body) => {
      seen = records();
      return removingIngest(body);
    };
    await deleteObject(false);
    expect(seen).toEqual([
      expect.objectContaining({ kind: "remove", state: "committed", parent_sha: null, commit_sha: null }),
    ]);
    expect(JSON.parse(seen[0].payload)).toEqual([{ object_id: OBJECT_ID, doc_id: OBJECT_DB_ID }]);
    expect(ingestBodies[0].opId).toBe(seen[0].id);
  });

  // The ingest may have changed the document before its flush failed, so the
  // object may yet go: pending, with the record left to finish it.
  it("answers pending and keeps the record when the ingest fails", async () => {
    ingestAnswer = () => new Response("snapshot_failed", { status: 503 });
    const res = await deleteObject(false);
    expect(res).toMatchObject({ ok: true, objectDbId: OBJECT_DB_ID, pending: true });
    expect(records()).toEqual([expect.objectContaining({ kind: "remove", state: "committed" })]);
  });

  // A write that throws may or may not have landed, so it is not answered as
  // "nothing changed": delete_failed says what is true either way.
  it("answers delete_failed and sends nothing when the record write is refused", async () => {
    memory.raw.exec(
      "CREATE TRIGGER refuse_record BEFORE INSERT ON pending_object_ops BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const res = await deleteObject(false);
    expect(res).toMatchObject({ ok: false, error: "delete_failed", objectDbId: OBJECT_DB_ID });
    expect(ingestBodies).toEqual([]);
    expect(objectRows()).toEqual([OBJECT_DB_ID]);
    expect(events.at(-1)).toBe("lease:end:failed");
  });
});

describe("deleting from a repository that holds nothing for the object", () => {
  beforeEach(async () => {
    const github = await import("~/lib/github.server");
    vi.mocked(github.getRepoTree).mockResolvedValueOnce({ tree: [], truncated: false });
    vi.mocked(github.getFileAtRef).mockResolvedValueOnce({ status: "ok", content: "object_id,title\notro,Otro\n" });
  });

  it("makes no commit and removes the object as a committed record's operation", async () => {
    const res = await deleteObject(true);
    expect(res).toMatchObject({ ok: true, pending: false });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(ingestBodies[0]).toMatchObject({ opId: expect.any(Number) });
    expect(objectRows()).toEqual([]);
    expect(records()).toEqual([]);
  });

  it("answers pending and keeps the record when the ingest fails", async () => {
    ingestAnswer = () => new Response("snapshot_failed", { status: 503 });
    const res = await deleteObject(true);
    expect(res).toMatchObject({ ok: true, pending: true });
    expect(records()).toEqual([expect.objectContaining({ state: "committed", parent_sha: null })]);
  });

  it("answers delete_failed when the record write is refused", async () => {
    memory.raw.exec(
      "CREATE TRIGGER refuse_record BEFORE INSERT ON pending_object_ops BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const res = await deleteObject(true);
    expect(res).toMatchObject({ ok: false, error: "delete_failed" });
    expect(ingestBodies).toEqual([]);
    expect(objectRows()).toEqual([OBJECT_DB_ID]);
  });
});

// A compatibility check: the delete before this change refused it the same
// way; it pins that the refusal still comes before the lease.
describe("a course item", () => {
  it.each([true, false])("is refused as today, fromRepo=%s, before the lease (compatibility)", async (fromRepo) => {
    memory.raw.exec(`UPDATE objects SET course_project_id = ${PROJECT_ID} WHERE id = ${OBJECT_DB_ID}`);
    const res = await deleteObject(fromRepo);
    expect(res).toMatchObject({ ok: false, error: "course_item_delete_refused" });
    expect(events).toEqual([]);
    expect(objectRows()).toEqual([OBJECT_DB_ID]);
  });
});

// ---------------------------------------------------------------------------
// Against the real collaboration object
// ---------------------------------------------------------------------------

describe("the removal as the real collaboration object settles it", () => {
  let doInstance: ProjectCollaborationDO;
  let doStorage: Map<string, unknown>;

  function doContext() {
    return {
      get: vi.fn(() => ({ id: CONVENOR, encrypted_access_token: "enc" })),
      cloudflare: {
        env: {
          ENCRYPTION_KEY: "k",
          SESSION_SECRET: SECRET,
          DB: {},
          GITHUB_APP_ID: "a",
          GITHUB_PRIVATE_KEY: "p",
          COLLABORATION: { idFromName: (n: string) => n, get: () => doInstance },
        },
      },
    } as never;
  }

  async function deleteO1(fromRepo: boolean): Promise<Record<string, unknown>> {
    const form = new URLSearchParams({ intent: "delete-object", objectDbId: "1", fromRepo: String(fromRepo) });
    return (await action({
      request: new Request("https://compositor.telar.org/objects/o1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      context: doContext(),
      params: { objectId: "o1" },
    } as never)) as Record<string, unknown>;
  }

  function ydoc(): Y.Doc {
    return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  }

  beforeEach(async () => {
    memory.close();
    memory = createMemoryD1();
    seedProject(memory, "text");
    memory.raw.exec(
      `INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) ` +
        `VALUES (${CONVENOR}, ${CONVENOR}, 'u2', 'enc', 'e', '2099-01-01', '2099-01-01')`,
    );
    memory.raw.exec(
      `INSERT INTO project_members (project_id, user_id, role) VALUES (${DO_PROJECT_ID}, ${CONVENOR}, 'convenor')`,
    );
    memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(buildDoc(true), DO_PROJECT_ID);
    const storage = new Map<string, unknown>();
    doStorage = storage;
    const ctx = {
      getWebSockets: () => [] as unknown[],
      blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
      storage: {
        getAlarm: async () => null,
        setAlarm: async () => {},
        get: async (key: string) => (key === "docGeneration" ? 0 : storage.get(key)),
        put: async (key: string | Record<string, unknown>, value?: unknown) => {
          const entries = typeof key === "string" ? { [key]: value } : key;
          for (const [k, v] of Object.entries(entries)) storage.set(k, v);
        },
        list: async (options?: { prefix?: string }) =>
          new Map([...storage].filter(([k]) => k.startsWith(options?.prefix ?? ""))),
        delete: async () => 0,
      },
      acceptWebSocket: vi.fn(),
    };
    doInstance = new ProjectCollaborationDO(
      ctx as unknown as DurableObjectState,
      { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
    );
    (doInstance as unknown as { projectId: number }).projectId = DO_PROJECT_ID;
    await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
    vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue({
      project: { id: DO_PROJECT_ID, github_repo_full_name: "o/a", installation_id: 1 },
      userRole: "convenor",
    } as never);
  });

  it("removes the object as a record's operation, verified in D1, before answering", async () => {
    const res = await deleteO1(false);
    expect(res).toMatchObject({ ok: true, pending: false });
    expect(objectRows()).toEqual([]);
    expect(records()).toEqual([]);
    // The delivery carried the record's id and earned its receipt: the
    // collaboration object found the D1 row gone.
    const receipts = [...doStorage].filter(([key]) => key.startsWith("ingestReceipt:"));
    expect(receipts).toHaveLength(1);
    expect((receipts[0][1] as { removed: string[] }).removed).toEqual(["o1"]);
  });

  // Finding 1: a malformed sibling suspends the objects sweep, so the flush
  // succeeds and D1 still holds the object. The removal is not answered done.
  it("answers pending with the record kept when D1 still holds the object after the flush", async () => {
    const sibling = new Y.Map<unknown>();
    ydoc().transact(() => {
      sibling.set("_id", "not-an-id");
      sibling.set("object_id", "o2");
      ydoc().getArray<Y.Map<unknown>>("objects").push([sibling]);
    }, null);

    const res = await deleteO1(false);

    expect(objectRows()).toContain(1);
    expect(res).toMatchObject({ ok: true, pending: true });
    expect(res).not.toMatchObject({ pending: false });
    expect(records()).toEqual([expect.objectContaining({ kind: "remove", state: "committed" })]);
  });

  // Finding 2: the document lost the map before the flush, and D1 refused the
  // DELETE. The object may yet go on a later snapshot, so this is pending, not
  // failed.
  it("answers pending, not failed, when the flush cannot delete the row", async () => {
    memory.raw.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON objects BEGIN SELECT RAISE(ABORT, 'refused'); END");

    const res = await deleteO1(false);

    expect(objectRows()).toContain(1);
    expect(res).toMatchObject({ ok: true, pending: true });
    expect(records()).toEqual([expect.objectContaining({ kind: "remove", state: "committed" })]);
  });

  // Round 2's finding: the record INSERT persists and its answer is lost. The
  // outcome is unknown, so the answer is delete_failed, whose text is true
  // either way, and the record left behind finishes the removal later.
  it("answers delete_failed when the record write's answer is lost, and completion then removes the object", async () => {
    recordWriteLost = true;

    const res = await deleteO1(false);

    expect(res).toMatchObject({ ok: false, error: "delete_failed" });
    expect(records()).toEqual([expect.objectContaining({ kind: "remove", state: "committed" })]);
    expect(objectRows()).toEqual([1]);

    recordWriteLost = false;
    const env = {
      SESSION_SECRET: SECRET,
      COLLABORATION: { idFromName: (n: string) => n, get: () => doInstance },
    } as unknown as Env;
    const completion = await completePendingObjectOps(
      env, drizzle(asD1(memory), { schema }), DO_PROJECT_ID, { kind: "absent" },
    );
    expect(completion.ok).toBe(true);
    expect(objectRows()).toEqual([]);
    expect(records()).toEqual([]);
  });
});

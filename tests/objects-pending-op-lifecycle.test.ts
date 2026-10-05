/**
 * The Objects page's committing actions keep a record of their operation
 * across the commit, and finish what earlier operations left before reading
 * D1.
 *
 * `upload-image` and `commit-objects` each write objects.csv from D1 plus the
 * objects they add. A commit whose objects never reached D1 — the registration
 * failed and the tab closed — is undone by the next of them, so each one:
 *
 *   - reads objects.csv strictly at the head it will commit on, refusing a
 *     failed read rather than taking it for a missing file;
 *   - completes the project's pending operations with that sheet, inside its
 *     `objects` lease, before it reads D1, and refuses if that fails;
 *   - writes its own record `prepared` before the commit, deletes it on a
 *     stale-head refusal, leaves it prepared on any other throw, marks it
 *     committed on success, and deletes it once the registration has run.
 *
 * The modal's retry names the operation by id, takes the lease and completes
 * that operation.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
// `resolveActiveProjectFromRequest` is mocked directly (every case here
// controls the session's resolved project through it, including
// `insert-pending-objects`, which reads it without the page-site check).
// `resolvePageProject` — the gate every OTHER intent in this file goes
// through now — is rebuilt on top of that same mock, matching the real
// module's logic, since its own internal call to
// `resolveActiveProjectFromRequest` cannot be intercepted by replacing the
// export alone. `siteChangedAnswer` stays real.
vi.mock("~/lib/active-project.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/active-project.server")>();
  const resolveActiveProjectFromRequest = vi.fn();
  return {
    ...actual,
    resolveActiveProjectFromRequest,
    resolvePageProject: vi.fn(async (request: Request, env: unknown, userId: number, formData: FormData) => {
      const resolved = await resolveActiveProjectFromRequest(request, env, userId);
      if (!resolved) return { kind: "no_project" };
      if (formData.get("siteId") !== String((resolved as { project: { id: number } }).project.id)) {
        return { kind: "site_changed", currentSiteName: (resolved as { project: { github_repo_full_name: string } }).project.github_repo_full_name };
      }
      return { kind: "ok", ...(resolved as object) };
    }),
  };
});
vi.mock("~/lib/upgrade-gate.server", () => ({
  readUploadRefusal: vi.fn(async () => null),
  readRepoWriteRefusal: vi.fn(async () => null),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({ resolveProjectToken: vi.fn(async () => "inst-token") }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "head-sha"),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(async () => null),
  getFileAtRef: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHead: vi.fn(), bumpProjectHeadFrom: vi.fn(async () => true) }));
vi.mock("~/lib/sync.server", () => ({ computeSyncDiff: vi.fn(), applySyncChanges: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(async () => ({ runId: 11, htmlUrl: "u" })),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn(),
  verifySiteUrl: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/csv-export.server", () => ({
  serializeObjectsCsv: vi.fn(() => "csv-content"),
  dbObjectToCsvRow: vi.fn((o: unknown) => o),
}));
vi.mock("~/lib/upload.server", () => ({
  createImageBlobs: vi.fn(async () => []),
  commitMultipleBinaryFilesWithCsv: vi.fn(),
  arrayBufferToBase64: vi.fn(() => "base64data"),
  validateUploadFile: vi.fn(() => null),
}));
vi.mock("~/lib/slugify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/slugify")>();
  return { slugify: actual.slugify, generateUniqueObjectSlug: vi.fn(async (s: string) => s) };
});
vi.mock("~/lib/register-objects.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/register-objects.server")>();
  return {
    registerCommittedObjects: vi.fn(),
    pendingObjectsInDomain: vi.fn(actual.pendingObjectsInDomain),
  };
});
vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn(async () => "applied") }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), findYMapByIdOrTempId: vi.fn() }));

import { action } from "~/routes/_app.objects";
import { getDb } from "~/lib/db.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { getFileAtRef, getFileContent, getRepoHead } from "~/lib/github.server";
import { commitFilesToRepo, StaleHeadError } from "~/lib/commit.server";
import { commitMultipleBinaryFilesWithCsv } from "~/lib/upload.server";
import { serializeObjectsCsv } from "~/lib/csv-export.server";
import { pendingObjectsInDomain, registerCommittedObjects } from "~/lib/register-objects.server";
import {
  markPendingObjectOpCommitted,
  preparePendingObjectOp,
} from "~/lib/pending-object-ops.server";

const PROJECT_ID = 42;
const events: string[] = [];
let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

type Row = { id: number; state: string; kind: string; parent_sha: string | null; commit_sha: string | null; actor_id: number | null };

function rows(): Row[] {
  return memory.raw.prepare("SELECT * FROM pending_object_ops ORDER BY id").all() as Row[];
}

const tableName = (t: unknown) => String((t as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]);

/** The real database, with every read recorded by the table it reads. */
function recordingDb() {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "select") return value;
      return (...args: unknown[]) => {
        const query = (value as (...a: unknown[]) => { from: (t: unknown) => unknown }).apply(target, args);
        const from = query.from.bind(query);
        query.from = (table: unknown) => {
          events.push(`select:${tableName(table)}`);
          return from(table);
        };
        return query;
      };
    },
  });
}

function context(userId = 7) {
  const user = { id: userId, encrypted_access_token: "enc" };
  const env = {
    ENCRYPTION_KEY: "k",
    SESSION_SECRET: "s",
    DB: {},
    GITHUB_APP_ID: "a",
    GITHUB_PRIVATE_KEY: "p",
    COLLABORATION: { idFromName: (n: string) => n, get: () => ({}) },
  };
  return { get: vi.fn(() => user), cloudflare: { env } } as never;
}

function uploadRequest(): Request {
  const form = new FormData();
  form.set("intent", "upload-image");
  form.set("siteId", String(PROJECT_ID));
  form.append("imageFile", new File([new Uint8Array([0xff, 0xd8, 0xff])], "p.jpg", { type: "image/jpeg" }));
  form.set(
    "metadataArray",
    JSON.stringify([{ objectId: "", title: "A Title", creator: "", description: "", source: "", credit: "", period: "", year: "", altText: "" }]),
  );
  return new Request("https://compositor.telar.org/objects", { method: "POST", body: form });
}

/** `siteId` defaults to the resolved project (42); every case here that
 * changes the resolved project overrides it explicitly. */
function post(fields: Record<string, string>): Request {
  return new Request("https://compositor.telar.org/objects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ siteId: String(PROJECT_ID), ...fields }).toString(),
  });
}

const pendingOne = [{ object_id: "a-title", title: "A Title", featured: false, image_available: false }];

type Answer = {
  ok: boolean;
  error?: string;
  operationId?: number | null;
  registration?: { ok: boolean; operationId?: number | null };
};

async function run(request: Request): Promise<Answer> {
  return (await action({ request, context: context(), params: {} } as never)) as Answer;
}

const upload = () => run(uploadRequest());
const commitObjects = () =>
  run(post({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify(pendingOne) }));

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (7, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, 7, 'owner/repo', 5)`,
  );
  vi.mocked(getDb).mockReturnValue(recordingDb() as never);
  // objects.csv last read at the head these cases commit on, so the check for
  // unread object rows finds nothing and reads nothing more.
  vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue({
    project: { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5, objects_read_sha: "head-sha" },
    userRole: "convenor",
  } as never);
  vi.mocked(controlFreezeLease).mockImplementation(async (_e, _p, _u, control) => {
    events.push(control.op === "begin" ? `begin:${control.kind}` : `end:${(control as { outcome?: string }).outcome}`);
    return "applied";
  });
  vi.mocked(getRepoHead).mockImplementation(async () => {
    events.push("head");
    return "head-sha";
  });
  vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) => {
    events.push(`read:${path.split("/").pop()}`);
    return null;
  });
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref, options) => {
    events.push(`strict:${path.split("/").pop()}@${ref}:${options?.strict === true}`);
    return { status: "ok", content: "object_id,title\nold,Old\n" };
  });
  const commit = async () => {
    events.push(`commit:${rows().map((r) => r.state).join(",")}`);
    return { newHeadSha: "new-sha" };
  };
  vi.mocked(commitMultipleBinaryFilesWithCsv).mockImplementation(commit as never);
  vi.mocked(commitFilesToRepo).mockImplementation(commit as never);
  vi.mocked(registerCommittedObjects).mockImplementation(async (_e, _d, _p, _a, _o, options) => {
    events.push(`register:${options?.opId}:${rows().map((r) => r.state).join(",")}`);
    return { ok: true, insertedCount: 1, alreadyPresent: [], failed: [] };
  });
});

afterEach(() => {
  memory.close();
});

describe.each([
  ["upload-image", upload, commitMultipleBinaryFilesWithCsv],
  ["commit-objects", commitObjects, commitFilesToRepo],
] as const)("%s", (_name, act, commitMock) => {
  it("records the operation across its commit and deletes the record once registered", async () => {
    const res = await act();
    expect(res.ok).toBe(true);
    // Prepared while the commit ran; committed while the registration ran.
    expect(events).toContain("commit:prepared");
    const registered = events.find((e) => e.startsWith("register:"))!;
    const [, opId, states] = registered.split(":");
    expect(states).toBe("committed");
    expect(Number(opId)).toBeGreaterThan(0);
    expect(res.operationId).toBe(Number(opId));
    expect(res.registration?.operationId).toBe(Number(opId));
    expect(rows()).toEqual([]);
  });

  it("writes the record with the head it built on and the actor", async () => {
    vi.mocked(registerCommittedObjects).mockResolvedValueOnce({ ok: false, error: "insert_failed", retryable: true });
    const res = await act();
    expect(res).toMatchObject({ ok: true, registration: { ok: false } });
    expect(rows()).toEqual([
      expect.objectContaining({ kind: "register", state: "committed", parent_sha: "head-sha", commit_sha: "new-sha", actor_id: 7 }),
    ]);
    expect(res.operationId).toBe(rows()[0].id);
    expect(res.registration?.operationId).toBe(rows()[0].id);
  });

  it("deletes the record when the head moved, since nothing was written", async () => {
    vi.mocked(commitMock).mockRejectedValueOnce(new StaleHeadError("moved"));
    const res = await act();
    expect(res).toMatchObject({ ok: false, error: "stale_head" });
    expect(rows()).toEqual([]);
  });

  it("leaves the record prepared when the commit throws, since it may have landed", async () => {
    vi.mocked(commitMock).mockRejectedValueOnce(new Error("socket hang up"));
    const res = await act();
    expect(res.ok).toBe(false);
    expect(rows()).toEqual([expect.objectContaining({ state: "prepared", commit_sha: null })]);
    expect(registerCommittedObjects).not.toHaveBeenCalled();
  });

  it("reads objects.csv strictly at the head, and completes before reading D1", async () => {
    await act();
    const strictAt = events.indexOf("strict:objects.csv@head-sha:true");
    const opsAt = events.indexOf("select:pending_object_ops");
    const objectsAt = events.indexOf("select:objects");
    expect(events.indexOf("head")).toBeLessThan(strictAt);
    expect(strictAt).toBeGreaterThanOrEqual(0);
    expect(opsAt).toBeGreaterThan(strictAt);
    expect(objectsAt).toBeGreaterThan(opsAt);
    expect(events.indexOf("begin:objects")).toBeLessThan(opsAt);
    expect(getFileContent).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), "telar-content/spreadsheets/objects.csv", expect.anything(),
    );
    // The file it read is the one it rewrites.
    expect(vi.mocked(serializeObjectsCsv).mock.calls[0][1]).toBe("object_id,title\nold,Old\n");
  });

  it("refuses a failed read of objects.csv, committing and recording nothing", async () => {
    vi.mocked(getFileAtRef).mockResolvedValue({ status: "error" });
    const res = await act();
    expect(res.ok).toBe(false);
    expect(res.error).toBe(_name === "upload-image" ? "upload_failed" : "commit_failed");
    expect(events.some((e) => e.startsWith("commit:"))).toBe(false);
    expect(rows()).toEqual([]);
  });

  it("takes a missing objects.csv for a site with no objects yet", async () => {
    vi.mocked(getFileAtRef).mockResolvedValue({ status: "absent" });
    const res = await act();
    expect(res.ok).toBe(true);
    expect(vi.mocked(serializeObjectsCsv).mock.calls[0][1]).toBeUndefined();
  });

  it("completes an earlier operation first, with the operation's own id", async () => {
    const earlier = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", objects: [pendingOne[0] as never], parentSha: "h0", actorId: 3,
    });
    await markPendingObjectOpCommitted(db, earlier, "c0");
    const res = await act();
    expect(res.ok).toBe(true);
    const registers = events.filter((e) => e.startsWith("register:"));
    expect(registers[0]).toBe(`register:${earlier}:committed`);
    expect(events.indexOf(registers[0])).toBeLessThan(events.indexOf("select:objects"));
    expect(vi.mocked(registerCommittedObjects).mock.calls[0][3]).toBe(3);
    expect(rows()).toEqual([]);
  });

  // B4: an earlier operation whose commit landed with only some of its
  // objects in the sheet has those registered before D1 is read, so the CSV
  // written from D1 keeps them.
  it("registers the landed objects of an earlier prepared operation before reading D1", async () => {
    const earlier = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register",
      objects: [{ ...pendingOne[0], object_id: "old" } as never, { ...pendingOne[0], object_id: "late" } as never],
      parentSha: "h0", actorId: 3,
    });
    const res = await act();
    expect(res.ok).toBe(true);
    const first = vi.mocked(registerCommittedObjects).mock.calls[0];
    expect((first[4] as Array<{ object_id: string }>).map((o) => o.object_id)).toEqual(["old"]);
    expect(first[5]).toEqual({ opId: earlier });
    expect(events.indexOf(`register:${earlier}:prepared`)).toBeLessThan(events.indexOf("select:objects"));
    expect(rows().map((r) => r.id)).toEqual([earlier]);
  });

  it("refuses when an earlier operation cannot be completed, committing nothing", async () => {
    const earlier = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", objects: [pendingOne[0] as never], parentSha: "h0", actorId: 3,
    });
    await markPendingObjectOpCommitted(db, earlier, "c0");
    vi.mocked(registerCommittedObjects).mockResolvedValueOnce({ ok: false, error: "insert_failed", retryable: true });
    const res = await act();
    expect(res.ok).toBe(false);
    expect(res.error).toBe(_name === "upload-image" ? "upload_failed" : "commit_failed");
    expect(events.some((e) => e.startsWith("commit:"))).toBe(false);
    expect(events).not.toContain("select:objects");
    expect(rows().map((r) => r.id)).toEqual([earlier]);
  });
});

// B3: an object the ingest would refuse is refused before anything is
// committed, so no commit can land holding an object nothing will register.
describe("objects the ingest would refuse are refused before the commit", () => {
  it.each([
    ["a title that is not text", { title: 5 }],
    ["a featured flag that is not a boolean", { featured: "yes" }],
    ["an object_id that is not a string", { object_id: ["a"] }],
  ])("commit-objects refuses %s, committing and recording nothing", async (_name, bad) => {
    const res = await run(post({
      intent: "commit-objects",
      disableSheets: "false",
      pendingObjects: JSON.stringify([{ ...pendingOne[0], ...bad }]),
    }));
    expect(res).toMatchObject({ ok: false, error: "commit_failed" });
    expect(events.some((e) => e.startsWith("commit:"))).toBe(false);
    expect(rows()).toEqual([]);
  });

  it("upload-image refuses objects the validation rejects, committing and recording nothing", async () => {
    vi.mocked(pendingObjectsInDomain).mockReturnValueOnce(false);
    const res = await upload();
    expect(res).toMatchObject({ ok: false, error: "upload_failed" });
    expect(events.some((e) => e.startsWith("commit:"))).toBe(false);
    expect(rows()).toEqual([]);
  });

  it("upload-image validates the objects it built, as the uploader", async () => {
    await upload();
    const [objects, actorId] = vi.mocked(pendingObjectsInDomain).mock.calls[0];
    expect((objects as Array<{ object_id: string }>).map((o) => o.object_id)).toEqual(["a-title"]);
    expect(actorId).toBe(7);
  });
});

describe("the modal's retry names the operation", () => {
  function retry(fields: Record<string, string>) {
    return run(post({ intent: "insert-pending-objects", projectId: String(PROJECT_ID), ...fields }));
  }

  async function committedOp(): Promise<number> {
    const id = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", objects: [pendingOne[0] as never], parentSha: "h", actorId: 3,
    });
    await markPendingObjectOpCommitted(db, id, "c");
    return id;
  }

  it("completes that operation under the objects lease", async () => {
    const id = await committedOp();
    const res = await retry({ operationId: String(id) });
    expect(res.ok).toBe(true);
    expect(events[0]).toBe("begin:objects");
    expect(events).toContain(`register:${id}:committed`);
    expect(events.at(-1)).toBe("end:succeeded");
    expect(rows()).toEqual([]);
  });

  it("completes only that operation", async () => {
    const other = await committedOp();
    const id = await committedOp();
    await retry({ operationId: String(id) });
    expect(rows().map((r) => r.id)).toEqual([other]);
  });

  it("answers done when the operation is already gone", async () => {
    const res = await retry({ operationId: "999" });
    expect(res.ok).toBe(true);
    expect(registerCommittedObjects).not.toHaveBeenCalled();
  });

  it("answers failed and keeps the operation when its registration fails", async () => {
    const id = await committedOp();
    vi.mocked(registerCommittedObjects).mockResolvedValueOnce({ ok: false, error: "insert_failed", retryable: true });
    const res = await retry({ operationId: String(id) });
    expect(res).toMatchObject({ ok: false, error: "insert_failed" });
    expect(rows().map((r) => r.id)).toEqual([id]);
  });

  it("reads the sheet at the head for a prepared operation, and completes it when the sheet holds its objects", async () => {
    const id = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", objects: [pendingOne[0] as never], parentSha: "h", actorId: 3,
    });
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, _p, ref, options) => {
      events.push(`strict@${ref}:${options?.strict === true}`);
      return { status: "ok", content: "object_id,title\na-title,A Title\n" };
    });
    const res = await retry({ operationId: String(id) });
    expect(res.ok).toBe(true);
    expect(events).toContain("strict@head-sha:true");
    expect(rows()).toEqual([]);
  });

  it("answers failed while a prepared operation's objects are not in the sheet", async () => {
    const id = await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", objects: [pendingOne[0] as never], parentSha: "h", actorId: 3,
    });
    const res = await retry({ operationId: String(id) });
    expect(res).toMatchObject({ ok: false, error: "insert_failed" });
    expect(rows().map((r) => r.id)).toEqual([id]);
  });

  it("is refused while another operation holds the lease", async () => {
    const id = await committedOp();
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");
    const res = await retry({ operationId: String(id) });
    expect(res).toMatchObject({ ok: false, error: "operation_in_progress" });
    expect(registerCommittedObjects).not.toHaveBeenCalled();
    expect(rows().map((r) => r.id)).toEqual([id]);
  });

  // A mismatch here answers the same structured `site_changed` refusal every
  // other site-level intent gives (409, not the page's own `project_changed`
  // shape), so the run() cast below reads the DataWithResponseInit envelope
  // rather than a plain action payload.
  it("is refused when the active project is no longer the one committed to", async () => {
    const id = await committedOp();
    const res = (await action({
      request: post({ intent: "insert-pending-objects", projectId: "41", operationId: String(id) }),
      context: context(),
      params: {},
    } as never)) as { data: { ok: boolean; intent: string; error: string; currentSiteName: string }; init: { status: number } };
    expect(res.init.status).toBe(409);
    expect(res.data).toEqual({
      ok: false,
      intent: "insert-pending-objects",
      error: "site_changed",
      currentSiteName: "owner/repo",
    });
    expect(registerCommittedObjects).not.toHaveBeenCalled();
  });

  it.each([["missing", {}], ["not a number", { operationId: "abc" }], ["zero", { operationId: "0" }]])(
    "answers missing_data for an operation id that is %s",
    async (_name, fields) => {
      const res = await retry(fields as Record<string, string>);
      expect(res).toMatchObject({ ok: false, error: "missing_data" });
    },
  );

  it("does not complete another project's operation", async () => {
    memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (43, 7, 'o/b', 5)");
    const foreign = await preparePendingObjectOp(db, {
      projectId: 43, kind: "register", objects: [pendingOne[0] as never], parentSha: "h", actorId: 3,
    });
    await markPendingObjectOpCommitted(db, foreign, "c");
    const res = await retry({ operationId: String(foreign) });
    expect(res.ok).toBe(true);
    expect(registerCommittedObjects).not.toHaveBeenCalled();
    expect(rows().map((r) => r.id)).toEqual([foreign]);
  });
});

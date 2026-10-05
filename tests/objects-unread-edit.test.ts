/**
 * The Objects page's committing actions never write over a GitHub edit to
 * objects.csv the Compositor has not read.
 *
 * `upload-image` and `commit-objects` write objects.csv from D1. The project
 * records the last commit whose objects.csv object rows D1 accounts for,
 * `objects_read_sha`; each action compares GitHub's object rows at its head
 * with that commit's, refuses as `stale_head` when they differ, and advances
 * the record to the commit it made. The objects sync advances it too: the
 * apply to the commit it applied, and a check that finds nothing to bring in
 * to the commit it read. `complete-pending-objects` writes no file and is
 * never refused by the check.
 *
 * These run the real actions, the real serializer and the real record against
 * an in-memory database, over a GitHub that keeps each commit's objects.csv.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/active-project.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/active-project.server")>();
  const resolveActiveProjectFromRequest = vi.fn();
  return {
    ...actual,
    resolveActiveProjectFromRequest,
    resolvePageProject: vi.fn(async (request: Request, env: unknown, userId: number) => {
      const resolved = await resolveActiveProjectFromRequest(request, env, userId);
      return resolved ? { kind: "ok", ...(resolved as object) } : { kind: "no_project" };
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
  getRepoHead: vi.fn(),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(async () => null),
  getFileAtRef: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
// D1 is unchanged since every check here read it.
vi.mock("~/lib/synced-rows-fingerprint.server", () => ({ syncedRowsFingerprint: vi.fn(async () => "rows-as-compared") }));
vi.mock("~/lib/sync.server", () => ({
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
  computeSyncDiff: vi.fn(),
  finishPendingBeforeCheck: vi.fn(async () => {}),
  objectsBaseAt: vi.fn(async () => undefined),
  applySyncChanges: vi.fn(),
  refuseMovedObjectsBase: vi.fn(async () => {}),
  ObjectsSyncStale: class ObjectsSyncStale extends Error {},
  SyncBaseStale: class SyncBaseStale extends Error {},
  SyncEntriesRefused: class SyncEntriesRefused extends Error {},
  computeFullSyncDiff: vi.fn(),
  hasDivergentChanges: vi.fn(),
}));
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
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { commitFilesToRepo, StaleHeadError } from "~/lib/commit.server";
import { commitMultipleBinaryFilesWithCsv } from "~/lib/upload.server";
import { registerCommittedObjects } from "~/lib/register-objects.server";
import { applySyncChanges, checkRepairingLegacyIds, computeSyncDiff, finishPendingBeforeCheck, type SyncDiff } from "~/lib/sync.server";

const PROJECT_ID = 42;
const CSV_PATH = "telar-content/spreadsheets/objects.csv";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** objects.csv at each commit GitHub holds: null is no file. */
let commits: Map<string, string | null>;
let githubHead: string;
let commitCount: number;

/** A commit on GitHub, as an author makes one there. */
function githubEdit(objectsCsv: string | null): string {
  commitCount += 1;
  const sha = `gh-${commitCount}`;
  commits.set(sha, objectsCsv);
  githubHead = sha;
  return sha;
}

/** A commit the Compositor makes, compare-and-set on the head it read. */
function compositorCommit(expectedHead: string, objectsCsv: string): { newHeadSha: string } {
  if (expectedHead !== githubHead) throw new StaleHeadError("moved");
  commitCount += 1;
  const sha = `tc-${commitCount}`;
  commits.set(sha, objectsCsv);
  githubHead = sha;
  return { newHeadSha: sha };
}

function projectRow(): { head_sha: string | null; objects_read_sha: string | null } {
  return memory.raw.prepare("SELECT * FROM projects WHERE id = ?").get(PROJECT_ID) as never;
}

function objectIds(): string[] {
  return (memory.raw.prepare("SELECT object_id FROM objects WHERE project_id = ? ORDER BY object_id").all(PROJECT_ID) as Array<{ object_id: string }>)
    .map((r) => r.object_id);
}

function insertObject(objectId: string, title: string): void {
  memory.raw
    .prepare("INSERT INTO objects (project_id, object_id, title) VALUES (?, ?, ?)")
    .run(PROJECT_ID, objectId, title);
}

function context() {
  const user = { id: 7, encrypted_access_token: "enc" };
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

type Answer = { ok: boolean; intent?: string; error?: string; newHeadSha?: string };

async function run(request: Request): Promise<Answer> {
  return (await action({ request, context: context(), params: {} } as never)) as Answer;
}

function uploadRequest(title: string): Request {
  const form = new FormData();
  form.set("intent", "upload-image");
  form.set("siteId", String(PROJECT_ID));
  form.append("imageFile", new File([new Uint8Array([0xff, 0xd8, 0xff])], "p.jpg", { type: "image/jpeg" }));
  form.set(
    "metadataArray",
    JSON.stringify([{ objectId: "", title, creator: "", description: "", source: "", credit: "", period: "", year: "", altText: "" }]),
  );
  return new Request("https://compositor.telar.org/objects", { method: "POST", body: form });
}

function post(fields: Record<string, string>): Request {
  return new Request("https://compositor.telar.org/objects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ siteId: String(PROJECT_ID), ...fields }).toString(),
  });
}

const upload = (title = "Upload") => run(uploadRequest(title));
const commitObjects = (pending: unknown[] = []) =>
  run(post({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify(pending) }));

const HEADER = "object_id,title";
const START = `${HEADER}\n# One row per object\nalpha,Alpha\n`;

beforeEach(() => {
  vi.clearAllMocks();
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (7, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  commits = new Map([["gh-0", START]]);
  githubHead = "gh-0";
  commitCount = 0;
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, head_sha, objects_read_sha) VALUES (${PROJECT_ID}, 7, 'owner/repo', 5, 'gh-0', 'gh-0')`,
  );
  insertObject("alpha", "Alpha");

  vi.mocked(getDb).mockReturnValue(db as never);
  vi.mocked(resolveActiveProjectFromRequest).mockImplementation(async () => ({
    project: memory.raw.prepare("SELECT * FROM projects WHERE id = ?").get(PROJECT_ID),
    userRole: "convenor",
  }) as never);
  vi.mocked(getRepoHead).mockImplementation(async () => githubHead);
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref, options) => {
    // The Spanish name is read only where objects.csv is not there, and no commit here has it.
    if (path === "telar-content/spreadsheets/objetos.csv" && options?.strict === true) return { status: "absent" };
    if (path !== CSV_PATH || options?.strict !== true) throw new Error(`unexpected read of ${path}`);
    if (!commits.has(ref)) return { status: "error" };
    const content = commits.get(ref);
    return content == null ? { status: "absent" } : { status: "ok", content };
  });
  vi.mocked(commitMultipleBinaryFilesWithCsv).mockImplementation((async (params: { expectedHeadSha: string; csvContent: string }) =>
    compositorCommit(params.expectedHeadSha, params.csvContent)) as never);
  vi.mocked(commitFilesToRepo).mockImplementation((async (...args: unknown[]) => {
    const files = args[4] as Array<{ path: string; content: string }>;
    return compositorCommit(args[9] as string, files.find((f) => f.path === CSV_PATH)!.content);
  }) as never);
  // The document half of a landed commit: the objects reach D1.
  vi.mocked(registerCommittedObjects).mockImplementation(async (_e, _d, _p, _a, objects) => {
    for (const o of objects) insertObject(o.object_id, o.title ?? "");
    return { ok: true, insertedCount: objects.length, alreadyPresent: [], failed: [] };
  });
});

afterEach(() => {
  memory.close();
});

const csvReads = () => vi.mocked(getFileAtRef).mock.calls.filter((call) => call[3] === CSV_PATH).map((call) => call[4]);

describe("GitHub at the record", () => {
  it("uploads with one read of objects.csv, and advances the record with the head", async () => {
    const res = await upload();
    expect(res).toMatchObject({ ok: true });
    expect(csvReads()).toEqual(["gh-0"]);
    expect(projectRow()).toMatchObject({ head_sha: res.newHeadSha, objects_read_sha: res.newHeadSha });
  });
});

describe.each([
  ["upload-image", () => upload(), commitMultipleBinaryFilesWithCsv],
  ["commit-objects", () => commitObjects(), commitFilesToRepo],
] as const)("%s after GitHub moved", (name, act, commitMock) => {
  it("goes on when another file changed, and records the commit it made", async () => {
    githubEdit(START);
    const res = await act();
    expect(res).toMatchObject({ ok: true });
    // head_sha stays for the refresh or a check to cover the unread commit.
    expect(projectRow()).toEqual(expect.objectContaining({ head_sha: "gh-0", objects_read_sha: res.newHeadSha }));
  });

  it("goes on when only a comment row changed", async () => {
    githubEdit(START.replace("# One row per object", "# One row per object, ids in lowercase"));
    const res = await act();
    expect(res).toMatchObject({ ok: true });
    // The comment row it carried is GitHub's.
    expect(commits.get(res.newHeadSha!)).toContain("# One row per object, ids in lowercase");
    expect(projectRow().objects_read_sha).toBe(res.newHeadSha);
  });

  it("refuses an object row changed on GitHub as stale_head, and commits nothing", async () => {
    const edit = githubEdit(START.replace("alpha,Alpha", "alpha,Alpha (edited on GitHub)"));
    const res = await act();
    expect(res).toEqual({ ok: false, intent: name, error: "stale_head" });
    expect(commitMock).not.toHaveBeenCalled();
    expect(githubHead).toBe(edit);
    expect(commits.get(edit)).toContain("Alpha (edited on GitHub)");
    expect(projectRow()).toMatchObject({ head_sha: "gh-0", objects_read_sha: "gh-0" });
  });

  it("refuses when the record cannot be read at, as a failed read", async () => {
    githubEdit(START);
    commits.delete("gh-0");
    const res = await act();
    expect(res).toMatchObject({ ok: false, error: name === "upload-image" ? "upload_failed" : "commit_failed" });
    expect(commitMock).not.toHaveBeenCalled();
  });
});

describe("the Compositor's own commits", () => {
  it("never take an earlier upload for an unread edit", async () => {
    githubEdit(START);
    expect(await upload("First")).toMatchObject({ ok: true });
    const second = await upload("Second");
    expect(second).toMatchObject({ ok: true });
    expect(commits.get(second.newHeadSha!)).toContain("first,First");
    expect(objectIds()).toEqual(["alpha", "first", "second"]);
  });
});

describe("no record", () => {
  beforeEach(() => {
    memory.raw.prepare("UPDATE projects SET objects_read_sha = NULL WHERE id = ?").run(PROJECT_ID);
  });

  it("goes on when GitHub has no objects.csv", async () => {
    commits.set("gh-0", null);
    const res = await upload();
    expect(res).toMatchObject({ ok: true });
    expect(projectRow().objects_read_sha).toBe(res.newHeadSha);
  });

  it("refuses when GitHub has objects.csv", async () => {
    expect(await upload()).toEqual({ ok: false, intent: "upload-image", error: "stale_head" });
    expect(await commitObjects()).toEqual({ ok: false, intent: "commit-objects", error: "stale_head" });
    expect(commitMultipleBinaryFilesWithCsv).not.toHaveBeenCalled();
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });
});

function emptyDiff(headSha: string): SyncDiff {
  return {
    newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null, headSha,
  };
}

describe("the objects sync", () => {
  // The apply registers the row it brings in, so the next objects
  // commit, with nothing pending, writes it from D1.
  it("apply records the commit it applied, and the next objects commit keeps its row", async () => {
    const added = githubEdit(`${START}beta,Beta\n`);
    expect(await commitObjects()).toMatchObject({ ok: false, error: "stale_head" });

    // The apply records the commit it applied under its lease.
    vi.mocked(applySyncChanges).mockImplementation(async () => {
      insertObject("beta", "Beta");
      memory.raw.prepare("UPDATE projects SET objects_read_sha = ? WHERE id = ?").run(added, PROJECT_ID);
      return { appliedCount: 0, pendingObjects: [], updateSkipped: false, notAdded: [], readRecorded: true };
    });
    const changes = { newObjectIds: ["beta"], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [], headSha: added };
    expect(await run(post({ intent: "sync-apply", changes: JSON.stringify(changes) }))).toMatchObject({ ok: true, notAdded: [] });
    expect(projectRow().objects_read_sha).toBe(added);

    const res = await commitObjects();
    expect(res).toMatchObject({ ok: true });
    expect(commits.get(res.newHeadSha!)).toContain("beta,Beta");
    expect(objectIds()).toEqual(["alpha", "beta"]);
  });

  // A row the apply could not add is not in D1, so the commit is not read: the
  // record stays, and the next check offers the row again.
  it("apply that could not add a new row records nothing, and answers it", async () => {
    const added = githubEdit(`${START}beta,Beta\n`);
    vi.mocked(applySyncChanges).mockResolvedValue({ appliedCount: 0, pendingObjects: [], updateSkipped: false, notAdded: ["beta"] });
    const changes = { newObjectIds: ["beta"], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [], headSha: added };
    expect(await run(post({ intent: "sync-apply", changes: JSON.stringify(changes) }))).toMatchObject({ ok: true, pendingObjects: [], notAdded: ["beta"] });
    expect(projectRow().objects_read_sha).toBe("gh-0");
  });

  // An object re-created under its key since the check kept its values, so
  // GitHub's change to it is not read: the record stays, and the next commit
  // is refused until the check offers the change again.
  it("apply that skipped an update records nothing", async () => {
    const edited = githubEdit(START.replace("alpha,Alpha", "alpha,Alpha (renamed)"));
    vi.mocked(applySyncChanges).mockResolvedValue({ appliedCount: 0, pendingObjects: [], updateSkipped: true, notAdded: [] });
    const changes = {
      newObjectIds: [], changedObjectIds: ["alpha"], fieldChoices: { alpha: { title: "repo" } },
      changedDocIds: { alpha: 1 }, removedObjectIds: [], unregisteredObjectIds: [], headSha: edited,
    };
    expect(await run(post({ intent: "sync-apply", changes: JSON.stringify(changes) }))).toMatchObject({ ok: true, appliedCount: 0 });
    expect(projectRow().objects_read_sha).toBe("gh-0");
    expect(await commitObjects()).toMatchObject({ ok: false, error: "stale_head" });
  });

  it("apply that fails records nothing", async () => {
    const added = githubEdit(`${START}beta,Beta\n`);
    vi.mocked(applySyncChanges).mockRejectedValue(new Error("lease held"));
    const changes = { newObjectIds: ["beta"], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [], headSha: added };
    expect(await run(post({ intent: "sync-apply", changes: JSON.stringify(changes) }))).toMatchObject({ ok: false });
    expect(projectRow().objects_read_sha).toBe("gh-0");
  });

  it("check that finds nothing to bring in records the commit it read, and the next upload goes on", async () => {
    // A title edited on GitHub to what the Compositor already holds.
    memory.raw.prepare("UPDATE objects SET title = 'Alpha (renamed)' WHERE object_id = 'alpha'").run();
    const edit = githubEdit(START.replace("alpha,Alpha", "alpha,Alpha (renamed)"));
    expect(await upload()).toMatchObject({ ok: false, error: "stale_head" });

    vi.mocked(computeSyncDiff).mockResolvedValue(emptyDiff(edit));
    expect(await run(post({ intent: "compute-sync-diff" }))).toMatchObject({ ok: true });
    expect(projectRow().objects_read_sha).toBe(edit);

    expect(await upload()).toMatchObject({ ok: true });
  });

  // The check reads D1 after the pending object operations are finished, and
  // fails rather than show their effect as a difference.
  it("check finishes pending operations before it reads the diff, and fails when it cannot", async () => {
    vi.mocked(computeSyncDiff).mockResolvedValue(emptyDiff(githubEdit(START)));
    await run(post({ intent: "compute-sync-diff" }));
    expect(vi.mocked(finishPendingBeforeCheck).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(computeSyncDiff).mock.invocationCallOrder[0]);

    vi.mocked(computeSyncDiff).mockClear();
    vi.mocked(finishPendingBeforeCheck).mockRejectedValueOnce(new Error("lease held"));
    expect(await run(post({ intent: "compute-sync-diff" }))).toMatchObject({ ok: false, error: "sync_failed" });
    expect(computeSyncDiff).not.toHaveBeenCalled();
  });

  // Until the project's ids have been repaired, the check pairs ids an earlier
  // import stored stripped, and repairs them.
  it("check runs the legacy repair while the project's ids are unrepaired, and not after", async () => {
    const edit = githubEdit(START);
    vi.mocked(computeSyncDiff).mockResolvedValue(emptyDiff(edit));
    await run(post({ intent: "compute-sync-diff" }));
    memory.raw.prepare("UPDATE projects SET legacy_ids_repaired_at = '2026-09-30'").run();
    await run(post({ intent: "compute-sync-diff" }));
    expect(vi.mocked(checkRepairingLegacyIds).mock.calls.map((call) => (call[5] as { open: boolean }).open)).toEqual([true, false]);
  });

  it("check judges the ids against the commit D1's object rows are from", async () => {
    const edit = githubEdit(START);
    vi.mocked(computeSyncDiff).mockResolvedValue({ ...emptyDiff(edit), newObjects: [{ object_id: "x" }] } as never);
    const readSha = projectRow().objects_read_sha;
    expect(readSha).not.toBeNull();
    await run(post({ intent: "compute-sync-diff" }));
    expect((vi.mocked(checkRepairingLegacyIds).mock.calls[0][5] as { ref: string | null }).ref).toBe(readSha);
  });

  it("check that finds only unregistered image files still records the commit it read", async () => {
    const edit = githubEdit(START);
    vi.mocked(computeSyncDiff).mockResolvedValue({
      ...emptyDiff(edit),
      unregisteredFiles: [{ object_id: "loose", filename: "loose.jpg" }],
    });
    await run(post({ intent: "compute-sync-diff" }));
    expect(projectRow().objects_read_sha).toBe(edit);
  });

  it.each([
    ["a new object", { newObjects: [{ object_id: "beta" }] }],
    ["a changed object", { changedObjects: [{ object_id: "alpha" }] }],
    ["a missing object", { missingObjects: [{ object_id: "alpha" }] }],
    ["a reorder", { reordered: { order: [{ objectId: "beta", docId: 2 }, { objectId: "alpha", docId: 1 }] } }],
    // The rows the check's repair could not give GitHub's spelling.
    ["a row still stored stripped", { respelled: [{ objectId: "alpha", docId: 1, githubId: "alpha  " }] }],
  ])("check that finds %s records nothing", async (_label, found) => {
    const edit = githubEdit(`${START}beta,Beta\n`);
    vi.mocked(computeSyncDiff).mockResolvedValue({ ...emptyDiff(edit), ...(found as object) } as SyncDiff);
    await run(post({ intent: "compute-sync-diff" }));
    expect(projectRow().objects_read_sha).toBe("gh-0");
  });
});

describe("complete-pending-objects", () => {
  it("is never refused by the check, and reads objects.csv at the head alone", async () => {
    const edit = githubEdit(START.replace("alpha,Alpha", "alpha,Alpha (edited on GitHub)"));
    expect(await run(post({ intent: "complete-pending-objects" }))).toEqual({ ok: true, intent: "complete-pending-objects" });
    memory.raw.prepare("UPDATE projects SET objects_read_sha = NULL WHERE id = ?").run(PROJECT_ID);
    expect(await run(post({ intent: "complete-pending-objects" }))).toEqual({ ok: true, intent: "complete-pending-objects" });
    expect(csvReads()).toEqual([edit, edit]);
  });
});

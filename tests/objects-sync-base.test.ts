/**
 * The objects page's check compares three ways against the commit whose
 * objects.csv D1 last accounted for (`projects.objects_read_sha`), and its
 * empty-cell guard reads that base, so a value the author cleared on GitHub is
 * offered rather than read as a cell left for enrichment. With no
 * record, or a record naming a commit GitHub does not hold, the check is
 * two-way and the guard has no base. A clearing the author declines advances
 * the record to the commit read, whose cell is empty, so the next check does
 * not offer it again.
 *
 * The route, the sync and the record's advance run for real against D1 in
 * memory; GitHub answers from the case's files by ref and path, and the
 * collaboration object and the lease are faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import type { FileAtRef } from "~/lib/github.server";

const PROJECT_ID = 42;
const CONVENOR = 7;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OBJECTS = "telar-content/spreadsheets/objects.csv";

let memory: MemoryD1;
/** File text by "<ref>:<path>". */
let files: Record<string, string> = {};
let commit: "exists" | "missing" | "error" = "exists";
/** Whether the read of objects.csv at the recorded commit fails. */
let baseReadFails = false;
/** Requests the collaboration object received. */
let collaborationRequests = 0;
/** The bodies of the ingests the collaboration object received. */
let ingestBodies: unknown[] = [];
/** GitHub's head. */
let githubHead = HEAD;
/** Whether an operation holds the objects lease; a begin while one does is refused. */
let leaseHeld = false;
/** Run as a lease begin arrives; answering a result stands for the object's own answer. */
let onLeaseBegin: (() => "unavailable" | void) | null = null;
/** Run once the check has read the site's version, as a writer acting during the check. */
let onVersionRead: (() => void) | null = null;
/** Run when an ingest arrives, as a writer acting while the apply holds its lease. */
let duringIngest: (() => void | Promise<void>) | null = null;

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
vi.mock("~/lib/db.server", () => ({ getDb: () => drizzle(asD1(memory), { schema }) }));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
  siteChangedAnswer: vi.fn(),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
  getInstallationInfo: vi.fn(),
}));
vi.mock("~/lib/github.server", () => {
  const at = async (_t: string, _o: string, _r: string, path: string, ref: string): Promise<FileAtRef> => {
    if (baseReadFails && ref === BASE) return { status: "error" };
    const text = files[`${ref}:${path}`];
    return text === undefined ? { status: "absent" } : { status: "ok", content: text };
  };
  return {
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getRepoHead: vi.fn(async () => githubHead),
    getFileAtRef: vi.fn(at),
    getFileContent: vi.fn(async (t: string, o: string, r: string, path: string, ref?: string) => {
      const read = await at(t, o, r, path, ref ?? githubHead);
      return read.status === "ok" ? read.content : null;
    }),
    commitExists: vi.fn(async () => commit),
    githubHeaders: vi.fn(() => ({})),
  };
});
vi.mock("~/lib/site-version.server", async (orig) => {
  const actual = (await orig()) as typeof import("~/lib/site-version.server");
  return {
    ...actual,
    readSiteTelarVersion: vi.fn(async (...args: Parameters<typeof actual.readSiteTelarVersion>) => {
      const read = await actual.readSiteTelarVersion(...args);
      onVersionRead?.();
      return read;
    }),
  };
});
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn(async () => ({ ok: false })) }));
vi.mock("~/lib/page-site-gate.server", () => ({ gatePageSite: vi.fn() }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, control: { op: string }) => {
    if (control.op === "begin") {
      if (onLeaseBegin?.() === "unavailable") return "unavailable";
      if (leaseHeld) return "refused";
      leaseHeld = true;
    } else if (control.op === "end") {
      leaseHeld = false;
    }
    return "applied";
  }),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import { action } from "~/routes/_app.objects";
import { gatePageSite } from "~/lib/page-site-gate.server";
import type { SyncChanges, SyncDiff } from "~/lib/sync.server";
import { buildObjectsSyncPayload, emptyObjectsSyncSelections } from "~/components/features/objects/sync-selections";

function context() {
  const COLLABORATION = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (request: Request) => {
        collaborationRequests++;
        if (new URL(request.url).pathname === "/ingest-sync") {
          ingestBodies.push(await request.json());
          await duringIngest?.();
        }
        return Response.json({ applied: {} });
      },
    }),
  };
  return {
    get: vi.fn(() => ({ id: CONVENOR, encrypted_access_token: "enc" })),
    cloudflare: {
      env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {}, GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "p", COLLABORATION },
    },
  } as never;
}

function objectsReadSha(): string | null {
  return (memory.raw.prepare("SELECT objects_read_sha FROM projects WHERE id = ?").get(PROJECT_ID) as {
    objects_read_sha: string | null;
  }).objects_read_sha;
}

/** The record the page loads: D1's `objects_read_sha`, as the gate hands the route its project. */
function recordIs(sha: string | null) {
  memory.raw.prepare("UPDATE projects SET objects_read_sha = ? WHERE id = ?").run(sha, PROJECT_ID);
  const project = { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5, objects_read_sha: sha };
  vi.mocked(gatePageSite).mockResolvedValue({ refused: null, page: { project, userRole: "convenor" } } as never);
}

async function post(fields: Record<string, string>) {
  return action({
    request: new Request("https://compositor.telar.org/objects", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
    context: context(),
    params: {},
  } as never);
}

/**
 * The page's check, asserted three-way or two-way: o2, in D1 alone and from
 * the repository, is listed as missing by a two-way check, and passed over by
 * a three-way one, since the base does not hold it either.
 */
async function check(mode: "three-way" | "two-way" = "three-way"): Promise<SyncDiff> {
  const result = (await post({ intent: "compute-sync-diff" })) as { ok: boolean; diff: SyncDiff };
  expect(result.ok).toBe(true);
  expect(result.diff.missingObjects.map((o) => o.object_id)).toEqual(mode === "two-way" ? ["o2"] : []);
  expect(result.diff.suppressedEditorOnly !== undefined).toBe(mode === "three-way");
  return result.diff;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      `VALUES (${CONVENOR}, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')`,
  );
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, ${CONVENOR}, 'owner/repo', 5)`,
  );
  memory.raw.exec(
    `INSERT INTO objects (id, project_id, object_id, order_key, title, creator) VALUES (1, ${PROJECT_ID}, 'o1', 'a1', 'Old', 'Ana')`,
  );
  memory.raw.exec(
    `INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ${PROJECT_ID}, 'o2', 'a2', 'Kept', 'repo')`,
  );
  files = {
    [`${BASE}:${OBJECTS}`]: "object_id,title,creator\no1,Old,Ana\n",
    [`${HEAD}:${OBJECTS}`]: "object_id,title,creator\no1,,Ana\n",
  };
  commit = "exists";
  baseReadFails = false;
  collaborationRequests = 0;
  ingestBodies = [];
  duringIngest = null;
  githubHead = HEAD;
  leaseHeld = false;
  onLeaseBegin = null;
  onVersionRead = null;
  recordIs(BASE);
});

afterEach(() => {
  memory.close();
});

describe("the objects page's check, against the recorded base", () => {
  it("offers a title cleared on GitHub", async () => {
    const diff = await check();
    expect(diff.changedObjects).toEqual([
      expect.objectContaining({
        object_id: "o1",
        changedFields: ["title"],
        conflictFields: [],
        d1Values: { title: "Old" },
        repoValues: { title: null },
      }),
    ]);
  });

  it("leaves a cell empty at the base and on GitHub for enrichment", async () => {
    files[`${BASE}:${OBJECTS}`] = "object_id,title,creator\no1,,Ana\n";
    expect((await check()).changedObjects).toEqual([]);
  });

  it("passes the cleared cell over with no record, two-way", async () => {
    recordIs(null);
    expect((await check("two-way")).changedObjects).toEqual([]);
  });

  it("passes the cleared cell over when GitHub does not hold the recorded commit, two-way", async () => {
    delete files[`${BASE}:${OBJECTS}`];
    commit = "missing";
    expect((await check("two-way")).changedObjects).toEqual([]);
  });

  it("reads a recorded commit with no objects.csv as an empty base", async () => {
    delete files[`${BASE}:${OBJECTS}`];
    expect((await check()).changedObjects).toEqual([]);
  });

  it("refuses the check when the read at a commit GitHub holds fails", async () => {
    baseReadFails = true;
    expect(await post({ intent: "compute-sync-diff" })).toEqual({
      ok: false, intent: "compute-sync-diff", error: "sheet_unreadable", sheet: "objects.csv",
    });
  });

  it("passes the cleared cell over when the read fails at a commit GitHub does not hold, two-way", async () => {
    baseReadFails = true;
    commit = "missing";
    expect((await check("two-way")).changedObjects).toEqual([]);
  });

  it("does not list a field changed only in the Compositor, and counts it", async () => {
    memory.raw.exec("UPDATE objects SET creator = 'Edited here' WHERE id = 1");
    files[`${HEAD}:${OBJECTS}`] = "object_id,title,creator\no1,Old,Ana\n";
    const diff = await check();
    expect(diff.changedObjects).toEqual([]);
    expect(diff.suppressedEditorOnly).toBe(1);
  });
});

describe("a title cleared on GitHub where the base had two title columns", () => {
  beforeEach(() => {
    memory.raw.exec(
      `INSERT INTO objects (id, project_id, object_id, order_key, title, creator) VALUES (3, ${PROJECT_ID}, 'o3', 'a3', 'Third', 'Cy')`,
    );
    files[`${HEAD}:${OBJECTS}`] = "object_id,title,creator\no1,,Ana\no3,Third,Cy\n";
  });

  const cleared = (diff: SyncDiff) =>
    diff.changedObjects.map((o) => ({ id: o.object_id, fields: o.changedFields }));

  it("offers the clearing when only the earlier title column held the value", async () => {
    files[`${BASE}:${OBJECTS}`] = "object_id,title,Title,creator\no1,Old,,Ana\no3,,Third,Cy\n";
    expect(cleared(await check())).toEqual([{ id: "o1", fields: ["title"] }]);
  });

  it("offers the clearing when the last title column held the value", async () => {
    files[`${BASE}:${OBJECTS}`] = "object_id,title,Title,creator\no1,,Old,Ana\no3,Third,,Cy\n";
    expect(cleared(await check())).toEqual([{ id: "o1", fields: ["title"] }]);
  });

  it("defaults the clearing to GitHub's where the Compositor holds the base's value", async () => {
    files[`${BASE}:${OBJECTS}`] = "object_id,title,Title,creator\no1,Old,,Ana\no3,,Third,Cy\n";
    const [o1] = (await check()).changedObjects;
    expect(o1.repoDefaultFields).toEqual(["title"]);
  });

  it("keeps the Compositor's edit as the default when GitHub cleared the value it replaced", async () => {
    memory.raw.exec("UPDATE objects SET title = 'Edited here' WHERE id = 1");
    files[`${BASE}:${OBJECTS}`] = "object_id,title,Title,creator\no1,Old,,Ana\no3,,Third,Cy\n";
    const [o1] = (await check()).changedObjects;
    expect(o1.changedFields).toEqual(["title"]);
    expect(o1.repoDefaultFields ?? []).toEqual([]);
  });

  it("leaves a cell empty in every title column at the base for enrichment", async () => {
    files[`${BASE}:${OBJECTS}`] = "object_id,title,Title,creator\no1,,,Ana\no3,Third,Third,Cy\n";
    expect(cleared(await check())).toEqual([]);
  });
});

describe("a clearing the author declines", () => {
  it("advances the record to the commit read, and the next check does not offer it", async () => {
    expect((await check()).changedObjects.map((o) => o.object_id)).toEqual(["o1"]);

    const declined: SyncChanges = {
      newObjectIds: [],
      changedObjectIds: ["o1"],
      changedDocIds: { o1: 1 },
      fieldChoices: { o1: { title: "d1" } },
      removedObjectIds: [],
      removedDocIds: {},
      unregisteredObjectIds: [],
      headSha: HEAD,
      baseSha: BASE,
    };
    expect(await post({ intent: "sync-apply", changes: JSON.stringify(declined) })).toMatchObject({ ok: true });
    expect(objectsReadSha()).toBe(HEAD);

    recordIs(objectsReadSha());
    expect((await check()).changedObjects).toEqual([]);
  });
});

describe("an apply whose check's base has moved", () => {
  const MOVED = "c".repeat(40);

  function acceptTitle(baseSha?: string | null): SyncChanges {
    return {
      newObjectIds: [],
      changedObjectIds: ["o1"],
      changedDocIds: { o1: 1 },
      fieldChoices: { o1: { title: "repo" } },
      fieldsSeen: { o1: { title: "Old" } },
      removedObjectIds: [],
      removedDocIds: {},
      unregisteredObjectIds: [],
      headSha: HEAD,
      ...(baseSha !== undefined ? { baseSha } : {}),
    };
  }

  function objectTitle(): string | null {
    return (memory.raw.prepare("SELECT title FROM objects WHERE id = 1").get() as { title: string | null }).title;
  }

  it("is refused, and writes nothing, when objects_read_sha moved since the check", async () => {
    const diff = await check();
    expect(diff.baseSha).toBe(BASE);
    memory.raw.prepare("UPDATE projects SET objects_read_sha = ? WHERE id = ?").run(MOVED, PROJECT_ID);

    const answer = await post({ intent: "sync-apply", changes: JSON.stringify(acceptTitle(diff.baseSha)) });
    expect(answer).toEqual({ ok: false, intent: "sync-apply", error: "sync_stale" });
    expect(objectsReadSha()).toBe(MOVED);
    expect(objectTitle()).toBe("Old");
    expect(collaborationRequests).toBe(0);
  });

  it("is refused, and writes nothing, when the check names no base", async () => {
    await check();
    const answer = await post({ intent: "sync-apply", changes: JSON.stringify(acceptTitle()) });
    expect(answer).toEqual({ ok: false, intent: "sync-apply", error: "sync_stale" });
    expect(objectsReadSha()).toBe(BASE);
    expect(collaborationRequests).toBe(0);
  });

  it("names the record as the check left it, when the check advanced it", async () => {
    files[`${HEAD}:${OBJECTS}`] = files[`${BASE}:${OBJECTS}`];
    const diff = await check();
    expect(objectsReadSha()).toBe(HEAD);
    expect(diff.baseSha).toBe(HEAD);
  });

  it("is refused, and writes nothing, when a field taken from GitHub carries no value the check read", async () => {
    const diff = await check();
    const { fieldsSeen: _seen, ...unseen } = acceptTitle(diff.baseSha);
    const answer = await post({ intent: "sync-apply", changes: JSON.stringify(unseen) });
    expect(answer).toEqual({ ok: false, intent: "sync-apply", error: "sync_stale" });
    expect(objectsReadSha()).toBe(BASE);
    expect(collaborationRequests).toBe(0);
  });

  it("answers that the commit was not recorded when another writer moved the record during the apply", async () => {
    const diff = await check();
    duringIngest = () => {
      memory.raw.prepare("UPDATE projects SET objects_read_sha = ? WHERE id = ?").run(MOVED, PROJECT_ID);
    };
    const answer = await post({ intent: "sync-apply", changes: JSON.stringify(acceptTitle(diff.baseSha)) });
    expect(answer).toMatchObject({ ok: true, readNotRecorded: true });
    expect(objectsReadSha()).toBe(MOVED);
  });

  it("applies while objects_read_sha is still the check's base", async () => {
    const diff = await check();
    const answer = await post({ intent: "sync-apply", changes: JSON.stringify(acceptTitle(diff.baseSha)) });
    expect(answer).toMatchObject({ ok: true });
    expect(answer).not.toHaveProperty("readNotRecorded");
    expect(ingestBodies).toEqual([{
      objects: { update: [{ objectId: "o1", docId: 1, fields: { title: null }, seen: { title: "Old" } }], insert: [], remove: [] },
      allOrNothing: true,
    }]);
    expect(objectsReadSha()).toBe(HEAD);
  });
});

describe("a check whose only listed change is a deletion conflict", () => {
  it("applies on its defaults, records the commit reviewed, and the next check lists nothing", async () => {
    files[`${BASE}:${OBJECTS}`] = "object_id,title,creator\no1,Old,Ana\no3,Third,Ana\n";
    files[`${HEAD}:${OBJECTS}`] = "object_id,title,creator\no1,Old,Ana\no3,Third,Ana edited\n";
    const diff = await check();
    expect(diff.changedObjects).toEqual([]);
    expect(diff.newObjects).toEqual([expect.objectContaining({ object_id: "o3", deletedInCompositor: true })]);

    const kept = buildObjectsSyncPayload(diff, emptyObjectsSyncSelections());
    expect(kept.newObjectIds).toEqual([]);
    expect(await post({ intent: "sync-apply", changes: JSON.stringify(kept) })).toMatchObject({ ok: true });
    expect(objectsReadSha()).toBe(HEAD);
    expect(ingestBodies).toEqual([]);

    recordIs(objectsReadSha());
    const next = await check();
    expect(next.newObjects).toEqual([]);
    expect(next.suppressedEditorOnly).toBe(1);
  });
});

describe("a check made while an apply holds the objects lease", () => {
  // The reviewer's case: the author takes GitHub's title at HEAD; while the
  // apply writes it, GitHub moves to a commit that restores the old title, and
  // another check reads D1 holding the new one.
  it("records nothing, and the check after the apply still offers GitHub's value", async () => {
    files[`${HEAD}:${OBJECTS}`] = "object_id,title,creator\no1,New,Ana\n";
    const RESTORED = "d".repeat(40);
    files[`${RESTORED}:${OBJECTS}`] = "object_id,title,creator\no1,Old,Ana\n";
    const diff = await check();
    expect(diff.changedObjects).toMatchObject([{ object_id: "o1", changedFields: ["title"] }]);

    // The ingest writes GitHub's title; GitHub moves; another check runs
    // while the apply holds the lease, and fails rather than read D1 mid-apply.
    let concurrent: unknown;
    duringIngest = async () => {
      memory.raw.exec("UPDATE objects SET title = 'New' WHERE id = 1");
      githubHead = RESTORED;
      concurrent = await post({ intent: "compute-sync-diff" });
    };
    const chooseGitHub = buildObjectsSyncPayload(diff, emptyObjectsSyncSelections());
    expect(await post({ intent: "sync-apply", changes: JSON.stringify(chooseGitHub) })).toMatchObject({ ok: true });
    expect(concurrent).toMatchObject({ ok: false, error: "sync_failed" });

    recordIs(objectsReadSha());
    const next = await check();
    expect(next.changedObjects).toMatchObject([
      { object_id: "o1", changedFields: ["title"], d1Values: { title: "New" }, repoValues: { title: "Old" } },
    ]);
  });
});

describe("a check that finds nothing to bring in", () => {
  const RESTORED = "e".repeat(40);

  beforeEach(() => {
    // GitHub's head holds what the recorded commit holds: nothing to bring in.
    files[`${RESTORED}:${OBJECTS}`] = files[`${BASE}:${OBJECTS}`];
    githubHead = RESTORED;
  });

  // The reviewer's case: the check compares D1 while a partial apply is
  // writing it; the apply writes GitHub's title, keeps the record (a field
  // it left), and releases the lease before the check asks for it.
  it("records nothing when D1's object rows changed between its comparison and its record", async () => {
    // The check's first lease finishes pending records; the second is the record's.
    let begins = 0;
    onLeaseBegin = () => {
      if (++begins < 2) return undefined;
      onLeaseBegin = null;
      memory.raw.exec("UPDATE objects SET title = 'New' WHERE id = 1");
    };
    const diff = await check();
    expect(diff.changedObjects).toEqual([]);
    expect(objectsReadSha()).toBe(BASE);
    expect(diff.baseSha).toBe(BASE);
  });

  // The site's version decides which file is a row's image, and the check
  // read it before reading the rows; a version written after that read is
  // one the check did not compare with.
  it("records nothing when the site's version was written after the check read it", async () => {
    memory.raw.exec(`INSERT INTO project_config (project_id, telar_version) VALUES (${PROJECT_ID}, '1.7.0')`);
    onVersionRead = () => {
      onVersionRead = null;
      memory.raw.exec(`UPDATE project_config SET telar_version = '1.8.0' WHERE project_id = ${PROJECT_ID}`);
    };
    const diff = await check();
    expect(onVersionRead).toBeNull();
    expect(objectsReadSha()).toBe(BASE);
    expect(diff.baseSha).toBe(BASE);
  });

  // A freeze request that fails, or answers 5xx, is "unavailable".
  it("records nothing when the lease could not be asked for", async () => {
    onLeaseBegin = () => "unavailable";
    const diff = await check();
    expect(objectsReadSha()).toBe(BASE);
    expect(diff.baseSha).toBe(BASE);
  });

  it("records the commit it read while the lease is free and D1's rows are as compared", async () => {
    const diff = await check();
    expect(objectsReadSha()).toBe(RESTORED);
    expect(diff.baseSha).toBe(RESTORED);
  });
});

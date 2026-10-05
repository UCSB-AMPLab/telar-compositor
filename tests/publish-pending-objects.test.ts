/**
 * A publish finishes the objects operations still owed before it reads D1,
 * and it reads objects.csv strictly.
 *
 * A publish writes objects.csv from D1. An upload or objects commit whose
 * objects reached the repository but not D1 — its registration failed and the
 * tab closed — would be written out of the site by that file. So, holding the
 * publish lease and at the one head the whole publish is built on, the action
 * reads objects.csv strictly, completes the project's pending operations with
 * it, and only then snapshots and reads D1. A read that fails is not taken for
 * a missing file, which would write the sheet without its comment and
 * instruction rows: it refuses with `objects_unreadable`. A completion that fails
 * refuses with `objects_unregistered` and keeps its record.
 *
 * D1 is the repository's own migration chain in memory, the file set is the
 * real one, and the collaboration object is a stand-in that registers an
 * ingested object by writing its row, which is what the real one's flush does.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

const PROJECT_ID = 1;
const PUBLISH_SHA = "sha-at-the-start";
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";

const events: string[] = [];
let memory: MemoryD1;

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({ getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })) })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    // head_sha is the recorded head, the one the repository is at: a publish commits only on it.
    project: { id: 1, github_repo_full_name: "owner/repo", installation_id: 55, publish_snapshot: null, head_sha: "sha-at-the-start" },
    userRole: "convenor",
  })),
  requirePublishingRole: vi.fn(async () => {}),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("~/lib/upgrade.server", () => ({
  healMissingFrameworkFiles: vi.fn(async () => []),
  fetchFrameworkFilesAtVersion: vi.fn(),
}));

const { getRepoHead, getFileAtRef } = vi.hoisted(() => ({
  getRepoHead: vi.fn(),
  getFileAtRef: vi.fn(),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getRepoHead, getFileAtRef };
});

const { commitFilesToRepo, StaleHeadError } = vi.hoisted(() => {
  class StaleHeadError extends Error {}
  return { commitFilesToRepo: vi.fn(), StaleHeadError };
});
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo,
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError,
}));

const { controlFreezeLease } = vi.hoisted(() => ({ controlFreezeLease: vi.fn() }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease,
  newFreezeOperationId: () => "op-publish",
}));

const tableName = (t: unknown) => String((t as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]);

vi.mock("~/lib/db.server", () => ({
  // The real database, with every read recorded by the table it reads.
  getDb: () => {
    const db = drizzle(asD1(memory), { schema });
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
  },
}));

import { action } from "~/routes/_app.publish";
import { buildPublishFileSet } from "~/lib/publish.server";
import { ObjectsCommitUnready } from "~/lib/pending-object-ops.server";
import {
  markPendingObjectOpCommitted,
  preparePendingObjectOp,
} from "~/lib/pending-object-ops.server";

type DoAnswer = (path: string, body: Record<string, unknown> | null) => Response;
let doAnswer: DoAnswer;

/** The collaboration object: /snapshot answers 200; /ingest-sync writes each object's row. */
function defaultDo(path: string, body: Record<string, unknown> | null): Response {
  if (path.endsWith("/snapshot")) {
    events.push("snapshot");
    return new Response("OK", { status: 200 });
  }
  events.push("ingest");
  const inserts = (body?.objects as { insert?: Array<{ object_id: string; title: string }> } | undefined)?.insert ?? [];
  for (const ins of inserts) {
    memory.raw
      .prepare("INSERT INTO objects (project_id, object_id, order_key, title) VALUES (?, ?, 'a00001', ?)")
      .run(PROJECT_ID, ins.object_id, ins.title);
  }
  return Response.json({ applied: { objectInsert: inserts.length }, skipped: {}, failed: {}, refused: {} });
}

function buildContext() {
  const doStub = {
    fetch: async (req: Request) => {
      const text = await req.text();
      return doAnswer(new URL(req.url).pathname, text ? (JSON.parse(text) as Record<string, unknown>) : null);
    },
  };
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: asD1(memory),
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => doStub) },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function runPublish() {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Publish site");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", String(PROJECT_ID));
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: buildContext(),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as { ok?: boolean; error?: string };
}

/** Repository files by path; anything else is absent. */
let repoFiles: Record<string, { status: "ok"; content: string } | { status: "absent" } | { status: "error" }>;

function pending(objectId: string) {
  return {
    object_id: objectId, title: `Title ${objectId}`, featured: false, creator: null, description: null,
    source_url: null, period: null, year: null, object_type: null, subjects: null, source: null,
    credit: null, thumbnail: null, image_available: false,
  };
}

async function committedRegisterRow(objectId: string): Promise<number> {
  const db = drizzle(asD1(memory), { schema });
  const id = await preparePendingObjectOp(db, {
    projectId: PROJECT_ID, kind: "register", objects: [pending(objectId)], parentSha: "h", actorId: 1,
  });
  await markPendingObjectOpCommitted(db, id, "c");
  return id;
}

function pendingRows(): number[] {
  return (memory.raw.prepare("SELECT id FROM pending_object_ops").all() as Array<{ id: number }>).map((r) => r.id);
}

function committedFile(path: string): string | undefined {
  const files = (commitFilesToRepo.mock.calls[0] as unknown[] | undefined)?.[4] as
    | Array<{ path: string; content: string }>
    | undefined;
  return files?.find((f) => f.path === path)?.content;
}

function objectsCsvReads(): unknown[][] {
  return getFileAtRef.mock.calls.filter((call) => (call as unknown[])[3] === OBJECTS_CSV) as unknown[][];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  events.length = 0;
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(
    "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'owner/repo', 55)",
  );
  memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");
  doAnswer = defaultDo;
  repoFiles = { [OBJECTS_CSV]: { status: "ok", content: "object_id,title\n# An instruction row,\n" } };
  getRepoHead.mockImplementation(async () => {
    events.push("head");
    // A head that moves after the capture: any second read would see it.
    return getRepoHead.mock.calls.length === 1 ? PUBLISH_SHA : "sha-that-moved";
  });
  getFileAtRef.mockImplementation(async (_t: string, _o: string, _r: string, path: string) => {
    if (path === OBJECTS_CSV) events.push("read:objects.csv");
    return repoFiles[path] ?? { status: "absent" };
  });
  commitFilesToRepo.mockImplementation(async () => {
    events.push("commit");
    return { newHeadSha: "new-sha" };
  });
  controlFreezeLease.mockImplementation(async (_e: unknown, _p: unknown, _u: unknown, control: { op: string; outcome?: string }) => {
    events.push(control.op === "begin" ? "lease:begin" : `lease:end:${control.outcome}`);
    return true;
  });
});

afterEach(() => {
  memory.close();
});

describe("a publish completes what is owed before it reads D1", () => {
  it("registers a committed operation's object first, so the committed objects.csv holds it", async () => {
    const row = await committedRegisterRow("bell");

    const res = await runPublish();

    expect(res).toMatchObject({ ok: true });
    expect(events.indexOf("ingest")).toBeGreaterThan(-1);
    expect(events.indexOf("ingest")).toBeLessThan(events.indexOf("select:objects"));
    expect(committedFile(OBJECTS_CSV)).toContain("bell");
    expect(pendingRows()).not.toContain(row);
  });

  it("completes inside the publish lease, before the forced snapshot", async () => {
    await committedRegisterRow("bell");

    await runPublish();

    const ingestAt = events.indexOf("ingest");
    expect(events.indexOf("lease:begin")).toBeLessThan(ingestAt);
    expect(ingestAt).toBeLessThan(events.indexOf("snapshot"));
    expect(events.at(-1)).toBe("lease:end:succeeded");
  });

  it("makes no GitHub read for completion when there are no rows: objects.csv is read once, strictly", async () => {
    const res = await runPublish();

    expect(res).toMatchObject({ ok: true });
    expect(objectsCsvReads()).toHaveLength(1);
    expect(objectsCsvReads()[0][5]).toEqual({ strict: true });
    expect(events).not.toContain("ingest");
  });

  it("keeps the sheet's comment and instruction rows in the rewrite", async () => {
    await runPublish();

    expect(committedFile(OBJECTS_CSV)).toContain("# An instruction row");
  });

  it("publishes a site with no objects.csv and no rows as before", async () => {
    repoFiles = {};

    const res = await runPublish();

    expect(res).toMatchObject({ ok: true });
    expect(committedFile(OBJECTS_CSV)).toBeDefined();
    expect(events).not.toContain("ingest");
  });
});

describe("one publish, one head", () => {
  it("reads objects.csv, completes, builds and commits at the head captured before the snapshot", async () => {
    await committedRegisterRow("bell");

    const res = await runPublish();

    expect(res).toMatchObject({ ok: true });
    expect(getRepoHead).toHaveBeenCalledTimes(1);
    expect(events.indexOf("head")).toBeLessThan(events.indexOf("snapshot"));
    for (const call of getFileAtRef.mock.calls) expect((call as unknown[])[4]).toBe(PUBLISH_SHA);
    expect((commitFilesToRepo.mock.calls[0] as unknown[])[9]).toBe(PUBLISH_SHA);
  });

  it("refuses stale when the head moved after the capture", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new StaleHeadError("moved"));

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, error: "stale_head" });
  });
});

describe("the refusals", () => {
  it("refuses objects_unreadable when objects.csv cannot be read, committing nothing", async () => {
    repoFiles = { [OBJECTS_CSV]: { status: "error" } };

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, error: "objects_unreadable", projectId: PROJECT_ID });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(events).not.toContain("snapshot");
    expect(events.at(-1)).toBe("lease:end:failed");
  });

  it("refuses objects_unregistered when completion fails, committing nothing and keeping the record", async () => {
    const row = await committedRegisterRow("bell");
    doAnswer = (path, body) =>
      path.endsWith("/ingest-sync") ? new Response("snapshot_failed", { status: 503 }) : defaultDo(path, body);

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, error: "objects_unregistered", projectId: PROJECT_ID });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(pendingRows()).toEqual([row]);
    expect(events.at(-1)).toBe("lease:end:failed");
  });
});

describe("the refusals when a step throws rather than answering a failure", () => {
  it("refuses objects_unreadable when the read of objects.csv throws", async () => {
    getFileAtRef.mockImplementationOnce(async () => {
      throw new Error("network");
    });

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, error: "objects_unreadable", projectId: PROJECT_ID });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("lease:end:failed");
  });

  it("refuses objects_unregistered when completion throws, committing nothing", async () => {
    await committedRegisterRow("bell");
    // The pending-row read fails outright: D1 answers an error, not rows.
    memory.raw.exec("ALTER TABLE pending_object_ops RENAME TO pending_object_ops_gone");

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, error: "objects_unregistered", projectId: PROJECT_ID });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("lease:end:failed");
  });
});

describe("the file set's own read of objects.csv", () => {
  // A caller that hands no sheet down is read for strictly, and a failed read
  // refuses rather than writing the sheet as though it had no rows to keep.
  it("refuses a failed read rather than taking it for a missing file", async () => {
    repoFiles = { [OBJECTS_CSV]: { status: "error" } };
    const env = buildContext().cloudflare.env as unknown as Env;

    await expect(
      buildPublishFileSet({ token: "t", owner: "owner", repo: "repo", ref: PUBLISH_SHA, projectId: PROJECT_ID, env }),
    ).rejects.toBeInstanceOf(ObjectsCommitUnready);
    expect(objectsCsvReads()[0][5]).toEqual({ strict: true });
  });
});

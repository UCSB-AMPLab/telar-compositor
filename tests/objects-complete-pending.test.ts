/**
 * The Objects page finishes the objects operations still owed.
 *
 * Objects whose registration failed after the tab closed stay out of the list
 * until the next publish, and an author who does not see them may upload the
 * same images again. So the loader counts the project's pending records, and
 * reads and writes nothing else for it; a publisher's page with a non-zero
 * count posts one `complete-pending-objects`; and the action, holding the
 * `objects` lease, reads objects.csv strictly at the head and completes the
 * records. It is silent: a refused lease or a failure leaves the records for
 * the next publish, upload or visit. The role is checked on the server.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
// `~/lib/active-project.server` stays real: the loader's
// `resolveActiveProjectFromRequest` and the action's `resolvePageProject`
// both run through it, and the page-site check inside `resolvePageProject`
// is the thing under test — a stub of the module would bypass it. What is
// mocked is what it delegates to: the session read and the membership
// lookup.
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 42) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({ resolveActiveProject: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({ resolveProjectToken: vi.fn(async () => "inst-token") }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "head-sha"),
  getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
  getFileContent: vi.fn(async () => null),
  getFileAtRef: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), findYMapByIdOrTempId: vi.fn() }));

import { action, loader } from "~/routes/_app.objects";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { getFileAtRef } from "~/lib/github.server";
import { markPendingObjectOpCommitted, preparePendingObjectOp } from "~/lib/pending-object-ops.server";

const PROJECT_ID = 42;
const events: string[] = [];
let memory: MemoryD1;
let ingestAnswer: (body: Record<string, unknown>) => Response;

function records(): number[] {
  return (memory.raw.prepare("SELECT id FROM pending_object_ops ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

function objectIds(): string[] {
  return (memory.raw.prepare("SELECT object_id FROM objects ORDER BY id").all() as Array<{ object_id: string }>).map((r) => r.object_id);
}

/** Registers each ingested object by writing its row, as the real flush does. */
function registeringIngest(body: Record<string, unknown>): Response {
  const inserts = (body.objects as { insert?: Array<{ object_id: string; title: string }> }).insert ?? [];
  for (const ins of inserts) {
    memory.raw
      .prepare("INSERT INTO objects (project_id, object_id, order_key, title) VALUES (?, ?, 'a00001', ?)")
      .run(PROJECT_ID, ins.object_id, ins.title);
  }
  return Response.json({ applied: { objectInsert: inserts.length } });
}

function context() {
  const stub = {
    fetch: async (req: Request) => {
      events.push("ingest");
      return ingestAnswer(JSON.parse(await req.text()) as Record<string, unknown>);
    },
  };
  return {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc" })),
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

function asRole(userRole: string) {
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5 },
    userRole,
  } as never);
}

async function complete(): Promise<Record<string, unknown>> {
  return (await action({
    request: new Request("https://compositor.telar.org/objects", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "complete-pending-objects", siteId: String(PROJECT_ID) }).toString(),
    }),
    context: context(),
    params: {},
  } as never)) as Record<string, unknown>;
}

async function committedRegisterRow(objectId: string): Promise<number> {
  const db = drizzle(asD1(memory), { schema });
  const id = await preparePendingObjectOp(db, {
    projectId: PROJECT_ID,
    kind: "register",
    objects: [{
      object_id: objectId, title: objectId, featured: false, creator: null, description: null,
      source_url: null, period: null, year: null, object_type: null, subjects: null, source: null,
      credit: null, thumbnail: null, image_available: false,
    }],
    parentSha: "h",
    actorId: 7,
  });
  await markPendingObjectOpCommitted(db, id, "c");
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  events.length = 0;
  ingestAnswer = registeringIngest;
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (7, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, 7, 'owner/repo', 5)`,
  );
  vi.mocked(getDb).mockImplementation(() => drizzle(asD1(memory), { schema }) as never);
  vi.mocked(getFileAtRef).mockResolvedValue({ status: "ok", content: "object_id,title\n" });
  vi.mocked(controlFreezeLease).mockImplementation(async (_e, _p, _u, control) => {
    events.push(control.op === "begin" ? `lease:begin:${control.kind}` : `lease:end:${(control as { outcome?: string }).outcome}`);
    return "applied";
  });
  asRole("convenor");
});

afterEach(() => {
  memory.close();
});

describe("the loader counts the pending records", () => {
  it("reports how many there are, and reads GitHub for none of it and writes nothing", async () => {
    await committedRegisterRow("bell");
    await committedRegisterRow("drum");

    const data = (await loader({
      request: new Request("https://compositor.telar.org/objects"),
      context: context(),
      params: {},
    } as never)) as { pendingObjectOps: number };

    expect(data.pendingObjectOps).toBe(2);
    expect(records()).toHaveLength(2);
    expect(getFileAtRef).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("complete-pending-objects", () => {
  it("completes a committed register record under the objects lease", async () => {
    await committedRegisterRow("bell");

    const res = await complete();

    expect(res).toMatchObject({ ok: true, intent: "complete-pending-objects" });
    expect(events).toEqual(["lease:begin:objects", "ingest", "lease:end:succeeded"]);
    expect(vi.mocked(getFileAtRef).mock.calls[0].slice(3)).toEqual([
      "telar-content/spreadsheets/objects.csv", "head-sha", { strict: true },
    ]);
    expect(objectIds()).toEqual(["bell"]);
    expect(records()).toEqual([]);
  });

  it("is silent under a lease someone else holds, and keeps the records", async () => {
    const id = await committedRegisterRow("bell");
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");

    const res = await complete();

    expect(res).toMatchObject({ ok: false, intent: "complete-pending-objects" });
    expect(res).not.toHaveProperty("error");
    expect(events).not.toContain("ingest");
    expect(records()).toEqual([id]);
  });

  it("is silent when completion fails, and keeps the records", async () => {
    const id = await committedRegisterRow("bell");
    ingestAnswer = () => new Response("snapshot_failed", { status: 503 });

    const res = await complete();

    expect(res).toMatchObject({ ok: false, intent: "complete-pending-objects" });
    expect(res).not.toHaveProperty("error");
    expect(records()).toEqual([id]);
  });

  it("refuses someone without a publishing role, taking no lease and completing nothing", async () => {
    const id = await committedRegisterRow("bell");
    asRole("viewer");

    const res = await complete();

    expect(res).toMatchObject({ ok: false, error: "forbidden" });
    expect(events).toEqual([]);
    expect(records()).toEqual([id]);
  });
});

/**
 * The objects sync and the full sync finish the project's pending object
 * operations at the head they apply, inside the `objects` lease and before
 * they compare GitHub's rows with D1's.
 *
 * A committed removal whose document half has not run leaves D1 holding an
 * object the sheet no longer has. Without completion the sync reads that as a
 * difference and flags the row `missing_from_repo`; with it the removal runs
 * first, the record goes, and the sync finds nothing to flag.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

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
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(async () => HEAD),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import { applyFullSyncChanges, applySyncChanges, finishPendingBeforeCheck, ObjectsSyncStale, SyncBaseStale, type FullSyncChanges, type SyncChanges } from "~/lib/sync.server";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { markPendingObjectOpCommitted, preparePendingObjectOp } from "~/lib/pending-object-ops.server";
import { PROJECT_ID, SECRET, seedProject } from "./helpers/collaboration-fixture";
import { withChoicesSeen } from "./helpers/object-update-seen";

const HEAD = "c".repeat(40);
const USER = 1;
let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
const bodies: Array<Record<string, unknown>> = [];

function flags(): Array<[number, number]> {
  return (memory.raw.prepare("SELECT id, missing_from_repo FROM objects ORDER BY id").all() as Array<{ id: number; missing_from_repo: number }>)
    .map((r) => [r.id, r.missing_from_repo]);
}

function removalsSent(): number {
  return bodies.filter((b) => ((b.objects as { remove?: unknown[] } | undefined)?.remove ?? []).length > 0).length;
}

function records(): number {
  return (memory.raw.prepare("SELECT COUNT(*) AS n FROM pending_object_ops").get() as { n: number }).n;
}

/** The document's removal, as its flush does it: the row leaves D1. */
function env(): Env {
  return {
    SESSION_SECRET: SECRET,
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          const body = JSON.parse(await req.text()) as { objects?: { remove?: Array<{ docId: number }> } };
          bodies.push(body);
          for (const r of body.objects?.remove ?? []) memory.raw.prepare("DELETE FROM objects WHERE id = ?").run(r.docId);
          // A registration, as the flush lands it: the row arrives with the repo as origin.
          for (const i of (body.objects as { insert?: Array<{ object_id: string }> } | undefined)?.insert ?? []) {
            memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (${50 + Number(i.object_id.slice(1))}, ${PROJECT_ID}, '${i.object_id}', 'a000${i.object_id}', 'New', 'repo')`);
          }
          return Response.json({ applied: {} });
        },
      }),
    },
  } as unknown as Env;
}

async function landedRemovalOfO1(): Promise<void> {
  const id = await preparePendingObjectOp(db, {
    projectId: PROJECT_ID, kind: "remove", targets: [{ object_id: "o1", doc_id: 1 } as never], parentSha: "h0", actorId: USER,
  });
  await markPendingObjectOpCommitted(db, id, HEAD);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  bodies.length = 0;
  memory = createMemoryD1();
  seedProject(memory, "text");
  memory.raw.exec("UPDATE objects SET origin = 'repo' WHERE id = 1");
  db = drizzle(asD1(memory), { schema });
  // The sheet the removal's commit wrote: no o1.
  vi.mocked(getFileAtRef).mockImplementation(async () => ({ status: "ok", content: "object_id,title\n" }));
});

afterEach(() => memory.close());

describe("the syncs finish pending records first", () => {
  it("applySyncChanges runs a landed removal before it compares, so the row is not read as missing", async () => {
    await landedRemovalOfO1();
    const changes: SyncChanges = withChoicesSeen({
      newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: ["o1"], removedDocIds: { o1: 1 },
      unregisteredObjectIds: [], headSha: HEAD,
    });

    await applySyncChanges(PROJECT_ID, changes, "tok", "owner", "repo", db, env(), USER);

    expect(bodies[0]).toMatchObject({ objects: { remove: [{ objectId: "o1", docId: 1 }] } });
    // The author's own removal of o1 finds the row already gone: only the
    // record's removal is sent. Completion after the comparison sends both.
    expect(removalsSent()).toBe(1);
    expect(flags()).toEqual([]);
    expect(records()).toBe(0);
  });

  it("applyFullSyncChanges runs a landed removal before it compares, so the row is not read as missing", async () => {
    await landedRemovalOfO1();
    const changes: FullSyncChanges = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: ["o1"], removedDocIds: { o1: 1 }, unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
      projectId: PROJECT_ID,
      baseSha: null,
    };

    await applyFullSyncChanges(PROJECT_ID, changes, "tok", "owner", "repo", db, USER, env());

    expect(bodies[0]).toMatchObject({ objects: { remove: [{ objectId: "o1", docId: 1 }] } });
    // The author's own removal of o1 finds the row already gone: only the
    // record's removal is sent. Completion after the comparison sends both.
    expect(removalsSent()).toBe(1);
    expect(flags()).toEqual([]);
    expect(records()).toBe(0);
  });
});

describe("a record is judged at GitHub's head now", () => {
  const H1 = "d".repeat(40);

  async function preparedRegistration(ids: string[], ageMs = 2 * 60 * 60 * 1000): Promise<void> {
    await preparePendingObjectOp(db, {
      projectId: PROJECT_ID, kind: "register", parentSha: HEAD, actorId: USER,
      now: new Date(Date.now() - ageMs),
      objects: ids.map((object_id) => ({ object_id, title: "New", featured: false, creator: null, description: null,
        source_url: null, period: null, year: null, object_type: null, subjects: null, source: null, credit: null,
        thumbnail: null, image_available: false }) as never),
    });
  }

  beforeEach(() => {
    // GitHub moved on to H1, where the registration's commit holds o9.
    vi.mocked(getRepoHead).mockResolvedValue(H1);
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, _p, ref) => ({
      status: "ok", content: ref === H1 ? "object_id,title\no1,One\no9,Nine\n" : "object_id,title\no1,One\n",
    }));
  });

  it("refuses a check made at an older head once completion has registered an object, and flags nothing missing", async () => {
    await preparedRegistration(["o9"]);
    const changes: FullSyncChanges = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [], headSha: HEAD } as never,
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
      projectId: PROJECT_ID,
      baseSha: null,
      headSha: HEAD,
    } as never;

    await expect(applyFullSyncChanges(PROJECT_ID, changes, "tok", "owner", "repo", db, USER, env()))
      .rejects.toBeInstanceOf(SyncBaseStale);

    // Registered at H1, and not compared against H0, where it is absent.
    expect(JSON.stringify(bodies)).toContain('"o9"');
    expect(memory.raw.prepare("SELECT missing_from_repo FROM objects WHERE object_id = 'o9'").get()).toEqual({ missing_from_repo: 0 });
  });

  const fullChangesAtH0 = (): FullSyncChanges => ({
    objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [], headSha: HEAD },
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    projectId: PROJECT_ID,
    baseSha: null,
    headSha: HEAD,
  }) as never;

  // o9 and o10 landed together; a later commit removed o10, so o10 stays held
  // and the record is kept after o9 is applied.
  async function keptAfterApplyingO9(): Promise<void> {
    await preparedRegistration(["o9", "o10"], 0);
    vi.mocked(getFileAtRef).mockImplementation(async () => ({ status: "ok", content: "object_id,title\no1,One\no9,Nine\n" }));
  }
  const o9Flag = () => memory.raw.prepare("SELECT missing_from_repo FROM objects WHERE object_id = 'o9'").get();

  it("refuses a check at an older head when completion applied only part of a record, which it keeps", async () => {
    await keptAfterApplyingO9();

    await expect(applyFullSyncChanges(PROJECT_ID, fullChangesAtH0(), "tok", "owner", "repo", db, USER, env()))
      .rejects.toBeInstanceOf(SyncBaseStale);

    expect(o9Flag()).toEqual({ missing_from_repo: 0 });
    expect(records()).toBe(1);
  });

  it("applySyncChanges refuses with ObjectsSyncStale when GitHub moved on after its head check", async () => {
    await preparedRegistration(["o9"]);
    // The head check sees the check's head; completion then finds GitHub at H1.
    vi.mocked(getRepoHead).mockResolvedValueOnce(HEAD);
    const changes: SyncChanges = withChoicesSeen({
      newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [], headSha: HEAD,
    });

    await expect(applySyncChanges(PROJECT_ID, changes, "tok", "owner", "repo", db, env(), USER))
      .rejects.toBeInstanceOf(ObjectsSyncStale);

    expect(o9Flag()).toEqual({ missing_from_repo: 0 });
  });

  it("the check finishes a pending record before it reads D1, under the objects lease", async () => {
    await landedRemovalOfO1();
    vi.mocked(getFileAtRef).mockImplementation(async () => ({ status: "ok", content: "object_id,title\n" }));

    await finishPendingBeforeCheck(env(), db, PROJECT_ID, USER, { token: "tok", owner: "owner", repo: "repo" });

    expect(removalsSent()).toBe(1);
    expect(records()).toBe(0);
    expect(flags()).toEqual([]);
  });
});

describe("a check that cannot finish pending records fails", () => {
  it("fails when the objects lease is held elsewhere", async () => {
    const { controlFreezeLease } = await import("~/lib/freeze-lease.server");
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");
    await expect(finishPendingBeforeCheck(env(), db, PROJECT_ID, USER, { token: "t", owner: "o", repo: "r" })).rejects.toThrow(/lease/);
  });

  it("fails when a record cannot be finished", async () => {
    await landedRemovalOfO1();
    const failing = { ...env(), COLLABORATION: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("no", { status: 500 }) }) } } as unknown as Env;
    await expect(finishPendingBeforeCheck(failing, db, PROJECT_ID, USER, { token: "t", owner: "o", repo: "r" })).rejects.toThrow(/could not be completed/);
  });
});

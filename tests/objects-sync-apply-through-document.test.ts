/**
 * The objects sync apply goes through the document, and the three objects
 * sync readers read objects.csv strictly at one head.
 *
 * `applySyncChanges` wrote accepted field changes to D1 directly and deleted
 * removed objects from D1 directly, then echoed the removed ids for the page
 * to delete from its document. A warm document then wrote its own stale
 * values back over the accepted fields on its next snapshot, and a page that was not synced when the answer landed removed
 * nothing, so the next snapshot re-inserted each removed object. Now the
 * apply holds the `objects` lease and sends the accepted field changes and the
 * removals in one ingest; removals name the object's D1 id, only for objects
 * still absent from the sheet it has just read and never for a course item;
 * `missing_from_repo`, which only D1 holds, is written directly once the
 * ingest has answered; and a failed ingest claims nothing.
 *
 * Each reader resolves the head once and reads objects.csv strictly and the
 * tree at it. A failed read refuses rather than reading as a site with no
 * objects, which would offer every object D1 holds as removed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as Y from "yjs";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1, beforeObjectIdentityIndex } from "./helpers/d1-memory";

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
    getRepoHead: vi.fn(),
    getRepoTree: vi.fn(),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import {
  applySyncChanges,
  computeSyncDiff,
  resolveFullSyncPayload,
  type SyncChanges,
} from "~/lib/sync.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { PROJECT_ID, SECRET, buildDoc, seedProject } from "./helpers/collaboration-fixture";
import { readSeenFrom, withChoicesSeen } from "./helpers/object-update-seen";

const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const USER = 1;

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
const events: string[] = [];
let sheet: { status: "ok"; content: string } | { status: "absent" } | { status: "error" };

function objectRows(): Array<{ id: number; object_id: string; title: string | null; missing_from_repo: number }> {
  return memory.raw.prepare("SELECT id, object_id, title, missing_from_repo FROM objects ORDER BY id").all() as never;
}

function addObject(id: number, objectId: string, title: string, extra = ""): void {
  memory.raw.exec(
    `INSERT INTO objects (id, project_id, object_id, order_key, title${extra ? ", course_project_id" : ""}) ` +
      `VALUES (${id}, ${PROJECT_ID}, '${objectId}', 'a0000${id}', '${title}'${extra ? `, ${extra}` : ""})`,
  );
}

function changes(overrides: Partial<SyncChanges> = {}): SyncChanges {
  return withChoicesSeen({
    newObjectIds: [],
    changedObjectIds: [],
    fieldChoices: {},
    removedObjectIds: [],
    unregisteredObjectIds: [],
    headSha: HEAD,
    ...overrides,
  });
}

/** A collaboration binding whose ingest is recorded and answered by `answer`. */
function standInEnv(answer: () => Response = () => Response.json({ applied: {} })) {
  const bodies: Array<Record<string, unknown>> = [];
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          events.push("ingest");
          bodies.push(JSON.parse(await req.text()) as Record<string, unknown>);
          return answer();
        },
      }),
    },
  } as unknown as Env;
  return { env, bodies };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  events.length = 0;
  readSeenFrom(null);
  memory = createMemoryD1();
  seedProject(memory, "text");
  db = drizzle(asD1(memory), { schema });
  sheet = { status: "ok", content: "object_id,title\no1,Repo title\n" };
  vi.mocked(getRepoHead).mockImplementation(async () => {
    events.push("head");
    return HEAD;
  });
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref, options) => {
    events.push(`read:${path.split("/").pop()}@${ref}:${options?.strict === true}`);
    return path === OBJECTS_CSV ? sheet : { status: "absent" };
  });
  vi.mocked(getRepoTree).mockImplementation(async (_t, _o, _r, ref) => {
    events.push(`tree@${ref}`);
    return { tree: [], truncated: false };
  });
  vi.mocked(controlFreezeLease).mockImplementation(async (_e, _p, _u, control) => {
    events.push(control.op === "begin" ? `lease:begin:${control.kind}` : `lease:end:${(control as { outcome?: string }).outcome}`);
    return "applied";
  });
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// The apply
// ---------------------------------------------------------------------------



describe("applySyncChanges goes through the document", () => {
  it("sends the accepted fields and the removals in one ingest, by D1 id, and writes neither to D1", async () => {
    addObject(2, "o2", "Gone from the repo");
    const { env, bodies } = standInEnv();

    const res = await applySyncChanges(
      PROJECT_ID,
      changes({
        changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } },
        removedObjectIds: ["o2"], removedDocIds: { o2: 2 },
      }),
      "tok", "owner", "repo", db, env, USER,
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      objects: {
        update: [{ objectId: "o1", fields: { title: "Repo title" } }],
        remove: [{ objectId: "o2", docId: 2 }],
      },
    });
    // D1 is the snapshot's to write: the apply changes no content row itself.
    expect(objectRows().find((r) => r.object_id === "o1")?.title).toBe("objects.title as D1 holds it");
    expect(objectRows().map((r) => r.object_id)).toContain("o2");
    expect(res).not.toHaveProperty("removedObjectIds");
    expect(res.appliedCount).toBe(2);
  });

  it("does not remove an object that is back in the sheet it has just read", async () => {
    const { env, bodies } = standInEnv();

    await applySyncChanges(
      PROJECT_ID, changes({ removedObjectIds: ["o1"], removedDocIds: { o1: 1 } }),
      "tok", "owner", "repo", db, env, USER,
    );

    expect(bodies).toEqual([]);
    // Neither half: no removal sent, and no D1 delete of its own.
    expect(objectRows().map((r) => r.id)).toEqual([1]);
  });

  // The author accepted the removal of the object they were shown. One
  // re-created under the same key since the check is someone else.
  it("does not remove an object whose D1 id is not the one the author was shown", async () => {
    const { env, bodies } = standInEnv();
    sheet = { status: "ok", content: "object_id,title\n" };

    await applySyncChanges(
      PROJECT_ID, changes({ removedObjectIds: ["o1"], removedDocIds: { o1: 99 } }),
      "tok", "owner", "repo", db, env, USER,
    );

    expect(bodies).toEqual([]);
  });

  it("removes nothing for a choice that names no D1 id", async () => {
    const { env, bodies } = standInEnv();
    sheet = { status: "ok", content: "object_id,title\n" };

    await applySyncChanges(PROJECT_ID, changes({ removedObjectIds: ["o1"] }), "tok", "owner", "repo", db, env, USER);

    expect(bodies).toEqual([]);
    expect(objectRows().map((r) => r.id)).toEqual([1]);
  });

  // D1 has no unique index on (project_id, object_id), so two rows can share a
  // key. The removal is chosen by the row's identity, not by whichever row a
  // lookup by key happens to keep.
  it("removes the row the author was shown when another row shares its key", async () => {
    memory.raw.exec("UPDATE objects SET origin = 'repo' WHERE id = 1");
    beforeObjectIdentityIndex(memory);
    memory.raw.exec(
      `INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ${PROJECT_ID}, 'o1', 'a00002', 'Twin', 'compositor')`,
    );
    sheet = { status: "ok", content: "object_id,title\n" };
    // The stand-in removes the named row, as the real object's flush does.
    const { env, bodies } = standInEnv(() => {
      const { remove } = (bodies.at(-1) as { objects: { remove: Array<{ docId: number }> } }).objects;
      for (const r of remove) memory.raw.prepare("DELETE FROM objects WHERE id = ?").run(r.docId);
      return Response.json({ applied: {} });
    });

    await applySyncChanges(
      PROJECT_ID, changes({ removedObjectIds: ["o1"], removedDocIds: { o1: 1 } }),
      "tok", "owner", "repo", db, env, USER,
    );

    expect(bodies[0]).toMatchObject({ objects: { remove: [{ objectId: "o1", docId: 1 }] } });
    expect(objectRows().map((r) => r.id)).toEqual([2]);
  });

  it("decides and writes missing_from_repo per row, not per key", async () => {
    memory.raw.exec("UPDATE objects SET origin = 'repo' WHERE id = 1");
    beforeObjectIdentityIndex(memory);
    memory.raw.exec(
      `INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ${PROJECT_ID}, 'o1', 'a00002', 'Twin', 'compositor')`,
    );
    sheet = { status: "ok", content: "object_id,title\n" };
    const { env } = standInEnv();

    await applySyncChanges(PROJECT_ID, changes(), "tok", "owner", "repo", db, env, USER);

    // The repo row is absent from the repo and flagged; the compositor row is
    // not a repo object and is not.
    expect(objectRows().map((r) => [r.id, r.missing_from_repo])).toEqual([[1, 1], [2, 0]]);
  });

  // A compatibility check: the apply before this change exempted course items
  // the same way.
  it("does not remove a course item (compatibility)", async () => {
    addObject(2, "o2", "Course item", "1");
    const { env, bodies } = standInEnv();

    await applySyncChanges(
      PROJECT_ID, changes({ removedObjectIds: ["o2"], removedDocIds: { o2: 2 } }),
      "tok", "owner", "repo", db, env, USER,
    );

    expect(bodies).toEqual([]);
  });

  it("flags missing_from_repo in D1 only once the ingest has answered", async () => {
    addObject(2, "o2", "Gone from the repo");
    memory.raw.exec("UPDATE objects SET origin = 'repo'");
    let flagAtIngest: number | undefined;
    const { env, bodies } = standInEnv(() => {
      flagAtIngest = objectRows().find((r) => r.object_id === "o2")?.missing_from_repo;
      return Response.json({ applied: {} });
    });

    await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } } }),
      "tok", "owner", "repo", db, env, USER,
    );

    expect(bodies).toHaveLength(1);
    expect(flagAtIngest).toBe(0);
    expect(objectRows().find((r) => r.object_id === "o2")?.missing_from_repo).toBe(1);
  });

  it("claims nothing when the ingest fails", async () => {
    addObject(2, "o2", "Gone from the repo");
    memory.raw.exec("UPDATE objects SET origin = 'repo'");
    const { env } = standInEnv(() => new Response("snapshot_failed", { status: 503 }));

    await expect(
      applySyncChanges(
        PROJECT_ID,
        changes({
          changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } },
          removedObjectIds: ["o2"], removedDocIds: { o2: 2 },
        }),
        "tok", "owner", "repo", db, env, USER,
      ),
    ).rejects.toThrow();
    expect(objectRows().map((r) => r.missing_from_repo)).toEqual([0, 0]);
    expect(events.at(-1)).toBe("lease:end:failed");
  });

  it("holds the objects lease, and reads at the checked head inside it", async () => {
    const { env } = standInEnv();

    await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } } }),
      "tok", "owner", "repo", db, env, USER,
    );

    expect(events).toEqual([
      "head", "lease:begin:objects", `read:objects.csv@${HEAD}:true`, `tree@${HEAD}`,
      `read:_config.yml@${HEAD}:true`, "ingest", "lease:end:succeeded",
    ]);
  });

  it("refuses under a lease someone else holds, reading and sending nothing", async () => {
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");
    const { env, bodies } = standInEnv();

    await expect(
      applySyncChanges(PROJECT_ID, changes({ removedObjectIds: ["o1"] }), "tok", "owner", "repo", db, env, USER),
    ).rejects.toThrow();
    expect(bodies).toEqual([]);
    expect(getFileAtRef).not.toHaveBeenCalled();
  });

  it("refuses a failed read of objects.csv, sending nothing", async () => {
    sheet = { status: "error" };
    addObject(2, "o2", "Would read as removed");
    const { env, bodies } = standInEnv();

    await expect(
      applySyncChanges(PROJECT_ID, changes({ removedObjectIds: ["o1", "o2"] }), "tok", "owner", "repo", db, env, USER),
    ).rejects.toThrow();
    expect(bodies).toEqual([]);
  });

  // A compatibility check on the strict read: absent was always a site with no
  // objects.
  it("reads a missing objects.csv as a site with no objects (compatibility)", async () => {
    sheet = { status: "absent" };
    const { env, bodies } = standInEnv();

    await applySyncChanges(
      PROJECT_ID, changes({ removedObjectIds: ["o1"], removedDocIds: { o1: 1 } }),
      "tok", "owner", "repo", db, env, USER,
    );

    expect(bodies[0]).toMatchObject({ objects: { remove: [{ objectId: "o1", docId: 1 }] } });
  });
});

// ---------------------------------------------------------------------------
// The two diff readers
// ---------------------------------------------------------------------------

describe("the sync readers read objects.csv strictly at one head", () => {
  it("computeSyncDiff reads the sheet and the tree at the head it resolves", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db);

    expect(getRepoHead).toHaveBeenCalledTimes(1);
    expect(events).toContain(`read:objects.csv@${HEAD}:true`);
    expect(events).toContain(`tree@${HEAD}`);
    expect(diff.changedObjects.map((c) => c.object_id)).toEqual(["o1"]);
  });

  it("computeSyncDiff refuses a failed read rather than offering every object as removed", async () => {
    sheet = { status: "error" };
    await expect(computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db)).rejects.toThrow();
  });

  it("computeSyncDiff reads a missing objects.csv as a site with no objects (compatibility)", async () => {
    sheet = { status: "absent" };
    memory.raw.exec("UPDATE objects SET origin = 'repo'");
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db);
    expect(diff.missingObjects.map((m) => m.object_id)).toEqual(["o1"]);
  });

  const fullChanges = {
    objects: changes({ changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } } }),
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
  };

  it("resolveFullSyncPayload reads the sheet and the tree at the head it resolves", async () => {
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges, "tok", "owner", "repo", db, USER);

    expect(events).toContain(`read:objects.csv@${HEAD}:true`);
    expect(events).toContain(`tree@${HEAD}`);
    expect(payload.objects.update).toEqual([{ objectId: "o1", docId: 1, fields: { title: "Repo title" }, seen: { title: null } }]);
  });

  it("resolveFullSyncPayload refuses a failed read", async () => {
    sheet = { status: "error" };
    await expect(
      resolveFullSyncPayload(PROJECT_ID, fullChanges, "tok", "owner", "repo", db, USER),
    ).rejects.toThrow();
  });

  it("resolveFullSyncPayload reads a missing objects.csv as a site with no objects (compatibility)", async () => {
    sheet = { status: "absent" };
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges, "tok", "owner", "repo", db, USER);
    expect(payload.objects.update).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Against the real collaboration object: a warm document
// ---------------------------------------------------------------------------

async function loadRealDo(): Promise<{ doInstance: ProjectCollaborationDO; ydoc: Y.Doc; env: Env }> {
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(buildDoc(true), PROJECT_ID);
  const ctx = {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: { idFromName: (n: string) => n, get: () => doInstance },
  } as unknown as Env;
  readSeenFrom((doInstance as unknown as { ydoc: Y.Doc }).ydoc);
  return { doInstance, ydoc: (doInstance as unknown as { ydoc: Y.Doc }).ydoc, env };
}

describe("a removal accepted from an old check", () => {
  // The sequence: the check offered o1 as D1 id 1; o1 was deleted and
  // re-created as id 2 before the author applied the old choice.
  it("leaves an object re-created under the same key in D1 and in the document", async () => {
    const { ydoc, env } = await loadRealDo();
    sheet = { status: "ok", content: "object_id,title\n" };
    const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
    const recreated = new Y.Map<unknown>();
    ydoc.transact(() => {
      objectsArray.delete(0, 1);
      recreated.set("_id", 2);
      recreated.set("object_id", "o1");
      recreated.set("title", new Y.Text("Again"));
      recreated.set("_validation_state", "valid");
      objectsArray.push([recreated]);
    }, null);
    memory.raw.exec("DELETE FROM objects WHERE id = 1");
    addObject(2, "o1", "Again");

    await applySyncChanges(
      PROJECT_ID, changes({ removedObjectIds: ["o1"], removedDocIds: { o1: 1 } }),
      "tok", "owner", "repo", db, env, USER,
    );

    expect(objectRows().map((r) => r.id)).toEqual([2]);
    expect(objectsArray.toArray().map((m) => m.get("_id"))).toEqual([2]);
  });
});

describe("an accepted field survives the warm document's next snapshot", () => {
  it("keeps the repo value in D1 after the document snapshots again", async () => {
    const { doInstance, ydoc, env } = await loadRealDo();
    // The warm document holds the old value.
    const title = ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title") as Y.Text;
    expect(title.toString()).not.toBe("Repo title");

    await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } } }),
      "tok", "owner", "repo", db, env, USER,
    );
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    expect(objectRows().find((r) => r.object_id === "o1")?.title).toBe("Repo title");
  });
});

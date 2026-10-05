/**
 * The full sync removes the object the author was shown, and holds the
 * objects lease.
 *
 * The full-sync dialog submits the D1 id each removed object was shown with,
 * and `resolveFullSyncPayload` sends a removal only for a D1 row holding that
 * key and that id, which is not a course item and is still absent from the
 * sheet it has just read strictly at the head. An object deleted and
 * re-created under the same key since the check is not the one the author
 * chose; a row sharing its key with the chosen one is left alone; a choice with
 * no id removes nothing. `applyFullSyncChanges` holds the `objects` lease for
 * its whole apply, and a refused lease fails it as any other apply failure.
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
    getRepoHead: vi.fn(async () => "head-sha"),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import {
  applyFullSyncChanges,
  resolveFullSyncPayload,
  type FullSyncChanges,
  type FullSyncDiff,
} from "~/lib/sync.server";
import { getFileAtRef } from "~/lib/github.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { buildThreeWayChanges } from "~/components/features/dashboard/SyncConfirmModal";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { PROJECT_ID, SECRET, buildDoc, seedProject } from "./helpers/collaboration-fixture";
import { emptyThreeWaySelections } from "./sync-probe-fixtures";

const USER = 1;
let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sheet: { status: "ok"; content: string } | { status: "absent" } | { status: "error" };
const events: string[] = [];

function objectRows(): number[] {
  return (memory.raw.prepare("SELECT id FROM objects ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

function fullChanges(removedDocIds: Record<string, number> | undefined, removed = ["o1"]): FullSyncChanges {
  return {
    objects: {
      newObjectIds: [],
      changedObjectIds: [],
      fieldChoices: {},
      removedObjectIds: removed,
      ...(removedDocIds ? { removedDocIds } : {}),
      unregisteredObjectIds: [],
    },
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    // A check computed for this project against no recorded head, as the
    // seeded project has none.
    projectId: PROJECT_ID,
    baseSha: null,
  };
}

function removals(payload: { objects: { remove: unknown[] } }): unknown[] {
  return payload.objects.remove;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  events.length = 0;
  memory = createMemoryD1();
  seedProject(memory, "text");
  db = drizzle(asD1(memory), { schema });
  sheet = { status: "ok", content: "object_id,title\n" };
  vi.mocked(getFileAtRef).mockImplementation(async () => sheet);
  vi.mocked(controlFreezeLease).mockImplementation(async (_e, _p, _u, control) => {
    events.push(control.op === "begin" ? `lease:begin:${control.kind}` : `lease:end:${(control as { outcome?: string }).outcome}`);
    return "applied";
  });
});

afterEach(() => {
  memory.close();
});



describe("resolveFullSyncPayload removes the row the author was shown", () => {
  it("sends the removal by the submitted D1 id when that row still holds the key", async () => {
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges({ o1: 1 }), "t", "o", "r", db, USER);
    expect(removals(payload)).toEqual([{ objectId: "o1", docId: 1 }]);
  });

  it("sends nothing for an object re-created under the same key since the check", async () => {
    memory.raw.exec("DELETE FROM objects WHERE id = 1");
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (2, ${PROJECT_ID}, 'o1', 'a00002', 'Again')`);
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges({ o1: 1 }), "t", "o", "r", db, USER);
    expect(removals(payload)).toEqual([]);
  });

  it("removes the chosen row when another row shares its key, and flags the survivor", async () => {
    memory.raw.exec("UPDATE objects SET origin = 'repo' WHERE id = 1");
    beforeObjectIdentityIndex(memory);
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ${PROJECT_ID}, 'o1', 'a00002', 'Twin', 'repo')`);
    const { payload, residue } = await resolveFullSyncPayload(PROJECT_ID, fullChanges({ o1: 1 }), "t", "o", "r", db, USER);
    expect(removals(payload)).toEqual([{ objectId: "o1", docId: 1 }]);
    // The removed row is excluded by its id; the row sharing its key is still
    // absent from the repo and is flagged.
    expect(residue.missingFromRepoSet).toEqual([2]);
  });

  it("sends nothing for an object back in the sheet it has just read", async () => {
    sheet = { status: "ok", content: "object_id,title\no1,Back\n" };
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges({ o1: 1 }), "t", "o", "r", db, USER);
    expect(removals(payload)).toEqual([]);
  });

  it("sends nothing for a choice that names no D1 id", async () => {
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(undefined), "t", "o", "r", db, USER);
    expect(removals(payload)).toEqual([]);
  });

  // A compatibility check: course items were exempt before this change too.
  it("sends nothing for a course item (compatibility)", async () => {
    memory.raw.exec("UPDATE objects SET course_project_id = 1 WHERE id = 1");
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges({ o1: 1 }), "t", "o", "r", db, USER);
    expect(removals(payload)).toEqual([]);
  });
});

describe("resolveFullSyncPayload with object ids that name Object.prototype's own properties", () => {
  /** `changes` as the route reads it: through JSON, as the dialog posts it. */
  const posted = (changes: FullSyncChanges): FullSyncChanges => JSON.parse(JSON.stringify(changes));

  it.each(["constructor", "__proto__"])("%s: the removal reaches the row the author was shown", async (id) => {
    memory.raw.prepare("UPDATE objects SET object_id = ? WHERE id = 1").run(id);
    const chosen = posted(fullChanges(Object.fromEntries([[id, 1]]), [id]));
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, chosen, "t", "o", "r", db, USER);
    expect(removals(payload)).toEqual([{ objectId: id, docId: 1 }]);
  });

  it.each(["constructor", "__proto__"])("%s: a removal naming no D1 id for that object removes nothing", async (id) => {
    memory.raw.prepare("UPDATE objects SET object_id = ? WHERE id = 1").run(id);
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, posted(fullChanges({}, [id])), "t", "o", "r", db, USER);
    expect(removals(payload)).toEqual([]);
  });

  it.each(["constructor", "__proto__"])("%s: a field choice reaches the row the author was shown", async (id) => {
    memory.raw.prepare("UPDATE objects SET object_id = ? WHERE id = 1").run(id);
    sheet = { status: "ok", content: `object_id,title\n${id},From GitHub\n` };
    const base = fullChanges(undefined, []);
    const chosen = posted({
      ...base,
      objects: {
        ...base.objects,
        changedObjectIds: [id],
        changedDocIds: Object.fromEntries([[id, 1]]),
        fieldChoices: Object.fromEntries([[id, { title: "repo" as const }]]),
      },
    });
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, chosen, "t", "o", "r", db, USER);
    expect(payload.objects.update).toEqual([{ objectId: id, docId: 1, fields: { title: "From GitHub" } }]);
  });

  it.each(["constructor", "__proto__"])("%s: a changed object with no choices and no D1 id writes nothing", async (id) => {
    memory.raw.prepare("UPDATE objects SET object_id = ? WHERE id = 1").run(id);
    sheet = { status: "ok", content: `object_id,title\n${id},From GitHub\n` };
    const base = fullChanges(undefined, []);
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, posted({ ...base, objects: { ...base.objects, changedObjectIds: [id] } }), "t", "o", "r", db, USER,
    );
    expect(payload.objects.update).toEqual([]);
  });
});

describe("applyFullSyncChanges", () => {
  function standInEnv(answer = () => Response.json({ applied: {} })) {
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
    };
    return { env, bodies };
  }

  it("holds the objects lease for its whole apply", async () => {
    const { env } = standInEnv();
    await applyFullSyncChanges(PROJECT_ID, fullChanges({ o1: 1 }), "t", "o", "r", db, USER, env);
    expect(events).toEqual(["lease:begin:objects", "ingest", "lease:end:succeeded"]);
  });

  it("fails under a lease someone else holds, sending nothing", async () => {
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");
    const { env, bodies } = standInEnv();
    await expect(
      applyFullSyncChanges(PROJECT_ID, fullChanges({ o1: 1 }), "t", "o", "r", db, USER, env),
    ).rejects.toThrow();
    expect(bodies).toEqual([]);
    expect(getFileAtRef).not.toHaveBeenCalled();
  });

  // Sequence: two rows share o1, both from the repo; the sheet lacks
  // o1; the author removes the row shown as id 1. The other row survives, and
  // is flagged missing from the repo.
  it("flags the row that shares the removed row's key", async () => {
    memory.raw.exec("UPDATE objects SET origin = 'repo' WHERE id = 1");
    beforeObjectIdentityIndex(memory);
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ${PROJECT_ID}, 'o1', 'a00002', 'Twin', 'repo')`);
    // The stand-in removes the named row, as the real object's flush does.
    const { env } = standInEnv();
    const removing = {
      ...env,
      COLLABORATION: {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async (req: Request) => {
            const body = JSON.parse(await req.text()) as { objects: { remove: Array<{ docId: number }> } };
            for (const r of body.objects.remove) memory.raw.prepare("DELETE FROM objects WHERE id = ?").run(r.docId);
            return Response.json({ applied: {} });
          },
        }),
      },
    };

    await applyFullSyncChanges(PROJECT_ID, fullChanges({ o1: 1 }), "t", "o", "r", db, USER, removing);

    expect(memory.raw.prepare("SELECT id, missing_from_repo FROM objects ORDER BY id").all()).toEqual([
      { id: 2, missing_from_repo: 1 },
    ]);
  });

  // The flag is written to the row decided, not to every row under its key:
  // a compositor-origin row sharing the key is not a repo object.
  it("writes the flag to the repo row only when a compositor row shares its key", async () => {
    memory.raw.exec("UPDATE objects SET origin = 'repo' WHERE id = 1");
    beforeObjectIdentityIndex(memory);
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ${PROJECT_ID}, 'o1', 'a00002', 'Twin', 'compositor')`);
    const { env } = standInEnv();

    await applyFullSyncChanges(PROJECT_ID, fullChanges(undefined, []), "t", "o", "r", db, USER, env);

    expect(memory.raw.prepare("SELECT id, missing_from_repo FROM objects ORDER BY id").all()).toEqual([
      { id: 1, missing_from_repo: 1 },
      { id: 2, missing_from_repo: 0 },
    ]);
  });

  // The stale-choice sequence, against the real collaboration object: the
  // check showed o1 as D1 id 1; o1 was deleted and re-created as id 2; the old
  // choice is applied.
  it("leaves an object re-created under the same key in D1 and in the document", async () => {
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
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
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
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (2, ${PROJECT_ID}, 'o1', 'a00002', 'Again')`);
    const env = { SESSION_SECRET: SECRET, COLLABORATION: { idFromName: (n: string) => n, get: () => doInstance } };

    await applyFullSyncChanges(PROJECT_ID, fullChanges({ o1: 1 }), "t", "o", "r", db, USER, env);

    expect(objectRows()).toEqual([2]);
    expect(objectsArray.toArray().map((m) => m.get("_id"))).toEqual([2]);
  });
});

describe("the full-sync dialog submits the D1 id it showed", () => {
  it("names each removed object's D1 id beside its key", () => {
    const diff = {
      objects: {
        newObjects: [],
        changedObjects: [],
        missingObjects: [
          { object_id: "gone-1", dbId: 3, title: "Gone", usedByStories: [] },
          { object_id: "gone-2", dbId: 8, title: "Gone too", usedByStories: [], editedInCompositor: true },
        ],
        unregisteredFiles: [],
      },
      stories: { newStories: [], changedStories: [], missingStories: [] },
      config: { changedFields: [], versionChange: null },
      glossary: { added: [], removed: [], changed: [] },
      hasConflicts: true,
      classification: "three-way",
      suppressedEditorOnly: 0,
    } as unknown as FullSyncDiff;
    const selections = { ...emptyThreeWaySelections(), objectDelete: { "gone-2": true } };

    const changes = buildThreeWayChanges(diff, selections);

    expect(changes.objects.removedObjectIds).toEqual(["gone-1", "gone-2"]);
    expect(changes.objects.removedDocIds).toEqual({ "gone-1": 3, "gone-2": 8 });
  });
});

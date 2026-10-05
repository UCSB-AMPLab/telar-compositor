/**
 * An object whose sync insert D1 refused at the flush, and which lands at a
 * later snapshot, is given the repo as its origin.
 *
 * The row stays in the document with no D1 id after the refused flush; the
 * snapshot that inserts it later reads its origin from the document. These run
 * the real applies against the real collaboration object and an in-memory
 * database, drop the refusal, and snapshot.
 *
 * The registration of pending repo objects from the objects tab is the third
 * producer of such an insert.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as Y from "yjs";
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
    getRepoHead: vi.fn(),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import {
  applyFullSyncChanges, applySyncChanges, ObjectsNotAdded, type FullSyncChanges, type SyncChanges,
} from "~/lib/sync.server";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { registerCommittedObjects } from "~/lib/register-objects.server";
import type { PendingObject } from "~/lib/sync.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { PROJECT_ID, SECRET, buildDoc, seedProject, seededText } from "./helpers/collaboration-fixture";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const USER = 1;
const SEEN_TITLE = seededText("objects", "title");

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ydoc: Y.Doc;
let env: Env;
let host: ProjectCollaborationDO;

function laterOriginOf(objectId: string): string | undefined {
  const row = memory.raw
    .prepare("SELECT origin FROM objects WHERE project_id = ? AND object_id = ?")
    .get(PROJECT_ID, objectId) as { origin: string } | undefined;
  return row?.origin;
}

function laterChanges(): SyncChanges {
  return {
    newObjectIds: ["o2"],
    changedObjectIds: [],
    fieldChoices: {},
    fieldsSeen: {},
    changedDocIds: {},
    removedObjectIds: [],
    unregisteredObjectIds: [],
    headSha: HEAD,
    baseSha: BASE,
  };
}

function laterFullChanges(): FullSyncChanges {
  return {
    objects: { ...laterChanges(), baseSha: undefined },
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    headSha: HEAD,
    projectId: PROJECT_ID,
    baseSha: BASE,
    storyContentChecked: true,
    pageContentChecked: true,
  };
}

function refuseO2(): void {
  memory.raw.exec(
    "CREATE TRIGGER refuse_o2 BEFORE INSERT ON objects WHEN NEW.object_id = 'o2' BEGIN SELECT RAISE(ABORT, 'refused'); END",
  );
}

/** o2's Y.Map in the document, which a refused flush leaves awaiting its D1 row. */
function pendingO2(): Y.Map<unknown> | undefined {
  return ydoc.getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("object_id") === "o2");
}

/** The state a refused flush left, as the first call must have left it. */
function expectO2Pending(): Y.Map<unknown> {
  const held = pendingO2();
  expect(held).toBeDefined();
  expect(held!.get("_id")).toBeNull();
  expect(laterOriginOf("o2")).toBeUndefined();
  return held!;
}

/** The pending row as a base version built it: with no origin of its own. */
function withoutOrigin(held: Y.Map<unknown>): void {
  expect(held.get("origin")).toBe("repo");
  ydoc.transact(() => held.delete("origin"), null);
  expect(held.has("origin")).toBe(false);
}

async function landLater(): Promise<void> {
  memory.raw.exec("DROP TRIGGER refuse_o2");
  await (host as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  seedProject(memory, "text");
  memory.raw
    .prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ?, yjs_state = ? WHERE id = ?")
    .run(BASE, BASE, buildDoc(true), PROJECT_ID);
  db = drizzle(asD1(memory), { schema });
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  const sheets: Record<string, string> = {
    [BASE]: `object_id,title\no1,${SEEN_TITLE}\n`,
    [HEAD]: `object_id,title\no1,${SEEN_TITLE}\no2,From GitHub\n`,
  };
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
    path === OBJECTS_CSV && sheets[ref] !== undefined ? { status: "ok", content: sheets[ref] } : { status: "absent" },
  );

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
  host = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (host as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (host as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  ydoc = (host as unknown as { ydoc: Y.Doc }).ydoc;
  const title = ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title") as Y.Text;
  ydoc.transact(() => {
    title.delete(0, title.length);
    title.insert(0, SEEN_TITLE);
  }, null);
  const stub = { fetch: async (req: Request) => host.fetch(req) };
  env = { SESSION_SECRET: SECRET, COLLABORATION: { idFromName: (n: string) => n, get: () => stub } } as unknown as Env;
});

afterEach(() => {
  memory.close();
});

describe("a refused insert that lands at a later snapshot", () => {
  it("is given the repo as its origin by the full sync", async () => {
    refuseO2();
    const first = await applyFullSyncChanges(PROJECT_ID, laterFullChanges(), "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);
    expect(first).toBeInstanceOf(ObjectsNotAdded);
    expectO2Pending();

    await landLater();

    expect(laterOriginOf("o2")).toBe("repo");
  });

  it("is given the repo as its origin by the objects page", async () => {
    refuseO2();
    const first = await applySyncChanges(PROJECT_ID, laterChanges(), "t", "o", "r", db, env, USER);
    expect(first.notAdded).toEqual(["o2"]);
    expectO2Pending();

    await landLater();

    expect(laterOriginOf("o2")).toBe("repo");
  });

  it("passes an identical retry of the full sync, which lands it with the repo as origin", async () => {
    refuseO2();
    const first = await applyFullSyncChanges(PROJECT_ID, laterFullChanges(), "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);
    expect(first).toBeInstanceOf(ObjectsNotAdded);
    expectO2Pending();
    memory.raw.exec("DROP TRIGGER refuse_o2");

    await applyFullSyncChanges(PROJECT_ID, laterFullChanges(), "t", "o", "r", db, USER, env);

    expect(laterOriginOf("o2")).toBe("repo");
  });

  it("passes an identical retry of the objects page's apply, which lands it with the repo as origin", async () => {
    refuseO2();
    const first = await applySyncChanges(PROJECT_ID, laterChanges(), "t", "o", "r", db, env, USER);
    expect(first.notAdded).toEqual(["o2"]);
    expectO2Pending();
    memory.raw.exec("DROP TRIGGER refuse_o2");

    const res = await applySyncChanges(PROJECT_ID, laterChanges(), "t", "o", "r", db, env, USER);

    expect(res.notAdded).toEqual([]);
    expect(laterOriginOf("o2")).toBe("repo");
  });

  it("is given the repo as its origin by the registration of a pending repo object", async () => {
    refuseO2();
    const result = await registerCommittedObjects(env, db as never, PROJECT_ID, USER, [pendingRepoObject("o2")]);
    expect(result).toMatchObject({ ok: false, failed: ["o2"] });
    expectO2Pending();

    await landLater();

    expect(laterOriginOf("o2")).toBe("repo");
  });

  it("passes an identical retry of the registration, which lands it with the repo as origin", async () => {
    refuseO2();
    const first = await registerCommittedObjects(env, db as never, PROJECT_ID, USER, [pendingRepoObject("o2")]);
    expect(first).toMatchObject({ ok: false, failed: ["o2"] });
    expectO2Pending();
    memory.raw.exec("DROP TRIGGER refuse_o2");

    const result = await registerCommittedObjects(env, db as never, PROJECT_ID, USER, [pendingRepoObject("o2")]);

    expect(result).toMatchObject({ ok: true, insertedCount: 1 });
    expect(laterOriginOf("o2")).toBe("repo");
  });
});

describe("a row a base version left pending, with no origin of its own", () => {
  it("is given the repo as its origin by the retry of the full sync", async () => {
    refuseO2();
    await applyFullSyncChanges(PROJECT_ID, laterFullChanges(), "t", "o", "r", db, USER, env).catch(() => {});
    withoutOrigin(expectO2Pending());
    memory.raw.exec("DROP TRIGGER refuse_o2");

    await applyFullSyncChanges(PROJECT_ID, laterFullChanges(), "t", "o", "r", db, USER, env);

    expect(laterOriginOf("o2")).toBe("repo");
  });

  it("is given the repo as its origin by the retry of the objects page's apply", async () => {
    refuseO2();
    await applySyncChanges(PROJECT_ID, laterChanges(), "t", "o", "r", db, env, USER);
    withoutOrigin(expectO2Pending());
    memory.raw.exec("DROP TRIGGER refuse_o2");

    const res = await applySyncChanges(PROJECT_ID, laterChanges(), "t", "o", "r", db, env, USER);

    expect(res.notAdded).toEqual([]);
    expect(laterOriginOf("o2")).toBe("repo");
  });

  it("is given the repo as its origin by the retry of the registration", async () => {
    refuseO2();
    await registerCommittedObjects(env, db as never, PROJECT_ID, USER, [pendingRepoObject("o2")]);
    withoutOrigin(expectO2Pending());
    memory.raw.exec("DROP TRIGGER refuse_o2");

    const result = await registerCommittedObjects(env, db as never, PROJECT_ID, USER, [pendingRepoObject("o2")]);

    expect(result).toMatchObject({ ok: true, insertedCount: 1 });
    expect(laterOriginOf("o2")).toBe("repo");
  });

  it("does not label a pending row made with other values", async () => {
    refuseO2();
    await registerCommittedObjects(env, db as never, PROJECT_ID, USER, [pendingRepoObject("o2")]);
    const held = expectO2Pending();
    ydoc.transact(() => {
      held.delete("origin");
      (held.get("title") as Y.Text).insert(0, "Edited ");
    }, null);
    memory.raw.exec("DROP TRIGGER refuse_o2");

    await registerCommittedObjects(env, db as never, PROJECT_ID, USER, [pendingRepoObject("o2")]);

    expect(held.has("origin")).toBe(false);
    expect(laterOriginOf("o2")).toBe("iiif");
  });

  it("keeps a different origin it already holds", async () => {
    refuseO2();
    await registerCommittedObjects(env, db as never, PROJECT_ID, USER, [pendingRepoObject("o2")]);
    const held = expectO2Pending();
    ydoc.transact(() => held.set("origin", "compositor"), null);
    memory.raw.exec("DROP TRIGGER refuse_o2");

    await registerCommittedObjects(env, db as never, PROJECT_ID, USER, [pendingRepoObject("o2")]);

    expect(held.get("origin")).toBe("compositor");
    expect(laterOriginOf("o2")).toBe("compositor");
  });
});

function pendingRepoObject(objectId: string): PendingObject {
  return {
    object_id: objectId, title: "From GitHub", featured: false, creator: null, description: null,
    source_url: null, period: null, year: null, object_type: null, subjects: null, source: null,
    credit: null, thumbnail: null, image_available: false, origin: "repo",
  };
}

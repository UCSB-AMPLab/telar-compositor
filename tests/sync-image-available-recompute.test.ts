/**
 * The objects sync's apply and the full sync's accept recompute
 * `image_available` by the tiler's rule against the tree they read at the
 * head, through the collaboration object, so a document still
 * holding the stale value cannot write it back. Only on a site with no base
 * the tile probe may ask, where the repository decides readiness; a
 * truncated tree unmarks nothing; what the author is told was applied counts
 * only what they chose.
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
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import { applySyncChanges, resolveFullSyncPayload, type SyncChanges } from "~/lib/sync.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { PROJECT_ID, SECRET, seedProject } from "./helpers/collaboration-fixture";
import { readSeenFrom, withChoicesSeen } from "./helpers/object-update-seen";

const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const USER = 1;

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let files: string[];
let truncated: boolean;
let sheetCsv: string;
let configYml: string | null;

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

/** Two self-hosted objects, o1 and o2, with the `image_available` each holds in D1. */
function seedImages(o1: boolean, o2: boolean): void {
  memory.raw.exec(`UPDATE objects SET source_url = NULL, origin = 'repo', image_available = ${o1 ? 1 : 0} WHERE id = 1`);
  memory.raw.exec(
    `INSERT INTO objects (id, project_id, object_id, order_key, title, origin, image_available) ` +
      `VALUES (2, ${PROJECT_ID}, 'o2', 'a00002', 'Second', 'repo', ${o2 ? 1 : 0})`,
  );
}

function flags(): Array<[string, number]> {
  const rows = memory.raw.prepare("SELECT object_id, image_available FROM objects ORDER BY id").all() as Array<{
    object_id: string; image_available: number;
  }>;
  return rows.map((r) => [r.object_id, r.image_available]);
}

/** The real collaboration object, loaded from D1, as the apply's binding. */
async function loadRealDo(): Promise<{ doInstance: ProjectCollaborationDO; ydoc: Y.Doc; env: Env; bodies: unknown[] }> {
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
  const bodies: unknown[] = [];
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          bodies.push(JSON.parse(await req.clone().text()));
          return doInstance.fetch(req);
        },
      }),
    },
  } as unknown as Env;
  readSeenFrom(ydoc);
  return { doInstance, ydoc, env, bodies };
}

function docFlag(ydoc: Y.Doc, objectId: string): unknown {
  return ydoc.getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("object_id") === objectId)?.get("image_available");
}

async function snapshot(doInstance: ProjectCollaborationDO): Promise<void> {
  await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  readSeenFrom(null);
  memory = createMemoryD1();
  seedProject(memory, "text");
  db = drizzle(asD1(memory), { schema });
  files = [];
  truncated = false;
  sheetCsv = "object_id,title\no1,Repo title\no2,Second\n";
  configYml = null;
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
    if (path === OBJECTS_CSV) return { status: "ok", content: sheetCsv };
    if (path === "_config.yml" && configYml !== null) return { status: "ok", content: configYml };
    return { status: "absent" };
  });
  vi.mocked(getRepoTree).mockImplementation(async () => ({
    tree: files.map((name) => ({ path: `telar-content/objects/${name}`, type: "blob" })),
    truncated,
  }) as never);
});

afterEach(() => {
  memory.close();
});



describe("the objects sync's apply recomputes image_available", () => {
  it("unmarks a ready object with no file in the tree, through the document, and counts only the author's change", async () => {
    seedImages(true, true);
    files = ["o1.jpg"];
    const { doInstance, ydoc, env } = await loadRealDo();

    const applied = await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } } }),
      "tok", "owner", "repo", db, env, USER,
    );
    await snapshot(doInstance);

    expect(docFlag(ydoc, "o2")).toBe(false);
    expect(flags()).toEqual([["o1", 1], ["o2", 0]]);
    expect(applied.appliedCount).toBe(1);
    expect(applied.changedSinceReview).toEqual([]);
  });

  it("recomputes with nothing selected, and reports nothing applied", async () => {
    seedImages(true, true);
    files = ["o1.jpg"];
    const { doInstance, env } = await loadRealDo();

    const applied = await applySyncChanges(PROJECT_ID, changes(), "tok", "owner", "repo", db, env, USER);
    await snapshot(doInstance);

    expect(flags()).toEqual([["o1", 1], ["o2", 0]]);
    expect(applied.appliedCount).toBe(0);
    expect(applied.updateSkipped).toBe(false);
  });

  it("unmarks nothing when the tree listing is truncated", async () => {
    seedImages(true, true);
    truncated = true;
    const { doInstance, env, bodies } = await loadRealDo();

    await applySyncChanges(PROJECT_ID, changes(), "tok", "owner", "repo", db, env, USER);
    await snapshot(doInstance);

    expect(flags()).toEqual([["o1", 1], ["o2", 1]]);
    expect(bodies).toEqual([]);
  });

  it("marks an object whose file is in the tree, even when the listing is truncated", async () => {
    seedImages(false, false);
    files = ["o2.png"];
    truncated = true;
    const { doInstance, ydoc, env } = await loadRealDo();

    await applySyncChanges(PROJECT_ID, changes(), "tok", "owner", "repo", db, env, USER);
    await snapshot(doInstance);

    expect(docFlag(ydoc, "o2")).toBe(true);
    expect(flags()).toEqual([["o1", 0], ["o2", 1]]);
  });

  // D1 lags the document: D1 holds true, the document already holds false,
  // the value the tree gives. The recompute is sent with D1's value as seen,
  // which the document no longer holds.
  it("does not hold the apply back where the document no longer holds the value D1 was read with", async () => {
    seedImages(true, true);
    const { doInstance, ydoc, env, bodies } = await loadRealDo();
    ydoc.getArray<Y.Map<unknown>>("objects").get(1).set("image_available", false);

    const applied = await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } } }),
      "tok", "owner", "repo", db, env, USER,
    );
    await snapshot(doInstance);

    expect(bodies[0]).toMatchObject({
      objects: { update: expect.arrayContaining([{ objectId: "o2", fields: { image_available: false }, seen: { image_available: true } }]) },
    });
    expect(applied.updateSkipped).toBe(false);
    expect(applied.appliedCount).toBe(1);
    expect(memory.raw.prepare("SELECT title FROM objects WHERE id = 1").get()).toEqual({ title: "Repo title" });
    expect(docFlag(ydoc, "o2")).toBe(false);
  });

  it("judges an object by the source the apply leaves it with", async () => {
    seedImages(true, true);
    files = ["o2.jpg"];
    memory.raw.exec("UPDATE objects SET source_url = 'https://example.org/iiif/o1/manifest.json' WHERE id = 1");
    sheetCsv = "object_id,title,source_url\no1,Repo title,o1.jpg\no2,Second,\n";
    const { doInstance, ydoc, env, bodies } = await loadRealDo();

    await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { source_url: "repo" } } }),
      "tok", "owner", "repo", db, env, USER,
    );
    await snapshot(doInstance);

    expect(bodies[0]).toMatchObject({
      objects: { update: [{ objectId: "o1", docId: 1, fields: { source_url: "o1.jpg", image_available: false } }] },
    });
    expect(docFlag(ydoc, "o1")).toBe(false);
    expect(flags()).toEqual([["o1", 0], ["o2", 1]]);
  });

  it("brings every row sharing a key to the recomputed value", async () => {
    seedImages(true, false);
    beforeObjectIdentityIndex(memory);
    memory.raw.exec(
      `INSERT INTO objects (id, project_id, object_id, order_key, title, origin, image_available) ` +
        `VALUES (3, ${PROJECT_ID}, 'o2', 'a00003', 'Second again', 'repo', 1)`,
    );
    files = ["o1.jpg"];
    const { doInstance, env } = await loadRealDo();

    await applySyncChanges(PROJECT_ID, changes(), "tok", "owner", "repo", db, env, USER);
    await snapshot(doInstance);

    // The snapshot re-keys the second row (`deduplicateYArray`); each row keeps its own value.
    expect(memory.raw.prepare("SELECT id, image_available FROM objects ORDER BY id").all()).toEqual([
      { id: 1, image_available: 1 }, { id: 2, image_available: 0 }, { id: 3, image_available: 0 },
    ]);
  });

  it("recomputes nothing on a site whose base the tile probe asks", async () => {
    memory.raw.exec(`UPDATE project_config SET url = 'https://example.org', baseurl = '/site' WHERE project_id = ${PROJECT_ID}`);
    seedImages(true, true);
    const { doInstance, env, bodies } = await loadRealDo();

    await applySyncChanges(PROJECT_ID, changes(), "tok", "owner", "repo", db, env, USER);
    await snapshot(doInstance);

    expect(flags()).toEqual([["o1", 1], ["o2", 1]]);
    expect(bodies).toEqual([]);
  });
});

describe("the full sync's accept recomputes image_available", () => {
  const fullChanges = (objects: SyncChanges) => ({
    objects,
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
  });

  it("sends each recomputed value by key, on the reviewed entry or one of its own", async () => {
    seedImages(false, true);
    files = ["o1.jpg"];

    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID,
      fullChanges(changes({ changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } } })),
      "tok", "owner", "repo", db, USER,
    );

    expect(payload.objects.update).toEqual([
      expect.objectContaining({
        objectId: "o1", docId: 1,
        fields: { title: "Repo title", image_available: true },
        seen: expect.objectContaining({ image_available: false }),
      }),
      { objectId: "o2", fields: { image_available: false }, seen: { image_available: true } },
    ]);
  });

  it("decides by the site address the accept leaves, not D1's", async () => {
    seedImages(true, true);
    configYml = "url: https://example.org\nbaseurl: /site\n";

    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, { ...fullChanges(changes()), config: { accept: ["url", "baseurl"], reject: [] } }, "tok", "owner", "repo", db, USER,
    );

    expect(payload.config).toEqual(expect.arrayContaining([{ key: "url", value: "https://example.org" }]));
    expect(payload.objects.update).toEqual([]);
  });

  it("unmarks nothing when the tree listing is truncated", async () => {
    seedImages(true, true);
    truncated = true;

    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(changes()), "tok", "owner", "repo", db, USER);

    expect(payload.objects.update).toEqual([]);
  });
});

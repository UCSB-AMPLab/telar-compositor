/**
 * The full sync's base and the objects record it holds.
 *
 * With no head recorded, the review's base is the commit the import read
 * (`importCommitOf`): the apply accepts that base while no head is recorded,
 * and advances head_sha compare-and-set from none. Where the project's
 * `objects_read_sha` is not the base (an objects commit moved it on its own,
 * or a head write left it behind), the objects are compared against it, the
 * apply holds only while it is still the record, and advances it to the head
 * recorded. An imported site starts this way: no head, the import's commit,
 * and the record an objects commit made since.
 *
 * The diff and the apply run for real against D1 in memory; GitHub answers
 * from each commit's objects.csv, and the collaboration object takes the
 * ingest and applies nothing.
 *
 * @version v1.5.5-beta
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
    getRepoHead: vi.fn(),
    getRepoTree: vi.fn(),
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
  applyFullSyncChanges,
  computeFullSyncDiff,
  SyncBaseStale,
  type FullSyncChanges,
} from "~/lib/sync.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { PROJECT_ID, SECRET, seedProject } from "./helpers/collaboration-fixture";

const IMPORT = "a".repeat(40);
const OBJECTS_COMMIT = "b".repeat(40);
const HEAD = "c".repeat(40);
const OTHER = "d".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const USER = 1;

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** objects.csv at each commit. */
let sheets: Record<string, string>;
let ingests: unknown[];

/** The collaboration object, taking each ingest and applying nothing. */
const env = {
  SESSION_SECRET: SECRET,
  COLLABORATION: {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (req: Request) => {
        ingests.push(JSON.parse(await req.text()));
        return Response.json({ applied: {} });
      },
    }),
  },
} as unknown as Env;

function project(): { head_sha: string | null; objects_read_sha: string | null } {
  return memory.raw.prepare("SELECT head_sha, objects_read_sha FROM projects WHERE id = ?").get(PROJECT_ID) as never;
}

/** The project as an import leaves it: no head, the import's commit in its page files record, and `objectsRead`. */
function imported(objectsRead: string | null): void {
  memory.raw
    .prepare("UPDATE projects SET head_sha = NULL, page_files_json = ?, objects_read_sha = ? WHERE id = ?")
    .run(JSON.stringify({ commit: IMPORT, files: {} }), objectsRead, PROJECT_ID);
}

function changes(over: Partial<FullSyncChanges> = {}): FullSyncChanges {
  return {
    objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    headSha: HEAD,
    projectId: PROJECT_ID,
    baseSha: IMPORT,
    storyContentChecked: true,
    pageContentChecked: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ingests = [];
  memory = createMemoryD1();
  seedProject(memory, "text");
  db = drizzle(asD1(memory), { schema });
  // D1 holds o1, which the import read, and n1, which an objects commit added
  // since; GitHub then edited n1's title.
  memory.raw.exec("DELETE FROM objects");
  memory.raw.exec(
    `INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES ` +
      `(1, ${PROJECT_ID}, 'o1', 'a1', 'One', 'repo'), (2, ${PROJECT_ID}, 'n1', 'a2', 'New', 'compositor')`,
  );
  sheets = {
    [IMPORT]: "object_id,title\no1,One\n",
    [OBJECTS_COMMIT]: "object_id,title\no1,One\nn1,New\n",
    [HEAD]: "object_id,title\no1,One\nn1,Edited on GitHub\n",
  };
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getRepoTree).mockResolvedValue({ tree: [], truncated: false } as never);
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
    path === OBJECTS_CSV && sheets[ref] !== undefined ? { status: "ok", content: sheets[ref] } : { status: "absent" },
  );
});

afterEach(() => {
  memory.close();
});

describe("the check of an imported site whose objects record an objects commit moved", () => {
  it("compares the objects against the record: a title GitHub alone edited since is GitHub's change", async () => {
    imported(OBJECTS_COMMIT);
    const diff = await computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, IMPORT, { headRef: HEAD, objectsReadSha: OBJECTS_COMMIT });

    expect(diff.baseSha).toBe(IMPORT);
    expect(diff.objectsReadSha).toBe(OBJECTS_COMMIT);
    expect(diff.objects.changedObjects).toMatchObject([{ object_id: "n1", changedFields: ["title"], conflictFields: [] }]);
  });

  it("compares them against the base where the caller names no record, which reads both sides as changed", async () => {
    imported(OBJECTS_COMMIT);
    const diff = await computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, IMPORT, { headRef: HEAD });

    expect(diff.objectsReadSha).toBeUndefined();
    expect(diff.objects.changedObjects).toMatchObject([{ object_id: "n1", conflictFields: ["title"] }]);
  });

  it("compares them two-way where there is no record", async () => {
    imported(null);
    const diff = await computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, IMPORT, { headRef: HEAD, objectsReadSha: null });

    expect(diff.objectsReadSha).toBeNull();
    expect(diff.objects.suppressedEditorOnly).toBeUndefined();
    expect(diff.classification).toBe("three-way");
  });
});

describe("an apply over the import's commit", () => {
  it("records the head over no head, and moves the objects record from the one the check loaded", async () => {
    imported(OBJECTS_COMMIT);

    const res = await applyFullSyncChanges(PROJECT_ID, changes({ objectsReadSha: OBJECTS_COMMIT }), "t", "o", "r", db, USER, env);

    expect(res.newHeadSha).toBe(HEAD);
    expect(project()).toEqual({ head_sha: HEAD, objects_read_sha: HEAD });
  });

  it("moves the objects record from the import's commit when the check carried none", async () => {
    imported(IMPORT);

    await applyFullSyncChanges(PROJECT_ID, changes(), "t", "o", "r", db, USER, env);

    expect(project()).toEqual({ head_sha: HEAD, objects_read_sha: HEAD });
  });

  it("is refused, writing nothing, once a head is recorded", async () => {
    imported(OBJECTS_COMMIT);
    memory.raw.prepare("UPDATE projects SET head_sha = ? WHERE id = ?").run(OTHER, PROJECT_ID);

    await expect(applyFullSyncChanges(PROJECT_ID, changes({ objectsReadSha: OBJECTS_COMMIT }), "t", "o", "r", db, USER, env))
      .rejects.toBeInstanceOf(SyncBaseStale);
    expect(ingests).toEqual([]);
    expect(project()).toEqual({ head_sha: OTHER, objects_read_sha: OBJECTS_COMMIT });
  });

  it("is refused, writing nothing, for a base that is not the import's commit", async () => {
    imported(OBJECTS_COMMIT);

    await expect(applyFullSyncChanges(PROJECT_ID, changes({ baseSha: OTHER }), "t", "o", "r", db, USER, env))
      .rejects.toBeInstanceOf(SyncBaseStale);
    expect(ingests).toEqual([]);
    expect(project()).toEqual({ head_sha: null, objects_read_sha: OBJECTS_COMMIT });
  });
});

describe("an apply whose objects record moved since the check", () => {
  it("is refused, writing nothing", async () => {
    imported(IMPORT);

    await expect(applyFullSyncChanges(PROJECT_ID, changes({ objectsReadSha: OBJECTS_COMMIT }), "t", "o", "r", db, USER, env))
      .rejects.toBeInstanceOf(SyncBaseStale);
    expect(ingests).toEqual([]);
    expect(project()).toEqual({ head_sha: null, objects_read_sha: IMPORT });
  });

  it("is refused for a record that is not a string", async () => {
    imported(OBJECTS_COMMIT);

    await expect(applyFullSyncChanges(PROJECT_ID, changes({ objectsReadSha: 7 as never }), "t", "o", "r", db, USER, env))
      .rejects.toBeInstanceOf(SyncBaseStale);
    expect(ingests).toEqual([]);
  });
});

describe("an apply over a recorded head whose objects record lags", () => {
  it("advances the record from the one the check loaded", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ? WHERE id = ?").run(OBJECTS_COMMIT, IMPORT, PROJECT_ID);

    await applyFullSyncChanges(
      PROJECT_ID, changes({ baseSha: OBJECTS_COMMIT, objectsReadSha: IMPORT }), "t", "o", "r", db, USER, env,
    );

    expect(project()).toEqual({ head_sha: HEAD, objects_read_sha: HEAD });
  });
});

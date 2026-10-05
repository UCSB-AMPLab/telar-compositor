/**
 * The objects page's sync applies the commit the author reviewed.
 *
 * The check reports the commit it read (`headSha`), and the apply carries it
 * back. Before the lease and before any read, the apply refuses with
 * `ObjectsSyncStale` a check that names no full commit SHA, or one whose
 * commit is not GitHub's head at the apply; otherwise every read of the apply
 * is at that commit. The objects sync is two-way and has no base, so the check's own
 * commit is the only identity it has.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
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

import { applySyncChanges, computeSyncDiff, ObjectsSyncStale, type SyncChanges } from "~/lib/sync.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { PROJECT_ID, SECRET, seedProject } from "./helpers/collaboration-fixture";
import { withChoicesSeen } from "./helpers/object-update-seen";

const CHECKED = "a".repeat(40);
const MOVED = "b".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const USER = 1;

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
const events: string[] = [];
let head: string;
/** objects.csv at each commit. */
let sheets: Record<string, string>;

function changes(overrides: Partial<SyncChanges> = {}): SyncChanges {
  return withChoicesSeen({
    newObjectIds: [],
    changedObjectIds: ["o1"],
    changedDocIds: { o1: 1 },
    fieldChoices: { o1: { title: "repo" } },
    removedObjectIds: [],
    unregisteredObjectIds: [],
    headSha: CHECKED,
    ...overrides,
  });
}

function standInEnv() {
  const bodies: Array<Record<string, unknown>> = [];
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          events.push("ingest");
          bodies.push(JSON.parse(await req.text()) as Record<string, unknown>);
          return Response.json({ applied: {} });
        },
      }),
    },
  } as unknown as Env;
  return { env, bodies };
}

function titleOfO1(): string | null {
  return (memory.raw.prepare("SELECT title FROM objects WHERE object_id = 'o1'").get() as { title: string | null }).title;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  events.length = 0;
  memory = createMemoryD1();
  seedProject(memory, "text");
  db = drizzle(asD1(memory), { schema });
  head = CHECKED;
  sheets = {
    [CHECKED]: "object_id,title\no1,Reviewed title\n",
    [MOVED]: "object_id,title\no1,Changed since the check\n",
  };
  vi.mocked(getRepoHead).mockImplementation(async () => {
    events.push("head");
    return head;
  });
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) => {
    events.push(`read:${path.split("/").pop()}@${ref}`);
    return path === OBJECTS_CSV && sheets[ref] !== undefined
      ? { status: "ok", content: sheets[ref] }
      : { status: "absent" };
  });
  vi.mocked(getRepoTree).mockImplementation(async (_t, _o, _r, ref) => {
    events.push(`tree@${ref}`);
    return { tree: [], truncated: false };
  });
  vi.mocked(controlFreezeLease).mockImplementation(async (_e, _p, _u, control) => {
    events.push(control.op === "begin" ? "lease:begin" : "lease:end");
    return "applied";
  });
});

afterEach(() => {
  memory.close();
});

describe("the objects check says what it read", () => {
  it("returns the commit it read the sheet and the tree at", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db);

    expect(diff.headSha).toBe(CHECKED);
    // The site's version is read at the same commit (`siteVersionAtRef`).
    expect(events).toEqual([
      "head", `read:objects.csv@${CHECKED}`, `tree@${CHECKED}`, `read:_config.yml@${CHECKED}`,
    ]);
  });

  it("returns the commit a caller pins it to", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, MOVED);

    expect(diff.headSha).toBe(MOVED);
    expect(getRepoHead).not.toHaveBeenCalled();
  });
});

describe("the objects apply refuses a check that is not current", () => {
  const refusals: Array<[string, Partial<SyncChanges>]> = [
    ["names no commit (an older page)", { headSha: undefined }],
    ["names a commit that is not a full SHA", { headSha: "abc123" }],
    ["names an uppercase SHA", { headSha: "A".repeat(40) }],
  ];
  for (const [label, overrides] of refusals) {
    it(`refuses a check that ${label}, reading and writing nothing`, async () => {
      const { env, bodies } = standInEnv();

      await expect(
        applySyncChanges(PROJECT_ID, changes(overrides), "tok", "owner", "repo", db, env, USER),
      ).rejects.toBeInstanceOf(ObjectsSyncStale);

      expect(events).toEqual([]);
      expect(bodies).toEqual([]);
      expect(titleOfO1()).toBe("objects.title as D1 holds it");
    });
  }

  it("refuses once GitHub has moved from the checked commit, before the lease and any read", async () => {
    head = MOVED;
    const { env, bodies } = standInEnv();

    await expect(
      applySyncChanges(PROJECT_ID, changes(), "tok", "owner", "repo", db, env, USER),
    ).rejects.toBeInstanceOf(ObjectsSyncStale);

    expect(events).toEqual(["head"]);
    expect(bodies).toEqual([]);
  });

  // The row the author reviewed was changed on GitHub before the apply: the
  // later row is never applied.
  it("never applies a row changed on GitHub between check and apply", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db);
    expect(diff.changedObjects[0]?.repoValues.title).toBe("Reviewed title");
    head = MOVED;
    const { env, bodies } = standInEnv();

    await expect(
      applySyncChanges(PROJECT_ID, changes({ headSha: diff.headSha }), "tok", "owner", "repo", db, env, USER),
    ).rejects.toBeInstanceOf(ObjectsSyncStale);

    expect(bodies).toEqual([]);
  });
});

describe("every read of the objects apply is at the checked commit", () => {
  it("reads objects.csv and the tree at headSha, inside the lease", async () => {
    const { env, bodies } = standInEnv();

    await applySyncChanges(PROJECT_ID, changes(), "tok", "owner", "repo", db, env, USER);

    expect(events).toEqual([
      "head", "lease:begin", `read:objects.csv@${CHECKED}`, `tree@${CHECKED}`,
      `read:_config.yml@${CHECKED}`, "ingest", "lease:end",
    ]);
    expect(bodies[0]).toMatchObject({
      objects: { update: [{ objectId: "o1", fields: { title: "Reviewed title" } }] },
    });
  });

  // A commit that lands after the head comparison is not read: the reads stay
  // at the checked commit even when GitHub answers otherwise afterwards.
  it("does not read a commit that lands after the head comparison", async () => {
    vi.mocked(getRepoHead)
      .mockImplementationOnce(async () => {
        events.push("head");
        return CHECKED;
      })
      .mockImplementation(async () => {
        events.push("head");
        return MOVED;
      });
    const { env, bodies } = standInEnv();

    await applySyncChanges(PROJECT_ID, changes(), "tok", "owner", "repo", db, env, USER);

    expect(events.filter((e) => e === "head")).toHaveLength(1);
    expect(events.some((e) => e.includes(MOVED))).toBe(false);
    expect(bodies[0]).toMatchObject({
      objects: { update: [{ objectId: "o1", fields: { title: "Reviewed title" } }] },
    });
  });
});

/**
 * The objects sync readers read objects.csv strictly at one head.
 *
 * Each reader resolves the head once and reads objects.csv strictly and the
 * tree at it. A failed read refuses rather than reading as a site with no
 * objects, which would offer every object D1 holds as removed.
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
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import {
  computeSyncDiff,
  resolveFullSyncPayload,
  type SyncChanges,
} from "~/lib/sync.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { PROJECT_ID, seedProject } from "./helpers/collaboration-fixture";
import { readSeenFrom, withChoicesSeen } from "./helpers/object-update-seen";

const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const USER = 1;

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
const events: string[] = [];
let sheet: { status: "ok"; content: string } | { status: "absent" } | { status: "error" };

function changes(overrides: Partial<SyncChanges> = {}): SyncChanges {
  return withChoicesSeen({
    newObjectIds: [],
    changedObjectIds: [],
    fieldChoices: {},
    removedObjectIds: [],
    unregisteredObjectIds: [],
    ...overrides,
  });
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

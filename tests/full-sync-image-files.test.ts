/**
 * Image files with no object, in the full sync.
 *
 * The check offers an image file in the objects folder that no row of
 * objects.csv or D1 names only where the review's base did not hold it, so a
 * file the author left out at an earlier sync, which the apply then recorded
 * the head over, is not offered again. With no base, every such file is. The
 * apply registers each file the author chose under its stem, and takes only
 * a stem of an image file at the head it reads that names no row.
 *
 * The diff runs for real against D1 in memory; GitHub answers from each
 * commit's objects.csv and objects folder.
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

import { computeFullSyncDiff, resolveFullSyncPayload, type FullSyncChanges } from "~/lib/sync.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { PROJECT_ID, seedProject } from "./helpers/collaboration-fixture";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** The objects folder's files at each commit. */
let folders: Record<string, string[]>;

function blob(name: string) {
  return { path: `telar-content/objects/${name}`, type: "blob", mode: "100644", sha: "0".repeat(40) };
}

function treesListed(): string[] {
  return vi.mocked(getRepoTree).mock.calls.map((call) => String(call[3]));
}

function changes(unregisteredObjectIds: unknown): FullSyncChanges {
  return {
    objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds },
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
  } as unknown as FullSyncChanges;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  seedProject(memory, "text");
  db = drizzle(asD1(memory), { schema });
  folders = { [BASE]: ["o1.jpg", "left-out.jpg"], [HEAD]: ["o1.jpg", "left-out.jpg", "new-image.png"] };
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) =>
    path === OBJECTS_CSV ? { status: "ok", content: "object_id,title\no1,One\n" } : { status: "absent" },
  );
  vi.mocked(getRepoTree).mockImplementation(async (_t, _o, _r, ref) => {
    const files = folders[String(ref)];
    if (!files) throw new Error(`GitHub API error fetching tree: 404`);
    return { tree: files.map(blob), truncated: false } as never;
  });
});

afterEach(() => {
  memory.close();
});

describe("the check", () => {
  it("offers an image file the base did not hold, and not one it held", async () => {
    const diff = await computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, BASE, { headRef: HEAD });

    expect(diff.objects.unregisteredFiles).toEqual([{ object_id: "new-image", filename: "new-image.png" }]);
    expect(treesListed()).toEqual([HEAD, BASE]);
  });

  it("offers every image file with no row when there is no base", async () => {
    const diff = await computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, null, { headRef: HEAD });

    expect(diff.objects.unregisteredFiles.map((f) => f.filename)).toEqual(["left-out.jpg", "new-image.png"]);
    expect(treesListed()).toEqual([HEAD]);
  });

  it("lists the base's folder only when there is a file to judge", async () => {
    folders[HEAD] = ["o1.jpg"];

    const diff = await computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, BASE, { headRef: HEAD });

    expect(diff.objects.unregisteredFiles).toEqual([]);
    expect(treesListed()).toEqual([HEAD]);
  });

  it("fails when the base's folder cannot be listed, rather than offer what the author left out", async () => {
    vi.mocked(getRepoTree).mockImplementation(async (_t, _o, _r, ref) => {
      if (ref === BASE) throw new Error("GitHub API error fetching tree: 502");
      return { tree: folders[HEAD].map(blob), truncated: false } as never;
    });

    await expect(computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, BASE, { headRef: HEAD })).rejects.toThrow("502");
  });
});

describe("the apply", () => {
  it("adds each image file the author chose as an object under its stem, not ready", async () => {
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, changes(["new-image"]), "t", "o", "r", db, 1, HEAD);

    expect(payload.objects.insert).toMatchObject([{ object_id: "new-image", image_available: false, origin: "repo", created_by: 1 }]);
  });

  it("adds nothing for an id that is not the stem of an image file at the head, or that names a row, and adds a stem once", async () => {
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, changes(["no-such-file", "o1", "new-image", "new-image", 7]), "t", "o", "r", db, 1, HEAD,
    );

    expect(payload.objects.insert.map((o) => o.object_id)).toEqual(["new-image"]);
  });

  it("adds nothing for a list that is not one", async () => {
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, changes({ 0: "new-image", length: 1 }), "t", "o", "r", db, 1, HEAD);

    expect(payload.objects.insert).toEqual([]);
  });
});

/**
 * The objects sync and the full sync match an object to its file, and a
 * step to its object, by the id the site gives it.
 *
 * The site finds the image for a row written `map.jpg` at
 * `telar-content/objects/map.jpg`, since it strips the extension from the id
 * and then looks for `map` with each image extension. A sync that matched the
 * file's stem, `map`, against the id as written marked the row as needing
 * tiles and offered the file as a new object `map`. A step naming `map` shows
 * object `map.jpg` on the site, so it is one of that object's uses.
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

import {
  applySyncChanges,
  computeFullSyncDiff,
  computeSyncDiff,
  resolveFullSyncPayload,
  type SyncChanges,
} from "~/lib/sync.server";
import type { FullSyncChanges } from "~/lib/sync.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { PROJECT_ID, SECRET, seedProject } from "./helpers/collaboration-fixture";

const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const CONFIG_YML = "_config.yml";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let files: Record<string, string>;
let treeFiles: string[];
/** When set, the read of `_config.yml` fails as a network error does. */
let configReadFails = false;

function blob(path: string) {
  return { path, type: "blob", mode: "100644", sha: "0".repeat(40) };
}

function addObject(id: number, objectId: string): void {
  memory.raw.exec(
    `INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (${id}, ${PROJECT_ID}, '${objectId}', 'b${id}', 'T')`,
  );
}

function storyTitle(id: number): string {
  return (memory.raw.prepare("SELECT title FROM stories WHERE id = ?").get(id) as { title: string }).title;
}

function addStep(id: number, objectId: string): void {
  memory.raw.exec(
    `INSERT INTO steps (id, story_id, step_number, order_key, kind, object_id) VALUES (${id}, 1, ${id}, 'c${id}', 'media', '${objectId}')`,
  );
}

/** The rows each ingest the stand-in object was sent inserts, in order. */
let sentInserts: Array<Array<{ object_id: string; image_available: boolean }>> = [];

const standInEnv = {
  SESSION_SECRET: SECRET,
  COLLABORATION: {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (request: Request) => {
        const body = (await request.json()) as { objects?: { insert?: Array<{ object_id: string; image_available: boolean }> } };
        sentInserts.push(body.objects?.insert ?? []);
        return Response.json({ applied: {} });
      },
    }),
  },
} as unknown as Env;

/** The rows the objects apply's ingest registered, as the last ingest sent them. */
function registeredRows(): Array<{ object_id: string; image_available: boolean }> {
  return sentInserts.at(-1) ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  sentInserts = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  seedProject(memory, "text");
  db = drizzle(asD1(memory), { schema });
  files = { [OBJECTS_CSV]: "object_id,title\no1,One\nmap.jpg,Map\n" };
  treeFiles = ["telar-content/objects/map.jpg"];
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  configReadFails = false;
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) =>
    path === CONFIG_YML && configReadFails
      ? { status: "error" }
      : path in files ? { status: "ok", content: files[path] } : { status: "absent" },
  );
  vi.mocked(getRepoTree).mockImplementation(async () => ({
    tree: treeFiles.map(blob) as never,
    truncated: false,
  }));
});

afterEach(() => {
  memory.close();
});

describe("the objects sync check", () => {
  it("offers a new row map.jpg not ready, whatever file it has, and offers no unregistered map", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    expect(diff.newObjects.map((o) => [o.object_id, o.image_available])).toEqual([["map.jpg", false]]);
    expect(diff.unregisteredFiles).toEqual([]);
  });

  it("offers no unregistered map for a file map.jpg that a D1 row map.jpg holds", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\n";
    addObject(2, "map.jpg");

    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    expect(diff.unregisteredFiles).toEqual([]);
  });

  it("follows the site's version: a row map.heic is the file map.jpg's on 1.8.0 only", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap.heic,Map\n";

    const on18 = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.8.0" });
    const on17 = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    expect(on18.unregisteredFiles).toEqual([]);
    expect(on17.unregisteredFiles.map((f) => f.object_id)).toEqual(["map"]);
  });

  it("counts a step naming map as a use of the removed object map.jpg", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\n";
    addObject(2, "map.jpg");
    addStep(7, "map");

    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    const missing = diff.missingObjects.find((o) => o.object_id === "map.jpg");
    expect(missing?.usedByStories).toEqual([{ storyTitle: storyTitle(1), stepNumber: 7 }]);
  });

  it("counts only this project's steps as uses of a removed object", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\n";
    addObject(2, "map");
    addStep(7, "map");
    memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (2, 1, 'o/b', 1)");
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (90, 2, 'map', 'b90', 'T')`);
    memory.raw.exec(`INSERT INTO stories (id, project_id, story_id, title, "order", order_key) VALUES (90, 2, 's90', 'Elsewhere', 0, 'a90')`);
    memory.raw.exec(`INSERT INTO steps (id, story_id, step_number, order_key, kind, object_id) VALUES (91, 90, 4, 'c91', 'media', 'map')`);

    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    const missing = diff.missingObjects.find((o) => o.object_id === "map");
    expect(missing?.usedByStories).toEqual([{ storyTitle: storyTitle(1), stepNumber: 7 }]);
  });
});

// A new row is not ready until its tiles answer on the site, whatever file the
// tiler could find for it: neither sync marks it from the repository's files.
describe("the image files the syncs read, by the site's version", () => {
  function fullChanges(newObjectIds: string[], unregisteredObjectIds: string[] = []): FullSyncChanges {
    return {
      objects: { newObjectIds, changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    } as unknown as FullSyncChanges;
  }
  function objectsChanges(newObjectIds: string[], unregisteredObjectIds: string[] = []): SyncChanges {
    return { newObjectIds, changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds, headSha: HEAD };
  }
  const configAt = (version: string) => `title: T\ntelar:\n  version: ${version}\n`;

  async function objectsCheck(version: string) {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: version });
    return diff.newObjects.map((o) => [o.object_id, o.image_available]);
  }
  async function fullCheck(version: string) {
    files[CONFIG_YML] = configAt(version);
    const diff = await computeFullSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, null, { headRef: HEAD, frameworkVersion: version });
    return diff.objects.newObjects.map((o) => [o.object_id, o.image_available]);
  }
  async function fullApply(version: string, ids: string[], unregistered: string[] = []) {
    files[CONFIG_YML] = configAt(version);
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(ids, unregistered), "tok", "owner", "repo", db, 1, HEAD);
    return payload.objects.insert.map((o) => [o.object_id, o.image_available]);
  }
  async function registeredBy(ids: string[]) {
    sentInserts = [];
    await applySyncChanges(PROJECT_ID, objectsChanges(ids), "tok", "owner", "repo", db, standInEnv, 1);
    return registeredRows().map((r) => [r.object_id, r.image_available]);
  }

  beforeEach(() => {
    files[OBJECTS_CSV] = "object_id,title\nmap,Map\n";
  });

  it("marks no new row ready from a file the tiler would find, at either sync's check and apply", async () => {
    for (const [file, version] of [["map.gif", "1.8.0"], ["map.heic", "1.7.0"], ["map.jpg", "1.7.0"]]) {
      treeFiles = [`telar-content/objects/${file}`];
      expect(await objectsCheck(version)).toEqual([["map", false]]);
      expect(await registeredBy(["map"])).toEqual([["map", false]]);
      expect(await fullCheck(version)).toEqual([["map", false]]);
      expect(await fullApply(version, ["map"])).toEqual([["map", false]]);
    }
  });

  it("does not offer map.Jpg as an unregistered object", async () => {
    treeFiles = ["telar-content/objects/map.Jpg"];
    files[OBJECTS_CSV] = "object_id,title\n";
    const noRow = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.8.0" });
    expect(noRow.unregisteredFiles).toEqual([]);
  });

  it("does not offer a file whose stem is empty, since no row can take an empty id", async () => {
    treeFiles = ["telar-content/objects/.jpg", "telar-content/objects/.PNG", "telar-content/objects/plan.png"];
    files[OBJECTS_CSV] = "object_id,title\n";
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });
    expect(diff.unregisteredFiles).toEqual([{ object_id: "plan", filename: "plan.png" }]);
  });

  it("offers map.gif as an unregistered object on 1.8.0 only", async () => {
    treeFiles = ["telar-content/objects/map.gif"];
    files[OBJECTS_CSV] = "object_id,title\n";
    const on18 = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.8.0" });
    const on17 = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });
    expect(on18.unregisteredFiles).toEqual([{ object_id: "map", filename: "map.gif" }]);
    expect(on17.unregisteredFiles).toEqual([]);
  });
});

// An image file with no row becomes a row under its stem. The tiler looks for
// the row's image under the site id it gives that stem, and only for a site id
// it accepts. The row is not ready either way until its tiles answer on the site.
describe("a row made from an unregistered file", () => {
  it("is not ready, whatever the tiler would find for it, at the objects sync's apply", async () => {
    files[OBJECTS_CSV] = "object_id,title\n";
    treeFiles = ["telar-content/objects/map.jpg.png", "telar-content/objects/my map.jpg", "telar-content/objects/plan.png"];
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });
    expect(diff.unregisteredFiles.map((f) => f.object_id).sort()).toEqual(["map.jpg", "my map", "plan"]);

    const applied = await applySyncChanges(
      PROJECT_ID,
      { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: ["map.jpg", "my map", "plan"], headSha: HEAD },
      "tok", "owner", "repo", db, standInEnv, 1,
    );
    expect(applied.pendingObjects.map((o) => [o.object_id, o.image_available])).toEqual([
      ["map.jpg", false], ["my map", false], ["plan", false],
    ]);
  });

  it("is not ready, whatever the tiler would find for it, at the full sync's apply", async () => {
    files[OBJECTS_CSV] = "object_id,title\n";
    treeFiles = ["telar-content/objects/map.jpg.png", "telar-content/objects/my map.jpg", "telar-content/objects/plan.png"];
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID,
      {
        objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: ["map.jpg", "my map", "plan"] },
        stories: { accept: [], reject: [], insertNew: [] },
        config: { accept: [], reject: [] },
        glossary: { accept: [], reject: [], insertNew: [] },
      } as unknown as FullSyncChanges,
      "tok", "owner", "repo", db, 1, HEAD,
    );
    expect(payload.objects.insert.map((o) => [o.object_id, o.image_available])).toEqual([
      ["map.jpg", false], ["my map", false], ["plan", false],
    ]);
  });
});

describe("the objects sync apply", () => {
  it("registers a new row map.jpg not ready, though the file map.jpg is its image", async () => {
    const changes: SyncChanges = {
      newObjectIds: ["map.jpg"],
      changedObjectIds: [],
      fieldChoices: {},
      removedObjectIds: [],
      unregisteredObjectIds: [],
      headSha: HEAD,
    };

    await applySyncChanges(PROJECT_ID, changes, "tok", "owner", "repo", db, standInEnv, 1);

    const rows = registeredRows();
    expect(rows.map((r) => [r.object_id, r.image_available])).toEqual([["map.jpg", false]]);
  });
});

describe("the full sync apply", () => {
  function fullChanges(newObjectIds: string[]): FullSyncChanges {
    return {
      objects: {
        newObjectIds,
        changedObjectIds: [],
        fieldChoices: {},
        removedObjectIds: [],
        unregisteredObjectIds: [],
      },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    } as unknown as FullSyncChanges;
  }

  it("inserts a new row map.jpg not ready, though the file map.jpg is its image", async () => {
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(["map.jpg"]), "tok", "owner", "repo", db, 1, HEAD);

    expect(payload.objects.insert.map((o) => [o.object_id, o.image_available])).toEqual([["map.jpg", false]]);
  });
});

describe("two rows the site reads as one object", () => {
  it("are named in a sheet warning by the objects sync check", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap,Map\nmap.jpg,Map\n";

    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    expect(diff.warnings).toContainEqual({
      code: "object_site_id_shared",
      ids: ["map", "map.jpg"],
      shown: "map.jpg",
      sameRowEverywhere: false,
      sheet: "objects.csv",
    });
  });

  it("are named by the full sync check, on the site's framework version", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap,Map\nmap.heic,Map\n";

    const on18 = await computeFullSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, null, {
      collectWarnings: true, headRef: HEAD, frameworkVersion: "1.8.0",
    });
    const on17 = await computeFullSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, null, {
      collectWarnings: true, headRef: HEAD, frameworkVersion: "1.7.0",
    });

    const shared = (w: { code: string }) => w.code === "object_site_id_shared";
    expect((on18.warnings ?? []).filter(shared)).toEqual([
      { code: "object_site_id_shared", ids: ["map", "map.heic"], shown: "map.heic", sameRowEverywhere: true, sheet: "objects.csv" },
    ]);
    expect((on17.warnings ?? []).filter(shared)).toEqual([]);
  });
});

describe("an object_id repeated in objects.csv", () => {
  it("is named in a sheet warning by the objects sync check, and not as two ids the site reads as one", async () => {
    files[OBJECTS_CSV] = "object_id,title\nmap,First\no1,One\nmap,Second\n";

    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    expect(diff.warnings).toContainEqual({ code: "object_id_repeated", id: "map", sameRowEverywhere: false, sheet: "objects.csv" });
    expect((diff.warnings ?? []).filter((w) => w.code === "object_site_id_shared")).toEqual([]);
  });

  it("is named by the full sync check", async () => {
    files[OBJECTS_CSV] = "object_id,title\nmap,First\no1,One\nmap,Second\n";

    const diff = await computeFullSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, null, {
      collectWarnings: true, headRef: HEAD, frameworkVersion: "1.7.0",
    });

    expect((diff.warnings ?? []).filter((w) => w.code === "object_id_repeated")).toEqual([
      { code: "object_id_repeated", id: "map", sameRowEverywhere: false, sheet: "objects.csv" },
    ]);
  });

  it("leaves a site-id collision among the repeats named once, by its distinct ids", async () => {
    files[OBJECTS_CSV] = "object_id,title\nmap,First\nmap,Second\nmap.jpg,Third\n";

    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    expect(diff.warnings).toContainEqual({
      code: "object_site_id_shared", ids: ["map", "map.jpg"], shown: "map.jpg", sameRowEverywhere: false, sheet: "objects.csv",
    });
    expect(diff.warnings).toContainEqual({ code: "object_id_repeated", id: "map", sameRowEverywhere: false, sheet: "objects.csv" });
  });
});

describe("the full sync on a site whose repository is ahead of D1", () => {
  it("reviews a row map.heic by the repository's 1.8.0, not D1's 1.7.0, and inserts it not ready", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap.heic,Map\n";
    files[CONFIG_YML] = "title: T\ntelar:\n  version: 1.8.0\n";
    memory.raw.exec(`UPDATE project_config SET telar_version = '1.7.0' WHERE project_id = ${PROJECT_ID}`);

    const diff = await computeFullSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, null, {
      headRef: HEAD, frameworkVersion: "1.7.0",
    });
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID,
      {
        objects: { newObjectIds: ["map.heic"], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
        stories: { accept: [], reject: [], insertNew: [] },
        config: { accept: [], reject: [] },
        glossary: { accept: [], reject: [], insertNew: [] },
      } as unknown as FullSyncChanges,
      "tok", "owner", "repo", db, 1, HEAD,
    );

    expect(diff.objects.unregisteredFiles).toEqual([]);
    expect(payload.objects.insert.map((o) => [o.object_id, o.image_available])).toEqual([["map.heic", false]]);
  });

  it("falls back to D1's version when the repository names none", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap.heic,Map\n";
    files[CONFIG_YML] = "title: T\n";

    const diff = await computeFullSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, null, {
      headRef: HEAD, frameworkVersion: "1.8.0",
    });

    expect(diff.objects.unregisteredFiles).toEqual([]);
  });
});

describe("the objects tab's sync on a site whose repository is ahead of D1", () => {
  beforeEach(() => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap.heic,Map\n";
    files[CONFIG_YML] = "title: T\ntelar:\n  version: 1.8.0\n";
  });

  it("checks a row map.heic by the repository's 1.8.0: map.jpg is its file, no unregistered map", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    expect(diff.unregisteredFiles).toEqual([]);
  });

  it("registers a row map.heic not ready, though map.jpg is its file on the repository's 1.8.0", async () => {
    const changes: SyncChanges = {
      newObjectIds: ["map.heic"],
      changedObjectIds: [],
      fieldChoices: {},
      removedObjectIds: [],
      unregisteredObjectIds: [],
      headSha: HEAD,
    };

    await applySyncChanges(PROJECT_ID, changes, "tok", "owner", "repo", db, standInEnv, 1);

    const rows = registeredRows();
    expect(rows.map((r) => [r.object_id, r.image_available])).toEqual([["map.heic", false]]);
  });
});

// The tiler builds nothing for a site id outside `_SAFE_OBJECT_ID`
// (`[A-Za-z0-9_-]+`), whatever file is there.
describe("a row whose site id the tiler refuses", () => {
  beforeEach(() => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap.jpg.png,Map\n";
    treeFiles = ["telar-content/objects/map.jpg.jpg"];
  });

  it("is not tiled by the objects sync check", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });
    expect(diff.newObjects.map((o) => [o.object_id, o.image_available])).toEqual([["map.jpg.png", false]]);
  });

  it("is not registered as tiled by the objects sync apply", async () => {
    await applySyncChanges(
      PROJECT_ID,
      { newObjectIds: ["map.jpg.png"], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [], headSha: HEAD },
      "tok", "owner", "repo", db, standInEnv, 1,
    );
    const rows = registeredRows();
    expect(rows.map((r) => r.image_available)).toEqual([false]);
  });

  it("is not inserted as tiled by the full sync", async () => {
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID,
      {
        objects: { newObjectIds: ["map.jpg.png"], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
        stories: { accept: [], reject: [], insertNew: [] },
        config: { accept: [], reject: [] },
        glossary: { accept: [], reject: [], insertNew: [] },
      } as unknown as FullSyncChanges,
      "tok", "owner", "repo", db, 1, HEAD,
    );
    expect(payload.objects.insert.map((o) => o.image_available)).toEqual([false]);
  });
});

describe("the repository's version, read as the import reads _config.yml", () => {
  it("takes a flow-mapping telar: {version: 1.8.0} over D1's 1.7.0 in the objects sync", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap.heic,Map\n";
    files[CONFIG_YML] = "title: T\ntelar: {version: 1.8.0}\n";

    const diff = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });

    expect(diff.unregisteredFiles).toEqual([]);
  });

  // A config the site cannot parse does not build, so no published site can
  // disagree with D1's version: it reads as naming none.
  it("reads a _config.yml that is not valid YAML as naming no version, and takes D1's", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap.heic,Map\n";
    files[CONFIG_YML] = "title: T\ntelar: [unclosed\n";

    const on17 = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" });
    const on18 = await computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.8.0" });

    expect(on17.unregisteredFiles.map((f) => f.object_id)).toEqual(["map"]);
    expect(on18.unregisteredFiles).toEqual([]);
  });

  it("refuses when _config.yml cannot be read, rather than guess D1's", async () => {
    files[OBJECTS_CSV] = "object_id,title\no1,One\nmap.heic,Map\n";
    configReadFails = true;

    await expect(
      computeSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, undefined, HEAD, true, { d1: "1.7.0" }),
    ).rejects.toThrow(/_config\.yml/);
  });
});

describe("the telar_version heal, read as the import reads _config.yml", () => {
  it("heals D1's 1.7.0 from a flow-mapping telar: {version: 1.8.0}", async () => {
    files[CONFIG_YML] = "title: T\ntelar: {version: 1.8.0}\n";
    memory.raw.exec(`UPDATE project_config SET telar_version = '1.7.0' WHERE project_id = ${PROJECT_ID}`);

    const diff = await computeFullSyncDiff(PROJECT_ID, "tok", "owner", "repo", db, null, {
      headRef: HEAD, frameworkVersion: "1.7.0",
    });
    const { residue } = await resolveFullSyncPayload(
      PROJECT_ID,
      {
        objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
        stories: { accept: [], reject: [], insertNew: [] },
        config: { accept: [], reject: [] },
        glossary: { accept: [], reject: [], insertNew: [] },
      } as unknown as FullSyncChanges,
      "tok", "owner", "repo", db, 1, HEAD,
    );

    expect(diff.config.versionChange).toEqual({ direction: "ahead", repoVersion: "1.8.0", d1Version: "1.7.0" });
    expect(residue.telarVersionHeal).toBe("1.8.0");
  });
});

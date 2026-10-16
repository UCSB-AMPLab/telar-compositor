/**
 * The full sync's accept recomputes `image_available` by the tiler's rule
 * against the tree it reads at the head, through the collaboration object, so
 * a document still holding the stale value cannot write it back. Only on a
 * site with no base the tile probe may ask, where the repository decides
 * readiness; a truncated tree unmarks nothing.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
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

import { resolveFullSyncPayload, type SyncChanges } from "~/lib/sync.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { PROJECT_ID, seedProject } from "./helpers/collaboration-fixture";
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

  it("marks an object whose file is in the tree, even when the listing is truncated", async () => {
    seedImages(false, false);
    files = ["o2.png"];
    truncated = true;

    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(changes()), "tok", "owner", "repo", db, USER);

    expect(payload.objects.update).toEqual([{ objectId: "o2", fields: { image_available: true }, seen: { image_available: false } }]);
  });

  it("judges an object by the source the accept leaves it with", async () => {
    seedImages(true, true);
    files = ["o2.jpg"];
    memory.raw.exec("UPDATE objects SET source_url = 'https://example.org/iiif/o1/manifest.json' WHERE id = 1");
    sheetCsv = "object_id,title,source_url\no1,Repo title,o1.jpg\no2,Second,\n";

    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID,
      fullChanges(changes({ changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { source_url: "repo" } } })),
      "tok", "owner", "repo", db, USER,
    );

    expect(payload.objects.update).toMatchObject([{ objectId: "o1", docId: 1, fields: { source_url: "o1.jpg", image_available: false } }]);
  });

  it("names the row by its D1 id where rows share a key", async () => {
    seedImages(true, false);
    beforeObjectIdentityIndex(memory);
    memory.raw.exec(
      `INSERT INTO objects (id, project_id, object_id, order_key, title, origin, image_available) ` +
        `VALUES (3, ${PROJECT_ID}, 'o2', 'a00003', 'Second again', 'repo', 1)`,
    );
    files = ["o1.jpg"];

    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(changes()), "tok", "owner", "repo", db, USER);

    expect(payload.objects.update).toEqual([
      { objectId: "o2", docId: 3, fields: { image_available: false }, seen: { image_available: true } },
    ]);
  });
});

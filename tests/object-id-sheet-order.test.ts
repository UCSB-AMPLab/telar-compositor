/**
 * "The later row" is the later one in the order a publish writes objects.csv:
 * the author's list order, `order_key`, ascending, then `id` (the order the
 * collaboration object snapshots objects in).
 *
 * Where two rows share the site's id (`map` and `map.jpg`), the site's object
 * page and every step naming either show the later row of objects.csv. So the
 * publish writes the rows in one declared order, and the Compositor's
 * resolver and its warning name the row that order puts last, whichever of
 * the two was added first.
 *
 * The rows' `order_key` runs against their ids here, as it does in a real
 * project once an author has moved objects in the list, so an order by id and
 * the list order disagree.
 *
 * D1 is the repository's migration chain in memory.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import Papa from "papaparse";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let memory: MemoryD1;

vi.mock("~/lib/db.server", () => ({ getDb: () => drizzle(asD1(memory), { schema }) }));
vi.mock("~/lib/github.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getFileAtRef: vi.fn(async () => ({ status: "absent" })),
}));

import { buildPublishFileSet } from "~/lib/publish.server";
import { compareSheetOrder, objectsSheetOrder } from "~/lib/objects.server";
import { resolveStepObject, sharedSiteIds } from "~/lib/object-id";

const PROJECT_ID = 42;
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";

/** Rows by id; each row's order_key runs the other way (a higher id, an earlier key). */
function addObjects(ids: Array<[number, string]>): void {
  for (const [id, objectId] of ids) {
    memory.raw
      .prepare("INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (?, ?, ?, ?, 'T')")
      .run(id, PROJECT_ID, objectId, `k${1000 - id}`);
  }
}

async function publishedObjectIds(): Promise<string[]> {
  const files = await buildPublishFileSet({
    token: "tok",
    owner: "owner",
    repo: "repo",
    ref: "sha",
    projectId: PROJECT_ID,
    env: { DB: {} } as never,
    configYml: null,
    config: null,
  } as never);
  const csv = files.find((f) => f.path === OBJECTS_CSV)?.content ?? "";
  const rows = Papa.parse<string[]>(csv, { skipEmptyLines: true }).data;
  // Header, then the bilingual row, then the objects.
  return rows.slice(2).map((r) => r[0]);
}

async function inSheetOrder() {
  const db = drizzle(asD1(memory), { schema });
  return db
    .select({ object_id: schema.objects.object_id })
    .from(schema.objects)
    .where(eq(schema.objects.project_id, PROJECT_ID))
    .orderBy(objectsSheetOrder());
}

beforeEach(() => {
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (7, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(`INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, 7, 'owner/repo', 5)`);
});

afterEach(() => {
  memory.close();
});

describe("the order publish writes objects.csv in", () => {
  it("is the list order, order_key ascending, whatever the rows' ids or names say", async () => {
    addObjects([[1, "zeta"], [2, "alpha"], [3, "mid"]]);
    expect(await publishedObjectIds()).toEqual(["mid", "alpha", "zeta"]);
  });
});

describe("the order compared on rows already read", () => {
  it("is the order SQLite gives: a null key first, then an empty one, then by key, then by id", async () => {
    const rows = [
      { id: 4, object_id: "d", order_key: "a0" },
      { id: 1, object_id: "a", order_key: null },
      { id: 3, object_id: "c", order_key: "a0" },
      { id: 2, object_id: "b", order_key: "" },
      { id: 5, object_id: "e", order_key: "Z" },
    ];
    for (const r of rows) {
      memory.raw
        .prepare("INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (?, ?, ?, ?, 'T')")
        .run(r.id, PROJECT_ID, r.object_id, r.order_key);
    }
    const fromSql = (await inSheetOrder()).map((r) => r.object_id);
    const fromJs = [...rows].sort(compareSheetOrder).map((r) => r.object_id);
    expect(fromJs).toEqual(["a", "b", "e", "c", "d"]);
    expect(fromJs).toEqual(fromSql);
  });
});

describe("two rows the site reads as one", () => {
  for (const [label, first, second] of [
    ["map listed after map.jpg", "map", "map.jpg"],
    ["map.jpg listed after map", "map.jpg", "map"],
  ] as const) {
    it(`with ${label}, the resolver and the warning name the row publish writes last`, async () => {
      // The first row is the later in the list (its order_key is the larger).
      addObjects([[1, first], [2, second]]);

      const published = await publishedObjectIds();
      const lastWritten = published.filter((id) => id === "map" || id === "map.jpg").at(-1);
      const rows = await inSheetOrder();

      expect(lastWritten).toBe(first);
      expect(resolveStepObject(rows, "map", "1.7.0")?.object_id).toBe(lastWritten);
      expect(sharedSiteIds(rows, "1.7.0").get(first)?.shown).toBe(lastWritten);
    });
  }
});

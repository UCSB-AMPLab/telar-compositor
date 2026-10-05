/**
 * The objects page's sync check and the full sync open on the same defaults.
 * The page's check compares three ways against the commit whose
 * objects.csv D1 last accounted for (`projects.objects_read_sha`), the full
 * sync against the base it is given; with the same commit as both, each case
 * below is checked on the page (its check, then what an untouched dialog
 * posts) and on the full sync (its diff, then what an untouched modal posts).
 *
 * The route, both diffs and the record run for real against D1 in memory;
 * GitHub answers from the case's files by ref and path.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import type { FileAtRef } from "~/lib/github.server";

const PROJECT_ID = 42;
const CONVENOR = 7;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OBJECTS = "telar-content/spreadsheets/objects.csv";

let memory: MemoryD1;
/** File text by "<ref>:<path>". */
let files: Record<string, string> = {};
let commit: "exists" | "missing" = "exists";

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
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: () => drizzle(asD1(memory), { schema }) }));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
  siteChangedAnswer: vi.fn(),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
  getInstallationInfo: vi.fn(),
}));
vi.mock("~/lib/github.server", () => {
  const at = async (_t: string, _o: string, _r: string, path: string, ref: string): Promise<FileAtRef> => {
    const text = files[`${ref}:${path}`];
    return text === undefined ? { status: "absent" } : { status: "ok", content: text };
  };
  return {
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getRepoHead: vi.fn(async () => HEAD),
    getFileAtRef: vi.fn(at),
    getFileContent: vi.fn(async (t: string, o: string, r: string, path: string, ref?: string) => {
      const read = await at(t, o, r, path, ref ?? HEAD);
      return read.status === "ok" ? read.content : null;
    }),
    getSubtreeOids: vi.fn(async () => new Map()),
    listSubtreeEntries: vi.fn(async () => []),
    commitExists: vi.fn(async () => commit),
    githubHeaders: vi.fn(() => ({})),
  };
});
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn(async () => ({ ok: false })) }));
vi.mock("~/lib/page-site-gate.server", () => ({ gatePageSite: vi.fn() }));

import { action } from "~/routes/_app.objects";
import { gatePageSite } from "~/lib/page-site-gate.server";
import { computeFullSyncDiff, type FullSyncDiff, type SyncDiff } from "~/lib/sync.server";
import { buildObjectsSyncPayload, emptyObjectsSyncSelections } from "~/components/features/objects/sync-selections";
import { buildAllOrNothingChanges, buildThreeWayChanges, emptySelections } from "~/components/features/dashboard/sync-changes";

function threeWayContext() {
  return {
    get: vi.fn(() => ({ id: CONVENOR, encrypted_access_token: "enc" })),
    cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {}, GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "p" } },
  } as never;
}

function recordThreeWayBase(sha: string | null) {
  memory.raw.prepare("UPDATE projects SET objects_read_sha = ? WHERE id = ?").run(sha, PROJECT_ID);
  const project = { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5, objects_read_sha: sha };
  vi.mocked(gatePageSite).mockResolvedValue({ refused: null, page: { project, userRole: "convenor" } } as never);
}

/** The objects page's check, through its route. */
async function pageCheck(): Promise<SyncDiff> {
  const result = (await action({
    request: new Request("https://compositor.telar.org/objects", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "compute-sync-diff" }).toString(),
    }),
    context: threeWayContext(),
    params: {},
  } as never)) as { ok: boolean; diff: SyncDiff };
  expect(result.ok).toBe(true);
  return result.diff;
}

/** The full sync's diff against the same commit. */
async function fullSyncAgainstRecord(): Promise<FullSyncDiff> {
  const db = drizzle(asD1(memory), { schema });
  return computeFullSyncDiff(PROJECT_ID, "t", "owner", "repo", db, BASE, { headRef: HEAD });
}

/** What the objects page's dialog posts when the author presses Apply without touching anything. */
function pageDefaults(diff: SyncDiff) {
  return buildObjectsSyncPayload(diff, emptyObjectsSyncSelections());
}

/** What the full sync's modal posts for objects when the author resolves nothing. */
function fullDefaults(diff: FullSyncDiff) {
  return buildThreeWayChanges(diff, emptySelections()).objects;
}

function insertThreeWayCaseObject(id: number, objectId: string, fields: Record<string, string>) {
  const cols = ["id", "project_id", "object_id", "order_key", "origin", ...Object.keys(fields)];
  const vals = [id, PROJECT_ID, objectId, `a${id}`, "repo", ...Object.values(fields)];
  memory.raw.prepare(`INSERT INTO objects (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      `VALUES (${CONVENOR}, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')`,
  );
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, ${CONVENOR}, 'owner/repo', 5)`,
  );
  // An object unchanged everywhere, so each case's sheet has a row besides
  // the case's own.
  insertThreeWayCaseObject(1, "anchor", { title: "Anchor" });
  files = {};
  commit = "exists";
  recordThreeWayBase(BASE);
});

afterEach(() => {
  memory.close();
});

/** Serves objects.csv at the base and at the head, each after the anchor row. */
function serveObjects(base: string, head: string) {
  files[`${BASE}:${OBJECTS}`] = `object_id,title,creator\nanchor,Anchor,\n${base}`;
  files[`${HEAD}:${OBJECTS}`] = `object_id,title,creator\nanchor,Anchor,\n${head}`;
}

describe("an object deleted here and edited on GitHub", () => {
  beforeEach(() => {
    serveObjects("o3,Third,Ana\n", "o3,Third,Ana edited\n");
  });

  it("the objects page flags it and leaves it deleted", async () => {
    const diff = await pageCheck();
    expect(diff.newObjects).toEqual([expect.objectContaining({ object_id: "o3", deletedInCompositor: true })]);
    expect(pageDefaults(diff).newObjectIds).toEqual([]);
  });

  it("the full sync flags it and leaves it deleted", async () => {
    const diff = await fullSyncAgainstRecord();
    expect(diff.objects.newObjects).toEqual([expect.objectContaining({ object_id: "o3", deletedInCompositor: true })]);
    expect(fullDefaults(diff).newObjectIds).toEqual([]);
  });
});

describe("an object deleted on GitHub and edited here", () => {
  beforeEach(() => {
    insertThreeWayCaseObject(3, "o3", { title: "Third", creator: "Edited here" });
    serveObjects("o3,Third,Ana\n", "");
  });

  it("the objects page flags it and keeps it", async () => {
    const diff = await pageCheck();
    expect(diff.missingObjects).toEqual([expect.objectContaining({ object_id: "o3", editedInCompositor: true })]);
    expect(pageDefaults(diff).removedObjectIds).toEqual([]);
  });

  it("the full sync flags it and keeps it", async () => {
    const diff = await fullSyncAgainstRecord();
    expect(diff.objects.missingObjects).toEqual([expect.objectContaining({ object_id: "o3", editedInCompositor: true })]);
    expect(fullDefaults(diff).removedObjectIds).toEqual([]);
  });
});

describe("a field changed only in the Compositor", () => {
  beforeEach(() => {
    insertThreeWayCaseObject(3, "o3", { title: "Third", creator: "Edited here" });
    serveObjects("o3,Third,Ana\n", "o3,Third,Ana\n");
  });

  it("the objects page does not offer it as a GitHub change, and counts it", async () => {
    const diff = await pageCheck();
    expect(diff.changedObjects).toEqual([]);
    expect(diff.suppressedEditorOnly).toBe(1);
  });

  it("the full sync does not offer it either, and counts it", async () => {
    const diff = await fullSyncAgainstRecord();
    expect(diff.objects.changedObjects).toEqual([]);
    expect(diff.suppressedEditorOnly).toBe(1);
  });
});

describe("a field changed only on GitHub", () => {
  beforeEach(() => {
    insertThreeWayCaseObject(3, "o3", { title: "Third", creator: "Ana" });
    serveObjects("o3,Third,Ana\n", "o3,Third,Ana on GitHub\n");
  });

  it("the objects page takes GitHub's value", async () => {
    const diff = await pageCheck();
    expect(diff.changedObjects).toMatchObject([{ object_id: "o3", changedFields: ["creator"], conflictFields: [] }]);
    expect(pageDefaults(diff).fieldChoices).toEqual({ o3: { creator: "repo" } });
    expect(pageDefaults(diff).baseSha).toBe(BASE);
    // With the Compositor's value the check read, which the apply guards.
    expect(pageDefaults(diff).fieldsSeen).toEqual({ o3: { creator: "Ana" } });
  });

  it("the full sync takes GitHub's value", async () => {
    const diff = await fullSyncAgainstRecord();
    expect(fullDefaults(diff).fieldChoices).toEqual({ o3: { creator: "repo" } });
    expect(fullDefaults(diff).fieldsSeen).toEqual({ o3: { creator: "Ana" } });
  });
});

describe("a field both sides changed", () => {
  beforeEach(() => {
    insertThreeWayCaseObject(3, "o3", { title: "Third", creator: "Edited here" });
    serveObjects("o3,Third,Ana\n", "o3,Third,Ana on GitHub\n");
  });

  it("the objects page keeps the Compositor's value", async () => {
    const diff = await pageCheck();
    expect(diff.changedObjects).toMatchObject([{ object_id: "o3", conflictFields: ["creator"] }]);
    expect(pageDefaults(diff).fieldChoices).toEqual({ o3: { creator: "d1" } });
    expect(pageDefaults(diff).fieldsSeen).toEqual({});
  });

  it("the full sync keeps the Compositor's value", async () => {
    const diff = await fullSyncAgainstRecord();
    expect(fullDefaults(diff).fieldChoices).toEqual({ o3: { creator: "d1" } });
  });
});

describe("a field the base cannot place", () => {
  // `medium` and `object_type` are one field; the base holds both, so it
  // cannot say which value the sheet held.
  beforeEach(() => {
    insertThreeWayCaseObject(3, "o3", { title: "Third", object_type: "Painting" });
    files[`${BASE}:${OBJECTS}`] = "object_id,title,medium,object_type\nanchor,Anchor,,\no3,Third,Oil,Painting\n";
    files[`${HEAD}:${OBJECTS}`] = "object_id,title,medium\nanchor,Anchor,\no3,Third,Oil\n";
  });

  it("the objects page defaults it to GitHub's value", async () => {
    const diff = await pageCheck();
    expect(diff.changedObjects).toMatchObject([
      { object_id: "o3", conflictFields: ["object_type"], repoDefaultFields: ["object_type"] },
    ]);
    expect(pageDefaults(diff).fieldChoices).toEqual({ o3: { object_type: "repo" } });
  });

  it("the full sync defaults it to GitHub's value", async () => {
    const diff = await fullSyncAgainstRecord();
    expect(fullDefaults(diff).fieldChoices).toEqual({ o3: { object_type: "repo" } });
  });
});

describe("a base GitHub does not hold", () => {
  beforeEach(() => {
    insertThreeWayCaseObject(3, "o3", { title: "Third", creator: "Edited here" });
    files[`${HEAD}:${OBJECTS}`] = "object_id,title,creator\nanchor,Anchor,\no3,Third,Ana\n";
    commit = "missing";
  });

  it("makes the objects page's check two-way", async () => {
    const diff = await pageCheck();
    expect(diff.suppressedEditorOnly).toBeUndefined();
    expect(diff.changedObjects).toMatchObject([{ object_id: "o3", changedFields: ["creator"], conflictFields: [] }]);
  });

  it("makes the full sync two-way", async () => {
    const diff = await fullSyncAgainstRecord();
    expect(diff.classification).toBe("two-way");
    expect(diff.objects.changedObjects).toMatchObject([{ object_id: "o3", changedFields: ["creator"], conflictFields: [] }]);
    expect(buildAllOrNothingChanges(diff, emptySelections()).objects.fieldsSeen).toEqual({ o3: { creator: "Edited here" } });
  });
});

/**
 * Course items are exempt from repo sync's delete paths.
 *
 * A preloaded object is absent from `objects.csv` until the group's first
 * publish — which, on a fresh site, is all of them. Without the exemption a
 * routine full sync offers to delete the entire course collection, and a
 * convenor editing objects.csv on GitHub can remove any course item silently.
 *
 * Two delete paths, both pinned here:
 *   - `applySyncChanges` sends accepted removals through the document, by D1
 *     id, as `objects.remove`.
 *   - `resolveFullSyncPayload` routes them through the document as
 *     `objects.remove`, by D1 id, where the snapshot's orphan-delete drops
 *     the row.
 *
 * Also pinned, because the design leans on it rather than re-implementing it:
 * `origin: "compositor"` already keeps a preloaded object out of the
 * missing-from-repo flag.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
// objects.csv is read strictly at a head; the cases here state the
// sheet through getFileContent, so the strict read answers from it: null is
// a missing file.
// The mock database answers its queued rows in order; this file's applies have
// no pending object records, which have their own spec.
vi.mock("~/lib/pending-object-ops.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  completePendingObjectOps: vi.fn(async () => ({ ok: true, outcomes: new Map() })),
}));
vi.mock("~/lib/github.server", () => {
  const getFileContent = vi.fn();
  return {
    getFileContent,
    getFileAtRef: vi.fn(async (...args: unknown[]) => {
      const content = await getFileContent(...args.slice(0, 4));
      return content == null ? { status: "absent" } : { status: "ok", content };
    }),
    getRepoTree: vi.fn(),
    getRepoHead: vi.fn(),
    graphqlGitHub: vi.fn(),
    githubHeaders: vi.fn(() => ({})),
    decodeGitHubContent: vi.fn((s: string) => s),
  };
});

import * as githubServer from "~/lib/github.server";
import { syncIngestRecorder } from "./helpers/sync-ingest-recorder";
import { applySyncChanges, resolveFullSyncPayload } from "~/lib/sync.server";
import type { MockDb } from "./sync-probe-fixtures";

const PROJECT_ID = 42;
const COURSE_ID = 900;
const TOKEN = "t";
const OWNER = "o";
const REPO = "r";
/** The commit the objects check was read at, and GitHub's head at the apply. */
const CHECKED_HEAD = "d".repeat(40);

/** The owner who accepted the sync; the route resolves them server-side. */
const EXEMPTION_ACTOR_ID = 7;

/** objects.csv holding no rows — every D1 object reads as absent from the repo. */
const EMPTY_OBJECTS_CSV = "object_id,title\n";

function d1Object(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    project_id: PROJECT_ID,
    object_id: "obj-1",
    title: "An object",
    featured: false,
    creator: null,
    description: null,
    source_url: "https://iiif.example.org/manifest.json",
    period: null,
    year: null,
    object_type: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    alt_text: null,
    dimensions: null,
    extra_columns: null,
    image_available: true,
    missing_from_repo: false,
    origin: "repo",
    created_by: null,
    course_project_id: null,
    updated_at: null,
    ...overrides,
  };
}

/**
 * A mock db that records which tables were DELETEd from. Sequence-based like
 * the shared probe mocks; `deletes` counts `db.delete(...)` calls, which is
 * the whole question here (the exemption is about a delete happening at all).
 */
function deleteTrackingDb(responses: unknown[]): { db: MockDb; deletes: number } {
  const state = { deletes: 0 };
  let callIndex = 0;

  function makeResult() {
    const data = responses[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(data);
  }

  const db: Record<string, unknown> = {};
  function terminal() {
    return Object.assign(
      {
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(makeResult()).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e);
          }
        },
      },
      db,
    );
  }
  db.select = vi.fn(() => terminal());
  db.from = vi.fn(() => terminal());
  db.where = vi.fn(() => terminal());
  db.limit = vi.fn(() => terminal());
  db.orderBy = vi.fn(() => terminal());
  db.update = vi.fn(() => terminal());
  db.set = vi.fn(() => terminal());
  db.insert = vi.fn(() => terminal());
  db.values = vi.fn(() => terminal());
  db.delete = vi.fn(() => {
    state.deletes += 1;
    return terminal();
  });

  return {
    db: db as unknown as MockDb,
    get deletes() {
      return state.deletes;
    },
  } as { db: MockDb; deletes: number };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(githubServer.getFileContent).mockResolvedValue(EMPTY_OBJECTS_CSV);
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], sha: "abc" } as never);
  vi.mocked(githubServer.getRepoHead).mockResolvedValue(CHECKED_HEAD);
});

// ---------------------------------------------------------------------------
// applySyncChanges — the document-routed remove
// ---------------------------------------------------------------------------

describe("applySyncChanges — removed objects", () => {
  // Each removal names the D1 id the author was shown, as the dialog submits it.
  const removal = (removedDocIds: Record<string, number>) => ({
    newObjectIds: [],
    changedObjectIds: [],
    fieldChoices: {},
    removedObjectIds: Object.keys(removedDocIds),
    removedDocIds,
    unregisteredObjectIds: [],
    headSha: CHECKED_HEAD,
  });

  it("removes an ordinary site object through the document, by its D1 id, and deletes nothing in D1", async () => {
    const tracked = deleteTrackingDb([[d1Object({ object_id: "obj-plain" })]]);
    const ingest = syncIngestRecorder();

    const result = await applySyncChanges(
      PROJECT_ID, removal({ "obj-plain": 1 }), TOKEN, OWNER, REPO, tracked.db, ingest.env, EXEMPTION_ACTOR_ID,
    );

    expect(tracked.deletes).toBe(0);
    expect(result.appliedCount).toBe(1);
    expect(ingest.objectsArm()?.remove).toEqual([{ objectId: "obj-plain", docId: 1 }]);
  });

  it("refuses to remove a course item, however the removal was accepted", async () => {
    const tracked = deleteTrackingDb([
      [d1Object({ object_id: "obj-course", course_project_id: COURSE_ID, origin: "compositor" })],
    ]);
    const ingest = syncIngestRecorder();

    const result = await applySyncChanges(
      PROJECT_ID, removal({ "obj-course": 1 }), TOKEN, OWNER, REPO, tracked.db, ingest.env, EXEMPTION_ACTOR_ID,
    );

    // Neither half: no D1 delete, and no removal sent through the document,
    // where the snapshot's orphan sweep would take the row anyway.
    expect(tracked.deletes).toBe(0);
    expect(result.appliedCount).toBe(0);
    expect(ingest.bodies).toEqual([]);
  });

  it("exempts only the course item when a mixed batch is accepted", async () => {
    const tracked = deleteTrackingDb([
      [
        d1Object({ id: 1, object_id: "obj-plain" }),
        d1Object({ id: 2, object_id: "obj-course", course_project_id: COURSE_ID, origin: "compositor" }),
      ],
    ]);
    const ingest = syncIngestRecorder();

    await applySyncChanges(
      PROJECT_ID, removal({ "obj-plain": 1, "obj-course": 2 }), TOKEN, OWNER, REPO, tracked.db, ingest.env, EXEMPTION_ACTOR_ID,
    );

    expect(ingest.objectsArm()?.remove).toEqual([{ objectId: "obj-plain", docId: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// resolveFullSyncPayload — the document-routed remove
// ---------------------------------------------------------------------------

describe("resolveFullSyncPayload — objects.remove", () => {
  const emptyChanges = {
    objects: {
      newObjectIds: [] as string[],
      changedObjectIds: [] as string[],
      fieldChoices: {} as Record<string, Record<string, "repo" | "d1">>,
      removedObjectIds: [] as string[],
      unregisteredObjectIds: [] as string[],
    },
    stories: { accept: [] as string[], reject: [] as string[], insertNew: [] as string[], removed: [] as string[] },
    config: { accept: [] as string[], reject: [] as string[] },
    glossary: { accept: [] as string[], reject: [] as string[], insertNew: [] as string[] },
  };

  it("carries an ordinary object's removal through to the document", async () => {
    const tracked = deleteTrackingDb([[d1Object({ object_id: "obj-plain" })], []]);

    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID,
      {
        ...emptyChanges,
        objects: { ...emptyChanges.objects, removedObjectIds: ["obj-plain"], removedDocIds: { "obj-plain": 1 } },
      } as never,
      TOKEN,
      OWNER,
      REPO,
      tracked.db,
      EXEMPTION_ACTOR_ID,
    );

    expect(payload.objects.remove).toEqual([{ objectId: "obj-plain", docId: 1 }]);
  });

  it("filters a course item out of the remove list entirely", async () => {
    const tracked = deleteTrackingDb([
      [
        d1Object({ id: 1, object_id: "obj-plain" }),
        d1Object({ id: 2, object_id: "obj-course", course_project_id: COURSE_ID, origin: "compositor" }),
      ],
      [],
    ]);

    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID,
      {
        ...emptyChanges,
        objects: {
          ...emptyChanges.objects,
          removedObjectIds: ["obj-plain", "obj-course"],
          removedDocIds: { "obj-plain": 1, "obj-course": 2 },
        },
      } as never,
      TOKEN,
      OWNER,
      REPO,
      tracked.db,
      EXEMPTION_ACTOR_ID,
    );

    expect(payload.objects.remove).toEqual([{ objectId: "obj-plain", docId: 1 }]);
  });

  it("compositor origin still keeps a preloaded object out of the missing-from-repo flag", async () => {
    // The existing sync rule, pinned rather than re-implemented: a preloaded
    // object is absent from objects.csv until the first publish, and must not
    // be flagged as missing for it.
    const tracked = deleteTrackingDb([
      [
        d1Object({ id: 1, object_id: "obj-course", course_project_id: COURSE_ID, origin: "compositor" }),
        d1Object({ id: 2, object_id: "obj-repo", origin: "repo" }),
      ],
      [],
    ]);

    const { residue } = await resolveFullSyncPayload(
      PROJECT_ID,
      emptyChanges as never,
      TOKEN,
      OWNER,
      REPO,
      tracked.db,
      EXEMPTION_ACTOR_ID,
    );

    // By row id: the obj-repo row, id 2.
    expect(residue.missingFromRepoSet).toEqual([2]);
  });
});

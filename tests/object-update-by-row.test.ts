/**
 * A reviewed object change is applied to the row the author reviewed
 *
 * The sync shows each changed object with its D1 row (`ChangedObject.dbId`),
 * and the dialog submits it (`changedDocIds`). The apply sends an update only
 * while D1 holds that key with that id, naming the id on the entry, and the
 * collaboration object applies it only to the object holding both; one held
 * under the key with another id is an object re-created since the check, and
 * is left alone and answered as skipped. An apply is all or nothing:
 * an object re-created in the Compositor since the check is an edit made here,
 * and holds the whole apply back as one, naming the object and writing
 * nothing, so the apply leaves head_sha, and the next check shows GitHub's
 * change against the object that holds the key now.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as Y from "yjs";
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
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
    // No story files at either commit: the story trees conclude.
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import {
  applyFullSyncChanges,
  computeSyncDiff,
  resolveFullSyncPayload,
  ObjectsChangedSinceReview,
  type FullSyncChanges,
  type FullSyncDiff,
  type SyncChanges,
} from "~/lib/sync.server";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { buildAllOrNothingChanges, buildThreeWayChanges } from "~/components/features/dashboard/SyncConfirmModal";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { PROJECT_ID, SECRET, buildDoc, seedProject } from "./helpers/collaboration-fixture";
import { emptyThreeWaySelections } from "./sync-probe-fixtures";
import { readSeenFrom, withChoicesSeen, withDocumentSeen } from "./helpers/object-update-seen";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const USER = 1;

const BASE_SHEET = "object_id,title\no1,Base title\n";
const REPO_SHEET = "object_id,title\no1,Repo title\n";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** objects.csv at each commit. */
let sheets: Record<string, string>;

function objectRows(): Array<{ id: number; object_id: string; title: string | null }> {
  return memory.raw.prepare("SELECT id, object_id, title FROM objects ORDER BY id").all() as never;
}

function projectHeads(): { head_sha: string | null; objects_read_sha: string | null } {
  return memory.raw.prepare("SELECT head_sha, objects_read_sha FROM projects WHERE id = ?").get(PROJECT_ID) as never;
}

/** D1 deletes the object the author reviewed and holds a new one under its key. */
function recreateInD1(): void {
  memory.raw.exec("DELETE FROM objects WHERE id = 1");
  memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (2, ${PROJECT_ID}, 'o1', 'a00002', 'Again')`);
}

/** The document without o1: deleted in the Compositor, and D1 not yet told. */
function deleteInDoc(ydoc: Y.Doc): void {
  ydoc.transact(() => ydoc.getArray<Y.Map<unknown>>("objects").delete(0, 1), null);
}

/** The document's o1 replaced by a new object under the same key, D1 id `id`. */
function recreateInDoc(ydoc: Y.Doc, id: number): Y.Map<unknown> {
  const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
  const recreated = new Y.Map<unknown>();
  ydoc.transact(() => {
    objectsArray.delete(0, 1);
    recreated.set("_id", id);
    recreated.set("object_id", "o1");
    recreated.set("order_key", "a00002");
    recreated.set("title", new Y.Text("Again"));
    recreated.set("_validation_state", "valid");
    objectsArray.push([recreated]);
  }, null);
  return recreated;
}

/**
 * The author's choices, with the value a check read for each field taken
 * from GitHub: the loaded document's, or none where no document is loaded.
 */
function changes(overrides: Partial<SyncChanges> = {}): SyncChanges {
  return withChoicesSeen({
    newObjectIds: [],
    changedObjectIds: ["o1"],
    fieldChoices: { o1: { title: "repo" } },
    changedDocIds: { o1: 1 },
    removedObjectIds: [],
    unregisteredObjectIds: [],
    ...overrides,
  });
}

function fullChanges(objects: Partial<SyncChanges> = {}): FullSyncChanges {
  return {
    objects: changes(objects),
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    headSha: HEAD,
    projectId: PROJECT_ID,
    baseSha: BASE,
    storyContentChecked: true,
    // The fixture holds a page: the accept advances head_sha only over page
    // files the check read to a conclusion.
    pageContentChecked: true,
  };
}

async function loadRealDo(): Promise<{ doInstance: ProjectCollaborationDO; ydoc: Y.Doc; env: Env }> {
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(buildDoc(true), PROJECT_ID);
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
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: { idFromName: (n: string) => n, get: () => doInstance },
  } as unknown as Env;
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  readSeenFrom(ydoc);
  return { doInstance, ydoc, env };
}

async function postIngest(doInstance: ProjectCollaborationDO, body: unknown) {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, SECRET, "ingest-sync");
  const res = await doInstance.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
        "Content-Type": "application/json",
      },
      // As a check that read the document now would send it.
      body: JSON.stringify(withDocumentSeen((doInstance as unknown as { ydoc: Y.Doc }).ydoc, body)),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    applied: Record<string, number>; skipped: Record<string, string[]>; superseded: Record<string, string[]>;
  };
}

function docTitle(ydoc: Y.Doc): string {
  return String(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  readSeenFrom(null);
  memory = createMemoryD1();
  seedProject(memory, "text");
  memory.raw.prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ? WHERE id = ?").run(BASE, BASE, PROJECT_ID);
  db = drizzle(asD1(memory), { schema });
  sheets = { [BASE]: BASE_SHEET, [HEAD]: REPO_SHEET };
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
    path === OBJECTS_CSV && sheets[ref] !== undefined ? { status: "ok", content: sheets[ref] } : { status: "absent" },
  );
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe("the document applies an update with a docId only to the object holding both", () => {
  it("applies it to the object holding the key and the id", async () => {
    const { doInstance, ydoc } = await loadRealDo();

    const report = await postIngest(doInstance, { objects: { update: [{ objectId: "o1", docId: 1, fields: { title: "New" } }] } });

    expect(report.applied.objectUpdate).toBe(1);
    expect(docTitle(ydoc)).toBe("New");
  });

  it("leaves one holding the key under another id, and answers it skipped", async () => {
    const { doInstance, ydoc } = await loadRealDo();
    recreateInDoc(ydoc, 2);

    const report = await postIngest(doInstance, { objects: { update: [{ objectId: "o1", docId: 1, fields: { title: "New" } }] } });

    expect(report.applied.objectUpdate).toBe(0);
    expect(report.skipped.objectUpdate).toEqual(["o1"]);
    expect(report.superseded.objectUpdate).toEqual(["o1"]);
    expect(docTitle(ydoc)).toBe("Again");
  });

  it("answers an update to an object it does not hold as skipped, and not as re-created", async () => {
    const { doInstance, ydoc } = await loadRealDo();
    deleteInDoc(ydoc);

    const report = await postIngest(doInstance, { objects: { update: [{ objectId: "o1", docId: 1, fields: { title: "New" } }] } });

    expect(report.applied.objectUpdate).toBe(0);
    expect(report.skipped.objectUpdate).toEqual(["o1"]);
    expect(report.superseded.objectUpdate).toEqual([]);
  });

  // A sync apply's ingest is all or nothing.
  it("writes nothing, in any domain, for an all-or-nothing ingest naming a row re-created since", async () => {
    const { doInstance, ydoc } = await loadRealDo();
    recreateInDoc(ydoc, 2);
    const glossaryTitle = () => String(ydoc.getArray<Y.Map<unknown>>("glossary").get(0).get("title"));
    const before = glossaryTitle();

    const report = await postIngest(doInstance, {
      allOrNothing: true,
      objects: { update: [{ objectId: "o1", docId: 1, fields: { title: "New" } }] },
      glossary: { update: [{ termId: "t1", title: "From GitHub" }], insert: [] },
    }) as { heldBack?: boolean; superseded: Record<string, string[]>; applied: Record<string, number> };

    expect(report.heldBack).toBe(true);
    expect(report.superseded.objectUpdate).toEqual(["o1"]);
    expect(report.applied.glossaryUpdate).toBe(0);
    expect(glossaryTitle()).toBe(before);
    expect(docTitle(ydoc)).toBe("Again");
  });

  it.each([
    ["an order entry", { order: [{ objectId: "o1", docId: 1 }] }, "objectOrder"],
    ["a removal", { remove: [{ objectId: "o1", docId: 1 }] }, "removal"],
  ])("writes nothing for an all-or-nothing ingest when %s names a row re-created since", async (_what, arm, answered) => {
    const { doInstance, ydoc } = await loadRealDo();
    recreateInDoc(ydoc, 2);
    const glossaryTitleNow = () => String(ydoc.getArray<Y.Map<unknown>>("glossary").get(0).get("title"));
    const before = glossaryTitleNow();

    const report = await postIngest(doInstance, {
      allOrNothing: true,
      objects: { update: [], insert: [], remove: [], ...arm },
      glossary: { update: [{ termId: "t1", title: "From GitHub" }], insert: [] },
    }) as unknown as { heldBack?: boolean; superseded: Record<string, string[]>; removals: { superseded: string[] } };

    expect(report.heldBack).toBe(true);
    expect(answered === "removal" ? report.removals.superseded : report.superseded.objectOrder).toEqual(["o1"]);
    expect(glossaryTitleNow()).toBe(before);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").length).toBe(1);
  });

  // A page deleted in the Compositor since the check: found missing while the
  // content is planned, before any write.
  it("writes nothing for an all-or-nothing ingest replacing a page the document no longer holds", async () => {
    const { doInstance, ydoc } = await loadRealDo();
    const glossaryTitleHeld = () => String(ydoc.getArray<Y.Map<unknown>>("glossary").get(0).get("title"));
    const before = glossaryTitleHeld();

    const report = await postIngest(doInstance, {
      allOrNothing: true,
      pages: { insert: [], replaceContent: [{ pageId: 999, expected: "hash-reviewed", title: "T", body: "B", frontmatter: "" }] },
      glossary: { update: [{ termId: "t1", title: "From GitHub" }], insert: [] },
    }) as unknown as { heldBack?: boolean; pageContent: { failed: number[] } };

    expect(report.heldBack).toBe(true);
    expect(report.pageContent.failed).toEqual([999]);
    expect(glossaryTitleHeld()).toBe(before);
  });

  it("applies an update without a docId by key, as before", async () => {
    const { doInstance, ydoc } = await loadRealDo();
    recreateInDoc(ydoc, 2);

    const report = await postIngest(doInstance, { objects: { update: [{ objectId: "o1", fields: { title: "New" } }] } });

    expect(report.applied.objectUpdate).toBe(1);
    expect(docTitle(ydoc)).toBe("New");
  });
});

// ---------------------------------------------------------------------------
// The full sync's apply
// ---------------------------------------------------------------------------

describe("the full sync's apply updates the row the author reviewed", () => {
  it("sends the update by D1 id while D1 holds that row", async () => {
    const { payload, updatesNotSent } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER);
    expect(payload.objects.update).toEqual([{ objectId: "o1", docId: 1, fields: { title: "Repo title" }, seen: { title: null } }]);
    expect(updatesNotSent).toEqual([]);
  });

  it("sends nothing for an object re-created under the same key since the check", async () => {
    recreateInD1();
    const { payload, updatesNotSent } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER);
    expect(payload.objects.update).toEqual([]);
    expect(updatesNotSent).toEqual(["o1"]);
  });

  it("sends nothing for a choice that names no D1 id", async () => {
    const { payload, updatesNotSent } = await resolveFullSyncPayload(
      PROJECT_ID, fullChanges({ changedDocIds: undefined }), "t", "o", "r", db, USER,
    );
    expect(payload.objects.update).toEqual([]);
    expect(updatesNotSent).toEqual(["o1"]);
  });

  it("advances head_sha when the update is applied", async () => {
    const { ydoc, env } = await loadRealDo();

    const res = await applyFullSyncChanges(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER, env);

    expect(docTitle(ydoc)).toBe("Repo title");
    expect(res.newHeadSha).toBe(HEAD);
    expect(projectHeads()).toEqual({ head_sha: HEAD, objects_read_sha: HEAD });
  });

  it("advances head_sha when the document no longer holds the object", async () => {
    const { ydoc, env } = await loadRealDo();
    deleteInDoc(ydoc);

    const res = await applyFullSyncChanges(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER, env);

    expect(res.newHeadSha).toBe(HEAD);
    expect(projectHeads()).toEqual({ head_sha: HEAD, objects_read_sha: HEAD });
  });

  it("refuses the object as edited here, holding head_sha, when the document holds the object re-created", async () => {
    const { ydoc, env } = await loadRealDo();
    recreateInDoc(ydoc, 2);

    await expect(applyFullSyncChanges(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER, env))
      .rejects.toMatchObject({ name: "ObjectsChangedSinceReview", objectIds: ["o1"] });

    expect(docTitle(ydoc)).toBe("Again");
    expect(projectHeads()).toEqual({ head_sha: BASE, objects_read_sha: BASE });
  });

  it("holds head_sha for an object re-created since the check, and the next check shows GitHub's change against it", async () => {
    const { ydoc, env } = await loadRealDo();
    recreateInDoc(ydoc, 2);
    recreateInD1();

    const refusal = await applyFullSyncChanges(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER, env).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ObjectsChangedSinceReview);
    expect((refusal as ObjectsChangedSinceReview).objectIds).toEqual(["o1"]);

    expect(objectRows()).toEqual([{ id: 2, object_id: "o1", title: "Again" }]);
    const held = projectHeads().head_sha!;
    expect(held).toBe(BASE);
    // The next check compares against the head still recorded.
    const next = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, sheets[held], HEAD);
    expect(next.changedObjects.map((c) => [c.object_id, c.dbId, c.repoValues.title])).toEqual([["o1", 2, "Repo title"]]);
    // Recorded as read, GitHub's change is the base, and the re-created
    // object's difference from it reads as the editor's own.
    const hidden = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, sheets[HEAD], HEAD);
    expect(hidden.changedObjects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The dialogs
// ---------------------------------------------------------------------------

describe("the full-sync dialog submits the D1 id each changed object was shown with", () => {
  const diff = {
    objects: {
      newObjects: [],
      changedObjects: [
        { object_id: "c1", dbId: 4, title: "One", changedFields: ["title"], conflictFields: [], d1Values: {}, repoValues: {} },
        { object_id: "c2", dbId: 9, title: "Two", changedFields: ["creator"], conflictFields: ["creator"], d1Values: {}, repoValues: {} },
      ],
      missingObjects: [],
      unregisteredFiles: [],
    },
    stories: { newStories: [], changedStories: [], missingStories: [] },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], removed: [], changed: [] },
    hasConflicts: true,
    classification: "three-way",
    suppressedEditorOnly: 0,
  } as unknown as FullSyncDiff;

  it("in a three-way sync", () => {
    const built = buildThreeWayChanges(diff, emptyThreeWaySelections());
    expect(built.objects.changedDocIds).toEqual({ c1: 4, c2: 9 });
  });

  it("in an all-or-nothing sync", () => {
    const built = buildAllOrNothingChanges(diff, emptyThreeWaySelections());
    expect(built.objects.changedDocIds).toEqual({ c1: 4, c2: 9 });
  });
});

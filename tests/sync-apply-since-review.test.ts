/**
 * A sync apply does not overwrite a change made after its check.
 *
 * Both applies check the base again under the operation lease, before their
 * first write: an apply that landed between the first check and the lease
 * has moved it, and the apply is refused with nothing written. And each field
 * taken from GitHub carries the Compositor's value the check read (`seen`):
 * the collaboration object leaves a field whose value differs, answers the
 * object as changed since the review, and the apply keeps its record, so the
 * next check offers the field again.
 *
 * @version v1.5.0-beta
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
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import {
  applyFullSyncChanges,
  applySyncChanges,
  ObjectsChangedSinceReview,
  StoryContentNotApplied,
  SyncBaseStale,
  type FullSyncChanges,
  type SyncChanges,
} from "~/lib/sync.server";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { contentRefusal } from "~/lib/sync-apply-refusal.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { fieldsUnchangedSinceReview } from "../workers/object-seen-fields";
import { PROJECT_ID, SECRET, buildDoc, seedProject, seededText } from "./helpers/collaboration-fixture";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const MOVED = "d".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const USER = 1;
const SEEN_TITLE = seededText("objects", "title");

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

function sinceReviewHeads(): { head_sha: string | null; objects_read_sha: string | null } {
  return memory.raw.prepare("SELECT head_sha, objects_read_sha FROM projects WHERE id = ?").get(PROJECT_ID) as never;
}

function sinceReviewD1Title(): string | null {
  return (memory.raw.prepare("SELECT title FROM objects WHERE id = 1").get() as { title: string | null }).title;
}

function sinceReviewChanges(overrides: Partial<SyncChanges> = {}): SyncChanges {
  return {
    newObjectIds: [],
    changedObjectIds: ["o1"],
    fieldChoices: { o1: { title: "repo" } },
    fieldsSeen: { o1: { title: SEEN_TITLE } },
    changedDocIds: { o1: 1 },
    removedObjectIds: [],
    unregisteredObjectIds: [],
    headSha: HEAD,
    baseSha: BASE,
    ...overrides,
  };
}

function sinceReviewFullChanges(objects: Partial<SyncChanges> = {}): FullSyncChanges {
  return {
    objects: sinceReviewChanges({ baseSha: undefined, ...objects }),
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    headSha: HEAD,
    projectId: PROJECT_ID,
    baseSha: BASE,
    storyContentChecked: true,
    pageContentChecked: true,
  };
}

/** A collaboration binding that records each ingest and applies nothing. */
function recordingCollaboration() {
  const bodies: unknown[] = [];
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          bodies.push(JSON.parse(await req.text()));
          return Response.json({ applied: {} });
        },
      }),
    },
  } as unknown as Env;
  return { env, bodies };
}

async function loadSinceReviewDo(): Promise<{ ydoc: Y.Doc; env: Env }> {
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
  // The document as the check read it: its title is D1's.
  setSinceReviewDocTitle(ydoc, SEEN_TITLE);
  return { ydoc, env };
}

/** Sets the document's o1 title, as the check read it or as edited in the Compositor after it. */
function setSinceReviewDocTitle(ydoc: Y.Doc, title: string): void {
  const text = ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title") as Y.Text;
  ydoc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, title);
  }, null);
}

function sinceReviewDocTitle(ydoc: Y.Doc): string {
  return String(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title"));
}

/** The lease, once taken, finds the record `column` moved to MOVED by an apply that landed first. */
function moveOnLease(column: "head_sha" | "objects_read_sha"): void {
  vi.mocked(controlFreezeLease).mockImplementation(async (_env, _project, _user, op) => {
    if ((op as { op: string }).op === "begin") {
      memory.raw.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(MOVED, PROJECT_ID);
    }
    return "applied";
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(controlFreezeLease).mockImplementation(async () => "applied");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  seedProject(memory, "text");
  memory.raw.prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ? WHERE id = ?").run(BASE, BASE, PROJECT_ID);
  db = drizzle(asD1(memory), { schema });
  const sheets: Record<string, string> = {
    [BASE]: `object_id,title\no1,${SEEN_TITLE}\n`,
    [HEAD]: "object_id,title\no1,Repo title\n",
  };
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
    path === OBJECTS_CSV && sheets[ref] !== undefined ? { status: "ok", content: sheets[ref] } : { status: "absent" },
  );
});

afterEach(() => {
  memory.close();
});

describe("the base, checked again under the lease", () => {
  it("refuses the objects page's apply, writing nothing, when objects_read_sha moved before the lease", async () => {
    moveOnLease("objects_read_sha");
    const { env, bodies } = recordingCollaboration();

    await expect(applySyncChanges(PROJECT_ID, sinceReviewChanges(), "t", "o", "r", db, env, USER))
      .rejects.toBeInstanceOf(SyncBaseStale);
    expect(bodies).toEqual([]);
    expect(sinceReviewD1Title()).toBe(SEEN_TITLE);
    expect(sinceReviewHeads().objects_read_sha).toBe(MOVED);
  });

  it("refuses the full sync's apply, writing nothing, when head_sha moved before the lease", async () => {
    moveOnLease("head_sha");
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ${PROJECT_ID}, 'gone', 'a00002', 'Gone', 'repo')`);
    const { env, bodies } = recordingCollaboration();

    await expect(applyFullSyncChanges(PROJECT_ID, sinceReviewFullChanges(), "t", "o", "r", db, USER, env))
      .rejects.toBeInstanceOf(SyncBaseStale);
    expect(bodies).toEqual([]);
    expect(sinceReviewD1Title()).toBe(SEEN_TITLE);
    const gone = memory.raw.prepare("SELECT missing_from_repo FROM objects WHERE id = 2").get() as { missing_from_repo: number };
    expect(gone.missing_from_repo).toBe(0);
    expect(sinceReviewHeads().head_sha).toBe(MOVED);
  });
});

describe("a field taken from GitHub with no value the check read", () => {
  it("refuses the objects page's apply before the lease, writing nothing", async () => {
    const { env, bodies } = recordingCollaboration();
    await expect(applySyncChanges(PROJECT_ID, sinceReviewChanges({ fieldsSeen: undefined }), "t", "o", "r", db, env, USER))
      .rejects.toBeInstanceOf(SyncBaseStale);
    expect(bodies).toEqual([]);
    expect(controlFreezeLease).not.toHaveBeenCalled();
  });

  it("refuses the full sync's apply before the lease, writing nothing", async () => {
    const { env, bodies } = recordingCollaboration();
    await expect(applyFullSyncChanges(
      PROJECT_ID, sinceReviewFullChanges({ fieldsSeen: { o1: {} } }), "t", "o", "r", db, USER, env,
    )).rejects.toBeInstanceOf(SyncBaseStale);
    expect(bodies).toEqual([]);
    expect(controlFreezeLease).not.toHaveBeenCalled();
  });
});

describe("the record of what the objects apply read", () => {
  it("moves before the lease is released, so the next apply to take it finds it moved", async () => {
    let recordAtRelease: string | null = null;
    vi.mocked(controlFreezeLease).mockImplementation(async (_env, _project, _user, op) => {
      if ((op as { op: string }).op === "end") recordAtRelease = sinceReviewHeads().objects_read_sha;
      return "applied";
    });
    const { env } = recordingCollaboration();

    const first = await applySyncChanges(PROJECT_ID, sinceReviewChanges(), "t", "o", "r", db, env, USER);
    expect(first.readRecorded).toBe(true);
    expect(recordAtRelease).toBe(HEAD);

    await expect(applySyncChanges(PROJECT_ID, sinceReviewChanges(), "t", "o", "r", db, env, USER))
      .rejects.toBeInstanceOf(SyncBaseStale);
  });

  it("answers that it was not recorded when another writer moved it first", async () => {
    const { env } = recordingCollaboration();
    // A writer outside the lease moves the record once the apply has passed
    // its check under the lease: here, when the ingest is sent.
    const moving = {
      ...env,
      COLLABORATION: {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async () => {
            memory.raw.prepare("UPDATE projects SET objects_read_sha = ? WHERE id = ?").run(MOVED, PROJECT_ID);
            return Response.json({ applied: {} });
          },
        }),
      },
    } as unknown as Env;

    const res = await applySyncChanges(PROJECT_ID, sinceReviewChanges(), "t", "o", "r", db, moving, USER);
    expect(res.readRecorded).toBe(false);
    expect(sinceReviewHeads().objects_read_sha).toBe(MOVED);
  });
});

describe("a field edited in the Compositor after the check", () => {
  it("the objects page's apply leaves it, answers the object, and does not count the update as applied", async () => {
    const { ydoc, env } = await loadSinceReviewDo();
    setSinceReviewDocTitle(ydoc, "Edited here");

    const res = await applySyncChanges(PROJECT_ID, sinceReviewChanges(), "t", "o", "r", db, env, USER);

    expect(sinceReviewDocTitle(ydoc)).toBe("Edited here");
    expect(res.changedSinceReview).toEqual(["o1"]);
    expect(res.updateSkipped).toBe(true);
  });

  it("the objects page's apply takes GitHub's value while the field is as the check read it", async () => {
    const { ydoc, env } = await loadSinceReviewDo();

    const res = await applySyncChanges(PROJECT_ID, sinceReviewChanges(), "t", "o", "r", db, env, USER);

    expect(sinceReviewDocTitle(ydoc)).toBe("Repo title");
    expect(res.changedSinceReview).toEqual([]);
    expect(res.updateSkipped).toBe(false);
  });

  it("the full sync's apply leaves it, keeps head_sha, and answers the object", async () => {
    const { ydoc, env } = await loadSinceReviewDo();
    setSinceReviewDocTitle(ydoc, "Edited here");

    const refusal = await applyFullSyncChanges(PROJECT_ID, sinceReviewFullChanges(), "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ObjectsChangedSinceReview);
    expect((refusal as ObjectsChangedSinceReview).objectIds).toEqual(["o1"]);
    expect(sinceReviewDocTitle(ydoc)).toBe("Edited here");
    expect(sinceReviewHeads().head_sha).toBe(BASE);
    expect(contentRefusal(refusal)).toEqual({
      ok: false, intent: "apply-full-sync", error: "object_changed_since_review", objectIds: ["o1"],
    });
  });

  it("the full sync's apply takes GitHub's value while the field is as the check read it", async () => {
    const { ydoc, env } = await loadSinceReviewDo();

    const res = await applyFullSyncChanges(PROJECT_ID, sinceReviewFullChanges(), "t", "o", "r", db, USER, env);

    expect(sinceReviewDocTitle(ydoc)).toBe("Repo title");
    expect(res.newHeadSha).toBe(HEAD);
  });
});

describe("the document's comparison with the value the check read", () => {
  function sinceReviewMap(values: Record<string, unknown>): Y.Map<unknown> {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("object");
    for (const [key, value] of Object.entries(values)) map.set(key, value);
    return map;
  }

  it("reads an absent or null value as empty, and featured as a boolean", () => {
    const map = sinceReviewMap({ title: new Y.Text(""), featured: false });
    const kept = fieldsUnchangedSinceReview(map, {
      fields: { title: "New", featured: true, creator: "Ana" },
      seen: { title: null, featured: false, creator: null },
    });
    expect(kept).toEqual({ fields: { title: "New", featured: true, creator: "Ana" }, changed: false });
  });

  it("leaves a field whose value differs, and one with no value read", () => {
    const map = sinceReviewMap({ title: new Y.Text("Edited"), source_url: "https://a" });
    const kept = fieldsUnchangedSinceReview(map, {
      fields: { title: "New", source_url: "https://b", credit: "C" },
      seen: { title: "Old", source_url: "https://a" },
    });
    expect(kept).toEqual({ fields: { source_url: "https://b" }, changed: true });
  });
});

// An apply is all or nothing: a field it may not take, or a row
// re-created since the check, holds the whole apply back, so the record is
// either the commit applied or where it was, and no field is written from a
// commit the record does not name.
describe("an apply that cannot take everything it was sent", () => {
  const SEEN_CREATOR = seededText("objects", "creator");

  /** GitHub's head changes o1's title and creator; the check read both as D1 held them. */
  function serveTitleAndCreator(): void {
    const sheets: Record<string, string> = {
      [BASE]: `object_id,title,creator\no1,${SEEN_TITLE},${SEEN_CREATOR}\n`,
      [HEAD]: "object_id,title,creator\no1,Repo title,Repo creator\n",
    };
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
      path === OBJECTS_CSV && sheets[ref] !== undefined ? { status: "ok", content: sheets[ref] } : { status: "absent" },
    );
  }

  const bothFields = {
    fieldChoices: { o1: { title: "repo" as const, creator: "repo" as const } },
    fieldsSeen: { o1: { title: SEEN_TITLE, creator: SEEN_CREATOR } },
  };

  function heldDocCreator(ydoc: Y.Doc): string {
    return String(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("creator"));
  }

  /** The collaboration object as the check read it: o1's creator is D1's too. */
  async function loadHeldDo(): Promise<{ ydoc: Y.Doc; env: Env }> {
    const loaded = await loadSinceReviewDo();
    const text = loaded.ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("creator") as Y.Text;
    loaded.ydoc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, SEEN_CREATOR);
    }, null);
    return loaded;
  }

  it("the objects page's apply writes no field when one changed since the check, and keeps its record", async () => {
    serveTitleAndCreator();
    const { ydoc, env } = await loadHeldDo();
    setSinceReviewDocTitle(ydoc, "Edited here");

    const res = await applySyncChanges(PROJECT_ID, sinceReviewChanges(bothFields), "t", "o", "r", db, env, USER);

    expect(res.changedSinceReview).toEqual(["o1"]);
    expect(res.appliedCount).toBe(0);
    expect(sinceReviewDocTitle(ydoc)).toBe("Edited here");
    expect(heldDocCreator(ydoc)).toBe(SEEN_CREATOR);
    expect(sinceReviewHeads().objects_read_sha).toBe(BASE);
  });

  it("the full sync's apply writes nothing, in any domain, when an object's field changed since the check", async () => {
    serveTitleAndCreator();
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ${PROJECT_ID}, 'gone', 'a00002', 'Gone', 'repo')`);
    const { ydoc, env } = await loadHeldDo();
    setSinceReviewDocTitle(ydoc, "Edited here");

    const refusal = await applyFullSyncChanges(PROJECT_ID, sinceReviewFullChanges(bothFields), "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ObjectsChangedSinceReview);
    expect(heldDocCreator(ydoc)).toBe(SEEN_CREATOR);
    const gone = memory.raw.prepare("SELECT missing_from_repo FROM objects WHERE id = 2").get() as { missing_from_repo: number };
    expect(gone.missing_from_repo).toBe(0);
    expect(sinceReviewHeads().head_sha).toBe(BASE);
  });

  it("the full sync's apply writes no object field when a story's content changed since the check", async () => {
    serveTitleAndCreator();
    const { ydoc, env } = await loadHeldDo();
    const content = "step,object,question,answer\n1,o1,Q1,A1\n";
    const objectsAndStory = vi.mocked(getFileAtRef).getMockImplementation()!;
    vi.mocked(getFileAtRef).mockImplementation(async (t, o, r, path, ref, options) =>
      path === "telar-content/spreadsheets/s1.csv" && ref === HEAD
        ? { status: "ok", content }
        : objectsAndStory(t, o, r, path, ref, options),
    );
    const changes = sinceReviewFullChanges({ fieldChoices: { o1: { creator: "repo" } }, fieldsSeen: { o1: { creator: SEEN_CREATOR } } });
    // The check hashed the story as it then stood; it has been edited since.
    changes.stories = { ...changes.stories, acceptContent: ["s1"], contentExpected: { s1: "hash-reviewed" } };

    const refusal = await applyFullSyncChanges(PROJECT_ID, changes, "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(StoryContentNotApplied);
    expect((refusal as StoryContentNotApplied).changedSinceReview).toEqual(["s1"]);
    expect(heldDocCreator(ydoc)).toBe(SEEN_CREATOR);
    expect(sinceReviewHeads().head_sha).toBe(BASE);
  });

  // Deleted in the Compositor since the check: the collaboration object finds
  // no story to replace the content of while it plans, before any write.
  it("the full sync's apply writes no object field when a story was deleted since the check", async () => {
    serveTitleAndCreator();
    const { ydoc, env } = await loadHeldDo();
    const content = "step,object,question,answer\n1,o1,Q1,A1\n";
    const objectsAndStory = vi.mocked(getFileAtRef).getMockImplementation()!;
    vi.mocked(getFileAtRef).mockImplementation(async (t, o, r, path, ref, options) =>
      path === "telar-content/spreadsheets/s1.csv" && ref === HEAD
        ? { status: "ok", content }
        : objectsAndStory(t, o, r, path, ref, options),
    );
    ydoc.transact(() => ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1), null);
    const changes = sinceReviewFullChanges({ fieldChoices: { o1: { creator: "repo" } }, fieldsSeen: { o1: { creator: SEEN_CREATOR } } });
    changes.stories = { ...changes.stories, acceptContent: ["s1"], contentExpected: { s1: "hash-reviewed" } };

    const refusal = await applyFullSyncChanges(PROJECT_ID, changes, "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(StoryContentNotApplied);
    expect((refusal as StoryContentNotApplied).changedSinceReview).toEqual(["s1"]);
    expect(heldDocCreator(ydoc)).toBe(SEEN_CREATOR);
    expect(sinceReviewHeads().head_sha).toBe(BASE);
  });
});

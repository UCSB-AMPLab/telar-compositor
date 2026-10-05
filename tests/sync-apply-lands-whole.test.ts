/**
 * A sync apply lands whole or not at all, write failures included.
 *
 * An object insert D1 would refuse for a cause the payload shows (a row over
 * D1's row size), and an entry the ingest's boundary refuses as malformed,
 * hold the whole all-or-nothing ingest back before anything is written, and
 * neither apply moves its record. An insert D1 refuses only at the flush has
 * landed beside the rest of the ingest: neither apply then records the commit,
 * and both name the row as not added.
 *
 * These run the real applies against the real collaboration object and an
 * in-memory database.
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
  InsertsNotAdded,
  ObjectsNotAdded,
  SyncEntriesRefused,
  type FullSyncChanges,
  type SyncChanges,
} from "~/lib/sync.server";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { contentRefusal } from "~/lib/sync-apply-refusal.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { PROJECT_ID, SECRET, buildDoc, seedProject, seededText } from "./helpers/collaboration-fixture";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const GLOSSARY_CSV = "telar-content/spreadsheets/glossary.csv";
const USER = 1;
const SEEN_TITLE = seededText("objects", "title");
/** Past D1's 2,000,000-byte row, in one cell. */
const OVERSIZED = "x".repeat(2_000_001);

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ydoc: Y.Doc;
let env: Env;
/** Changes each ingest body before the collaboration object reads it, when set. */
let rewriteIngest: ((body: Record<string, unknown>) => void) | null;

function landsWholeHeads(): { head_sha: string | null; objects_read_sha: string | null } {
  return memory.raw.prepare("SELECT head_sha, objects_read_sha FROM projects WHERE id = ?").get(PROJECT_ID) as never;
}

function landsWholeRow(objectId: string): { title: string | null } | undefined {
  return memory.raw
    .prepare("SELECT title FROM objects WHERE project_id = ? AND object_id = ?")
    .get(PROJECT_ID, objectId) as never;
}

function landsWholeDocTitle(objectId: string): string | undefined {
  const map = ydoc.getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("object_id") === objectId);
  return map === undefined ? undefined : String(map.get("title"));
}

/** GitHub's head: o1 retitled, and a new row o2 titled `newTitle`. */
function serveHead(newTitle: string): void {
  const sheets: Record<string, string> = {
    [BASE]: `object_id,title\no1,${SEEN_TITLE}\n`,
    [HEAD]: `object_id,title\no1,Repo title\no2,${newTitle}\n`,
  };
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
    path === OBJECTS_CSV && sheets[ref] !== undefined ? { status: "ok", content: sheets[ref] } : { status: "absent" },
  );
}

/** GitHub's head holds one glossary term, `t9`, that the Compositor does not. */
function serveGlossaryTerm(): void {
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) =>
    path === GLOSSARY_CSV
      ? { status: "ok", content: "term_id,title,definition\nt9,Weft,Cross threads\n" }
      : { status: "absent" },
  );
}

/** A full sync that accepts only the glossary term `t9`. */
function glossaryOnlyFullChanges(): FullSyncChanges {
  return {
    objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, fieldsSeen: {}, changedDocIds: {}, removedObjectIds: [], unregisteredObjectIds: [], headSha: HEAD },
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: ["t9"] },
    headSha: HEAD,
    projectId: PROJECT_ID,
    baseSha: BASE,
    storyContentChecked: true,
    pageContentChecked: true,
  };
}

function landsWholeChanges(): SyncChanges {
  return {
    newObjectIds: ["o2"],
    changedObjectIds: ["o1"],
    fieldChoices: { o1: { title: "repo" } },
    fieldsSeen: { o1: { title: SEEN_TITLE } },
    changedDocIds: { o1: 1 },
    removedObjectIds: [],
    unregisteredObjectIds: [],
    headSha: HEAD,
    baseSha: BASE,
  };
}

function landsWholeFullChanges(): FullSyncChanges {
  return {
    objects: { ...landsWholeChanges(), baseSha: undefined },
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

/** D1 refuses o2's INSERT, as it refuses a row only the write itself finds wrong. */
function refuseO2AtTheFlush(): void {
  memory.raw.exec(
    "CREATE TRIGGER refuse_o2 BEFORE INSERT ON objects WHEN NEW.object_id = 'o2' BEGIN SELECT RAISE(ABORT, 'refused'); END",
  );
}

/** An object insert the boundary refuses as malformed: its identity is empty. */
function addMalformedInsert(body: Record<string, unknown>): void {
  const objects = body.objects as { insert?: unknown[] };
  objects.insert = [...(objects.insert ?? []), { object_id: "", created_by: USER }];
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  rewriteIngest = null;
  memory = createMemoryD1();
  seedProject(memory, "text");
  memory.raw
    .prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ?, yjs_state = ? WHERE id = ?")
    .run(BASE, BASE, buildDoc(true), PROJECT_ID);
  db = drizzle(asD1(memory), { schema });
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  serveHead("From GitHub");

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
  ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  const title = ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title") as Y.Text;
  ydoc.transact(() => {
    title.delete(0, title.length);
    title.insert(0, SEEN_TITLE);
  }, null);
  const stub = {
    fetch: async (req: Request) => {
      if (!rewriteIngest) return doInstance.fetch(req);
      const body = (await req.json()) as Record<string, unknown>;
      rewriteIngest(body);
      return doInstance.fetch(new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body) }));
    },
  };
  env = { SESSION_SECRET: SECRET, COLLABORATION: { idFromName: (n: string) => n, get: () => stub } } as unknown as Env;
});

afterEach(() => {
  memory.close();
});

describe("an insert D1 refuses only at the flush", () => {
  it("the full sync keeps head_sha and objects_read_sha and names the row as not added", async () => {
    refuseO2AtTheFlush();

    const refusal = await applyFullSyncChanges(PROJECT_ID, landsWholeFullChanges(), "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ObjectsNotAdded);
    expect((refusal as ObjectsNotAdded).objectIds).toEqual(["o2"]);
    expect(landsWholeRow("o2")).toBeUndefined();
    expect(landsWholeHeads()).toEqual({ head_sha: BASE, objects_read_sha: BASE });
    expect(contentRefusal(refusal)).toEqual({
      ok: false, intent: "apply-full-sync", error: "objects_not_added", objectIds: ["o2"],
    });
  });

  it("the full sync keeps head_sha and objects_read_sha over a glossary term D1 refused", async () => {
    serveGlossaryTerm();
    memory.raw.exec(
      "CREATE TRIGGER refuse_t9 BEFORE INSERT ON glossary_terms WHEN NEW.term_id = 't9' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );

    const refusal = await applyFullSyncChanges(PROJECT_ID, glossaryOnlyFullChanges(), "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);

    expect(memory.raw.prepare("SELECT 1 AS x FROM glossary_terms WHERE term_id = 't9'").get()).toBeUndefined();
    expect(landsWholeHeads()).toEqual({ head_sha: BASE, objects_read_sha: BASE });
    expect(refusal).toBeInstanceOf(InsertsNotAdded);
    expect((refusal as InsertsNotAdded).failed).toEqual({ glossaryInsert: ["t9"] });
    expect(contentRefusal(refusal)).toMatchObject({ ok: false, intent: "apply-full-sync", error: "inserts_not_added" });
  });

  it("the objects page keeps objects_read_sha and names the row as not added", async () => {
    refuseO2AtTheFlush();

    const res = await applySyncChanges(PROJECT_ID, landsWholeChanges(), "t", "o", "r", db, env, USER);

    expect(res.notAdded).toEqual(["o2"]);
    expect(landsWholeRow("o2")).toBeUndefined();
    expect(landsWholeHeads().objects_read_sha).toBe(BASE);
  });
});

describe("an insert over D1's row size, known before the write", () => {
  it("holds the objects page's apply back whole and keeps its record", async () => {
    serveHead(OVERSIZED);

    const refusal = await applySyncChanges(PROJECT_ID, landsWholeChanges(), "t", "o", "r", db, env, USER)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(SyncEntriesRefused);
    expect(landsWholeDocTitle("o1")).toBe(SEEN_TITLE);
    expect(landsWholeDocTitle("o2")).toBeUndefined();
    expect(landsWholeRow("o2")).toBeUndefined();
    expect(landsWholeHeads().objects_read_sha).toBe(BASE);
  });

  it("holds the full sync back whole and keeps head_sha", async () => {
    serveHead(OVERSIZED);

    const refusal = await applyFullSyncChanges(PROJECT_ID, landsWholeFullChanges(), "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(SyncEntriesRefused);
    expect(landsWholeDocTitle("o1")).toBe(SEEN_TITLE);
    expect(landsWholeDocTitle("o2")).toBeUndefined();
    expect(landsWholeRow("o1")?.title).not.toBe("Repo title");
    expect(landsWholeHeads()).toEqual({ head_sha: BASE, objects_read_sha: BASE });
  });
});

describe("an entry the ingest's boundary refuses as malformed", () => {
  it("holds the objects page's apply back whole and keeps its record", async () => {
    rewriteIngest = addMalformedInsert;

    const refusal = await applySyncChanges(PROJECT_ID, landsWholeChanges(), "t", "o", "r", db, env, USER)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(SyncEntriesRefused);
    expect(landsWholeDocTitle("o1")).toBe(SEEN_TITLE);
    expect(landsWholeDocTitle("o2")).toBeUndefined();
    expect(landsWholeRow("o2")).toBeUndefined();
    expect(landsWholeHeads().objects_read_sha).toBe(BASE);
  });

  it("holds the full sync back whole and keeps head_sha", async () => {
    rewriteIngest = addMalformedInsert;

    const refusal = await applyFullSyncChanges(PROJECT_ID, landsWholeFullChanges(), "t", "o", "r", db, USER, env)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(SyncEntriesRefused);
    expect(contentRefusal(refusal)).toMatchObject({ ok: false, intent: "apply-full-sync", error: "entries_refused" });
    expect(landsWholeDocTitle("o1")).toBe(SEEN_TITLE);
    expect(landsWholeDocTitle("o2")).toBeUndefined();
    expect(landsWholeRow("o2")).toBeUndefined();
    expect(landsWholeHeads()).toEqual({ head_sha: BASE, objects_read_sha: BASE });
  });

  it("is answered by the collaboration object as held back, naming the entry by position", async () => {
    const res = await env.COLLABORATION.get(env.COLLABORATION.idFromName(String(PROJECT_ID))).fetch(
      await landsWholeIngestRequest({
        objects: {
          update: [{ objectId: "o1", docId: 1, fields: { title: "Repo title" }, seen: { title: SEEN_TITLE } }],
          insert: [{ object_id: "", created_by: USER }],
        },
        allOrNothing: true,
      }),
    );
    const answer = (await res.json()) as { heldBack?: boolean; refused?: { objectInsert?: number[] } };

    expect(answer.heldBack).toBe(true);
    expect(answer.refused?.objectInsert).toEqual([0]);
    expect(landsWholeDocTitle("o1")).toBe(SEEN_TITLE);
  });
});

/** An `/ingest-sync` request as the applies send one. */
async function landsWholeIngestRequest(body: object): Promise<Request> {
  const { makeInternalMarkerHeaders } = await import("~/lib/internal-marker.server");
  const headers = await makeInternalMarkerHeaders(PROJECT_ID, SECRET, "ingest-sync");
  return new Request("https://internal/ingest-sync", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

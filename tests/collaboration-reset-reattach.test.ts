/**
 * The DO's two `afterTransaction` handlers — the contribution accumulator and
 * the canDelete enforcement — are bound to the Y.Doc they were attached to.
 * `/reset` destroys that doc and builds a new one, so the handlers have to be
 * re-attached with it: a reset DO that kept the old bindings would run for the
 * rest of its lifetime with no delete enforcement at all.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

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

import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { checkD1Bind } from "./helpers/d1-memory";

/**
 * Durable Object key-value storage. The DO reads the document generation from
 * it on every socket upgrade and writes it on `/reset`, so a stub that only
 * answers the alarm calls leaves the reset unable to arm its guard. Each
 * harness gets its own store.
 */
function makeStorageStub(extra: Record<string, unknown> = {}) {
  const kv = new Map<string, unknown>();
  return {
    getAlarm: async () => null,
    setAlarm: async () => {},
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => { kv.set(key, value); },
    // A load lists the log prefix before it tags an untagged blob or builds one.
    list: async () => new Map(),
    // The snapshot and the reset retire a storage base header by deleting it.
    delete: async (keys: string[]) => keys.filter((key) => kv.delete(key)).length,
    ...extra,
  };
}


const TEST_SECRET = "test-session-secret";
const TEST_PROJECT_ID = 42;
const CONVENOR = 1;
const COLLABORATOR = 2;

/** Two stories, one owned by each user; the convenor's is the protected one. */
const STORY_ROWS = [
  {
    id: 10, story_id: "convenor-story", title: "Convenor", subtitle: "", byline: "",
    order: 0, private: 0, draft: 0, show_sections: 0, created_by: CONVENOR,
  },
  {
    id: 11, story_id: "collab-story", title: "Collaborator", subtitle: "", byline: "",
    order: 1, private: 0, draft: 0, show_sections: 0, created_by: COLLABORATOR,
  },
];

function fakeSocket(userId: number, role: "convenor" | "collaborator") {
  const attachment = { userId, projectId: TEST_PROJECT_ID, role };
  return {
    attachment,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

/** D1 stub for a cold project: no blob, two stories, nothing else. */
function makeDb() {
  const runs: string[] = [];
  const db = {
    runs,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          checkD1Bind(sql, args);
          return {
            // The base row a load and a reset both read: no blob, no tags, no
            // claim yet, which is the cold build.
            first: async () =>
              /^SELECT yjs_state|^SELECT yjs_generation/.test(sql)
                ? { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 }
                : null,
            all: async () => ({
              results: sql.includes("FROM stories") ? STORY_ROWS : [],
            }),
            run: async () => {
              runs.push(sql);
              return { meta: { last_row_id: 1, changes: 1 }, success: true as const };
            },
          };
        },
      };
    },
  };
  return db;
}

async function makeDO(sockets: ReturnType<typeof fakeSocket>[]) {
  const ctx = {
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: makeStorageStub(),
    acceptWebSocket: vi.fn(),
  };
  const env = { DB: makeDb(), SESSION_SECRET: TEST_SECRET, COLLABORATION: {} };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  // The constructor's hibernation-recovery load is fire-and-forget.
  await new Promise((r) => setTimeout(r, 0));
  return doInstance;
}

async function resetRequest(): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(TEST_PROJECT_ID, TEST_SECRET, "reset");
  return new Request("https://internal/reset", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(TEST_PROJECT_ID),
    },
  });
}

/** The DO's live Y.Doc — private, and the point of the test is that it is
 *  replaced, so it is read afresh each time rather than captured. */
function liveDoc(doInstance: ProjectCollaborationDO): Y.Doc {
  return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
}

function storyIds(ydoc: Y.Doc): unknown[] {
  return ydoc.getArray<Y.Map<unknown>>("stories").toArray().map((m) => m.get("story_id"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => { /* silence the revert log */ });
});

describe("collaboration DO — /reset re-attaches the document handlers", () => {
  it("reverts an unauthorised collaborator delete AFTER a reset", async () => {
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    const doInstance = await makeDO([collab]);

    const res = await doInstance.fetch(await resetRequest());
    expect(res.status).toBe(200);

    const ydoc = liveDoc(doInstance);
    expect(storyIds(ydoc)).toEqual(["convenor-story", "collab-story"]);

    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    }, collab);

    expect(storyIds(ydoc)).toEqual(["convenor-story", "collab-story"]);
  });

  it("still lets a collaborator delete their own story after a reset", async () => {
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    const doInstance = await makeDO([collab]);
    await doInstance.fetch(await resetRequest());

    const ydoc = liveDoc(doInstance);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").delete(1, 1);
    }, collab);

    expect(storyIds(ydoc)).toEqual(["convenor-story"]);
  });

  it("keeps accumulating contribution field paths on the post-reset doc", async () => {
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    const doInstance = await makeDO([collab]);
    await doInstance.fetch(await resetRequest());

    const ydoc = liveDoc(doInstance);
    ydoc.transact(() => {
      const story = ydoc.getArray<Y.Map<unknown>>("stories").get(1);
      (story.get("title") as Y.Text).insert(0, "edited ");
    }, collab);

    const fieldSets = (doInstance as unknown as { userFieldSets: Map<number, Set<string>> })
      .userFieldSets;
    expect(fieldSets.get(COLLABORATOR)?.size ?? 0).toBeGreaterThan(0);
  });

  it("binds the awareness instance to the replaced document", async () => {
    const doInstance = await makeDO([fakeSocket(CONVENOR, "convenor")]);
    await doInstance.fetch(await resetRequest());

    const inner = doInstance as unknown as {
      ydoc: Y.Doc;
      awareness: { doc: Y.Doc };
    };
    expect(inner.awareness.doc).toBe(inner.ydoc);
  });
});

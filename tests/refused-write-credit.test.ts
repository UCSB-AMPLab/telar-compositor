/**
 * A refused write earns nothing.
 *
 * The structural guard and the contribution accumulator sit on the same
 * `afterTransaction` emitter. The guard reverts in a transaction of its own,
 * whose mutations land immediately, but the accumulator walks the ORIGINAL
 * transaction's change set — which still names every key the guard put back. So
 * without the guard's marks a collaborator earned a field path, a timestamp,
 * words and editing time for a write the document does not hold: emptying a
 * story's steps, planting an id, pushing a `null` into an array, or deleting a
 * colleague's step.
 *
 * Everything here runs through `attachDocHandlers` on the real Durable Object
 * class. A test that registers the two handlers by hand would prove only its own
 * registration order, which is the thing under test.
 *
 * The origin has to be a socket the guard accepts — an object answering
 * `deserializeAttachment` with a userId and a role. The `{ userId: 7 }` origin
 * used by the accumulator's own unit tests is ignored by the guard, so a
 * transaction carrying it is never reverted at all.
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
import { refusedMarks } from "../workers/refusal-marks";
import type { TimeLedger, WordsByRow } from "../workers/contribution-metrics";
import { checkD1Bind } from "./helpers/d1-memory";

const TEST_SECRET = "test-session-secret";
const PROJECT_ID = 42;
const OWNER = 1;
const OTHER = 2;

type Role = "convenor" | "collaborator" | "instructor";

interface FakeSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  serializeAttachment: ReturnType<typeof vi.fn>;
  deserializeAttachment: () => { userId: number; projectId: number; role: Role };
}

function fakeSocket(userId: number, role: Role = "collaborator"): FakeSocket {
  const attachment = { userId, projectId: PROJECT_ID, role };
  return {
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

/**
 * A Durable Object with no sockets at construction time, so the constructor's
 * hibernation-recovery load never runs and the document stays empty for the
 * seed below to fill. Sockets are appended afterwards; the guard reads the list
 * at broadcast time.
 */
function makeDO(sockets: FakeSocket[] = []) {
  const live: FakeSocket[] = [];
  const kv = new Map<string, unknown>();
  const ctx = {
    getWebSockets: () => live,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      list: async () => new Map(),
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => { kv.set(key, value); },
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        checkD1Bind(sql, args);
        return {
        async run() { return { meta: { last_row_id: 1, changes: 1 }, success: true as const }; },
        async all() { return { results: [], success: true as const }; },
        async first() {
          // The base row: no blob, no tags, no claim yet.
          return /^SELECT yjs_state|^SELECT yjs_generation/.test(sql)
            ? { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 }
            : null;
        },
        };
      },
    }),
    async batch() { return []; },
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: DB as unknown, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  live.push(...sockets);
  return doInstance;
}

interface Inner {
  ydoc: Y.Doc;
  userFieldSets: Map<number, Set<string>>;
  lastEditAt: Map<number, string>;
  timeLedger: TimeLedger;
  wordsByRow: WordsByRow;
  stagedEffects: { sends: Array<{ ws: unknown; msg: Uint8Array }> };
}

const inner = (doInstance: ProjectCollaborationDO): Inner =>
  doInstance as unknown as Inner;

const pathsOf = (doInstance: ProjectCollaborationDO, userId: number): string[] =>
  [...(inner(doInstance).userFieldSets.get(userId) ?? [])];

/**
 * One story owned by OWNER, with two steps and a layer under the second. The
 * seed runs null-origin, so nothing in it is attributed to anybody.
 */
function seed(ydoc: Y.Doc, storyId = 7) {
  const story = new Y.Map<unknown>();
  const steps = new Y.Array<unknown>();
  const stepOne = new Y.Map<unknown>();
  const stepTwo = new Y.Map<unknown>();
  const layers = new Y.Array<unknown>();
  const layer = new Y.Map<unknown>();
  ydoc.transact(() => {
    layer.set("_id", 21);
    layer.set("created_by", OWNER);
    layer.set("content", new Y.Text("Layer text"));
    layers.push([layer]);

    stepOne.set("_id", 11);
    stepOne.set("created_by", OWNER);
    stepOne.set("question", new Y.Text("First question"));

    stepTwo.set("_id", 12);
    stepTwo.set("created_by", OTHER);
    stepTwo.set("question", new Y.Text("Second question"));
    stepTwo.set("layers", layers);

    steps.push([stepOne]);
    steps.push([stepTwo]);

    story.set("_id", storyId);
    story.set("story_id", "the-story");
    story.set("created_by", OWNER);
    story.set("title", new Y.Text("Story"));
    story.set("steps", steps);
    ydoc.getArray<unknown>("stories").push([story]);
  }, null);
  return { story, steps, stepOne, stepTwo, layers };
}

const stepIds = (steps: Y.Array<unknown>): unknown[] =>
  steps.toArray().map((s) => (s instanceof Y.Map ? s.get("_id") : "NOT A MAP"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => { /* the revert log */ });
});

describe("a refused write earns no credit", () => {
  it("credits nothing at all for a refused container write", () => {
    const doInstance = makeDO([fakeSocket(OTHER)]);
    const { ydoc } = inner(doInstance);
    const { story } = seed(ydoc);

    ydoc.transact(() => {
      story.set("steps", new Y.Map<unknown>());
    }, fakeSocket(OTHER));

    expect(stepIds(story.get("steps") as Y.Array<unknown>)).toEqual([11, 12]);
    expect(pathsOf(doInstance, OTHER)).toEqual([]);
    expect(inner(doInstance).lastEditAt.has(OTHER)).toBe(false);
    expect(inner(doInstance).timeLedger.has(OTHER)).toBe(false);
    expect(inner(doInstance).wordsByRow.size).toBe(0);
  });

  it("keeps the credit for a legitimate edit bundled with the refused one", () => {
    const doInstance = makeDO([fakeSocket(OTHER)]);
    const { ydoc } = inner(doInstance);
    const { story } = seed(ydoc);

    ydoc.transact(() => {
      (story.get("title") as Y.Text).insert(5, " of ours");
      story.set("steps", new Y.Map<unknown>());
    }, fakeSocket(OTHER));

    expect(pathsOf(doInstance, OTHER)).toEqual(["stories:7:title"]);
    expect(inner(doInstance).lastEditAt.has(OTHER)).toBe(true);
    expect(inner(doInstance).timeLedger.has(OTHER)).toBe(true);
  });

  it("keeps a field edit inside an element while refusing the array's own change", () => {
    const doInstance = makeDO([fakeSocket(OTHER)]);
    const { ydoc } = inner(doInstance);
    const { story, steps, stepTwo } = seed(ydoc);

    ydoc.transact(() => {
      steps.push([null]);
      (stepTwo.get("question") as Y.Text).insert(6, " really");
    }, fakeSocket(OTHER));

    expect(stepIds(story.get("steps") as Y.Array<unknown>)).toEqual([11, 12]);
    expect(pathsOf(doInstance, OTHER)).toEqual(["stories:7:steps:12:question"]);
  });

  it("names the real row, not the planted id, on the path it does credit", () => {
    const doInstance = makeDO([fakeSocket(OTHER)]);
    const { ydoc } = inner(doInstance);
    const { story } = seed(ydoc);

    ydoc.transact(() => {
      story.set("_id", 99);
      (story.get("title") as Y.Text).insert(5, "!");
    }, fakeSocket(OTHER));

    expect(story.get("_id")).toBe(7);
    expect(pathsOf(doInstance, OTHER)).toEqual(["stories:7:title"]);
  });

  it("earns nothing for an array element the guard removes", () => {
    const doInstance = makeDO([fakeSocket(OTHER)]);
    const { ydoc } = inner(doInstance);
    const { story, steps } = seed(ydoc);

    ydoc.transact(() => {
      steps.push([null]);
    }, fakeSocket(OTHER));

    expect(stepIds(story.get("steps") as Y.Array<unknown>)).toEqual([11, 12]);
    expect(pathsOf(doInstance, OTHER)).toEqual([]);
    expect(inner(doInstance).lastEditAt.has(OTHER)).toBe(false);
  });
});

describe("a refused deletion earns nothing for the arrays it touched", () => {
  it("credits the legitimate field edit and neither array", () => {
    const doInstance = makeDO([fakeSocket(OTHER)]);
    const { ydoc } = inner(doInstance);
    const { story, steps, stepTwo, layers } = seed(ydoc);

    ydoc.transact(() => {
      steps.delete(0, 1);          // OWNER's step
      layers.delete(0, 1);         // OWNER's layer, under OTHER's step
      (stepTwo.get("question") as Y.Text).insert(6, " again");
    }, fakeSocket(OTHER));

    expect(stepIds(story.get("steps") as Y.Array<unknown>)).toEqual([11, 12]);
    expect((stepTwo.get("layers") as Y.Array<unknown>).length).toBe(1);
    expect(pathsOf(doInstance, OTHER)).toEqual(["stories:7:steps:12:question"]);
  });

  it("leaves credit earned earlier for the same array standing", () => {
    const doInstance = makeDO([fakeSocket(OTHER)]);
    const { ydoc } = inner(doInstance);
    const { steps } = seed(ydoc);

    ydoc.transact(() => {
      const mine = new Y.Map<unknown>();
      mine.set("_id", null);
      mine.set("_temp_id", "a-new-step");
      mine.set("created_by", OTHER);
      steps.push([mine]);
    }, fakeSocket(OTHER));
    expect(pathsOf(doInstance, OTHER)).toContain("stories:7:steps");

    ydoc.transact(() => {
      steps.delete(0, 1);
    }, fakeSocket(OTHER));

    expect(pathsOf(doInstance, OTHER)).toContain("stories:7:steps");
  });

  it("holds on the replacement document after /reset", async () => {
    const doInstance = makeDO([fakeSocket(OTHER)]);
    const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, TEST_SECRET, "reset");
    const res = await doInstance.fetch(new Request("https://internal/reset", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
      },
    }));
    expect(res.status).toBe(200);

    // The rebuilt document is a different Y.Doc; the handlers are re-attached
    // to it, and the order they are attached in is what this asserts.
    const { ydoc } = inner(doInstance);
    const { story, steps, stepTwo } = seed(ydoc, 8);

    ydoc.transact(() => {
      steps.delete(0, 1);
      (stepTwo.get("question") as Y.Text).insert(6, " still");
    }, fakeSocket(OTHER));

    expect(stepIds(story.get("steps") as Y.Array<unknown>)).toEqual([11, 12]);
    expect(pathsOf(doInstance, OTHER)).toEqual(["stories:8:steps:12:question"]);
  });
});

describe("earlier credit is never retracted", () => {
  it("keeps a legitimate edit when a later, unrelated transaction is refused", () => {
    const doInstance = makeDO([fakeSocket(OTHER)]);
    const { ydoc } = inner(doInstance);
    const { story } = seed(ydoc);

    // Two edits: the first establishes the word baseline (credited 0, as any
    // first sight of a field is), the second is what the preserved word count
    // below actually measures.
    ydoc.transact(() => {
      (story.get("title") as Y.Text).insert(5, " one");
    }, fakeSocket(OTHER));
    ydoc.transact(() => {
      (story.get("title") as Y.Text).insert(9, " two three");
    }, fakeSocket(OTHER));
    expect(pathsOf(doInstance, OTHER)).toEqual(["stories:7:title"]);
    const lastEditBefore = inner(doInstance).lastEditAt.get(OTHER);
    const accrualBefore = inner(doInstance).timeLedger.get(OTHER);
    const wordsBefore = inner(doInstance).wordsByRow.get("stories")?.get("7")?.get(OTHER);
    expect(lastEditBefore).toBeDefined();
    expect(accrualBefore).toBeDefined();
    expect(wordsBefore).toBeGreaterThan(0);

    // A structural swap on `steps` is refused regardless of who sends it or
    // what key it lands on; what this asserts is that a LATER refusal does
    // not disturb credit a prior transaction already earned.
    const marksSeen: number[] = [];
    ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      marksSeen.push(refusedMarks(tr)?.size ?? 0);
    });
    ydoc.transact(() => {
      story.set("steps", new Y.Array<unknown>());
    }, fakeSocket(OTHER));

    expect(stepIds(story.get("steps") as Y.Array<unknown>)).toEqual([11, 12]);
    expect(marksSeen[0]).toBeGreaterThan(0);
    expect(pathsOf(doInstance, OTHER)).toEqual(["stories:7:title"]);
    expect(inner(doInstance).lastEditAt.get(OTHER)).toBe(lastEditBefore);
    expect(inner(doInstance).timeLedger.get(OTHER)).toBe(accrualBefore);
    expect(inner(doInstance).wordsByRow.get("stories")?.get("7")?.get(OTHER)).toBe(wordsBefore);
  });
});

describe("the handlers run in the order the credit depends on", () => {
  it("has the guard's marks on the transaction before the accumulator runs", () => {
    const doInstance = makeDO();
    const { ydoc } = inner(doInstance);
    const { story } = seed(ydoc);

    // The guard stages the corrected state before it returns, so the size of
    // the acting user's field set at the moment of staging is what the
    // accumulator had recorded by then. Zero is the guard running first. The
    // queue is read rather than the socket, because the broadcast is held for
    // the message handler's drain and reaches no socket from inside the
    // transaction.
    const sizeAtBroadcast: number[] = [];
    const staged = inner(doInstance).stagedEffects.sends;
    const pushStaged = staged.push.bind(staged);
    staged.push = (...items: Array<{ ws: unknown; msg: Uint8Array }>) => {
      sizeAtBroadcast.push(inner(doInstance).userFieldSets.get(OTHER)?.size ?? 0);
      return pushStaged(...items);
    };
    const watcher = fakeSocket(OTHER);
    (doInstance as unknown as { ctx: { getWebSockets: () => FakeSocket[] } })
      .ctx.getWebSockets().push(watcher);

    const marksSeen: number[] = [];
    ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      marksSeen.push(refusedMarks(tr)?.size ?? 0);
    });

    ydoc.transact(() => {
      (story.get("title") as Y.Text).insert(5, " again");
      story.set("steps", new Y.Map<unknown>());
    }, fakeSocket(OTHER));

    expect(sizeAtBroadcast).toEqual([0]);
    expect(marksSeen[0]).toBeGreaterThan(0);
    expect(pathsOf(doInstance, OTHER)).toEqual(["stories:7:title"]);
  });
});

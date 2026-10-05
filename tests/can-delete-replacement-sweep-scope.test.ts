/**
 * R2-3 — the replacement sweep must cover ordinary content, not course items
 * alone.
 *
 * A restored entity is only safe if nothing else in the array claims its
 * identity. The sweep that guarantees that ran only where the deleted Y.Map
 * carried a course marker, so on ordinary content an attacker could insert a
 * hollow map carrying the victim's exact `_id` and key ahead of it, delete the
 * victim, let enforcement restore it — and hand the finishing blow to the DO's
 * own pre-snapshot dedupe, which sees two maps claiming one row and keeps the
 * first.
 *
 * The fix belongs here rather than in the dedupe because the two maps are
 * indistinguishable to D1: it knows only that row 10 exists. What separates
 * the forgery from the original is provenance — the forgery was born inside the
 * offending transaction — and provenance is known at revert time and gone by
 * snapshot time.
 *
 * The sweep on ordinary content is therefore provenance-only. A same-key
 * neighbour that predates the transaction is real content with its own live D1
 * row; the dedupe re-keys it rather than deleting it, and this pass must not do
 * what that rule exists to prevent.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
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
import { makeCanDeleteHandler, makeViolationCounter } from "../workers/can-delete";
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

type Role = "convenor" | "collaborator" | "instructor";

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: Role };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(userId: number, role: Role): FakeWS {
  return { deserializeAttachment: () => ({ userId, role }), send: vi.fn(), close: vi.fn() };
}

/** A bare Y.Doc with the handler wired exactly as the DO wires it. */
function makeHarness() {
  const ydoc = new Y.Doc();
  const warns: string[] = [];
  const isReverting = { value: false };
  ydoc.on("afterTransaction", makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => false,
    isReverting: () => isReverting.value,
    setReverting: (v: boolean) => { isReverting.value = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => { /* not under test */ },
    recordViolation: makeViolationCounter(),
    warn: (msg: string) => { warns.push(msg); },
  }));
  return {
    ydoc,
    warns,
    stories: ydoc.getArray<Y.Map<unknown>>("stories"),
    objects: ydoc.getArray<Y.Map<unknown>>("objects"),
    asUser: (ws: FakeWS, fn: () => void) => { ydoc.transact(fn, ws); },
    seed: (fn: () => void) => { ydoc.transact(fn, null); },
  };
}

/** A real DO instance, so the pre-snapshot dedupe can finish the attack. */
function makeDo() {
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        checkD1Bind(sql, args);
        return {
          async run() { return { meta: { last_row_id: 1, changes: 1 }, success: true as const }; },
          async all() { return { results: [], success: true as const }; },
          async first() { return null; },
        };
      },
    }),
    async batch() { return []; },
  };
  const ctx = {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: DB as unknown, SESSION_SECRET: "test", COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = 42;
  markLoaded(doInstance);
  return { doInstance, ydoc: (doInstance as unknown as { ydoc: Y.Doc }).ydoc };
}

/**
 * `deduplicateYArray` as the DO calls it. The signature is restated here
 * because the method is private, and it must match the real one exactly: an
 * extra parameter in this shim silently shifts `d1KeyToId` out of its slot, so
 * D1's own answer never reaches the keeper pass and the test passes for want
 * of a collision rather than because the pass resolved one.
 */
function dedupe(
  doInstance: ProjectCollaborationDO,
  arrayName: string,
  key: string,
  d1KeyToId: ReadonlyMap<string, number>,
): boolean {
  return (doInstance as unknown as {
    deduplicateYArray: (a: string, k: string, d?: ReadonlyMap<string, number>) => boolean;
  }).deduplicateYArray(arrayName, key, d1KeyToId);
}

interface StorySpec {
  id: number | null;
  tempId: string;
  createdBy: number;
  storyId: string;
  title: string;
}

function makeStory(spec: StorySpec): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", spec.id);
  m.set("_temp_id", spec.tempId);
  m.set("created_by", spec.createdBy);
  m.set("story_id", spec.storyId);
  m.set("title", new Y.Text(spec.title));
  m.set("steps", new Y.Array<Y.Map<unknown>>());
  return m;
}

function title(m: Y.Map<unknown>): string {
  const v = m.get("title");
  return v instanceof Y.Text ? v.toString() : "";
}

// ---------------------------------------------------------------------------
// The reported attack, end to end through the DO's own dedupe
// ---------------------------------------------------------------------------

describe("R2-3 — a hollow replacement on ordinary content", () => {
  it("does not survive the revert to be finished off by the pre-snapshot dedupe", () => {
    const { doInstance, ydoc } = makeDo();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      stories.push([makeStory({
        id: 10, tempId: "uuid-victim", createdBy: 9,
        storyId: "la-vasija", title: "An afternoon of work",
      })]);
    }, null);

    // One transaction: plant a twin ahead of the victim, then delete the victim.
    ydoc.transact(() => {
      stories.insert(0, [makeStory({
        id: 10, tempId: "uuid-forged", createdBy: 9,
        storyId: "la-vasija", title: "",
      })]);
      stories.delete(1, 1);
    }, fakeSocket(7, "collaborator"));

    // Enforcement must leave exactly one map claiming row 10 — the real one.
    expect(stories.length).toBe(1);
    expect(title(stories.get(0))).toBe("An afternoon of work");

    // And the DO's own dedupe must then have nothing to collapse.
    dedupe(doInstance, "stories", "story_id", new Map([["la-vasija", 10]]));
    expect(stories.length).toBe(1);
    expect(title(stories.get(0))).toBe("An afternoon of work");
  });

  it("sweeps a same-key forgery against an unsaved victim, where D1 has no answer", () => {
    // With `_id` null on both, the dedupe's D1-decided keeper has nothing to
    // decide on and falls back to position — which the attacker chooses.
    const { doInstance, ydoc } = makeDo();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      stories.push([makeStory({
        id: null, tempId: "uuid-victim", createdBy: 9,
        storyId: "mi-historia", title: "An afternoon of work",
      })]);
    }, null);

    ydoc.transact(() => {
      stories.insert(0, [makeStory({
        id: null, tempId: "uuid-forged", createdBy: 9,
        storyId: "mi-historia", title: "",
      })]);
      stories.delete(1, 1);
    }, fakeSocket(7, "collaborator"));

    expect(stories.length).toBe(1);
    expect(title(stories.get(0))).toBe("An afternoon of work");

    dedupe(doInstance, "stories", "story_id", new Map());
    expect(stories.length).toBe(1);
    expect(title(stories.get(0))).toBe("An afternoon of work");
  });

  it("hands a same-key collision to D1's own answer", () => {
    // The two cases above never reach a collision, so neither reads
    // `d1KeyToId` — which left the shim above free to pass it in the wrong
    // slot and still go green. This one collides, so D1's answer is read, and
    // a shim whose signature has drifted from the method throws here instead.
    const { doInstance, ydoc } = makeDo();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      stories.push([makeStory({
        id: null, tempId: "uuid-newcomer", createdBy: 9,
        storyId: "la-vasija", title: "A newcomer",
      })]);
      stories.push([makeStory({
        id: 10, tempId: "uuid-owner", createdBy: 9,
        storyId: "la-vasija", title: "An afternoon of work",
      })]);
    }, null);

    expect(dedupe(doInstance, "stories", "story_id", new Map([["la-vasija", 10]]))).toBe(true);
    // D1 says row 10 owns the key, so it keeps it wherever it sits, and the
    // loser keeps its content under a minted one.
    expect(stories.length).toBe(2);
    expect(stories.get(1).get("story_id")).toBe("la-vasija");
    expect(stories.get(0).get("story_id")).toBe("la-vasija-2");
    expect(title(stories.get(0))).toBe("A newcomer");
  });

  it("sweeps a forgery that copies only the victim's _temp_id", () => {
    const h = makeHarness();
    h.seed(() => {
      h.stories.push([makeStory({
        id: 10, tempId: "uuid-victim", createdBy: 9,
        storyId: "la-vasija", title: "An afternoon of work",
      })]);
    });

    h.asUser(fakeSocket(7, "collaborator"), () => {
      h.stories.insert(0, [makeStory({
        id: null, tempId: "uuid-victim", createdBy: 9,
        storyId: "otra-cosa", title: "",
      })]);
      h.stories.delete(1, 1);
    });

    expect(h.stories.length).toBe(1);
    expect(title(h.stories.get(0))).toBe("An afternoon of work");
  });
});

// ---------------------------------------------------------------------------
// The honest paths the sweep must not touch
// ---------------------------------------------------------------------------

describe("R2-3 — the sweep leaves honest content alone", () => {
  it("keeps a same-key neighbour that predates the offending transaction", () => {
    // A live second row under a colliding key is exactly what the dedupe
    // re-keys rather than deletes. Removing it here would destroy a member's
    // story on an inference about who is entitled to the key.
    const h = makeHarness();
    h.seed(() => {
      h.stories.push([
        makeStory({ id: 11, tempId: "uuid-a", createdBy: 7, storyId: "compartida", title: "Mine" }),
        makeStory({ id: 10, tempId: "uuid-b", createdBy: 9, storyId: "compartida", title: "Theirs" }),
      ]);
    });

    h.asUser(fakeSocket(7, "collaborator"), () => { h.stories.delete(1, 1); });

    const survivors = h.stories.toArray().map(title).sort();
    expect(survivors).toEqual(["Mine", "Theirs"]);
  });

  it("keeps a same-_id neighbour that predates the offending transaction", () => {
    const h = makeHarness();
    h.seed(() => {
      h.stories.push([
        makeStory({ id: 10, tempId: "uuid-a", createdBy: 7, storyId: "una", title: "Mine" }),
        makeStory({ id: 10, tempId: "uuid-b", createdBy: 9, storyId: "otra", title: "Theirs" }),
      ]);
    });

    h.asUser(fakeSocket(7, "collaborator"), () => { h.stories.delete(1, 1); });

    const survivors = h.stories.toArray().map(title).sort();
    expect(survivors).toEqual(["Mine", "Theirs"]);
  });

  it("does not run at all for the Durable Object's own null-origin writes", () => {
    const h = makeHarness();
    h.seed(() => {
      h.stories.push([makeStory({
        id: 10, tempId: "uuid-victim", createdBy: 9, storyId: "la-vasija", title: "Theirs",
      })]);
    });

    h.seed(() => {
      h.stories.insert(0, [makeStory({
        id: 10, tempId: "uuid-do", createdBy: 9, storyId: "la-vasija", title: "Rebuilt by the DO",
      })]);
      h.stories.delete(1, 1);
    });

    expect(h.stories.length).toBe(1);
    expect(title(h.stories.get(0))).toBe("Rebuilt by the DO");
    expect(h.warns).toEqual([]);
  });

  it("leaves the convenor's own deletes untouched, replacement and all", () => {
    const h = makeHarness();
    h.seed(() => {
      h.stories.push([makeStory({
        id: 10, tempId: "uuid-victim", createdBy: 9, storyId: "la-vasija", title: "Theirs",
      })]);
    });

    h.asUser(fakeSocket(1, "convenor"), () => {
      h.stories.insert(0, [makeStory({
        id: 10, tempId: "uuid-new", createdBy: 1, storyId: "la-vasija", title: "Replacement",
      })]);
      h.stories.delete(1, 1);
    });

    expect(h.stories.length).toBe(1);
    expect(title(h.stories.get(0))).toBe("Replacement");
  });
});

// ---------------------------------------------------------------------------
// The course-item sweep keeps its wider reach
// ---------------------------------------------------------------------------

describe("R2-3 — a marked course item still sweeps competitors from any transaction", () => {
  it("removes a twin planted in an earlier transaction", () => {
    const h = makeHarness();
    const makeObject = (spec: {
      id: number | null; tempId: string; createdBy: number; objectId: string;
      title: string; marker?: number;
    }) => {
      const m = new Y.Map<unknown>();
      m.set("_id", spec.id);
      m.set("_temp_id", spec.tempId);
      m.set("created_by", spec.createdBy);
      m.set("object_id", spec.objectId);
      m.set("title", new Y.Text(spec.title));
      if (spec.marker !== undefined) m.set("course_project_id", spec.marker);
      return m;
    };

    h.seed(() => {
      h.objects.push([makeObject({
        id: 10, tempId: "uuid-victim", createdBy: 9,
        objectId: "vasija-muisca", title: "Course item", marker: 3,
      })]);
    });
    // Planted in its own earlier transaction, so provenance alone would miss it.
    h.seed(() => {
      h.objects.insert(0, [makeObject({
        id: 10, tempId: "uuid-twin", createdBy: 7, objectId: "vasija-muisca", title: "",
      })]);
    });

    h.asUser(fakeSocket(7, "collaborator"), () => {
      const at = h.objects.toArray().findIndex((m) => m.get("_temp_id") === "uuid-victim");
      h.objects.delete(at, 1);
    });

    expect(h.objects.length).toBe(1);
    expect(title(h.objects.get(0))).toBe("Course item");
  });
});

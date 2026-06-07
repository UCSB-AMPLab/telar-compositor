/**
 * This file tests the DO control endpoints in `workers/collaboration.ts`:
 *
 *   POST /notify-deleted   — broadcasts msgType=2 + subtype byte to
 *                            matching sockets, then closes each
 *   GET  /active-ws-count  — returns { count } for the convenor's
 *                            pre-flight modal
 *   POST /restore-orphans  — restores orphan story Y.Maps back to the
 *                            live doc via the worker (D1 inserts alone
 *                            lose the Yjs CRDT history)
 *
 * Both endpoints are HMAC-marker gated by verifyInternalMarker; an
 * unsigned reach gets 401.
 *
 * Wire format:
 *   varuint(2 = messageSessionControl) + uint8(0x01 project_deleted
 *                                              | 0x02 removed_from_project)
 *
 * The DO class is exercised directly with a stubbed ctx/env. We mock
 * `cloudflare:workers` so DurableObject is a plain class and the DO
 * receives the test ctx/env via super().
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";

// Mock the cloudflare:workers DurableObject base so the import is
// available in Node and the constructor stores ctx/env on `this`.
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

// Pull in the DO class AFTER the mock so the cloudflare:workers import
// resolves to the stub above.
import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker, verifyInternalMarker } from "../workers/auth";
import { buildActivityRows } from "../workers/collaboration-helpers";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-session-secret";
const TEST_PROJECT_ID = 42;

interface FakeSocket {
  attachment: { userId: number; projectId: number; role: "convenor" | "collaborator" };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  serializeAttachment: ReturnType<typeof vi.fn>;
  deserializeAttachment: () => FakeSocket["attachment"];
}

function fakeSocket(
  userId: number,
  role: "convenor" | "collaborator" = "collaborator",
): FakeSocket {
  const attachment = { userId, projectId: TEST_PROJECT_ID, role };
  const ws: FakeSocket = {
    attachment,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
  return ws;
}

/**
 * Build a ctx that starts with NO sockets (so the DO constructor's
 * hibernation-recovery branch is skipped — it would otherwise call
 * blockConcurrencyWhile → ensureDocLoaded → DB.prepare which we don't
 * stub). We then append sockets after construction; the new endpoints
 * call ctx.getWebSockets() at request time so they pick up the live list.
 */
function makeCtxWithSockets(sockets: FakeSocket[]) {
  const live: FakeSocket[] = [];
  const ctx = {
    getWebSockets: () => live,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    acceptWebSocket: vi.fn(),
  };
  return {
    ctx,
    /** Call AFTER `new ProjectCollaborationDO(ctx, env)` to populate sockets. */
    populate: () => {
      live.push(...sockets);
    },
  };
}

function makeEnv() {
  return {
    DB: {} as unknown,
    SESSION_SECRET: TEST_SECRET,
    COLLABORATION: {} as unknown,
  };
}

/**
 * Derive the op string + signed userId for a DO control path so the test's
 * minted marker binds to exactly what the route's verifyInternalMarker call
 * will re-derive from the request. Keeps the harness in lockstep with the
 * production mint→op→userId map without each test re-stating it.
 */
function markerBindingFor(
  pathname: string,
  query?: string,
): { op: string; userId?: number | string } {
  const params = new URLSearchParams(query ?? "");
  if (pathname.endsWith("/snapshot")) return { op: "snapshot" };
  if (pathname.endsWith("/reset")) return { op: "reset" };
  if (pathname.endsWith("/notify-deleted")) {
    const userId = params.get("userId");
    return userId !== null ? { op: "notify-deleted", userId } : { op: "notify-deleted" };
  }
  if (pathname.endsWith("/active-ws-count")) {
    const exceptUserId = params.get("exceptUserId");
    return exceptUserId !== null
      ? { op: "active-ws-count", userId: exceptUserId }
      : { op: "active-ws-count" };
  }
  if (pathname.endsWith("/restore-orphans")) return { op: "restore-orphans" };
  return { op: "unknown" };
}

async function makeRequest(
  pathname: string,
  method: "GET" | "POST",
  options: { signed?: boolean; query?: string; body?: unknown } = { signed: true },
): Promise<Request> {
  const url = `https://internal${pathname}${options.query ? `?${options.query}` : ""}`;
  const headers: Record<string, string> = {};
  if (options.signed !== false) {
    const { op, userId } = markerBindingFor(pathname, options.query);
    const { sigHex, timestamp } = await signInternalMarker(
      TEST_PROJECT_ID,
      TEST_SECRET,
      op,
      userId,
    );
    headers["X-Internal-Auth"] = sigHex;
    headers["X-Internal-Timestamp"] = String(timestamp);
    headers["X-Internal-Project"] = String(TEST_PROJECT_ID);
  }
  let body: BodyInit | undefined = undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return new Request(url, { method, headers, body });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /notify-deleted
// ---------------------------------------------------------------------------

describe("collaboration DO — POST /notify-deleted", () => {
  it("no userId param: broadcasts varuint(2) + uint8(0x01) to ALL sockets, closes each with code 1000 reason 'project_deleted'", async () => {
    const sA = fakeSocket(1, "convenor");
    const sB = fakeSocket(2, "collaborator");
    const sC = fakeSocket(3, "collaborator");
    const { ctx, populate } = makeCtxWithSockets([sA, sB, sC]);
    const env = makeEnv();
    const doInstance = new ProjectCollaborationDO(
      ctx as unknown as DurableObjectState,
      env as unknown as Env,
    );
    populate();

    const req = await makeRequest("/notify-deleted", "POST");
    const res = await doInstance.fetch(req);

    expect(res.status).toBe(200);
    for (const s of [sA, sB, sC]) {
      expect(s.send).toHaveBeenCalledTimes(1);
      const payload = s.send.mock.calls[0][0] as Uint8Array;
      // Decode as msgType=2 + subtype=0x01
      const decoder = decoding.createDecoder(payload);
      expect(decoding.readVarUint(decoder)).toBe(2);
      expect(decoding.readUint8(decoder)).toBe(0x01);

      expect(s.close).toHaveBeenCalledTimes(1);
      expect(s.close.mock.calls[0][0]).toBe(1000);
      expect(s.close.mock.calls[0][1]).toBe("project_deleted");
    }
  });

  it("with ?userId=N: broadcasts varuint(2) + uint8(0x02) ONLY to sockets whose attachment.userId === N (single-socket variant)", async () => {
    const sA = fakeSocket(1, "convenor");
    const sB1 = fakeSocket(2, "collaborator");
    const sB2 = fakeSocket(2, "collaborator"); // user 2 has two open tabs
    const sC = fakeSocket(3, "collaborator");
    const { ctx, populate } = makeCtxWithSockets([sA, sB1, sB2, sC]);
    const env = makeEnv();
    const doInstance = new ProjectCollaborationDO(
      ctx as unknown as DurableObjectState,
      env as unknown as Env,
    );
    populate();

    const req = await makeRequest("/notify-deleted", "POST", {
      signed: true,
      query: "userId=2",
    });
    const res = await doInstance.fetch(req);

    expect(res.status).toBe(200);

    // user 1 + 3: untouched
    expect(sA.send).not.toHaveBeenCalled();
    expect(sA.close).not.toHaveBeenCalled();
    expect(sC.send).not.toHaveBeenCalled();
    expect(sC.close).not.toHaveBeenCalled();

    // user 2 (both tabs): receive subtype 0x02 + close
    for (const s of [sB1, sB2]) {
      expect(s.send).toHaveBeenCalledTimes(1);
      const payload = s.send.mock.calls[0][0] as Uint8Array;
      const decoder = decoding.createDecoder(payload);
      expect(decoding.readVarUint(decoder)).toBe(2);
      expect(decoding.readUint8(decoder)).toBe(0x02);

      expect(s.close).toHaveBeenCalledTimes(1);
      expect(s.close.mock.calls[0][0]).toBe(1000);
      expect(s.close.mock.calls[0][1]).toBe("removed_from_project");
    }
  });

  it("rejects without verifyInternalMarker HMAC headers (X-Internal-Auth + X-Internal-Timestamp + X-Internal-Project)", async () => {
    const s = fakeSocket(1);
    const { ctx, populate } = makeCtxWithSockets([s]);
    const env = makeEnv();
    const doInstance = new ProjectCollaborationDO(
      ctx as unknown as DurableObjectState,
      env as unknown as Env,
    );
    populate();

    const req = await makeRequest("/notify-deleted", "POST", { signed: false });
    const res = await doInstance.fetch(req);

    expect(res.status).toBe(401);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.close).not.toHaveBeenCalled();
  });

  it("send/close per socket survives a per-socket throw (other sockets still notified)", async () => {
    const sA = fakeSocket(1);
    const sB = fakeSocket(2);
    sA.send.mockImplementation(() => {
      throw new Error("socket already closed");
    });
    const { ctx, populate } = makeCtxWithSockets([sA, sB]);
    const env = makeEnv();
    const doInstance = new ProjectCollaborationDO(
      ctx as unknown as DurableObjectState,
      env as unknown as Env,
    );
    populate();

    const req = await makeRequest("/notify-deleted", "POST");
    const res = await doInstance.fetch(req);

    expect(res.status).toBe(200);
    expect(sB.send).toHaveBeenCalledTimes(1);
    expect(sB.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GET /active-ws-count
// ---------------------------------------------------------------------------

describe("collaboration DO — GET /active-ws-count", () => {
  it("returns { count: number } matching ctx.getWebSockets().length", async () => {
    const sockets = [fakeSocket(1), fakeSocket(2), fakeSocket(3)];
    const { ctx, populate } = makeCtxWithSockets(sockets);
    const env = makeEnv();
    const doInstance = new ProjectCollaborationDO(
      ctx as unknown as DurableObjectState,
      env as unknown as Env,
    );
    populate();

    const req = await makeRequest("/active-ws-count", "GET");
    const res = await doInstance.fetch(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(3);
  });

  it("rejects without verifyInternalMarker HMAC headers", async () => {
    const { ctx, populate } = makeCtxWithSockets([fakeSocket(1)]);
    const env = makeEnv();
    const doInstance = new ProjectCollaborationDO(
      ctx as unknown as DurableObjectState,
      env as unknown as Env,
    );
    populate();

    const req = await makeRequest("/active-ws-count", "GET", { signed: false });
    const res = await doInstance.fetch(req);

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Marker-check direct (regression — paranoia)
// ---------------------------------------------------------------------------

describe("verifyInternalMarker (direct)", () => {
  it("control endpoints inherit the same HMAC contract as /reset", async () => {
    // Sanity: a freshly-signed marker for our project verifies, an unsigned
    // request does not. Locks the contract these endpoints depend on.
    const { sigHex, timestamp } = await signInternalMarker(
      TEST_PROJECT_ID,
      TEST_SECRET,
      "notify-deleted",
    );
    const fresh = new Request("https://internal/notify-deleted", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(TEST_PROJECT_ID),
      },
    });
    expect(await verifyInternalMarker(fresh, TEST_SECRET, "notify-deleted")).toBeNull();

    const bare = new Request("https://internal/notify-deleted", { method: "POST" });
    const res = await verifyInternalMarker(bare, TEST_SECRET, "notify-deleted");
    expect(res?.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /restore-orphans — hotfix
// ---------------------------------------------------------------------------
//
// Routes orphan-CSV restore through the DO so the Y.doc (source of truth)
// gains the story Y.Maps and snapshotToD1's existing INSERT path persists
// to D1. Direct D1 inserts (the original design) lose the
// rows on the next snapshotToD1 because the reconciler treats them as
// orphan-from-Y.doc and DELETEs them (workers/collaboration.ts:1289).

// Build a DO instance with stubs for ensureDocLoaded/snapshotToD1 so the
// tests can focus on auth + JSON parse + Y.Map construction without
// needing a real D1 mock. The Y.doc itself is the real Y.Doc the DO
// constructs in its constructor.
function makeDoWithStubs(sockets: FakeSocket[] = []) {
  const { ctx, populate } = makeCtxWithSockets(sockets);
  const env = makeEnv();
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  populate();
  // Force projectId so the handler doesn't early-return.
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  // Replace ensureDocLoaded with a no-op that marks the doc as loaded —
  // unit tests do not touch D1.
  (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded = async () => {
    (doInstance as unknown as { docLoaded: boolean }).docLoaded = true;
  };
  // Spy snapshotToD1 to be a no-op so the test does not require a DB stub.
  const snapshotSpy = vi
    .spyOn(doInstance as unknown as { snapshotToD1: () => Promise<void> }, "snapshotToD1")
    .mockResolvedValue(undefined);
  return { doInstance, snapshotSpy };
}

describe("collaboration DO — POST /restore-orphans (hotfix)", () => {
  it("rejects without verifyInternalMarker HMAC headers", async () => {
    const { doInstance } = makeDoWithStubs();
    const req = await makeRequest("/restore-orphans", "POST", {
      signed: false,
      body: { stories: [] },
    });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(401);
  });

  it("empty stories array returns { restored: 0 } and does not call snapshotToD1", async () => {
    const { doInstance, snapshotSpy } = makeDoWithStubs();
    const req = await makeRequest("/restore-orphans", "POST", { body: { stories: [] } });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restored: number };
    expect(body.restored).toBe(0);
    expect(snapshotSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON body with 400", async () => {
    const { doInstance } = makeDoWithStubs();
    // Build a request whose body is invalid JSON.
    const { sigHex, timestamp } = await signInternalMarker(
      TEST_PROJECT_ID,
      TEST_SECRET,
      "restore-orphans",
    );
    const req = new Request("https://internal/restore-orphans", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(TEST_PROJECT_ID),
        "Content-Type": "application/json",
      },
      body: "not-json{",
    });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(400);
  });

  it("rejects body missing the stories array with 400", async () => {
    const { doInstance } = makeDoWithStubs();
    const req = await makeRequest("/restore-orphans", "POST", { body: { wrong: "shape" } });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(400);
  });

  it("pushes a Y.Map onto stories array with correct shape (single story, no steps)", async () => {
    const { doInstance, snapshotSpy } = makeDoWithStubs();
    const req = await makeRequest("/restore-orphans", "POST", {
      body: {
        stories: [
          { storyId: "draft-foo", steps: [], layers: [] },
        ],
      },
    });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restored: number };
    expect(body.restored).toBe(1);

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");
    expect(storiesArr.length).toBe(1);

    const storyMap = storiesArr.get(0);
    expect(storyMap.get("_id")).toBeNull();
    expect(storyMap.get("story_id")).toBe("draft-foo");
    // title is Y.Text with the storyId as a placeholder (CSV files do not
    // carry their own title; the user can rename in /stories).
    const title = storyMap.get("title") as Y.Text;
    expect(title.toString()).toBe("draft-foo");
    expect((storyMap.get("subtitle") as Y.Text).toString()).toBe("");
    expect((storyMap.get("byline") as Y.Text).toString()).toBe("");
    expect(storyMap.get("private")).toBe(false);
    expect(storyMap.get("draft")).toBe(true);
    expect(storyMap.get("show_sections")).toBe(false);
    expect(typeof storyMap.get("order")).toBe("number");

    const stepsArr = storyMap.get("steps") as Y.Array<Y.Map<unknown>>;
    expect(stepsArr.length).toBe(0);

    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it("constructs nested step Y.Maps with the buildFromD1Rows shape", async () => {
    const { doInstance } = makeDoWithStubs();
    const req = await makeRequest("/restore-orphans", "POST", {
      body: {
        stories: [
          {
            storyId: "draft-bar",
            steps: [
              {
                step_number: 1,
                kind: "media",
                object_id: "image-1",
                x: 0.5,
                y: 0.5,
                zoom: 1.0,
                page: "1",
                question: "Q?",
                answer: "A!",
                clip_start: "",
                clip_end: "",
                loop: "",
              },
            ],
            layers: [],
          },
        ],
      },
    });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(200);

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");
    const stepsArr = storiesArr.get(0).get("steps") as Y.Array<Y.Map<unknown>>;
    expect(stepsArr.length).toBe(1);

    const stepMap = stepsArr.get(0);
    expect(stepMap.get("_id")).toBeNull();
    expect(stepMap.get("step_number")).toBe(1);
    expect(stepMap.get("kind")).toBe("media");
    expect(stepMap.get("object_id")).toBe("image-1");
    expect(stepMap.get("x")).toBe(0.5);
    expect(stepMap.get("y")).toBe(0.5);
    expect(stepMap.get("zoom")).toBe(1.0);
    expect(stepMap.get("page")).toBe("1");
    expect((stepMap.get("question") as Y.Text).toString()).toBe("Q?");
    expect((stepMap.get("answer") as Y.Text).toString()).toBe("A!");
    expect((stepMap.get("alt_text") as Y.Text).toString()).toBe("");
    // layers Y.Array exists and is empty for steps with no layer data.
    const layersArr = stepMap.get("layers") as Y.Array<Y.Map<unknown>>;
    expect(layersArr.length).toBe(0);
  });

  it("threads layers under their parent step via step_index", async () => {
    const { doInstance } = makeDoWithStubs();
    const req = await makeRequest("/restore-orphans", "POST", {
      body: {
        stories: [
          {
            storyId: "draft-baz",
            steps: [
              { step_number: 1, kind: "media", object_id: "obj-a", page: "1", question: "", answer: "" },
              { step_number: 2, kind: "media", object_id: "obj-b", page: "1", question: "", answer: "" },
            ],
            layers: [
              // Two layers on step 0 (step_number 1).
              { step_index: 0, layer_number: 1, title: "L1 title", button_label: "B1", content: "C1" },
              { step_index: 0, layer_number: 2, title: "L2 title", button_label: "B2", content: "C2" },
              // One layer on step 1 (step_number 2).
              { step_index: 1, layer_number: 1, title: "Step2 L1", button_label: "S2B1", content: "S2C1" },
            ],
          },
        ],
      },
    });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(200);

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    const stepsArr = (ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps")) as Y.Array<Y.Map<unknown>>;

    const step0Layers = stepsArr.get(0).get("layers") as Y.Array<Y.Map<unknown>>;
    expect(step0Layers.length).toBe(2);
    expect((step0Layers.get(0).get("title") as Y.Text).toString()).toBe("L1 title");
    expect(step0Layers.get(0).get("layer_number")).toBe(1);
    expect((step0Layers.get(1).get("title") as Y.Text).toString()).toBe("L2 title");
    expect(step0Layers.get(1).get("layer_number")).toBe(2);

    const step1Layers = stepsArr.get(1).get("layers") as Y.Array<Y.Map<unknown>>;
    expect(step1Layers.length).toBe(1);
    expect((step1Layers.get(0).get("title") as Y.Text).toString()).toBe("Step2 L1");
  });

  it("removes pre-existing Y.Maps with matching story_id before pushing the fresh one (stale-_id recovery)", async () => {
    // Models the bug discovered during late staging UAT: a Y.Map left
    // over from a prior session carries a stale _id pointing at a now-
    // deleted D1 row. Without removal, deduplicateYArray inside
    // snapshotToD1 would keep that stale entry as the "first occurrence"
    // and discard our fresh _id=null Y.Map — leaving D1 without the row.
    const { doInstance } = makeDoWithStubs();
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    const stale = new Y.Map<unknown>();
    stale.set("_id", 19); // stale: D1 has no row with this id any more
    stale.set("story_id", "draft-test-tx90");
    stale.set("title", new Y.Text("Old draft"));
    stale.set("subtitle", new Y.Text(""));
    stale.set("byline", new Y.Text(""));
    stale.set("order", 1);
    stale.set("private", false);
    stale.set("draft", true);
    stale.set("show_sections", false);
    stale.set("steps", new Y.Array<Y.Map<unknown>>());
    ydoc.getArray<Y.Map<unknown>>("stories").push([stale]);

    const req = await makeRequest("/restore-orphans", "POST", {
      body: { stories: [{ storyId: "draft-test-tx90", steps: [], layers: [] }] },
    });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(200);

    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");
    expect(storiesArr.length).toBe(1);
    const storyMap = storiesArr.get(0);
    // The stale Y.Map should be gone; the surviving one is the fresh
    // restore (no D1 id yet, title resets to the storyId placeholder).
    expect(storyMap.get("_id")).toBeNull();
    expect((storyMap.get("title") as Y.Text).toString()).toBe("draft-test-tx90");
  });

  it("preserves existing stories — pushes restored ones onto the end of the array", async () => {
    const { doInstance } = makeDoWithStubs();
    // Pre-populate the Y.doc with one existing story (simulates a project
    // that already has stories before the restore fires).
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    const existing = new Y.Map<unknown>();
    existing.set("_id", 99);
    existing.set("story_id", "existing");
    existing.set("title", new Y.Text("Existing"));
    existing.set("subtitle", new Y.Text(""));
    existing.set("byline", new Y.Text(""));
    existing.set("order", 0);
    existing.set("private", false);
    existing.set("draft", false);
    existing.set("show_sections", false);
    existing.set("steps", new Y.Array<Y.Map<unknown>>());
    ydoc.getArray<Y.Map<unknown>>("stories").push([existing]);

    const req = await makeRequest("/restore-orphans", "POST", {
      body: {
        stories: [{ storyId: "draft-new", steps: [], layers: [] }],
      },
    });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(200);

    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");
    expect(storiesArr.length).toBe(2);
    // Existing untouched at index 0.
    expect(storiesArr.get(0).get("story_id")).toBe("existing");
    expect(storiesArr.get(0).get("draft")).toBe(false);
    // Restored at index 1, draft=true.
    expect(storiesArr.get(1).get("story_id")).toBe("draft-new");
    expect(storiesArr.get(1).get("draft")).toBe(true);
    // Order column on restored should be greater than existing's.
    expect(storiesArr.get(1).get("order")).toBeGreaterThan(0);
  });

  it("broadcasts a syncStep2 update to all connected websockets after mutation", async () => {
    const sA = fakeSocket(1);
    const sB = fakeSocket(2);
    const { doInstance } = makeDoWithStubs([sA, sB]);
    const req = await makeRequest("/restore-orphans", "POST", {
      body: { stories: [{ storyId: "draft-broadcast", steps: [], layers: [] }] },
    });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(200);

    // Each socket should have received exactly one frame: the syncStep2
    // message. Decoding the frame: varuint(0 = messageSync) + varuint(1 =
    // syncStep2 in y-protocols). Here we just assert the broadcast fired —
    // wire-format depth lives in y-protocols' own tests.
    expect(sA.send).toHaveBeenCalledTimes(1);
    expect(sB.send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// buildActivityRows — snapshot activity emit
// ---------------------------------------------------------------------------
//
// Editor edits never flow through React Router actions — they flow through the
// Y.doc and are reconciled to D1 by snapshotToD1. The snapshot block iterates
// activeUserIds with their userFieldSets (per-user field-path Sets) and emits
// one coarse activity row per (user, entity) touched this snapshot window (one
// row per save).
// buildActivityRows is the pure derivation: it groups field-paths by their
// entity prefix (collection:id) and maps the collection name to an
// activity_log entity_type, deriving the verb (added vs edited) from whether
// the id is a fresh client UUID (_temp_id) or an existing numeric D1 id.

describe("buildActivityRows — snapshot activity emit", () => {
  it("emits one row per (user, entity) for an editor edit, mapping collection → entity_type", () => {
    // User 42 edited the title of an existing story (numeric id 9) and the
    // label of an existing object (numeric id 3) this snapshot window.
    const userFieldSets = new Map<number, Set<string>>([
      [42, new Set<string>(["stories:9:title", "objects:3:label_en"])],
    ]);
    const rows = buildActivityRows([42], userFieldSets, 7);

    expect(rows).toHaveLength(2);

    const byType = new Map(rows.map((r) => [r.entityType, r]));
    const story = byType.get("story");
    const object = byType.get("object");

    expect(story).toBeDefined();
    expect(story!.projectId).toBe(7);
    expect(story!.actorUserId).toBe(42);
    expect(story!.entityId).toBe("9");
    expect(story!.verb).toBe("edited");

    expect(object).toBeDefined();
    expect(object!.entityId).toBe("3");
    expect(object!.entityType).toBe("object");
    expect(object!.verb).toBe("edited");
  });

  it("coalesces multiple field edits on the same entity into one row (coarse)", () => {
    const userFieldSets = new Map<number, Set<string>>([
      [42, new Set<string>(["stories:9:title", "stories:9:subtitle", "stories:9:byline"])],
    ]);
    const rows = buildActivityRows([42], userFieldSets, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("story");
    expect(rows[0].entityId).toBe("9");
  });

  it("derives verb 'added' when the entity id is a fresh client UUID (_temp_id)", () => {
    const tempId = "550e8400-e29b-41d4-a716-446655440000";
    const userFieldSets = new Map<number, Set<string>>([
      [42, new Set<string>([`glossary:${tempId}:title`])],
    ]);
    const rows = buildActivityRows([42], userFieldSets, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("term");
    expect(rows[0].verb).toBe("added");
    expect(rows[0].entityId).toBe(tempId);
  });

  it("attributes each row to its own user (server-resolved actor, never shared)", () => {
    const userFieldSets = new Map<number, Set<string>>([
      [42, new Set<string>(["stories:9:title"])],
      [99, new Set<string>(["pages:about:body"])],
    ]);
    const rows = buildActivityRows([42, 99], userFieldSets, 7);
    expect(rows).toHaveLength(2);
    const story = rows.find((r) => r.entityType === "story")!;
    const page = rows.find((r) => r.entityType === "page")!;
    expect(story.actorUserId).toBe(42);
    expect(page.actorUserId).toBe(99);
    expect(page.entityId).toBe("about");
  });

  it("skips users with no field edits and config edits map to entity_type 'config'", () => {
    const userFieldSets = new Map<number, Set<string>>([
      [42, new Set<string>(["config:title"])],
      [99, new Set<string>()], // no edits — produces no rows
    ]);
    const rows = buildActivityRows([42, 99], userFieldSets, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("config");
    expect(rows[0].actorUserId).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// POST /snapshot — a thrown snapshot must surface as a non-200
// response, never as a rejected fetch (which the publish action swallows).
// ---------------------------------------------------------------------------

describe("collaboration DO — POST /snapshot", () => {
  it("returns 500 with body 'snapshot_failed' when snapshotToD1 throws", async () => {
    const { doInstance, snapshotSpy } = makeDoWithStubs();
    snapshotSpy.mockRejectedValueOnce(new Error("D1_ERROR: batch failed"));

    const req = await makeRequest("/snapshot", "POST");
    const res = await doInstance.fetch(req);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("snapshot_failed");
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 200 OK when snapshotToD1 succeeds", async () => {
    const { doInstance, snapshotSpy } = makeDoWithStubs();
    // makeDoWithStubs already mockResolvedValue(undefined)

    const req = await makeRequest("/snapshot", "POST");
    const res = await doInstance.fetch(req);

    expect(res.status).toBe(200);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsigned /snapshot reach with 401 and does not snapshot", async () => {
    const { doInstance, snapshotSpy } = makeDoWithStubs();

    const req = await makeRequest("/snapshot", "POST", { signed: false });
    const res = await doInstance.fetch(req);

    expect(res.status).toBe(401);
    expect(snapshotSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// webSocketClose — the last-client-disconnect snapshot is best-effort. A
// thrown snapshot must be swallowed-with-log, never surface as an unhandled
// rejection that could crash the DO.
// ---------------------------------------------------------------------------

describe("collaboration DO — webSocketClose last-disconnect snapshot", () => {
  it("does not reject when the last-disconnect snapshot throws", async () => {
    // No sockets populated → ctx.getWebSockets().length === 0 after close,
    // so the last-disconnect snapshot branch runs.
    const { doInstance, snapshotSpy } = makeDoWithStubs([]);
    snapshotSpy.mockRejectedValueOnce(new Error("D1_ERROR: batch failed"));

    // Standalone socket with an attachment that has NO awarenessClientId,
    // so the awareness-removal branch is skipped.
    const ws = fakeSocket(1);

    await expect(
      doInstance.webSocketClose(ws as unknown as WebSocket, 1000),
    ).resolves.toBeUndefined();
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The `/api/persistence` resource route: the loader that reports a project's
 * saving state and the action that restores it.
 *
 * The route is invoked directly with a Request and a context stub, the way
 * `tests/api-site-status-gh.test.ts` invokes its neighbour. What is deliberately
 * NOT mocked is the internal-marker layer: the whole point of the op and the
 * generation being bound into a signature is that the object re-derives them, so
 * the fake Durable Object binding here verifies every captured request with the
 * real `verifyInternalMarker` and a wrong op or a wrong generation is a 401
 * exactly as it would be in production.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  createSessionStorageMock: vi.fn(),
  getUserRoleMock: vi.fn(),
  requireOwnerMock: vi.fn(),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/db.server", () => ({ getDb: mocks.getDbMock }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: mocks.createSessionStorageMock,
}));
vi.mock("~/lib/membership.server", () => ({
  getUserRole: mocks.getUserRoleMock,
  requireOwner: mocks.requireOwnerMock,
  resolveActiveProject: vi.fn(),
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: mocks.userContext }));

import { action, loader } from "../app/routes/api.persistence";
import { verifyInternalMarker } from "../workers/auth";

const TEST_SECRET = "test-session-secret";
const USER = { id: 42 } as { id: number };
const PROJECT_ID = 7;

/** One request the fake object received, with the query it would re-derive. */
interface Captured {
  request: Request;
  url: URL;
}

type Answer = Response | (() => Promise<Response>);

/**
 * A Durable Object binding that answers a script and records what it was asked.
 *
 * Every answer is scripted in order; the last one repeats, so a test that cares
 * only about the reset can leave the readback standing.
 */
function makeCollaboration(answers: Answer[]) {
  const captured: Captured[] = [];
  const queue = [...answers];
  const fetch = vi.fn(async (request: Request) => {
    captured.push({ request, url: new URL(request.url) });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === undefined) throw new Error("no scripted answer left");
    return typeof next === "function" ? await next() : next.clone();
  });
  return {
    captured,
    fetch,
    binding: { idFromName: vi.fn((s: string) => `do-${s}`), get: vi.fn(() => ({ fetch })) },
  };
}

function stateAnswer(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The context the route reads: the authenticated user and the env. */
function makeContext(collaboration: ReturnType<typeof makeCollaboration>, user = USER) {
  return {
    get: (key: unknown) => (key === mocks.userContext ? user : undefined),
    cloudflare: {
      env: { DB: {}, SESSION_SECRET: TEST_SECRET, COLLABORATION: collaboration.binding },
    },
  };
}

/** What the session cookie carries as the active project, for this test. */
function withSessionProject(activeProjectId: unknown) {
  mocks.createSessionStorageMock.mockReturnValue({
    getSession: vi.fn(async () => ({
      get: (key: string) => (key === "activeProjectId" ? activeProjectId : undefined),
    })),
  });
}

function loaderRequest(projectId: string | null): Request {
  const query = projectId === null ? "" : `?projectId=${projectId}`;
  return new Request(`https://compositor.telar.org/api/persistence${query}`);
}

function resetRequest(fields: Record<string, string>): Request {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request("https://compositor.telar.org/api/persistence", {
    method: "POST",
    body,
  });
}

/** What the action returns, as the tests read it. */
interface ResetReportBody {
  projectId: number;
  reset: { kind: string; status?: number; body?: string; generation?: number | null };
  state: Record<string, unknown>;
}

/** Run the handler and hand back whatever Response it produced or threw. */
async function answered(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** The op a captured request's marker verifies against, or null for none. */
async function opOf(entry: Captured, op: string, binding?: string): Promise<boolean> {
  return (await verifyInternalMarker(entry.request, TEST_SECRET, op, binding)) === null;
}

let warnings: string[];

beforeEach(() => {
  vi.clearAllMocks();
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  mocks.getDbMock.mockReturnValue({});
  mocks.getUserRoleMock.mockResolvedValue("convenor");
  mocks.requireOwnerMock.mockResolvedValue(undefined);
  withSessionProject(PROJECT_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

describe("the loader resolves its project strictly and reads the object", () => {
  it("404s when the session carries no active project, even when the first membership would match", async () => {
    withSessionProject(undefined);
    const collab = makeCollaboration([stateAnswer({ halted: false, generation: 1 })]);

    const response = await answered(() =>
      loader({ request: loaderRequest(String(PROJECT_ID)), context: makeContext(collab) } as never),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("no_active_project");
    expect(collab.fetch).not.toHaveBeenCalled();
  });

  it.each([["not-a-number"], ["0"], ["-3"], [""]])(
    "404s on an unusable session id: %s",
    async (sessionId) => {
      withSessionProject(sessionId);
      const collab = makeCollaboration([stateAnswer({ halted: false, generation: 1 })]);

      const response = await answered(() =>
        loader({ request: loaderRequest(String(PROJECT_ID)), context: makeContext(collab) } as never),
      );

      expect(response.status).toBe(404);
      expect(collab.fetch).not.toHaveBeenCalled();
    },
  );

  it("403s when the caller holds no membership in the session's project", async () => {
    mocks.getUserRoleMock.mockResolvedValue(null);
    const collab = makeCollaboration([stateAnswer({ halted: false, generation: 1 })]);

    const response = await answered(() =>
      loader({ request: loaderRequest(String(PROJECT_ID)), context: makeContext(collab) } as never),
    );

    expect(response.status).toBe(403);
    expect(collab.fetch).not.toHaveBeenCalled();
  });

  it("409s when the asserted id differs from the session's, with no object call", async () => {
    const collab = makeCollaboration([stateAnswer({ halted: false, generation: 1 })]);

    const response = await answered(() =>
      loader({ request: loaderRequest("99"), context: makeContext(collab) } as never),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("project_mismatch");
    expect(collab.fetch).not.toHaveBeenCalled();
  });

  it("passes the object's answer through with the project id, signed for its own op", async () => {
    const collab = makeCollaboration([
      stateAnswer({ halted: true, reason: "log_corrupt", at: 99, generation: 4 }),
    ]);

    const response = await loader({
      request: loaderRequest(String(PROJECT_ID)),
      context: makeContext(collab),
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId: PROJECT_ID,
      halted: true,
      reason: "log_corrupt",
      at: 99,
      generation: 4,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(collab.captured[0].url.pathname).toBe("/persistence-state");
    expect(collab.captured[0].request.method).toBe("GET");
    expect(await opOf(collab.captured[0], "persistence-state")).toBe(true);
    expect(await opOf(collab.captured[0], "reset")).toBe(false);
  });

  it("answers a 503 as halted null with the object's body, and forbids caching", async () => {
    const collab = makeCollaboration([new Response("storage_unavailable", { status: 503 })]);

    const response = await loader({
      request: loaderRequest(String(PROJECT_ID)),
      context: makeContext(collab),
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId: PROJECT_ID,
      halted: null,
      unavailable: "storage_unavailable",
    });
    // A cached copy would offer a convenor a generation the object has spent.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

const RESET_FIELDS = {
  intent: "reset",
  projectId: String(PROJECT_ID),
  expectedGeneration: "4",
};

describe("the action refuses before it reaches the object", () => {
  it("lets requireOwner's 403 escape uncaught, before any object call", async () => {
    mocks.requireOwnerMock.mockRejectedValue(new Response("Forbidden", { status: 403 }));
    const collab = makeCollaboration([new Response("OK", { status: 200 })]);

    const response = await answered(() =>
      action({ request: resetRequest(RESET_FIELDS), context: makeContext(collab) } as never),
    );

    expect(response.status).toBe(403);
    expect(collab.fetch).not.toHaveBeenCalled();
  });

  it("409s on an asserted id that differs, before any object call", async () => {
    const collab = makeCollaboration([new Response("OK", { status: 200 })]);

    const response = await answered(() =>
      action({
        request: resetRequest({ ...RESET_FIELDS, projectId: "99" }),
        context: makeContext(collab),
      } as never),
    );

    expect(response.status).toBe(409);
    expect(collab.fetch).not.toHaveBeenCalled();
  });

  it.each([["-1"], ["4.0"], ["04"], ["1e3"], [""], ["nine"], ["9007199254740993"]])(
    "400s on a generation that is not canonical: %s",
    async (generation) => {
      const collab = makeCollaboration([new Response("OK", { status: 200 })]);

      const response = await answered(() =>
        action({
          request: resetRequest({ ...RESET_FIELDS, expectedGeneration: generation }),
          context: makeContext(collab),
        } as never),
      );

      expect(response.status).toBe(400);
      expect(collab.fetch).not.toHaveBeenCalled();
      expect(mocks.requireOwnerMock).not.toHaveBeenCalled();
    },
  );

  it("400s an unknown intent", async () => {
    const collab = makeCollaboration([new Response("OK", { status: 200 })]);

    const response = await answered(() =>
      action({
        request: resetRequest({ ...RESET_FIELDS, intent: "wipe" }),
        context: makeContext(collab),
      } as never),
    );

    expect(response.status).toBe(400);
    expect(collab.fetch).not.toHaveBeenCalled();
  });
});

describe("the action sends one guarded reset and reads the state after it", () => {
  it("POSTs /reset once with the generation in the query and in the signature", async () => {
    const collab = makeCollaboration([
      new Response("OK", { status: 200 }),
      stateAnswer({ halted: false, generation: 5 }),
    ]);

    const response = await action({
      request: resetRequest(RESET_FIELDS),
      context: makeContext(collab),
    } as never);
    const body = (await response.json()) as ResetReportBody;

    expect(collab.captured).toHaveLength(2);
    const reset = collab.captured[0];
    expect(reset.request.method).toBe("POST");
    expect(reset.url.pathname).toBe("/reset");
    expect(reset.url.searchParams.get("expectedGeneration")).toBe("4");
    expect(reset.url.searchParams.get("requireNotHalted")).toBeNull();
    expect(await opOf(reset, "reset", "4")).toBe(true);
    // A marker bound to another generation, or to no generation at all, is a
    // different message and does not verify.
    expect(await opOf(reset, "reset", "5")).toBe(false);
    expect(await opOf(reset, "reset")).toBe(false);
    expect(body).toEqual({
      projectId: PROJECT_ID,
      reset: { kind: "landed" },
      state: { projectId: PROJECT_ID, halted: false, generation: 5 },
    });
  });

  it.each([
    [200, "OK", { kind: "landed" }],
    [409, "reset_stale:9", { kind: "stale", generation: 9 }],
    [503, "reset_failed", { kind: "retry" }],
    [401, "Unauthorized", { kind: "failed", status: 401, body: "Unauthorized" }],
  ])("maps %s %s to its outcome", async (status, body, expected) => {
    const collab = makeCollaboration([
      new Response(body, { status }),
      stateAnswer({ halted: false, generation: 5 }),
    ]);

    const response = await action({
      request: resetRequest(RESET_FIELDS),
      context: makeContext(collab),
    } as never);

    expect(((await response.json()) as ResetReportBody).reset).toEqual(expected);
  });

  it("reports a thrown reset as uncertain and still reads the state", async () => {
    const collab = makeCollaboration([
      () => Promise.reject(new Error("DO unreachable")),
      stateAnswer({ halted: false, generation: 5 }),
    ]);

    const response = await action({
      request: resetRequest(RESET_FIELDS),
      context: makeContext(collab),
    } as never);
    const body = (await response.json()) as ResetReportBody;

    expect(body.reset).toEqual({ kind: "uncertain" });
    expect(body.state).toEqual({ projectId: PROJECT_ID, halted: false, generation: 5 });
  });

  it("keeps an uncertain reset uncertain even when the readback shows a later generation", async () => {
    const collab = makeCollaboration([
      () => Promise.reject(new Error("DO unreachable")),
      stateAnswer({ halted: false, generation: 5 }),
    ]);

    const response = await action({
      request: resetRequest(RESET_FIELDS),
      context: makeContext(collab),
    } as never);
    const body = (await response.json()) as ResetReportBody;

    // The generation advances before the rebuild, so a moved generation proves
    // neither a landed replacement nor that this reset was what moved it.
    expect(body.reset.kind).toBe("uncertain");
    expect(body.state.generation).toBe(5);
  });

  it("reports a landed reset with an unreadable readback as landed, not as a failure", async () => {
    let call = 0;
    const collab = makeCollaboration([
      () => {
        call += 1;
        return call === 1
          ? Promise.resolve(new Response("OK", { status: 200 }))
          : Promise.reject(new Error("DO unreachable"));
      },
    ]);

    const response = await action({
      request: resetRequest(RESET_FIELDS),
      context: makeContext(collab),
    } as never);
    const body = (await response.json()) as ResetReportBody;

    expect(body.reset).toEqual({ kind: "landed" });
    expect(body.state).toEqual({ unreadable: true });
  });

  it("logs one line, with the project id, only for an unnamed status", async () => {
    const collab = makeCollaboration([
      new Response("Unauthorized", { status: 401 }),
      stateAnswer({ halted: false, generation: 5 }),
    ]);

    await action({ request: resetRequest(RESET_FIELDS), context: makeContext(collab) } as never);

    expect(warnings.filter((l) => l.includes("[persistence-reset] project 7"))).toHaveLength(1);
  });

  it("signs the readback for its own op, not for the reset's", async () => {
    const collab = makeCollaboration([
      new Response("OK", { status: 200 }),
      stateAnswer({ halted: true, reason: "apply_failed", at: 3, generation: 5 }),
    ]);

    await action({ request: resetRequest(RESET_FIELDS), context: makeContext(collab) } as never);

    expect(await opOf(collab.captured[1], "persistence-state")).toBe(true);
    expect(await opOf(collab.captured[1], "reset", "4")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("the route is registered where its middleware and session come from", () => {
  it("sits inside the _app layout and exports both a loader and an action", async () => {
    const routes = (await import("../app/routes")).default as unknown as Array<{
      file?: string;
      children?: Array<{ path?: string; file?: string }>;
    }>;
    const layout = routes.find((entry) => entry.file === "routes/_app.tsx");

    expect(layout?.children?.some(
      (child) => child.path === "/api/persistence" && child.file === "routes/api.persistence.tsx",
    )).toBe(true);

    const module = await import("../app/routes/api.persistence");
    expect(typeof module.loader).toBe("function");
    expect(typeof module.action).toBe("function");
    // A resource route: no component, so a navigation to it serves the data.
    expect("default" in module).toBe(false);
  });
});

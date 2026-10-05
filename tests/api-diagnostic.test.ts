/**
 * The `/api/diagnostic` resource route: the convenor's read of a collaboration
 * object's persistence, and the two staging-only controls.
 *
 * The route is invoked directly with a Request and a context stub, the way
 * `tests/api-persistence.test.ts` invokes its neighbour. What is deliberately
 * NOT mocked is the internal-marker layer: the op and the control string being
 * bound into a signature is the whole reason the object can tell one control
 * from another, so the fake Durable Object binding here verifies every captured
 * request with the real `verifyInternalMarker`.
 *
 * `describeBuild` and the route's registration are asserted here too: both are
 * pure reads of a module, and neither needs workerd.
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

// `describeBuild` lives beside the object that reads it, and importing that
// module in Node needs the platform's base class to be a plain one.
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

import { action, loader } from "../app/routes/api.diagnostic";
import { verifyInternalMarker } from "../workers/auth";
import { describeBuild } from "../workers/collaboration";
import routes from "../app/routes";

const TEST_SECRET = "test-session-secret";
const USER = { id: 42 } as { id: number };
const PROJECT_ID = 7;

interface Captured {
  request: Request;
  url: URL;
}

/** A Durable Object binding that answers a script and records what it was asked. */
function makeCollaboration(answers: Response[]) {
  const captured: Captured[] = [];
  const queue = [...answers];
  const fetch = vi.fn(async (request: Request) => {
    captured.push({ request, url: new URL(request.url) });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === undefined) throw new Error("no scripted answer left");
    return next.clone();
  });
  return {
    captured,
    fetch,
    binding: { idFromName: vi.fn((s: string) => `do-${s}`), get: vi.fn(() => ({ fetch })) },
  };
}

function objectAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeContext(collaboration: ReturnType<typeof makeCollaboration>, user = USER) {
  return {
    get: (key: unknown) => (key === mocks.userContext ? user : undefined),
    cloudflare: {
      env: { DB: {}, SESSION_SECRET: TEST_SECRET, COLLABORATION: collaboration.binding },
    },
  };
}

function withSessionProject(activeProjectId: unknown) {
  mocks.createSessionStorageMock.mockReturnValue({
    getSession: vi.fn(async () => ({
      get: (key: string) => (key === "activeProjectId" ? activeProjectId : undefined),
    })),
  });
}

function readRequest(query: string): Request {
  return new Request(`https://compositor.telar.org/api/diagnostic${query}`);
}

function controlRequest(fields: Record<string, string>): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request("https://compositor.telar.org/api/diagnostic", { method: "POST", body });
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDbMock.mockReturnValue({});
  mocks.getUserRoleMock.mockResolvedValue("convenor");
  mocks.requireOwnerMock.mockResolvedValue(undefined);
  withSessionProject(PROJECT_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the loader gates the read and passes the object's answer through", () => {
  it("404s with no active project and 409s on a mismatched assertion", async () => {
    withSessionProject(undefined);
    const missing = makeCollaboration([objectAnswer({})]);
    const noProject = await answered(() =>
      loader({ request: readRequest(`?projectId=${PROJECT_ID}`), context: makeContext(missing) } as never),
    );
    expect(noProject.status).toBe(404);
    expect(missing.fetch).not.toHaveBeenCalled();

    withSessionProject(PROJECT_ID);
    const mismatched = makeCollaboration([objectAnswer({})]);
    const wrongProject = await answered(() =>
      loader({ request: readRequest("?projectId=99"), context: makeContext(mismatched) } as never),
    );
    expect(wrongProject.status).toBe(409);
    expect(await wrongProject.text()).toBe("project_mismatch");
    expect(mismatched.fetch).not.toHaveBeenCalled();
  });

  it("403s a caller who is not the convenor, before the object is reached", async () => {
    mocks.requireOwnerMock.mockRejectedValue(new Response("Forbidden", { status: 403 }));
    const collab = makeCollaboration([objectAnswer({})]);

    const response = await answered(() =>
      loader({ request: readRequest(`?projectId=${PROJECT_ID}`), context: makeContext(collab) } as never),
    );

    expect(response.status).toBe(403);
    expect(collab.fetch).not.toHaveBeenCalled();
  });

  it("forwards a malformed count as supplied, so the object refuses it", async () => {
    // The policy on the value is the object's — `400 bad_count` on staging,
    // `403` off it — and a route that filtered the value would answer a
    // malformed request with an ordinary read.
    for (const count of ["abc", "-1", "1e3", ""]) {
      const collab = makeCollaboration([new Response("bad_count", { status: 400 })]);
      const response = await loader({
        request: readRequest(`?projectId=${PROJECT_ID}&count=${count}`),
        context: makeContext(collab),
      } as never);

      expect(response.status, count).toBe(400);
      expect(await response.text()).toBe("bad_count");
      expect(collab.captured[0].url.searchParams.get("count"), count).toBe(count);
    }

    // An option the route does not know is still dropped: a query it never
    // composed is a question the object cannot be made to answer.
    const unknown = makeCollaboration([objectAnswer({})]);
    await loader({
      request: readRequest(`?projectId=${PROJECT_ID}&validate=maybe&other=x`),
      context: makeContext(unknown),
    } as never);
    expect(unknown.captured[0].url.searchParams.get("validate")).toBe("maybe");
    expect(unknown.captured[0].url.searchParams.get("other")).toBeNull();
  });

  it("signs for its own op, forwards only the options it composed, and never caches", async () => {
    const collab = makeCollaboration([objectAnswer({ object: { nonce: "n" } })]);

    const response = await loader({
      request: readRequest(`?projectId=${PROJECT_ID}&validate=1&count=12&other=x`),
      context: makeContext(collab),
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: { nonce: "n" } });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const asked = collab.captured[0];
    expect(asked.url.pathname).toBe("/diagnostic");
    expect(asked.url.searchParams.get("validate")).toBe("1");
    expect(asked.url.searchParams.get("count")).toBe("12");
    expect(asked.url.searchParams.get("other")).toBeNull();
    expect(await verifyInternalMarker(asked.request, TEST_SECRET, "diagnostic")).toBeNull();
    // A marker minted for this read cannot reach the controls.
    expect(
      await verifyInternalMarker(asked.request, TEST_SECRET, "diagnostic-control", "record=1"),
    ).not.toBeNull();
  });

  it("passes the object's own status through, the hold's 409 included", async () => {
    const collab = makeCollaboration([new Response("snapshot_in_flight", { status: 409 })]);

    const response = await loader({
      request: readRequest(`?projectId=${PROJECT_ID}`),
      context: makeContext(collab),
    } as never);

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("snapshot_in_flight");
  });
});

describe("the action reads its control from the form and binds it into the marker", () => {
  it("refuses an intent or a value outside the pair", async () => {
    for (const fields of [
      { projectId: String(PROJECT_ID), intent: "reset", value: "1" },
      { projectId: String(PROJECT_ID), intent: "record", value: "yes" },
    ]) {
      const collab = makeCollaboration([objectAnswer({})]);
      const response = await answered(() =>
        action({ request: controlRequest(fields), context: makeContext(collab) } as never),
      );
      expect(response.status).toBe(400);
      expect(collab.fetch).not.toHaveBeenCalled();
    }
  });

  it("asserts the form's project against the session's", async () => {
    const collab = makeCollaboration([objectAnswer({})]);
    const response = await answered(() =>
      action({
        request: controlRequest({ projectId: "99", intent: "hold", value: "1" }),
        context: makeContext(collab),
      } as never),
    );
    expect(response.status).toBe(409);
    expect(collab.fetch).not.toHaveBeenCalled();
  });

  it("403s a caller who is not the convenor", async () => {
    mocks.requireOwnerMock.mockRejectedValue(new Response("Forbidden", { status: 403 }));
    const collab = makeCollaboration([objectAnswer({})]);
    const response = await answered(() =>
      action({
        request: controlRequest({ projectId: String(PROJECT_ID), intent: "hold", value: "1" }),
        context: makeContext(collab),
      } as never),
    );
    expect(response.status).toBe(403);
    expect(collab.fetch).not.toHaveBeenCalled();
  });

  it("signs the control string it sends, and passes the object's refusal through", async () => {
    const collab = makeCollaboration([new Response("snapshot_in_flight", { status: 409 })]);

    const response = await action({
      request: controlRequest({ projectId: String(PROJECT_ID), intent: "hold", value: "1" }),
      context: makeContext(collab),
    } as never);

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("snapshot_in_flight");
    const asked = collab.captured[0];
    expect(asked.request.method).toBe("POST");
    expect(asked.url.pathname).toBe("/diagnostic");
    expect(asked.url.searchParams.get("hold")).toBe("1");
    expect(
      await verifyInternalMarker(asked.request, TEST_SECRET, "diagnostic-control", "hold=1"),
    ).toBeNull();
    // The other control string, and the other value, are both refused.
    expect(
      await verifyInternalMarker(asked.request, TEST_SECRET, "diagnostic-control", "hold=0"),
    ).not.toBeNull();
    expect(
      await verifyInternalMarker(asked.request, TEST_SECRET, "diagnostic-control", "record=1"),
    ).not.toBeNull();
  });
});

describe("describeBuild answers from the binding, or null without one", () => {
  it("reports the deployed version when the binding is present", () => {
    expect(describeBuild({
      CF_VERSION_METADATA: { id: "v1", tag: "t", timestamp: "2026-09-09T00:00:00Z" },
    } as Partial<Env>)).toEqual({ id: "v1", tag: "t", timestamp: "2026-09-09T00:00:00Z" });
  });

  it("answers null for an absent or unusable binding", () => {
    expect(describeBuild({})).toBeNull();
    expect(describeBuild({ CF_VERSION_METADATA: { id: 1 } } as unknown as Partial<Env>)).toBeNull();
  });
});

describe("the route is registered inside the authenticated shell", () => {
  it("sits beside api.persistence under the _app layout", () => {
    const layout = routes.find(
      (entry) => "file" in entry && entry.file === "routes/_app.tsx",
    ) as { children?: Array<{ path?: string; file?: string }> } | undefined;
    const paths = (layout?.children ?? []).map((child) => child.path);
    expect(paths).toContain("/api/diagnostic");
    expect(paths).toContain("/api/persistence");
    const registered = (layout?.children ?? []).find(
      (child) => child.path === "/api/diagnostic",
    );
    expect(registered?.file).toBe("routes/api.diagnostic.tsx");
  });
});

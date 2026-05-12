/**
 * This file tests the `/account` action handler — the route that powers
 * the dashboard's project-management actions (delete-project,
 * leave-project, get-active-ws-count) plus the destructive
 * delete-account intent.
 *
 * Strategy: import the action() export from app/routes/_app.account.tsx
 * with `requireOwner`, `requireProjectMember`, `deleteProjectCascade`
 * mocked. Drive each intent end-to-end with a minimal Request +
 * RouterContext stub; assert on the recorded mock calls and the action's
 * return value.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the heavy server-only dependencies BEFORE importing the route.
// `vi.hoisted` is the supported way to share state between top-level
// `const` declarations and the hoisted `vi.mock` factories — without it,
// the factories execute before the consts are initialised.
const mocks = vi.hoisted(() => ({
  requireOwnerMock: vi.fn(),
  requireProjectMemberMock: vi.fn(),
  deleteProjectCascadeMock: vi.fn(),
  getUserProjectsWithStatsMock: vi.fn(),
  listUserInstallationsMock: vi.fn(),
  // delete-account intent additions.
  dbBatchMock: vi.fn(async () => undefined),
  dbSelectMock: vi.fn(),
  destroySessionMock: vi.fn(
    async () => "__compositor_session=; Max-Age=0; Path=/; HttpOnly",
  ),
  getSessionMock: vi.fn(async () => ({ id: "session-stub" })),
}));
const {
  requireOwnerMock,
  requireProjectMemberMock,
  deleteProjectCascadeMock,
} = mocks;

vi.mock("~/lib/membership.server", () => ({
  requireOwner: mocks.requireOwnerMock,
  requireProjectMember: mocks.requireProjectMemberMock,
  getUserProjectsWithStats: mocks.getUserProjectsWithStatsMock,
}));

vi.mock("~/lib/import.server", () => ({
  deleteProjectCascade: mocks.deleteProjectCascadeMock,
}));

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: mocks.listUserInstallationsMock,
}));

// db mock: leave-project uses `db.delete(...).where(...)` directly as an
// awaited drizzle chain (the chain itself resolves). delete-account uses
// `db.delete(...).where(...)` to BUILD query builders that are then passed
// into `db.batch([...])` without being awaited individually. To support
// both, .where() returns a builder-shaped object that is both
// thenable-on-await AND carries a .toSQL() method whose .sql string
// includes the table name (so Test E can assert FK ordering).
function makeDeleteBuilder(table: string) {
  const builder = {
    table,
    toSQL: () => ({ sql: `delete from ${table}`, params: [] }),
    // Thenable so `await db.delete(...).where(...)` (the leave-project path)
    // still resolves cleanly without firing the batch.
    then: (resolve: (v: undefined) => unknown) => resolve(undefined),
  };
  return builder;
}

// Drizzle table objects expose their SQLite name on Symbol(drizzle:Name).
// Use the Symbol.for registry — `getDrizzleTableName` is identical across
// every drizzle table object in the codebase.
const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");
function getDrizzleTableName(table: unknown): string {
  const indexed = table as Record<symbol, unknown>;
  const name = indexed[DRIZZLE_NAME_SYMBOL];
  return typeof name === "string" ? name : "unknown";
}

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    delete: vi.fn((t: unknown) => {
      const name = getDrizzleTableName(t);
      return {
        where: vi.fn(() => makeDeleteBuilder(name)),
      };
    }),
    // delete-account race-guard SELECT — chainable .from().where() that
    // resolves to whatever the test sets via mocks.dbSelectMock.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => mocks.dbSelectMock()),
      })),
    })),
    batch: mocks.dbBatchMock,
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "decrypted-token"),
}));

// Session storage — delete-account calls destroySession + returns
// the Max-Age=0 Set-Cookie header on its redirect response.
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: mocks.getSessionMock,
    destroySession: mocks.destroySessionMock,
  })),
}));

vi.mock("~/i18n/i18next.server", () => ({
  getLocale: vi.fn(async () => "en"),
}));

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

import { action } from "../app/routes/_app.account";
import { signInternalMarker } from "../workers/auth";
import { userContext as userContextStub } from "~/middleware/auth.server";

const TEST_SECRET = "test-session-secret";

interface RecordedDoCall {
  url: string;
  method: string;
  hasMarker: boolean;
}

let doCalls: RecordedDoCall[];
let doFetchMock: ReturnType<typeof vi.fn>;

function makeContext(opts: {
  userId: number;
  doResponse?: () => Promise<Response>;
}) {
  doCalls = [];
  doFetchMock = vi.fn(async (req: Request) => {
    doCalls.push({
      url: req.url,
      method: req.method,
      hasMarker: !!req.headers.get("X-Internal-Auth"),
    });
    return opts.doResponse ? opts.doResponse() : new Response("OK", { status: 200 });
  });

  const env = {
    DB: {} as unknown,
    SESSION_SECRET: TEST_SECRET,
    ENCRYPTION_KEY: "test-encryption-key",
    GITHUB_APP_SLUG: "test-app",
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({ fetch: doFetchMock })),
    },
  };

  return {
    get: (key: unknown) => {
      if (key === userContextStub) {
        return {
          id: opts.userId,
          github_id: 1,
          github_login: "tester",
          github_name: null,
          github_email: null,
          encrypted_access_token: "encrypted",
          created_at: null,
        };
      }
      return undefined;
    },
    cloudflare: { env },
  };
}

function makeFormRequest(body: Record<string, string>): Request {
  const formData = new FormData();
  for (const [k, v] of Object.entries(body)) formData.set(k, v);
  return new Request("https://example.workers.dev/account", {
    method: "POST",
    body: formData,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// delete-project intent
// ---------------------------------------------------------------------------

describe("/account action — delete-project intent", () => {
  it("convenor: cascades D1 (deleteProjectCascade) then RPCs DO /notify-deleted; returns { ok: true, intent: 'delete-project' }", async () => {
    requireOwnerMock.mockResolvedValue(undefined);
    deleteProjectCascadeMock.mockResolvedValue(undefined);
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-project", projectId: "42" });

    const res = (await action({ request: req, context: ctx } as never)) as
      | { ok: boolean; intent?: string }
      | Response;

    expect(res).not.toBeInstanceOf(Response);
    expect((res as { ok: boolean; intent: string }).ok).toBe(true);
    expect((res as { intent: string }).intent).toBe("delete-project");

    // Cascade order: requireOwner BEFORE deleteProjectCascade BEFORE DO RPC
    expect(requireOwnerMock).toHaveBeenCalledTimes(1);
    expect(deleteProjectCascadeMock).toHaveBeenCalledTimes(1);
    expect(doFetchMock).toHaveBeenCalledTimes(1);
    expect(doCalls[0].url).toBe("https://internal/notify-deleted");
    expect(doCalls[0].method).toBe("POST");
    expect(doCalls[0].hasMarker).toBe(true);

    // Order check: cascade must run before DO RPC
    const cascadeOrder = deleteProjectCascadeMock.mock.invocationCallOrder[0];
    const doOrder = doFetchMock.mock.invocationCallOrder[0];
    expect(cascadeOrder).toBeLessThan(doOrder);
  });

  it("collaborator: requireOwner throws 403 (no cascade, no DO RPC)", async () => {
    requireOwnerMock.mockRejectedValue(new Response("Forbidden", { status: 403 }));
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-project", projectId: "42" });

    let thrown: unknown = null;
    try {
      await action({ request: req, context: ctx } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
    expect(deleteProjectCascadeMock).not.toHaveBeenCalled();
    expect(doFetchMock).not.toHaveBeenCalled();
  });

  it("DO RPC failure does not roll back D1 cascade (acceptable degradation)", async () => {
    requireOwnerMock.mockResolvedValue(undefined);
    deleteProjectCascadeMock.mockResolvedValue(undefined);
    const ctx = makeContext({
      userId: 7,
      doResponse: async () => {
        throw new Error("DO unreachable");
      },
    });
    const req = makeFormRequest({ intent: "delete-project", projectId: "42" });

    const res = (await action({ request: req, context: ctx } as never)) as {
      ok: boolean;
      intent: string;
    };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("delete-project");
    expect(deleteProjectCascadeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-numeric projectId (V5 input validation)", async () => {
    requireOwnerMock.mockResolvedValue(undefined);
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-project", projectId: "abc" });

    const res = (await action({ request: req, context: ctx } as never)) as {
      ok: boolean;
      error?: string;
    };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_project_id");
    expect(deleteProjectCascadeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// leave-project intent
// ---------------------------------------------------------------------------

describe("/account action — leave-project intent", () => {
  it("any member can call: requireProjectMember runs, then DO RPC fired with userId param; returns { ok: true, intent: 'leave-project' }", async () => {
    requireProjectMemberMock.mockResolvedValue(undefined);
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "leave-project", projectId: "42" });

    const res = (await action({ request: req, context: ctx } as never)) as {
      ok: boolean;
      intent: string;
    };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("leave-project");
    expect(requireProjectMemberMock).toHaveBeenCalledTimes(1);
    expect(doFetchMock).toHaveBeenCalledTimes(1);
    // Single-socket variant — userId query param present
    expect(doCalls[0].url).toContain("/notify-deleted?userId=7");
    expect(doCalls[0].hasMarker).toBe(true);
  });

  it("non-member: requireProjectMember throws 403", async () => {
    requireProjectMemberMock.mockRejectedValue(
      new Response("Forbidden", { status: 403 }),
    );
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "leave-project", projectId: "42" });

    let thrown: unknown = null;
    try {
      await action({ request: req, context: ctx } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
    expect(doFetchMock).not.toHaveBeenCalled();
  });

  it("DO RPC failure is swallowed (best-effort; D1 row deletion already happened)", async () => {
    requireProjectMemberMock.mockResolvedValue(undefined);
    const ctx = makeContext({
      userId: 7,
      doResponse: async () => {
        throw new Error("DO unreachable");
      },
    });
    const req = makeFormRequest({ intent: "leave-project", projectId: "42" });

    const res = (await action({ request: req, context: ctx } as never)) as {
      ok: boolean;
      intent: string;
    };

    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get-active-ws-count intent
// ---------------------------------------------------------------------------

describe("/account action — get-active-ws-count intent", () => {
  it("convenor: returns { ok: true, count: N } from DO /active-ws-count", async () => {
    requireOwnerMock.mockResolvedValue(undefined);
    const ctx = makeContext({
      userId: 7,
      doResponse: async () =>
        new Response(JSON.stringify({ count: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const req = makeFormRequest({
      intent: "get-active-ws-count",
      projectId: "42",
    });

    const res = (await action({ request: req, context: ctx } as never)) as {
      ok: boolean;
      count: number | null;
    };

    expect(res.ok).toBe(true);
    expect(res.count).toBe(3);
    expect(doCalls[0].url).toBe(
      "https://internal/active-ws-count?exceptUserId=7",
    );
    expect(doCalls[0].method).toBe("GET");
  });

  it("DO unreachable: returns { ok: true, count: null } (informational only — modal omits warning)", async () => {
    requireOwnerMock.mockResolvedValue(undefined);
    const ctx = makeContext({
      userId: 7,
      doResponse: async () => {
        throw new Error("network");
      },
    });
    const req = makeFormRequest({
      intent: "get-active-ws-count",
      projectId: "42",
    });

    const res = (await action({ request: req, context: ctx } as never)) as {
      ok: boolean;
      count: number | null;
    };

    expect(res.ok).toBe(true);
    expect(res.count).toBeNull();
  });

  it("non-convenor: requireOwner throws 403", async () => {
    requireOwnerMock.mockRejectedValue(
      new Response("Forbidden", { status: 403 }),
    );
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({
      intent: "get-active-ws-count",
      projectId: "42",
    });

    let thrown: unknown = null;
    try {
      await action({ request: req, context: ctx } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Unknown intent
// ---------------------------------------------------------------------------

describe("/account action — unknown intent", () => {
  it("returns { ok: false, error: 'unknown_intent' } for unrecognised intents", async () => {
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "fly-to-mars", projectId: "42" });
    const res = (await action({ request: req, context: ctx } as never)) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unknown_intent");
  });
});

// ---------------------------------------------------------------------------
// delete-account intent
// ---------------------------------------------------------------------------

describe("/account action — delete-account intent", () => {
  beforeEach(() => {
    mocks.dbBatchMock.mockReset();
    mocks.dbBatchMock.mockResolvedValue(undefined);
    mocks.dbSelectMock.mockReset();
    mocks.destroySessionMock.mockClear();
    mocks.getSessionMock.mockClear();
    mocks.deleteProjectCascadeMock.mockReset();
    mocks.deleteProjectCascadeMock.mockResolvedValue(undefined);
  });

  it("happy path: race-guard sees 0 convened projects → batch(3) → 302 redirect + Set-Cookie", async () => {
    // Two sequential SELECTs: race-guard (collab-only) → []; then
    // solo-cascade scan → also []. Both return empty so the action skips
    // straight to the user-row batch.
    mocks.dbSelectMock.mockReturnValueOnce([]).mockReturnValueOnce([]);
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-account" });

    const res = await action({ request: req, context: ctx } as never);

    // The action returns a Response from redirect().
    expect(res).toBeInstanceOf(Response);
    const r = res as Response;
    // react-router redirect() uses 302 by default.
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/signin?reason=account_deleted");
    // Set-Cookie is whatever destroySession returned.
    expect(r.headers.get("Set-Cookie")).toContain("Max-Age=0");

    // batch called exactly once with three operations.
    expect(mocks.dbBatchMock).toHaveBeenCalledTimes(1);
    const ops = (mocks.dbBatchMock.mock.calls[0] as unknown as [
      Array<{ toSQL: () => { sql: string } }>,
    ])[0];
    expect(ops).toHaveLength(3);

    expect(mocks.destroySessionMock).toHaveBeenCalledTimes(1);
  });

  it("race-guard fires: returns { ok:false, error:'convened_projects_exist' } without touching batch or session", async () => {
    // First SELECT (race-guard) returns a collab-convened project → gate.
    mocks.dbSelectMock.mockReturnValueOnce([{ id: 7 }]);
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-account" });

    const res = (await action({ request: req, context: ctx } as never)) as {
      ok: boolean;
      intent: string;
      error: string;
    };

    expect(res.ok).toBe(false);
    expect(res.intent).toBe("delete-account");
    expect(res.error).toBe("convened_projects_exist");

    // No state changes whatsoever on the race-guard path.
    expect(mocks.dbBatchMock).not.toHaveBeenCalled();
    expect(mocks.destroySessionMock).not.toHaveBeenCalled();
    expect(mocks.getSessionMock).not.toHaveBeenCalled();
    // Gate fires: no solo-cascade calls.
    expect(mocks.deleteProjectCascadeMock).not.toHaveBeenCalled();
  });

  it("cascade atomicity: db.batch rejection propagates (no Set-Cookie, no redirect)", async () => {
    mocks.dbSelectMock.mockReturnValueOnce([]).mockReturnValueOnce([]);
    mocks.dbBatchMock.mockRejectedValueOnce(new Error("simulated batch failure"));
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-account" });

    let thrown: unknown = null;
    try {
      await action({ request: req, context: ctx } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("simulated batch failure");

    // destroySession must NOT run when batch fails — the action is not
    // allowed to catch-and-swallow.
    expect(mocks.destroySessionMock).not.toHaveBeenCalled();
  });

  it("auth guard: anonymous request throws 401 BEFORE any DB call", async () => {
    const ctx = {
      get: () => null,
      cloudflare: {
        env: {
          DB: {} as unknown,
          SESSION_SECRET: TEST_SECRET,
          ENCRYPTION_KEY: "test-encryption-key",
          GITHUB_APP_SLUG: "test-app",
        },
      },
    };
    const req = makeFormRequest({ intent: "delete-account" });

    let thrown: unknown = null;
    try {
      await action({ request: req, context: ctx } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);

    // Defence-in-depth: no DB / session touch on the anonymous path.
    expect(mocks.dbBatchMock).not.toHaveBeenCalled();
    expect(mocks.dbSelectMock).not.toHaveBeenCalled();
    expect(mocks.destroySessionMock).not.toHaveBeenCalled();
  });

  it("FK ordering: batch ops are passed in [project_invites, project_members, users] order", async () => {
    mocks.dbSelectMock.mockReturnValueOnce([]).mockReturnValueOnce([]);
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-account" });

    await action({ request: req, context: ctx } as never);

    expect(mocks.dbBatchMock).toHaveBeenCalledTimes(1);
    const ops = (mocks.dbBatchMock.mock.calls[0] as unknown as [
      Array<{ toSQL: () => { sql: string } }>,
    ])[0];
    expect(ops).toHaveLength(3);

    // Per-index SQL substring assertions. A misordered cascade MUST fail
    // this test (project_invites and project_members both
    // FK-reference users.id, so users MUST be the last op).
    expect(ops[0].toSQL().sql).toMatch(/project_invites/i);
    expect(ops[1].toSQL().sql).toMatch(/project_members/i);
    expect(ops[2].toSQL().sql).toMatch(/\busers\b/i);
  });
});

// ---------------------------------------------------------------------------
// delete-account intent — solo-cascade variant
// ---------------------------------------------------------------------------

describe("/account action — delete-account intent (solo-cascade)", () => {
  beforeEach(() => {
    mocks.dbBatchMock.mockReset();
    mocks.dbBatchMock.mockResolvedValue(undefined);
    mocks.dbSelectMock.mockReset();
    mocks.destroySessionMock.mockClear();
    mocks.getSessionMock.mockClear();
    mocks.deleteProjectCascadeMock.mockReset();
    mocks.deleteProjectCascadeMock.mockResolvedValue(undefined);
  });

  it("(a): zero solo projects — deleteProjectCascade never called; main batch fires once", async () => {
    // race-guard (collab-only) → []; solo scan → [].
    mocks.dbSelectMock.mockReturnValueOnce([]).mockReturnValueOnce([]);
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-account" });

    const res = await action({ request: req, context: ctx } as never);

    expect(res).toBeInstanceOf(Response);
    expect(mocks.deleteProjectCascadeMock).not.toHaveBeenCalled();
    expect(mocks.dbBatchMock).toHaveBeenCalledTimes(1);
  });

  it("(b): N solo projects — deleteProjectCascade called N times with each projectId; main batch then fires", async () => {
    // race-guard → []; solo scan → 3 solo project ids.
    mocks.dbSelectMock
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ id: 101 }, { id: 102 }, { id: 103 }]);
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-account" });

    const res = await action({ request: req, context: ctx } as never);

    expect(res).toBeInstanceOf(Response);
    expect(mocks.deleteProjectCascadeMock.mock.calls.length).toBe(3);
    // Each invocation receives (db, projectId). Assert the projectId arg
    // for each call.
    expect(mocks.deleteProjectCascadeMock.mock.calls[0][1]).toBe(101);
    expect(mocks.deleteProjectCascadeMock.mock.calls[1][1]).toBe(102);
    expect(mocks.deleteProjectCascadeMock.mock.calls[2][1]).toBe(103);

    // Solo cascades must run BEFORE the user-row batch.
    const lastCascadeOrder =
      mocks.deleteProjectCascadeMock.mock.invocationCallOrder[2];
    const batchOrder = mocks.dbBatchMock.mock.invocationCallOrder[0];
    expect(lastCascadeOrder).toBeLessThan(batchOrder);

    expect(mocks.dbBatchMock).toHaveBeenCalledTimes(1);
  });

  it("(c): race-guard with collab project mid-flight — returns convened_projects_exist; no cascade calls, no main batch", async () => {
    // race-guard SELECT sees a collab-bearing project → gate.
    mocks.dbSelectMock.mockReturnValueOnce([{ id: 555 }]);
    const ctx = makeContext({ userId: 7 });
    const req = makeFormRequest({ intent: "delete-account" });

    const res = (await action({ request: req, context: ctx } as never)) as {
      ok: boolean;
      intent: string;
      error: string;
    };

    expect(res.ok).toBe(false);
    expect(res.intent).toBe("delete-account");
    expect(res.error).toBe("convened_projects_exist");

    expect(mocks.deleteProjectCascadeMock).not.toHaveBeenCalled();
    expect(mocks.dbBatchMock).not.toHaveBeenCalled();
    expect(mocks.destroySessionMock).not.toHaveBeenCalled();
  });
});

// Sanity: signed marker shape is what we expect (regression on shared infra).
describe("signInternalMarker (regression)", () => {
  it("returns 64-char sigHex + numeric timestamp", async () => {
    const { sigHex, timestamp } = await signInternalMarker(42, TEST_SECRET);
    expect(sigHex).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof timestamp).toBe("number");
  });
});

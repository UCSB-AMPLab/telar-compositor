/**
 * This file tests the `_app.dashboard.tsx` action — focused on the
 * `remove-member` intent's DO eviction call. After the D1 membership row is
 * deleted, the action must POST to the collaboration DO's
 * `https://internal/notify-deleted?userId=<targetUserId>` endpoint so the
 * removed collaborator's live WebSocket is closed immediately.
 *
 * Pattern mirrors tests/stories.action.test.ts (flush-yjs-snapshot intent)
 * and tests/dashboard-autosave-config.test.ts (db chain mocking style).
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

// selectChain.limit returns [] so targetRole check passes (not a convenor).
const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
};
const deleteChain = {
  where: vi.fn().mockResolvedValue(undefined),
};

function makeDbMock() {
  return {
    select: vi.fn(() => selectChain),
    delete: vi.fn(() => deleteChain),
    update: vi.fn(),
  };
}

const dbMock = makeDbMock();

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => dbMock),
}));

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn(() => 99), // sessionActiveId = 99
    })),
  })),
}));

// getUserProjects returns a single project so getActiveProject resolves
// to { id: 99, github_repo_full_name: "owner/repo" }.
vi.mock("~/lib/membership.server", () => ({
  getUserProjects: vi.fn(async () => [
    { id: 99, github_repo_full_name: "owner/repo" },
  ]),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));

// signInternalMarker lives in workers/auth — the dashboard imports it via
// the relative path ../../workers/auth.
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({
    sigHex: "deadbeef",
    timestamp: 1234567890,
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.dashboard";
import { signInternalMarker } from "../workers/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TARGET_USER_ID = 55;

function buildRequest(targetUserId: number): Request {
  const form = new URLSearchParams();
  form.set("intent", "remove-member");
  form.set("userId", String(targetUserId));
  return new Request("https://compositor.telar.org/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

type DOFetch = (request: Request) => Promise<Response>;
interface DOStubMockShape {
  fetch: ReturnType<typeof vi.fn<DOFetch>>;
}

function buildContext(doFetch: DOStubMockShape["fetch"]) {
  // Convenor user — requireOwner passes (mocked above).
  const user = { id: 1, encrypted_access_token: "enc-token" };
  const doStub: DOStubMockShape = { fetch: doFetch };
  const COLLABORATION = {
    idFromName: vi.fn(() => "do-id"),
    get: vi.fn(() => doStub),
  };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    COLLABORATION,
  };
  return {
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"],
    COLLABORATION,
    doStub,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply chain mock return values after clearAllMocks resets them.
  selectChain.from.mockReturnThis();
  selectChain.where.mockReturnThis();
  selectChain.limit.mockResolvedValue([]);
  deleteChain.where.mockResolvedValue(undefined);
});

describe("_app.dashboard action: remove-member DO eviction", () => {
  it("calls the DO notify-deleted endpoint with the removed user's id after the D1 delete", async () => {
    const doFetch = vi.fn<DOFetch>(async () => new Response("OK", { status: 200 }));
    const { context, COLLABORATION } = buildContext(doFetch);

    await action({
      request: buildRequest(TARGET_USER_ID),
      context,
      params: {},
    } as never);

    // Internal marker signed with the active project id, session secret, the
    // notify-deleted op, and the removed user's id — so a marker minted to
    // evict one user can't be replayed to evict another.
    expect(signInternalMarker).toHaveBeenCalledWith(
      99,
      "sess-secret",
      "notify-deleted",
      TARGET_USER_ID,
    );

    // DO stub looked up by project id (string-coerced).
    expect(COLLABORATION.idFromName).toHaveBeenCalledWith("99");
    expect(COLLABORATION.get).toHaveBeenCalledWith("do-id");

    // The DO request targets the removed user's id, not the convenor's.
    expect(doFetch).toHaveBeenCalledTimes(1);
    const req = doFetch.mock.calls[0][0] as Request;
    expect(req.url).toBe(
      `https://internal/notify-deleted?userId=${TARGET_USER_ID}`,
    );
    expect(req.method).toBe("POST");
    expect(req.headers.get("X-Internal-Auth")).toBe("deadbeef");
    expect(req.headers.get("X-Internal-Timestamp")).toBe("1234567890");
    expect(req.headers.get("X-Internal-Project")).toBe("99");
  });

  it("returns { ok: true, intent: 'remove-member' } even when DO fetch throws (best-effort)", async () => {
    const doFetch = vi.fn<DOFetch>(async () => {
      throw new Error("DO unreachable");
    });
    const { context } = buildContext(doFetch);

    const res = (await action({
      request: buildRequest(TARGET_USER_ID),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string };

    // D1 delete already succeeded; DO outage must not flip the outcome.
    expect(res.ok).toBe(true);
    expect(res.intent).toBe("remove-member");
  });

  it("returns { ok: true, intent: 'remove-member' } on happy path (DO succeeds)", async () => {
    const doFetch = vi.fn<DOFetch>(async () => new Response("OK", { status: 200 }));
    const { context } = buildContext(doFetch);

    const res = (await action({
      request: buildRequest(TARGET_USER_ID),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("remove-member");
  });
});

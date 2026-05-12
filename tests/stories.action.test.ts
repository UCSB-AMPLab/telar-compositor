/**
 * This file tests the `_app.stories.tsx` action — focused on the
 * `flush-yjs-snapshot` intent that forces a snapshot of the live Yjs doc
 * into D1 before the user navigates away from the editor.
 *
 * Why an action-level test (mirrors `tests/upgrade.action.test.ts`):
 *   the action signs an internal marker and POSTs to the COLLABORATION DO's
 *   `https://internal/snapshot` endpoint. The test verifies the marker
 *   handshake and the soft-error posture: if the snapshot POST fails, the
 *   action returns `{ ok: false, ... }` rather than throwing — the client
 *   decides whether to navigate.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(),
    update: vi.fn(),
  })),
}));

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn(() => undefined),
    })),
  })),
}));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 42,
      github_repo_full_name: "owner/repo",
    },
    userRole: "convenor",
  })),
}));

// signInternalMarker lives in workers/auth and the action imports it via
// the relative path used by _app.publish.tsx.
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({
    sigHex: "deadbeef",
    timestamp: 1234567890,
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.stories";
import { signInternalMarker } from "../workers/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(intent: string): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  return new Request("https://compositor.telar.org/stories", {
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
  const user = { id: 7, encrypted_access_token: "enc-token" };
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
});

describe("_app.stories action: flush-yjs-snapshot intent", () => {
  it("signs the internal marker and POSTs to https://internal/snapshot with the three internal headers", async () => {
    const doFetch = vi.fn<DOFetch>(async () => new Response("OK", { status: 200 }));
    const { context, COLLABORATION } = buildContext(doFetch);

    await action({
      request: buildRequest("flush-yjs-snapshot"),
      context,
      params: {},
    } as never);

    // Marker signed with the active project's id and the session secret.
    expect(signInternalMarker).toHaveBeenCalledWith(42, "sess-secret");

    // DO stub looked up by project id (string-coerced).
    expect(COLLABORATION.idFromName).toHaveBeenCalledWith("42");
    expect(COLLABORATION.get).toHaveBeenCalledWith("do-id");

    // The DO request is the marker-signed POST to /snapshot.
    expect(doFetch).toHaveBeenCalledTimes(1);
    const req = doFetch.mock.calls[0][0] as Request;
    expect(req.url).toBe("https://internal/snapshot");
    expect(req.method).toBe("POST");
    expect(req.headers.get("X-Internal-Auth")).toBe("deadbeef");
    expect(req.headers.get("X-Internal-Timestamp")).toBe("1234567890");
    expect(req.headers.get("X-Internal-Project")).toBe("42");
  });

  it("returns { ok: true, intent } when the DO snapshot succeeds", async () => {
    const doFetch = vi.fn<DOFetch>(async () => new Response("OK", { status: 200 }));
    const { context } = buildContext(doFetch);

    const res = (await action({
      request: buildRequest("flush-yjs-snapshot"),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("flush-yjs-snapshot");
  });

  it("returns { ok: false, intent, error: 'snapshot_failed' } when the DO returns !ok (soft-error posture)", async () => {
    const doFetch = vi.fn<DOFetch>(async () => new Response("nope", { status: 500 }));
    const { context } = buildContext(doFetch);

    const res = (await action({
      request: buildRequest("flush-yjs-snapshot"),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string; error?: string };

    expect(res.ok).toBe(false);
    expect(res.intent).toBe("flush-yjs-snapshot");
    expect(res.error).toBe("snapshot_failed");
  });

  it("returns { ok: false, intent, error: 'snapshot_failed' } when doStub.fetch throws (DO unreachable — soft-error)", async () => {
    const doFetch = vi.fn<DOFetch>(async () => {
      throw new Error("DO unreachable");
    });
    const { context } = buildContext(doFetch);

    const res = (await action({
      request: buildRequest("flush-yjs-snapshot"),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string; error?: string };

    expect(res.ok).toBe(false);
    expect(res.intent).toBe("flush-yjs-snapshot");
    expect(res.error).toBe("snapshot_failed");
  });
});

describe("_app.stories action: existing intents still routed (regression guard)", () => {
  it("routes 'toggle-draft' through the existing case (not the new flush case)", async () => {
    // Confirm by negative: the flush case must NOT call signInternalMarker
    // when an unrelated intent is submitted. The toggle-draft case calls
    // db.update which our mock does not implement — we expect it to throw
    // (TypeError on chaining), but signInternalMarker must remain unused.
    const doFetch = vi.fn<DOFetch>();
    const { context } = buildContext(doFetch);

    const form = new URLSearchParams();
    form.set("intent", "toggle-draft");
    form.set("storyDbId", "1");
    form.set("currentValue", "false");
    const request = new Request("https://compositor.telar.org/stories", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    try {
      await action({ request, context, params: {} } as never);
    } catch {
      // expected — db.update() chain is not fully mocked for this case;
      // the only thing we assert here is that the flush path was NOT taken.
    }

    expect(signInternalMarker).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("throws 400 'Bad request' on an unknown intent (default arm preserved)", async () => {
    const doFetch = vi.fn<DOFetch>();
    const { context } = buildContext(doFetch);

    await expect(
      action({
        request: buildRequest("not-a-real-intent"),
        context,
        params: {},
      } as never),
    ).rejects.toBeInstanceOf(Response);
    expect(signInternalMarker).not.toHaveBeenCalled();
  });
});

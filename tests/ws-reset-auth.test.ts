/**
 * Tests for /ws/:projectId/reset auth gate.
 *
 * Six cases:
 *  1. Unauthenticated POST -> 401
 *  2. Invalid session cookie (token verifier returns null) -> 401
 *  3. Valid user, no row in project_members -> 403
 *  4. Valid user with role=collaborator -> 403
 *  5. Valid user with role=convenor -> 200; forwarded request to the DO carries
 *     X-Internal-Auth, X-Internal-Timestamp, X-Internal-Project headers
 *  6. DO direct-call rejection (the marker check itself): a request without
 *     the X-Internal-Auth header is rejected with 401 by verifyInternalMarker
 *     so an attacker that bypasses the worker entry cannot reach the DO.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

// Mock the auth module so we can drive parseSessionCookie / getUserIdFromToken
// from each test case while leaving signInternalMarker and verifyInternalMarker
// real — those are what the worker entry produces and the DO consumes.
vi.mock("../workers/auth", async () => {
  const actual = await vi.importActual<typeof import("../workers/auth")>("../workers/auth");
  return {
    ...actual,
    parseSessionCookie: vi.fn(),
    getUserIdFromToken: vi.fn(),
  };
});

// Stub react-router so that importing workers/app.ts doesn't try to spin
// up a real React Router request handler at module-init time. We don't
// invoke any non-/reset route in this test file.
vi.mock("react-router", () => ({
  createRequestHandler: vi.fn(() => vi.fn(async () => new Response("not used", { status: 200 }))),
  RouterContextProvider: class {
    cloudflare?: unknown;
  },
}));

// Stub the virtual server-build module that workers/app.ts imports lazily.
vi.mock("virtual:react-router/server-build", () => ({}));

// Stub the collaboration module so importing workers/app.ts (which re-exports
// ProjectCollaborationDO) doesn't pull in yjs / cloudflare:workers.
vi.mock("../workers/collaboration", () => ({
  ProjectCollaborationDO: class {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import worker from "../workers/app";
import {
  parseSessionCookie,
  getUserIdFromToken,
  verifyInternalMarker,
  signInternalMarker,
} from "../workers/auth";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-session-secret";

let recordedDoRequest: Request | null = null;

function makeEnv(opts: { firstResult: { role: string } | null }): Env {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => opts.firstResult),
        })),
      })),
    } as unknown as D1Database,
    SESSION_SECRET: TEST_SECRET,
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id-42"),
      get: vi.fn(() => ({
        fetch: vi.fn(async (req: Request) => {
          recordedDoRequest = req;
          return new Response("OK", { status: 200 });
        }),
      })),
    } as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

// Cloudflare's ExportedHandler.fetch expects Request<unknown, IncomingRequestCfProperties>
// but the WHATWG Request constructor produces Request<unknown, CfProperties>. The cast
// is purely a TypeScript-level narrowing — at runtime the standard Request is what
// Workers receive in tests.
type CfRequest = Parameters<NonNullable<ExportedHandler<Env>["fetch"]>>[0];

function buildResetRequest(cookieValue?: string): CfRequest {
  const headers: Record<string, string> = {};
  if (cookieValue !== undefined) {
    headers["Cookie"] = `__compositor_session=${cookieValue}`;
  }
  return new Request("https://example.workers.dev/ws/42/reset", {
    method: "POST",
    headers,
  }) as unknown as CfRequest;
}

const ctxStub = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  recordedDoRequest = null;
});

// ---------------------------------------------------------------------------
// Cases 1-5: worker-entry gate
// ---------------------------------------------------------------------------

describe("/ws/:projectId/reset — worker-entry auth gate", () => {
  it("Case 1: unauthenticated POST returns 401", async () => {
    vi.mocked(parseSessionCookie).mockReturnValue(null);
    const env = makeEnv({ firstResult: null });
    const req = new Request("https://example.workers.dev/ws/42/reset", {
      method: "POST",
    }) as unknown as CfRequest;

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(401);
    expect(env.COLLABORATION.idFromName).not.toHaveBeenCalled();
  });

  it("Case 2: invalid session cookie returns 401", async () => {
    vi.mocked(parseSessionCookie).mockReturnValue("forged.token.value");
    vi.mocked(getUserIdFromToken).mockResolvedValue(null);
    const env = makeEnv({ firstResult: null });
    const req = buildResetRequest("forged.token.value");

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(401);
    expect(env.COLLABORATION.idFromName).not.toHaveBeenCalled();
  });

  it("Case 3: authenticated non-member returns 403", async () => {
    vi.mocked(parseSessionCookie).mockReturnValue("valid.cookie.value");
    vi.mocked(getUserIdFromToken).mockResolvedValue(7);
    const env = makeEnv({ firstResult: null });
    const req = buildResetRequest("valid.cookie.value");

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(403);
    expect(env.COLLABORATION.idFromName).not.toHaveBeenCalled();
  });

  it("Case 4: authenticated collaborator (non-convenor) returns 403", async () => {
    vi.mocked(parseSessionCookie).mockReturnValue("valid.cookie.value");
    vi.mocked(getUserIdFromToken).mockResolvedValue(7);
    const env = makeEnv({ firstResult: { role: "collaborator" } });
    const req = buildResetRequest("valid.cookie.value");

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(403);
    expect(env.COLLABORATION.idFromName).not.toHaveBeenCalled();
  });

  it("Case 5: authenticated convenor succeeds and forwards a signed marker to the DO", async () => {
    vi.mocked(parseSessionCookie).mockReturnValue("valid.cookie.value");
    vi.mocked(getUserIdFromToken).mockResolvedValue(7);
    const env = makeEnv({ firstResult: { role: "convenor" } });
    const req = buildResetRequest("valid.cookie.value");

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(200);
    expect(env.COLLABORATION.idFromName).toHaveBeenCalledWith("42");
    expect(recordedDoRequest).not.toBeNull();
    // The forwarded request must carry all three internal-auth headers.
    expect(recordedDoRequest!.url).toBe("https://internal/reset");
    const sigHex = recordedDoRequest!.headers.get("X-Internal-Auth");
    const ts = recordedDoRequest!.headers.get("X-Internal-Timestamp");
    const proj = recordedDoRequest!.headers.get("X-Internal-Project");
    expect(sigHex).toBeTruthy();
    expect(sigHex!.length).toBe(64); // hex of HMAC-SHA256 = 32 bytes = 64 hex chars
    expect(ts).toMatch(/^\d+$/);
    expect(proj).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// Case 6: DO marker check (direct-call rejection)
//
// The DO's /reset handler delegates header verification to verifyInternalMarker
// in workers/auth.ts. We exercise that helper directly with a request that
// has no X-Internal-Auth header — simulating an attacker that reached the DO
// without going through workers/app.ts. Expectation: 401.
// ---------------------------------------------------------------------------

describe("DO /reset marker check (T-32-03b)", () => {
  it("Case 6: DO rejects a direct call missing the internal marker with 401", async () => {
    const bareRequest = new Request("https://internal/reset", { method: "POST" });

    const res = await verifyInternalMarker(bareRequest, TEST_SECRET);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("rejects a stale marker (timestamp older than 30s) with 401", async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago
    const message = `ws-reset:42:${staleTimestamp}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(TEST_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    const sigHex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const staleRequest = new Request("https://internal/reset", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(staleTimestamp),
        "X-Internal-Project": "42",
      },
    });

    const res = await verifyInternalMarker(staleRequest, TEST_SECRET);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("accepts a freshly-signed marker", async () => {
    // signInternalMarker uses the current clock; verifyInternalMarker should accept it.
    const { sigHex, timestamp } = await signInternalMarker(42, TEST_SECRET);

    const freshRequest = new Request("https://internal/reset", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": "42",
      },
    });

    const res = await verifyInternalMarker(freshRequest, TEST_SECRET);

    expect(res).toBeNull(); // null = valid marker
  });
});

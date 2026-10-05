/**
 * This file pins the auth gate for the `/ws/:projectId/reset` endpoint —
 * the worker route that lets a convenor wipe a project's collaboration
 * state and force every connected client to reload from D1.
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
 *
 * Also pins the project-id validation both `/ws/` branches share via
 * `parseCanonicalProjectId` (see workers/auth.ts): a non-canonical id segment
 * ("02", "2abc", "2.9", "+2", a percent-encoded space, or a trailing path
 * segment) is refused with 400 before `idFromName` is ever called — for the
 * reset route, before the auth gate runs at all — and the canonical form
 * still reaches the DO exactly as before.
 *
 * @version v1.5.0-beta
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
import { checkD1Bind } from "./helpers/d1-memory";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-session-secret";

let recordedDoRequest: Request | null = null;

function makeEnv(opts: { firstResult: { role: string } | null }): Env {
  return {
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: unknown[]) => {
          checkD1Bind(sql, args);
          return {
            first: vi.fn(async () => opts.firstResult),
          };
        }),
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
// Project-id validation shared by both /ws/ branches (parseCanonicalProjectId,
// workers/auth.ts). Each case names the mutation of the fix it would catch
// if the canonicalisation regressed.
// ---------------------------------------------------------------------------

describe("/ws/:projectId/reset — non-canonical id is refused before auth runs", () => {
  it.each([
    ["02", "a leading zero — parseInt/Number would read this as project 2"],
    ["2abc", "trailing non-digit junk — parseInt would read this as project 2"],
    ["2.9", "a decimal point — the canonical form is digits only, no decimal point"],
    ["+2", "a leading sign — Number() would read this as project 2"],
    ["%202", "a percent-encoded space before the digit"],
  ])("refuses /ws/%s/reset (%s) with 400 before the auth gate", async (segment) => {
    vi.mocked(parseSessionCookie).mockReturnValue("valid.cookie.value");
    vi.mocked(getUserIdFromToken).mockResolvedValue(7);
    const env = makeEnv({ firstResult: { role: "convenor" } });
    const req = new Request(`https://example.workers.dev/ws/${segment}/reset`, {
      method: "POST",
      headers: { Cookie: "__compositor_session=valid.cookie.value" },
    }) as unknown as CfRequest;

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(400);
    // The id is validated before the cookie is read, so an invalid segment
    // never reaches the auth gate at all.
    expect(parseSessionCookie).not.toHaveBeenCalled();
    expect(env.COLLABORATION.idFromName).not.toHaveBeenCalled();
  });

  it("still accepts /ws/2/reset (the one canonical spelling of project 2)", async () => {
    vi.mocked(parseSessionCookie).mockReturnValue("valid.cookie.value");
    vi.mocked(getUserIdFromToken).mockResolvedValue(7);
    const env = makeEnv({ firstResult: { role: "convenor" } });
    const req = new Request("https://example.workers.dev/ws/2/reset", {
      method: "POST",
      headers: { Cookie: "__compositor_session=valid.cookie.value" },
    }) as unknown as CfRequest;

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(200);
    expect(env.COLLABORATION.idFromName).toHaveBeenCalledWith("2");
  });

  // Boundary and encoding cases. Each names the specific guard inside
  // parseCanonicalProjectId/isProjectId whose removal it would catch.
  it.each([
    [
      "9007199254740992",
      "one past Number.MAX_SAFE_INTEGER — passes the regex and the " +
        "round-trip check; only isProjectId's Number.isSafeInteger check " +
        "rejects it, so dropping isProjectId from the parser would admit it",
    ],
    [
      "%32",
      "a percent-encoded digit (would decode to \"2\") — catches decoding " +
        "the segment before validating it, since the raw segment is never " +
        "decoded here",
    ],
    [
      "٢",
      "a Unicode digit (Arabic-Indic two, U+0662) — the ASCII-only regex " +
        "class rejects it; catches a rewrite to a Unicode-aware digit class",
    ],
    [
      "9".repeat(25),
      "a numeric string far past safe-integer range — the round-trip check and the safe-integer bound both reject it, so no test can discriminate the round trip alone; it guards a future widening of the digit pattern",
    ],
  ])("refuses /ws/%s/reset (%s) with 400 before the auth gate", async (segment) => {
    vi.mocked(parseSessionCookie).mockReturnValue("valid.cookie.value");
    vi.mocked(getUserIdFromToken).mockResolvedValue(7);
    const env = makeEnv({ firstResult: { role: "convenor" } });
    const req = new Request(`https://example.workers.dev/ws/${segment}/reset`, {
      method: "POST",
      headers: { Cookie: "__compositor_session=valid.cookie.value" },
    }) as unknown as CfRequest;

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(400);
    expect(parseSessionCookie).not.toHaveBeenCalled();
    expect(env.COLLABORATION.idFromName).not.toHaveBeenCalled();
  });

  it("still accepts the safe-integer boundary itself (Number.MAX_SAFE_INTEGER)", async () => {
    // Catches an off-by-one in isProjectId's bound that would reject a
    // legitimate, large project id.
    vi.mocked(parseSessionCookie).mockReturnValue("valid.cookie.value");
    vi.mocked(getUserIdFromToken).mockResolvedValue(7);
    const env = makeEnv({ firstResult: { role: "convenor" } });
    const req = new Request("https://example.workers.dev/ws/9007199254740991/reset", {
      method: "POST",
      headers: { Cookie: "__compositor_session=valid.cookie.value" },
    }) as unknown as CfRequest;

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(200);
    expect(env.COLLABORATION.idFromName).toHaveBeenCalledWith("9007199254740991");
  });
});

describe("/ws/:projectId — worker-entry route (non-reset upgrade forward)", () => {
  function buildWsRequest(pathSuffix: string): CfRequest {
    return new Request(`https://example.workers.dev/ws/${pathSuffix}`, {
      headers: { Upgrade: "websocket" },
    }) as unknown as CfRequest;
  }

  it.each([
    ["02", "a leading zero — parseInt in the DO's own handler would read this as project 2"],
    ["2abc", "trailing non-digit junk"],
    ["2.9", "a decimal point"],
    ["+2", "a leading sign"],
    ["%202", "a percent-encoded space before the digit"],
    ["2/extra", "a trailing path segment past the id"],
  ])("refuses /ws/%s (%s) with 400 before addressing any Durable Object", async (suffix) => {
    const env = makeEnv({ firstResult: null });
    const res = await worker.fetch(buildWsRequest(suffix), env, ctxStub);

    expect(res.status).toBe(400);
    expect(env.COLLABORATION.idFromName).not.toHaveBeenCalled();
  });

  it("still forwards /ws/2 (the canonical id) to the Durable Object unchanged", async () => {
    const env = makeEnv({ firstResult: null });
    const req = buildWsRequest("2");

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(200);
    expect(env.COLLABORATION.idFromName).toHaveBeenCalledWith("2");
    expect(recordedDoRequest).not.toBeNull();
    expect(recordedDoRequest!.url).toBe("https://example.workers.dev/ws/2");
  });

  // Boundary and encoding cases. Each names the specific guard inside
  // parseCanonicalProjectId/isProjectId whose removal it would catch.
  it.each([
    [
      "9007199254740992",
      "one past Number.MAX_SAFE_INTEGER — passes the regex and the " +
        "round-trip check; only isProjectId's Number.isSafeInteger check " +
        "rejects it, so dropping isProjectId from the parser would admit it",
    ],
    [
      "%32",
      "a percent-encoded digit (would decode to \"2\") — catches decoding " +
        "the segment before validating it",
    ],
    [
      "٢",
      "a Unicode digit (Arabic-Indic two, U+0662) — the ASCII-only regex " +
        "class rejects it; catches a rewrite to a Unicode-aware digit class",
    ],
    [
      "9".repeat(25),
      "a numeric string far past safe-integer range — the round-trip check and the safe-integer bound both reject it, so no test can discriminate the round trip alone; it guards a future widening of the digit pattern",
    ],
  ])("refuses /ws/%s (%s) with 400 before addressing any Durable Object", async (segment) => {
    const env = makeEnv({ firstResult: null });
    const res = await worker.fetch(buildWsRequest(segment), env, ctxStub);

    expect(res.status).toBe(400);
    expect(env.COLLABORATION.idFromName).not.toHaveBeenCalled();
  });

  it("still forwards the safe-integer boundary itself (Number.MAX_SAFE_INTEGER)", async () => {
    // Catches an off-by-one in isProjectId's bound that would reject a
    // legitimate, large project id.
    const env = makeEnv({ firstResult: null });
    const req = buildWsRequest("9007199254740991");

    const res = await worker.fetch(req, env, ctxStub);

    expect(res.status).toBe(200);
    expect(env.COLLABORATION.idFromName).toHaveBeenCalledWith("9007199254740991");
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

describe("DO /reset marker check", () => {
  it("Case 6: DO rejects a direct call missing the internal marker with 401", async () => {
    const bareRequest = new Request("https://internal/reset", { method: "POST" });

    const res = await verifyInternalMarker(bareRequest, TEST_SECRET, "reset");

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("rejects a stale marker (timestamp older than 30s) with 401", async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago
    const message = `reset:42:-:${staleTimestamp}`;
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

    const res = await verifyInternalMarker(staleRequest, TEST_SECRET, "reset");

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("accepts a freshly-signed marker", async () => {
    // signInternalMarker uses the current clock; verifyInternalMarker should accept it.
    const { sigHex, timestamp } = await signInternalMarker(42, TEST_SECRET, "reset");

    const freshRequest = new Request("https://internal/reset", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": "42",
      },
    });

    const res = await verifyInternalMarker(freshRequest, TEST_SECRET, "reset");

    expect(res).toBeNull(); // null = valid marker
  });

  it("rejects a marker minted for one op replayed on another (cross-op)", async () => {
    // Mint a marker for op="snapshot" but present it on the /reset verify path.
    const { sigHex, timestamp } = await signInternalMarker(42, TEST_SECRET, "snapshot");

    const crossOpRequest = new Request("https://internal/reset", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": "42",
      },
    });

    const res = await verifyInternalMarker(crossOpRequest, TEST_SECRET, "reset");

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("rejects a marker minted for one user replayed for another (cross-user)", async () => {
    // Mint for op="notify-deleted", userId=1; verify with expectedUserId="2".
    const { sigHex, timestamp } = await signInternalMarker(
      42,
      TEST_SECRET,
      "notify-deleted",
      1,
    );

    const crossUserRequest = new Request("https://internal/notify-deleted?userId=2", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": "42",
      },
    });

    const res = await verifyInternalMarker(
      crossUserRequest,
      TEST_SECRET,
      "notify-deleted",
      "2",
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("accepts a marker bound to a userId when the expected userId matches", async () => {
    const { sigHex, timestamp } = await signInternalMarker(
      42,
      TEST_SECRET,
      "notify-deleted",
      1,
    );

    const req = new Request("https://internal/notify-deleted?userId=1", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": "42",
      },
    });

    const res = await verifyInternalMarker(req, TEST_SECRET, "notify-deleted", "1");

    expect(res).toBeNull();
  });
});

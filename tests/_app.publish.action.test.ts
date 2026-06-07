/**
 * Fix #13(B): the publish action must FAIL CLOSED on a snapshot failure
 * (non-200 from the DO /snapshot) rather than publishing stale D1, while a
 * genuine "DO unreachable" (fetch rejects) must be tolerated and continue.
 *
 * This is a REGRESSION GUARD that locks the post-fix asymmetry of the publish
 * action's force-snapshot block (app/routes/_app.publish.tsx:514-520):
 *   - `!snapshotRes.ok` (the DO /snapshot handler converted a thrown snapshot
 *     into a 500) → return `snapshot_failed`, never build the file set.
 *   - `doStub.fetch(...)` THROWS (binding/network failure, no live DO) →
 *     continue past the snapshot block; D1 already holds the last persisted
 *     state.
 * The two outcomes MUST differ; see the precedent in tests/stories.action.test.ts
 * whose `flush-yjs-snapshot` intent is deliberately symmetric (both paths soft-
 * error). The publish action is deliberately asymmetric — do not harmonise.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — paths/exports verified against app/routes/_app.publish.tsx imports.
// Resolved-module-id equality is what vi.mock matches on: the route imports
// signInternalMarker from "../../workers/auth" (app/routes/ → root/workers),
// and this test file in tests/ reaches the same module via "../workers/auth".
// ---------------------------------------------------------------------------

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/db.server", () => ({
  // A bare object; the action only chains db.select(...) AFTER the snapshot
  // block. For the "continue" case that chain throws and lands in the action's
  // outer catch → error: "publish_failed" (NOT "snapshot_failed"), which is
  // exactly the distinction this test asserts.
  getDb: vi.fn(() => ({})),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "tok"),
}));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 7,
      github_repo_full_name: "owner/repo",
      publish_snapshot: null,
    },
  })),
  requireOwner: vi.fn(async () => {}),
}));

vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));

// vi.hoisted so the spy exists before the hoisted vi.mock factory runs.
const { buildPublishFileSet } = vi.hoisted(() => ({
  buildPublishFileSet: vi.fn(async () => [] as unknown[]),
}));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.publish";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DOFetch = (request: Request) => Promise<Response>;

function buildContext(doFetch: DOFetch) {
  const user = { id: 1, encrypted_access_token: "x", github_login: "u" };
  const doStub = { fetch: doFetch };
  const COLLABORATION = {
    idFromName: vi.fn(() => "do-id"),
    get: vi.fn(() => doStub),
  };
  const env = {
    DB: {},
    SESSION_SECRET: "s",
    ENCRYPTION_KEY: "k",
    COLLABORATION,
  };
  return {
    get: vi.fn(() => user),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

function buildRequest(): Request {
  const form = new FormData();
  form.set("intent", "publish");
  return new Request("https://app/publish", {
    method: "POST",
    body: form,
    headers: { Cookie: "" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publish action — Fix #13(B) snapshot failure handling", () => {
  it("returns snapshot_failed and does NOT build the publish file set when /snapshot returns 500", async () => {
    const doFetch: DOFetch = async () =>
      new Response("snapshot_failed", { status: 500 });
    const res = await action({
      request: buildRequest(),
      context: buildContext(doFetch),
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "snapshot_failed" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("continues past the snapshot block (no snapshot_failed) when the DO fetch rejects (unreachable)", async () => {
    const doFetch: DOFetch = async () => {
      throw new Error("DO unreachable");
    };
    const res = (await action({
      request: buildRequest(),
      context: buildContext(doFetch),
      params: {},
    } as unknown as Parameters<typeof action>[0])) as { error?: string };

    // It must NOT short-circuit with snapshot_failed; it proceeds to the
    // file-set build (which our mock makes succeed/return []). Downstream the
    // unmocked db chain throws into the action's outer catch → publish_failed,
    // which is fine — the assertion is that the snapshot block did not fail it.
    expect(res?.error).not.toBe("snapshot_failed");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });
});

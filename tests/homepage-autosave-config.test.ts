/**
 * Tests for the homepage `autosave-config` action — auth-bypass fix.
 *
 * Mirrors tests/dashboard-autosave-config.test.ts for the
 * homepage route's separate autosave-config case. Covers the auth-bypass
 * guard added by `requireProjectMember`: a signed-in user who forges a
 * `projectId` for a project they are NOT a member of must receive 403, and
 * the underlying `db.update(project_config)` mutation must not run. Happy
 * path verifies that a legitimate member's autosave succeeds for each of
 * the two allowed fields (title, description).
 *
 * Mocking strategy mirrors `tests/homepage-autosave-landing.test.ts`: stub
 * the entire dependency graph at module boundaries and invoke
 * `action({request, context})` directly. The D1 layer is mocked as a
 * chainable drizzle builder so we can assert on whether `update` was
 * called.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

// Track calls to db.update / db.insert so the bypass test can assert no
// mutation ran on project_config.
const updateMock = vi.fn(() => ({
  set: vi.fn(() => ({
    where: vi.fn(async () => undefined),
  })),
}));

const insertMock = vi.fn(() => ({
  values: vi.fn(async () => undefined),
}));

function makeDbMock() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
    update: updateMock,
    insert: insertMock,
    delete: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
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
      get: vi.fn(() => undefined),
    })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "user-token"),
}));

vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "head-sha"),
  searchGitHubUsers: vi.fn(async () => []),
}));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 1 },
    userRole: "collaborator",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));

vi.mock("~/lib/sync.server", () => ({
  computeFullSyncDiff: vi.fn(async () => ({})),
  applyFullSyncChanges: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.homepage";
import { requireProjectMember } from "~/lib/membership.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(formFields: Record<string, string>): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(formFields)) {
    form.set(key, value);
  }
  return new Request("https://compositor.telar.org/homepage", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext(
  overrides: Partial<{ user: unknown; env: Record<string, unknown> }> = {},
) {
  const user = overrides.user ?? { id: 7, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    ...(overrides.env ?? {}),
  };
  return {
    get: vi.fn(() => user),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockClear();
  insertMock.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS = ["title", "description"] as const;

describe("homepage action: autosave-config (CR-01 — IDOR guard)", () => {
  it("returns 403 when the signed-in user is not a member of the forged projectId", async () => {
    // Forged projectId — user 7 is NOT a member of project 999.
    vi.mocked(requireProjectMember).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const result = action({
      request: buildRequest({
        intent: "autosave-config",
        entityId: "999",
        field: "title",
        value: "hacked",
      }),
      context: buildContext(),
      params: {},
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = await result.catch((e: unknown) => e as Response);
    expect(err.status).toBe(403);

    // Critical: the DB mutation must NOT have run.
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it.each(ALLOWED_FIELDS)(
    "succeeds for allowed field %s when the user is a project member",
    async (field) => {
      vi.mocked(requireProjectMember).mockResolvedValueOnce(undefined);

      const result = (await action({
        request: buildRequest({
          intent: "autosave-config",
          entityId: "1",
          field,
          value: `new ${field}`,
        }),
        context: buildContext(),
        params: {},
      } as never)) as { ok: boolean; intent: string };

      expect(result.ok).toBe(true);
      expect(result.intent).toBe("autosave-config");
      // DB update ran exactly once.
      expect(updateMock).toHaveBeenCalledTimes(1);

      // requireProjectMember was called with the form-supplied projectId.
      expect(vi.mocked(requireProjectMember)).toHaveBeenCalledWith(
        dbMock,
        1,
        7,
      );
    },
  );

  it("rejects non-finite projectId with 400 before calling requireProjectMember", async () => {
    const result = action({
      request: buildRequest({
        intent: "autosave-config",
        // entityId / projectId both omitted → Number(undefined) === NaN
        field: "title",
        value: "x",
      }),
      context: buildContext(),
      params: {},
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = await result.catch((e: unknown) => e as Response);
    expect(err.status).toBe(400);
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects disallowed fields with 400 before calling requireProjectMember", async () => {
    const result = action({
      request: buildRequest({
        intent: "autosave-config",
        entityId: "1",
        field: "evil_field",
        value: "x",
      }),
      context: buildContext(),
      params: {},
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = await result.catch((e: unknown) => e as Response);
    expect(err.status).toBe(400);
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

/**
 * Tests for the homepage `autosave-landing` action — auth-bypass fix.
 *
 * Mirrors tests/dashboard-autosave-config.test.ts for the
 * homepage route. Covers the auth-bypass guard added by
 * `requireProjectMember`: a signed-in user who forges a `projectId` for a
 * project they are NOT a member of must receive 403, and the underlying
 * `db.insert(project_landing)` / `db.update(project_landing)` mutation must
 * not run. Happy path verifies that a legitimate member's autosave succeeds
 * for each of the five allowed fields.
 *
 * Mocking strategy mirrors `tests/dashboard-autosave-config.test.ts`: stub
 * the entire dependency graph at module boundaries and invoke
 * `action({request, context})` directly. The D1 layer is mocked as a
 * chainable drizzle builder so we can assert on whether `update` / `insert`
 * was called.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

// Track calls to db.update / db.insert so the bypass test can assert no
// mutation ran on project_landing.
const updateMock = vi.fn(() => ({
  set: vi.fn(() => ({
    where: vi.fn(async () => undefined),
  })),
}));

const insertMock = vi.fn(() => ({
  values: vi.fn(async () => undefined),
}));

// The autosave-landing action runs a select-limit on project_landing first
// to decide insert vs update. By default an existing row is reported so the
// happy path exercises the update branch. Tests can override per-call.
const selectLimitMock = vi.fn(async () => [{ id: 1 }]);

function makeDbMock() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: selectLimitMock,
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

function buildRequest(
  formFields: Record<string, string>,
  path = "/homepage",
): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(formFields)) {
    form.set(key, value);
  }
  return new Request(`https://compositor.telar.org${path}`, {
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
  selectLimitMock.mockClear();
  // Default: an existing project_landing row exists.
  selectLimitMock.mockImplementation(async () => [{ id: 1 }]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS = [
  "stories_heading",
  "stories_intro",
  "objects_heading",
  "objects_intro",
  "welcome_body",
] as const;

describe("homepage action: autosave-landing (IDOR guard)", () => {
  it("returns 403 when the signed-in user is not a member of the forged projectId", async () => {
    // Forged projectId — user 7 is NOT a member of project 999.
    vi.mocked(requireProjectMember).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const result = action({
      request: buildRequest({
        intent: "autosave-landing",
        entityId: "999",
        field: "stories_heading",
        value: "hacked",
      }),
      context: buildContext(),
      params: {},
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(403);

    // Critical: neither DB mutation must have run.
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it.each(ALLOWED_FIELDS)(
    "succeeds for allowed field %s when the user is a project member (update branch)",
    async (field) => {
      vi.mocked(requireProjectMember).mockResolvedValueOnce(undefined);

      const result = (await action({
        request: buildRequest({
          intent: "autosave-landing",
          entityId: "1",
          field,
          value: `new ${field}`,
        }),
        context: buildContext(),
        params: {},
      } as never)) as { ok: boolean; intent: string };

      expect(result.ok).toBe(true);
      expect(result.intent).toBe("autosave-landing");
      // Existing row → update branch ran exactly once; insert did not.
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(insertMock).not.toHaveBeenCalled();

      // requireProjectMember was called with the form-supplied projectId.
      expect(vi.mocked(requireProjectMember)).toHaveBeenCalledWith(
        dbMock,
        1,
        7,
      );
    },
  );

  it("inserts a new project_landing row when none exists yet (happy path, insert branch)", async () => {
    vi.mocked(requireProjectMember).mockResolvedValueOnce(undefined);
    // No existing row — forces the insert branch.
    selectLimitMock.mockImplementationOnce(async () => []);

    const result = (await action({
      request: buildRequest({
        intent: "autosave-landing",
        entityId: "1",
        field: "welcome_body",
        value: "Welcome!",
      }),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(result.ok).toBe(true);
    expect(result.intent).toBe("autosave-landing");
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("persists the welcome body when the editor is served at /pages/index", async () => {
    // The homepage module is registered to BOTH /homepage and /pages/index
    // (routes.ts). Its `autosave-landing` action must persist welcome_body
    // regardless of which path the MarkdownEditor's default actionUrl resolves
    // to — proving the action travels with the editor at its new canonical
    // path (/dashboard's action does NOT handle autosave-landing, so
    // /pages/index must be served by THIS module).
    vi.mocked(requireProjectMember).mockResolvedValueOnce(undefined);

    const result = (await action({
      request: buildRequest(
        {
          intent: "autosave-landing",
          entityId: "1",
          field: "welcome_body",
          value: "Welcome from /pages/index!",
        },
        "/pages/index",
      ),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(result.ok).toBe(true);
    expect(result.intent).toBe("autosave-landing");
    // Existing row → update branch wrote welcome_body exactly once.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
    expect(vi.mocked(requireProjectMember)).toHaveBeenCalledWith(dbMock, 1, 7);
  });

  it("rejects non-finite projectId with 400 before calling requireProjectMember", async () => {
    const result = action({
      request: buildRequest({
        intent: "autosave-landing",
        entityId: "not-a-number",
        field: "stories_heading",
        value: "x",
      }),
      context: buildContext(),
      params: {},
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(400);
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects disallowed fields with 400 before calling requireProjectMember", async () => {
    const result = action({
      request: buildRequest({
        intent: "autosave-landing",
        entityId: "1",
        field: "secret_field",
        value: "x",
      }),
      context: buildContext(),
      params: {},
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(400);
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});

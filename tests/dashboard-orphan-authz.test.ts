/**
 * Tests for the dashboard `restore-orphan-drafts` and `ignore-orphans`
 * actions — convenor-only guard.
 *
 * Both intents must be restricted to convenors (`requireOwner`).
 * A collaborator-level caller must receive 403; no downstream work
 * (GitHub API, DO call, etc.) should run.
 *
 * Mocking strategy mirrors `tests/dashboard-reorder-authz.test.ts`.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

function makeDbMock() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => []),
        innerJoin: vi.fn(() => ({
          where: vi.fn(async () => []),
        })),
        groupBy: vi.fn(async () => []),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => undefined),
    })),
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
  getFileContent: vi.fn(async () => null),
}));

vi.mock("~/lib/membership.server", () => ({
  getUserProjects: vi.fn(async () => [
    {
      id: 1,
      user_id: 7,
      github_repo_full_name: "owner/repo",
      userRole: "collaborator",
      onboarding_completed: 1,
    },
  ]),
  // The dashboard action resolves the active project through the shared
  // resolveActiveProjectFromRequest helper, which delegates here. The
  // convenor gate under test is requireOwner, not this role — return a
  // resolvable project so resolution never short-circuits to no_project.
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 1,
      user_id: 7,
      github_repo_full_name: "owner/repo",
      userRole: "collaborator",
      onboarding_completed: 1,
    },
    userRole: "collaborator",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));

vi.mock("~/lib/sync.server", () => ({
  computeFullSyncDiff: vi.fn(async () => ({})),
  applyFullSyncChanges: vi.fn(async () => undefined),
}));

vi.mock("~/lib/import.server", () => ({
  scanRepoOrphanStoryIds: vi.fn(async () => []),
  parseCompositorIgnored: vi.fn(() => []),
  parseTelarCsv: vi.fn(() => []),
  mapStoryCsv: vi.fn(() => ({ steps: [], layers: [] })),
}));

vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => undefined),
}));

vi.mock("~/lib/activity.server", () => ({
  recordActivity: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.dashboard";
import { requireOwner, resolveActiveProject } from "~/lib/membership.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(formFields: Record<string, string>): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(formFields)) {
    form.set(key, value);
  }
  return new Request("https://compositor.telar.org/dashboard", {
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
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response(JSON.stringify({ restored: 0 }), { status: 200 })),
      })),
    },
    ...(overrides.env ?? {}),
  };
  return {
    get: vi.fn(() => user),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests: restore-orphan-drafts
// ---------------------------------------------------------------------------

describe("dashboard action: restore-orphan-drafts (convenor-only guard)", () => {
  it("returns 403 when requireOwner rejects for restore-orphan-drafts", async () => {
    vi.mocked(requireOwner).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const result = action({
      request: buildRequest({ intent: "restore-orphan-drafts" }),
      context: buildContext(),
      params: {},
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(403);
  });

  it("calls requireOwner (not requireProjectMember) for restore-orphan-drafts", async () => {
    vi.mocked(requireOwner).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const { requireProjectMember } = await import("~/lib/membership.server");

    await action({
      request: buildRequest({ intent: "restore-orphan-drafts" }),
      context: buildContext(),
      params: {},
    } as never).catch(() => undefined);

    expect(vi.mocked(requireOwner)).toHaveBeenCalled();
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: shared active-project resolution wiring
//
// The action resolves the active project through the shared
// resolveActiveProjectFromRequest helper (which delegates to
// resolveActiveProject on membership.server). When that resolves null — the
// caller belongs to no project — repo-facing intents must short-circuit to
// no_project before any GitHub/DO work, and never reach requireOwner.
// ---------------------------------------------------------------------------

describe("dashboard action: no resolvable project → no_project", () => {
  for (const intent of ["restore-orphan-drafts", "ignore-orphans"]) {
    it(`${intent}: returns no_project and skips requireOwner when resolution is null`, async () => {
      vi.mocked(resolveActiveProject).mockResolvedValueOnce(null);

      const result = (await action({
        request: buildRequest({ intent }),
        context: buildContext(),
        params: {},
      } as never)) as { ok: boolean; error?: string };

      expect(result.ok).toBe(false);
      expect(result.error).toBe("no_project");
      expect(vi.mocked(requireOwner)).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: ignore-orphans
// ---------------------------------------------------------------------------

describe("dashboard action: ignore-orphans (convenor-only guard)", () => {
  it("returns 403 when requireOwner rejects for ignore-orphans", async () => {
    vi.mocked(requireOwner).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const result = action({
      request: buildRequest({ intent: "ignore-orphans" }),
      context: buildContext(),
      params: {},
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(403);
  });

  it("calls requireOwner (not requireProjectMember) for ignore-orphans", async () => {
    vi.mocked(requireOwner).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const { requireProjectMember } = await import("~/lib/membership.server");

    await action({
      request: buildRequest({ intent: "ignore-orphans" }),
      context: buildContext(),
      params: {},
    } as never).catch(() => undefined);

    expect(vi.mocked(requireOwner)).toHaveBeenCalled();
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

/**
 * This file tests the onboarding route action — specifically the three
 * create-site intent branches:
 *   - check-repo-name
 *   - create-site
 *   - check-installation-scope
 *
 * FALLBACK: Mocking the full onboarding.tsx import graph (auth middleware,
 * drizzle/D1, crypto, github libs, commit/import/upgrade helpers) in
 * isolation is brittle. We exercise a pure helper
 * `handleCreateSiteIntents(intent, formData, token, env)` exported from
 * `~/routes/onboarding` that each of the three new `if (intent === ...)`
 * branches delegates to.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the create-site server module used by the helper.
vi.mock("~/lib/create-site.server", () => {
  class RepoNameTakenError extends Error {}
  class PermissionDeniedError extends Error {}
  class RepoNotReadyError extends Error {}
  class GitHubError extends Error {}
  return {
    checkRepoNameAvailable: vi.fn(),
    createSiteFromTemplate: vi.fn(),
    waitForRepoReady: vi.fn(),
    isRepoInInstallation: vi.fn(),
    RepoNameTakenError,
    PermissionDeniedError,
    RepoNotReadyError,
    GitHubError,
  };
});

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(),
}));

// getDb must never be called by the three new branches (CSITE-06 invariant).
vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb should not be called in create-site intent branches");
  }),
}));

import {
  checkRepoNameAvailable,
  createSiteFromTemplate,
  waitForRepoReady,
  isRepoInInstallation,
  RepoNameTakenError,
  PermissionDeniedError,
  RepoNotReadyError,
} from "~/lib/create-site.server";
import { getInstallationToken } from "~/lib/github-app.server";
import { handleCreateSiteIntents } from "~/lib/onboarding-create-site.server";

const TOKEN = "user-token";
const ENV = {
  GITHUB_APP_ID: "app-id",
  GITHUB_PRIVATE_KEY: "private-key",
} as unknown as Env;

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("onboarding action — check-repo-name intent", () => {
  it("returns available:true when name is free", async () => {
    vi.mocked(checkRepoNameAvailable).mockResolvedValue({ available: true });
    const res = await handleCreateSiteIntents(
      "check-repo-name",
      fd({ owner: "student", name: "my-site" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({ ok: true, intent: "check-repo-name", available: true });
    expect(checkRepoNameAvailable).toHaveBeenCalledWith(TOKEN, "student", "my-site");
  });

  it("maps reason:invalid to invalid_name error", async () => {
    vi.mocked(checkRepoNameAvailable).mockResolvedValue({ available: false, reason: "invalid" });
    const res = await handleCreateSiteIntents(
      "check-repo-name",
      fd({ owner: "student", name: "bad name" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({ ok: false, intent: "check-repo-name", error: "invalid_name" });
  });

  it("maps reason:exists to name_exists error", async () => {
    vi.mocked(checkRepoNameAvailable).mockResolvedValue({ available: false, reason: "exists" });
    const res = await handleCreateSiteIntents(
      "check-repo-name",
      fd({ owner: "student", name: "taken" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({ ok: false, intent: "check-repo-name", error: "name_exists" });
  });

  it("maps primitive throw to github_error with message", async () => {
    vi.mocked(checkRepoNameAvailable).mockRejectedValue(new Error("boom"));
    const res = await handleCreateSiteIntents(
      "check-repo-name",
      fd({ owner: "student", name: "site" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({
      ok: false,
      intent: "check-repo-name",
      error: "github_error",
      message: "boom",
    });
  });
});

describe("onboarding action — create-site intent", () => {
  it("happy path returns repoUrl, defaultBranch, owner, name", async () => {
    vi.mocked(createSiteFromTemplate).mockResolvedValue({
      repoUrl: "https://github.com/s/my-site",
      defaultBranch: "main",
    });
    vi.mocked(waitForRepoReady).mockResolvedValue(undefined);

    const res = await handleCreateSiteIntents(
      "create-site",
      fd({ owner: "s", name: "my-site" }),
      TOKEN,
      ENV,
    );

    expect(res).toEqual({
      ok: true,
      intent: "create-site",
      repoUrl: "https://github.com/s/my-site",
      defaultBranch: "main",
      owner: "s",
      name: "my-site",
      // Default userUiLocale=null → no patch attempted,
      // langPatchFailed:false is part of the success shape.
      langPatchFailed: false,
    });
    expect(createSiteFromTemplate).toHaveBeenCalledWith(TOKEN, "s", "my-site");
    expect(waitForRepoReady).toHaveBeenCalledWith(TOKEN, "s", "my-site");
  });

  it("maps RepoNameTakenError to repo_name_taken", async () => {
    vi.mocked(createSiteFromTemplate).mockRejectedValue(new RepoNameTakenError("taken"));
    const res = await handleCreateSiteIntents(
      "create-site",
      fd({ owner: "s", name: "my-site" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({ ok: false, intent: "create-site", error: "repo_name_taken" });
  });

  it("maps PermissionDeniedError to permission_denied", async () => {
    vi.mocked(createSiteFromTemplate).mockRejectedValue(new PermissionDeniedError("nope"));
    const res = await handleCreateSiteIntents(
      "create-site",
      fd({ owner: "s", name: "my-site" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({ ok: false, intent: "create-site", error: "permission_denied" });
  });

  it("maps RepoNotReadyError (from waitForRepoReady) to repo_not_ready", async () => {
    vi.mocked(createSiteFromTemplate).mockResolvedValue({
      repoUrl: "https://github.com/s/my-site",
      defaultBranch: "main",
    });
    vi.mocked(waitForRepoReady).mockRejectedValue(new RepoNotReadyError("timeout"));
    const res = await handleCreateSiteIntents(
      "create-site",
      fd({ owner: "s", name: "my-site" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({ ok: false, intent: "create-site", error: "repo_not_ready" });
  });

  it("maps generic Error to github_error with message", async () => {
    vi.mocked(createSiteFromTemplate).mockRejectedValue(new Error("kaboom"));
    const res = await handleCreateSiteIntents(
      "create-site",
      fd({ owner: "s", name: "my-site" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({
      ok: false,
      intent: "create-site",
      error: "github_error",
      message: "kaboom",
    });
  });

  it("performs zero D1 writes across happy path and error paths (getDb never called)", async () => {
    const { getDb } = await import("~/lib/db.server");
    vi.mocked(createSiteFromTemplate).mockResolvedValue({
      repoUrl: "https://github.com/s/my-site",
      defaultBranch: "main",
    });
    vi.mocked(waitForRepoReady).mockResolvedValue(undefined);
    await handleCreateSiteIntents("create-site", fd({ owner: "s", name: "my-site" }), TOKEN, ENV);

    vi.mocked(createSiteFromTemplate).mockRejectedValue(new RepoNameTakenError("x"));
    await handleCreateSiteIntents("create-site", fd({ owner: "s", name: "my-site" }), TOKEN, ENV);

    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("onboarding action — check-installation-scope intent", () => {
  it("returns inScope:true when isRepoInInstallation resolves true", async () => {
    vi.mocked(getInstallationToken).mockResolvedValue("install-token");
    vi.mocked(isRepoInInstallation).mockResolvedValue(true);

    const res = await handleCreateSiteIntents(
      "check-installation-scope",
      fd({ owner: "s", name: "my-site", installation_id: "42" }),
      TOKEN,
      ENV,
    );

    expect(res).toEqual({ ok: true, intent: "check-installation-scope", inScope: true });
    expect(getInstallationToken).toHaveBeenCalledWith("app-id", "private-key", 42);
    expect(isRepoInInstallation).toHaveBeenCalledWith("install-token", "s", "my-site");
  });

  it("returns inScope:false when isRepoInInstallation resolves false", async () => {
    vi.mocked(getInstallationToken).mockResolvedValue("install-token");
    vi.mocked(isRepoInInstallation).mockResolvedValue(false);
    const res = await handleCreateSiteIntents(
      "check-installation-scope",
      fd({ owner: "s", name: "my-site", installation_id: "42" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({ ok: true, intent: "check-installation-scope", inScope: false });
  });

  it("maps isRepoInInstallation throw to github_error", async () => {
    vi.mocked(getInstallationToken).mockResolvedValue("install-token");
    vi.mocked(isRepoInInstallation).mockRejectedValue(new Error("502 bad gateway"));
    const res = await handleCreateSiteIntents(
      "check-installation-scope",
      fd({ owner: "s", name: "my-site", installation_id: "42" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({
      ok: false,
      intent: "check-installation-scope",
      error: "github_error",
      message: "502 bad gateway",
    });
  });

  it("maps getInstallationToken throw (plain Error) to github_error", async () => {
    vi.mocked(getInstallationToken).mockRejectedValue(
      new Error("Failed to get installation token: 404 not found"),
    );
    const res = await handleCreateSiteIntents(
      "check-installation-scope",
      fd({ owner: "s", name: "my-site", installation_id: "42" }),
      TOKEN,
      ENV,
    );
    expect(res).toEqual({
      ok: false,
      intent: "check-installation-scope",
      error: "github_error",
      message: "Failed to get installation token: 404 not found",
    });
    expect(isRepoInInstallation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// unlinkProjectCascade — cascade-delete coverage
// ---------------------------------------------------------------------------
//
// Imports the helper directly from the route module. The helper takes a db
// and a projectId, so we can unit-test the cascade order without booting the
// full route action (which requires authMiddleware + session storage).

import { unlinkProjectCascade } from "~/routes/onboarding";
import {
  layers,
  steps,
  stories,
  objects,
  glossary_terms,
  project_config,
  project_themes,
  project_landing,
  project_members,
  project_invites,
  projects,
} from "~/db/schema";

describe("unlink project cascade includes member + invite tables", () => {
  it("deletes project_members and project_invites after per-entity cascades and before projects", async () => {
    const visited: unknown[] = [];
    const db = {
      delete: vi.fn((table: unknown) => {
        visited.push(table);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
      // unlinkProjectCascade selects stories first; return [] to skip the
      // step/layer branch (covered by other tests; not the focus here).
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
      // The cascade is issued as a single atomic batch.
      batch: vi.fn().mockResolvedValue([]),
    };

    await unlinkProjectCascade(db, 7);

    // Presence
    expect(visited).toContain(project_members);
    expect(visited).toContain(project_invites);

    // Per-entity cascades still run before the new deletes
    expect(visited.indexOf(project_members)).toBeGreaterThan(visited.indexOf(project_landing));
    expect(visited.indexOf(project_members)).toBeGreaterThan(visited.indexOf(project_themes));
    expect(visited.indexOf(project_invites)).toBeGreaterThan(visited.indexOf(project_landing));

    // project_members before project_invites (helper's insertion order)
    expect(visited.indexOf(project_members)).toBeLessThan(visited.indexOf(project_invites));

    // Both run BEFORE the project row delete
    expect(visited.indexOf(project_members)).toBeLessThan(visited.indexOf(projects));
    expect(visited.indexOf(project_invites)).toBeLessThan(visited.indexOf(projects));

    // The project row is deleted last
    expect(visited[visited.length - 1]).toBe(projects);
  });

  it("hits every per-entity cascade table including the new member/invite deletes", async () => {
    const visited: unknown[] = [];
    const db = {
      delete: vi.fn((table: unknown) => {
        visited.push(table);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
      // Return one story id so the layers/steps branch also runs and we can
      // assert the full cascade (including layers + steps).
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: 1 }]),
        })),
      })),
      batch: vi.fn().mockResolvedValue([]),
    };

    await unlinkProjectCascade(db, 7);

    for (const t of [
      layers,
      steps,
      stories,
      objects,
      glossary_terms,
      project_config,
      project_themes,
      project_landing,
      project_members,
      project_invites,
      projects,
    ]) {
      expect(visited).toContain(t);
    }
  });
});

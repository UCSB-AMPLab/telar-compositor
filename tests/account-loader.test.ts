/**
 * This file tests the `/account` loader — the dashboard loader that
 * shapes the user's project list, derives the convened-projects set,
 * and counts collaborator-role rows for the account-deletion modal.
 *
 * Loader derivations:
 *
 *   - convenedProjects: in-memory filter over the existing
 *     getUserProjectsWithStats result for userRole === "convenor",
 *     narrowed to { id, title }.
 *   - collaboratorCount: count of userRole === "collaborator" rows in
 *     the same result. Drives the modal body "removed from N collaborator
 *     projects" bullet.
 *
 * Both derivations MUST NOT introduce a new DB query — the existing
 * projectRows call is the single source of truth.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must precede the loader import)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getUserProjectsWithStatsMock: vi.fn(),
  listUserInstallationsMock: vi.fn(async () => ({ installations: [] })),
  getLocaleMock: vi.fn(async () => "en"),
  decryptMock: vi.fn(async () => "token"),
}));

vi.mock("~/lib/membership.server", () => ({
  PRESENCE_PALETTE: ["#E47A6F"],
  setUserPresenceColor: vi.fn(),
  getUserProjectsWithStats: mocks.getUserProjectsWithStatsMock,
  requireOwner: vi.fn(),
  requireProjectMember: vi.fn(),
}));

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: mocks.listUserInstallationsMock,
}));

vi.mock("~/i18n/i18next.server", () => ({
  getLocale: mocks.getLocaleMock,
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: mocks.decryptMock,
}));

vi.mock("~/lib/import.server", () => ({
  deleteProjectCascade: vi.fn(),
}));

vi.mock("~/lib/db.server", () => ({
  // The loader's only direct db call is `db.select(...).from(project_members)
  // .where(...).limit(1)` for the presence colour. We chain a minimal
  // builder that resolves to [] so currentPresenceColor falls back to null.
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
  })),
}));

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

import { loader } from "../app/routes/_app.account";
import { userContext as userContextStub } from "~/middleware/auth.server";

function makeContext(opts: { userId: number | null }) {
  const env = {
    DB: {} as unknown,
    SESSION_SECRET: "test-secret",
    ENCRYPTION_KEY: "test-key",
    GITHUB_APP_SLUG: "test-app",
  };
  return {
    get: (key: unknown) => {
      if (key !== userContextStub) return undefined;
      if (opts.userId === null) return null;
      return {
        id: opts.userId,
        github_id: 1,
        github_login: "tester",
        github_name: null,
        github_email: null,
        encrypted_access_token: "encrypted",
        created_at: null,
      };
    },
    cloudflare: { env },
  };
}

function makeGetRequest(): Request {
  return new Request("https://example.workers.dev/account", { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// convenedProjects + collaboratorCount derivations
// ---------------------------------------------------------------------------

describe("/account loader — delete-account derivations", () => {
  it("empty projectRows → convenedProjects=[], collaboratorCount=0", async () => {
    mocks.getUserProjectsWithStatsMock.mockResolvedValue([]);
    const ctx = makeContext({ userId: 7 });

    const data = await (loader as unknown as (a: unknown) => Promise<{
      convenedProjects: { id: number; title: string }[];
      collaboratorCount: number;
    }>)({ request: makeGetRequest(), context: ctx });

    expect(data.convenedProjects).toEqual([]);
    expect(data.collaboratorCount).toBe(0);
    expect(mocks.getUserProjectsWithStatsMock).toHaveBeenCalledTimes(1);
  });

  it("mixed roles + collaborator_count → convenedProjects filters to collab-only convener rows; collaboratorCount=2", async () => {
    // Solo-cascade gate: fires only for convener projects
    // that have collaborators (orphaning hazard). Solo convener projects
    // are excluded from convenedProjects and counted separately as
    // soloConvenedCount.
    mocks.getUserProjectsWithStatsMock.mockResolvedValue([
      {
        id: 1,
        github_repo_full_name: "alice/site-one",
        userRole: "convenor",
        last_edited_at: 1000,
        collaborator_count: 1, // collab-bearing → in convenedProjects
      },
      {
        id: 2,
        github_repo_full_name: "alice/site-two",
        userRole: "convenor",
        last_edited_at: 900,
        collaborator_count: 0, // solo → soloConvenedCount
      },
      {
        id: 3,
        github_repo_full_name: "alice/site-three",
        userRole: "convenor",
        last_edited_at: 800,
        collaborator_count: 2, // collab-bearing → in convenedProjects
      },
      {
        id: 4,
        github_repo_full_name: "bob/site-four",
        userRole: "collaborator",
        last_edited_at: 700,
        collaborator_count: 3,
      },
      {
        id: 5,
        github_repo_full_name: "carol/site-five",
        userRole: "collaborator",
        last_edited_at: 600,
        collaborator_count: 1,
      },
    ]);
    const ctx = makeContext({ userId: 7 });

    const data = await (loader as unknown as (a: unknown) => Promise<{
      convenedProjects: { id: number; title: string }[];
      soloConvenedCount: number;
      collaboratorCount: number;
    }>)({ request: makeGetRequest(), context: ctx });

    expect(data.convenedProjects).toHaveLength(2);
    expect(data.convenedProjects).toEqual([
      { id: 1, title: "alice/site-one" },
      { id: 3, title: "alice/site-three" },
    ]);
    expect(data.soloConvenedCount).toBe(1);
    expect(data.collaboratorCount).toBe(2);
    // Crucial: only one DB call to getUserProjectsWithStats — no extra
    // query introduced by the derivations.
    expect(mocks.getUserProjectsWithStatsMock).toHaveBeenCalledTimes(1);
  });

  it("convenedProjects items contain ONLY {id, title} keys (narrow payload)", async () => {
    mocks.getUserProjectsWithStatsMock.mockResolvedValue([
      {
        id: 42,
        github_repo_full_name: "owner/repo",
        userRole: "convenor",
        last_edited_at: 12345,
        collaborator_count: 9,
      },
    ]);
    const ctx = makeContext({ userId: 7 });

    const data = await (loader as unknown as (a: unknown) => Promise<{
      convenedProjects: Record<string, unknown>[];
    }>)({ request: makeGetRequest(), context: ctx });

    expect(data.convenedProjects).toHaveLength(1);
    expect(Object.keys(data.convenedProjects[0]).sort()).toEqual([
      "id",
      "title",
    ]);
    expect(data.convenedProjects[0]).toEqual({ id: 42, title: "owner/repo" });
  });

  // -------------------------------------------------------------------------
  // Solo-convener auto-cascade derivation
  // -------------------------------------------------------------------------

  it("(a): mix of solo + collab convener projects — convenedProjects filtered to collab-bearing; soloConvenedCount = N", async () => {
    mocks.getUserProjectsWithStatsMock.mockResolvedValue([
      {
        id: 1,
        github_repo_full_name: "alice/with-collabs",
        userRole: "convenor",
        last_edited_at: 1000,
        collaborator_count: 4,
      },
      {
        id: 2,
        github_repo_full_name: "alice/solo-one",
        userRole: "convenor",
        last_edited_at: 900,
        collaborator_count: 0,
      },
      {
        id: 3,
        github_repo_full_name: "alice/solo-two",
        userRole: "convenor",
        last_edited_at: 800,
        collaborator_count: 0,
      },
      {
        id: 4,
        github_repo_full_name: "alice/solo-three",
        userRole: "convenor",
        last_edited_at: 700,
        collaborator_count: 0,
      },
    ]);
    const ctx = makeContext({ userId: 7 });

    const data = await (loader as unknown as (a: unknown) => Promise<{
      convenedProjects: { id: number; title: string }[];
      soloConvenedCount: number;
    }>)({ request: makeGetRequest(), context: ctx });

    expect(data.convenedProjects).toEqual([
      { id: 1, title: "alice/with-collabs" },
    ]);
    expect(data.soloConvenedCount).toBe(3);
  });

  it("(b): only solo convener projects — convenedProjects = []; soloConvenedCount > 0", async () => {
    mocks.getUserProjectsWithStatsMock.mockResolvedValue([
      {
        id: 10,
        github_repo_full_name: "alice/solo-a",
        userRole: "convenor",
        last_edited_at: 500,
        collaborator_count: 0,
      },
      {
        id: 11,
        github_repo_full_name: "alice/solo-b",
        userRole: "convenor",
        last_edited_at: 400,
        collaborator_count: 0,
      },
    ]);
    const ctx = makeContext({ userId: 7 });

    const data = await (loader as unknown as (a: unknown) => Promise<{
      convenedProjects: { id: number; title: string }[];
      soloConvenedCount: number;
    }>)({ request: makeGetRequest(), context: ctx });

    expect(data.convenedProjects).toEqual([]);
    expect(data.soloConvenedCount).toBe(2);
  });

  it("(c): no convener projects (collaborator-only or empty) — soloConvenedCount = 0", async () => {
    mocks.getUserProjectsWithStatsMock.mockResolvedValue([
      {
        id: 20,
        github_repo_full_name: "bob/team-a",
        userRole: "collaborator",
        last_edited_at: 300,
        collaborator_count: 5,
      },
    ]);
    const ctx = makeContext({ userId: 7 });

    const data = await (loader as unknown as (a: unknown) => Promise<{
      convenedProjects: { id: number; title: string }[];
      soloConvenedCount: number;
    }>)({ request: makeGetRequest(), context: ctx });

    expect(data.convenedProjects).toEqual([]);
    expect(data.soloConvenedCount).toBe(0);
  });
});

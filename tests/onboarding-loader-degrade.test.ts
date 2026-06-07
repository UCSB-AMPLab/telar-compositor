/**
 * This file tests graceful degradation in the onboarding loader when
 * GitHub API calls fail (5xx, rate-limit, transient-401). The loader
 * must NOT throw in those cases — it must resolve with empty
 * installations and repos so the repo-connect CTA remains reachable.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must precede the loader import)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  listUserInstallationsMock: vi.fn(),
  listInstallationReposMock: vi.fn(),
  decryptMock: vi.fn(async () => "test-token"),
}));

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: mocks.listUserInstallationsMock,
  listInstallationRepos: mocks.listInstallationReposMock,
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: mocks.decryptMock,
}));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

// DB mock: return no existing projects (so the loader proceeds to the GitHub
// calls rather than redirecting to /objects).
vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  })),
}));

// Stub out modules imported by onboarding.tsx that we don't exercise here
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined), set: vi.fn() })),
    commitSession: vi.fn(async () => "cookie=val"),
  })),
}));

vi.mock("~/lib/upgrade.server", () => ({
  checkTelarVersion: vi.fn(),
}));

vi.mock("~/lib/import.server", () => ({
  importRepo: vi.fn(),
}));

vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn((c: string) => c),
  verifySiteUrl: vi.fn(),
  enableGitHubPages: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(() => false),
}));

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(),
}));

vi.mock("~/lib/onboarding-create-site.server", () => ({
  handleCreateSiteIntents: vi.fn(),
}));

import { loader } from "../app/routes/onboarding";
import { userContext as userContextStub } from "~/middleware/auth.server";

function makeContext(opts: { userId: number }) {
  const env = {
    DB: {} as unknown,
    SESSION_SECRET: "test-secret",
    ENCRYPTION_KEY: "test-key",
    GITHUB_APP_SLUG: "test-app",
    GITHUB_APP_ID: "app-id",
    GITHUB_PRIVATE_KEY: "private-key",
  };
  return {
    get: (key: unknown) => {
      if (key !== userContextStub) return undefined;
      return {
        id: opts.userId,
        github_id: 1,
        github_login: "tester",
        github_name: "Tester",
        github_email: null,
        github_plan: "free",
        encrypted_access_token: "encrypted",
        created_at: null,
        ui_locale: null,
      };
    },
    cloudflare: { env },
  };
}

function makeRequest(): Request {
  return new Request("https://example.workers.dev/onboarding", {
    method: "GET",
  });
}

type LoaderData = {
  user: {
    github_id: number;
    github_login: string;
    github_name: string | null;
    github_email: string | null;
    github_plan: string | null;
  };
  repos: unknown[];
  installations: unknown[];
  connectedProjects: unknown[];
  orphanRepoNames: string[];
  githubAppSlug: string;
};

const callLoader = (ctx: unknown) =>
  (loader as unknown as (a: unknown) => Promise<LoaderData>)({
    request: makeRequest(),
    context: ctx,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decryptMock.mockResolvedValue("test-token");
});

// ---------------------------------------------------------------------------
// Graceful degradation tests
// ---------------------------------------------------------------------------

describe("onboarding loader — graceful degradation on GitHub API failure", () => {
  it("resolves with empty installations + repos when listUserInstallations throws a 503", async () => {
    mocks.listUserInstallationsMock.mockRejectedValue(
      new Error("GitHub API error: 503 Service Unavailable"),
    );

    // Pre-fix: the loader would throw, making this assertion fail.
    // Post-fix: the loader resolves with empty installations.
    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.installations).toEqual([]);
    expect(data.repos).toEqual([]);
    expect(data.orphanRepoNames).toEqual([]);
  });

  it("resolves with empty installations + repos when listUserInstallations throws a rate-limit error", async () => {
    mocks.listUserInstallationsMock.mockRejectedValue(
      new Error("GitHub API error: 429 rate limit exceeded"),
    );

    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.installations).toEqual([]);
    expect(data.repos).toEqual([]);
  });

  it("resolves with empty installations + repos when listUserInstallations throws a transient 401", async () => {
    mocks.listUserInstallationsMock.mockRejectedValue(
      new Error("GitHub API error: 401 Unauthorized"),
    );

    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.installations).toEqual([]);
    expect(data.repos).toEqual([]);
  });

  it("skips listInstallationRepos call when listUserInstallations throws", async () => {
    mocks.listUserInstallationsMock.mockRejectedValue(
      new Error("GitHub API error: 503 Service Unavailable"),
    );

    await callLoader(makeContext({ userId: 7 }));

    expect(mocks.listInstallationReposMock).not.toHaveBeenCalled();
  });

  it("still includes user and connectedProjects in the degraded return shape", async () => {
    mocks.listUserInstallationsMock.mockRejectedValue(
      new Error("GitHub API error: 503 Service Unavailable"),
    );

    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.user).toMatchObject({
      github_login: "tester",
    });
    expect(Array.isArray(data.connectedProjects)).toBe(true);
    expect(typeof data.githubAppSlug).toBe("string");
  });

  it("happy path still works: listUserInstallations succeeds → repos populated", async () => {
    mocks.listUserInstallationsMock.mockResolvedValue({
      installations: [{ id: 42, account: { login: "tester" }, target_type: "User" }],
    });
    mocks.listInstallationReposMock.mockResolvedValue({
      repositories: [
        {
          id: 1,
          name: "my-site",
          full_name: "tester/my-site",
          private: false,
          default_branch: "main",
        },
      ],
    });

    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.installations).toHaveLength(1);
    expect(data.repos).toHaveLength(1);
    expect(data.repos[0]).toMatchObject({
      full_name: "tester/my-site",
      installationId: 42,
    });
  });
});

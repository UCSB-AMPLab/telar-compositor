/**
 * Someone whose sites are all set up and who opens the wizard again is sent
 * to Start, the dashboard; `?force=1` keeps them in the wizard to add a site.
 *
 * @version v1.5.2-beta
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

// DB mock: the caller has one site, set up.
vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ id: 7, github_repo_full_name: "me/site", onboarding_completed: true }]),
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
        encrypted_access_token: "encrypted",
        created_at: null,
        ui_locale: null,
      };
    },
    cloudflare: { env },
  };
}

function makeRequest(query = ""): Request {
  return new Request(`https://example.workers.dev/onboarding${query}`, {
    method: "GET",
  });
}

type LoaderData = {
  user: {
    github_id: number;
    github_login: string;
    github_name: string | null;
    github_email: string | null;
  };
  repos: unknown[];
  installations: unknown[];
  connectedProjects: unknown[];
  orphanRepoNames: string[];
  githubAppSlug: string;
};

const callLoader = (ctx: unknown, query = "") =>
  (loader as unknown as (a: unknown) => Promise<LoaderData>)({
    request: makeRequest(query),
    context: ctx,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decryptMock.mockResolvedValue("test-token");
  mocks.listUserInstallationsMock.mockResolvedValue([]);
  mocks.listInstallationReposMock.mockResolvedValue([]);
});

describe("onboarding loader for someone whose sites are set up", () => {
  it("sends them to Start", async () => {
    const thrown = await callLoader(makeContext({ userId: 1 })).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe("/start");
  });

  it("keeps them in the wizard with ?force=1", async () => {
    const result = await callLoader(makeContext({ userId: 1 }), "?force=1").catch((e: unknown) => e);
    expect(result).not.toBeInstanceOf(Response);
  });
});

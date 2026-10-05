/**
 * This file pins the route the bug-report panel asks for the repository's
 * current name on GitHub: it answers for the project the request names, never
 * the session's active one, only after the caller's membership in that project
 * is checked; it reads through the token `resolveProjectToken` hands the
 * caller's role; it echoes the project id beside GitHub's `full_name`; and it
 * answers null rather than failing when GitHub or the token does.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptMock: vi.fn(),
  resolveActiveProjectFromRequestMock: vi.fn(),
  projectRows: [] as unknown[],
  getUserRoleMock: vi.fn(),
  resolveProjectTokenMock: vi.fn(),
  checkRepoAvailabilityMock: vi.fn(),
  userContext: Symbol("userContext"),
}));

// The one D1 read the route makes: the named project's row.
vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => mocks.projectRows }) }),
    }),
  }),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: mocks.decryptMock }));
vi.mock("~/lib/membership.server", () => ({ getUserRole: mocks.getUserRoleMock }));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: mocks.resolveActiveProjectFromRequestMock,
}));
vi.mock("~/lib/github-app.server", () => ({
  resolveProjectToken: mocks.resolveProjectTokenMock,
}));
vi.mock("~/lib/github.server", () => ({
  checkRepoAvailability: mocks.checkRepoAvailabilityMock,
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: mocks.userContext }));

import { loader } from "~/routes/api.repo-identity";

const USER = { id: 42, encrypted_access_token: "enc-tok" };
const PROJECT = { id: 7, installation_id: 55, github_repo_full_name: "owner/old-name" };

function call(query = "?projectId=7") {
  const context = {
    get: (key: unknown) => (key === mocks.userContext ? USER : undefined),
    cloudflare: {
      env: { SESSION_SECRET: "s", ENCRYPTION_KEY: "k", GITHUB_APP_ID: "app-id", GITHUB_PRIVATE_KEY: "pk" },
    },
  };
  return loader({
    request: new Request(`https://compositor.telar.org/api/repo-identity${query}`),
    context: context as never,
    params: {},
  } as never) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The session's active project is another one; the route must not read it.
  mocks.resolveActiveProjectFromRequestMock.mockResolvedValue({
    project: { id: 8, installation_id: 66, github_repo_full_name: "other/site" },
  });
  mocks.projectRows = [PROJECT];
  mocks.getUserRoleMock.mockResolvedValue("collaborator");
  mocks.decryptMock.mockResolvedValue("own-token");
  mocks.resolveProjectTokenMock.mockResolvedValue("installation-token");
  mocks.checkRepoAvailabilityMock.mockResolvedValue({
    availability: "available",
    canonicalFullName: "owner/new-name",
  });
});

describe("api.repo-identity", () => {
  it("returns GitHub's current name, read through the role's project token", async () => {
    const res = await call();
    expect(await res.json()).toEqual({ projectId: 7, fullName: "owner/new-name" });
    expect(mocks.getUserRoleMock).toHaveBeenCalledWith(expect.anything(), 7, 42);
    expect(mocks.resolveActiveProjectFromRequestMock).not.toHaveBeenCalled();
    expect(mocks.resolveProjectTokenMock).toHaveBeenCalledWith(
      "app-id",
      "pk",
      55,
      "own-token",
      "collaborator",
    );
    expect(mocks.checkRepoAvailabilityMock).toHaveBeenCalledWith(
      "installation-token",
      "owner",
      "old-name",
    );
  });

  it("answers null when GitHub gives no name", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({
      availability: "unavailable",
      canonicalFullName: null,
    });
    expect(await (await call()).json()).toEqual({ projectId: 7, fullName: null });
  });

  it("answers null when the token cannot be had", async () => {
    mocks.resolveProjectTokenMock.mockRejectedValue(new Error("installation gone"));
    expect(await (await call()).json()).toEqual({ projectId: 7, fullName: null });
  });

  it("answers null to a caller who is not a member of the named project, and reads nothing", async () => {
    mocks.getUserRoleMock.mockResolvedValue(null);
    expect(await (await call()).json()).toEqual({ projectId: 7, fullName: null });
    expect(mocks.checkRepoAvailabilityMock).not.toHaveBeenCalled();
  });

  it("answers null when the named project has no row", async () => {
    mocks.projectRows = [];
    expect(await (await call()).json()).toEqual({ projectId: 7, fullName: null });
    expect(mocks.checkRepoAvailabilityMock).not.toHaveBeenCalled();
  });

  it("refuses a request that names no usable project", async () => {
    for (const query of ["", "?projectId=", "?projectId=0", "?projectId=abc", "?projectId=7.5"]) {
      await expect(call(query), query).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.getUserRoleMock).not.toHaveBeenCalled();
  });
});

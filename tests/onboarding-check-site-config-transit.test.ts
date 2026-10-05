/**
 * A `check-site-config` whose Pages request rejects in transit reaches the
 * wizard as unreachable. The server action throws, as it does in
 * production, and the route's `clientAction` answers it; `verifySiteUrl` is the
 * real one, over a stubbed `fetch`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const project = { id: 42, github_repo_full_name: "owner/repo", installation_id: 11, origin: "imported" };
const db = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Object.assign(Promise.resolve([project]), { get: vi.fn(async () => project) })),
    })),
  })),
};

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => db) }));
vi.mock("~/middleware/auth.server", () => ({ authMiddleware: vi.fn(), userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined), set: vi.fn() })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/membership.server", () => ({
  getUserRole: vi.fn(async () => "convenor"),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));
vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn() }));
vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(),
  listInstallationRepos: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  getFileAtRef: vi.fn(),
  graphqlGitHub: vi.fn(),
  getFileContent: vi.fn(async () => 'url: "https://owner.github.io"\nbaseurl: "/repo"\n'),
}));
vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn(async () => "install-token") }));
vi.mock("~/lib/import.server", () => ({ importRepo: vi.fn() }));
vi.mock("~/lib/upgrade.server", () => ({ checkTelarVersion: vi.fn() }));
vi.mock("~/lib/upgrade-gate.server", () => ({ siteNeedsUpgrade: vi.fn(async () => false) }));
vi.mock("~/lib/onboarding-create-site.server", () => ({ handleCreateSiteIntents: vi.fn() }));

import { action, clientAction } from "~/routes/onboarding";

function checkRequest() {
  return new Request("https://compositor.telar.org/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "check-site-config", project_id: "42" }).toString(),
  });
}

function serverAction(request: Request | never) {
  const context = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc" })),
    cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "p", DB: {} } },
  };
  return () => action({ request, context, params: {} } as never);
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("check-site-config when the Pages request rejects", () => {
  it("throws from the server action, as a rejected fetch does", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    await expect(serverAction(checkRequest() as never)()).rejects.toThrow("fetch failed");
  });

  it("is answered unreachable by the route's clientAction, with status 503", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    const request = checkRequest();
    const answer = await clientAction({ request, serverAction: serverAction(request.clone() as never) } as never);
    expect(answer).toMatchObject({ data: { ok: false, reason: "unreachable", intent: "check-site-config" }, init: { status: 503 } });
  });

  it("passes the other intents' failures through unchanged", async () => {
    const failure = new TypeError("fetch failed");
    const request = new Request("https://compositor.telar.org/onboarding", {
      method: "POST",
      body: new URLSearchParams({ intent: "fix-site-config", project_id: "42" }),
    });
    await expect(clientAction({ request, serverAction: () => Promise.reject(failure) } as never)).rejects.toBe(failure);
  });
});

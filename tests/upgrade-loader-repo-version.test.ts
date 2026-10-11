/**
 * The Upgrade loader takes the version from the repository. A site reverted on
 * GitHub to an earlier Telar version stays recorded at the higher one in D1;
 * the loader must offer the upgrade from the repository's version and write
 * that version to D1.
 *
 * @version v1.5.4-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const d1Writes: Array<Record<string, unknown>> = [];
let d1Version: string | null = "1.8.1";
let repoVersion = "1.7.0";

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: async () => "user-token" }));
vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ telar_version: d1Version }] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          d1Writes.push(values);
        },
      }),
    }),
  }),
}));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: async () => ({
    project: {
      id: 1,
      installation_id: 42,
      github_repo_full_name: "student/my-site",
      github_pages_url: "https://student.github.io/my-site",
    },
    userRole: "convenor",
  }),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: async () => "install-token",
  resolveProjectToken: async () => "install-token",
}));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: async () => ({ tree: [], truncated: false }),
  getFileContent: async (_t: string, _o: string, _r: string, path: string) =>
    path === "_config.yml" ? `telar:\n  version: "${repoVersion}"\n` : null,
  GitHubTransientError: class GitHubTransientError extends Error {},
}));
vi.mock("~/lib/upgrade.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/upgrade.server")>("~/lib/upgrade.server");
  return {
    ...actual,
    fetchLatestRelease: async () => ({ tagName: "v1.8.1", body: "Notes", publishedAt: "2026-10-01T00:00:00Z" }),
    fetchAllReleases: async () => [
      { tagName: "v1.8.1", body: "Notes 1.8.1", publishedAt: "2026-10-10T00:00:00Z" },
      { tagName: "v1.8.0", body: "Notes 1.8.0", publishedAt: "2026-10-05T00:00:00Z" },
      { tagName: "v1.7.0", body: "Notes 1.7.0", publishedAt: "2026-09-10T00:00:00Z" },
    ],
    computeUpgradeDiff: async () => ({
      additions: [],
      deletions: [],
      summary: { layouts: 0, includes: 0, stylesheets: 0, scripts: 0, workflows: 0, dataFiles: 0, other: 0, deletions: 0, total: 0 },
    }),
    loadManifestChain: async () => [],
  };
});

const context = {
  get: () => ({ id: 7, encrypted_access_token: "enc" }),
  cloudflare: { env: { ENCRYPTION_KEY: "key", GITHUB_APP_ID: "app", GITHUB_PRIVATE_KEY: "priv", DB: {} } },
} as never;

async function runLoader() {
  const route = (await import("~/routes/_app.upgrade")) as unknown as {
    loader: (args: { request: Request; context: unknown }) => Promise<Record<string, unknown>>;
  };
  return route.loader({ request: new Request("https://compositor.test/upgrade"), context });
}

beforeEach(() => {
  d1Writes.length = 0;
  d1Version = "1.8.1";
  repoVersion = "1.7.0";
});

describe("Upgrade loader — the repository decides the version", () => {
  it("offers the upgrade and writes the repository's version to D1 when the repository is lower", async () => {
    const data = await runLoader();
    expect(data.needsUpgrade).toBe(true);
    expect(d1Writes).toHaveLength(1);
    expect(d1Writes[0].telar_version).toBe("1.7.0");
  });

  it("lists the release notes from the repository's version, not D1's", async () => {
    const data = await runLoader();
    expect(data.releaseCount).toBe(2);
  });

  it("shows the repository's version, not the one D1 held", async () => {
    const data = await runLoader();
    expect(data.siteVersion).toBe("v1.7.0");
  });

  it("reads a repository reverted below the supported minimum as below it", async () => {
    repoVersion = "0.8.0";
    const data = await runLoader();
    expect(data.isBelowMinimum).toBe(true);
  });

  it("writes nothing when D1 already holds the repository's version", async () => {
    d1Version = "1.7.0";
    const data = await runLoader();
    expect(data.needsUpgrade).toBe(true);
    expect(d1Writes).toHaveLength(0);
  });

  it("follows the repository when D1 holds no version", async () => {
    d1Version = null;
    const data = await runLoader();
    expect(data.needsUpgrade).toBe(true);
    expect(data.siteVersion).toBe("v1.7.0");
    expect(d1Writes).toHaveLength(1);
    expect(d1Writes[0].telar_version).toBe("1.7.0");
  });
});

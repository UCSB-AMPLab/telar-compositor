/**
 * preparedState round-trips through the browser between upgrade-prepare and
 * upgrade-commit. It is untrusted input: both convenor and collaborator can
 * reach upgrade-commit, so a client can hold a value the server never
 * produced, or one it produced for a different project, user, or head.
 * upgrade-commit must refuse to act on it unless a signature minted at
 * prepare time verifies unchanged.
 *
 * Unlike tests/upgrade.action.test.ts, this file leaves workers/auth and
 * crypto.subtle.digest real and unmocked — signing and verification
 * themselves are exactly what is under test here. Everything else
 * (GitHub reads/writes, D1, the manifest chain) is stubbed to an identity
 * pass-through so a real chain of upgrade-prepare then upgrade-commit calls
 * exercises the actual signing and verification code with nothing else to
 * fail on.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Manifest } from "~/lib/manifest-schema.server";

// ---------------------------------------------------------------------------
// Mocks — everything except workers/auth (real signing/verification) and
// crypto.subtle.digest (real hashing)
// ---------------------------------------------------------------------------

const configSetCalls: Array<Record<string, unknown>> = [];

function makeDbMock() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ telar_version: "1.1.0" }]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        configSetCalls.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  };
}
const dbMock = makeDbMock();

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => dbMock) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));

// resolveActiveProject's return value varies per test (and per call, for the
// cross-project/cross-user cases) via mockResolvedValueOnce in each test.
vi.mock("~/lib/membership.server", () => ({
  requirePublishingRole: vi.fn(async () => undefined),
  resolveActiveProject: vi.fn(),
}));

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));

vi.mock("~/lib/github.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/github.server")>(
    "~/lib/github.server",
  );
  return {
    ...actual,
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getRepoHead: vi.fn(async () => "head-oid-abc123"),
    getFileContent: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      path === "_config.yml" ? 'telar:\n  version: "1.1.0"\ntelar_language: "en"\n' : null,
    ),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      path === "_config.yml" ? { status: "ok" as const, content: 'telar:\n  version: "1.1.0"\ntelar_language: "en"\n' } : { status: "absent" as const },
    ),
  };
});

vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-head-sha" })),
  StaleHeadError: class StaleHeadError extends Error {},
  dispatchWorkflow: vi.fn(),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  getWorkflowRun: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
}));

vi.mock("~/lib/upgrade.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/upgrade.server")>(
    "~/lib/upgrade.server",
  );
  return {
    ...actual,
    fetchLatestRelease: vi.fn(),
    fetchAllReleases: vi.fn(),
    computeUpgradeDiff: vi.fn(),
    loadManifestChain: vi.fn(),
  };
});

// Identity pass-through: the manifest chain carries no operations for this
// file's fixture (EMPTY_CHAIN below), so nothing here needs to exercise the
// real manifest DSL. The one step is classified, so the round trip through
// the browser can be seen to keep its kind.
vi.mock("~/lib/manifest-runner.server", () => ({
  applyManifestChain: (_chain: unknown, files: Map<string, string>) => ({
    files,
    deletions: [],
    manualSteps: { en: [{ description: "Re-apply your language packs", audience: "all", kind: "action" }], es: [] },
  }),
}));

import { action } from "~/routes/_app.upgrade";
import {
  fetchLatestRelease,
  computeUpgradeDiff,
  loadManifestChain,
} from "~/lib/upgrade.server";
import { commitFilesToRepo, StaleHeadError } from "~/lib/commit.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { __resetTagCacheForTest, readLatestTag } from "~/lib/github-status.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A to_version under 1.3.0 keeps the ingest branch reserved for that
 *  release out of scope for this fixture. */
const EMPTY_CHAIN: Manifest[] = [
  {
    schema_version: 1,
    from_version: "1.1.0",
    to_version: "1.2.0",
    description: "no operations",
    operations: [],
    manual_steps: { en: [], es: [] },
  },
];

function diffWithContentAndDeletion() {
  return {
    additions: [{ path: "_layouts/default.html", content: "<html>v1.2.0</html>" }],
    deletions: ["_layouts/retired.html"],
    summary: {
      layouts: 1,
      includes: 0,
      stylesheets: 0,
      scripts: 0,
      workflows: 0,
      dataFiles: 0,
      other: 0,
      deletions: 1,
      total: 2,
    },
  };
}

function project(id: number, installationId = 42) {
  return {
    id,
    installation_id: installationId,
    github_repo_full_name: "student/my-site",
    github_pages_url: "https://student.github.io/my-site",
  };
}

// siteId is the session's active project for THIS call (set by the test via
// resolveActiveProject), not necessarily the project a prepared payload was
// signed for — the two are deliberately different in the cross-project test
// below, which is exactly the case the prepared-state signature (not the
// page-site check) must catch.
function buildPrepareRequest(siteId: number): Request {
  const form = new URLSearchParams();
  form.set("intent", "upgrade-prepare");
  form.set("siteId", String(siteId));
  return new Request("https://compositor.telar.org/upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildCommitRequest(preparedJson: string, siteId: number): Request {
  const form = new URLSearchParams();
  form.set("intent", "upgrade-commit");
  form.set("preparedState", preparedJson);
  form.set("siteId", String(siteId));
  return new Request("https://compositor.telar.org/upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext(userId: number) {
  return {
    get: vi.fn(() => ({ id: userId, encrypted_access_token: "enc-token" })),
    cloudflare: {
      env: {
        ENCRYPTION_KEY: "key",
        SESSION_SECRET: "sess-secret",
        GITHUB_APP_ID: "app-id",
        GITHUB_PRIVATE_KEY: "priv-key",
        DB: {},
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

type PrepareResult = { ok: true; intent: "upgrade-prepare"; prepared: Record<string, unknown> }
  | { ok: false; intent: "upgrade-prepare"; error: string };
type CommitResult = {
  ok: boolean;
  intent: "upgrade-commit";
  newHeadSha?: string;
  error?: string;
  manualSteps?: Record<"en" | "es", Array<{ description: string; audience?: string; kind?: string }>>;
};

/** Runs upgrade-prepare for the given user/project/role and returns the
 *  signed `prepared` payload exactly as the client would receive it. */
async function prepare(userId: number, projectId: number, userRole: "convenor" | "collaborator") {
  vi.mocked(resolveActiveProject).mockResolvedValueOnce({
    project: project(projectId),
    userRole,
  } as never);
  const res = (await action({
    request: buildPrepareRequest(projectId),
    context: buildContext(userId),
    params: {},
  } as never)) as PrepareResult;
  if (!res.ok) throw new Error(`prepare failed: ${res.error}`);
  return res.prepared;
}

async function commit(
  preparedJson: string,
  userId: number,
  projectId: number,
  userRole: "convenor" | "collaborator",
) {
  vi.mocked(resolveActiveProject).mockResolvedValueOnce({
    project: project(projectId),
    userRole,
  } as never);
  return (await action({
    request: buildCommitRequest(preparedJson, projectId),
    context: buildContext(userId),
    params: {},
  } as never)) as CommitResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetTagCacheForTest();
  configSetCalls.length = 0;
  vi.mocked(fetchLatestRelease).mockResolvedValue({
    tagName: "v1.2.0",
    body: "Release notes",
    publishedAt: "2026-03-01T00:00:00Z",
  });
  vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithContentAndDeletion());
  vi.mocked(loadManifestChain).mockResolvedValue(EMPTY_CHAIN);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upgrade prepared-state signing", () => {
  it("succeeds end to end for the convenor", async () => {
    const prepared = await prepare(7, 1, "convenor");
    const res = await commit(JSON.stringify(prepared), 7, 1, "convenor");

    expect(res.ok).toBe(true);
    expect(vi.mocked(commitFilesToRepo)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(commitFilesToRepo).mock.calls[0];
    expect(call[4]).toContainEqual({ path: "_layouts/default.html", content: "<html>v1.2.0</html>" });
    expect(call[7]).toEqual(["_layouts/retired.html"]);
  });

  it("keeps each manual step's audience and kind from prepare through commit", async () => {
    const prepared = await prepare(7, 1, "convenor");
    const res = await commit(JSON.stringify(prepared), 7, 1, "convenor");

    expect(res.manualSteps).toEqual({ en: [{ description: "Re-apply your language packs", audience: "all", kind: "action" }], es: [] });
  });

  it("succeeds end to end for a collaborator", async () => {
    const prepared = await prepare(11, 1, "collaborator");
    const res = await commit(JSON.stringify(prepared), 11, 1, "collaborator");

    expect(res.ok).toBe(true);
    expect(vi.mocked(commitFilesToRepo)).toHaveBeenCalledTimes(1);
  });

  it("refuses a payload with a tampered addition's content", async () => {
    const prepared = await prepare(7, 1, "convenor") as {
      additions: Array<{ path: string; content: string }>;
    };
    const tampered = {
      ...prepared,
      additions: prepared.additions.map((a) =>
        a.path === "_layouts/default.html" ? { ...a, content: "<html>attacker-controlled</html>" } : a,
      ),
    };

    const res = await commit(JSON.stringify(tampered), 7, 1, "convenor");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_prepared_state");
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("refuses a payload with an extra path added to deletions", async () => {
    const prepared = await prepare(7, 1, "convenor") as { deletions: string[] };
    const tampered = {
      ...prepared,
      deletions: [...prepared.deletions, "someone-elses-file.md"],
    };

    const res = await commit(JSON.stringify(tampered), 7, 1, "convenor");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_prepared_state");
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("refuses a payload whose freeze lease id was swapped", async () => {
    // The commit renews and ends the lease the payload names; a swapped id
    // would have it act on a different operation.
    const prepared = await prepare(7, 1, "convenor") as { operationId?: string };
    expect(typeof prepared.operationId).toBe("string");
    const tampered = { ...prepared, operationId: "another-operation" };

    const res = await commit(JSON.stringify(tampered), 7, 1, "convenor");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_prepared_state");
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  // Every field the payload carries is signed, the sheet stage's
  // included, and a field the page adds is refused too.
  it.each([
    ["the head rule", { advancesHead: false }],
    ["the sheet report", { sheetReport: [{ kind: "unreadable", sheet: "s.csv", error: "x", file: "s.csv" }] }],
    ["the decisions", { decisions: { sheets: null, rounds: [{ choices: [] }] } }],
    ["whether the sheets were clean", { sheetsClean: false }],
    ["a field prepare never wrote", { verbatimEverything: true }],
  ])("refuses a payload whose %s was changed", async (_label, change) => {
    const prepared = await prepare(7, 1, "convenor");
    const res = await commit(JSON.stringify({ ...prepared, ...change }), 7, 1, "convenor");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_prepared_state");
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("refuses a payload signed for project 1 when submitted against project 2", async () => {
    const prepared = await prepare(7, 1, "convenor");

    const res = await commit(JSON.stringify(prepared), 7, 2, "convenor");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_prepared_state");
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("refuses a payload signed for one user when submitted by another", async () => {
    const prepared = await prepare(7, 1, "convenor");

    const res = await commit(JSON.stringify(prepared), 99, 1, "convenor");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_prepared_state");
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("lets a validly-signed payload through to the pre-existing stale-head refusal once the head has moved", async () => {
    const prepared = await prepare(7, 1, "convenor");
    // Simulate the real head moving between prepare and commit: the payload
    // itself is untouched (a valid signature), so verification passes: it is
    // commitFilesToRepo's own compare-and-swap against expectedHeadOid that
    // must refuse this, not the signature check.
    vi.mocked(commitFilesToRepo).mockRejectedValueOnce(
      new StaleHeadError("Expected HEAD to be at a different commit"),
    );

    const res = await commit(JSON.stringify(prepared), 7, 1, "convenor");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("stale_head");
    // Reached the commit call at all — proof verification did not block it.
    expect(vi.mocked(commitFilesToRepo)).toHaveBeenCalledTimes(1);
  });
});

// The commit checks the prepared target against the latest release,
// through the same tag read the content-write gate uses.
describe("upgrade commit against the latest release", () => {
  function release(tagName: string) {
    return { tagName, body: "Release notes", publishedAt: "2026-03-01T00:00:00Z" };
  }

  it("refuses a prepared upgrade whose target a newer release has overtaken, and commits nothing", async () => {
    const prepared = await prepare(7, 1, "convenor");
    expect(prepared.newVersion).toBe("v1.2.0");
    vi.mocked(fetchLatestRelease).mockResolvedValue(release("v1.3.0"));
    const res = await commit(JSON.stringify(prepared), 7, 1, "convenor");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("prepared_outdated");
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("refuses when the latest release cannot be read, and commits nothing", async () => {
    const prepared = await prepare(7, 1, "convenor");
    vi.mocked(fetchLatestRelease).mockRejectedValue(new Error("GitHub unavailable"));
    const res = await commit(JSON.stringify(prepared), 7, 1, "convenor");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("release_unknown");
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("commits a prepared target that is the latest release", async () => {
    const prepared = await prepare(7, 1, "convenor");
    const res = await commit(JSON.stringify(prepared), 7, 1, "convenor");
    expect(res.ok).toBe(true);
    expect(vi.mocked(commitFilesToRepo)).toHaveBeenCalled();
  });

  it("commits a prepared target newer than a cached tag that has not caught up", async () => {
    // The cache holds v1.2.0 from an earlier read; prepare reads GitHub itself and finds v1.3.0.
    await readLatestTag("user-token", Date.now());
    vi.mocked(fetchLatestRelease).mockResolvedValue(release("v1.3.0"));
    const prepared = await prepare(7, 1, "convenor");
    expect(prepared.newVersion).toBe("v1.3.0");
    const res = await commit(JSON.stringify(prepared), 7, 1, "convenor");
    expect(res.ok).toBe(true);
  });
});

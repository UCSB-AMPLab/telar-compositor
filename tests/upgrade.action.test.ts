/**
 * This file tests the upgrade route action end-to-end.
 *
 * Covers: loadManifestChain + applyManifestChain + tree-diff merge + atomic
 * commit + D1 version bump, including the blocker merge-order fix (patchedConfig
 * seeded into manifest-runner input, not pre-upgrade configContent) and the
 * symmetric version normalisation that handles the historical edge case where
 * recorded versions occasionally lacked a leading `v`.
 *
 * Mocking strategy: because the action pulls in auth middleware, drizzle/D1,
 * crypto, session storage, and GitHub helpers, we mock the whole dependency
 * graph at the module boundary and invoke `action({request, context})`
 * directly. The D1 layer is mocked as a chainable drizzle builder via a small
 * hand-rolled fake that tracks `.update(table).set(values).where(...)` calls.
 *
 * The workflow commit's single retry on a GitHub server error is exercised here
 * too, and so is the `rebuild` intent the failed-build screen submits.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { createHash } from "node:crypto";
import { join } from "path";
import { validateManifest, type Manifest } from "~/lib/manifest-schema.server";
import type { FileAtRef, TreeEntry } from "~/lib/github.server";
import { V121_BODIES } from "~/lib/v130-ingest.server";

// ---------------------------------------------------------------------------
// Fixture loaders
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(
  __dirname,
  "fixtures",
  "manifest-snapshots",
  "mirl-story-v092-to-v120",
  "before",
);
const BEFORE_CONFIG = readFileSync(join(FIXTURE_DIR, "_config.yml"), "utf-8");
const BEFORE_PROJECT_CSV = readFileSync(
  join(FIXTURE_DIR, "project.csv"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track calls to project_config.set so tests can inspect telar_version writes.
const configSetCalls: Array<Record<string, unknown>> = [];
const projectsSetCalls: Array<Record<string, unknown>> = [];

// Minimal drizzle-shaped fake. Each table call returns a thenable chain.
function makeDbMock() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ telar_version: "v0.9.2-beta" }]),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => {
      const tableName = (table as { _?: { name?: string } })?._?.name ?? "";
      return {
        set: vi.fn((values: Record<string, unknown>) => {
          if (tableName.includes("project_config") || table === project_config) {
            configSetCalls.push(values);
          } else if (tableName.includes("projects") || table === projects) {
            projectsSetCalls.push(values);
          }
          // Awaitable for a plain write, and `.returning()` for a
          // compare-and-set one, which reports one row changed.
          return {
            where: vi.fn(() =>
              Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => [{ id: 1 }]) }),
            ),
          };
        }),
      };
    }),
  };
}

// Reference the same table objects the action imports so the update branch
// identifies which table is being written. Import lazily after mocks are set.
let project_config: unknown;
let projects: unknown;

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
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "user-token"),
}));

vi.mock("~/lib/membership.server", () => ({
  requirePublishingRole: vi.fn(async () => undefined),
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 1,
      installation_id: 42,
      github_repo_full_name: "student/my-site",
      github_pages_url: "https://student.github.io/my-site",
    },
    userRole: "convenor",
  })),
}));

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));

// Partial mock: the three network readers are stubbed, but GitHubTransientError
// is the real class. The retry under test turns on `instanceof`, so a stand-in
// class here would let the test pass against a route that never retried.
vi.mock("~/lib/github.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/github.server")>(
    "~/lib/github.server",
  );
  return {
    ...actual,
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getRepoHead: vi.fn(async () => "head-oid-abc123"),
    // The spreadsheets directory, listed on its own when the tree is truncated.
    listDirectoryEntries: vi.fn(async () => []),
    getFileContent: vi.fn(async (_t: string, _o: string, _r: string, path: string) => {
      if (path === "_config.yml") return BEFORE_CONFIG;
      if (path.endsWith("project.csv")) return BEFORE_PROJECT_CSV;
      return null;
    }),
    // Prepare's reads of the site, at the head it listed.
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) => {
      if (path === "_config.yml") return { status: "ok" as const, content: BEFORE_CONFIG };
      if (path.endsWith("project.csv")) return { status: "ok" as const, content: BEFORE_PROJECT_CSV };
      return { status: "absent" as const };
    }),
  };
});

vi.mock("~/lib/commit.server", async () => ({
  cleanCommitContent: (await vi.importActual<typeof import("~/lib/commit.server")>("~/lib/commit.server")).cleanCommitContent,
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

// This file's business-logic tests (manifest chains, version bumps, the
// workflow-commit retry under fake timers) are independent of prepared-state
// signing itself, which has its own dedicated, unmocked test coverage
// elsewhere. _app.upgrade.tsx imports signInternalMarker/verifyInternalMarker
// from "../../workers/auth" (app/routes/ -> root/workers), and this file in
// tests/ reaches the same module via "../workers/auth" — same relative-path
// convention already used by the publish action tests. verifyInternalMarker
// resolves to `null`, its own real "signature is valid" return value.
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "test-sig", timestamp: Math.floor(Date.now() / 1000) })),
  verifyInternalMarker: vi.fn(async () => null),
}));

// hashPreparedUpgradeContent (local to _app.upgrade.tsx, not part of
// workers/auth) calls the real crypto.subtle.digest directly. Real WebCrypto
// does not reliably resolve under vi.useFakeTimers() + advanceTimersByTimeAsync
// once it sits behind the long await chain runUpgradePrepare runs first — this
// stub keeps that real-crypto behaviour out of tests that only care about
// manifest/version/retry business logic, matching the workers/auth mock above.
vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));

// The freeze lease is the Durable Object's; here only the calls the action
// makes to it are observed, and every one of them is answered as applied.
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "op-test"),
}));

// The head writers run for real against the db mock above; spied so a test
// can say which head each advanced from.
vi.mock("~/lib/github-status.server", async (orig) => {
  const actual = (await orig()) as typeof import("~/lib/github-status.server");
  return {
    ...actual,
    bumpProjectHeadFrom: vi.fn(actual.bumpProjectHeadFrom),
  };
});

// The 1.7.0 template's _config.yml reads Google Sheets, so an upgrade to
// 1.8.0 checks its published tabs; here the sheet publishes one clean tab.
vi.mock("~/lib/sheets.server", async (orig) => ({
  ...((await orig()) as typeof import("~/lib/sheets.server")),
  readPublishedTabs: vi.fn(async () => [{ name: "project", gid: "0", file: "project.csv", text: "order,story_id\n" }]),
}));

// Hoisted db mock is required because vi.mock('~/lib/db.server') hoists above imports.
const dbMock = makeDbMock();

// Pre-empt the Route typegen stub so the action file imports cleanly under node.
// Nothing in the action's runtime uses Route.ActionArgs shape beyond {request, context}.

import { action as routeAction, loader } from "~/routes/_app.upgrade";

/**
 * The route's action, and the whole upgrade under the old single-shot intent
 * name: prepare, then the commit of the upgrade prepare answered, as the page
 * drives it. The route has no single-shot intent, so nothing reaches a commit
 * without passing prepare's answers.
 */
async function action(args: Parameters<typeof routeAction>[0]) {
  const form = await args.request.clone().formData();
  if (form.get("intent") !== "upgrade") return routeAction(args);
  const prepared = (await routeAction({ ...args, request: buildRequest("upgrade-prepare") })) as {
    ok: boolean;
    answer?: string;
    prepared?: unknown;
  };
  if (!prepared.ok || prepared.answer !== "ready") return prepared;
  return routeAction({
    ...args,
    request: buildRequest("upgrade-commit", { preparedState: JSON.stringify(prepared.prepared) }),
  });
}
import {
  fetchLatestRelease,
  computeUpgradeDiff,
  loadManifestChain,
  ReleaseLookupError,
  __clearManifestCacheForTests,
} from "~/lib/upgrade.server";
import {
  ReleaseFileUnreadableError,
  ReleaseListUnreadableError,
  ReleaseManifestInvalidError,
  ReleaseTreeUnreadableError,
  UpgradeFileNotTextError,
  UpgradeFileUnreadableError,
} from "~/lib/upgrade-reads.server";
import {
  getRepoHead,
  getRepoTree,
  getFileAtRef,
  getFileContent,
  GitHubTransientError,
} from "~/lib/github.server";
import {
  commitFilesToRepo,
  dispatchWorkflow,
  getWorkflowRun,
  listWorkflowRunsBySha,
  getJobSteps,
  mapStepsToBuildPhases,
  StaleHeadError,
} from "~/lib/commit.server";
import { getInstallationToken } from "~/lib/github-app.server";
import { bumpProjectHeadFrom } from "~/lib/github-status.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { requirePublishingRole, resolveActiveProject } from "~/lib/membership.server";
import { project_config as projectConfigTable, projects as projectsTable } from "~/db/schema";
project_config = projectConfigTable;
projects = projectsTable;

// ---------------------------------------------------------------------------
// Test fixtures — manifest chain 0.9.2-beta -> 1.2.0
// ---------------------------------------------------------------------------

const MANIFEST_092_093: Manifest = {
  schema_version: 1,
  from_version: "0.9.2-beta",
  to_version: "0.9.3-beta",
  description: "IIIF tile fixes",
  operations: [],
  manual_steps: {
    en: [{ description: "Regenerate IIIF tiles" }],
    es: [{ description: "Regenera teselas IIIF" }],
  },
};

const MANIFEST_093_094: Manifest = {
  schema_version: 1,
  from_version: "0.9.3-beta",
  to_version: "0.9.4-beta",
  description: "patch",
  operations: [],
  manual_steps: { en: [], es: [] },
};

const MANIFEST_094_100: Manifest = {
  schema_version: 1,
  from_version: "0.9.4-beta",
  to_version: "1.0.0-beta",
  description: "max_viewer_cards bump",
  operations: [
    {
      type: "config_update_value",
      key: "max_viewer_cards",
      old_value: "10",
      new_value: "8",
    },
  ],
  manual_steps: { en: [], es: [] },
};

const MANIFEST_100_110: Manifest = {
  schema_version: 1,
  from_version: "1.0.0-beta",
  to_version: "1.1.0",
  description: "collection_mode added",
  operations: [
    {
      type: "config_add_field",
      key: "collection_mode",
      value: "false",
      after_key: "telar_language",
      comment: "Set to true for collection-first homepage",
      skip_if_exists: true,
    },
  ],
  manual_steps: {
    en: [{ description: "New features: deep linking, collection mode", doc_url: "https://telar.org/docs" }],
    es: [{ description: "Nuevas funciones: enlaces directos, modo colección", doc_url: "https://telar.org/guia" }],
  },
};

const MANIFEST_110_120: Manifest = {
  schema_version: 1,
  from_version: "1.1.0",
  to_version: "1.2.0",
  description: "show_sections column",
  operations: [
    {
      type: "csv_add_column",
      file_glob: "**/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "",
      after: { en: "private", es: "privada" },
    },
  ],
  manual_steps: {
    en: [{ description: "New: section TOC, Back to Start" }],
    es: [{ description: "Nuevo: TOC de secciones, volver al inicio" }],
  },
};

const FULL_CHAIN: Manifest[] = [
  MANIFEST_092_093,
  MANIFEST_093_094,
  MANIFEST_094_100,
  MANIFEST_100_110,
  MANIFEST_110_120,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(intent: string, fields: Record<string, string> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  // Every intent here is refused unless the posted siteId matches the
  // session's active project (id 1, per the resolveActiveProject mock above
  // and every override of it in this file); `fields` can still replace it.
  form.set("siteId", "1");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("https://compositor.telar.org/upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

// Minimal context — action reads context.get(userContext) and
// context.cloudflare.env.
function buildContext(overrides: Partial<{ user: unknown; env: Record<string, unknown> }> = {}) {
  const user = overrides.user ?? { id: 7, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    GITHUB_APP_ID: "app-id",
    GITHUB_PRIVATE_KEY: "priv-key",
    DB: {},
    ...(overrides.env ?? {}),
  };
  return {
    get: vi.fn(() => user),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

/** A site file as prepare's strict read at the head answers it: its text, or absent. */
function atRef(content: string | null): FileAtRef {
  return content === null ? { status: "absent" } : { status: "ok", content };
}

function latestRelease(tag: string) {
  return {
    tagName: tag,
    body: "Release notes",
    publishedAt: "2026-03-01T00:00:00Z",
  };
}

function emptyDiff() {
  return {
    additions: [],
    deletions: [],
    summary: {
      layouts: 0,
      includes: 0,
      stylesheets: 0,
      scripts: 0,
      workflows: 0,
      dataFiles: 0,
      other: 0,
      deletions: 0,
      total: 0,
    },
  };
}

// A diff that includes a .github/workflows/ file plus a content file, so the
// upgrade action exercises the split-commit path.
function diffWithWorkflow() {
  return {
    additions: [
      { path: ".github/workflows/build.yml", content: "name: build" },
      { path: "_layouts/default.html", content: "<html></html>" },
    ],
    deletions: [],
    summary: {
      layouts: 1,
      includes: 0,
      stylesheets: 0,
      scripts: 0,
      workflows: 1,
      dataFiles: 0,
      other: 0,
      deletions: 0,
      total: 2,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  configSetCalls.length = 0;
  projectsSetCalls.length = 0;
  // Default db behaviour: project_config's `.limit(1)` read, and an awaited
  // `.where()` (the project's stories and their steps) answering none.
  (dbMock.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn(() => ({
      leftJoin: vi.fn(() => ({ where: vi.fn(() => ({ orderBy: vi.fn(async () => []) })) })),
      where: vi.fn(() =>
        Object.assign(Promise.resolve([]), {
          limit: vi.fn(async () => [{ telar_version: "v0.9.2-beta" }]),
        }),
      ),
    })),
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upgrade action: manifest pipeline", () => {
  it("rejects a non-publishing role (requirePublishingRole throws)", async () => {
    vi.mocked(requirePublishingRole).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );
    try {
      await action({ request: buildRequest("upgrade"), context: buildContext(), params: {} } as never);
      expect.fail("expected a 403 Response to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(403);
    }
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("owner succeeds and commit receives merged additions", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);

    const res = await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    expect((res as { ok: boolean }).ok).toBe(true);
    expect(commitFilesToRepo).toHaveBeenCalledTimes(1);
    const call = vi.mocked(commitFilesToRepo).mock.calls[0];
    // positional args: installToken, owner, repo, branch, additions, msg, body, deletions, skipCi, expectedHeadOid
    const additions = call[4] as Array<{ path: string; content: string }>;
    const configEntry = additions.find((a) => a.path === "_config.yml");
    expect(configEntry).toBeDefined();
    const csvEntry = additions.find((a) => a.path.endsWith("project.csv"));
    expect(csvEntry).toBeDefined();
    expect(csvEntry!.content).toMatch(/show_sections/);
    expect((res as { ok: boolean }).ok).toBe(true);
  });

  it("seeds manifest runner with patchedConfig (not pre-upgrade config) — merge-order regression guard", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);

    await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    const additions = vi.mocked(commitFilesToRepo).mock.calls[0][4] as Array<{
      path: string;
      content: string;
    }>;
    const configEntry = additions.find((a) => a.path === "_config.yml");
    expect(configEntry).toBeDefined();
    // Contains the bumped version AND a manifest-added field. The version is
    // written by updateTelarVersionInConfig which preserves latestRelease.tagName
    // verbatim, so the "v" prefix is retained inside the telar: block.
    expect(configEntry!.content).toMatch(/version:\s*["']?v?1\.2\.0/);
    expect(configEntry!.content).toMatch(/collection_mode:\s*false/);
  });

  // The date comes from the manifest that installs the release, so
  // both upgrade routes stamp the date the framework declares.
  it("stamps the release date the last manifest declares, not the publication day", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    const dated = FULL_CHAIN.map((m, i) =>
      i === FULL_CHAIN.length - 1 ? { ...m, release_date: "2026-02-27" } : m,
    );
    vi.mocked(loadManifestChain).mockResolvedValue(dated);

    await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    const additions = vi.mocked(commitFilesToRepo).mock.calls[0][4] as Array<{ path: string; content: string }>;
    const config = additions.find((a) => a.path === "_config.yml")!.content;
    expect(config).toMatch(/release_date:\s*"2026-02-27"/);
  });

  it("normalises fromVersion and toVersion symmetrically — v0.9.2-beta -> 0.9.2-beta, v1.2.0 -> 1.2.0", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);
    // D1 returns "v0.9.2-beta" (with leading v) — the action must strip it.
    (dbMock.select as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ telar_version: "v0.9.2-beta" }]),
        })),
      })),
    });

    await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    expect(loadManifestChain).toHaveBeenCalledWith(
      expect.any(String),
      "0.9.2-beta",
      "1.2.0",
      undefined,
    );
  });

  it("passes expectedHeadOid to commitFilesToRepo", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);
    vi.mocked(getRepoHead).mockResolvedValue("head-oid-abc123");

    await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    const call = vi.mocked(commitFilesToRepo).mock.calls[0];
    // 10th positional arg (index 9) is expectedHeadOid
    expect(call[9]).toBe("head-oid-abc123");
  });

  // Whether the site has a file decides whether the upgrade may write
  // one, so the tree has to be the revision the commit is made on. A read
  // without a ref takes the default branch, which need not be main.
  it("diffs the tree at the head it commits on, and says whether that tree was truncated", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);
    vi.mocked(getRepoHead).mockResolvedValue("head-oid-abc123");
    vi.mocked(getRepoTree).mockResolvedValue({ tree: [], truncated: true });

    await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    const treeCall = vi.mocked(getRepoTree).mock.calls[0];
    expect(treeCall[3]).toBe("head-oid-abc123");
    expect(vi.mocked(getRepoHead).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(getRepoTree).mock.invocationCallOrder[0],
    );
    const diffCall = vi.mocked(computeUpgradeDiff).mock.calls[0];
    expect(diffCall[3]).toMatchObject({ userTreeTruncated: true });
  });

  it("returns manualSteps in response payload", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; manualSteps?: { en?: unknown[]; es?: unknown[] } };

    expect(res.ok).toBe(true);
    expect(Array.isArray(res.manualSteps?.en)).toBe(true);
    // Should include steps from manifests with non-empty manual_steps.en
    expect((res.manualSteps?.en as Array<unknown>).length).toBeGreaterThan(0);
    expect((res.manualSteps?.es as Array<unknown>).length).toBeGreaterThan(0);
  });

  it("returns upgradeError when loadManifestChain throws (missing migration manifest)", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockRejectedValueOnce(
      new Error("Missing migration manifest for upgrade path"),
    );

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing_manifest");
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(configSetCalls).toHaveLength(0);
  });

  it("returns upgradeError when applyManifestChain throws on a scope violation", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    // Chain includes a regex_replace op targeting a path outside the allowlist.
    const BAD_CHAIN: Manifest[] = [
      {
        schema_version: 1,
        from_version: "0.9.2-beta",
        to_version: "1.2.0",
        description: "bad",
        operations: [
          {
            type: "regex_replace",
            file_glob: "**/*.exe",
            search: "foo",
            replace: "bar",
          },
        ],
        manual_steps: { en: [], es: [] },
      },
    ];
    vi.mocked(loadManifestChain).mockResolvedValue(BAD_CHAIN);
    // Seed with a file that will match the glob to trigger the scope check.
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "_config.yml") return atRef(BEFORE_CONFIG);
      if (path.endsWith(".exe")) return atRef("binary");
      return atRef(null);
    });
    // collectFilesReferencedByChain for regex_replace adds known CSV paths
    // only — so the runner's glob match runs on in-map files. Add a fake
    // file to the runner input by mocking collectFilesReferencedByChain
    // indirectly: seed an extra file via _config.yml by also faking a
    // mis-targeted path. Simpler: insert a bad path via an "exe" key in
    // the manifest using file_delete first. Use file_delete to insert
    // a matching file into deletions. Actually simplest: the runner's
    // matchGlob against in-map files will only find files we seeded;
    // so seed one by extending collectFilesReferencedByChain.
    // Fallback: rely on _config.yml being added + regex_replace scope
    // allowlist rejection when file_glob matches _config.yml. Use a
    // bad glob that would match _config.yml but fail the path allowlist —
    // but _config.yml is in the allowlist.
    // Use file_delete op with a malicious path instead — but file_delete
    // doesn't hit the scope check. The cleanest test is to replace the op
    // with regex_replace targeting _config.yml with a bad pattern —
    // but _config.yml is allowed. We need a path that matches the glob
    // AND is in the map AND fails scope. Use ".git/config" via a glob.
    // The runner's opRegexReplace throws BEFORE applying if isPathInScope
    // returns false. Populate the map with ".git/HEAD" which starts with
    // ".git/" (scope-rejected). To inject it into the runner's input,
    // we can't via collectFilesReferencedByChain today — so replace the
    // failing chain with one that has a malformed regex instead.
    const BROKEN_CHAIN: Manifest[] = [
      {
        schema_version: 1,
        from_version: "0.9.2-beta",
        to_version: "1.2.0",
        description: "bad-regex",
        operations: [
          {
            type: "regex_replace",
            file_glob: "**/*.yml",
            search: "[", // invalid regex — throws in RegExp constructor
            replace: "x",
          },
        ],
        manual_steps: { en: [], es: [] },
      },
    ];
    vi.mocked(loadManifestChain).mockResolvedValue(BROKEN_CHAIN);

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("manifest_failed");
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(configSetCalls).toHaveLength(0);
  });

  it("names a list the manifest could not add to, with its file, key and values, and commits nothing", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    // The reader is shared by every test in this file and keeps an
    // implementation across tests, so the one in place is put back after.
    const previousRead = vi.mocked(getFileAtRef).getMockImplementation();
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) =>
      atRef(path === "_config.yml" ? 'title: "Site"\ntelar:\n  version: "0.9.2-beta"\nexclude:\n  vendor: true\n' : null),
    );
    const LIST_CHAIN: Manifest[] = [
      {
        schema_version: 1,
        from_version: "0.9.2-beta",
        to_version: "1.2.0",
        description: "exclude entries",
        operations: [
          { type: "yaml_list_add", file: "_config.yml", key: "exclude", values: ["telar-content/texts/", "tests/"] },
        ],
        manual_steps: { en: [], es: [] },
      },
    ];
    vi.mocked(loadManifestChain).mockResolvedValue(LIST_CHAIN);

    let res: { ok: boolean; error?: string; detail?: unknown };
    try {
      res = (await action({
        request: buildRequest("upgrade"),
        context: buildContext(),
        params: {},
      } as never)) as typeof res;
    } finally {
      if (previousRead) vi.mocked(getFileAtRef).mockImplementation(previousRead);
    }

    expect(res.ok).toBe(false);
    expect(res.error).toBe("config_exclude_unreadable");
    expect(res.detail).toEqual({ file: "_config.yml", key: "exclude", values: ["telar-content/texts/", "tests/"] });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(configSetCalls).toHaveLength(0);
  });

  it("reports a list refused for any reason but a mapping as the generic manifest failure", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    // The reader is shared by every test in this file and keeps an
    // implementation across tests, so the one in place is put back after.
    const previousRead = vi.mocked(getFileAtRef).getMockImplementation();
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) =>
      atRef(path === "_config.yml" ? 'title: "Site"\ntelar:\n  version: "0.9.2-beta"\nexclude: &gems [vendor]\n' : null),
    );
    const LIST_CHAIN: Manifest[] = [
      {
        schema_version: 1,
        from_version: "0.9.2-beta",
        to_version: "1.2.0",
        description: "exclude entries",
        operations: [
          { type: "yaml_list_add", file: "_config.yml", key: "exclude", values: ["telar-content/texts/", "tests/"] },
        ],
        manual_steps: { en: [], es: [] },
      },
    ];
    vi.mocked(loadManifestChain).mockResolvedValue(LIST_CHAIN);

    let res: { ok: boolean; error?: string; detail?: unknown };
    try {
      res = (await action({
        request: buildRequest("upgrade"),
        context: buildContext(),
        params: {},
      } as never)) as typeof res;
    } finally {
      if (previousRead) vi.mocked(getFileAtRef).mockImplementation(previousRead);
    }

    expect(res.ok).toBe(false);
    expect(res.error).toBe("manifest_failed");
    expect(res.detail).toBeUndefined();
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(configSetCalls).toHaveLength(0);
  });

  it("commits the 1.8.0 page lines: the manifest loads the built-in pages its guarded edits name", async () => {
    const upgradeFixture = (name: string) =>
      readFileSync(join(__dirname, "fixtures", "upgrade-1.8.0", name), "utf-8");
    const MANIFEST_180 = validateManifest(JSON.parse(upgradeFixture("migration.json")));
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.8.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue([MANIFEST_180]);
    const SITE: Record<string, string> = {
      "_config.yml": upgradeFixture("config-v1.7.0.yml"),
      "index.md": upgradeFixture("index-v1.7.0.md"),
      "pages/glossary.md": upgradeFixture("glossary-v1.7.0.md"),
    };
    const previousRead = vi.mocked(getFileAtRef).getMockImplementation();
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) => atRef(SITE[path] ?? null));
    // The release copies of the built-in pages are read for their front
    // matter; none is found here, so the pages carry the manifest's edits alone.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    // This file answers every digest with the same bytes, which makes the
    // v1.3.0 transforms read every page as the v1.2.1 default and replace it.
    // The page-line check needs real hashes, so this test has them.
    vi.mocked(crypto.subtle.digest).mockImplementation(async (_algorithm, data) => {
      const digest = createHash("sha256").update(Buffer.from(data as Uint8Array)).digest();
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.length) as ArrayBuffer;
    });

    let res: { ok: boolean; error?: string };
    try {
      res = (await action({
        request: buildRequest("upgrade"),
        context: buildContext(),
        params: {},
      } as never)) as typeof res;
    } finally {
      if (previousRead) vi.mocked(getFileAtRef).mockImplementation(previousRead);
      vi.unstubAllGlobals();
      vi.mocked(crypto.subtle.digest).mockResolvedValue(new ArrayBuffer(32));
    }

    expect(res.ok).toBe(true);
    const additions = vi.mocked(commitFilesToRepo).mock.calls[0][4] as Array<{ path: string; content: string }>;
    const committed = new Map(additions.map((a) => [a.path, a.content]));
    expect(committed.get("index.md")).toBe(upgradeFixture("index-0dd90d52.md"));
    expect(committed.get("pages/glossary.md")).toContain("{% include glossary-intro.html lang=lang %}");
    expect(committed.get("pages/glossary.md")).not.toContain("{{ lang.pages.glossary_intro }}");
  });

  it("commits the 1.8.0 page lines over a 1.2.x site's default pages, after the v1.3.0 ingest", async () => {
    const upgradeFixture = (name: string) =>
      readFileSync(join(__dirname, "fixtures", "upgrade-1.8.0", name), "utf-8");
    const MANIFEST_180 = validateManifest(JSON.parse(upgradeFixture("migration.json")));
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.8.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue([MANIFEST_180]);
    const SITE: Record<string, string> = {
      "_config.yml": upgradeFixture("config-v1.7.0.yml"),
      "index.md": `---\nlayout: index\ntitle: Home\n---\n\n${V121_BODIES.index}\n`,
      "pages/glossary.md": `---\nlayout: glossary-index\ntitle: Glossary\n---\n\n${V121_BODIES.glossary}\n`,
    };
    const previousRead = vi.mocked(getFileAtRef).getMockImplementation();
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) => atRef(SITE[path] ?? null));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    // The ingest compares page bodies by hash, so this test has real ones.
    vi.mocked(crypto.subtle.digest).mockImplementation(async (_algorithm, data) => {
      const digest = createHash("sha256").update(Buffer.from(data as Uint8Array)).digest();
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.length) as ArrayBuffer;
    });

    let res: { ok: boolean; error?: string };
    try {
      res = (await action({
        request: buildRequest("upgrade"),
        context: buildContext(),
        params: {},
      } as never)) as typeof res;
    } finally {
      if (previousRead) vi.mocked(getFileAtRef).mockImplementation(previousRead);
      vi.unstubAllGlobals();
      vi.mocked(crypto.subtle.digest).mockResolvedValue(new ArrayBuffer(32));
    }

    expect(res.ok).toBe(true);
    const additions = vi.mocked(commitFilesToRepo).mock.calls[0][4] as Array<{ path: string; content: string }>;
    const committed = new Map(additions.map((a) => [a.path, a.content]));
    expect(committed.get("index.md")).toMatch(
      /\{\{ lang\.index_page\.welcome \| default: site\.data\.languages\.en\.index_page\.welcome \| markdownify \}\}\n$/,
    );
    expect(committed.get("pages/glossary.md")).toMatch(/\{% include glossary-intro\.html lang=lang %\}\n$/);
  });

  it("prepares the 1.8.0 manifest over a 1.7.0 site without fetching any file_delete path, and deletes the ones the site has", async () => {
    const upgradeFixture = (name: string) =>
      readFileSync(join(__dirname, "fixtures", "upgrade-1.8.0", name), "utf-8");
    const MANIFEST_180 = validateManifest(JSON.parse(upgradeFixture("migration.json")));
    const DELETED = MANIFEST_180.operations.flatMap((op) => (op.type === "file_delete" ? op.paths : []));
    // The 1.7.0 template's tree, as `git ls-tree -r v1.7.0` lists it.
    const SITE_TREE = upgradeFixture("tree-v1.7.0.txt")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [meta, path] = line.split("\t");
        const [mode, type, sha] = meta.split(" ");
        return { path, mode, type, sha } as TreeEntry;
      });
    const siteHas = new Set(SITE_TREE.map((e) => e.path));
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.8.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue([MANIFEST_180]);
    const previousRead = vi.mocked(getFileAtRef).getMockImplementation();
    const previousTree = vi.mocked(getRepoTree).getMockImplementation();
    // The recorded tree lists the site's sheets, which the 1.8.0 sheet stage
    // reads; each is answered as a sheet with nothing to repair, since this
    // test is about the manifest's deletions.
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "_config.yml") return atRef(upgradeFixture("config-v1.7.0.yml"));
      return atRef(path.startsWith("telar-content/spreadsheets/") && siteHas.has(path) ? "id,title\n" : null);
    });
    vi.mocked(getRepoTree).mockImplementation(async () => ({ tree: SITE_TREE, truncated: false }));
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    let res: { ok: boolean; error?: string };
    try {
      res = (await action({
        request: buildRequest("upgrade"),
        context: buildContext(),
        params: {},
      } as never)) as typeof res;
    } finally {
      if (previousRead) vi.mocked(getFileAtRef).mockImplementation(previousRead);
      if (previousTree) vi.mocked(getRepoTree).mockImplementation(previousTree);
      vi.unstubAllGlobals();
    }

    expect(res.ok).toBe(true);
    const deletedSet = new Set(DELETED);
    const read = vi.mocked(getFileAtRef).mock.calls.map((call) => call[3]);
    expect(read.filter((path) => deletedSet.has(path))).toEqual([]);
    const fetched = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(fetched.filter((url) => DELETED.some((path) => url.includes(`/contents/${path}`)))).toEqual([]);

    // Every deletion the commit's own head check would have kept: the
    // manifest's paths the 1.7.0 site has, and none it does not.
    const committedDeletions = vi.mocked(commitFilesToRepo).mock.calls.flatMap(
      (call) => (call[7] as string[] | undefined) ?? [],
    );
    const expected = DELETED.filter((path) => siteHas.has(path));
    expect(expected.length).toBeGreaterThan(90);
    expect([...committedDeletions].sort()).toEqual([...expected].sort());
  });

  it("does NOT update D1 telar_version on failure", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockRejectedValueOnce(new Error("missing"));

    await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    expect(configSetCalls).toHaveLength(0);
    expect(projectsSetCalls).toHaveLength(0);
  });

  it("updates D1 telar_version once on success with normalised toVersion (no leading v)", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);

    await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    expect(configSetCalls).toHaveLength(1);
    // Must be normalised — no leading "v".
    expect(configSetCalls[0].telar_version).toBe("1.2.0");
    expect(projectsSetCalls).toHaveLength(1);
    expect(projectsSetCalls[0].head_sha).toBe("new-head-sha");
    // The single commit advances head_sha only from the head it was built on.
    expect(bumpProjectHeadFrom).toHaveBeenCalledWith(expect.anything(), 1, "head-oid-abc123", "new-head-sha");
  });
});

// The upgrade route's project-repo reads
// (getRepoTree, getRepoHead, getFileAtRef, the workflow commit) must run
// on the installation token for a collaborator, never their own decrypted
// OAuth token — a private repo the collaborator is not a GitHub
// collaborator on would reject their token outright. Rather than mock the
// distinction away, this simulates GitHub itself refusing anything but the
// installation token, and asserts the upgrade still completes.
describe("upgrade action: completes for a collaborator on a private repo", () => {
  // The mocks this test overrides are module-level vi.fn()s shared by every
  // test in this file; vi.clearAllMocks() (the file's beforeEach) clears
  // call history but leaves a set mockResolvedValue/mockImplementation in
  // place, so this test's collaborator role and reject-unless-install
  // behaviour must be restored here or every later test in the file would
  // silently run as a collaborator against a GitHub that only accepts
  // "install-token".
  afterEach(() => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: {
        id: 1,
        installation_id: 42,
        github_repo_full_name: "student/my-site",
        github_pages_url: "https://student.github.io/my-site",
      },
      userRole: "convenor",
    } as never);
    vi.mocked(getRepoTree).mockImplementation(async () => ({ tree: [], truncated: false }));
    vi.mocked(getRepoHead).mockImplementation(async () => "head-oid-abc123");
    vi.mocked(getFileAtRef).mockImplementation(
      async (_t: string, _o: string, _r: string, path: string) => {
        if (path === "_config.yml") return atRef(BEFORE_CONFIG);
        if (path.endsWith("project.csv")) return atRef(BEFORE_PROJECT_CSV);
        return atRef(null);
      },
    );
    vi.mocked(commitFilesToRepo).mockImplementation(async () => ({ newHeadSha: "new-head-sha" }));
  });

  it("rejects the collaborator's own token at every project-repo read; only the installation token succeeds", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: {
        id: 1,
        installation_id: 42,
        github_repo_full_name: "student/my-site",
        github_pages_url: "https://student.github.io/my-site",
      },
      userRole: "collaborator",
    } as never);

    const rejectUnlessInstall = (token: string) => {
      if (token !== "install-token") {
        throw new Error("GitHub 404: repository not found (private repo, collaborator's own token)");
      }
    };
    vi.mocked(getRepoTree).mockImplementation(async (token: string) => {
      rejectUnlessInstall(token);
      return { tree: [], truncated: false };
    });
    vi.mocked(getRepoHead).mockImplementation(async (token: string) => {
      rejectUnlessInstall(token);
      return "head-oid-abc123";
    });
    vi.mocked(getFileAtRef).mockImplementation(
      async (token: string, _o: string, _r: string, path: string) => {
        rejectUnlessInstall(token);
        if (path === "_config.yml") return atRef(BEFORE_CONFIG);
        if (path.endsWith("project.csv")) return atRef(BEFORE_PROJECT_CSV);
        return atRef(null);
      },
    );
    vi.mocked(commitFilesToRepo).mockImplementation(async (token: string) => {
      rejectUnlessInstall(token);
      return { newHeadSha: "new-head-sha" };
    });

    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);

    const res = await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    expect((res as { ok: boolean }).ok).toBe(true);
    expect(commitFilesToRepo).toHaveBeenCalledTimes(1);
  });
});

describe("upgrade action: split commit (workflows held separately)", () => {
  beforeEach(() => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);
  });

  it("splits into two commits: content first (skip ci, no _config.yml), workflows + _config.yml second", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo)
      .mockResolvedValueOnce({ newHeadSha: "content-sha" })
      .mockResolvedValueOnce({ newHeadSha: "workflow-sha" });

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; newHeadSha?: string };

    expect(res.ok).toBe(true);
    expect(commitFilesToRepo).toHaveBeenCalledTimes(2);

    // Commit 1 — content. Positional args:
    // token, owner, repo, branch, additions, msg, body, deletions, skipCi, expectedHeadOid
    const c1 = vi.mocked(commitFilesToRepo).mock.calls[0];
    const c1Paths = (c1[4] as Array<{ path: string }>).map((a) => a.path);
    expect(c1Paths).toContain("_layouts/default.html");
    expect(c1Paths).not.toContain(".github/workflows/build.yml");
    expect(c1Paths).not.toContain("_config.yml");
    expect(c1[8]).toBe(true); // skip ci on the intermediate content commit
    expect(c1[9]).toBe("head-oid-abc123"); // original expectedHeadOid

    // Commit 2 — workflows + the held _config.yml version bump.
    const c2 = vi.mocked(commitFilesToRepo).mock.calls[1];
    const c2Paths = (c2[4] as Array<{ path: string }>).map((a) => a.path);
    expect(c2Paths).toContain(".github/workflows/build.yml");
    expect(c2Paths).toContain("_config.yml");
    expect(c2[8]).toBeFalsy(); // final commit triggers the build
    expect(c2[9]).toBe("content-sha"); // chained onto commit 1's new head

    // Full success → version stamped, head bumped to the final commit.
    expect(configSetCalls).toHaveLength(1);
    expect(configSetCalls[0].telar_version).toBe("1.2.0");
    expect(projectsSetCalls).toHaveLength(1);
    expect(projectsSetCalls[0].head_sha).toBe("workflow-sha");
    expect(res.newHeadSha).toBe("workflow-sha");
    // Commit 2 is chained on commit 1, which is built on the prepared head:
    // both are the Compositor's, so the head advances from the prepared head.
    expect(bumpProjectHeadFrom).toHaveBeenCalledWith(expect.anything(), 1, "head-oid-abc123", "workflow-sha");
  });

  it("keeps the content commit but holds the version bump when the workflow commit is rejected", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo)
      .mockResolvedValueOnce({ newHeadSha: "content-sha" })
      .mockRejectedValueOnce(
        new Error("Resource not accessible by integration"),
      );

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string; reauthUrl?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("insufficient_permissions");
    expect(res.reauthUrl).toContain("/settings/installations/42");
    expect(commitFilesToRepo).toHaveBeenCalledTimes(2);

    // Version is HELD — not stamped — so the re-prompt fires again.
    expect(configSetCalls).toHaveLength(0);
    // The content commit DID land — record its head so D1 doesn't go stale.
    expect(projectsSetCalls).toHaveLength(1);
    expect(projectsSetCalls[0].head_sha).toBe("content-sha");
    expect(bumpProjectHeadFrom).toHaveBeenCalledWith(expect.anything(), 1, "head-oid-abc123", "content-sha");
  });

  it("does not attempt the workflow commit when the content commit fails", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo).mockRejectedValueOnce(
      new StaleHeadError("Expected HEAD to be at a different commit"),
    );

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("stale_head");
    expect(commitFilesToRepo).toHaveBeenCalledTimes(1);
    expect(configSetCalls).toHaveLength(0);
    expect(projectsSetCalls).toHaveLength(0);
  });

  it("uses a single atomic commit when the upgrade touches no workflow files", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());

    await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never);

    expect(commitFilesToRepo).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The workflow commit retries once on a GitHub server error
// ---------------------------------------------------------------------------

/** A 5xx as `graphqlGitHub` raises it — the real class, so `instanceof` decides. */
function transient(status: number): GitHubTransientError {
  return new GitHubTransientError(`GitHub GraphQL error: ${status}`, status);
}

/** The calls that carried the workflow half of the upgrade. */
function workflowCommitCalls() {
  return vi
    .mocked(commitFilesToRepo)
    .mock.calls.filter((call) => String(call[5]).startsWith("Update Telar workflows"));
}

/** The calls that carried the content half. */
function contentCommitCalls() {
  return vi
    .mocked(commitFilesToRepo)
    .mock.calls.filter((call) => !String(call[5]).startsWith("Update Telar workflows"));
}

/** A chain that touches nothing, so the diff alone decides what is committed. */
const EMPTY_CHAIN: Manifest[] = [
  {
    schema_version: 1,
    from_version: "0.9.2-beta",
    to_version: "1.2.0",
    description: "no operations",
    operations: [],
    manual_steps: { en: [], es: [] },
  },
];

/** Only a workflow file changes, so the content commit is skipped entirely. */
function diffWorkflowOnly() {
  return {
    ...emptyDiff(),
    additions: [{ path: ".github/workflows/build.yml", content: "name: build" }],
  };
}

/** A workflow deletion, whose existence probe runs inside the retried call. */
function diffWorkflowDeletion() {
  return {
    ...emptyDiff(),
    additions: [{ path: ".github/workflows/build.yml", content: "name: build" }],
    deletions: [".github/workflows/retired.yml"],
  };
}

describe("upgrade action: the workflow commit's single retry", () => {
  beforeEach(() => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);
  });

  it("retries once after a 503 and succeeds, with the same arguments and not a millisecond before 1,500 ms", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo)
      .mockResolvedValueOnce({ newHeadSha: "content-sha" })
      .mockRejectedValueOnce(transient(503))
      .mockResolvedValueOnce({ newHeadSha: "workflow-sha" });

    vi.useFakeTimers();
    try {
      const pending = action({
        request: buildRequest("upgrade"),
        context: buildContext(),
        params: {},
      } as never) as Promise<{ ok: boolean; newHeadSha?: string }>;

      // The gap is 1,500 ms exactly: nothing at 1,499, the retry at 1,500.
      await vi.advanceTimersByTimeAsync(1499);
      expect(workflowCommitCalls()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(workflowCommitCalls()).toHaveLength(2);

      const res = await pending;

      expect(res.ok).toBe(true);
      expect(res.newHeadSha).toBe("workflow-sha");
      expect(contentCommitCalls()).toHaveLength(1);

      const [first, second] = workflowCommitCalls();
      expect(second).toHaveLength(first.length);
      expect(second).toEqual(first);
      // The expected head is what makes the retry safe — say so explicitly
      // rather than leaving it inside a whole-argument comparison.
      expect(second[9]).toBe("content-sha");
      expect(first[9]).toBe("content-sha");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries on the workflow-only path against the prepared original head, on the same 1,500 ms gap", async () => {
    vi.mocked(loadManifestChain).mockResolvedValue(EMPTY_CHAIN);
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWorkflowOnly());
    vi.mocked(commitFilesToRepo)
      .mockRejectedValueOnce(transient(500))
      .mockResolvedValueOnce({ newHeadSha: "workflow-sha" });

    vi.useFakeTimers();
    try {
      const pending = action({
        request: buildRequest("upgrade"),
        context: buildContext(),
        params: {},
      } as never) as Promise<{ ok: boolean }>;

      await vi.advanceTimersByTimeAsync(1499);
      expect(workflowCommitCalls()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(workflowCommitCalls()).toHaveLength(2);

      const res = await pending;

      expect(res.ok).toBe(true);
      expect(contentCommitCalls()).toHaveLength(0);
      const calls = workflowCommitCalls();
      expect(calls[1]).toEqual(calls[0]);
      // No content commit ran, so the retry's expected head is still the head
      // the prepare captured.
      expect(calls[1][9]).toBe("head-oid-abc123");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a 503 raised while probing the workflow deletions, carrying the same deletion list", async () => {
    vi.mocked(loadManifestChain).mockResolvedValue(EMPTY_CHAIN);
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWorkflowDeletion());
    vi.mocked(commitFilesToRepo)
      .mockRejectedValueOnce(transient(502))
      .mockResolvedValueOnce({ newHeadSha: "workflow-sha" });

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    const calls = workflowCommitCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1][7]).toEqual([".github/workflows/retired.yml"]);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("gives up after one retry: 503 then 503 is upgrade_failed and exactly two workflow attempts", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo)
      .mockResolvedValueOnce({ newHeadSha: "content-sha" })
      .mockRejectedValueOnce(transient(503))
      .mockRejectedValueOnce(transient(503));

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("upgrade_failed");
    expect(workflowCommitCalls()).toHaveLength(2);
    expect(configSetCalls).toHaveLength(0);
  });

  it("classifies the retry's own error: 503 then a permission refusal is insufficient_permissions", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo)
      .mockResolvedValueOnce({ newHeadSha: "content-sha" })
      .mockRejectedValueOnce(transient(503))
      .mockRejectedValueOnce(new Error("Resource not accessible by integration"));

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string; reauthUrl?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("insufficient_permissions");
    expect(res.reauthUrl).toContain("/settings/installations/42");
    expect(workflowCommitCalls()).toHaveLength(2);
  });

  it("classifies a stale head raised by the retry as stale_head", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo)
      .mockResolvedValueOnce({ newHeadSha: "content-sha" })
      .mockRejectedValueOnce(transient(503))
      .mockRejectedValueOnce(new StaleHeadError("Expected HEAD to be at a different commit"));

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("stale_head");
    expect(workflowCommitCalls()).toHaveLength(2);
  });

  it("does not retry the content commit: a 503 there fails the upgrade after one call", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo).mockRejectedValueOnce(transient(503));

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("upgrade_failed");
    expect(commitFilesToRepo).toHaveBeenCalledTimes(1);
    expect(workflowCommitCalls()).toHaveLength(0);
  });

  it("does not retry a stale head on the first workflow attempt", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo)
      .mockResolvedValueOnce({ newHeadSha: "content-sha" })
      .mockRejectedValueOnce(new StaleHeadError("Expected HEAD to be at a different commit"));

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("stale_head");
    expect(workflowCommitCalls()).toHaveLength(1);
  });

  it("does not retry a 4xx", async () => {
    vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWithWorkflow());
    vi.mocked(commitFilesToRepo)
      .mockResolvedValueOnce({ newHeadSha: "content-sha" })
      .mockRejectedValueOnce(new Error("GitHub GraphQL error: 422"));

    const res = (await action({
      request: buildRequest("upgrade"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("upgrade_failed");
    expect(workflowCommitCalls()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The rebuild intent, and the poll that follows the run it was given
// ---------------------------------------------------------------------------

const WORKFLOW_PAGE_URL =
  "https://github.com/student/my-site/actions/workflows/build.yml";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 900,
    name: "Build and deploy Telar site",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/student/my-site/actions/runs/900",
    head_sha: "tip-sha",
    ...overrides,
  };
}

describe("upgrade action: rebuild", () => {
  it("dispatches build.yml for the project's repo on the installation token", async () => {
    vi.mocked(dispatchWorkflow).mockResolvedValue({
      runId: 900,
      runUrl: "https://api.github.com/repos/student/my-site/actions/runs/900",
      htmlUrl: "https://github.com/student/my-site/actions/runs/900",
    });
    vi.mocked(getWorkflowRun).mockResolvedValue(run());

    const res = (await action({
      request: buildRequest("rebuild"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; runId?: number | null; headSha?: string | null; buildUrl?: string };

    expect(res.ok).toBe(true);
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      "install-token",
      "student",
      "my-site",
      "build.yml",
    );
    expect(res.runId).toBe(900);
    expect(res.headSha).toBe("tip-sha");
    expect(res.buildUrl).toBe("https://github.com/student/my-site/actions/runs/900");
  });

  it("falls back to the user token when the installation token cannot be obtained, for the convenor", async () => {
    vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error("jwt refused"));
    vi.mocked(dispatchWorkflow).mockResolvedValue({
      runId: 900,
      runUrl: "",
      htmlUrl: "https://github.com/student/my-site/actions/runs/900",
    });
    vi.mocked(getWorkflowRun).mockResolvedValue(run());

    await action({
      request: buildRequest("rebuild"),
      context: buildContext(),
      params: {},
    } as never);

    expect(dispatchWorkflow).toHaveBeenCalledWith(
      "user-token",
      "student",
      "my-site",
      "build.yml",
    );
  });

  // A collaborator's own token has no write access to the
  // convenor's repository, so a failed mint must not fall back to it — the
  // dispatch never fires, and the action reports rebuild_failed instead of
  // trading a clear failure for a confusing GitHub 403 on the dispatch call.
  it("does NOT fall back to the user token for a collaborator — reports rebuild_failed instead", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValueOnce({
      project: {
        id: 1,
        installation_id: 42,
        github_repo_full_name: "student/my-site",
        github_pages_url: "https://student.github.io/my-site",
      },
      userRole: "collaborator",
    } as never);
    vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error("jwt refused"));

    const res = (await action({
      request: buildRequest("rebuild"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("rebuild_failed");
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("tolerates a 404 on the first read-back of the run GitHub named", async () => {
    vi.mocked(dispatchWorkflow).mockResolvedValue({
      runId: 900,
      runUrl: "",
      htmlUrl: "https://github.com/student/my-site/actions/runs/900",
    });
    vi.mocked(getWorkflowRun)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(run({ head_sha: "settled-sha" }));

    vi.useFakeTimers();
    try {
      const pending = action({
        request: buildRequest("rebuild"),
        context: buildContext(),
        params: {},
      } as never) as Promise<{ runId?: number | null; headSha?: string | null }>;
      await vi.advanceTimersByTimeAsync(1000);
      const res = await pending;

      expect(getWorkflowRun).toHaveBeenCalledTimes(2);
      expect(res.runId).toBe(900);
      expect(res.headSha).toBe("settled-sha");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers unconfirmed on the legacy 204, adopting no run and pointing at the workflow's own page", async () => {
    vi.mocked(dispatchWorkflow).mockResolvedValue({ runId: 0, runUrl: "", htmlUrl: "" });
    // A push landed and someone else dispatched the same workflow: both produce
    // runs a listing would offer, and neither is the run this dispatch started.
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([
      run({ id: 111, head_sha: "pushed-sha" }),
    ]);
    vi.mocked(getWorkflowRun).mockResolvedValue(run({ id: 222, head_sha: "other-dispatch-sha" }));

    const res = (await action({
      request: buildRequest("rebuild"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; runId?: number | null; headSha?: string | null; buildUrl?: string };

    expect(res.ok).toBe(true);
    expect(res.runId).toBeNull();
    expect(res.headSha).toBeNull();
    expect(res.buildUrl).toBe(WORKFLOW_PAGE_URL);
    expect(getWorkflowRun).not.toHaveBeenCalled();
    expect(listWorkflowRunsBySha).not.toHaveBeenCalled();
  });

  it("reads the run back four times, at 0, 1, 2 and 3 seconds, before giving up", async () => {
    vi.mocked(dispatchWorkflow).mockResolvedValue({ runId: 900, runUrl: "", htmlUrl: "" });
    vi.mocked(getWorkflowRun).mockResolvedValue(null);

    vi.useFakeTimers();
    try {
      const pending = action({
        request: buildRequest("rebuild"),
        context: buildContext(),
        params: {},
      } as never) as Promise<{ ok: boolean; runId?: number | null; buildUrl?: string }>;

      await vi.advanceTimersByTimeAsync(0);
      expect(getWorkflowRun).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(getWorkflowRun).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(getWorkflowRun).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1000);
      expect(getWorkflowRun).toHaveBeenCalledTimes(4);

      const res = await pending;

      // A fifth read is never made, and an exhausted lookup is still an
      // accepted dispatch.
      expect(getWorkflowRun).toHaveBeenCalledTimes(4);
      expect(res.ok).toBe(true);
      expect(res.runId).toBeNull();
      expect(res.buildUrl).toBe(WORKFLOW_PAGE_URL);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the dispatch's own URL as buildUrl when the run never appears", async () => {
    vi.mocked(dispatchWorkflow).mockResolvedValue({
      runId: 900,
      runUrl: "",
      htmlUrl: "https://github.com/student/my-site/actions/runs/900",
    });
    vi.mocked(getWorkflowRun).mockResolvedValue(null);

    vi.useFakeTimers();
    try {
      const pending = action({
        request: buildRequest("rebuild"),
        context: buildContext(),
        params: {},
      } as never) as Promise<{ ok: boolean; runId?: number | null; buildUrl?: string }>;
      await vi.advanceTimersByTimeAsync(3000);
      const res = await pending;

      expect(res.ok).toBe(true);
      expect(res.runId).toBeNull();
      // GitHub named a URL even though the run stayed unreadable — that URL is
      // better than the workflow's index page, so it is what the page gets.
      expect(res.buildUrl).toBe("https://github.com/student/my-site/actions/runs/900");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports rebuild_failed only when the dispatch itself failed", async () => {
    vi.mocked(dispatchWorkflow).mockRejectedValue(
      new Error("workflow_dispatch failed (403): forbidden"),
    );

    const res = (await action({
      request: buildRequest("rebuild"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("rebuild_failed");
    expect(getWorkflowRun).not.toHaveBeenCalled();
  });

  it("is gated and project-resolved like upgrade", async () => {
    vi.mocked(requirePublishingRole).mockRejectedValueOnce(new Response("Forbidden", { status: 403 }));

    try {
      await action({ request: buildRequest("rebuild"), context: buildContext(), params: {} } as never);
      expect.fail("expected a 403 Response to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(403);
    }
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });
});

/** The phases a job's steps map to — a marker, so the response can be traced
 *  back to the run whose steps were actually read. */
const SELECTED_PHASES = [
  { id: "setup", label: "Setup", status: "in_progress", conclusion: null },
];

describe("upgrade action: poll-build follows the run it was given", () => {
  beforeEach(() => {
    vi.mocked(getJobSteps).mockResolvedValue([]);
    vi.mocked(mapStepsToBuildPhases).mockReturnValue(SELECTED_PHASES as never);
  });

  it("reports the submitted run when a newer run heads the listing", async () => {
    // GitHub lists newest first, so the run a rebuild left behind can sit
    // ahead of the one being followed — and it is the completed one, which is
    // what would stop the page early.
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([
      run({ id: 111, status: "completed", conclusion: "failure", html_url: "https://newer" }),
      run({ id: 900, status: "in_progress", conclusion: null, html_url: "https://selected" }),
    ]);

    const res = (await action({
      request: buildRequest("poll-build", { sha: "tip-sha", runId: "900" }),
      context: buildContext(),
      params: {},
    } as never)) as {
      runId?: number;
      buildStatus?: string;
      buildConclusion?: string | null;
      buildUrl?: string;
      phases?: unknown;
    };

    expect(res.runId).toBe(900);
    expect(res.buildStatus).toBe("in_progress");
    expect(res.buildConclusion).toBeNull();
    expect(res.buildUrl).toBe("https://selected");
    expect(res.phases).toEqual(SELECTED_PHASES);
    expect(getJobSteps).toHaveBeenCalledWith("install-token", "student", "my-site", 900);
  });

  it("reports the submitted run when an older run heads the listing", async () => {
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([
      run({ id: 42, status: "completed", conclusion: "success", html_url: "https://older" }),
      run({
        id: 900,
        status: "completed",
        conclusion: "failure",
        html_url: "https://selected",
      }),
    ]);

    const res = (await action({
      request: buildRequest("poll-build", { sha: "tip-sha", runId: "900" }),
      context: buildContext(),
      params: {},
    } as never)) as {
      runId?: number;
      buildConclusion?: string | null;
      buildUrl?: string;
      phases?: unknown;
    };

    expect(res.runId).toBe(900);
    // The conclusion is the selected run's, not the first-listed run's.
    expect(res.buildConclusion).toBe("failure");
    expect(res.buildUrl).toBe("https://selected");
    expect(res.phases).toEqual(SELECTED_PHASES);
  });

  it("reads the submitted run by id while the sha listing does not carry it yet", async () => {
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([]);
    vi.mocked(getWorkflowRun).mockResolvedValue(
      run({ id: 900, status: "queued", conclusion: null, html_url: "https://new" }),
    );

    const res = (await action({
      request: buildRequest("poll-build", { sha: "tip-sha", runId: "900" }),
      context: buildContext(),
      params: {},
    } as never)) as {
      runId?: number;
      buildStatus?: string;
      buildConclusion?: string | null;
      phases?: unknown;
    };

    expect(getWorkflowRun).toHaveBeenCalledWith("install-token", "student", "my-site", 900);
    expect(res.runId).toBe(900);
    expect(res.buildStatus).toBe("queued");
    expect(res.buildConclusion).toBeNull();
    expect(res.phases).toEqual(SELECTED_PHASES);
  });

  it("stays pending while neither the listing nor the id lookup finds the run", async () => {
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([]);
    vi.mocked(getWorkflowRun).mockResolvedValue(null);

    const res = (await action({
      request: buildRequest("poll-build", { sha: "tip-sha", runId: "900" }),
      context: buildContext(),
      params: {},
    } as never)) as { buildStatus?: string; runId?: number | null };

    expect(res.buildStatus).toBe("pending");
    expect(res.runId).toBeNull();
  });

  it("keeps the newest-run behaviour when no run id is submitted", async () => {
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([
      run({ id: 111, html_url: "https://newest" }),
      run({ id: 900 }),
    ]);

    const res = (await action({
      request: buildRequest("poll-build", { sha: "tip-sha" }),
      context: buildContext(),
      params: {},
    } as never)) as { runId?: number; phases?: unknown };

    expect(res.runId).toBe(111);
    expect(res.phases).toBeNull();
    expect(getWorkflowRun).not.toHaveBeenCalled();
    expect(getJobSteps).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The freeze lease an upgrade holds
// ---------------------------------------------------------------------------

/** The lease controls the action sent, in order, as the Durable Object would read them. */
function leaseCalls(): unknown[] {
  return vi.mocked(controlFreezeLease).mock.calls.map((call) => call[3]);
}

describe("upgrade action: the freeze lease", () => {
  beforeEach(() => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);
    vi.mocked(getJobSteps).mockResolvedValue([]);
  });

  async function prepare() {
    return (await action({
      request: buildRequest("upgrade-prepare"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; prepared?: { operationId?: string } };
  }

  it("begins on prepare, and signs the lease's id into the prepared state", async () => {
    const res = await prepare();
    expect(res.ok).toBe(true);
    expect(res.prepared?.operationId).toBe("op-test");
    expect(leaseCalls()).toEqual([{ op: "begin", kind: "upgrade", operationId: "op-test" }]);
    expect(vi.mocked(controlFreezeLease).mock.calls[0][2]).toBe(7);
  });

  it("ends as failed when prepare fails", async () => {
    vi.mocked(loadManifestChain).mockRejectedValueOnce(new Error("Missing migration manifest for upgrade path"));
    expect((await prepare()).ok).toBe(false);
    expect(leaseCalls()).toEqual([
      { op: "begin", kind: "upgrade", operationId: "op-test" },
      { op: "end", operationId: "op-test", outcome: "failed" },
    ]);
  });

  it("renews on commit, and ends as failed when the commit fails", async () => {
    const { prepared } = await prepare();
    vi.mocked(controlFreezeLease).mockClear();
    vi.mocked(commitFilesToRepo).mockRejectedValueOnce(new StaleHeadError("moved"));

    const res = (await action({
      request: buildRequest("upgrade-commit", { preparedState: JSON.stringify(prepared) }),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(false);
    expect(leaseCalls()).toEqual([
      { op: "renew", operationId: "op-test" },
      { op: "end", operationId: "op-test", outcome: "failed" },
    ]);
  });

  it("answers a prepared state that is not an object without throwing", async () => {
    const res = (await action({
      request: buildRequest("upgrade-commit", { preparedState: "null" }),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it("ends as succeeded once the commit lands, without waiting on the build", async () => {
    const { prepared } = await prepare();
    vi.mocked(controlFreezeLease).mockClear();
    const res = (await action({
      request: buildRequest("upgrade-commit", { preparedState: JSON.stringify(prepared) }),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(leaseCalls()).toEqual([
      { op: "renew", operationId: "op-test" },
      { op: "end", operationId: "op-test", outcome: "succeeded" },
    ]);
  });

  it("refuses to prepare while another publish or upgrade holds the lock", async () => {
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");
    const res = (await prepare()) as { ok: boolean; error?: string };
    expect(res).toMatchObject({ ok: false, error: "operation_in_progress" });
    expect(computeUpgradeDiff).not.toHaveBeenCalled();
  });

  it("prepares when the lock cannot be asked about", async () => {
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("unavailable");
    expect((await prepare()).ok).toBe(true);
  });

  it("begins its operation again at commit when the lease ran out, and commits", async () => {
    const { prepared } = await prepare();
    vi.mocked(controlFreezeLease).mockClear();
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");
    const res = (await action({
      request: buildRequest("upgrade-commit", { preparedState: JSON.stringify(prepared) }),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(leaseCalls().slice(0, 2)).toEqual([
      { op: "renew", operationId: "op-test" },
      { op: "begin", kind: "upgrade", operationId: "op-test" },
    ]);
  });

  it("does not commit when another operation began after its lease ran out", async () => {
    const { prepared } = await prepare();
    vi.mocked(controlFreezeLease).mockClear();
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused").mockResolvedValueOnce("refused");
    const res = (await action({
      request: buildRequest("upgrade-commit", { preparedState: JSON.stringify(prepared) }),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res).toMatchObject({ ok: false, error: "operation_in_progress" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("has no single-shot upgrade: the intent is unknown and commits nothing", async () => {
    const res = await routeAction({ request: buildRequest("upgrade"), context: buildContext(), params: {} } as never);
    expect(res).toMatchObject({ ok: false, error: "unknown_intent" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(leaseCalls()).toEqual([]);
  });

  it("lets go of a prepared upgrade the author cancels", async () => {
    const { prepared } = await prepare();
    vi.mocked(controlFreezeLease).mockClear();
    const res = await action({
      request: buildRequest("upgrade-cancel", { preparedState: JSON.stringify(prepared) }),
      context: buildContext(),
      params: {},
    } as never);
    expect(res).toMatchObject({ ok: true, intent: "upgrade-cancel" });
    expect(leaseCalls()).toEqual([{ op: "end", operationId: "op-test", outcome: "failed" }]);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("takes no lease for a build poll or a rebuild", async () => {
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([run({ status: "completed", conclusion: "success" })]);
    await action({
      request: buildRequest("poll-build", { sha: "tip-sha", runId: "900" }),
      context: buildContext(),
      params: {},
    } as never);
    vi.mocked(dispatchWorkflow).mockResolvedValue({
      runId: 900,
      runUrl: "https://api.github.com/repos/student/my-site/actions/runs/900",
      htmlUrl: "https://github.com/student/my-site/actions/runs/900",
    });
    vi.mocked(getWorkflowRun).mockResolvedValue(run());
    await action({ request: buildRequest("rebuild"), context: buildContext(), params: {} } as never);
    expect(leaseCalls()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Prepare's reads: pinned to the head, and loud on failure
// ---------------------------------------------------------------------------

describe("upgrade action: prepare's reads", () => {
  const SITE_DEFAULT = vi.mocked(getFileAtRef).getMockImplementation();
  let actual: typeof import("~/lib/upgrade.server");
  beforeAll(async () => {
    actual = await vi.importActual<typeof import("~/lib/upgrade.server")>("~/lib/upgrade.server");
  });

  /** The site's files as prepare's reads answer them; a path not named is absent. */
  function siteFiles(files: Record<string, FileAtRef | string>) {
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
      const file = files[path];
      if (file === undefined) return { status: "absent" };
      return typeof file === "string" ? { status: "ok", content: file } : file;
    });
  }

  /** GitHub as the framework's release reads reach it, by URL; a URL no route names is a 404. */
  function releaseGitHub(routes: Array<[RegExp, () => unknown]>) {
    const fetchMock = vi.fn(async (url: string) => {
      for (const [pattern, answer] of routes) if (pattern.test(url)) return answer();
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const serverError = () => ({ ok: false, status: 500, json: async () => ({}) });
  const content = (text: string) => ok({ encoding: "base64", content: Buffer.from(text).toString("base64") });

  async function prepare(): Promise<{ ok: boolean; error?: string; detail?: unknown; prepared?: unknown }> {
    return (await action({
      request: buildRequest("upgrade-prepare"),
      context: buildContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string; detail?: unknown };
  }

  beforeEach(() => {
    vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
    vi.mocked(computeUpgradeDiff).mockResolvedValue(emptyDiff());
    vi.mocked(loadManifestChain).mockResolvedValue(FULL_CHAIN);
    vi.mocked(getRepoHead).mockResolvedValue("head-oid-abc123");
    __clearManifestCacheForTests();
  });

  afterEach(() => {
    if (SITE_DEFAULT) vi.mocked(getFileAtRef).mockImplementation(SITE_DEFAULT);
    vi.unstubAllGlobals();
  });

  describe("site files", () => {
    it("reads every site file at the head it listed, strictly, and none at the default branch", async () => {
      // A 1.3.0 target reads the preload paths and the built-in pages too.
      vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.3.0"));
      siteFiles({ "_config.yml": BEFORE_CONFIG, "telar-content/spreadsheets/project.csv": BEFORE_PROJECT_CSV });
      releaseGitHub([]);

      const res = await prepare();

      expect(res.ok).toBe(true);
      const reads = vi.mocked(getFileAtRef).mock.calls;
      expect(reads.map((call) => call[3])).toEqual(
        expect.arrayContaining([
          "_config.yml",
          "telar-content/spreadsheets/project.csv",
          "index.md",
          "pages/glossary.md",
          "pages/objects.md",
          "telar-content/texts/pages/about.md",
          "telar-content/texts/pages/acerca.md",
        ]),
      );
      for (const call of reads) {
        expect(call[0]).toBe("install-token");
        expect(call[4]).toBe("head-oid-abc123");
        expect(call[5]).toEqual({ strict: true });
      }
      expect(getFileContent).not.toHaveBeenCalled();
    });

    it("stops on _config.yml answering 500, naming it", async () => {
      siteFiles({ "_config.yml": { status: "error" } });
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "upgrade_file_unreadable", detail: { path: "_config.yml" } });
      expect(commitFilesToRepo).not.toHaveBeenCalled();
    });

    it("stops on _config.yml whose bytes are not valid UTF-8, naming it", async () => {
      siteFiles({ "_config.yml": { status: "ok", content: "telar:\n  version: \"0.9.2-beta\"\n\uFFFD\n", lossy: true } });
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "upgrade_file_not_text", detail: { path: "_config.yml" } });
    });

    it("stops on a v1.3.0 preload path whose bytes are not valid UTF-8, naming it", async () => {
      vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.3.0"));
      siteFiles({
        "_config.yml": BEFORE_CONFIG,
        "telar-content/texts/pages/about.md": { status: "ok", content: "---\ntitle: About\n---\n\uFFFD\n", lossy: true },
      });
      releaseGitHub([]);
      const res = await prepare();
      expect(res).toMatchObject({
        ok: false,
        error: "upgrade_file_not_text",
        detail: { path: "telar-content/texts/pages/about.md" },
      });
      expect(commitFilesToRepo).not.toHaveBeenCalled();
    });

    it("keeps its failure for an absent _config.yml", async () => {
      siteFiles({});
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "upgrade_failed" });
      expect((res as { message?: string }).message).toMatch(/_config\.yml not found/);
    });

    it("stops on a file the manifest names answering 500, naming it", async () => {
      siteFiles({ "_config.yml": BEFORE_CONFIG, "telar-content/spreadsheets/project.csv": { status: "error" } });
      const res = await prepare();
      expect(res).toMatchObject({
        ok: false,
        error: "upgrade_file_unreadable",
        detail: { path: "telar-content/spreadsheets/project.csv" },
      });
    });

    it("stops on a v1.3.0 preload path answering 500, naming it", async () => {
      vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.3.0"));
      siteFiles({ "_config.yml": BEFORE_CONFIG, "telar-content/texts/pages/about.md": { status: "error" } });
      releaseGitHub([]);
      const res = await prepare();
      expect(res).toMatchObject({
        ok: false,
        error: "upgrade_file_unreadable",
        detail: { path: "telar-content/texts/pages/about.md" },
      });
    });

    it("stops on a built-in page answering 500, naming it", async () => {
      // Below 1.3.0 nothing preloads the pages, so the front matter merge reads them.
      siteFiles({ "_config.yml": BEFORE_CONFIG, "pages/objects.md": { status: "error" } });
      releaseGitHub([]);
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "upgrade_file_unreadable", detail: { path: "pages/objects.md" } });
    });

    it("reads a 404 on every site file but _config.yml as absent, and prepares", async () => {
      vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.3.0"));
      siteFiles({ "_config.yml": BEFORE_CONFIG });
      releaseGitHub([]);
      expect((await prepare()).ok).toBe(true);
    });

    it("parses a _config.yml and a project sheet that start with a byte-order mark, and writes both with it", async () => {
      siteFiles({
        "_config.yml": '\uFEFFtelar:\n  version: "0.9.2-beta"\n  release_date: "2026-03-13"\ntelar_language: en\n',
        "telar-content/spreadsheets/project.csv": "\uFEFForder,title,subtitle,private\n1,A,B,",
      });
      releaseGitHub([]);

      const res = await prepare();

      expect(res.ok).toBe(true);
      const additions = (res.prepared as { additions: Array<{ path: string; content: string }> }).additions;
      const committed = new Map(additions.map((a) => [a.path, a.content]));
      expect(committed.get("_config.yml")).toBe(
        '\uFEFFtelar:\n  version: "1.2.0"\n  release_date: "2026-03-01"\ntelar_language: en\ncollection_mode: false  # Set to true for collection-first homepage\n',
      );
      expect(committed.get("telar-content/spreadsheets/project.csv")).toBe(
        "\uFEFForder,title,subtitle,private,show_sections\n1,A,B,,",
      );
    });
  });

  describe("release files", () => {
    it("stops on a truncated release tree, naming the release's version", async () => {
      vi.mocked(computeUpgradeDiff).mockImplementation(actual.computeUpgradeDiff);
      releaseGitHub([[/\/git\/trees\/v1\.2\.0/, () => ok({ tree: [], truncated: true })]]);
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "release_tree_unreadable", detail: { version: "1.2.0" } });
    });

    it("stops on a release tree answering 500, naming the release's version", async () => {
      vi.mocked(computeUpgradeDiff).mockImplementation(actual.computeUpgradeDiff);
      releaseGitHub([[/\/git\/trees\/v1\.2\.0/, serverError]]);
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "release_tree_unreadable", detail: { version: "1.2.0" } });
    });

    it("stops on a release file download answering 500, naming the file", async () => {
      vi.mocked(computeUpgradeDiff).mockImplementation(actual.computeUpgradeDiff);
      const tree = [{ path: "_layouts/default.html", mode: "100644", type: "blob", sha: "sha-new" }];
      releaseGitHub([
        [/\/git\/trees\/v1\.2\.0/, () => ok({ tree, truncated: false })],
        [/\/contents\/_layouts\/default\.html/, serverError],
      ]);
      const res = await prepare();
      expect(res).toMatchObject({
        ok: false,
        error: "release_file_unreadable",
        detail: { path: "_layouts/default.html", version: "1.2.0" },
      });
    });

    it("stops on the dev-only list answering 500, naming it", async () => {
      vi.mocked(computeUpgradeDiff).mockImplementation(actual.computeUpgradeDiff);
      const tree = [{ path: "scripts/dev-only-files.txt", mode: "100644", type: "blob", sha: "sha-list" }];
      releaseGitHub([
        [/\/git\/trees\/v1\.2\.0/, () => ok({ tree, truncated: false })],
        [/\/contents\/scripts\/dev-only-files\.txt/, serverError],
      ]);
      const res = await prepare();
      expect(res).toMatchObject({
        ok: false,
        error: "release_file_unreadable",
        detail: { path: "scripts/dev-only-files.txt", version: "1.2.0" },
      });
    });

    it("stops on a built-in page's release copy answering 500, naming it", async () => {
      siteFiles({ "_config.yml": BEFORE_CONFIG, "pages/glossary.md": "---\nlayout: glossary-index\ntitle: Glossary\n---\n" });
      releaseGitHub([[/\/contents\/pages\/glossary\.md\?ref=v1\.2\.0/, serverError]]);
      const res = await prepare();
      expect(res).toMatchObject({
        ok: false,
        error: "release_file_unreadable",
        detail: { path: "pages/glossary.md", version: "1.2.0" },
      });
      expect(commitFilesToRepo).not.toHaveBeenCalled();
    });

    it("stops on a built-in page's release copy whose read throws, naming it", async () => {
      siteFiles({ "_config.yml": BEFORE_CONFIG, "pages/glossary.md": "---\nlayout: glossary-index\ntitle: Glossary\n---\n" });
      releaseGitHub([
        [
          /\/contents\/pages\/glossary\.md\?ref=v1\.2\.0/,
          () => {
            throw new TypeError("fetch failed");
          },
        ],
      ]);
      const res = await prepare();
      expect(res).toMatchObject({
        ok: false,
        error: "release_file_unreadable",
        detail: { path: "pages/glossary.md", version: "1.2.0" },
      });
    });

    it("reads a 404 on a built-in page's release copy as absent, and prepares", async () => {
      siteFiles({ "_config.yml": BEFORE_CONFIG, "pages/glossary.md": "---\nlayout: glossary-index\ntitle: Glossary\n---\n" });
      releaseGitHub([]);
      expect((await prepare()).ok).toBe(true);
    });
  });

  describe("release discovery", () => {
    // Bundled manifests reach 1.2.0; a 1.3.0 target is found through the releases.
    beforeEach(() => {
      vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.3.0"));
      vi.mocked(loadManifestChain).mockImplementation(actual.loadManifestChain);
    });

    const release = (tag: string) => [
      new RegExp(`/releases/tags/${tag.replace(/\./g, "\\.")}$`),
      () => ok({ assets: [{ name: "migration.json", url: `https://api/asset/${tag}` }] }),
    ] as [RegExp, () => unknown];
    const asset = (tag: string, answer: () => unknown) =>
      [new RegExp(`^https://api/asset/${tag.replace(/\./g, "\\.")}$`), answer] as [RegExp, () => unknown];
    const manifest = (from: string, to: string) => () =>
      ok({ schema_version: 1, from_version: from, to_version: to, description: "", operations: [], manual_steps: { en: [], es: [] } });

    it("stops on a release listing that cannot be read", async () => {
      releaseGitHub([[/\/releases\?per_page=100$/, serverError]]);
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "release_list_unreadable" });
      expect((res as { detail?: unknown }).detail).toBeUndefined();
    });

    it("stops on the target's migration.json answering 500, naming it and its release", async () => {
      releaseGitHub([release("v1.3.0"), asset("v1.3.0", serverError)]);
      const res = await prepare();
      expect(res).toMatchObject({
        ok: false,
        error: "release_file_unreadable",
        detail: { path: "migration.json", version: "1.3.0" },
      });
    });

    it("stops on the target's migration.json that does not validate, naming its release", async () => {
      releaseGitHub([release("v1.3.0"), asset("v1.3.0", () => ok({ schema_version: 1 }))]);
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "release_manifest_invalid", detail: { version: "1.3.0" } });
    });

    it("stops on an intermediate hop's migration.json that does not validate, naming that hop's release", async () => {
      releaseGitHub([
        release("v1.3.0"),
        asset("v1.3.0", manifest("1.2.1", "1.3.0")),
        [/\/releases\?per_page=100$/, () => ok([{ tag_name: "v1.3.0" }, { tag_name: "v1.2.1" }])],
        release("v1.2.1"),
        asset("v1.2.1", () => ok({ schema_version: 1 })),
      ]);
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "release_manifest_invalid", detail: { version: "1.2.1" } });
    });

    it("stops on an intermediate hop's migration.json answering 500, naming it", async () => {
      releaseGitHub([
        release("v1.3.0"),
        asset("v1.3.0", manifest("1.2.1", "1.3.0")),
        [/\/releases\?per_page=100$/, () => ok([{ tag_name: "v1.3.0" }, { tag_name: "v1.2.1" }])],
        release("v1.2.1"),
        asset("v1.2.1", serverError),
      ]);
      const res = await prepare();
      expect(res).toMatchObject({
        ok: false,
        error: "release_file_unreadable",
        detail: { path: "migration.json", version: "1.2.1" },
      });
    });

    it("keeps missing_manifest when no release carries the manifest", async () => {
      releaseGitHub([[/\/releases\?per_page=100$/, () => ok([])]]);
      const res = await prepare();
      expect(res).toMatchObject({ ok: false, error: "missing_manifest" });
    });

    it("prepares through a hop the listing finds", async () => {
      releaseGitHub([
        release("v1.3.0"),
        asset("v1.3.0", manifest("1.2.1", "1.3.0")),
        [/\/releases\?per_page=100$/, () => ok([{ tag_name: "v1.3.0" }, { tag_name: "v1.2.1" }])],
        release("v1.2.1"),
        asset("v1.2.1", manifest("1.2.0", "1.2.1")),
      ]);
      expect((await prepare()).ok).toBe(true);
    });
  });

  describe("the failure's code", () => {
    it("maps each typed read failure thrown past the diff and the chain", async () => {
      vi.mocked(computeUpgradeDiff).mockRejectedValueOnce(new ReleaseFileUnreadableError("_layouts/default.html", "1.2.0"));
      expect(await prepare()).toMatchObject({
        error: "release_file_unreadable",
        detail: { path: "_layouts/default.html", version: "1.2.0" },
      });
      vi.mocked(computeUpgradeDiff).mockRejectedValueOnce(new ReleaseTreeUnreadableError("1.2.0"));
      expect(await prepare()).toMatchObject({ error: "release_tree_unreadable", detail: { version: "1.2.0" } });
      vi.mocked(loadManifestChain).mockRejectedValueOnce(new ReleaseManifestInvalidError("1.2.0"));
      expect(await prepare()).toMatchObject({ error: "release_manifest_invalid", detail: { version: "1.2.0" } });
      vi.mocked(loadManifestChain).mockRejectedValueOnce(new ReleaseListUnreadableError());
      expect(await prepare()).toMatchObject({ error: "release_list_unreadable" });
      vi.mocked(computeUpgradeDiff).mockRejectedValueOnce(new UpgradeFileUnreadableError("_config.yml"));
      expect(await prepare()).toMatchObject({ error: "upgrade_file_unreadable", detail: { path: "_config.yml" } });
      vi.mocked(computeUpgradeDiff).mockRejectedValueOnce(new UpgradeFileNotTextError("_config.yml"));
      expect(await prepare()).toMatchObject({ error: "upgrade_file_not_text", detail: { path: "_config.yml" } });
    });

    it("names a target release GitHub answered with an error status as a release it could not check", async () => {
      vi.mocked(fetchLatestRelease).mockRejectedValueOnce(new ReleaseLookupError(new Response(null, { status: 503 })));
      expect(await prepare()).toMatchObject({ ok: false, error: "release_unknown" });
    });

    it("names a target release whose lookup never reached GitHub as a release it could not check", async () => {
      vi.mocked(fetchLatestRelease).mockRejectedValueOnce(new TypeError("fetch failed"));
      expect(await prepare()).toMatchObject({ ok: false, error: "release_unknown" });
    });
  });

  describe("the tree the review diffs", () => {
    it("recomputes the diff from main's head, not the default branch", async () => {
      vi.mocked(getRepoTree).mockClear();
      const res = (await action({
        request: buildRequest("compute-diff"),
        context: buildContext(),
        params: {},
      } as never)) as { ok: boolean };
      expect(res.ok).toBe(true);
      expect(vi.mocked(getRepoTree).mock.calls.map((call) => call[3])).toEqual(["head-oid-abc123"]);
      expect(getRepoHead).toHaveBeenCalledWith("install-token", expect.any(String), expect.any(String), "main");
    });

    it("loads the review page's diff from main's head, not the default branch", async () => {
      vi.mocked(getRepoTree).mockClear();
      const res = (await loader({
        request: new Request("https://compositor.telar.org/upgrade"),
        context: buildContext(),
        params: {},
      } as never)) as { diff: unknown };
      expect(res.diff).not.toBeNull();
      expect(vi.mocked(getRepoTree).mock.calls.map((call) => call[3])).toEqual(["main"]);
    });

    describe("the deletions the review lists", () => {
      const MANIFEST_DELETES: Manifest = {
        schema_version: 1,
        from_version: "1.1.0",
        to_version: "1.2.0",
        description: "removes dev-only files",
        operations: [
          { type: "file_delete", paths: ["migration.json", "pytest.ini", "tests/test_site.py", "not-in-the-site.txt"] },
        ],
        manual_steps: { en: [], es: [] },
      };
      const blobs = (...paths: string[]): TreeEntry[] =>
        paths.map((path) => ({ path, type: "blob", sha: `sha-${path}`, mode: "100644" }) as TreeEntry);

      function arrange(additions: Array<{ path: string; content: string }>) {
        vi.mocked(fetchLatestRelease).mockResolvedValue(latestRelease("v1.2.0"));
        vi.mocked(loadManifestChain).mockResolvedValue([...FULL_CHAIN, MANIFEST_DELETES]);
        vi.mocked(computeUpgradeDiff).mockResolvedValue({
          ...emptyDiff(),
          additions,
          deletions: ["_layouts/retired.html"],
        });
        vi.mocked(getRepoTree).mockResolvedValue({
          tree: blobs("migration.json", "pytest.ini", "tests/test_site.py", "_layouts/retired.html", "index.md"),
          truncated: false,
        });
      }

      async function review() {
        return (await loader({
          request: new Request("https://compositor.telar.org/upgrade"),
          context: buildContext(),
          params: {},
        } as never)) as {
          diff: { deletions: string[]; additions: Array<{ path: string }>; summary: { deletions: number; total: number } };
          filesByCategory: Record<string, string[]>;
        };
      }

      afterEach(() => {
        vi.mocked(getRepoTree).mockResolvedValue({ tree: [], truncated: false });
      });

      it("lists and counts the set the commit deletes: the manifest's paths the site has, and the tree diff's", async () => {
        arrange([]);
        const page = await review();
        await action({ request: buildRequest("upgrade"), context: buildContext(), params: {} } as never);
        const committed = vi.mocked(commitFilesToRepo).mock.calls[0][7] as string[];

        expect([...committed].sort()).toEqual(
          ["_layouts/retired.html", "migration.json", "pytest.ini", "tests/test_site.py"].sort(),
        );
        expect([...page.diff.deletions].sort()).toEqual([...committed].sort());
        expect([...(page.filesByCategory.deletions ?? [])].sort()).toEqual([...committed].sort());
        expect(page.diff.summary.deletions).toBe(committed.length);
      });

      const SITE_DELETIONS = ["_layouts/retired.html", "migration.json", "pytest.ini", "tests/test_site.py"];

      /** Prepare as the page posts it, with the deletions it listed; the commit follows when prepare is ready. */
      async function prepareListing(deletions: string[]) {
        const prepared = (await action({
          request: buildRequest("upgrade-prepare", { deletions: JSON.stringify(deletions) }),
          context: buildContext(),
          params: {},
        } as never)) as { ok: boolean; error?: string; answer?: string; prepared?: unknown };
        if (!prepared.ok) return prepared;
        await action({
          request: buildRequest("upgrade-commit", { preparedState: JSON.stringify(prepared.prepared) }),
          context: buildContext(),
          params: {},
        } as never);
        return prepared;
      }

      it("refuses, and commits nothing, when the manifest could not be read for the page but prepare reads it and would delete more", async () => {
        arrange([]);
        vi.mocked(loadManifestChain).mockRejectedValueOnce(new Error("transient"));
        const page = await review();
        expect(page.diff.deletions).toEqual(["_layouts/retired.html"]);

        const res = await prepareListing(page.diff.deletions);
        expect(res).toMatchObject({ ok: false, error: "deletions_changed" });
        expect(commitFilesToRepo).not.toHaveBeenCalled();

        const reloaded = await review();
        expect([...reloaded.diff.deletions].sort()).toEqual([...SITE_DELETIONS].sort());
        expect((await prepareListing(reloaded.diff.deletions)).ok).toBe(true);
        expect([...(vi.mocked(commitFilesToRepo).mock.calls[0][7] as string[])].sort()).toEqual([...SITE_DELETIONS].sort());
      });

      it("starts the page's chain at the version D1 holds when the heal of D1 fails, so the page lists what prepare deletes", async () => {
        arrange([]);
        // The repo is ahead of D1 (v0.9.2-beta), and D1 does not take the heal.
        vi.mocked(getFileContent).mockResolvedValueOnce('telar:\n  version: "1.0.0"\n');
        vi.mocked(dbMock.update as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
          throw new Error("D1 unavailable");
        });
        vi.mocked(loadManifestChain).mockImplementation(async (_token, from) =>
          from === "0.9.2-beta" ? [...FULL_CHAIN, MANIFEST_DELETES] : FULL_CHAIN,
        );
        const page = await review();
        expect(vi.mocked(loadManifestChain).mock.calls[0][1]).toBe("0.9.2-beta");

        expect((await prepareListing(page.diff.deletions)).ok).toBe(true);
        const committed = vi.mocked(commitFilesToRepo).mock.calls[0][7] as string[];
        expect([...page.diff.deletions].sort()).toEqual([...committed].sort());
        expect(committed).toContain("pytest.ini");
      });

      it("goes ahead when the page listed more than prepare deletes", async () => {
        arrange([]);
        const res = await prepareListing([...SITE_DELETIONS, "already-gone.txt"]);
        expect(res.ok).toBe(true);
        expect([...(vi.mocked(commitFilesToRepo).mock.calls[0][7] as string[])].sort()).toEqual([...SITE_DELETIONS].sort());
      });

      it("does not count a path the manifest deletes as an addition", async () => {
        arrange([
          { path: "pytest.ini", content: "" },
          { path: "_layouts/default.html", content: "" },
        ]);
        const page = await review();
        expect(page.diff.additions.map((a) => a.path)).toEqual(["_layouts/default.html"]);
        expect(page.diff.summary.total).toBe(1);
        expect(page.filesByCategory.other ?? []).not.toContain("pytest.ini");
      });
    });

    it("reads the review page's _config.yml from main, not the default branch", async () => {
      vi.mocked(getFileContent).mockClear();
      const res = (await loader({
        request: new Request("https://compositor.telar.org/upgrade"),
        context: buildContext(),
        params: {},
      } as never)) as { diff: unknown };
      expect(res.diff).not.toBeNull();
      expect(vi.mocked(getFileContent).mock.calls.map((call) => [call[3], call[4]])).toEqual([["_config.yml", "main"]]);
    });
  });
});

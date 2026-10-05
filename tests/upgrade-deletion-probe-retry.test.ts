/**
 * The upgrade's workflow commit retries a GitHub server error raised by the
 * deletion-existence probe, not only one raised by the commit mutation.
 *
 * The probe is the first of two GraphQL round trips inside commitFilesToRepo: it
 * narrows the deletion list to paths that exist at the expected head, because
 * createCommitOnBranch rejects a whole commit that names an already-absent path.
 * A 5xx there is GitHub stumbling exactly as a 5xx on the mutation is, and the
 * retry covers the call as a whole, so both round trips happen again.
 *
 * The rest of the action's dependencies are stubbed, but commit.server.ts is
 * the real module here and so is the GraphQL transport underneath it: the
 * failure is produced as an HTTP 503 on the probe request, which is the only
 * way to show that the class travels from the probe out through
 * commitFilesToRepo to the retry that reads it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Manifest } from "~/lib/manifest-schema.server";

// ---------------------------------------------------------------------------
// Mocks — everything except commit.server.ts and the GraphQL transport
// ---------------------------------------------------------------------------

vi.mock("~/lib/db.server", () => ({ getDb: () => dbMock }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
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
vi.mock("~/lib/github-status.server", () => ({
  bumpProjectHeadFrom: vi.fn(async () => true),
  // The commit checks its prepared target against the latest release.
  readLatestTag: async () => ({ ok: true, tag: "v1.2.0" }),
}));
vi.mock("~/lib/manifest-runner.server", () => ({
  applyManifestChain: (_chain: unknown, files: Map<string, string>) => ({
    files,
    deletions: [],
    manualSteps: { en: [], es: [] },
  }),
}));
vi.mock("~/lib/v130-ingest.server", async () => ({
  ...(await vi.importActual<typeof import("~/lib/v130-ingest.server")>("~/lib/v130-ingest.server")),
  applyV130Transforms: async (files: Map<string, string>) => ({ files, changes: [] }),
}));

// graphqlGitHub and GitHubTransientError stay real: the probe's 503 has to
// become the typed error through the transport, not through a stub.
vi.mock("~/lib/github.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/github.server")>(
    "~/lib/github.server",
  );
  return {
    ...actual,
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getRepoHead: vi.fn(async () => "head-oid-abc123"),
    getFileContent: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      path === "_config.yml" ? 'telar:\n  version: "0.9.2-beta"\n' : null,
    ),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      path === "_config.yml" ? { status: "ok" as const, content: 'telar:\n  version: "0.9.2-beta"\n' } : { status: "absent" as const },
    ),
  };
});

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
    updateTelarVersionInConfig: (content: string) => content,
  };
});

// This file's retry-timing tests are independent of prepared-state signing
// itself, which has its own dedicated, unmocked test coverage elsewhere.
// _app.upgrade.tsx imports signInternalMarker/verifyInternalMarker from
// "../../workers/auth" (app/routes/ -> root/workers), reached from here via
// "../workers/auth" — same relative-path convention the publish action tests
// use. verifyInternalMarker resolves to `null`, its own "signature is valid"
// return value.
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "test-sig", timestamp: Math.floor(Date.now() / 1000) })),
  verifyInternalMarker: vi.fn(async () => null),
}));

// hashPreparedUpgradeContent (local to _app.upgrade.tsx) calls the real
// crypto.subtle.digest directly. Real WebCrypto does not reliably resolve
// under vi.useFakeTimers() + advanceTimersByTimeAsync once it sits behind the
// long await chain runUpgradePrepare runs first — this stub keeps that out of
// tests that only care about the deletion-probe retry.
vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));

const dbMock = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => [{ telar_version: "0.9.2-beta" }] }) }),
  }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
};

import { action } from "~/routes/_app.upgrade";
import {
  fetchLatestRelease,
  computeUpgradeDiff,
  loadManifestChain,
} from "~/lib/upgrade.server";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const DELETED_PATH = ".github/workflows/retired.yml";

/** No operations, so the diff alone decides what the commit carries. */
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

/** Workflow files only, one of them a deletion, so the commit is the workflow
 *  commit and it runs a deletion probe first. */
function diffWorkflowDeletion() {
  return {
    additions: [{ path: ".github/workflows/build.yml", content: "name: build" }],
    deletions: [DELETED_PATH],
    summary: {
      layouts: 0,
      includes: 0,
      stylesheets: 0,
      scripts: 0,
      workflows: 1,
      dataFiles: 0,
      other: 0,
      deletions: 1,
      total: 1,
    },
  };
}

function buildRequest(intent: string, fields: Record<string, string> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  // Every intent is refused unless the posted siteId matches the session's
  // active project (id 1, per the resolveActiveProject mock above).
  form.set("siteId", "1");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("https://compositor.telar.org/upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext() {
  return {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
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

/** The commit request for the upgrade prepare answers, prepared before the fetch under test is armed. */
async function commitRequest(): Promise<Request> {
  const res = (await action({ request: buildRequest("upgrade-prepare"), context: buildContext(), params: {} } as never)) as {
    prepared: unknown;
  };
  return buildRequest("upgrade-commit", { preparedState: JSON.stringify(res.prepared) });
}

/** The GraphQL operation a recorded request carried. */
function operationOf(call: [string, RequestInit]): string {
  const body = JSON.parse(String(call[1].body)) as { query: string };
  if (body.query.includes("CheckPaths")) return "probe";
  if (body.query.includes("CreateCommit")) return "commit";
  return "other";
}

/** The deletion paths a recorded CreateCommit request asked for. */
function deletionsOf(call: [string, RequestInit]): string[] {
  const body = JSON.parse(String(call[1].body)) as {
    variables: { input: { fileChanges: { deletions?: Array<{ path: string }> } } };
  };
  return (body.variables.input.fileChanges.deletions ?? []).map((d) => d.path);
}

const PROBE_OK = { data: { repository: { p0: { __typename: "Blob" } } } };
const COMMIT_OK = {
  data: {
    createCommitOnBranch: {
      commit: { oid: "workflow-sha", url: "https://github.com/student/my-site/commit/wf" },
    },
  },
};

/** A GraphQL endpoint that answers 503 to the first `failures` requests. */
function graphqlFetchFailingFirst(failures: number) {
  const answers = [PROBE_OK, COMMIT_OK];
  let served = 0;
  let call = 0;
  return vi.fn().mockImplementation(async () => {
    call += 1;
    if (call <= failures) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    }
    const body = answers[served];
    served += 1;
    return { ok: true, status: 200, json: async () => body };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchLatestRelease).mockResolvedValue({
    tagName: "v1.2.0",
    body: "Release notes",
    publishedAt: "2026-03-01T00:00:00Z",
  });
  vi.mocked(computeUpgradeDiff).mockResolvedValue(diffWorkflowDeletion());
  vi.mocked(loadManifestChain).mockResolvedValue(EMPTY_CHAIN);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upgrade action: a 5xx from the deletion probe is retried", () => {
  it("repeats the whole call — probe and mutation — and succeeds", async () => {
    const request = await commitRequest();
    globalThis.fetch = graphqlFetchFailingFirst(1);

    vi.useFakeTimers();
    try {
      const pending = action({
        request,
        context: buildContext(),
        params: {},
      } as never) as Promise<{ ok: boolean; newHeadSha?: string }>;

      // The probe was the failure, and nothing is retried before 1,500 ms.
      await vi.advanceTimersByTimeAsync(1499);
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, RequestInit]
      >;
      expect(calls.map(operationOf)).toEqual(["probe"]);

      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;

      expect(res.ok).toBe(true);
      expect(res.newHeadSha).toBe("workflow-sha");

      const after = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, RequestInit]
      >;
      // The retry re-ran the probe as well as the mutation: the deletion list
      // has to be narrowed against the head the commit will actually name.
      expect(after.map(operationOf)).toEqual(["probe", "probe", "commit"]);
      expect(deletionsOf(after[2])).toEqual([DELETED_PATH]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up when the probe fails twice", async () => {
    const request = await commitRequest();
    globalThis.fetch = graphqlFetchFailingFirst(2);

    vi.useFakeTimers();
    try {
      const pending = action({
        request,
        context: buildContext(),
        params: {},
      } as never) as Promise<{ ok: boolean; error?: string }>;
      await vi.advanceTimersByTimeAsync(1500);
      const res = await pending;

      expect(res.ok).toBe(false);
      expect(res.error).toBe("upgrade_failed");
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, RequestInit]
      >;
      expect(calls.map(operationOf)).toEqual(["probe", "probe"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

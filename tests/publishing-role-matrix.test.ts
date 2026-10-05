/**
 * The role matrix for publish, image upload, and upgrade.
 *
 * Before this change all three commit under the acting user's own GitHub
 * token, which only a convenor's token can write with — so a convenor-only
 * gate and a token that would fail at GitHub were two independent guards.
 * After this change the three actions commit under the GitHub App
 * installation token, which every project has regardless of who acts, so
 * the membership gate is the only guard left standing.
 *
 * This file pins that gate as an explicit membership test of
 * `{convenor, collaborator, instructor}` — never `role !== null` — against
 * each of the four callers a request can present (convenor, collaborator,
 * instructor, non-member) and each of the three actions. Each role is
 * asserted directly, never inferred from another role passing.
 *
 * tests/publishing-role.test.ts unit-tests the real
 * `isPublishingRole` / `requirePublishingRole` from `~/lib/membership.server`
 * against a fake `getUserRole` query, including an unrecognised future role
 * — it has to live in its own file because it needs the real
 * implementation, and this file mocks that module for the route-level
 * parts below.
 *
 * Parts 1 and 2 here exercise the publish and upgrade routes with a
 * `requirePublishingRole` mock that mirrors the real membership test
 * exactly (mirrors it, does not import it, so a route accidentally wired to
 * a DIFFERENT gate would still be caught). Both routes gate the WHOLE
 * action ahead of the intent switch, and a refusal THROWS a bare 403
 * Response rather than returning `{ok:false}` — so an allowed role is
 * proven by the call reaching real (here: deliberately failing) business
 * logic rather than by an ok:true this file would otherwise have to fake.
 *
 * Part 3 covers the object-write route (`upload-image` in
 * `_app.objects.tsx`) — its gate is inline, so this exercises the real
 * production check directly, the same way tests/upload-image-hardening.test.ts
 * and tests/objects-action-resolution.test.ts already do (this file adds
 * the three actions together as one matrix).
 *
 * Part 1 also pins the commit body naming the publisher (publish); Part 2
 * pins the dispatch-token fallback refusing a collaborator a useless
 * credential (upgrade's rebuild) is pinned again, against a fuller
 * harness, in tests/upgrade.action.test.ts.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testGithubAppPrivateKey, installGithubAppFetchStub } from "./helpers/github-app-fetch";

/** Asserts `promise` rejects with a 403 Response, checking the status itself
 *  rather than only that some Response was thrown. */
async function expectForbidden(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    expect.fail("expected a 403 Response to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(403);
  }
}

// ===========================================================================
// Shared membership.server mock for the route-level parts below.
// One `vi.mock` factory per module path per file — every route section
// reads/writes the same `roleState.role`.
// ===========================================================================

const roleState = vi.hoisted(() => ({ role: "convenor" as string | null }));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })),
  })),
}));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
// ~/lib/github-app.server is left entirely unmocked: resolveProjectToken and
// getInstallationToken run for real, against a throwaway RSA key, with only
// the network boundary (fetch) stubbed below — see
// tests/helpers/github-app-fetch.ts for why a mock of getInstallationToken
// itself cannot intercept resolveProjectToken's internal call to it, and
// why this route-level suite instead needs the real fallback logic to run.
beforeEach(() => {
  installGithubAppFetchStub();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// Mirrors the real two-role test (Part 1 tests the real implementation)
// rather than importing it, so a route wired to a DIFFERENT gate would
// still fail this file.
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () =>
    roleState.role === null
      ? null
      : {
          project: {
            id: 7,
            github_repo_full_name: "owner/repo",
            installation_id: 55,
            publish_snapshot: null,
            // The recorded head, the one the repository is at: a publish
            // commits only on it.
            head_sha: "head-oid",
          },
          userRole: roleState.role,
        },
  ),
  requirePublishingRole: vi.fn(async () => {
    if (
      roleState.role !== "convenor" &&
      roleState.role !== "collaborator" &&
      roleState.role !== "instructor"
    ) {
      throw new Response("Forbidden", { status: 403 });
    }
  }),
}));

// One github.server mock, shared by all three route sections below, so a
// test in any of them can assert which token (installation vs. the
// collaborator's own) a project-repo read actually travelled on.
const { getRepoTree, getRepoHead, getFileContent, getFileAtRef } = vi.hoisted(() => ({
  getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
  getRepoHead: vi.fn(async () => "head-oid"),
  getFileContent: vi.fn(async () => null as string | null),
  getFileAtRef: vi.fn(async () => ({ status: "ok" as const, content: "" })),
}));
// The operation lock is granted: these cases are about what the
// action does once it holds it.
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "op-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoTree,
  getRepoHead,
  getFileContent,
  getFileAtRef,
  githubHeaders: vi.fn(() => ({})),
  GitHubTransientError: class GitHubTransientError extends Error {},
}));vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));


// ===========================================================================
// Part 1 — publish route
// ===========================================================================

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve([]), chain);
      chain.limit = () => Promise.resolve([]);
      chain.orderBy = () => Promise.resolve([]);
      return chain;
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  })),
}));
vi.mock("~/lib/upgrade.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/upgrade.server")>()),
  healMissingFrameworkFiles: vi.fn(async () => []),
  // upgrade-prepare (Part 3) reaches this before anything else network-bound;
  // rejecting it deterministically keeps that section's "admitted past the
  // gate" cases fast and offline, without pretending the full pipeline ran.
  fetchLatestRelease: vi.fn(async () => {
    throw new Error("not exercised by this file — see tests/upgrade.action.test.ts");
  }),
  fetchAllReleases: vi.fn(),
  computeUpgradeDiff: vi.fn(),
  loadManifestChain: vi.fn(),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  dispatchWorkflow: vi.fn(async () => ({ runId: 1, htmlUrl: "https://gh/run/1" })),
  getWorkflowRun: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet: vi.fn(async () => []) };
});

import { action as publishAction } from "~/routes/_app.publish";
import { commitFilesToRepo, listWorkflowRunsBySha } from "~/lib/commit.server";

type DOFetch = (request: Request) => Promise<Response>;
const publishSnapshotOk: DOFetch = async () => new Response("OK", { status: 200 });

function publishContext(user: Record<string, unknown> = { id: 1, encrypted_access_token: "x", github_login: "u" }) {
  const doStub = { fetch: publishSnapshotOk };
  const COLLABORATION = { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => doStub) };
  return {
    get: vi.fn(() => user),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION,
        GITHUB_APP_ID: "app-id",
        GITHUB_PRIVATE_KEY: testGithubAppPrivateKey(),
      },
    },
  } as unknown as Parameters<typeof publishAction>[0]["context"];
}

function publishRequest(): Request {
  const form = new FormData();
  form.set("intent", "publish");
  // siteId matches the mocked resolveActiveProject's project id (7), which
  // resolvePageProject's page-site gate compares it against.
  form.set("siteId", "7");
  return new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } });
}

describe("publish route — role matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("convenor is admitted past the gate (publishes)", async () => {
    roleState.role = "convenor";
    const res = (await publishAction({
      request: publishRequest(),
      context: publishContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(true);
  });

  it("collaborator is admitted past the gate (publishes)", async () => {
    roleState.role = "collaborator";
    const res = (await publishAction({
      request: publishRequest(),
      context: publishContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(true);
  });

  it("instructor is admitted past the gate (publishes)", async () => {
    roleState.role = "instructor";
    const res = (await publishAction({
      request: publishRequest(),
      context: publishContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(true);
  });

  it("an unrecognised future role is refused — the gate throws a bare 403 Response, not a quiet ok:false", async () => {
    roleState.role = "editor";
    await expectForbidden(
      publishAction({ request: publishRequest(), context: publishContext(), params: {} } as never),
    );
  });

  it("non-member (no active project) -> no_project, never reaches the role gate", async () => {
    roleState.role = null;
    const res = (await publishAction({
      request: publishRequest(),
      context: publishContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_project");
  });
});

describe("publish route — commit body names the publisher (GitHub login only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roleState.role = "collaborator";
  });

  it("carries the publisher's GitHub login in the commit body under the App's installation token", async () => {
    await publishAction({
      request: publishRequest(),
      context: publishContext({
        id: 1,
        encrypted_access_token: "x",
        github_login: "collab-login",
        github_name: "Collab Name",
      }),
      params: {},
    } as never);

    expect(commitFilesToRepo).toHaveBeenCalled();
    const call = vi.mocked(commitFilesToRepo).mock.calls[0];
    // (token, owner, repo, branch, files, message, messageBody, ...)
    expect(call[0]).toBe("install-token"); // installation token, not the collaborator's own
    const messageBody = call[6] as string;
    expect(messageBody).toBe("Published by @collab-login");
  });

  // github_name is free text with no character-set guarantee — unlike a
  // GitHub login (alphanumerics and single dashes only), it could suppress
  // the push-triggered build ("[skip ci]", which GitHub honours in commit
  // messages) or inject extra paragraphs via a newline. It must never reach
  // the commit body.
  it("never uses github_name, even one holding a skip directive and a newline", async () => {
    await publishAction({
      request: publishRequest(),
      context: publishContext({
        id: 1,
        encrypted_access_token: "x",
        github_login: "collab-login",
        github_name: "Alice [skip ci]\nSecond paragraph",
      }),
      params: {},
    } as never);

    const call = vi.mocked(commitFilesToRepo).mock.calls[0];
    const messageBody = call[6] as string;
    expect(messageBody).not.toContain("[skip ci]");
    expect(messageBody).not.toContain("\n");
    expect(messageBody).not.toContain("Alice");
    expect(messageBody).toBe("Published by @collab-login");
  });

  it("uses the GitHub login even when the account has no display name at all", async () => {
    await publishAction({
      request: publishRequest(),
      context: publishContext({ id: 1, encrypted_access_token: "x", github_login: "collab-login" }),
      params: {},
    } as never);

    const call = vi.mocked(commitFilesToRepo).mock.calls[0];
    expect(call[6] as string).toBe("Published by @collab-login");
  });
});

describe("publish route — project-repo reads run under the installation token for a collaborator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roleState.role = "collaborator";
  });

  function runValidationRequest(): Request {
    const form = new FormData();
    form.set("intent", "run-validation");
    form.set("siteId", "7");
    return new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } });
  }

  it("run-validation's getRepoHead runs on the installation token, not the collaborator's own", async () => {
    const res = (await publishAction({
      request: runValidationRequest(),
      context: publishContext(),
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(getRepoHead).toHaveBeenCalledWith("install-token", "owner", "repo");
  });
});

// ===========================================================================
// Part 2 — upgrade route
// ===========================================================================

import { action as upgradeAction } from "~/routes/_app.upgrade";

function upgradeContext(user: Record<string, unknown> = { id: 1, encrypted_access_token: "x", github_login: "u" }) {
  return {
    get: vi.fn(() => user),
    cloudflare: {
      env: { DB: {}, SESSION_SECRET: "s", ENCRYPTION_KEY: "k", GITHUB_APP_ID: "app-id", GITHUB_PRIVATE_KEY: testGithubAppPrivateKey() },
    },
  } as unknown as Parameters<typeof upgradeAction>[0]["context"];
}

function upgradePrepareRequest(): Request {
  const form = new FormData();
  form.set("intent", "upgrade-prepare");
  // siteId matches the mocked resolveActiveProject's project id (7), which
  // resolvePageProject's page-site gate compares it against.
  form.set("siteId", "7");
  return new Request("https://app/upgrade", { method: "POST", body: form, headers: { Cookie: "" } });
}

describe("upgrade route — role matrix (gate applies uniformly to every intent; exercised via upgrade-prepare)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("convenor is admitted past the gate (reaches real — here deliberately failing — business logic)", async () => {
    roleState.role = "convenor";
    const res = (await upgradeAction({
      request: upgradePrepareRequest(),
      context: upgradeContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    // fetchLatestRelease is stubbed to throw (see the upgrade.server mock
    // above), which prepare reports as a release it could not look up;
    // reaching that failure, rather than the gate's 403, is what proves the
    // role was admitted.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("release_unknown");
  });

  it("collaborator is admitted past the gate (reaches real — here deliberately failing — business logic)", async () => {
    roleState.role = "collaborator";
    const res = (await upgradeAction({
      request: upgradePrepareRequest(),
      context: upgradeContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("release_unknown");
  });

  it("instructor is admitted past the gate (reaches real — here deliberately failing — business logic)", async () => {
    roleState.role = "instructor";
    const res = (await upgradeAction({
      request: upgradePrepareRequest(),
      context: upgradeContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("release_unknown");
  });

  it("an unrecognised future role is refused — the gate throws a bare 403 Response, not a quiet ok:false", async () => {
    roleState.role = "editor";
    await expectForbidden(
      upgradeAction({ request: upgradePrepareRequest(), context: upgradeContext(), params: {} } as never),
    );
  });

  it("non-member (no active project) -> no_project, never reaches the role gate", async () => {
    roleState.role = null;
    const res = (await upgradeAction({
      request: upgradePrepareRequest(),
      context: upgradeContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_project");
  });
});

describe("upgrade route — project-repo reads run under the installation token for a collaborator", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    roleState.role = "collaborator";
    // Let fetchLatestRelease succeed (it stays on the user token — a
    // separate, public repo, see app/routes/_app.upgrade.tsx) so execution
    // reaches the project's own repo tree read this test is about.
    const { fetchLatestRelease } = await import("~/lib/upgrade.server");
    vi.mocked(fetchLatestRelease).mockResolvedValueOnce({
      tagName: "v1.6.2",
      body: "",
      publishedAt: "2026-01-01T00:00:00Z",
    } as never);
  });

  it("upgrade-prepare's getRepoTree runs on the installation token, not the collaborator's own", async () => {
    const res = (await upgradeAction({
      request: upgradePrepareRequest(),
      context: upgradeContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };

    // fetchLatestRelease succeeded this time, so a failure past this point
    // would be from something else in the pipeline — not the gate, and not
    // the read this test is pinning.
    // The fourth argument is the head the upgrade commits on.
    expect(getRepoTree).toHaveBeenCalledWith("install-token", "owner", "repo", "head-oid");
    void res;
  });
});

// ===========================================================================
// Part 3 — object-write route (_app.objects.tsx: upload-image)
// ===========================================================================
//
// The gate here is inline (`isPublishingRole(resolvedX.userRole)`, from
// `~/lib/publishing-roles`), so this drives the REAL production check
// directly through the shared `resolveActiveProject` mock above — no
// mirrored gate needed. This is the matrix view; tests/upload-image-hardening.test.ts
// and tests/objects-action-resolution.test.ts pin the same behaviour with
// fuller harnesses.

vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
// The version gate (readRepoWriteGate) runs for real. These databases record
// no site version, which it reads as current without a lookup, so what these
// cases pin is a write the gate does not stop; the lookup answers a failure
// so that a site version reaching it here would refuse loudly.
// headAdvancedFrom is the real one: it only builds the publish's head write.
vi.mock("~/lib/github-status.server", async (orig) => ({
  headAdvancedFrom: ((await orig()) as typeof import("~/lib/github-status.server")).headAdvancedFrom,
  objectsReadAdvancedFrom: ((await orig()) as typeof import("~/lib/github-status.server")).objectsReadAdvancedFrom,
  bumpProjectHeadFrom: vi.fn(async () => true),
  bumpObjectsReadFrom: vi.fn(async () => true),
  getCachedLatestTag: vi.fn(async () => null),
  readLatestTag: vi.fn(async () => ({ ok: false })),
}));
vi.mock("~/lib/sync.server", () => ({ computeSyncDiff: vi.fn(), applySyncChanges: vi.fn() }));
// Spread the real module: the publish route in Part 1 reaches the pre-publish
// validator, which reads this module's own column list and extras rule, and a
// factory listing only what the objects route calls leaves those undefined.
vi.mock("~/lib/csv-export.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    serializeObjectsCsv: vi.fn(() => "csv-content"),
    dbObjectToCsvRow: vi.fn((o: unknown) => o),
  };
});
vi.mock("~/lib/upload.server", () => ({
  createImageBlobs: vi.fn(async () => []),
  commitMultipleBinaryFilesWithCsv: vi.fn(async () => ({ newHeadSha: "new-sha" })),
  arrayBufferToBase64: vi.fn(() => "base64data"),
  validateUploadFile: vi.fn(() => null),
}));
vi.mock("~/lib/slugify", () => ({
  generateUniqueObjectSlug: vi.fn(async (slug: string) => slug),
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), findYMapByIdOrTempId: vi.fn() }));

import { action as objectsAction } from "~/routes/_app.objects";

function objectsContext(userId = 7) {
  const user = { id: userId, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    GITHUB_APP_ID: "app-id",
    GITHUB_PRIVATE_KEY: testGithubAppPrivateKey(),
  };
  return {
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof objectsAction>[0]["context"],
  };
}

function uploadImageRequest(): Request {
  const form = new FormData();
  form.set("intent", "upload-image");
  // siteId matches the mocked resolveActiveProject's project id (7), which
  // resolvePageProject's page-site gate compares it against.
  form.set("siteId", "7");
  form.append(
    "imageFile",
    new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", { type: "image/jpeg" }),
  );
  form.set(
    "metadataArray",
    JSON.stringify([
      {
        objectId: "x",
        title: "A Title",
        creator: "",
        description: "",
        source: "",
        credit: "",
        period: "",
        year: "",
        altText: "",
      },
    ]),
  );
  return new Request("https://compositor.telar.org/objects", { method: "POST", body: form });
}

describe("upload-image route — role matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["convenor", true],
    ["collaborator", true],
    ["instructor", true],
    ["editor", false], // a role that does not exist yet — refused, not admitted
  ] as const)("role=%s -> ok=%s", async (role, expectedOk) => {
    roleState.role = role;
    const { context } = objectsContext();
    const res = (await objectsAction({
      request: uploadImageRequest(),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(expectedOk);
    if (!expectedOk) expect(res.error).toBe("forbidden");
  });

  it("non-member (no active project) -> no_project", async () => {
    roleState.role = null;
    const { context } = objectsContext();
    const res = (await objectsAction({
      request: uploadImageRequest(),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_project");
  });
});

describe("upload-image route — reads run under the installation token for a collaborator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roleState.role = "collaborator";
  });

  it("the objects.csv read runs on the installation token, not the collaborator's own", async () => {
    const { context } = objectsContext();
    const res = (await objectsAction({
      request: uploadImageRequest(),
      context,
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(getFileAtRef).toHaveBeenCalledWith(
      "install-token",
      "owner",
      "repo",
      "telar-content/spreadsheets/objects.csv",
      "head-oid",
      { strict: true },
    );
  });
});

describe("upload-image route — the installation-token-mint fallback refuses a collaborator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("convenor: a failed mint falls back to the convenor's own token and the upload still succeeds", async () => {
    roleState.role = "convenor";
    installGithubAppFetchStub({ mintToken: null });

    const { context } = objectsContext();
    const res = (await objectsAction({
      request: uploadImageRequest(),
      context,
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(getFileAtRef).toHaveBeenCalledWith(
      "tok",
      "owner",
      "repo",
      "telar-content/spreadsheets/objects.csv",
      "head-oid",
      { strict: true },
    );
  });

  it("collaborator: a failed mint does NOT fall back to the collaborator's own token — the upload fails instead", async () => {
    roleState.role = "collaborator";
    installGithubAppFetchStub({ mintToken: null });

    const { context } = objectsContext();
    const res = (await objectsAction({
      request: uploadImageRequest(),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("upload_failed");
    // Never reached a write attempt with a token that would only fail at GitHub.
    expect(getFileContent).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// End-to-end private-repo collaborator
// ===========================================================================
//
// A collaborator's own GitHub OAuth token grants nothing beyond their own
// GitHub access — on a private repo they are not a GitHub collaborator on,
// GitHub refuses it outright. Rather than mock that distinction away, every
// project-repo-facing dependency below is made to reject any token except
// "install-token" (this file's crypto.server mock decrypts the collaborator's
// own token to the literal string "tok"), so a single wrongly-routed call
// fails the whole sequence instead of passing by coincidence.

describe("end-to-end: a collaborator on a private repo — upload, poll, commit, publish all complete", () => {
  function rejectUnlessInstall(token: string) {
    if (token !== "install-token") {
      throw new Error("GitHub 404: repository not found (private repo, collaborator's own token)");
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    roleState.role = "collaborator";
    installGithubAppFetchStub();

    getFileContent.mockImplementation(async (...args: unknown[]) => {
      rejectUnlessInstall(args[0] as string);
      return null;
    });
    getRepoTree.mockImplementation(async (...args: unknown[]) => {
      rejectUnlessInstall(args[0] as string);
      return { tree: [], truncated: false };
    });
    getRepoHead.mockImplementation(async (...args: unknown[]) => {
      rejectUnlessInstall(args[0] as string);
      return "head-oid";
    });
    getFileAtRef.mockImplementation(async (...args: unknown[]) => {
      rejectUnlessInstall(args[0] as string);
      return { status: "ok" as const, content: "" };
    });
    vi.mocked(listWorkflowRunsBySha).mockImplementation(async (token: string) => {
      rejectUnlessInstall(token);
      return [
        {
          id: 900,
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/owner/repo/actions/runs/900",
          head_sha: "commit-sha",
        },
      ] as never;
    });
    vi.mocked(commitFilesToRepo).mockImplementation(async (token: string) => {
      rejectUnlessInstall(token);
      return { newHeadSha: "new-sha" };
    });
  });

  it("upload-image commits, poll-build reaches success, commit-objects commits, and publish completes — all under the installation token", async () => {
    const { context: objectsCtx } = objectsContext();

    const uploadRes = (await objectsAction({
      request: uploadImageRequest(),
      context: objectsCtx,
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(uploadRes.ok).toBe(true);

    const pollForm = new FormData();
    pollForm.set("intent", "poll-build");
    pollForm.set("sha", "commit-sha");
    pollForm.set("siteId", "7");
    const pollRes = (await objectsAction({
      request: new Request("https://compositor.telar.org/objects", { method: "POST", body: pollForm }),
      context: objectsCtx,
      params: {},
    } as never)) as { ok: boolean; buildStatus?: string; buildConclusion?: string | null };
    expect(pollRes.ok).toBe(true);
    expect(pollRes.buildStatus).toBe("completed");
    expect(pollRes.buildConclusion).toBe("success");

    const commitForm = new FormData();
    commitForm.set("intent", "commit-objects");
    commitForm.set("pendingObjects", "[]");
    commitForm.set("siteId", "7");
    const commitRes = (await objectsAction({
      request: new Request("https://compositor.telar.org/objects", { method: "POST", body: commitForm }),
      context: objectsCtx,
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(commitRes.ok).toBe(true);

    const publishRes = (await publishAction({
      request: publishRequest(),
      context: publishContext(),
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(publishRes.ok).toBe(true);
  });
});

/**
 * The `repair-build-workflow` intent is a thin seam: it builds the repair's
 * dependencies from the project row and the environment, and maps the repair's
 * result onto the page's action data.
 *
 * Only `intent` comes from the client. Every other input — owner, repo,
 * installation, the recorded head, the App credentials — is derived
 * server-side, so a hand-made POST cannot aim the commit anywhere.
 *
 * The harness is the one from publish-validation-action.test.ts: a database
 * mock that answers by the columns each selection asks for, never by call
 * order.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

const { tableRows } = vi.hoisted(() => ({
  tableRows: {
    stories: [] as unknown[],
    config: [] as unknown[],
  },
}));

function rowsFor(columns?: Record<string, unknown>): unknown[] {
  if (!columns) return [];
  if ("draft" in columns) return tableRows.stories;
  if ("story_key" in columns) return tableRows.config;
  return [];
}

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: (columns?: Record<string, unknown>) => {
      const rows = rowsFor(columns);
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.limit = () => Promise.resolve(rows);
      return chain;
    },
  })),
}));

vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));

const { requirePublishingRole } = vi.hoisted(() => ({ requirePublishingRole: vi.fn(async () => {}) }));
vi.mock("~/lib/membership.server", () => ({ requirePublishingRole }));

const { activeProjectRole, resolveActiveProjectFromRequest } = vi.hoisted(() => {
  const activeProjectRole = { current: "convenor" as "convenor" | "collaborator" | "instructor" };
  return {
    activeProjectRole,
    resolveActiveProjectFromRequest: vi.fn(async () => ({
      project: {
        id: 7,
        github_repo_full_name: "owner/repo",
        head_sha: "recorded-head",
        installation_id: 42,
        publish_snapshot: null,
      },
      userRole: activeProjectRole.current,
    })),
  };
});
// `resolvePageProject` and `siteChangedAnswer` are re-implemented here against
// the same mocked `resolveActiveProjectFromRequest`, matching the real
// module's own logic (app/lib/active-project.server.ts), because this file
// mocks the whole module rather than importing its original.
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest,
  resolvePageProject: vi.fn(async (request: Request, env: unknown, userId: number, formData: FormData) => {
    const resolved = await resolveActiveProjectFromRequest();
    if (!resolved) return { kind: "no_project" };
    if (formData.get("siteId") !== String(resolved.project.id)) {
      return { kind: "site_changed", currentSiteName: resolved.project.github_repo_full_name };
    }
    return { kind: "ok", ...resolved };
  }),
  siteChangedAnswer: vi.fn((intent: string, currentSiteName: string) => ({
    ok: false,
    intent,
    error: "site_changed",
    currentSiteName,
  })),
}));

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  getInstallationInfo: vi.fn(),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));

const { repairBuildWorkflow } = vi.hoisted(() => ({
  repairBuildWorkflow: vi.fn(
    async (_deps: unknown, _args: unknown): Promise<unknown> => ({
      kind: "repaired",
      newHeadSha: "new-sha",
      recorded: true,
    }),
  ),
}));
vi.mock("~/lib/build-workflow.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, repairBuildWorkflow };
});

vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));

import { action } from "~/routes/_app.publish";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function buildContext() {
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        GITHUB_APP_ID: "app-id",
        GITHUB_PRIVATE_KEY: "private-key",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: vi.fn() })) },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

type ActionResponse = Record<string, unknown>;

async function repair(extraFields: Record<string, string> = {}): Promise<ActionResponse> {
  const form = new FormData();
  form.set("intent", "repair-build-workflow");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  for (const [key, value] of Object.entries(extraFields)) form.set(key, value);
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: buildContext(),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as ActionResponse;
}

function repairArgs(): Record<string, unknown> {
  return repairBuildWorkflow.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  tableRows.stories = [];
  tableRows.config = [];
  activeProjectRole.current = "convenor";
  repairBuildWorkflow.mockResolvedValue({ kind: "repaired", newHeadSha: "new-sha", recorded: true });
});

// ---------------------------------------------------------------------------

describe("repair-build-workflow — what the action supplies", () => {
  it("is gated like every other intent", async () => {
    await repair();

    expect(requirePublishingRole).toHaveBeenCalled();
  });

  it("takes the repository, installation, head and App credentials from the server, not the form", async () => {
    await repair({
      path: ".github/workflows/release.yml",
      content: "run: curl evil",
      tag: "../../../etc",
      owner: "attacker",
      repo: "other-repo",
      installationId: "99",
      expectedHead: "some-other-head",
    });

    const deps = repairBuildWorkflow.mock.calls[0][0] as Record<string, unknown>;
    const args = repairArgs();

    // The args object is exactly this shape — no extra key can carry a
    // hostile field through under a name the switch below doesn't expect.
    expect(args).toEqual({
      projectToken: "install-token",
      frameworkToken: "user-token",
      owner: "owner",
      repo: "repo",
      repoFullName: "owner/repo",
      projectHeadSha: "recorded-head",
      installationId: 42,
      appId: "app-id",
      privateKey: "private-key",
      role: "convenor",
    });

    // None of the posted hostile fields reach the repair, in either the args
    // or the dependency bag (functions in `deps` serialise away, so this also
    // guards against one being swapped for a literal that echoes the form).
    const postedValues = [
      ".github/workflows/release.yml",
      "run: curl evil",
      "../../../etc",
      "attacker",
      "other-repo",
      "99",
      "some-other-head",
    ];
    const argsJson = JSON.stringify(args);
    const depsJson = JSON.stringify(deps);
    for (const value of postedValues) {
      expect(argsJson).not.toContain(value);
      expect(depsJson).not.toContain(value);
    }
  });

  it("passes the caller's own role through, never an assumed one", async () => {
    activeProjectRole.current = "collaborator";
    await repair();

    expect(repairArgs()).toMatchObject({ role: "collaborator" });
  });

  it("answers whether a private, non-draft story still exists from the project's own rows", async () => {
    tableRows.stories = [
      { id: 1, story_id: "public", title: "Public", private: false, draft: false },
      { id: 2, story_id: "wip", title: "WIP", private: true, draft: true },
    ];
    await repair();
    const deps = repairBuildWorkflow.mock.calls[0][0] as {
      hasPrivateNonDraftStory: () => Promise<boolean>;
    };
    expect(await deps.hasPrivateNonDraftStory()).toBe(false);

    vi.clearAllMocks();
    tableRows.stories = [{ id: 3, story_id: "weavers", title: "The Weavers", private: true, draft: false }];
    await repair();
    const deps2 = repairBuildWorkflow.mock.calls[0][0] as {
      hasPrivateNonDraftStory: () => Promise<boolean>;
    };
    expect(await deps2.hasPrivateNonDraftStory()).toBe(true);
  });
});

describe("repair-build-workflow — each outcome as action data", () => {
  it("reports a landed repair with the new head and whether it was recorded", async () => {
    repairBuildWorkflow.mockResolvedValue({ kind: "repaired", newHeadSha: "new-sha", recorded: false });

    expect(await repair()).toEqual({
      ok: true,
      intent: "repair-build-workflow",
      outcome: "repaired",
      newHeadSha: "new-sha",
      recorded: false,
    });
  });

  it("reports a workflow that was already current", async () => {
    repairBuildWorkflow.mockResolvedValue({ kind: "already_current" });

    expect(await repair()).toEqual({
      ok: true,
      intent: "repair-build-workflow",
      outcome: "already_current",
    });
  });

  it("reports a repair that is no longer needed", async () => {
    repairBuildWorkflow.mockResolvedValue({ kind: "not_needed" });

    expect(await repair()).toEqual({
      ok: true,
      intent: "repair-build-workflow",
      outcome: "not_needed",
    });
  });

  it("reports a head that moved", async () => {
    repairBuildWorkflow.mockResolvedValue({ kind: "stale_head" });

    expect(await repair()).toEqual({
      ok: false,
      intent: "repair-build-workflow",
      error: "stale_head",
    });
  });

  it("reports a refused commit with the settings page that grants the permission", async () => {
    repairBuildWorkflow.mockResolvedValue({
      kind: "insufficient_permissions",
      reauthUrl: "https://github.com/settings/installations/42",
    });

    expect(await repair()).toEqual({
      ok: false,
      intent: "repair-build-workflow",
      error: "insufficient_permissions",
      reauthUrl: "https://github.com/settings/installations/42",
    });
  });

  it("reports anything else as a plain failure", async () => {
    repairBuildWorkflow.mockResolvedValue({ kind: "failed" });

    expect(await repair()).toEqual({
      ok: false,
      intent: "repair-build-workflow",
      error: "workflow_repair_failed",
    });
  });

  it("reports a refused commit with no settings link when the caller cannot act on one", async () => {
    repairBuildWorkflow.mockResolvedValue({ kind: "insufficient_permissions_convenor_required" });

    expect(await repair()).toEqual({
      ok: false,
      intent: "repair-build-workflow",
      error: "insufficient_permissions_convenor_required",
    });
  });
});

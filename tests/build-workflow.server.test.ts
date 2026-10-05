/**
 * `repairBuildWorkflow` commits the framework's `.github/workflows/build.yml`
 * over a site whose workflow cannot protect its private stories.
 *
 * Every GitHub, framework and D1 call is injected, so each branch is driven
 * here rather than through the route: the repair re-establishes the need at the
 * repository's current head, takes the version from the repository rather than
 * from D1, commits under the App installation token without skipping CI,
 * records the head compare-and-set, and never throws once the commit has
 * landed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StaleHeadError } from "~/lib/commit.server";
import {
  buildYmlRunsEncryptStep,
  isRepairableVersionTag,
  repairBuildWorkflow,
  BUILD_WORKFLOW_PATH,
  type RepairBuildWorkflowDeps,
} from "~/lib/build-workflow.server";

const WORKFLOW_WITH_MARKER =
  "        run: python3 scripts/encrypt_protected_stories.py\n";
const WORKFLOW_WITHOUT_MARKER = "jobs:\n  build:\n    runs-on: ubuntu-latest\n";
const CONFIG_YML = "telar:\n  version: 1.6.2\n";
const HEAD = "head-sha";

type Deps = RepairBuildWorkflowDeps;

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    getRepoHead: vi.fn(async () => HEAD),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      path === BUILD_WORKFLOW_PATH
        ? ({ status: "absent" } as const)
        : ({ status: "ok", content: CONFIG_YML } as const),
    ),
    hasPrivateNonDraftStory: vi.fn(async () => true),
    fetchFrameworkFilesAtVersion: vi.fn(async () => [
      { path: BUILD_WORKFLOW_PATH, content: WORKFLOW_WITH_MARKER },
    ]),
    getInstallationToken: vi.fn(async () => "install-token"),
    getInstallationInfo: vi.fn(async () => ({
      workflowsWrite: true,
      targetType: "User" as const,
    })),
    commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "repair-sha" })),
    bumpProjectHeadFrom: vi.fn(async () => true),
    ...overrides,
  } as Deps;
}

const ARGS = {
  projectToken: "project-token",
  frameworkToken: "framework-token",
  owner: "owner",
  repo: "repo",
  repoFullName: "owner/repo",
  projectHeadSha: HEAD,
  installationId: 42,
  appId: "app-id",
  privateKey: "private-key",
  role: "convenor" as "convenor" | "collaborator" | "instructor" | null,
};

function run(deps: Deps, args: Partial<typeof ARGS> = {}) {
  return repairBuildWorkflow(deps, { ...ARGS, ...args });
}

/** The workflow read answers `file`; `_config.yml` answers CONFIG_YML. */
function readsWorkflow(file: { status: "ok"; content: string } | { status: "absent" } | { status: "error" }) {
  return vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
    path === BUILD_WORKFLOW_PATH ? file : ({ status: "ok", content: CONFIG_YML } as const),
  ) as unknown as Deps["getFileAtRef"];
}

/** The workflow read answers absent; `_config.yml` answers `config`. */
function readsConfig(config: { status: "ok"; content: string } | { status: "absent" } | { status: "error" }) {
  return vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
    path === BUILD_WORKFLOW_PATH ? ({ status: "absent" } as const) : config,
  ) as unknown as Deps["getFileAtRef"];
}

beforeEach(() => {
  // `vi.spyOn` on an already-spied method returns the spy that is there, calls
  // and all, so the count has to be cleared here for the per-test assertions
  // below to mean what they say.
  vi.spyOn(console, "error").mockImplementation(() => {}).mockClear();
});

// ---------------------------------------------------------------------------

describe("buildYmlRunsEncryptStep", () => {
  it("is the framework's plain substring test", () => {
    expect(buildYmlRunsEncryptStep(WORKFLOW_WITH_MARKER)).toBe(true);
    expect(buildYmlRunsEncryptStep(WORKFLOW_WITHOUT_MARKER)).toBe(false);
    expect(buildYmlRunsEncryptStep("")).toBe(false);
  });
});

describe("isRepairableVersionTag", () => {
  it("accepts a release tag with or without the v prefix, and a pre-release suffix", () => {
    expect(isRepairableVersionTag("v1.6.2")).toBe(true);
    expect(isRepairableVersionTag("1.6.2")).toBe(true);
    expect(isRepairableVersionTag("v1.7.0-beta.1")).toBe(true);
  });

  it("rejects anything that could travel into a URL as a path", () => {
    expect(isRepairableVersionTag("")).toBe(false);
    expect(isRepairableVersionTag("../x")).toBe(false);
    expect(isRepairableVersionTag("v1.6")).toBe(false);
    expect(isRepairableVersionTag("main")).toBe(false);
    expect(isRepairableVersionTag("v1.6.2/../../etc")).toBe(false);
  });
});

describe("repairBuildWorkflow — the repair that lands", () => {
  it("commits the framework's build.yml with the App token, at the head it read, without skipping CI", async () => {
    const deps = makeDeps();

    const result = await run(deps);

    // The framework repo is separate and public — its fetch must run on the
    // framework token, never the project token.
    expect(deps.fetchFrameworkFilesAtVersion).toHaveBeenCalledWith(
      "framework-token",
      [BUILD_WORKFLOW_PATH],
      "v1.6.2",
    );
    expect(deps.commitFilesToRepo).toHaveBeenCalledTimes(1);
    const call = (deps.commitFilesToRepo as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("install-token");
    expect(call[1]).toBe("owner");
    expect(call[2]).toBe("repo");
    expect(call[4]).toEqual([{ path: BUILD_WORKFLOW_PATH, content: WORKFLOW_WITH_MARKER }]);
    // skipCi (arg 8) must be falsy: a site whose last build failed on the stale
    // workflow has no next publish to rebuild it.
    expect(call[8]).toBeFalsy();
    // expectedHeadOidOverride (arg 9) chains the commit on the head that was read.
    expect(call[9]).toBe(HEAD);
    expect(result).toEqual({ kind: "repaired", newHeadSha: "repair-sha", recorded: true });
  });

  it("records the new head compare-and-set against the head it committed on", async () => {
    const deps = makeDeps();

    await run(deps);

    expect(deps.bumpProjectHeadFrom).toHaveBeenCalledWith(HEAD, "repair-sha");
  });

  it("asks for the installation token with the App id, key and the project's installation", async () => {
    const deps = makeDeps();

    await run(deps);

    expect(deps.getInstallationToken).toHaveBeenCalledWith("app-id", "private-key", 42);
  });

  it("reads the project repo's head under the project token, not the framework token", async () => {
    const deps = makeDeps();

    await run(deps);

    expect(deps.getRepoHead).toHaveBeenCalledWith("project-token", "owner", "repo");
  });

  it("proceeds when the workflow is present but does not run the encryption step", async () => {
    const deps = makeDeps({
      getFileAtRef: readsWorkflow({ status: "ok", content: WORKFLOW_WITHOUT_MARKER }),
    });

    const result = await run(deps);

    expect(result.kind).toBe("repaired");
  });
});

describe("repairBuildWorkflow — need re-established at the head", () => {
  it("commits nothing when the workflow already runs the encryption step", async () => {
    const deps = makeDeps({
      getFileAtRef: readsWorkflow({ status: "ok", content: WORKFLOW_WITH_MARKER }),
    });

    const result = await run(deps);

    expect(result).toEqual({ kind: "already_current" });
    expect(deps.commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("commits nothing when no private, non-draft story is left", async () => {
    const deps = makeDeps({ hasPrivateNonDraftStory: vi.fn(async () => false) });

    const result = await run(deps);

    expect(result).toEqual({ kind: "not_needed" });
    expect(deps.commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("stops at a head that is not the one D1 recorded, before reading or fetching anything", async () => {
    const deps = makeDeps({ getRepoHead: vi.fn(async () => "moved-on") });

    const result = await run(deps);

    expect(result).toEqual({ kind: "stale_head" });
    expect(deps.getFileAtRef).not.toHaveBeenCalled();
    expect(deps.fetchFrameworkFilesAtVersion).not.toHaveBeenCalled();
    expect(deps.commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("fails rather than guesses when the workflow read is indeterminate", async () => {
    const deps = makeDeps({ getFileAtRef: readsWorkflow({ status: "error" }) });

    const result = await run(deps);

    expect(result).toEqual({ kind: "failed" });
    expect(deps.commitFilesToRepo).not.toHaveBeenCalled();
  });
});

describe("repairBuildWorkflow — the version comes from the repository", () => {
  it("reads _config.yml at the head, not the version D1 holds", async () => {
    const deps = makeDeps();

    await run(deps);

    // _config.yml is a project-repo read — it must run on the project token,
    // never the framework token.
    expect(deps.getFileAtRef).toHaveBeenCalledWith(
      "project-token",
      "owner",
      "repo",
      "_config.yml",
      HEAD,
    );
  });

  it("fails when _config.yml is absent", async () => {
    const deps = makeDeps({ getFileAtRef: readsConfig({ status: "absent" }) });

    const result = await run(deps);

    expect(result).toEqual({ kind: "failed" });
    expect(deps.commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("fails when _config.yml carries no telar version", async () => {
    const deps = makeDeps({
      getFileAtRef: readsConfig({ status: "ok", content: "title: A site\n" }),
    });

    const result = await run(deps);

    expect(result).toEqual({ kind: "failed" });
    expect(deps.fetchFrameworkFilesAtVersion).not.toHaveBeenCalled();
  });

  it("fails on a version that is not a release tag, rather than putting it in a URL", async () => {
    for (const version of ["../x", '""']) {
      const deps = makeDeps({
        getFileAtRef: readsConfig({ status: "ok", content: `telar:\n  version: ${version}\n` }),
      });

      const result = await run(deps);

      expect(result).toEqual({ kind: "failed" });
      expect(deps.fetchFrameworkFilesAtVersion).not.toHaveBeenCalled();
      expect(deps.commitFilesToRepo).not.toHaveBeenCalled();
    }
  });
});

describe("repairBuildWorkflow — exactly one file, and it must carry the marker", () => {
  const cases: { name: string; files: { path: string; content: string }[] }[] = [
    { name: "the framework returned nothing", files: [] },
    {
      name: "the framework returned more than the workflow",
      files: [
        { path: BUILD_WORKFLOW_PATH, content: WORKFLOW_WITH_MARKER },
        { path: "_config.yml", content: "telar:\n" },
      ],
    },
    {
      name: "the one file is not the workflow",
      files: [{ path: "_config.yml", content: WORKFLOW_WITH_MARKER }],
    },
    {
      name: "the workflow itself would not satisfy the framework",
      files: [{ path: BUILD_WORKFLOW_PATH, content: WORKFLOW_WITHOUT_MARKER }],
    },
  ];

  for (const { name, files } of cases) {
    it(`commits nothing when ${name}`, async () => {
      const deps = makeDeps({ fetchFrameworkFilesAtVersion: vi.fn(async () => files) });

      const result = await run(deps);

      expect(result).toEqual({ kind: "failed" });
      expect(deps.commitFilesToRepo).not.toHaveBeenCalled();
    });
  }
});

describe("repairBuildWorkflow — a refused commit is classified by reading the installation", () => {
  it("reports a stale head when the commit was chained on a head that moved", async () => {
    const deps = makeDeps({
      commitFilesToRepo: vi.fn(async () => {
        throw new StaleHeadError("Expected HEAD");
      }),
    });

    const result = await run(deps);

    expect(result).toEqual({ kind: "stale_head" });
    expect(deps.getInstallationInfo).not.toHaveBeenCalled();
    expect(deps.bumpProjectHeadFrom).not.toHaveBeenCalled();
  });

  const refused = () =>
    vi.fn(async () => {
      throw new Error("Resource not accessible by integration");
    });

  it("sends an organisation install to its organisation settings page", async () => {
    const deps = makeDeps({
      commitFilesToRepo: refused(),
      getInstallationInfo: vi.fn(async () => ({
        workflowsWrite: false,
        targetType: "Organization" as const,
      })),
    });

    const result = await run(deps);

    expect(result).toEqual({
      kind: "insufficient_permissions",
      reauthUrl: "https://github.com/organizations/owner/settings/installations/42",
    });
    expect(deps.bumpProjectHeadFrom).not.toHaveBeenCalled();
  });

  it("sends a user install to its own settings page", async () => {
    const deps = makeDeps({
      commitFilesToRepo: refused(),
      getInstallationInfo: vi.fn(async () => ({
        workflowsWrite: false,
        targetType: "User" as const,
      })),
    });

    const result = await run(deps);

    expect(result).toEqual({
      kind: "insufficient_permissions",
      reauthUrl: "https://github.com/settings/installations/42",
    });
  });

  it("does not blame the permission when the installation holds it", async () => {
    const deps = makeDeps({
      commitFilesToRepo: refused(),
      getInstallationInfo: vi.fn(async () => ({
        workflowsWrite: true,
        targetType: "User" as const,
      })),
    });

    const result = await run(deps);

    expect(result).toEqual({ kind: "failed" });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(deps.bumpProjectHeadFrom).not.toHaveBeenCalled();
  });

  it("falls back to a plain failure when the installation cannot be read either", async () => {
    const deps = makeDeps({
      commitFilesToRepo: refused(),
      getInstallationInfo: vi.fn(async () => {
        throw new Error("401");
      }),
    });

    const result = await run(deps);

    expect(result).toEqual({ kind: "failed" });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(deps.bumpProjectHeadFrom).not.toHaveBeenCalled();
  });

  // https://github.com/settings/installations/<id> can only be acted on by
  // the account that installed the App — a collaborator or instructor who
  // follows it reaches a page that is not theirs to act on. The role that
  // classifies the refusal has to be the caller's real one, not an assumed
  // convenor.
  for (const role of ["collaborator", "instructor"] as const) {
    it(`gives a ${role} no settings link, only the convenor-required reason`, async () => {
      const deps = makeDeps({
        commitFilesToRepo: refused(),
        getInstallationInfo: vi.fn(async () => ({
          workflowsWrite: false,
          targetType: "User" as const,
        })),
      });

      const result = await run(deps, { role });

      expect(result).toEqual({ kind: "insufficient_permissions_convenor_required" });
    });
  }

  it("still gives the convenor the settings link", async () => {
    const deps = makeDeps({
      commitFilesToRepo: refused(),
      getInstallationInfo: vi.fn(async () => ({
        workflowsWrite: false,
        targetType: "User" as const,
      })),
    });

    const result = await run(deps, { role: "convenor" });

    expect(result).toEqual({
      kind: "insufficient_permissions",
      reauthUrl: "https://github.com/settings/installations/42",
    });
  });
});

describe("repairBuildWorkflow — a failure after the commit is not a failed repair", () => {
  it("reports the repair with recorded false when another writer already moved the head", async () => {
    const deps = makeDeps({ bumpProjectHeadFrom: vi.fn(async () => false) });

    const result = await run(deps);

    expect(result).toEqual({ kind: "repaired", newHeadSha: "repair-sha", recorded: false });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("reports the repair with recorded false when the head write throws", async () => {
    const deps = makeDeps({
      bumpProjectHeadFrom: vi.fn(async () => {
        throw new Error("D1 unavailable");
      }),
    });

    const result = await run(deps);

    expect(result).toEqual({ kind: "repaired", newHeadSha: "repair-sha", recorded: false });
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

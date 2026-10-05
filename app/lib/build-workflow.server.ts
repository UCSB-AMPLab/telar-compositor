/**
 * The site's `.github/workflows/build.yml`: the test that decides whether it
 * can protect private stories, and the repair that replaces it with the one the
 * framework ships at the site's version.
 *
 * Every GitHub, framework and D1 call the repair makes is injected through
 * `deps`, so the route stays a thin seam and each branch can be driven directly
 * in tests.
 *
 * @version v1.5.0-beta
 */

import { StaleHeadError } from "~/lib/commit.server";
import type { CommitFile } from "~/lib/commit.server";
import type { FileAtRef } from "~/lib/github.server";
import type { InstallationInfo } from "~/lib/github-app.server";
import { deriveWorkflowsApproval } from "~/lib/github-status.server";
import { extractTelarVersion } from "~/lib/sync.server";
import { normalizeVersionTag } from "~/lib/version";

/** The one file this module reads and the one file the repair may commit. */
export const BUILD_WORKFLOW_PATH = ".github/workflows/build.yml";

const CONFIG_PATH = "_config.yml";

/** The branch every compositor commit lands on. */
const BRANCH = "main";

const REPAIR_COMMIT_MESSAGE = "Update the build workflow";

/**
 * The literal the framework's `_check_protected_prerequisites` looks for in
 * `.github/workflows/build.yml` before it will build a site carrying a
 * protected story.
 */
export const ENCRYPT_SCRIPT_MARKER = "encrypt_protected_stories.py";

/**
 * Whether a `build.yml` body runs the step that encrypts protected stories.
 *
 * A plain substring test, and it must stay one: the framework's own check is
 * `ENCRYPT_SCRIPT_MARKER not in workflow_text`, so anything that parses YAML or
 * strips comments would refuse files the framework accepts and warn the user
 * about a build that is going to succeed. The compositor's job here is
 * agreement with the gate, not a better gate. That the marker can sit in a line
 * that never runs is the framework's weakness to fix, not this function's.
 */
export function buildYmlRunsEncryptStep(content: string): boolean {
  return content.includes(ENCRYPT_SCRIPT_MARKER);
}

/**
 * A release tag the repair may put into a framework content URL: `MAJOR.MINOR
 * .PATCH` with an optional `v` prefix and an optional pre-release suffix. The
 * version comes out of a file in the user's repository, so it is untrusted
 * input to a URL until this passes.
 */
const REPAIRABLE_VERSION_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export function isRepairableVersionTag(tag: string): boolean {
  return REPAIRABLE_VERSION_TAG.test(tag);
}

// ---------------------------------------------------------------------------
// repairBuildWorkflow
// ---------------------------------------------------------------------------

export interface RepairBuildWorkflowDeps {
  getRepoHead: (token: string, owner: string, repo: string) => Promise<string>;
  getFileAtRef: (
    token: string,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ) => Promise<FileAtRef>;
  /** Whether the project still holds a story the framework's interlock sees. */
  hasPrivateNonDraftStory: () => Promise<boolean>;
  fetchFrameworkFilesAtVersion: (
    token: string,
    paths: string[],
    tagName: string,
  ) => Promise<CommitFile[]>;
  getInstallationToken: (
    appId: string,
    privateKey: string,
    installationId: number,
  ) => Promise<string>;
  getInstallationInfo: (
    appId: string,
    privateKey: string,
    installationId: number,
  ) => Promise<InstallationInfo>;
  commitFilesToRepo: (
    token: string,
    owner: string,
    repo: string,
    branch: string,
    files: CommitFile[],
    message: string,
    messageBody?: string,
    deletions?: string[],
    skipCi?: boolean,
    expectedHeadOidOverride?: string,
  ) => Promise<{ newHeadSha: string }>;
  /** Compare-and-set head advance; false when another writer got there first. */
  bumpProjectHeadFrom: (fromSha: string, toSha: string) => Promise<boolean>;
}

export interface RepairBuildWorkflowArgs {
  /** Token for reads against the project's own repository (getRepoHead,
   *  getFileAtRef) — never the commit, which mints and uses its own
   *  installation token internally regardless. */
  projectToken: string;
  /** Token for fetchFrameworkFilesAtVersion's read of the framework
   *  repository — a public repo the project's installation is not granted,
   *  so this must never be the project token: an installation token is
   *  scoped to its own installation's repos and cannot read one outside
   *  that grant. */
  frameworkToken: string;
  owner: string;
  repo: string;
  repoFullName: string;
  /** The head D1 recorded for the project. */
  projectHeadSha: string | null;
  installationId: number;
  appId: string;
  privateKey: string;
  /** The caller's own role on the project — never assumed. Only a convenor
   *  can act on the App installation's settings page, so this decides
   *  whether a workflows refusal comes back with that page's URL at all. */
  role: "convenor" | "collaborator" | "instructor" | null;
}

export type RepairBuildWorkflowResult =
  | { kind: "repaired"; newHeadSha: string; recorded: boolean }
  | { kind: "already_current" }
  | { kind: "not_needed" }
  | { kind: "stale_head" }
  | { kind: "insufficient_permissions"; reauthUrl: string | null }
  | { kind: "insufficient_permissions_convenor_required" }
  | { kind: "failed" };

type Need =
  | { kind: "proceed"; head: string }
  | Exclude<
      RepairBuildWorkflowResult,
      { kind: "repaired" } | { kind: "insufficient_permissions" } | { kind: "insufficient_permissions_convenor_required" }
    >;

/**
 * Re-establishes at the repository's current head whether a repair is still
 * needed. The page that offered the button is a page-load advisory and may be
 * describing a tree that has since been fixed, so nothing here trusts it.
 */
async function establishNeed(
  deps: RepairBuildWorkflowDeps,
  args: RepairBuildWorkflowArgs,
): Promise<Need> {
  const head = await deps.getRepoHead(args.projectToken, args.owner, args.repo);
  if (head !== args.projectHeadSha) return { kind: "stale_head" };

  const workflow = await deps.getFileAtRef(
    args.projectToken,
    args.owner,
    args.repo,
    BUILD_WORKFLOW_PATH,
    head,
  );
  // An indeterminate read cannot establish need, and a repair that overwrites a
  // file it could not see is worse than one that does not run.
  if (workflow.status === "error") return { kind: "failed" };
  if (workflow.status === "ok" && buildYmlRunsEncryptStep(workflow.content)) {
    return { kind: "already_current" };
  }

  if (!(await deps.hasPrivateNonDraftStory())) return { kind: "not_needed" };
  return { kind: "proceed", head };
}

/**
 * The file to commit: the framework's `build.yml` at the version the
 * repository's own `_config.yml` pins its scripts to. D1's `telar_version` can
 * disagree with the repository, and it is the repository's scripts the workflow
 * has to run beside.
 *
 * Null whenever the version, the tag or the fetched file cannot be trusted —
 * exactly one file, at exactly that path, itself carrying the marker.
 */
async function resolveWorkflowFile(
  deps: RepairBuildWorkflowDeps,
  args: RepairBuildWorkflowArgs,
  head: string,
): Promise<CommitFile | null> {
  const config = await deps.getFileAtRef(args.projectToken, args.owner, args.repo, CONFIG_PATH, head);
  if (config.status !== "ok") return null;

  const version = extractTelarVersion(config.content);
  if (!version) return null;

  const tag = normalizeVersionTag(version.trim());
  if (!isRepairableVersionTag(tag)) return null;

  const files = await deps.fetchFrameworkFilesAtVersion(args.frameworkToken, [BUILD_WORKFLOW_PATH], tag);
  if (files.length !== 1) return null;
  const [file] = files;
  if (file.path !== BUILD_WORKFLOW_PATH) return null;
  if (!buildYmlRunsEncryptStep(file.content)) return null;
  return file;
}

/**
 * Why the commit was refused, decided by reading the installation's granted
 * permissions rather than by matching the error's text: "Resource not
 * accessible by integration" covers more than workflows, and a 401 on the
 * GraphQL call would be misread by any substring rule.
 */
async function classifyRefusal(
  deps: RepairBuildWorkflowDeps,
  args: RepairBuildWorkflowArgs,
  err: unknown,
): Promise<RepairBuildWorkflowResult> {
  try {
    const info = await deps.getInstallationInfo(args.appId, args.privateKey, args.installationId);
    if (!info.workflowsWrite) {
      // The fresh target type decides the settings URL, so an organisation
      // install gets the organisation page even on a cold permissions cache.
      // The caller's real role decides whether a URL comes back at all: only
      // the convenor, as installer, can act on that settings page.
      const { needed, url } = deriveWorkflowsApproval({
        workflowsWriteMissing: 1,
        targetType: info.targetType,
        installationId: args.installationId,
        repoFullName: args.repoFullName,
        role: args.role,
      });
      if (!needed) return { kind: "insufficient_permissions_convenor_required" };
      return { kind: "insufficient_permissions", reauthUrl: url };
    }
  } catch {
    // The installation read is the classifier, not a second failure to report.
  }
  console.error("[repairBuildWorkflow] the workflow commit was refused:", err);
  return { kind: "failed" };
}

/**
 * Records the repaired head compare-and-set. Never throws: the repository has
 * already changed, so a D1 failure here is a repair that was not written down,
 * not a repair that did not happen. Zero rows means another writer recorded a
 * newer head, which must be left alone.
 */
async function recordRepairedHead(
  deps: RepairBuildWorkflowDeps,
  fromSha: string,
  toSha: string,
): Promise<boolean> {
  try {
    const recorded = await deps.bumpProjectHeadFrom(fromSha, toSha);
    if (!recorded) {
      console.error(
        `[repairBuildWorkflow] head ${toSha} not recorded: the project no longer sits at ${fromSha}`,
      );
    }
    return recorded;
  } catch (err) {
    console.error("[repairBuildWorkflow] recording the repaired head failed:", err);
    return false;
  }
}

/**
 * Commits the one file under the App installation token, because this
 * application's OAuth sign-in requests `repo read:user user:email` and holds no
 * `workflow` scope; the App's installation grant does.
 *
 * No skip-CI marker: a site whose last publish failed on the stale workflow
 * reads as up to date in D1 and its publish button is disabled, so there may be
 * no next publish to rebuild it. The push has to run `build.yml` itself.
 */
async function commitRepair(
  deps: RepairBuildWorkflowDeps,
  args: RepairBuildWorkflowArgs,
  head: string,
  file: CommitFile,
): Promise<RepairBuildWorkflowResult> {
  let installToken: string;
  try {
    installToken = await deps.getInstallationToken(args.appId, args.privateKey, args.installationId);
  } catch (err) {
    console.error("[repairBuildWorkflow] could not mint an installation token:", err);
    return { kind: "failed" };
  }

  let newHeadSha: string;
  try {
    ({ newHeadSha } = await deps.commitFilesToRepo(
      installToken,
      args.owner,
      args.repo,
      BRANCH,
      [file],
      REPAIR_COMMIT_MESSAGE,
      undefined,
      undefined,
      false,
      head,
    ));
  } catch (err) {
    if (err instanceof StaleHeadError) return { kind: "stale_head" };
    return await classifyRefusal(deps, args, err);
  }

  const recorded = await recordRepairedHead(deps, head, newHeadSha);
  return { kind: "repaired", newHeadSha, recorded };
}

/**
 * Replaces a site's `build.yml` with the framework's, so a private story can be
 * published. Commits exactly one file and nothing else, and commits nothing at
 * all unless the need still holds at the repository's current head.
 */
export async function repairBuildWorkflow(
  deps: RepairBuildWorkflowDeps,
  args: RepairBuildWorkflowArgs,
): Promise<RepairBuildWorkflowResult> {
  let need: Need;
  let file: CommitFile | null;
  try {
    need = await establishNeed(deps, args);
    if (need.kind !== "proceed") return need;
    file = await resolveWorkflowFile(deps, args, need.head);
  } catch (err) {
    console.error("[repairBuildWorkflow] could not read the repository:", err);
    return { kind: "failed" };
  }
  if (!file) return { kind: "failed" };
  return await commitRepair(deps, args, need.head, file);
}

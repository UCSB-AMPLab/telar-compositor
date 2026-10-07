/**
 * This file is the Upgrade route — surfaces version info, release
 * notes, and the file-change summary the user sees before clicking
 * Upgrade. The button commits framework files atomically against
 * the user's repo.
 *
 * Loader fetches the latest framework release and computes the
 * upgrade diff between the user's repo and that release.
 *
 * Action intents:
 *   - `upgrade-prepare` — reads and repairs everything the commit needs, and
 *     answers a signed prepared upgrade or a question for the column picker
 *   - `upgrade-commit` — commits a prepared upgrade, updates D1
 *   - `upgrade-cancel` — lets go of a prepared upgrade the author declined
 *   - `poll-build` — polls GitHub Actions for build progress
 *   - `compute-diff` — recomputes the diff (refresh / retry)
 *   - `rebuild` — dispatches the site build again after a failed build
 *
 * Renders a state machine — review | upgrading | choices | confirm |
 * building | done.
 *
 * @version v1.5.2-beta
 */

import { redirect } from "react-router";
import { and, eq, gt, sql } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { gateReasonKey, readUpgradeOrigin, upgradeReturnPath } from "~/lib/upgrade-origin";
import { applyBuiltInPageFrontmatter } from "~/lib/framework-page-frontmatter.server";
import { useIsPublisher } from "~/hooks/use-role";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  ExternalLink,
  FileCode,
  FileText,
  GitBranch,
  Loader2,
  Palette,
  Terminal,
  XCircle,
} from "lucide-react";
import type { Route } from "./+types/_app.upgrade";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, project_config, stories, steps } from "~/db/schema";
import { decrypt } from "~/lib/crypto.server";
import {
  getRepoTree,
  getRepoHead,
  getFileContent,
  getFileAtRef,
  getBlobText,
  listDirectoryEntries,
  GitHubTransientError,
} from "~/lib/github.server";
import type { TreeEntry } from "~/lib/github.server";
import type { SpreadsheetEntry } from "~/lib/upgrade-sheets.server";
import {
  ReleaseFileUnreadableError,
  ReleaseListUnreadableError,
  ReleaseManifestInvalidError,
  ReleaseTreeUnreadableError,
  UpgradeFileNotTextError,
  UpgradeFileUnreadableError,
  siteFileReads,
} from "~/lib/upgrade-reads.server";
import { requirePublishingRole } from "~/lib/membership.server";
import { resolveActiveProjectFromRequest, resolvePageProject, siteChangedAnswer } from "~/lib/active-project.server";
import { useSiteFetcher } from "~/lib/page-site";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import {
  InvalidPreparedStateError,
  assertPreparedUpgradeSignature,
  readPostedChallenge,
  signPreparedUpgrade,
  signUpgradeChallenge,
  type PreparedUpgrade,
  type PreparedUpgradeContent,
  type SignedUpgradeChallenge,
} from "~/lib/upgrade-signing.server";
import {
  fileAtHead,
  listSpreadsheetEntries,
  parsePostedChoices,
  runSheetStage,
  sheetsOffConfig,
  withRepairedSheets,
  type ChoiceNotice,
  type OfferedGroup,
  type SheetReportLine,
  type SheetStageResult,
  type SubmittedChoice,
  type TabCollision,
  type TabsRefused,
} from "~/lib/upgrade-sheets.server";
import { isGoogleSheetsOn } from "~/lib/pyyaml";
import { repairSiteConfig } from "~/lib/config-repair.server";
import { answersPublishedDifferently, upgradeStartsCuttingAnswers, type UpgradeAnswer } from "~/lib/upgrade-answers.server";
import { readGlossaryFiles } from "~/lib/upgrade-glossary-files.server";
import { PublishedSheetUnreadableError, readPublishedTabs } from "~/lib/sheets.server";
import {
  fetchLatestRelease,
  fetchAllReleases,
  computeUpgradeDiff,
  updateTelarVersionInConfig,
  checkTelarVersion,
  fetchFrameworkFile,
  categorizeFrameworkPath,
  loadManifestChain,
  releaseDateForUpgrade,
  collectFilesReferencedByChain,
  mergeUpgradeChanges,
  reviewedUpgradeDiff,
  reapplyBuiltInPageEdits,
  partitionWorkflowFiles,
} from "~/lib/upgrade.server";
import type { UpgradeDiff, TelarRelease, UpgradeSummary } from "~/lib/upgrade.server";
import { compareVersions, frameworkVersionForTag, MIN_SUPPORTED_VERSION } from "~/lib/telar-version";
import { applyManifestChain, manifestChainDeletions } from "~/lib/manifest-runner.server";
import { YamlListAddError } from "~/lib/yaml-list-add.server";
import type { ManifestApplyResult } from "~/lib/manifest-runner.server";
import { applyV130Transforms } from "~/lib/v130-ingest.server";
import type { V130IngestResult } from "~/lib/v130-ingest.server";
import type { Language, Manifest, ManualStep } from "~/lib/manifest-schema.server";
import { PostUpgradeSteps } from "~/components/features/upgrade/PostUpgradeSteps";
import {
  needsConfirmation,
  UpgradeSheetOutcome,
  UpgradeSheetQuestion,
  type ChoiceQuestion,
  type SheetsQuestion,
  type UpgradeFlowStage,
} from "~/components/features/upgrade/UpgradeSheetStage";
import { SiteLine } from "~/components/features/upgrade/SiteLine";
import { SheetLineList } from "~/components/features/upgrade/UpgradeSheetReport";
import {
  commitFilesToRepo,
  dispatchWorkflow,
  listWorkflowRunsBySha,
  getJobSteps,
  getWorkflowRun,
  mapStepsToBuildPhases,
  StaleHeadError,
} from "~/lib/commit.server";
import { getInstallationToken, resolveProjectToken } from "~/lib/github-app.server";
import type { BuildPhaseStatus, CommitFile, WorkflowRun } from "~/lib/commit.server";
import { bumpProjectHeadFrom, readLatestTag } from "~/lib/github-status.server";
import { normalizeVersionTag } from "~/lib/version";
import { marked, Renderer } from "marked";
import { sanitiseHtml } from "~/lib/sanitise-html";
import { Button } from "~/components/ui/Button";
import { controlFreezeLease, newFreezeOperationId } from "~/lib/freeze-lease.server";
import { useOperationLock } from "~/hooks/use-operation-lock";
import { OperationLockNotice } from "~/components/features/collaboration/OperationLockNotice";
import { wait } from "~/lib/wait";
import { answerReadsWhenUnreachable } from "~/lib/unreachable-write";
import { readOrKept, useReloadableLoaderData } from "~/lib/kept-loader-data";

export const handle = { i18n: ["common", "upgrade", "team", "publish"] };

// ---------------------------------------------------------------------------
// Build phases — mirrors commit.server.ts BUILD_PHASES (no server import)
// ---------------------------------------------------------------------------

const BUILD_PHASE_IDS = [
  "setup",
  "build-js",
  "process-data",
  "build-site",
  "iiif",
  "deploy",
] as const;

type BuildPhaseId = typeof BUILD_PHASE_IDS[number];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * The tree diff with the manifest chain's deletions merged in, as the commit
 * makes them. A chain that cannot be read leaves the tree diff as it is;
 * prepare refuses to delete any path the page did not list, so nothing is
 * deleted unreviewed.
 */
async function diffWithManifestDeletions(
  diff: UpgradeDiff,
  chain: {
    token: string;
    fromVersion: string;
    toVersion: string;
    releaseTag: string | undefined;
    site: { tree: TreeEntry[]; truncated: boolean };
  },
): Promise<UpgradeDiff> {
  try {
    const manifests = await loadManifestChain(chain.token, chain.fromVersion, chain.toVersion, chain.releaseTag);
    return reviewedUpgradeDiff(diff, manifestChainDeletions(manifests), chain.site);
  } catch (err) {
    console.error("Upgrade loader: migration manifest unavailable, listing the release diff only:", err);
    return diff;
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    // No active project — onboarding, not /dashboard (which loops via /objects).
    throw redirect("/onboarding");
  }
  const { project: activeProject, userRole } = resolved;
  const isConvenorActor = userRole === "convenor";

  const configRows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);
  const config = configRows[0] ?? null;
  const siteVersion = config?.telar_version ?? null;

  const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  const [owner, repo] = activeProject.github_repo_full_name.split("/");

  // The release this deployment is pinned to, for the notice the page renders
  // over the target version. Empty is the unpinned state, so it reads as null.
  const releaseTagOverride = env.TELAR_RELEASE_TAG || null;

  // Check minimum version support
  const siteTag = siteVersion ? normalizeVersionTag(siteVersion) : null;
  const isBelowMinimum = siteTag
    ? compareVersions(siteTag, MIN_SUPPORTED_VERSION) < 0
    : false;

  try {
    // Reads of the project's own repo (tree, _config.yml) run under the
    // installation token: a collaborator's own token may have no read
    // access to a private repository they are not a GitHub collaborator on.
    // fetchLatestRelease reads UCSB-AMPLab/telar, a repo outside this
    // installation's grant, so it stays on the user token — a public repo,
    // which any authenticated token can read.
    const projectToken = await resolveProjectToken(
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY,
      activeProject.installation_id,
      token,
      userRole,
    );

    // The three independent GitHub calls (latest release, user's repo tree,
    // user's _config.yml) fan out in parallel, so a cold page load costs
    // roughly the slowest single call (~2-3s for getRepoTree on large repos)
    // rather than the sum of all three.
    const [latestRelease, treeResult, configContent] = await Promise.all([
      fetchLatestRelease(token, env.TELAR_RELEASE_TAG),
      // The upgrade commits to main, which need not be the default branch.
      getRepoTree(projectToken, owner, repo, "main"),
      getFileContent(projectToken, owner, repo, "_config.yml", "main"),
    ]);
    const { tree: userTree, truncated: userTreeTruncated } = treeResult;

    // Fetch release notes for all versions newer than current site version.
    // Runs in parallel with computeUpgradeDiff because they share no state.
    //
    // computeUpgradeDiff is called with fetchContent:false — the review page
    // only needs paths and categories. Content for the commit is fetched
    // later inside runUpgradePrepare when the user clicks Upgrade. Skipping
    // content here avoids N sequential GitHub API calls (50-100+ on a full
    // framework upgrade) that previously dominated page load time.
    const [allReleasesData, treeDiff] = await Promise.all([
      siteTag && compareVersions(siteTag, latestRelease.tagName) < 0
        ? fetchAllReleases(token)
        : Promise.resolve(null),
      computeUpgradeDiff(token, userTree, latestRelease.tagName, {
        fetchContent: false,
        userTreeTruncated,
      }),
    ]);

    let releaseNotes: string = latestRelease.body;
    let releaseCount = 1;
    if (allReleasesData) {
      const newerReleases = allReleasesData.filter(
        (r) => siteTag ? compareVersions(r.tagName, siteTag) > 0 : true,
      );
      releaseCount = newerReleases.length;
      if (newerReleases.length > 1) {
        releaseNotes = newerReleases
          .map((r) => `## ${r.tagName}\n\n${r.body}`)
          .join("\n\n---\n\n");
      }
    }

    // Check the actual repo version — D1 may be stale if a previous upgrade
    // committed successfully but the D1 update failed.
    let effectiveVersion = siteTag;
    // The version prepare reads from D1 and starts its chain from; it moves to
    // the repo's only once D1 holds that version.
    let chainFromVersion = siteTag;
    if (configContent) {
      const versionMatch = configContent.match(/^\s*version:\s*["']?([^\s"'#]+)/m);
      if (versionMatch) {
        const repoVersion = normalizeVersionTag(versionMatch[1]);
        if (effectiveVersion && compareVersions(repoVersion, effectiveVersion) > 0) {
          // Repo is ahead of D1 — heal D1 silently
          effectiveVersion = repoVersion;
          try {
            const now = new Date().toISOString();
            await db
              .update(project_config)
              .set({ telar_version: repoVersion.replace(/^v/, ""), updated_at: now })
              .where(eq(project_config.project_id, activeProject.id));
            chainFromVersion = repoVersion;
          } catch {
            // Best-effort D1 heal
          }
        }
      }
    }

    const needsUpgrade = effectiveVersion
      ? compareVersions(effectiveVersion, latestRelease.tagName) < 0
      : false;

    // If the repo is already up to date (e.g. D1 was stale), redirect away
    if (!needsUpgrade && !isBelowMinimum) {
      const url = new URL(request.url);
      throw redirect(upgradeReturnPath(url.searchParams.get("from")));
    }

    // The commit deletes the manifest chain's paths as well as the tree
    // diff's, so the review lists the same set.
    const diff = await diffWithManifestDeletions(treeDiff, {
      token,
      fromVersion: (chainFromVersion ?? "").replace(/^v/, ""),
      toVersion: frameworkVersionForTag(latestRelease.tagName),
      releaseTag: env.TELAR_RELEASE_TAG || undefined,
      site: { tree: userTree, truncated: userTreeTruncated },
    });

    // Convert markdown release notes to HTML (with heading IDs for anchor links)
    const renderer = new Renderer();
    // Defence-in-depth: even though the slug regex below restricts characters
    // to letters/digits/hyphens, escape the value before inlining it into an
    // attribute so a future regex change can't open an injection path.
    const escapeAttr = (s: string) =>
      s.replace(
        /[&<>"']/g,
        (c) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
      );
    renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
      const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").trim();
      return `<h${depth} id="${escapeAttr(slug)}">${text}</h${depth}>`;
    };
    // Sanitise marked output before it reaches
    // dangerouslySetInnerHTML. Heading IDs from the custom Renderer above
    // survive sanitisation because the sanitiser allowlist permits id on h1-h6.
    const releaseNotesHtml = sanitiseHtml(
      (await marked.parse(releaseNotes, { async: false, gfm: true, renderer })) as string,
    );

    // Group file paths by category for the expandable file list
    const filesByCategory: Record<string, string[]> = {};
    for (const file of diff.additions) {
      const cat = categorizeFrameworkPath(file.path);
      (filesByCategory[cat] ??= []).push(file.path);
    }
    if (diff.deletions.length > 0) {
      filesByCategory.deletions = diff.deletions;
    }

    return {
      siteVersion,
      latestRelease,
      releaseTagOverride,
      releaseNotes: releaseNotesHtml as string,
      releaseCount,
      diff,
      filesByCategory,
      configContent: configContent ?? "",
      isBelowMinimum,
      needsUpgrade,
      googleSheetsEnabled: Boolean(config?.google_sheets_enabled),
      project: {
        id: activeProject.id,
        github_pages_url: activeProject.github_pages_url,
        github_repo_full_name: activeProject.github_repo_full_name,
      },
    };
  } catch (err) {
    // React Router throws Response objects for redirects and explicit
    // status responses — re-throw so the framework can act on them.
    if (err instanceof Response) throw err;
    // GitHub API unavailable — show minimal page
    console.error("Upgrade loader error:", err);
    return {
      siteVersion,
      latestRelease: null,
      releaseTagOverride,
      releaseNotes: "",
      releaseCount: 0,
      diff: null,
      configContent: "",
      isBelowMinimum,
      needsUpgrade: false,
      googleSheetsEnabled: Boolean(config?.google_sheets_enabled),
      project: {
        id: activeProject.id,
        github_pages_url: activeProject.github_pages_url,
        github_repo_full_name: activeProject.github_repo_full_name,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Action helpers
// ---------------------------------------------------------------------------

/** Gap before the single retry of the workflow commit. */
const WORKFLOW_COMMIT_RETRY_DELAY_MS = 1500;

const BUILD_WORKFLOW_FILE = "build.yml";

/** Retries after the first read-back of a run GitHub has just reported, a
 *  second apart: reads land at 0, 1, 2 and 3 seconds. */
const DISPATCHED_RUN_LOOKUP_RETRIES = 3;
const DISPATCHED_RUN_LOOKUP_INTERVAL_MS = 1000;

/**
 * Commits the workflow half of an upgrade, retrying once when GitHub answers
 * with a server error — including one from the deletion probe the commit runs
 * first, which is as transient as one on the mutation itself.
 *
 * The retry repeats the call verbatim, expected head included, which is what
 * makes it safe: a first attempt that landed before the 5xx reached us leaves
 * the branch past that head, so the retry is refused as a stale head rather
 * than committed twice. A rejection GitHub meant — a 4xx, a stale head, a
 * missing permission — is not a stumble and is not retried.
 */
async function commitWorkflowFilesWithRetry(
  ...args: Parameters<typeof commitFilesToRepo>
): Promise<{ newHeadSha: string }> {
  try {
    return await commitFilesToRepo(...args);
  } catch (err) {
    if (!(err instanceof GitHubTransientError)) throw err;
    console.warn(`[runUpgradeCommit] workflow commit retry after ${err.status}`);
    await wait(WORKFLOW_COMMIT_RETRY_DELAY_MS);
    return commitFilesToRepo(...args);
  }
}

/**
 * The token a workflow dispatch travels on: the installation's where the
 * project has one, the user's where it does not. A failed mint falls back
 * to the user's own token only when that user is the convenor — a
 * collaborator's token carries no write access to the convenor's
 * repository, so for a collaborator a failed mint throws instead, and the
 * caller reports it plainly rather than trading it for a confusing GitHub
 * 403 on the dispatch call.
 */
async function resolveDispatchToken(
  env: Env,
  installationId: number | null,
  userToken: string,
  isConvenorActor: boolean,
): Promise<string> {
  if (!installationId) return userToken;
  try {
    return await getInstallationToken(
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY,
      installationId,
    );
  } catch (err) {
    if (isConvenorActor) return userToken;
    throw err;
  }
}

/**
 * Reads back a run GitHub named in its dispatch response. A run that has just
 * been created is briefly invisible to the runs endpoint, so a 404 is retried
 * rather than believed.
 */
async function findDispatchedRun(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowRun | null> {
  for (let attempt = 0; attempt <= DISPATCHED_RUN_LOOKUP_RETRIES; attempt++) {
    if (attempt > 0) await wait(DISPATCHED_RUN_LOOKUP_INTERVAL_MS);
    const run = await getWorkflowRun(token, owner, repo, runId);
    if (run) return run;
  }
  return null;
}

type RebuildResult =
  | {
      ok: true;
      intent: "rebuild";
      runId: number | null;
      headSha: string | null;
      buildUrl: string;
    }
  | { ok: false; intent: "rebuild"; error: string };

// ---------------------------------------------------------------------------
// The upgrade's freeze lease
// ---------------------------------------------------------------------------
//
// The lease spans the upgrade's prepare and commit, the requests that read the
// site and rewrite it: while it stands no other publish or upgrade may begin,
// and collaborators wait with it. It ends when the commit and its bookkeeping
// have landed, not when the Actions build behind them does. The build turns a
// commit that has already landed into the published site and touches nothing
// a collaborator is editing, and a freeze that waited on it would hold every
// editor in a class for as long as the build ran — or, with the page that
// polls it closed, until the lease expired. A lease the object cannot be
// asked about lets the upgrade through (see `~/lib/freeze-lease.server`), and
// an id the page could have altered is safe to act on because the Durable
// Object ends or renews only a lease the same user holds.

/**
 * Start a lease for an upgrade and answer its id, or null when the object
 * refused it because another publish or upgrade is running.
 */
async function beginUpgradeLease(env: Env, projectId: number, userId: number): Promise<string | null> {
  const operationId = newFreezeOperationId();
  const lease = await controlFreezeLease(env, projectId, userId, { op: "begin", kind: "upgrade", operationId });
  return lease === "refused" ? null : operationId;
}

/**
 * Keep the lease an upgrade's commit is about to act under, and say whether it
 * may go ahead.
 *
 * The prepared state stays valid for longer than a lease phase, so a commit
 * can arrive after its lease has run out. It then begins the same operation
 * again, which succeeds unless another publish or upgrade began in the gap —
 * and that one is not to be committed over.
 */
async function holdUpgradeLease(env: Env, projectId: number, userId: number, raw: unknown): Promise<boolean> {
  const operationId = leaseId(raw);
  if (operationId === null) return true;
  if ((await controlFreezeLease(env, projectId, userId, { op: "renew", operationId })) !== "refused") return true;
  const again = await controlFreezeLease(env, projectId, userId, { op: "begin", kind: "upgrade", operationId });
  return again !== "refused";
}

/** An operation id a request carried, or null for none. */
function leaseId(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" ? raw : null;
}

async function endUpgradeLease(
  env: Env,
  projectId: number,
  userId: number,
  raw: unknown,
  outcome: "succeeded" | "failed",
): Promise<void> {
  const operationId = leaseId(raw);
  if (operationId !== null) await controlFreezeLease(env, projectId, userId, { op: "end", operationId, outcome });
}

/**
 * Runs the site's build again and answers with the run to follow.
 *
 * Where GitHub names the run it started, the page follows that run at its own
 * head. Where it answers the legacy 204 instead, no listing can say which run
 * the dispatch produced — a push or a competing dispatch makes runs this one
 * must not adopt — so the answer is an accepted dispatch with no run, never a
 * failure and never a guess.
 */
async function runSiteBuild(
  env: Env,
  installationId: number | null,
  userToken: string,
  isConvenorActor: boolean,
  owner: string,
  repo: string,
): Promise<RebuildResult> {
  let token: string;
  try {
    token = await resolveDispatchToken(env, installationId, userToken, isConvenorActor);
  } catch (err) {
    console.error("[runSiteBuild] no usable dispatch token:", err);
    return { ok: false, intent: "rebuild", error: "rebuild_failed" };
  }
  const workflowUrl = `https://github.com/${owner}/${repo}/actions/workflows/${BUILD_WORKFLOW_FILE}`;

  let dispatchedRunId = 0;
  let buildUrl = workflowUrl;
  try {
    const dispatch = await dispatchWorkflow(token, owner, repo, BUILD_WORKFLOW_FILE);
    dispatchedRunId = dispatch.runId;
    buildUrl = dispatch.htmlUrl || workflowUrl;
  } catch (err) {
    console.error("[runSiteBuild] workflow dispatch failed:", err);
    return { ok: false, intent: "rebuild", error: "rebuild_failed" };
  }

  // Past this line the build is running, so nothing below may report failure.
  try {
    const run = dispatchedRunId
      ? await findDispatchedRun(token, owner, repo, dispatchedRunId)
      : null;
    if (run?.head_sha) {
      return {
        ok: true,
        intent: "rebuild",
        runId: run.id,
        headSha: run.head_sha,
        buildUrl: run.html_url || buildUrl,
      };
    }
  } catch (err) {
    console.error("[runSiteBuild] run lookup failed:", err);
  }
  return { ok: true, intent: "rebuild", runId: null, headSha: null, buildUrl };
}

/**
 * The run a poll reports on. A submitted run id is followed and nothing else:
 * taking the newest run for the sha instead lets a poll issued after a rebuild
 * rediscover the failed run, read `completed`, and stop the page before the new
 * run exists. A run the sha listing does not carry yet is read by id, and until
 * one route or the other finds it the poll has nothing to report.
 */
async function selectPolledRun(
  token: string,
  owner: string,
  repo: string,
  runs: WorkflowRun[],
  runIdParam: string | null,
): Promise<WorkflowRun | null> {
  if (!runIdParam) return runs[0] ?? null;
  const wanted = Number(runIdParam);
  return (
    runs.find((run) => run.id === wanted) ??
    (await getWorkflowRun(token, owner, repo, wanted))
  );
}

// ---------------------------------------------------------------------------
// Prepared state
//
// The prepared state and the column-choice challenge round-trip through the
// browser and are untrusted when they come back; both are signed and verified
// in `~/lib/upgrade-signing.server`, which says what each binds and why.
// ---------------------------------------------------------------------------

/**
 * Why a prepared upgrade may not be committed against the latest release, or
 * null when it may. A release published between prepare and commit makes the
 * prepared target an old one, and committing it would leave the site behind
 * while it records itself as upgraded. Read through the content-write gate's
 * tag cache. Prepare reads GitHub directly, so a cache that has not caught up
 * can only make the prepared target look newer, never older: only a target
 * below the latest is refused. An unreadable release refuses too.
 */
async function preparedTargetRefusal(
  target: string,
  token: string,
  releaseTag: string | undefined,
): Promise<"release_unknown" | "prepared_outdated" | null> {
  const latest = await readLatestTag(token, Date.now(), releaseTag);
  if (!latest.ok) return "release_unknown";
  return compareVersions(target, latest.tag) < 0 ? "prepared_outdated" : null;
}

/** The paths a prepare request says its page listed for deletion; a value that is not a list of paths lists none. */
function reviewedDeletionPaths(posted: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(posted);
    return new Set(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * The path a symbolic link among the sheets points to, or a stop naming the
 * link when its blob cannot be read.
 */
async function readLinkBlob(token: string, owner: string, repo: string, entry: SpreadsheetEntry): Promise<string> {
  try {
    return await getBlobText(token, owner, repo, entry.sha);
  } catch {
    throw new UpgradeFileUnreadableError(entry.path);
  }
}

/**
 * The v1.3.0 ingest: the bespoke transforms run over the same virtual
 * filesystem as the manifest chain. v1.3.0's release manifest is
 * operations:[]; the Python reference migration's three conditional
 * transforms (A/B/C) live in v130-ingest.server.ts. The caller gates on
 * compareVersions, not a string compare, which strips the "v" prefix
 * internally but expects parseable input.
 */
async function applyV130Ingest(
  manifestChain: Manifest[],
  manifestResult: ManifestApplyResult,
  language: "en" | "es",
  readSite: (path: string) => Promise<string | null>,
): Promise<void> {
  // Preload the four content files (plus the acerca.md probe) into the Map.
  // collectFilesReferencedByChain does NOT enumerate these for the bespoke
  // transforms. Missing files (404 -> null) leave the Map slot empty;
  // Transform A returns { changed:false, reason: "missing" }.
  for (const path of [
    "index.md",
    "pages/glossary.md",
    "pages/objects.md",
    "telar-content/texts/pages/about.md",
    "telar-content/texts/pages/acerca.md",
  ]) {
    if (!manifestResult.files.has(path)) {
      const content = await readSite(path);
      if (content !== null) manifestResult.files.set(path, content);
    }
  }
  const v130Result: V130IngestResult = await applyV130Transforms(manifestResult.files, language);
  reapplyBuiltInPageEdits(manifestChain, manifestResult.files, language);
  // v130Result.files === manifestResult.files (mutated in place); the
  // additions merge picks up Transform A replacements + Transform C's silent
  // acerca.md creation automatically.
  if (v130Result.changes.length > 0) {
    console.log(
      `[runUpgradePrepare] v130 ingest applied ${v130Result.changes.length} change(s):`,
      v130Result.changes,
    );
  }
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });
  // Captured here, not read as `user.id` inside the nested prepare/commit
  // functions below: TypeScript's narrowing of the null check above does not
  // carry into a separately-declared nested function's body.
  const userId = user.id;

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Every intent acts on the session's site, and only when the page that
  // posted it showed that site.
  const resolved = await resolvePageProject(request, env, user.id, formData);
  if (resolved.kind === "site_changed") {
    return siteChangedAnswer(intent, resolved.currentSiteName);
  }
  if (resolved.kind === "no_project") {
    return { ok: false, intent, error: "no_project" };
  }
  const { project: activeProject, userRole } = resolved;

  // Guard: a publishing role — the roles the group's write-through actions
  // are open to. Every admitted role is named in the set, never inferred.
  await requirePublishingRole(db, activeProject.id, user.id);
  const isConvenorActor = userRole === "convenor";

  const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  const [owner, repo] = activeProject.github_repo_full_name.split("/");

  // runUpgradePrepare — collects everything needed to commit the upgrade:
  // framework tree-diff, manifest chain, referenced file contents, the sheet
  // repair, and the expected HEAD OID. All network I/O happens here. It
  // answers a signed prepared state, or, where the author has to choose
  // between columns, a signed challenge that the next prepare replays.
  /** Each story the project holds, with the answers of the steps the editor lists for it (`step_number > 0`), in `order_key` order. */
  async function projectStorySteps(projectId: number): Promise<Map<string, (string | null)[]>> {
    const rows = await db
      .select({ story: stories.story_id, stepId: steps.id, answer: steps.answer })
      .from(stories)
      .leftJoin(steps, and(eq(steps.story_id, stories.id), gt(steps.step_number, 0)))
      .where(eq(stories.project_id, projectId))
      .orderBy(sql`coalesce(${steps.order_key}, '')`, steps.step_number, steps.id);
    const byStory = new Map<string, (string | null)[]>();
    for (const row of rows) {
      const answers = byStory.get(row.story) ?? [];
      byStory.set(row.story, answers);
      if (row.stepId !== null) answers.push(row.answer);
    }
    return byStory;
  }

  async function runUpgradePrepare(
    operationId: string | undefined,
    posted: { challenge: string | null; choices: string | null; sheets: string | null; deletions: string | null },
  ): Promise<PrepareAnswer> {
    const challenge = await readPostedChallenge(posted.challenge, activeProject.id, userId, env.SESSION_SECRET);
    if (challenge === "invalid") return { ok: false, error: "invalid_upgrade_challenge" };
    try {
      // Reads of the project's own repo run under the installation token —
      // see the loader's resolveProjectToken call for why. fetchLatestRelease
      // and computeUpgradeDiff's framework-side reads stay on the user
      // token: an installation token cannot reach a repo (UCSB-AMPLab/telar)
      // outside its own installation's grant.
      const projectToken = await resolveProjectToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        activeProject.installation_id,
        token,
        userRole,
      );

      // A target release that cannot be read, an error status or a network
      // throw alike, stops prepare before anything is read from the site.
      let latestRelease: TelarRelease;
      try {
        latestRelease = await fetchLatestRelease(token, env.TELAR_RELEASE_TAG);
      } catch (err) {
        console.error("[runUpgradePrepare] target release unreadable:", err);
        return { ok: false, error: "release_unknown" };
      }
      // Capture HEAD OID first and read the tree at it, so the diff is taken
      // of the revision the commit is made on. The OID also goes to
      // commitFilesToRepo below, to stop a second upgrade path (e.g. GitHub
      // Actions, another client) from racing this commit. A tree read without
      // a ref takes the default branch, which need not be main.
      const expectedHeadOid = await getRepoHead(projectToken, owner, repo, "main");
      const { tree: userTree, truncated: userTreeTruncated } = await getRepoTree(
        projectToken,
        owner,
        repo,
        expectedHeadOid,
      );
      const diff = await computeUpgradeDiff(token, userTree, latestRelease.tagName, {
        userTreeTruncated,
      });

      // Every site read is at the head the tree was listed at, so a push
      // after listing does not change what prepare sees; the commit is made
      // against the same head and is refused as stale if it moved.
      const site = siteFileReads((path) =>
        getFileAtRef(projectToken, owner, repo, path, expectedHeadOid, { strict: true }),
      );

      const configContent = await site.read("_config.yml");
      if (!configContent) {
        return {
          ok: false,
          error: "upgrade_failed",
          message:
            "_config.yml not found — upgrade requires a valid site configuration.",
        };
      }

      const configRows = await db
        .select({ telar_version: project_config.telar_version })
        .from(project_config)
        .where(eq(project_config.project_id, activeProject.id))
        .limit(1);
      const oldVersion = configRows[0]?.telar_version ?? "unknown";

      // Exact-string-equality chain discovery — normalise both sides.
      const fromVersion = (oldVersion ?? "").replace(/^v/, "");
      const toVersion = frameworkVersionForTag(latestRelease.tagName);

      let manifestChain: Manifest[];
      try {
        manifestChain = await loadManifestChain(
          token,
          fromVersion,
          toVersion,
          env.TELAR_RELEASE_TAG || undefined,
        );
      } catch (err) {
        const unreadable = readFailure(err);
        if (unreadable) {
          console.error("[runUpgradePrepare] release discovery failed:", err);
          return unreadable;
        }
        // Missing release-asset manifest — fail closed, no commit.
        console.error(
          `[runUpgradePrepare] loadManifestChain failed (${fromVersion} -> ${toVersion}):`,
          err,
        );
        return {
          ok: false,
          error: "missing_manifest",
          message: err instanceof Error ? err.message : "Missing migration manifest",
        };
      }

      // The date comes from the chain, so the config is patched once the
      // chain is loaded. The framework's _config.yml convention is
      // `version: "X.Y.Z"` without the "v" prefix; latestRelease.tagName
      // carries the GitHub tag format ("v1.2.0"), so the leading v is
      // stripped before it is written into the telar block.
      const releaseDate = releaseDateForUpgrade(manifestChain, latestRelease.publishedAt);
      const patchedConfig = updateTelarVersionInConfig(
        configContent,
        frameworkVersionForTag(latestRelease.tagName),
        releaseDate,
      );

      const langMatch = patchedConfig.match(/^\s*telar_language:\s*["']?([a-z]{2})/m);
      const language: "en" | "es" = langMatch?.[1] === "es" ? "es" : "en";

      // BLOCKER fix: seed _config.yml with patchedConfig (version-bumped),
      // NOT configContent (pre-upgrade). The manifest runner's output therefore
      // carries BOTH the telar.version bump AND the DSL transforms.
      const manifestFiles = new Map<string, string>();
      manifestFiles.set("_config.yml", patchedConfig);

      const referenced = collectFilesReferencedByChain(manifestChain);
      for (const path of referenced) {
        if (manifestFiles.has(path)) continue;
        const content = await site.read(path);
        if (content !== null) manifestFiles.set(path, content);
      }

      let manifestResult: ManifestApplyResult;
      try {
        manifestResult = applyManifestChain(manifestChain, manifestFiles, language);
      } catch (err) {
        // Runner scope allowlist or other runtime error — fail closed.
        console.error(
          `[runUpgradePrepare] applyManifestChain failed (${fromVersion} -> ${toVersion}):`,
          err,
        );
        return manifestFailure(err);
      }

      if (compareVersions(`v${toVersion}`, "v1.3.0") >= 0) {
        await applyV130Ingest(manifestChain, manifestResult, language, (path) => site.read(path));
      }

      // Framework-owned frontmatter on the built-in pages, on every upgrade:
      // the pages are author-editable and never delivered whole, so a key the
      // framework adds to them reaches a site only this way. A release copy
      // that cannot be read, a network throw included, stops prepare.
      const builtInPages = await applyBuiltInPageFrontmatter(manifestResult.files, {
        site: (path) => site.read(path),
        target: (path) =>
          fetchFrameworkFile(token, path, latestRelease.tagName).catch(() => ({ kind: "failed" as const })),
      });
      if (builtInPages.unread.length > 0) {
        return {
          ok: false,
          error: "release_file_unreadable",
          detail: { path: builtInPages.unread[0], version: frameworkVersionForTag(latestRelease.tagName) },
        };
      }
      // The sheets the 1.8.0 build would refuse, repaired, after the chain,
      // whose edit of project.csv is what the repair reads.
      const sheets = await runSheetStage({
        listEntries: () =>
          listSpreadsheetEntries(userTree, userTreeTruncated, (dir) =>
            listDirectoryEntries(projectToken, owner, repo, expectedHeadOid, dir),
          ),
        readRaw: (path) => site.readKeepingMark(path),
        targetExists: fileAtHead(userTree, userTreeTruncated, (path) => site.readKeepingMark(path)),
        readLinkTarget: (entry) => readLinkBlob(projectToken, owner, repo, entry),
        readTabs: readPublishedTabs,
        chainFiles: manifestResult.files,
        targetTag: latestRelease.tagName,
        headOid: expectedHeadOid,
        challenge,
        submitted: parsePostedChoices(posted.choices),
        sheetsAnswer: posted.sheets,
      });
      if (sheets.kind !== "ready") return sheetStageStop(sheets, activeProject.id, userId, env.SESSION_SECRET);
      // A site that stops reading Google Sheets commits `_config.yml` switched
      // off; the post-upgrade steps follow this, not the settings read before.
      if (sheets.sheetsOff) manifestResult.files.set("_config.yml", sheets.sheetsOff.config);
      const readsGoogleSheetsAfter = isGoogleSheetsOn(manifestResult.files.get("_config.yml") ?? "");
      const sheetsDeleted = sheets.sheetsOff?.deleted ?? [];
      const headConfigOff = new Map<string, string>();
      if (sheets.sheetsOff) {
        const off = sheetsOffConfig(configContent);
        if (off === null) return { ok: false, error: "sheets_switch_unreadable" };
        headConfigOff.set("_config.yml", off);
        site.restoreMarks(headConfigOff);
      }

      // Every transform above has run on text without a byte-order mark; a
      // file that had one is written with it.
      site.restoreMarks(manifestResult.files);

      // Manifest-runner output overwrites the tree diff's copy of a path
      // (version-bumped _config.yml is preserved), a deleted path is never
      // also added, and the deletions are the ones the site's tree has.
      const merged = mergeUpgradeChanges(diff, manifestResult, {
        tree: userTree,
        truncated: userTreeTruncated,
      });

      // The page listed the deletions its author reviewed. Prepare refuses to
      // delete a path outside that list; a listed path prepare does not delete
      // (a file that has since gone) is not a reason to refuse. A request that
      // carries no list is not checked.
      if (posted.deletions !== null) {
        const reviewed = reviewedDeletionPaths(posted.deletions);
        if (merged.deletions.some((path) => !reviewed.has(path))) return { ok: false, error: "deletions_changed" };
      }

      const preparedContent: PreparedUpgradeContent = {
        additions: withRepairedSheets(merged.additions, sheets.writes).filter((a) => !sheetsDeleted.includes(a.path)),
        deletions: [...new Set([...merged.deletions, ...sheetsDeleted])],
        expectedHeadOid,
        commitMessage: `Upgrade Telar from ${oldVersion} to ${toVersion}`,
        commitBody: `Upgraded via Telar Compositor\n\nSee release notes: https://github.com/UCSB-AMPLab/telar/releases/tag/${latestRelease.tagName}`,
        newVersion: latestRelease.tagName,
        toVersion,
        manualSteps: manifestResult.manualSteps,
        sheetReport: sheets.report,
        sheetsClean: sheets.clean,
        decisions: sheets.decisions,
        advancesHead: sheets.advancesHead,
        tabsChecked: sheets.tabsChecked,
        sheetsOff: sheets.sheetsOff && { written: sheets.sheetsOff.written, deleted: sheets.sheetsOff.deleted },
        readsGoogleSheetsAfter,
        sheetsOffHeadConfig: headConfigOff.get("_config.yml") ?? null,
        answers: upgradeStartsCuttingAnswers(oldVersion, latestRelease.tagName)
          ? answersPublishedDifferently(
              sheets.finalSheets,
              await projectStorySteps(activeProject.id),
              sheets.finalSheets.some((s) => s.role === "glossary")
                ? []
                : await readGlossaryFiles(
                    userTree,
                    userTreeTruncated,
                    (dir) => listDirectoryEntries(projectToken, owner, repo, expectedHeadOid, dir),
                    (path) => site.readKeepingMark(path),
                  ),
            )
          : [],
        operationId,
      };
      const prepared = await signPreparedUpgrade(preparedContent, activeProject.id, userId, env.SESSION_SECRET);
      return { ok: true, answer: "ready", prepared };
    } catch (err) {
      const unreadable = readFailure(err);
      if (unreadable) {
        console.error("[runUpgradePrepare] read failed:", err);
        return unreadable;
      }
      console.error("[runUpgradePrepare] unhandled error:", err);
      return {
        ok: false,
        error: "upgrade_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  // The `insufficient_permissions` response: the re-auth link goes only to
  // the convenor, because /settings/installations/<id> can only be acted on
  // by the account that installed the App. A collaborator gets a distinct
  // code and no link — the grant is the convenor's to give, not theirs to
  // fetch.
  function insufficientPermissionsResult(installationId: number) {
    return isConvenorActor
      ? {
          ok: false as const,
          error: "insufficient_permissions",
          reauthUrl: `https://github.com/settings/installations/${installationId}`,
        }
      : {
          ok: false as const,
          error: "insufficient_permissions_convenor_required",
        };
  }

  /**
   * Sets the site's settings to Google Sheets off, once the commit carrying
   * `_config.yml` switched off has landed. `repairSiteConfig` never throws.
   */
  async function settingsFollowSheetsOff(prepared: PreparedUpgrade): Promise<void> {
    if (prepared.sheetsOff) await repairSiteConfig(db, env as never, activeProject.id, { google_sheets_enabled: false });
  }

  /**
   * Records `toSha` as synced, from the prepared head, unless the upgrade
   * wrote a value the editor holds (`advancesHead`).
   */
  async function recordUpgradeHead(prepared: PreparedUpgrade, toSha: string): Promise<void> {
    if (prepared.advancesHead) await bumpProjectHeadFrom(db, activeProject.id, prepared.expectedHeadOid, toSha);
  }

  // runUpgradeCommit — takes a prepared upgrade payload and performs the
  // installation-token commit + D1 updates. StaleHeadError surfaces as a
  // typed error so the client can offer re-sync.
  async function runUpgradeCommit(prepared: PreparedUpgrade): Promise<
    | ({
        ok: true;
        newHeadSha: string;
        newVersion: string;
        owner: string;
        repo: string;
        manualSteps: Record<Language, ManualStep[]>;
      } & UpgradeOutcome)
    | { ok: false; error: string; message?: string; reauthUrl?: string }
  > {
    try {
      // Verify before anything is minted or committed: preparedState is
      // untrusted input (see the prepared-state-signing section comment
      // above). Always the project/user THIS request itself resolved to,
      // never anything read back from `prepared`. Throws
      // InvalidPreparedStateError on failure, caught below — no result to
      // branch on and no way past this line without a verified signature.
      await assertPreparedUpgradeSignature(
        prepared,
        activeProject.id,
        userId,
        env.SESSION_SECRET,
      );

      const targetRefusal = await preparedTargetRefusal(prepared.newVersion, token, env.TELAR_RELEASE_TAG);
      if (targetRefusal) return { ok: false, error: targetRefusal };

      const installToken = await getInstallationToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        activeProject.installation_id,
      );

      // Split the upgrade so a .github/workflows/ rejection can't zero the
      // rest. GitHub rejects an ENTIRE commit that touches a workflow file
      // when the install lacks workflows:write (the v1.5.0 accept-gap), so a
      // single atomic commit of all ~141 files would lose the 138 content
      // files too. We therefore land the content first (plain contents:write),
      // then commit the workflow files together with the version-bumped
      // _config.yml. Holding the version bump in this second commit means that
      // if it is rejected, the site's recorded version stays behind, the
      // upgrade re-prompt re-fires, and the next attempt's diff narrows to just
      // the workflow files. The compositor keeps delivering workflows via the
      // App token — this only stops one rejection from discarding everything.
      const partition = partitionWorkflowFiles(
        prepared.additions,
        prepared.deletions,
      );

      let newHeadSha: string;
      let versionLanded: boolean;

      if (!partition.hasWorkflows) {
        // No workflow files — a single atomic commit is sufficient and keeps
        // the version bump and content together (unchanged behaviour).
        const result = await commitFilesToRepo(
          installToken,
          owner,
          repo,
          "main",
          prepared.additions,
          prepared.commitMessage,
          prepared.commitBody,
          prepared.deletions,
          undefined, // skipCi
          prepared.expectedHeadOid,
        );
        newHeadSha = result.newHeadSha;
        versionLanded = true;
        await settingsFollowSheetsOff(prepared);
      } else {
        // Hold _config.yml back with the workflow files so the version bump
        // only lands when the workflows do.
        const configEntry = partition.contentAdditions.find(
          (a) => a.path === "_config.yml",
        );
        // A site that stops reading Google Sheets has `_config.yml` switched
        // off in this commit too, at its old version: the tabs it saves must
        // never be on the site while the build still fetches over them.
        const contentAdditions = [
          ...partition.contentAdditions.filter((a) => a.path !== "_config.yml"),
          ...(prepared.sheetsOffHeadConfig === null ? [] : [{ path: "_config.yml", content: prepared.sheetsOffHeadConfig }]),
        ];

        // Commit 1 — content. Skip CI: the build should run on the complete
        // state (commit 2), and if commit 2 is rejected we deliberately do not
        // deploy a half-upgraded site. Skipped entirely if there is nothing
        // but workflows + _config.yml to land.
        let contentHeadSha = prepared.expectedHeadOid;
        if (contentAdditions.length > 0 || partition.contentDeletions.length > 0) {
          const contentResult = await commitFilesToRepo(
            installToken,
            owner,
            repo,
            "main",
            contentAdditions,
            prepared.commitMessage,
            prepared.commitBody,
            partition.contentDeletions,
            true, // skipCi — build runs on the final (workflow) commit
            prepared.expectedHeadOid,
          );
          contentHeadSha = contentResult.newHeadSha;
          await settingsFollowSheetsOff(prepared);
        }

        // Commit 2 — workflow files + the held version-bumped _config.yml.
        // Chained onto commit 1's new head. If this is rejected for missing
        // workflows:write, the content above stays committed.
        const workflowAdditions = [
          ...partition.workflowAdditions,
          ...(configEntry ? [configEntry] : []),
        ];
        try {
          const workflowResult = await commitWorkflowFilesWithRetry(
            installToken,
            owner,
            repo,
            "main",
            workflowAdditions,
            `Update Telar workflows for ${prepared.newVersion}`,
            prepared.commitBody,
            partition.workflowDeletions,
            undefined, // skipCi — this commit triggers the build
            contentHeadSha,
          );
          newHeadSha = workflowResult.newHeadSha;
          versionLanded = true;
        } catch (workflowErr) {
          if (workflowErr instanceof StaleHeadError) throw workflowErr;
          const wfMsg =
            workflowErr instanceof Error ? workflowErr.message : String(workflowErr);
          console.error("[runUpgradeCommit] workflow commit failed:", wfMsg);
          if (!wfMsg.includes("Resource not accessible by integration")) {
            throw workflowErr;
          }
          // Workflow permission missing: content already landed, version held.
          // Record the content head so D1 doesn't go stale, then surface the
          // permission error so the banner + modal prompt whoever can approve
          // it to do so. It advances only from the prepared head, the one the
          // diff was read at and commit 1 was built on, and only when the
          // content changes no value the editor holds (`advancesHead`).
          try {
            await recordUpgradeHead(prepared, contentHeadSha);
          } catch (d1Err) {
            console.error("D1 head bump after partial upgrade failed:", d1Err);
          }
          return insufficientPermissionsResult(activeProject.installation_id);
        }
      }

      const now = new Date().toISOString();

      // Commit already landed; D1 failure must not report upgrade_failed.
      // The head advances only from the prepared head: every commit between
      // it and newHeadSha is this upgrade's own (commit 2 is chained on
      // commit 1, which is built on the prepared head), and any other head
      // recorded meanwhile is kept. It does not advance when the upgrade
      // wrote a value the editor holds — a column the author chose over
      // another holding values — so the sync, which is three-way against the
      // recorded head, offers that value to the editor before the next
      // publish can write the editor's over it; publish refuses as
      // `stale_head` until then.
      try {
        if (versionLanded) {
          await db
            .update(project_config)
            .set({ telar_version: prepared.toVersion, updated_at: now })
            .where(eq(project_config.project_id, activeProject.id));
        }
        await recordUpgradeHead(prepared, newHeadSha);
      } catch (d1Err) {
        console.error("D1 update after upgrade commit failed:", d1Err);
      }

      // The upgrade does not rewrite the project's landing copy in D1, and it
      // does not need to. Three other places already hold that line:
      // `_app.homepage.tsx`'s loader shows the lang-pack canned text whenever
      // landing.welcome_body is empty, carries the v1.3.0 liquid block, or
      // carries the v1.2.1 English literal; the publish gate stops stale D1
      // from re-emitting English; and import recognises the liquid block, so a
      // re-sync after this upgrade leaves D1 clean. On the live site the
      // English is closed by the framework upgrade this commit just landed.
      return {
        ok: true,
        newHeadSha,
        newVersion: prepared.newVersion,
        owner,
        repo,
        manualSteps: prepared.manualSteps,
        sheetReport: prepared.sheetReport,
        advancesHead: prepared.advancesHead,
        answers: prepared.answers,
        sheetsOff: prepared.sheetsOff,
        readsGoogleSheetsAfter: prepared.readsGoogleSheetsAfter,
      };
    } catch (err) {
      if (err instanceof StaleHeadError) {
        console.error("[runUpgradeCommit] stale head:", err.message);
        return { ok: false, error: "stale_head" };
      }
      // Already logged with project id, user id and the verification-failure
      // reason inside assertPreparedUpgradeSignature — re-thrown here only to
      // reach this catch, so it is mapped to its refusal directly rather than
      // falling into the GitHub-message classification below (whose
      // "Resource not accessible by integration" substring match a
      // verification-failure reason could otherwise happen to contain).
      if (err instanceof InvalidPreparedStateError) {
        return { ok: false, error: "invalid_prepared_state" };
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      // Log the raw GitHub error before classifying it. The verbatim GraphQL
      // message is the only thing that separates "Resource not accessible by
      // integration" from a workflow-specific guard message, and the
      // insufficient_permissions branch below discards it — so the log has to
      // come first, unconditionally, for the cause to be recoverable from
      // worker logs.
      console.error("[runUpgradeCommit] commit failed:", message);
      // GitHub returns "Resource not accessible by integration" when the App
      // lacks a permission required for the commit (e.g. workflows: write).
      // Surface a targeted error with a per-install re-auth URL so the client
      // can route the user to the permissions review screen instead of a
      // generic failure.
      if (message.includes("Resource not accessible by integration")) {
        // The bare installation URL is the whole path for a user-account
        // install: GitHub has no `/permissions` sub-path, and appending one
        // 404s. (Org installs live at
        // /organizations/<org>/settings/installations/<id> — not handled
        // here; that needs target_type, which this path does not carry.)
        return insufficientPermissionsResult(activeProject.installation_id);
      }
      console.error("[runUpgradeCommit] unhandled error:", err);
      return {
        ok: false,
        error: "upgrade_failed",
        message,
      };
    }
  }

  // Publishing-role gate — enforced above via requirePublishingRole(). No spoofable path.
  switch (intent) {
    case "upgrade-prepare": {
      const operationId = await beginUpgradeLease(env, activeProject.id, userId);
      if (operationId === null) return { ok: false, intent: "upgrade-prepare", error: "operation_in_progress" };
      const res = await runUpgradePrepare(operationId, {
        challenge: formData.get("challenge") as string | null,
        choices: formData.get("choices") as string | null,
        sheets: formData.get("sheets") as string | null,
        deletions: formData.get("deletions") as string | null,
      });
      // Only a prepared upgrade holds the lease, until its commit or its
      // cancel; a question for the author ends it, as a failure does, and the
      // prepare that answers the question begins a new one.
      if (!holdsPreparedLease(res)) await endUpgradeLease(env, activeProject.id, userId, operationId, "failed");
      if (!res.ok) {
        return { ok: false, intent: "upgrade-prepare", error: res.error, message: res.message, detail: res.detail };
      }
      return { ...res, intent: "upgrade-prepare" };
    }

    // The author declined a prepared upgrade on the confirmation screen.
    case "upgrade-cancel": {
      const operation = postedLeaseOperation(formData.get("preparedState") as string | null);
      await endUpgradeLease(env, activeProject.id, userId, operation, "failed");
      return { ok: true, intent: "upgrade-cancel" };
    }

    case "upgrade-commit": {
      const preparedJson = formData.get("preparedState") as string | null;
      if (!preparedJson) {
        return { ok: false, intent: "upgrade-commit", error: "missing_prepared_state" };
      }
      let prepared: PreparedUpgrade;
      try {
        prepared = JSON.parse(preparedJson) as PreparedUpgrade;
      } catch {
        return { ok: false, intent: "upgrade-commit", error: "invalid_prepared_state" };
      }
      // Read defensively: the payload is the page's, and valid JSON need not
      // be an object.
      const leaseOperation = (prepared as Partial<PreparedUpgrade> | null)?.operationId;
      if (!(await holdUpgradeLease(env, activeProject.id, userId, leaseOperation))) {
        return { ok: false, intent: "upgrade-commit", error: "operation_in_progress" };
      }
      const res = await runUpgradeCommit(prepared);
      if (!res.ok) {
        await endUpgradeLease(env, activeProject.id, userId, leaseOperation, "failed");
        return { ok: false, intent: "upgrade-commit", error: res.error, message: res.message, reauthUrl: res.reauthUrl };
      }
      await endUpgradeLease(env, activeProject.id, userId, leaseOperation, "succeeded");
      const { newHeadSha, newVersion, manualSteps, sheetReport, advancesHead, answers, sheetsOff, readsGoogleSheetsAfter } = res;
      return {
        ok: true,
        intent: "upgrade-commit",
        newHeadSha,
        newVersion,
        owner,
        repo,
        manualSteps,
        sheetReport,
        advancesHead,
        answers,
        sheetsOff,
        readsGoogleSheetsAfter,
      };
    }

    case "poll-build": {
      const sha = formData.get("sha") as string | null;
      const runIdParam = formData.get("runId") as string | null;

      if (!sha) {
        return { ok: false, intent: "poll-build", error: "missing_sha" };
      }

      try {
        // The build's Actions data is a read of the project's own repo — same
        // reasoning as runUpgradePrepare.
        const projectToken = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          token,
          userRole,
        );
        const runs = await listWorkflowRunsBySha(projectToken, owner, repo, sha);
        const run = await selectPolledRun(projectToken, owner, repo, runs, runIdParam);

        if (!run) {
          return {
            ok: true,
            intent: "poll-build",
            buildStatus: "pending",
            buildConclusion: null,
            buildUrl: null,
            runId: null,
            phases: null,
          };
        }

        const phases = runIdParam
          ? mapStepsToBuildPhases(await getJobSteps(projectToken, owner, repo, run.id))
          : null;

        return {
          ok: true,
          intent: "poll-build",
          buildStatus: run.status,
          buildConclusion: run.conclusion,
          buildUrl: run.html_url,
          runId: run.id,
          phases,
        };
      } catch (err) {
        return {
          ok: false,
          intent: "poll-build",
          error: "poll_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "rebuild": {
      return runSiteBuild(
        env,
        activeProject.installation_id,
        token,
        isConvenorActor,
        owner,
        repo,
      );
    }

    case "compute-diff": {
      // Re-fetch diff for refresh/retry
      try {
        // Same reasoning as runUpgradePrepare: the project's own repo tree
        // reads under the installation token, the framework repo read stays
        // on the user token.
        const projectToken = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          token,
          userRole,
        );
        const latestRelease = await fetchLatestRelease(token, env.TELAR_RELEASE_TAG);
        // The diff prepare commits is of main's head, which need not be the
        // default branch.
        const head = await getRepoHead(projectToken, owner, repo, "main");
        const { tree: userTree, truncated: userTreeTruncated } = await getRepoTree(
          projectToken,
          owner,
          repo,
          head,
        );
        const diff = await computeUpgradeDiff(token, userTree, latestRelease.tagName, {
          userTreeTruncated,
        });
        return { ok: true, intent: "compute-diff", diff, latestRelease };
      } catch (err) {
        return {
          ok: false,
          intent: "compute-diff",
          error: "compute_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    default:
      return { ok: false, intent, error: "unknown_intent" };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What a landed upgrade did to the site's sheets, whether it recorded itself as synced, and the answers it publishes differently. */
interface UpgradeOutcome {
  sheetReport: SheetReportLine[];
  advancesHead: boolean;
  answers: UpgradeAnswer[];
  sheetsOff: PreparedUpgradeContent["sheetsOff"];
  readsGoogleSheetsAfter: boolean;
}

/** Prepare's answer when the sheet stage stops it or asks the author, with the question's challenge signed. */
async function sheetStageStop(
  sheets: Exclude<SheetStageResult, { kind: "ready" }>,
  projectId: number,
  userId: number,
  sessionSecret: string,
): Promise<PrepareAnswer> {
  if (sheets.kind === "failed") return { ok: false, error: sheets.error, detail: sheets.detail };
  const challenge = await signUpgradeChallenge(sheets.challenge, projectId, userId, sessionSecret);
  if (sheets.kind === "needs_sheets_decision") {
    return { ok: true, answer: "needs_sheets_decision", challenge, detail: sheets.detail, notice: sheets.notice };
  }
  return { ok: true, answer: "needs_choices", challenge, groups: sheets.groups, notice: sheets.notice };
}

/** Whether a prepare's answer keeps its lease: only a prepared upgrade does. */
function holdsPreparedLease(answer: PrepareAnswer): boolean {
  return answer.ok && answer.answer === "ready";
}

/** The lease a posted prepared state names, read defensively: the payload is the page's. */
function postedLeaseOperation(raw: string | null): unknown {
  try {
    return (JSON.parse(raw ?? "null") as Partial<PreparedUpgrade> | null)?.operationId;
  } catch {
    return null;
  }
}

type PrepareAnswer =
  | { ok: true; answer: "ready"; prepared: PreparedUpgrade }
  | { ok: true; answer: "needs_choices"; challenge: SignedUpgradeChallenge; groups: OfferedGroup[]; notice: ChoiceNotice | null }
  | { ok: true; answer: "needs_sheets_decision"; challenge: SignedUpgradeChallenge; detail: TabsRefused; notice: "sheets_changed" | null }
  | { ok: false; error: string; message?: string; detail?: UpgradeFailureDetail };

type CommittedUpgrade = {
  ok: true;
  intent: "upgrade-commit";
  newHeadSha: string;
  newVersion: string;
  owner: string;
  repo: string;
  manualSteps: Record<Language, ManualStep[]>;
} & UpgradeOutcome;

type UpgradeActionData =
  | ({ intent: "upgrade-prepare" } & Extract<PrepareAnswer, { ok: true }>)
  | { ok: false; intent: "upgrade-prepare"; error: string; message?: string; detail?: UpgradeFailureDetail }
  | CommittedUpgrade
  | { ok: false; intent: "upgrade-commit"; error: string; message?: string; reauthUrl?: string }
  | { ok: true; intent: "upgrade-cancel" }
  | { ok: true; intent: "poll-build"; buildStatus: string; buildConclusion: string | null; buildUrl: string | null; runId: number | null; phases: BuildPhaseStatus[] | null }
  | { ok: false; intent: "poll-build"; error: string; message?: string }
  | { ok: true; intent: "compute-diff"; diff: UpgradeDiff; latestRelease: TelarRelease }
  | { ok: false; intent: "compute-diff"; error: string; message?: string }
  | RebuildResult
  | { ok: false; intent: string; error: string }
  | null
  | undefined;

type UpgradeStage = UpgradeFlowStage;

/** The failures the review stage names; anything else reads as a generic failure. */
const NAMED_UPGRADE_FAILURES: ReadonlySet<string> = new Set([
  "stale_head",
  "prepared_outdated",
  "deletions_changed",
  "release_unknown",
  "insufficient_permissions",
  "insufficient_permissions_convenor_required",
  "operation_in_progress",
  "config_exclude_unreadable",
  "upgrade_file_unreadable",
  "upgrade_file_not_text",
  "release_file_unreadable",
  "release_tree_unreadable",
  "release_manifest_invalid",
  "release_list_unreadable",
  "sheet_unreadable_for_repair",
  "sheet_reserved_column",
  "sheet_rows_changed",
  "invalid_upgrade_challenge",
  "published_sheet_unreadable",
  "published_tab_unreadable",
  "sheets_columns_refused",
  "sheets_switch_unreadable",
]);

/**
 * The refusals the review screen explains in one sentence, by failure code.
 * A missing App permission when the acting user is not the convenor has no
 * link, because /settings/installations/<id> can only be worked by the
 * account that installed the App. The operation lock is another member's
 * publish, upgrade or upload. A prepared target a newer release overtook, and
 * a release that could not be read, stop the commit before anything changes.
 * A list the manifest could not add to names its file, key and values, from
 * the failure's detail. A site file prepare could not read, or whose bytes
 * are not text, names its path. A release file that could not be read names
 * its path and the release's version; a release whose tree could not be read
 * whole, or whose migration.json does not validate, names the version; an
 * unreadable release listing names nothing. A sheet the 1.8.0 build would
 * refuse and the upgrade cannot repair names the sheet and the change the
 * author has to make on GitHub, which is temporary: the remedy belongs in the
 * Compositor (see `stopFor` in `~/lib/upgrade-sheets.server`). A column
 * removal that would change the rows has one message for each reason. A challenge that does not verify asks the author to
 * start again. A published tab that could not be read is named, and a
 * published sheet that could not be read as a whole is not; tabs the 1.8.0
 * build would refuse are named, to be fixed in Google Sheets, with their
 * colliding columns listed under the message. A tab whose repair would stop
 * the upgrade anyway has messages of its own (TAB_NOTICES), which send the
 * author to Google Sheets rather than GitHub.
 */
const UPGRADE_NOTICES: Readonly<Record<string, string>> = {
  insufficient_permissions_convenor_required: "insufficientPermissionsConvenorRequired",
  operation_in_progress: "operationInProgress",
  prepared_outdated: "preparedOutdated",
  deletions_changed: "deletionsChanged",
  release_unknown: "releaseUnknown",
  config_exclude_unreadable: "configExcludeUnreadable",
  upgrade_file_unreadable: "upgradeFileUnreadable",
  upgrade_file_not_text: "upgradeFileNotText",
  release_file_unreadable: "releaseFileUnreadable",
  release_tree_unreadable: "releaseTreeUnreadable",
  release_manifest_invalid: "releaseManifestInvalid",
  release_list_unreadable: "releaseListUnreadable",
  sheet_unreadable_for_repair: "sheetUnreadableForRepair",
  sheet_reserved_column: "sheetReservedColumn",
  sheet_rows_changed: "sheetRowsChanged_rows_changed",
  invalid_upgrade_challenge: "invalidUpgradeChallenge",
  published_sheet_unreadable: "publishedSheetUnreadable",
  published_tab_unreadable: "publishedTabUnreadable",
  sheets_columns_refused: "sheetsColumnsRefused",
  sheets_switch_unreadable: "sheetsSwitchUnreadable",
};

/** A column removal that would change the rows: one message for each reason. */
const ROWS_CHANGED_NOTICES: Readonly<Record<string, string>> = {
  rows_changed: "sheetRowsChanged_rows_changed",
  header_row: "sheetRowsChanged_header_row",
  unsafe: "sheetRowsChanged_unsafe",
};

/** The same stops for a published tab. */
const TAB_NOTICES: Readonly<Record<string, string>> = {
  sheet_unreadable_for_repair: "tabUnreadableForRepair",
  sheet_reserved_column: "tabReservedColumn",
};
const TAB_ROWS_CHANGED_NOTICES: Readonly<Record<string, string>> = {
  rows_changed: "tabRowsChanged_rows_changed",
  header_row: "tabRowsChanged_header_row",
  unsafe: "tabRowsChanged_unsafe",
};

/** The notice for a failure code, by whether its sheet is a published tab and by its reason where it has one. */
function noticeKey(code: string, detail: UpgradeFailureDetail | null): string {
  const fromTab = detail !== null && "tab" in detail && detail.tab === true;
  const reason = detail && "reason" in detail ? detail.reason : undefined;
  const byReason = fromTab ? TAB_ROWS_CHANGED_NOTICES : ROWS_CHANGED_NOTICES;
  return (reason && byReason[reason]) || (fromTab && TAB_NOTICES[code]) || UPGRADE_NOTICES[code];
}

function upgradeFailureCode(error: string): string {
  return NAMED_UPGRADE_FAILURES.has(error) ? error : "upgrade_failed";
}

/**
 * What a named failure's message names: a list operation's file, key and
 * values, or the path, release version or both of a read that failed.
 */
type UpgradeFailureDetail =
  | { file: string; key: string; values: string[] }
  | { path: string; version?: string }
  | { version: string }
  | { sheet: string; column?: string; columns?: string; reason?: string; tab?: true }
  | { name: string }
  | TabsRefused;

/**
 * The prepare failure a read that could not be completed becomes: the site
 * file, release file, release tree or release manifest it names, or the
 * release listing. Null for any other throw.
 */
function readFailure(err: unknown): { ok: false; error: string; detail?: UpgradeFailureDetail } | null {
  if (err instanceof UpgradeFileUnreadableError) {
    return { ok: false, error: "upgrade_file_unreadable", detail: { path: err.path } };
  }
  if (err instanceof UpgradeFileNotTextError) {
    return { ok: false, error: "upgrade_file_not_text", detail: { path: err.path } };
  }
  if (err instanceof ReleaseFileUnreadableError) {
    return { ok: false, error: "release_file_unreadable", detail: { path: err.path, version: err.version } };
  }
  if (err instanceof ReleaseTreeUnreadableError) {
    return { ok: false, error: "release_tree_unreadable", detail: { version: err.version } };
  }
  if (err instanceof ReleaseManifestInvalidError) {
    return { ok: false, error: "release_manifest_invalid", detail: { version: err.version } };
  }
  if (err instanceof ReleaseListUnreadableError) return { ok: false, error: "release_list_unreadable" };
  if (err instanceof PublishedSheetUnreadableError) {
    if (err.tab === null) return { ok: false, error: "published_sheet_unreadable" };
    return { ok: false, error: "published_tab_unreadable", detail: { name: err.tab } };
  }
  return null;
}

/**
 * The prepare failure a throw from the manifest chain becomes. A list the
 * chain could not add to because the key holds a mapping is named, with what
 * it was adding, since the author has to turn it into a list; any other throw,
 * other list refusals included, is `manifest_failed`, which the page shows as
 * the generic failure.
 */
function manifestFailure(err: unknown): { ok: false; error: string; message: string; detail?: UpgradeFailureDetail } {
  if (err instanceof YamlListAddError && err.kind === "mapping") {
    return {
      ok: false,
      error: "config_exclude_unreadable",
      message: err.message,
      detail: { file: err.file, key: err.key, values: err.values },
    };
  }
  return { ok: false, error: "manifest_failed", message: err instanceof Error ? err.message : "Manifest application failed" };
}

/** A failure's detail as the interpolation its notice takes, or none. */
function noticeValues(detail: UpgradeFailureDetail | null): Record<string, string | number> | undefined {
  if (!detail) return undefined;
  if ("file" in detail) return { file: detail.file, key: detail.key, values: detail.values.join(", ") };
  if ("tabs" in detail) return { tabs: detail.tabs, count: detail.count };
  if ("sheet" in detail) {
    const { sheet, column, columns } = detail;
    return { sheet, ...(column !== undefined ? { column } : {}), ...(columns !== undefined ? { columns } : {}) };
  }
  if ("name" in detail) return { name: detail.name };
  return {
    ...("path" in detail ? { path: detail.path } : {}),
    ...(detail.version !== undefined ? { version: detail.version } : {}),
  };
}

/** The detail an upgrade action's failure carries, when it has one. */
function failureDetail(data: object): UpgradeFailureDetail | null {
  return "detail" in data ? ((data.detail as UpgradeFailureDetail | undefined) ?? null) : null;
}
type UpgradeSubStage = "preparing" | "committing";

/** The two ways a rebuild can end without a run to follow. */
type RebuildNotice = "rebuild_failed" | "rebuild_unconfirmed";

// ---------------------------------------------------------------------------
// Revalidation hold
// ---------------------------------------------------------------------------

/**
 * Whether an upgrade flow is in flight on the mounted page.
 *
 * `shouldRevalidate` is a route export and runs outside the component, so it
 * cannot read the stage from state; one page is mounted at a time, and it
 * clears this on unmount. The hold matters because the loader redirects away
 * as soon as the repository's version is current, and every action submission
 * revalidates — which would throw the owner off the page the moment the
 * upgrade commit landed, taking the build tracking and the retry with it.
 */
let upgradeFlowInFlight = false;

export function shouldRevalidate(): boolean {
  return !upgradeFlowInFlight;
}

const UPGRADE_LOADER_KEY = "upgrade";

/**
 * The page's read, answered with the data on screen where it fails in transit
 * (`readOrKept`): the explicit reload after `prepared_outdated` would otherwise
 * replace the page with its error card during an outage. The first read of a
 * visit is the server's; nothing is kept for a page that is not mounted.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  return readOrKept(UPGRADE_LOADER_KEY, serverLoader);
}

/**
 * A `poll-build` that fails in transit is answered unreachable, with its
 * intent and status 503, so the page keeps the progress it last showed and
 * polls again on its beat (`answerReadsWhenUnreachable`). Every other intent
 * reaches the server action unchanged.
 */
export async function clientAction({ request, serverAction }: Route.ClientActionArgs) {
  return answerReadsWhenUnreachable(request, serverAction, ["poll-build"]);
}

// ---------------------------------------------------------------------------
// Manual step visibility
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function VersionBadge({ label, version, variant }: { label: string; version: string; variant: "current" | "target" }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="font-body text-xs text-gray-500 uppercase tracking-wider">{label}</span>
      <span
        className={`font-heading font-semibold text-sm px-4 py-1.5 rounded-full ${
          variant === "target"
            ? "bg-terracotta text-cream"
            : "bg-cream-dark text-charcoal"
        }`}
      >
        {version}
      </span>
    </div>
  );
}

function PhaseCircle({ phase }: { phase: BuildPhaseStatus }) {
  if (phase.status === "in_progress") {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-blue-100">
        <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
      </div>
    );
  }
  if (phase.status === "completed") {
    if (phase.conclusion === "failure") {
      return (
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-red-100">
          <XCircle className="w-4 h-4 text-red-600" />
        </div>
      );
    }
    if (phase.conclusion === "skipped") {
      return (
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-50">
          <span className="text-gray-300 font-heading font-semibold text-sm">–</span>
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-green-100">
        <CheckCircle2 className="w-4 h-4 text-green-600" />
      </div>
    );
  }
  // queued
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-100">
      <span className="font-heading font-semibold text-xs text-gray-400">
        {BUILD_PHASE_IDS.findIndex((id) => id === phase.id) + 1}
      </span>
    </div>
  );
}

function connectorClass(phase: BuildPhaseStatus): string {
  if (phase.status === "completed" && phase.conclusion !== "failure") return "bg-green-300";
  if (phase.status === "in_progress") return "bg-blue-200";
  return "bg-gray-200";
}

const CATEGORY_ICONS = {
  layouts: FileCode,
  includes: FileText,
  stylesheets: Palette,
  scripts: Terminal,
  workflows: GitBranch,
  dataFiles: Database,
  other: FileText,
} as const;

function CategoryCard({
  icon: Icon,
  label,
  count,
  countLabel,
  files,
  variant = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  countLabel: string;
  files: string[];
  variant?: "default" | "danger";
}) {
  const [open, setOpen] = useState(false);
  const bg = variant === "danger" ? "bg-red-50" : "bg-cream-dark";
  const iconColor = variant === "danger" ? "text-red-400" : "text-terracotta";

  return (
    <div className={`${bg} rounded-lg overflow-hidden`}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:opacity-80 transition-opacity"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon className={`w-4 h-4 ${iconColor} shrink-0`} />
        <div className="min-w-0 flex-1">
          <p className="font-heading font-semibold text-xs text-charcoal leading-tight">
            {label}
          </p>
          <p className="font-body text-xs text-gray-500">{countLabel}</p>
        </div>
        <ChevronDown className={`w-3 h-3 text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && files.length > 0 && (
        <div className="px-3 pb-2">
          <ul className="font-body text-xs text-gray-600 space-y-0.5">
            {files.map((f) => (
              <li key={f} className="truncate" title={f}>
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function HintBox({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 bg-cream-dark hover:bg-gray-50 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-heading font-semibold text-sm text-charcoal">{title}</span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-gray-500 shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
        )}
      </button>
      {open && (
        <div className="px-4 py-3 bg-white">
          <p className="font-body text-sm text-gray-700">{body}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Why the person is on this page, when something sent them here. */
function GateReason({ reasonKey }: { reasonKey: string | null }) {
  const { t } = useTranslation("upgrade");
  if (!reasonKey) return null;
  return <p className="font-body text-sm text-charcoal mb-2">{t(reasonKey)}</p>;
}

export default function UpgradePage({ loaderData: routedData }: Route.ComponentProps) {
  const { data: loaderData, reload } = useReloadableLoaderData(UPGRADE_LOADER_KEY, routedData, "/upgrade");
  const { t, i18n } = useTranslation("upgrade");
  const [searchParams] = useSearchParams();
  const origin = readUpgradeOrigin(searchParams.get("from"));

  // Role comes from the typed loader hook, so the shape is checked rather than
  // asserted. An instructor or a caller with no project membership is
  // redirected away from /upgrade by the routes/_app loader guard (→
  // /objects?denied=upgrade), so this don't-render is belt-and-braces — such
  // a caller never reaches this component. Render-gating is a UX layer only;
  // the server side enforces the same convenor-or-collaborator gate
  // independently.
  const isPublisher = useIsPublisher();

  const {
    siteVersion,
    latestRelease,
    releaseTagOverride,
    releaseNotes,
    releaseCount,
    diff,
    filesByCategory,
    isBelowMinimum,
    needsUpgrade,
    googleSheetsEnabled,
    project,
  } = loaderData;

  if (!isPublisher) return null;

  // Another member's publish or upgrade; the server refuses to begin this one
  // while it runs, so the button waits on it and says whose it is.
  const operationLock = useOperationLock();

  const upgradeFetcher = useSiteFetcher();
  const pollFetcher = useSiteFetcher();
  const rebuildFetcher = useSiteFetcher();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The interval reads the fetcher's state through a ref: the tick closes over
  // the render it was scheduled in, and a stale "idle" would defeat the skip.
  const pollStateRef = useRef(pollFetcher.state);

  const [stage, setStage] = useState<UpgradeStage>("review");
  const [upgradeSubStage, setUpgradeSubStage] = useState<UpgradeSubStage | null>(null);
  const [upgradeSha, setUpgradeSha] = useState<string | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [buildConclusion, setBuildConclusion] = useState<string | null>(null);
  const [buildUrl, setBuildUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [phases, setPhases] = useState<BuildPhaseStatus[] | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [reauthUrl, setReauthUrl] = useState<string | null>(null);
  const [upgradeErrorDetail, setUpgradeErrorDetail] = useState<UpgradeFailureDetail | null>(null);
  const [manualSteps, setManualSteps] = useState<Record<Language, ManualStep[]>>({ en: [], es: [] });
  const [rebuildNotice, setRebuildNotice] = useState<RebuildNotice | null>(null);
  // The question prepare asked, while the picker shows it; the prepared
  // upgrade the confirmation shows; and what the landed upgrade did to the
  // sheets.
  const [question, setQuestion] = useState<ChoiceQuestion | null>(null);
  const [sheetsQuestion, setSheetsQuestion] = useState<SheetsQuestion | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState<PreparedUpgrade | null>(null);
  const [sheetReport, setSheetReport] = useState<SheetReportLine[]>([]);
  const [syncNeeded, setSyncNeeded] = useState(false);
  const [answers, setAnswers] = useState<UpgradeAnswer[]>([]);
  const [sheetsOff, setSheetsOff] = useState<PreparedUpgradeContent["sheetsOff"]>(null);
  // Whether the site reads Google Sheets after the upgrade, as the landed
  // upgrade says; null until one lands, when the loaded settings stand.
  const [readsSheetsAfter, setReadsSheetsAfter] = useState<boolean | null>(null);

  const upgradeData = upgradeFetcher.data as UpgradeActionData;
  const pollData = pollFetcher.data as UpgradeActionData;
  const rebuildData = rebuildFetcher.data as UpgradeActionData;

  // Handle upgrade response. Prepare answers with a prepared upgrade, which
  // commits straight away unless there is something to confirm, or with a
  // question for the column picker; the commit's answer advances to the
  // building stage.
  useEffect(() => {
    if (!upgradeData) return;

    if (upgradeData.ok && upgradeData.intent === "upgrade-prepare") {
      handlePrepared(upgradeData);
      return;
    }

    if (upgradeData.ok && upgradeData.intent === "upgrade-commit") {
      handleCommitted(upgradeData);
      return;
    }

    if (
      !upgradeData.ok &&
      (upgradeData.intent === "upgrade-prepare" || upgradeData.intent === "upgrade-commit")
    ) {
      setStage("review");
      setUpgradeSubStage(null);
      // Refused because the site changed: the layout's notice says why.
      if (isSiteChanged(upgradeData)) return;
      const code = upgradeFailureCode(upgradeData.error);
      setUpgradeError(code);
      setUpgradeErrorDetail(failureDetail(upgradeData));
      // Only a missing permission the acting user can grant comes with a link;
      // the convenor-required variant has the same cause and no link, because
      // only the convenor can work the App's installation settings page.
      setReauthUrl(
        code === "insufficient_permissions" && "reauthUrl" in upgradeData && upgradeData.reauthUrl
          ? upgradeData.reauthUrl
          : null,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upgradeData]);

  // Handle poll responses
  useEffect(() => {
    // A poll refused because the site changed is not asked again: the
    // layout's notice has said why, and this tab's build is not the
    // session's.
    if (isSiteChanged(pollData)) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    if (!pollData?.ok || pollData.intent !== "poll-build") return;
    if (pollData.buildUrl) setBuildUrl(pollData.buildUrl);
    if (pollData.runId != null) setRunId(pollData.runId);
    if (pollData.phases) setPhases(pollData.phases);
    if (pollData.buildStatus === "completed") {
      setBuildConclusion(pollData.buildConclusion);
      setStage("done");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollData]);

  // Rebuild response: follow the run GitHub named, or say plainly that it did
  // not name one. An accepted dispatch never returns the page to review — the
  // build is running either way — so the failed screen is where an
  // unidentified run is reported, with the link the response supplied.
  useEffect(() => {
    if (!rebuildData || rebuildData.intent !== "rebuild") return;

    if (isSiteChanged(rebuildData)) return;
    if (!rebuildData.ok) {
      setRebuildNotice("rebuild_failed");
      return;
    }

    setBuildUrl(rebuildData.buildUrl);
    if (rebuildData.runId == null || rebuildData.headSha == null) {
      setRebuildNotice("rebuild_unconfirmed");
      return;
    }

    setRebuildNotice(null);
    setRunId(rebuildData.runId);
    setUpgradeSha(rebuildData.headSha);
    setStage("building");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildData]);

  useEffect(() => {
    pollStateRef.current = pollFetcher.state;
  }, [pollFetcher.state]);

  // Polling effect
  useEffect(() => {
    if (stage !== "building" || !upgradeSha) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    function doPoll() {
      const formData: Record<string, string> = { intent: "poll-build", sha: upgradeSha! };
      if (runId != null) formData.runId = String(runId);
      pollFetcher.submit(formData, { method: "post" });
    }

    doPoll();
    // A tick that fires while a poll is still in flight would abort that poll:
    // React Router cancels a fetcher's request when the same fetcher submits
    // again. Responses slower than the interval would then never arrive and the
    // page would sit in `building` for as long as the build took to answer.
    intervalRef.current = setInterval(() => {
      if (pollStateRef.current !== "idle") return;
      doPoll();
    }, 5000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, upgradeSha, runId]);

  // Hold the loader's redirect while a flow the page owns is running. The
  // failed `done` screen is held too: its retry is the only way back to a
  // build, and a revalidation would take it away.
  const flowInFlight =
    stage === "upgrading" ||
    stage === "building" ||
    (stage === "done" && buildConclusion !== "success");
  useEffect(() => {
    upgradeFlowInFlight = flowInFlight;
    return () => {
      upgradeFlowInFlight = false;
    };
  }, [flowInFlight]);

  // A release published since the page loaded refused the commit, or the files
  // the upgrade removes differ from the ones listed: reload the page's data so
  // it names the release the next upgrade will install and the files it removes. After
  // the hold's own effect, which has released it by now.
  useEffect(() => {
    if (upgradeError === "prepared_outdated" || upgradeError === "deletions_changed") reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upgradeError]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // The deletions the page lists, which prepare compares its own against.
  const reviewedDeletions = JSON.stringify(diff?.deletions ?? []);

  function handleUpgrade() {
    setUpgradeError(null);
    setReauthUrl(null);
    setStage("upgrading");
    setUpgradeSubStage("preparing");
    upgradeFetcher.submit({ intent: "upgrade-prepare", deletions: reviewedDeletions }, { method: "post" });
  }

  function handleCommitted(data: CommittedUpgrade) {
    setUpgradeSha(data.newHeadSha);
    setNewVersion(data.newVersion);
    setManualSteps({
      en: Array.isArray(data.manualSteps?.en) ? data.manualSteps.en : [],
      es: Array.isArray(data.manualSteps?.es) ? data.manualSteps.es : [],
    });
    setSheetReport(Array.isArray(data.sheetReport) ? data.sheetReport : []);
    setSyncNeeded(data.advancesHead === false);
    setAnswers(Array.isArray(data.answers) ? data.answers : []);
    setSheetsOff(data.sheetsOff ?? null);
    setReadsSheetsAfter(typeof data.readsGoogleSheetsAfter === "boolean" ? data.readsGoogleSheetsAfter : null);
    setUpgradeSubStage(null);
    setStage("building");
  }

  function submitCommit(prepared: PreparedUpgrade) {
    setAwaitingConfirmation(null);
    setStage("upgrading");
    setUpgradeSubStage("committing");
    upgradeFetcher.submit({ intent: "upgrade-commit", preparedState: JSON.stringify(prepared) }, { method: "post" });
  }

  function handlePrepared(data: Extract<UpgradeActionData, { ok: true; intent: "upgrade-prepare" }>) {
    setUpgradeSubStage(null);
    if (data.answer === "needs_choices") {
      setQuestion({ challenge: data.challenge, groups: data.groups, notice: data.notice });
      setStage("choices");
      return;
    }
    if (data.answer === "needs_sheets_decision") {
      setSheetsQuestion({ challenge: data.challenge, detail: data.detail, notice: data.notice });
      setStage("sheets");
      return;
    }
    if (needsConfirmation(data.prepared)) {
      setAwaitingConfirmation(data.prepared);
      setStage("confirm");
      return;
    }
    submitCommit(data.prepared);
  }

  // The picker's answer goes back through prepare with the challenge it
  // answers, which ended its lease; the prepare begins a new one.
  function handleChoices(choices: SubmittedChoice[]) {
    if (!question) return;
    setStage("upgrading");
    setUpgradeSubStage("preparing");
    upgradeFetcher.submit(
      { intent: "upgrade-prepare", challenge: JSON.stringify(question.challenge), choices: JSON.stringify(choices), deletions: reviewedDeletions },
      { method: "post" },
    );
  }

  // The answer to the Google Sheets offer goes back through prepare with the
  // challenge it answers; keeping Google Sheets comes back as the stop that
  // names the tabs to fix there.
  function handleSheetsAnswer(answer: "off" | "keep") {
    if (!sheetsQuestion) return;
    setSheetsQuestion(null);
    setStage("upgrading");
    setUpgradeSubStage("preparing");
    upgradeFetcher.submit(
      { intent: "upgrade-prepare", challenge: JSON.stringify(sheetsQuestion.challenge), sheets: answer, deletions: reviewedDeletions },
      { method: "post" },
    );
  }

  function handleCancelChoices() {
    setQuestion(null);
    setStage("review");
  }

  // A prepared upgrade holds its lease until it commits or is cancelled.
  function handleCancelConfirmation() {
    if (awaitingConfirmation) {
      upgradeFetcher.submit(
        { intent: "upgrade-cancel", preparedState: JSON.stringify(awaitingConfirmation) },
        { method: "post" },
      );
    }
    setAwaitingConfirmation(null);
    setStage("review");
  }

  // The retry on the failed-build screen runs the site's build again. The
  // upgrade itself has already landed and D1 already records the new version,
  // so there is no upgrade left to re-attempt; what failed is the build, and
  // "again" means the site as it stands now. `newVersion` and `manualSteps`
  // describe that landed upgrade and are kept.
  function handleRetry() {
    setUpgradeError(null);
    setReauthUrl(null);
    setUpgradeSha(null);
    setBuildConclusion(null);
    setBuildUrl(null);
    setRunId(null);
    setPhases(null);
    setRebuildNotice(null);
    rebuildFetcher.submit({ intent: "rebuild" }, { method: "post" });
  }

  // Build phase labels (i18n)
  const phaseLabels: Record<BuildPhaseId, string> = {
    "setup": t("phase_label_setup"),
    "build-js": t("phase_label_build_js"),
    "process-data": t("phase_label_process_data"),
    "build-site": t("phase_label_build_site"),
    "iiif": t("phase_label_iiif_tiles"),
    "deploy": t("phase_label_deploy"),
  };

  // Build phase display
  const displayPhases: BuildPhaseStatus[] =
    phases ??
    BUILD_PHASE_IDS.map((id) => ({
      id,
      label: phaseLabels[id],
      status: "queued" as const,
      conclusion: null,
    }));

  // Post-upgrade navigation target
  // Post-upgrade navigation target: back to what the person was doing.
  function getContinueButton() {
    if (origin === "publish") {
      return (
        <Link to="/publish">
          <Button variant="primary" type="button">{t("continueToPublish")}</Button>
        </Link>
      );
    }
    if (origin === "objects") {
      return (
        <Link to="/objects">
          <Button variant="primary" type="button">{t("continueToObjects")}</Button>
        </Link>
      );
    }
    if (origin === "start") {
      return (
        <Link to="/start">
          <Button variant="primary" type="button">{t("continueToStart")}</Button>
        </Link>
      );
    }
    return null;
  }

  // Why the person is here, when they were sent rather than came.
  const reasonKey = gateReasonKey(origin, stage, needsUpgrade);

  const displayVersion = siteVersion ? normalizeVersionTag(siteVersion) : "unknown";

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="font-heading font-bold text-2xl text-charcoal mb-2">{t("title")}</h1>
      <SiteLine repo={project.github_repo_full_name} />
      <GateReason reasonKey={reasonKey} />
      {latestRelease && needsUpgrade && (
        <p className="font-body text-sm text-gray-500 mb-6">{t("subtitle")}</p>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* REVIEW STAGE                                                        */}
      {/* ------------------------------------------------------------------ */}
      {stage === "review" && (
        <>
          {/* Stale head banner */}
          {upgradeError === "stale_head" && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 flex items-start gap-3">
              <p className="font-body text-sm text-amber-900 flex-1">{t("staleHead")}</p>
              <Link
                to="/dashboard"
                className="font-heading font-semibold text-sm text-amber-900 underline underline-offset-2 hover:opacity-80 shrink-0"
              >
                {t("resync")}
              </Link>
            </div>
          )}

          {/* Missing GitHub App permission (e.g. workflows: write) */}
          {upgradeError === "insufficient_permissions" && reauthUrl && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 flex items-start gap-3">
              <p className="font-body text-sm text-amber-900 flex-1">{t("insufficientPermissions")}</p>
              <a
                href={reauthUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-heading font-semibold text-sm text-amber-900 underline underline-offset-2 hover:opacity-80 shrink-0"
              >
                {t("reviewPermissions")}
              </a>
            </div>
          )}

          {/* Refusals that need only a sentence: see UPGRADE_NOTICES */}
          {upgradeError && UPGRADE_NOTICES[upgradeError] && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
              <p className="font-body text-sm text-amber-900">
                {t(noticeKey(upgradeError, upgradeErrorDetail), noticeValues(upgradeErrorDetail))}
              </p>
              {upgradeErrorDetail && "collisions" in upgradeErrorDetail && (
                <SheetLineList
                  items={upgradeErrorDetail.collisions.map((c) => `${c.tab}: ${c.columns.join(", ")}`)}
                  className="text-amber-900 mt-2"
                />
              )}
            </div>
          )}

          {/* Generic error banner */}
          {upgradeError === "upgrade_failed" && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p className="font-body text-sm text-red-900">{t("upgradeFailedDetail")}</p>
            </div>
          )}

          {/* Below minimum version error */}
          {isBelowMinimum && (
            <div className="border border-red-300 rounded-lg p-6 mb-6 bg-red-50">
              <h2 className="font-heading font-bold text-lg text-red-900 mb-2">
                {t("belowMinimumTitle")}
              </h2>
              <p className="font-body text-sm text-red-800">
                {t("belowMinimum", { version: displayVersion })}
              </p>
            </div>
          )}

          {/* Version display */}
          {latestRelease && (
            <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
              <div className="flex items-center justify-center gap-6 mb-6">
                <VersionBadge label={t("currentVersion")} version={displayVersion} variant="current" />
                <ArrowRight className="w-5 h-5 text-gray-400" />
                <VersionBadge label={t("targetVersion")} version={latestRelease.tagName} variant="target" />
              </div>

              {/* A pinned deployment says so beside the target version, so a
                  rehearsal is never mistaken for a real upgrade. */}
              {releaseTagOverride && (
                <p className="font-body text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 mb-6 text-center">
                  {t("releaseTagOverride", { tag: latestRelease.tagName })}
                </p>
              )}

              {/* Release notes */}
              {releaseNotes && (
                <div className="mb-6">
                  <h2 className="font-heading font-semibold text-base text-charcoal mb-2">
                    {releaseCount > 1
                      ? t("combinedReleaseNotes", { count: releaseCount })
                      : t("releaseNotes")}
                  </h2>
                  <div
                    className="release-notes bg-cream-dark rounded-lg p-5 max-h-96 overflow-y-auto font-body text-sm text-charcoal"
                    dangerouslySetInnerHTML={{ __html: releaseNotes }}
                    onClick={(e) => {
                      const target = e.target as HTMLElement;
                      const anchor = target.closest("a");
                      if (!anchor) return;
                      const href = anchor.getAttribute("href");
                      if (!href?.startsWith("#")) return;
                      e.preventDefault();
                      const id = decodeURIComponent(href.slice(1));
                      const el = e.currentTarget.querySelector(`[id="${CSS.escape(id)}"]`);
                      el?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  />
                </div>
              )}

              {/* File change summary */}
              {diff && (
                <div className="mb-6">
                  <h2 className="font-heading font-semibold text-base text-charcoal mb-1">
                    {t("changesSummary")}
                  </h2>
                  <p className="font-body text-xs text-gray-500 mb-3">
                    {t("changesDescription")}
                  </p>
                  {diff.summary.total === 0 && diff.summary.deletions === 0 ? (
                    <p className="font-body text-sm text-gray-500">{t("totalChanges", { count: 0 })}</p>
                  ) : (
                    <>
                      <p className="font-body text-xs text-gray-500 mb-2">
                        {t("totalChanges", { count: diff.summary.total })}
                      </p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {(
                          [
                            "layouts",
                            "includes",
                            "stylesheets",
                            "scripts",
                            "workflows",
                            "dataFiles",
                            "other",
                          ] as const
                        )
                          .filter((key) => diff.summary[key] > 0)
                          .map((key) => (
                            <CategoryCard
                              key={key}
                              icon={CATEGORY_ICONS[key]}
                              label={t(key)}
                              count={diff.summary[key]}
                              countLabel={t("fileCount", { count: diff.summary[key] })}
                              files={filesByCategory?.[key] ?? []}
                            />
                          ))}
                        {diff.summary.deletions > 0 && (
                          <CategoryCard
                            icon={XCircle}
                            label={t("deletions")}
                            count={diff.summary.deletions}
                            countLabel={t("fileCount", { count: diff.summary.deletions })}
                            files={filesByCategory?.deletions ?? []}
                            variant="danger"
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Upgrade button — only if not below minimum and upgrade is needed */}
              {!isBelowMinimum && needsUpgrade && (
                <div className="flex items-center justify-end gap-3">
                  {operationLock && (
                    <OperationLockNotice lock={operationLock} waiting="upgrade" className="text-charcoal/70" />
                  )}
                  <Button variant="primary" type="button" onClick={handleUpgrade} disabled={operationLock !== null}>
                    {t("upgradeButton", { version: latestRelease.tagName })}
                  </Button>
                </div>
              )}

              {/* Already up to date */}
              {!isBelowMinimum && !needsUpgrade && latestRelease && (
                <p className="font-body text-sm text-green-700 text-center">
                  ✓ {t("upgradeSuccessDetail", { version: latestRelease.tagName })}
                </p>
              )}
            </div>
          )}

          {/* Hint boxes */}
          <div className="flex flex-col gap-2 mb-6">
            <HintBox title={t("hint_whatIsUpgrade_title")} body={t("hint_whatIsUpgrade")} />
            <HintBox title={t("hint_whatIsVersion_title")} body={t("hint_whatIsVersion")} />
            <HintBox title={t("hint_whatIsBuild_title")} body={t("hint_whatIsBuild")} />
          </div>

          <div className="flex justify-start">
            <Link
              to="/dashboard"
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream-dark transition-colors inline-block"
            >
              {t("backToDashboard")}
            </Link>
          </div>
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* UPGRADING STAGE — two-step progress: prepare, then commit           */}
      {/* ------------------------------------------------------------------ */}
      {stage === "upgrading" && (
        <div className="bg-white rounded-xl border border-gray-200 p-8">
          <h2 className="font-heading font-semibold text-lg text-charcoal mb-6 text-center">
            {t("upgrading")}
          </h2>
          <ol className="flex flex-col gap-4 max-w-sm mx-auto">
            {(["preparing", "committing"] as const).map((step) => {
              const isActive = upgradeSubStage === step;
              const isDone =
                (step === "preparing" && upgradeSubStage === "committing") ||
                upgradeSubStage === null;
              return (
                <li key={step} className="flex items-center gap-3">
                  {isActive ? (
                    <Loader2 className="w-5 h-5 text-terracotta animate-spin shrink-0" aria-hidden="true" />
                  ) : isDone ? (
                    <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" aria-hidden="true" />
                  ) : (
                    <div className="w-5 h-5 rounded-full border-2 border-gray-200 shrink-0" aria-hidden="true" />
                  )}
                  <span
                    className={`font-body text-sm ${
                      isActive
                        ? "text-charcoal font-semibold"
                        : isDone
                          ? "text-gray-500"
                          : "text-gray-400"
                    }`}
                  >
                    {t(`upgrading_step_${step}`)}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="font-body text-xs text-gray-500 mt-6 text-center">
            {t("upgrading_hint")}
          </p>
        </div>
      )}

      <UpgradeSheetQuestion
        stage={stage}
        question={question}
        sheetsQuestion={sheetsQuestion}
        awaitingConfirmation={awaitingConfirmation}
        onChoose={handleChoices}
        onCancelChoices={handleCancelChoices}
        onSheetsAnswer={handleSheetsAnswer}
        onConfirm={submitCommit}
        onCancelConfirmation={handleCancelConfirmation}
      />

      {/* ------------------------------------------------------------------ */}
      {/* BUILDING STAGE                                                      */}
      {/* ------------------------------------------------------------------ */}
      {stage === "building" && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-heading font-semibold text-lg text-charcoal mb-4">
            {t("buildTracking")}
          </h2>

          {!phases && (
            <div className="flex items-center gap-2 text-gray-500 mb-4">
              <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
              <span className="font-body text-sm">{t("waiting_build")}</span>
            </div>
          )}

          {phases && (
            <div className="flex items-start mb-4">
              {displayPhases.map((phase, index) => (
                <div key={phase.id} className="flex items-center flex-1">
                  <div className="flex flex-col items-center gap-1 flex-shrink-0">
                    <PhaseCircle phase={phase} />
                    <span
                      className={`font-heading text-xs whitespace-nowrap text-center leading-tight ${
                        phase.status === "completed" && phase.conclusion !== "failure"
                          ? "text-green-600"
                          : phase.status === "in_progress"
                          ? "text-blue-600 font-semibold"
                          : "text-gray-400"
                      }`}
                    >
                      {phase.label}
                    </span>
                  </div>
                  {index < displayPhases.length - 1 && (
                    <div
                      className={`flex-1 min-w-2 h-0.5 mx-1 mb-5 transition-colors ${connectorClass(phase)}`}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {buildUrl && (
            <a
              href={buildUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-body text-xs text-blue-600 hover:underline"
            >
              {t("view_on_github")}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* DONE STAGE                                                          */}
      {/* ------------------------------------------------------------------ */}
      {stage === "done" && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          {buildConclusion === "success" ? (
            <>
              <div className="flex flex-col items-center gap-3 py-4 mb-6">
                <CheckCircle2 className="w-12 h-12 text-green-500" />
                <h2 className="font-heading font-semibold text-xl text-charcoal">
                  {t("upgradeSuccess")}
                </h2>
                {newVersion && (
                  <p className="font-body text-sm text-gray-600">
                    {t("upgradeSuccessDetail", { version: newVersion })}
                  </p>
                )}
              </div>

              {/* Post-upgrade manual steps (from manifest chain) */}
              <UpgradeSheetOutcome lines={sheetReport} syncNeeded={syncNeeded} answers={answers} sheetsOff={sheetsOff} />
              <PostUpgradeSteps steps={manualSteps[i18n.language?.toLowerCase().startsWith("es") ? "es" : "en"]} googleSheetsEnabled={readsSheetsAfter ?? googleSheetsEnabled} />

              <div className="flex flex-wrap gap-3 justify-end">
                {project.github_pages_url && (
                  <a
                    href={project.github_pages_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream transition-colors"
                  >
                    {t("viewSite")}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {getContinueButton() ?? (
                  <Link to="/dashboard">
                    <Button variant="primary" type="button">{t("backToDashboard")}</Button>
                  </Link>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col items-center gap-3 py-4 mb-6">
                <XCircle className="w-12 h-12 text-red-500" />
                <h2 className="font-heading font-semibold text-xl text-charcoal">
                  {t("upgradeFailed")}
                </h2>
                <p className="font-body text-sm text-gray-600">{t("upgradeFailedDetail")}</p>
                {rebuildNotice && (
                  <p className="font-body text-sm text-amber-900">{t(rebuildNotice)}</p>
                )}
              </div>

              <UpgradeSheetOutcome lines={sheetReport} syncNeeded={syncNeeded} answers={answers} sheetsOff={sheetsOff} />

              <div className="flex flex-wrap gap-3 justify-end">
                {buildUrl && (
                  <a
                    href={buildUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream transition-colors"
                  >
                    {t("viewActions")}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <Button variant="primary" type="button" onClick={handleRetry}>
                  {t("retry")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

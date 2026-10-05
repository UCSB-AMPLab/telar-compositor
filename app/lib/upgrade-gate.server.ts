/**
 * Which acts an outdated site refuses, and to whom.
 *
 * A site behind the latest Telar release keeps every tab: browsing, editing
 * and the collaboration document are the Compositor's own and do not depend
 * on the framework the site runs. What depends on it is a write of the site's
 * content to the repository followed by a build of it: publishing, committing
 * objects, uploading a file, and deleting an object from the repository.
 * Publish is gated as a page as well, because the whole page is that act; the
 * Objects writes are gated as actions, so the rest of the page stays open.
 *
 * Those writes read the release three ways: current, behind, or unknown. A
 * release lookup that failed is unknown, and every one of them refuses on it:
 * a failure read as "current" is how a site behind a release published a
 * moment ago would publish through a worker that could not see it. The tag
 * cache keeps a failure only briefly (see TAG_FAILURE_RETRY_MS) so a GitHub
 * that has recovered stops the refusals within seconds. A site with no
 * recorded version reads as current, since there is nothing to compare.
 *
 * `siteNeedsUpgrade` keeps the fail-open reading for callers that only steer
 * a person somewhere (onboarding): an unknown release is not "behind".
 *
 * @version v1.5.0-beta
 */

import type { getDb } from "~/lib/db.server";
import { getCachedLatestTag, readLatestTag, type LatestTagRead } from "~/lib/github-status.server";
import { compareTelarVersion } from "~/lib/telar-version";
import { decrypt } from "~/lib/crypto.server";
import { isPublishingRole } from "~/lib/publishing-roles";
import { readSiteTelarVersion } from "~/lib/site-version.server";

type DbInstance = ReturnType<typeof getDb>;

/**
 * A collaborator cannot complete an upgrade the installation's missing
 * workflows:write permission would refuse — only the convenor, as installer,
 * can grant that on GitHub's settings page (see
 * insufficient_permissions_convenor_required in _app.upgrade.tsx).
 * Sending them to /upgrade anyway is a loop: the upgrade fails, and every
 * way back leads to it again. `workflowsWriteMissing === 1` is required (not
 * truthy) so a cold or null cache reads as completable — the same fail-open
 * reading deriveWorkflowsApproval uses — and the convenor is untouched
 * either way.
 */
export function deriveUpgradeAwaitsConvenor(
  needsUpgrade: boolean,
  userRole: string | null,
  workflowsWriteMissing: number | null,
): boolean {
  return needsUpgrade && userRole === "collaborator" && workflowsWriteMissing === 1;
}

/** A site's standing against the latest release. */
export type ReleaseStanding = "current" | "needs_upgrade" | "unknown";

/**
 * The standing a site version has against a release read. Pure, so the
 * `_app` loader can apply it to the read it already made.
 */
export function standingFromLatest(
  siteVersion: string | null,
  latest: LatestTagRead | undefined,
): ReleaseStanding {
  if (!siteVersion) return "current";
  if (!latest) return "current";
  if (!latest.ok) return "unknown";
  return compareTelarVersion(siteVersion, latest.tag).needsUpgrade ? "needs_upgrade" : "current";
}

/**
 * Whether the site's recorded Telar version is behind the latest release.
 * Fails open: an unreadable release or an unrecorded version reads as current.
 */
export async function siteNeedsUpgrade(
  db: DbInstance,
  env: { TELAR_RELEASE_TAG?: string },
  args: { projectId: number; userToken: string },
): Promise<boolean> {
  const siteVersion = await readSiteTelarVersion(db, args.projectId);
  const tag = await getCachedLatestTag(args.userToken, Date.now(), env.TELAR_RELEASE_TAG);
  return compareTelarVersion(siteVersion, tag).needsUpgrade;
}

/**
 * The site's standing, for a write that depends on it. Never throws. The
 * release is looked up only for a site with a recorded version; a pinned
 * release that cannot be fetched is unknown like any other failed lookup, and
 * so is a site version D1 could not return.
 */
export async function readReleaseStanding(
  db: DbInstance,
  env: { TELAR_RELEASE_TAG?: string },
  args: { projectId: number; userToken: string },
): Promise<ReleaseStanding> {
  let siteVersion: string | null;
  try {
    siteVersion = await readSiteTelarVersion(db, args.projectId);
  } catch {
    return "unknown";
  }
  if (!siteVersion) return "current";
  const latest = await readLatestTag(args.userToken, Date.now(), env.TELAR_RELEASE_TAG);
  return standingFromLatest(siteVersion, latest);
}

/**
 * What a write to the site's repository may do now: proceed, stop for an
 * upgrade the caller can run, stop for one only the convenor can complete, or
 * stop because the latest release cannot be read. The refusals are separate
 * because each sends the person somewhere different.
 */
export type RepoWriteGate =
  | "open"
  | "upgrade_required"
  | "upgrade_awaits_convenor"
  | "release_unknown";

export async function readRepoWriteGate(
  db: DbInstance,
  env: { TELAR_RELEASE_TAG?: string },
  args: {
    project: { id: number; gh_workflows_write_missing?: number | null };
    userRole: string | null;
    userToken: string;
  },
): Promise<RepoWriteGate> {
  const standing = await readReleaseStanding(db, env, {
    projectId: args.project.id,
    userToken: args.userToken,
  });
  if (standing === "current") return "open";
  if (standing === "unknown") return "release_unknown";

  const workflowsWriteMissing = args.project.gh_workflows_write_missing ?? null;
  return deriveUpgradeAwaitsConvenor(true, args.userRole, workflowsWriteMissing)
    ? "upgrade_awaits_convenor"
    : "upgrade_required";
}

/** Why a repository write may not proceed, or null when it may. */
export type RepoWriteRefusal = Exclude<RepoWriteGate, "open">;

/**
 * The version half of a repository write's refusal, from the caller's
 * encrypted token.
 *
 * A token that cannot be decrypted answers null and lets the action proceed:
 * the action decrypts again inside its own guarded region, which reports the
 * failure with its structured error rather than a 500. Nothing past the
 * decrypt throws; a standing that cannot be read is `release_unknown`.
 */
export async function readRepoWriteRefusal(
  db: DbInstance,
  env: { ENCRYPTION_KEY: string; TELAR_RELEASE_TAG?: string },
  args: {
    project: { id: number; gh_workflows_write_missing?: number | null };
    userRole: string | null;
    encryptedToken: string;
  },
): Promise<RepoWriteRefusal | null> {
  let userToken: string;
  try {
    userToken = await decrypt(args.encryptedToken, env.ENCRYPTION_KEY);
  } catch {
    return null;
  }
  const gate = await readRepoWriteGate(db, env, { ...args, userToken });
  return gate === "open" ? null : gate;
}

/** Why an upload may not proceed, or null when it may. */
export type UploadRefusal = "forbidden" | RepoWriteRefusal;

/**
 * May this person upload to this site now — both halves of the question in
 * one answer, role first. The role is read before anything else so a caller
 * who may never upload costs no lookup. A publishing role is named in the
 * set, never inferred.
 */
export async function readUploadRefusal(
  db: DbInstance,
  env: { ENCRYPTION_KEY: string; TELAR_RELEASE_TAG?: string },
  args: {
    project: { id: number; gh_workflows_write_missing?: number | null };
    userRole: string | null;
    encryptedToken: string;
  },
): Promise<UploadRefusal | null> {
  if (!isPublishingRole(args.userRole)) return "forbidden";
  return readRepoWriteRefusal(db, env, args);
}

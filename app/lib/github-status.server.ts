/**
 * GitHub status cache — keeps the per-navigation _app loader off the GitHub
 * API. The loader READS cached values (instant); the Site Status pill REFRESHES
 * them out-of-band via /api/site-status?payload=gh-status. This split is what
 * keeps every navigation fast: GitHub work never blocks the loader, and the
 * pill reconciles the cache in the background.
 *
 * @version v1.4.1-beta
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { projects } from "~/db/schema";
import { getDb } from "~/lib/db.server";
import { checkRepoAvailability, getRepoHead } from "~/lib/github.server";
import { computeFullSyncDiff, hasDivergentChanges } from "~/lib/sync.server";
import { fetchLatestRelease } from "~/lib/upgrade.server";

export const STATUS_TTL_MS = 45_000;
export const TAG_TTL_MS = 600_000;

export interface CachedGithubStatus {
  gh_repo_available: number | null;
  gh_remote_head_sha: string | null;
  gh_diverged: number | null;
  gh_diverged_against_sha: string | null;
  gh_checked_at: string | null;
}

/**
 * Shape returned by the `gh-status` resource-route payload
 * (/api/site-status?payload=gh-status) and consumed by the Site Status pill
 * poll.
 */
export interface DerivedGithubStatus {
  repoUnavailable: boolean;
  headDiverged: boolean;
  needsUpgrade: boolean;
  isBelowMinimum: boolean;
  latestTelarTag: string | null;
  /** Real content-diff count (computeChangeSummary), merged over the loader's
   *  cheap updated_at proxy. Optional/undefined when it couldn't be computed. */
  unpublishedCount?: number;
}

export function isStale(checkedAt: string | null, now: number, ttlMs = STATUS_TTL_MS): boolean {
  if (!checkedAt) return true;
  return Date.parse(checkedAt) < now - ttlMs;
}

/** SHA-tagged divergence: the cached verdict is only valid while local head is unchanged. */
export function deriveHeadDiverged(cache: CachedGithubStatus, localHeadSha: string | null): boolean {
  return (
    cache.gh_diverged === 1 &&
    cache.gh_diverged_against_sha !== null &&
    cache.gh_diverged_against_sha === localHeadSha &&
    cache.gh_remote_head_sha !== null &&
    cache.gh_remote_head_sha !== localHeadSha
  );
}

export interface WorkflowsApproval {
  /** True when the active user should see the "approve updated permissions"
   *  prompt: their installation lacks workflows:write AND they're the convenor
   *  (only the install owner can approve a GitHub App's pending permission). */
  needed: boolean;
  /** Installation settings page where the pending permission is approved, or
   *  null when no prompt is needed. Org installs use the org-scoped path. */
  url: string | null;
}

/**
 * Derive whether to surface the workflows-permission approval prompt, from the
 * cached gh_workflows_write_missing flag + install target type. Convenor-only:
 * collaborators cannot approve the convenor's installation. Fail-open: a cold
 * (null) cache yields needed=false, so a user is never nagged on stale data.
 */
export function deriveWorkflowsApproval(args: {
  workflowsWriteMissing: number | null;
  targetType: string | null;
  installationId: number;
  repoFullName: string | null;
  role: "convenor" | "collaborator" | null;
}): WorkflowsApproval {
  const needed = args.workflowsWriteMissing === 1 && args.role === "convenor";
  if (!needed) return { needed: false, url: null };
  const owner = args.repoFullName?.split("/")[0] ?? "";
  const url =
    args.targetType === "Organization" && owner
      ? `https://github.com/organizations/${owner}/settings/installations/${args.installationId}`
      : `https://github.com/settings/installations/${args.installationId}`;
  return { needed: true, url };
}

// In-isolate global latest-tag cache (the Telar release tag is identical for
// every project). Module-level state persists per warm isolate.
let _tagCache: { tag: string | null; fetchedAt: number } | null = null;
export function __resetTagCacheForTest() { _tagCache = null; }

/** Warm read only — never fetches. undefined = cold (caller decides whether to fetch). */
export function getCachedLatestTagIfWarm(now: number, ttlMs = TAG_TTL_MS): string | null | undefined {
  if (_tagCache && _tagCache.fetchedAt >= now - ttlMs) return _tagCache.tag;
  return undefined;
}

/**
 * Warm read, else fetch (the one allowed GitHub call on a cold gated-route load).
 * Note: does not dedupe concurrent cold fetches — two simultaneous cold loads can
 * each fire one fetchLatestRelease. Acceptable given the 10-min TTL (the race
 * window is tiny and the result is identical for every project).
 */
export async function getCachedLatestTag(token: string, now: number, ttlMs = TAG_TTL_MS): Promise<string | null> {
  const warm = getCachedLatestTagIfWarm(now, ttlMs);
  if (warm !== undefined) return warm;
  try {
    const latest = await fetchLatestRelease(token);
    _tagCache = { tag: latest.tagName, fetchedAt: now };
  } catch {
    _tagCache = { tag: null, fetchedAt: now };
  }
  return _tagCache.tag;
}

/**
 * Claim the refresh slot. Conditional update: succeeds for exactly one caller
 * within a TTL window, so concurrent navigations/tabs don't each fire a GitHub
 * waterfall. Sets gh_checked_at to `now` (the winner overwrites it with the
 * real value after the waterfall; a failed waterfall leaves it ~fresh, so we
 * don't hammer GitHub — retry after TTL).
 */
export async function claimRefresh(
  db: ReturnType<typeof getDb>,
  projectId: number,
  now: number,
  ttlMs = STATUS_TTL_MS,
): Promise<boolean> {
  const nowIso = new Date(now).toISOString();
  const staleBefore = new Date(now - ttlMs).toISOString();
  const claimed = await db
    .update(projects)
    .set({ gh_checked_at: nowIso })
    .where(
      and(
        eq(projects.id, projectId),
        or(isNull(projects.gh_checked_at), lt(projects.gh_checked_at, staleBefore)),
      ),
    )
    .returning({ id: projects.id });
  return claimed.length === 1;
}

/** Invalidate the cache on a head_sha change. The ONLY writer that nulls gh_checked_at. */
export async function bumpProjectHead(
  db: ReturnType<typeof getDb>,
  projectId: number,
  sha: string,
  now = Date.now(),
): Promise<void> {
  await db
    .update(projects)
    .set({ head_sha: sha, gh_checked_at: null, updated_at: new Date(now).toISOString() })
    .where(eq(projects.id, projectId));
}

interface RefreshableProject {
  id: number;
  head_sha: string | null;
  github_repo_full_name: string | null;
}

/**
 * The GitHub waterfall, parallelized. Writes the cache columns + the real
 * gh_checked_at, and performs the head_sha backfill / silent no-change bump
 * (folded into the single cache write so an interruption can't leave head_sha
 * advanced with a stale verdict). Caller has already won the claim
 * (claimRefresh). Fail-open: on error it leaves prior cache values; the claim's
 * gh_checked_at stamp prevents hammering — next refresh after TTL retries.
 */
export async function refreshGithubStatus(
  project: RefreshableProject,
  token: string,
  db: ReturnType<typeof getDb>,
  now = Date.now(),
): Promise<void> {
  if (!project.github_repo_full_name?.includes("/")) return;
  const [owner, repo] = project.github_repo_full_name.split("/");
  const nowIso = new Date(now).toISOString();
  try {
    const [availability, remoteHead] = await Promise.all([
      checkRepoAvailability(token, owner, repo),
      getRepoHead(token, owner, repo).catch(() => null),
    ]);

    if (availability === "unavailable") {
      await db.update(projects)
        .set({ gh_repo_available: 0, gh_checked_at: nowIso })
        .where(eq(projects.id, project.id));
      return;
    }
    // Repo is available (or transient "error" → fail-open). If the head fetch
    // failed, do NOT clobber the last-known verdict — leave prior gh_* intact.
    if (!remoteHead) {
      console.warn("[github-status] getRepoHead returned null for", project.github_repo_full_name);
      return;
    }

    let localHead = project.head_sha;
    let headToWrite: string | undefined; // set when we advance head_sha (backfill or silent no-change bump)
    if (!localHead) {
      headToWrite = remoteHead; // backfill for older imports that never stored head_sha
      localHead = remoteHead;
    }

    let diverged = 0;
    let divergedAgainst: string | null = localHead;
    if (remoteHead !== localHead) {
      try {
        const diff = await computeFullSyncDiff(project.id, token, owner, repo, db, localHead);
        if (hasDivergentChanges(diff)) {
          diverged = 1;
        } else {
          headToWrite = remoteHead; // silent no-change bump: align head, no banner
          localHead = remoteHead;
          divergedAgainst = remoteHead;
        }
      } catch {
        diverged = 1; // fail safe: show the banner
      }
    }

    // Single atomic write: head advance (if any) + all cache columns together.
    await db.update(projects).set({
      ...(headToWrite ? { head_sha: headToWrite, updated_at: nowIso } : {}),
      gh_repo_available: 1,
      gh_remote_head_sha: remoteHead,
      gh_diverged: diverged,
      gh_diverged_against_sha: divergedAgainst,
      gh_checked_at: nowIso,
    }).where(eq(projects.id, project.id));
  } catch (err) {
    // Fail open — leave the claimed gh_checked_at; retry after TTL.
    console.warn("[github-status] refreshGithubStatus failed", err);
  }
}

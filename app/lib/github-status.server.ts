/**
 * GitHub status cache — keeps the per-navigation _app loader off the GitHub
 * API. The loader READS cached values (instant); the Site Status pill REFRESHES
 * them out-of-band via /api/site-status?payload=gh-status. This split is what
 * keeps every navigation fast: GitHub work never blocks the loader, and the
 * pill reconciles the cache in the background.
 *
 * @version v1.5.5-beta
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { projects } from "~/db/schema";
import { getDb } from "~/lib/db.server";
import { checkRepoAvailability, getRepoHead } from "~/lib/github.server";
import type { OwnRepoAccess } from "~/lib/repo-access";
import { parsePageFilesRecord, serialisePageFilesRecord } from "~/lib/page-files-record";
import { heldPagesRecord, pageFilesRecordAdvancedFrom } from "~/lib/page-files-record.server";
import { computeFullSyncDiff, hasDivergentChanges } from "~/lib/sync.server";
import { CollidingColumnsRefusal } from "~/lib/import.server";
import { legacyRecordRef } from "~/lib/legacy-object-ids.server";
import { readSiteTelarVersion } from "~/lib/site-version.server";
import { recordIfLeaseFree } from "~/lib/operation-lease.server";
import { syncedRowsFingerprint } from "~/lib/synced-rows-fingerprint.server";
import {
  contentFilesMayHaveChanged,
  pageRowsOf,
  renderedContentMatchesHead,
  storyRowsOf,
  watchedPageFiles,
} from "~/lib/head-content-match.server";
import type { StoryRow } from "~/lib/head-content-match.server";
import { fetchLatestRelease } from "~/lib/upgrade.server";
import type { ReleaseLookupError } from "~/lib/upgrade.server";

export const STATUS_TTL_MS = 45_000;
export const TAG_TTL_MS = 600_000;

export interface CachedGithubStatus {
  gh_repo_available: number | null;
  gh_remote_head_sha: string | null;
  /** null = cold, 0 = in sync, 1 = diverged, 2 = the last check could not be made. */
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
  /** The last check of GitHub did not conclude, so divergence is unknown. */
  checkFailed: boolean;
  /** No head is recorded: the site has not been published from the Compositor. */
  firstPublish: boolean;
  needsUpgrade: boolean;
  isBelowMinimum: boolean;
  latestTelarTag: string | null;
  /** Real content-diff count (computeChangeSummary), merged over the loader's
   *  cheap updated_at proxy. Optional/undefined when it couldn't be computed. */
  unpublishedCount?: number;
  /** The caller's own repository state from D1; null when none is recorded. */
  ownRepoAccess?: OwnRepoAccess | null;
}

export function isStale(checkedAt: string | null, now: number, ttlMs = STATUS_TTL_MS): boolean {
  if (!checkedAt) return true;
  return Date.parse(checkedAt) < now - ttlMs;
}

/**
 * SHA-tagged divergence: the cached verdict is only valid while local head is
 * unchanged. A verdict recorded with no local head (a site whose story files
 * differ from HEAD before any base was recorded) is against null, and holds
 * while the head is still null.
 */
export function deriveHeadDiverged(cache: CachedGithubStatus, localHeadSha: string | null): boolean {
  return (
    cache.gh_diverged === 1 &&
    cache.gh_diverged_against_sha === localHeadSha &&
    cache.gh_remote_head_sha !== null &&
    cache.gh_remote_head_sha !== localHeadSha
  );
}

/**
 * The failed state, tagged like the divergence verdict: it describes the check
 * made against `localHeadSha` and lapses when the head moves. Unlike a
 * divergence it needs no remote head, since a check that could not read the
 * remote head is one of the ways it fails.
 */
export function deriveCheckFailed(cache: CachedGithubStatus, localHeadSha: string | null): boolean {
  return cache.gh_diverged === 2 && cache.gh_diverged_against_sha === localHeadSha;
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
  role: "convenor" | "collaborator" | "instructor" | null;
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
//
// The cache is unkeyed, and a release-tag override does not change that: the
// override is a deployment variable, constant for the life of every isolate
// that reads it, so one deployment can never mix pinned and unpinned answers
// in this cache.
//
// A success is kept for TAG_TTL_MS. A failure is kept apart from it, as a
// failure, until `retryAt`: at least TAG_FAILURE_RETRY_MS after it, and never
// before a rate-limit answer says the next request may be made. Writes that
// depend on the latest release refuse while the answer is a failure, so the
// failure must not outlive a GitHub that has recovered by more than that.
type TagCacheEntry =
  | { ok: true; tag: string; fetchedAt: number }
  | { ok: false; retryAt: number };

let _tagCache: TagCacheEntry | null = null;
// One lookup per isolate at a time; concurrent callers share its answer.
let _tagLookup: Promise<LatestTagRead> | null = null;
// Read when a failure arrives: a failure's deadlines run from its receipt, not
// from the `now` its caller passed before a lookup that may have taken seconds.
let _clock: () => number = () => Date.now();
export function __resetTagCacheForTest() {
  _tagCache = null;
  _tagLookup = null;
  _clock = () => Date.now();
}
export function __setTagClockForTest(clock: () => number) {
  _clock = clock;
}

export const TAG_FAILURE_RETRY_MS = 30_000;

/** The latest release tag, or the fact that it could not be read. */
export type LatestTagRead = { ok: true; tag: string } | { ok: false };

/** Warm read only — never fetches. undefined = cold (caller decides whether to fetch). */
export function readWarmLatestTag(now: number, ttlMs = TAG_TTL_MS): LatestTagRead | undefined {
  if (!_tagCache) return undefined;
  if (_tagCache.ok) {
    return _tagCache.fetchedAt >= now - ttlMs ? { ok: true, tag: _tagCache.tag } : undefined;
  }
  return now < _tagCache.retryAt ? { ok: false } : undefined;
}

/**
 * Warm read, else one lookup shared by every concurrent caller in the
 * isolate. Never throws: a failed lookup is answered as `{ ok: false }`.
 *
 * `releaseTag` pins the fetch to one release; see fetchLatestRelease.
 */
export function readLatestTag(token: string, now: number, releaseTag?: string, ttlMs = TAG_TTL_MS): Promise<LatestTagRead> {
  const warm = readWarmLatestTag(now, ttlMs);
  if (warm) return Promise.resolve(warm);
  if (!_tagLookup) {
    _tagLookup = lookupLatestTag(token, now, releaseTag).finally(() => {
      _tagLookup = null;
    });
  }
  return _tagLookup;
}

async function lookupLatestTag(token: string, now: number, releaseTag?: string): Promise<LatestTagRead> {
  try {
    const latest = await fetchLatestRelease(token, releaseTag);
    _tagCache = { ok: true, tag: latest.tagName, fetchedAt: now };
    return { ok: true, tag: latest.tagName };
  } catch (err) {
    const failedAt = Math.max(now, _clock());
    _tagCache = { ok: false, retryAt: failureRetryAt(err, failedAt) };
    return { ok: false };
  }
}

/**
 * When a failed lookup may be retried, counted from `failedAt`, the moment the
 * failure was received: the later of the floor and GitHub's word.
 */
function failureRetryAt(err: unknown, failedAt: number): number {
  const floor = failedAt + TAG_FAILURE_RETRY_MS;
  const limit = rateLimitOf(err);
  if (!limit) return floor;
  const fromRetryAfter =
    limit.retryAfterSeconds !== null ? failedAt + limit.retryAfterSeconds * 1000 : floor;
  const fromReset =
    limit.rateLimitResetEpochSeconds !== null ? limit.rateLimitResetEpochSeconds * 1000 : floor;
  return Math.max(floor, fromRetryAfter, fromReset);
}

/**
 * The rate-limit fields of a ReleaseLookupError, read by shape rather than
 * by class so this catch cannot itself throw where the class is not loaded.
 */
function rateLimitOf(
  err: unknown,
): Pick<ReleaseLookupError, "retryAfterSeconds" | "rateLimitResetEpochSeconds"> | null {
  if (typeof err !== "object" || err === null) return null;
  if (!("retryAfterSeconds" in err) || !("rateLimitResetEpochSeconds" in err)) return null;
  return err as ReleaseLookupError;
}

/**
 * The tag-or-null reading, for callers that only show the version and fail
 * open: a failure reads as null, and undefined is a cold cache.
 */
export function getCachedLatestTagIfWarm(now: number, ttlMs = TAG_TTL_MS): string | null | undefined {
  const warm = readWarmLatestTag(now, ttlMs);
  if (!warm) return undefined;
  return warm.ok ? warm.tag : null;
}

/** readLatestTag as tag-or-null, for the same fail-open callers. */
export async function getCachedLatestTag(token: string, now: number, releaseTag?: string, ttlMs = TAG_TTL_MS): Promise<string | null> {
  const read = await readLatestTag(token, now, releaseTag, ttlMs);
  return read.ok ? read.tag : null;
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

/**
 * Compare-and-set head advance, and the cache invalidation that goes with it
 * (gh_checked_at nulled): the write lands only while `head_sha` is still
 * `fromSha`, the commit the caller built on or read, so a head another writer
 * recorded in the meantime is never overwritten, and a commit is never
 * recorded over GitHub edits the Compositor has not read. `fromSha` null
 * is a project with no head recorded, matched with IS NULL, since `= NULL`
 * matches no row in SQL. Returns whether a row changed; zero rows is another
 * writer's head, to be left alone. `also` is written with the head, and only
 * when the head is. objects_read_sha advances with it as
 * `objectsReadAdvancedFrom` has it, from `objectsReadFrom` where the record
 * the writer read is not `fromSha`.
 */
export async function bumpProjectHeadFrom(
  db: ReturnType<typeof getDb>,
  projectId: number,
  fromSha: string | null,
  toSha: string,
  now = Date.now(),
  also: { last_synced_at?: string; page_files_json?: string } = {},
  objectsReadFrom: string | null = fromSha,
): Promise<boolean> {
  const atFrom = fromSha === null ? isNull(projects.head_sha) : eq(projects.head_sha, fromSha);
  const updated = await db
    .update(projects)
    .set({
      ...also,
      head_sha: toSha,
      objects_read_sha: objectsReadAdvancedFrom(fromSha, toSha, objectsReadFrom),
      gh_checked_at: null,
      updated_at: new Date(now).toISOString(),
    })
    .where(and(eq(projects.id, projectId), atFrom))
    .returning({ id: projects.id });
  return updated.length === 1;
}

/**
 * The compare-and-set of `bumpProjectHeadFrom` as one column of a wider write:
 * head_sha becomes `toSha` only while the row still holds `fromSha`, and keeps
 * its value otherwise, while the write's other columns land either way. SQL's
 * IS matches NULL with NULL and a string with an equal string, so a null
 * `fromSha` is a project that had no head recorded.
 */
export function headAdvancedFrom(fromSha: string | null, toSha: string): SQL {
  return sql`CASE WHEN ${projects.head_sha} IS ${fromSha} THEN ${toSha} ELSE ${projects.head_sha} END`;
}

/**
 * objects_read_sha, the last commit whose objects.csv object rows D1 accounts
 * for, advanced with a head write from `fromSha` to `toSha`: it becomes
 * `toSha` only while head_sha is still `fromSha` and the record is `fromSha`
 * too, the head being replaced. A record an objects commit advanced on its own
 * (`bumpObjectsReadFrom`) is left, so a head write that lands late never moves
 * it back. Null-aware as `headAdvancedFrom` is. Only a writer that has read
 * objects.csv at `toSha`, or holds what that commit's objects.csv holds, may
 * write it. `readFrom` is the record the write replaces where it is not the
 * head, as over no head, when it is the import's or none.
 */
export function objectsReadAdvancedFrom(fromSha: string | null, toSha: string, readFrom: string | null = fromSha): SQL {
  return sql`CASE WHEN ${projects.head_sha} IS ${fromSha} AND ${projects.objects_read_sha} IS ${readFrom} THEN ${toSha} ELSE ${projects.objects_read_sha} END`;
}

/**
 * The commit an import read, while no head is recorded: the commit of the page
 * files record the import writes, which every later writer of the record keeps
 * until a head is recorded with it. Null once a head is recorded, and for a
 * project whose import wrote no record.
 */
export function importCommitOf(project: { head_sha: string | null; page_files_json?: string | null }): string | null {
  if (project.head_sha !== null) return null;
  return parsePageFilesRecord(project.page_files_json)?.commit ?? null;
}

/**
 * objects_read_sha advanced with a head write that replaces whatever head the
 * row holds: `toSha` only where the record is that head. Compared with `=`, so
 * no record over no head stays no record: a write that is not a compare-and-set
 * from a head it read cannot vouch for an objects.csv nothing has read, as
 * after an import from Google Sheets, which records neither.
 */
export function objectsReadFollowingHead(toSha: string): SQL {
  return sql`CASE WHEN ${projects.objects_read_sha} = ${projects.head_sha} THEN ${toSha} ELSE ${projects.objects_read_sha} END`;
}

/**
 * Compare-and-set advance of objects_read_sha alone, for a writer that read
 * objects.csv without reading the rest of the commit: the objects commits,
 * whose objects.csv is the one they wrote from D1, and the object rename. Lands
 * only while the record is still `fromSha`, null matched with IS NULL. Returns
 * whether a row changed.
 */
export async function bumpObjectsReadFrom(
  db: ReturnType<typeof getDb>,
  projectId: number,
  fromSha: string | null,
  toSha: string,
): Promise<boolean> {
  const atFrom = fromSha === null ? isNull(projects.objects_read_sha) : eq(projects.objects_read_sha, fromSha);
  const updated = await db
    .update(projects)
    .set({ objects_read_sha: toSha })
    .where(and(eq(projects.id, projectId), atFrom))
    .returning({ id: projects.id });
  return updated.length === 1;
}

type Db = ReturnType<typeof getDb>;

/** The page files record the diff's page check gives at its head, for the silent bump; none when it gives none. */
function checkedRecord(diff: Awaited<ReturnType<typeof computeFullSyncDiff>>): { recordJson?: string } {
  const record = diff.pages?.conclusive ? diff.pages.record : undefined;
  return record ? { recordJson: serialisePageFilesRecord(record) } : {};
}

/** A verdict that records `remoteHead`, over D1's rows as `d1Fingerprint` read them. */
function advanceTo(remoteHead: string, d1Fingerprint: string): HeadVerdict {
  return { diverged: 0, against: remoteHead, headToWrite: remoteHead, d1Fingerprint };
}

interface RefreshableProject {
  id: number;
  head_sha: string | null;
  github_repo_full_name: string | null;
  /** Set once the project's ids have been repaired (migration 0063); absent is not yet. */
  legacy_ids_repaired_at?: string | null;
  /** The commit whose object rows D1 accounts for, which legacy pairing is judged against. */
  objects_read_sha?: string | null;
}

/** Who a refresh takes the objects lease as, to record a head under it. */
export interface RefreshLease {
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">;
  userId: number;
}

/**
 * The GitHub waterfall, parallelized. Writes the cache columns + the real
 * gh_checked_at, and performs the head_sha backfill / silent no-change bump
 * (folded into the single cache write so an interruption can't leave head_sha
 * advanced with a stale verdict). The verdict is `headVerdict`'s; it reads no
 * story file, and no page file with a base, since this runs every 45 seconds
 * while the heads differ. A head is recorded as a sync check records one
 * (`recordIfLeaseFree`): under the objects lease, taken as `lease`, and only
 * while D1's compared rows are the ones the verdict compared. Caller has
 * already won the claim (claimRefresh). Fail-open: on error it leaves prior
 * cache values; the claim's gh_checked_at stamp prevents hammering — next
 * refresh after TTL retries.
 */
export async function refreshGithubStatus(
  project: RefreshableProject,
  token: string,
  db: ReturnType<typeof getDb>,
  now: number,
  lease: RefreshLease,
): Promise<void> {
  if (!project.github_repo_full_name?.includes("/")) return;
  const [owner, repo] = project.github_repo_full_name.split("/");
  const nowIso = new Date(now).toISOString();
  try {
    const [{ availability, canonicalFullName }, remoteHead] = await Promise.all([
      checkRepoAvailability(token, owner, repo),
      getRepoHead(token, owner, repo).catch(() => null),
    ]);
    // Rename-healing: REST follows GitHub's rename redirect, so a canonical
    // full_name that differs from the stored one means the repo was renamed.
    // Folded into the single atomic write below rather than a second
    // db.update — see the write's own comment for why that must stay atomic.
    const renamedTo =
      canonicalFullName && canonicalFullName !== project.github_repo_full_name
        ? canonicalFullName
        : null;

    if (availability === "unavailable") {
      await db.update(projects)
        .set({ gh_repo_available: 0, gh_checked_at: nowIso })
        .where(eq(projects.id, project.id));
      return;
    }
    // A rate-limited probe says nothing about the repository: the check could
    // not be made, whatever the head fetch returned. A head that was read does
    // show the repository is reachable, so an earlier refusal stops standing.
    if (availability === "rate_limited") {
      console.warn("[github-status] rate limited checking", project.github_repo_full_name);
      await writeCheckFailed(db, project, nowIso, remoteHead ? { gh_repo_available: 1 } : {});
      return;
    }
    // Repo is available (or transient "error" → fail-open). A head fetch that
    // failed is a check that could not be made.
    if (!remoteHead) {
      console.warn("[github-status] getRepoHead returned null for", project.github_repo_full_name);
      await writeCheckFailed(db, project, nowIso);
      return;
    }

    const verdict = await headVerdict(project, token, owner, repo, db, remoteHead);
    const writeRefreshCache = (advance: boolean) =>
      writeRefreshVerdict(db, project, verdict, { nowIso, remoteHead, renamedTo, advance });
    if (!verdict.headToWrite) {
      await writeRefreshCache(false);
      return;
    }
    // An apply holding the objects lease may be writing the rows the verdict
    // compared, or may have written them since: the head is recorded only
    // under a lease granted here, while D1's rows are still as compared.
    let recorded = false;
    await recordIfLeaseFree(lease.env, project.id, lease.userId, "objects", async () => {
      if ((await syncedRowsFingerprint(db, project.id)) !== verdict.d1Fingerprint) return false;
      await writeRefreshCache(true);
      recorded = true;
      return true;
    });
    if (!recorded) await writeRefreshCache(false);
  } catch (err) {
    // The check did not conclude: record that, stamped now, so the next
    // refresh after the TTL tries again.
    console.warn("[github-status] refreshGithubStatus failed", err);
    await writeCheckFailed(db, project, nowIso).catch(() => {});
  }
}

/**
 * Records that the check could not be made (`gh_diverged` 2), against the head
 * loaded. What GitHub last reported (availability, remote head) is left as it
 * was, since this check read none of it, unless `reachable` says the head read
 * succeeded, which shows the repository is available.
 */
async function writeCheckFailed(
  db: ReturnType<typeof getDb>,
  project: RefreshableProject,
  nowIso: string,
  reachable: { gh_repo_available?: 1 } = {},
): Promise<void> {
  const loadedHead = project.head_sha;
  const whileLoaded = (value: string | number | null, otherwise: SQL) =>
    sql`CASE WHEN ${projects.head_sha} IS ${loadedHead} THEN ${value} ELSE ${otherwise} END`;
  await db.update(projects)
    .set({ ...verdictColumns({ diverged: 2, against: loadedHead }, nowIso, whileLoaded), ...reachable })
    .where(eq(projects.id, project.id));
}

/**
 * The refresh's one write, `advance` true to advance the head the verdict
 * names. A verdict that names a head to advance to and is written without the
 * advance is not written: it was reached over rows that may not be D1's, and
 * the claim's gh_checked_at stamp stands, so the next refresh after the TTL
 * computes it again. What GitHub holds (availability, remote head, the rename)
 * is written either way.
 */
async function writeRefreshVerdict(
  db: ReturnType<typeof getDb>,
  project: RefreshableProject,
  verdict: HeadVerdict,
  write: { nowIso: string; remoteHead: string; renamedTo: string | null; advance: boolean },
): Promise<void> {
  const { nowIso, remoteHead, renamedTo, advance } = write;
  // Single atomic write: head advance (if any) + rename heal (if any) + all
  // cache columns together. The verdict holds only for the head it was
  // computed against, so everything that depends on it lands only while the
  // row still holds that head: the head advance, updated_at with it, the
  // verdict columns and the gh_checked_at stamp. A writer that moved the
  // head since the load also nulled gh_checked_at; the stamp stays NULL and
  // the verdict columns keep their values, which that NULL marks as cold,
  // so the next refresh computes a verdict for the new head. What GitHub
  // holds (availability, remote head, the rename) is written either way.
  const loadedHead = project.head_sha;
  const whileLoaded = (value: string | number | null, otherwise: SQL) =>
    sql`CASE WHEN ${projects.head_sha} IS ${loadedHead} THEN ${value} ELSE ${otherwise} END`;
  const verdictStands = advance || !verdict.headToWrite;
  await db.update(projects).set({
    ...(advance ? refreshHeadAdvance(loadedHead, verdict, whileLoaded(nowIso, sql`${projects.updated_at}`)) : {}),
    ...(renamedTo ? { github_repo_full_name: renamedTo } : {}),
    gh_repo_available: 1,
    gh_remote_head_sha: remoteHead,
    ...(verdictStands ? verdictColumns(verdict, nowIso, whileLoaded) : {}),
  }).where(eq(projects.id, project.id));
}

/** The verdict columns and their gh_checked_at stamp, each written only while the head is the one loaded. */
function verdictColumns(
  verdict: HeadVerdict,
  nowIso: string,
  whileLoaded: (value: string | number | null, otherwise: SQL) => SQL,
) {
  return {
    gh_diverged: whileLoaded(verdict.diverged, sql`${projects.gh_diverged}`),
    gh_diverged_against_sha: whileLoaded(verdict.against, sql`${projects.gh_diverged_against_sha}`),
    gh_checked_at: whileLoaded(nowIso, sql`NULL`),
  };
}

/**
 * The columns a refresh writes to advance the head, each only while the head
 * is still `loadedHead`: none when the verdict advances nothing. The page
 * files record goes with the head when the verdict carries one. The backfill
 * over no head compares rendered stories and reads no objects.csv, so
 * objects_read_sha advances only from a base whose advance the diff settled
 * with objects.csv read: the recorded head, or the import's commit.
 */
function refreshHeadAdvance(loadedHead: string | null, verdict: HeadVerdict, updatedAt: SQL) {
  const { headToWrite, recordJson, objectsReadFrom } = verdict;
  if (!headToWrite) return {};
  const head = {
    head_sha: headAdvancedFrom(loadedHead, headToWrite), updated_at: updatedAt,
    ...(recordJson ? { page_files_json: pageFilesRecordAdvancedFrom(loadedHead, recordJson) } : {}),
  };
  if (objectsReadFrom === undefined) return head;
  return { ...head, objects_read_sha: objectsReadAdvancedFrom(loadedHead, headToWrite, objectsReadFrom) };
}

interface HeadVerdict {
  /** 2 is a check that could not be made, which says nothing about divergence. */
  diverged: 0 | 1 | 2;
  against: string | null;
  /** Set when head_sha advances: the backfill, or the silent no-change bump. */
  headToWrite?: string;
  /**
   * With `headToWrite`: the fingerprint of D1's compared rows
   * (`syncedRowsFingerprint`) taken before the comparison read them.
   */
  d1Fingerprint?: string;
  /** With `headToWrite`: the page files record at it, written with the head. */
  recordJson?: string;
  /** With `headToWrite`: the base the diff compared objects.csv from, which objects_read_sha advances from. */
  objectsReadFrom?: string;
}

/**
 * Whether the site has diverged from `remoteHead`, and whether head_sha
 * advances to it.
 *
 * Requests, with a base and the heads apart: this adds at most six to the
 * refresh, one GraphQL request for the subtree oids and up to five tree
 * listings (the spreadsheets subtree at both commits when it changed, the
 * layer subtree once when it did not, and the pages folder at both commits,
 * or once when it did not change). With no base: one GraphQL request and up
 * to two listings for the stories, and one more GraphQL request and one
 * listing for the pages folder. The rest of the
 * refresh's requests are the existing availability, head and diff reads.
 *
 * Scope of "reads no file": a story's step CSV and layer files, and with a
 * base a page's file, are decided from trees alone, so none of them is read
 * here. With no base, a page whose block was never captured is rendered with
 * the block of the file a publish carries it from, which is read
 * (`renderedPagesMatchHead`). The other categories (objects.csv, project.csv,
 * glossary.csv, _config.yml) go through `computeFullSyncDiff` as before,
 * which reads those four files; whether each change there is a real one is
 * the dialog's decision.
 *
 * The base is the recorded head, or with none the commit the import read
 * (`importCommitOf`). With no base, HEAD is backfilled as acknowledged only
 * when it already holds what a publish of D1's stories and pages would commit
 * (`renderedStoriesMatchHead`, `renderedPagesMatchHead`); otherwise the site
 * is divergent against no head. With no head and GitHub still at the
 * import's commit, HEAD is backfilled the same way, and otherwise nothing has
 * changed on GitHub. With a base GitHub has moved from, a possible change to a D1 story's
 * or page's files (`contentFilesMayHaveChanged`) is divergence; everything
 * else is decided by the existing diff, as before. A page held in two
 * languages is not a change on GitHub: the publish page asks which to keep.
 *
 * A listing that comes back null (truncated, a symlink, a submodule) and a
 * sheet the sync refuses for its colliding columns are divergence; a request
 * that throws is not one but a check that could not be made (`diverged` 2),
 * and the head never advances on either.
 */
/**
 * The verdict where HEAD is the import's commit or no base is known: a HEAD
 * that holds what a publish would commit is recorded with the page files
 * record it matches; one that does not is a difference only where there is no
 * base to say the files are the import's own layout.
 */
function atImportVerdict(
  hasBase: boolean,
  matches: boolean,
  remoteHead: string,
  d1Fingerprint: string,
  pageRows: Parameters<typeof heldPagesRecord>[1],
): HeadVerdict {
  if (!matches) return { diverged: hasBase ? 0 : 1, against: null };
  return { ...advanceTo(remoteHead, d1Fingerprint), recordJson: serialisePageFilesRecord(heldPagesRecord(remoteHead, pageRows)) };
}

async function headVerdict(
  project: RefreshableProject,
  token: string,
  owner: string,
  repo: string,
  db: Db,
  remoteHead: string,
): Promise<HeadVerdict> {
  const recorded = project.head_sha;
  // With no head recorded, the commit the import read is the base: an edit on
  // GitHub since the import is a change to review, which the first publish
  // would otherwise overwrite unread.
  const base = recorded ?? importCommitOf(project);
  if (recorded !== null && base === remoteHead) return { diverged: 0, against: recorded };
  try {
    // Everything in D1 the verdict compares, taken before it reads any of it.
    const d1Fingerprint = await syncedRowsFingerprint(db, project.id);
    const storyRows = await storyRowsOf(db, project.id);
    const pageRows = await pageRowsOf(db, project.id);
    if (!base || base === remoteHead) {
      // No head recorded, and no base or GitHub still at the import's commit.
      // There, files that differ from what a publish would commit are the
      // import's own layout, which the first publish rewrites, not a change
      // on GitHub.
      return atImportVerdict(!!base, await renderedContentMatchesHead(token, owner, repo, remoteHead, db, project.id, storyRows, pageRows), remoteHead, d1Fingerprint, pageRows);
    }
    const storyIds = storyRows.map((s) => s.story_id);
    const watched = await watchedPageFiles(db, project.id, pageRows);
    if (await contentFilesMayHaveChanged(token, owner, repo, base, remoteHead, storyIds, watched)) {
      return { diverged: 1, against: recorded };
    }
    const diff = await computeFullSyncDiff(project.id, token, owner, repo, db, base, {
      headRef: remoteHead,
      frameworkVersion: await readSiteTelarVersion(db, project.id),
      // Until the ids are repaired, a row stored stripped is divergence
      // (`respelled`), which sends the author to the sync that repairs it.
      legacyRef: project.legacy_ids_repaired_at == null ? legacyRecordRef(project) : undefined,
    });
    if (hasDivergentChanges(diff)) return { diverged: 1, against: recorded };
    return { ...advanceTo(remoteHead, d1Fingerprint), ...checkedRecord(diff), objectsReadFrom: base };
  } catch (err) {
    // A sheet the sync refuses is a change GitHub holds, which the review
    // names; any other throw is a request that did not conclude.
    return { diverged: err instanceof CollidingColumnsRefusal ? 1 : 2, against: recorded };
  }
}

/**
 * GitHub status cache — keeps the per-navigation _app loader off the GitHub
 * API. The loader READS cached values (instant); the Site Status pill REFRESHES
 * them out-of-band via /api/site-status?payload=gh-status. This split is what
 * keeps every navigation fast: GitHub work never blocks the loader, and the
 * pill reconciles the cache in the background.
 *
 * @version v1.5.0-beta
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { layers, project_config, project_pages, projects, steps, stories } from "~/db/schema";
import { getDb } from "~/lib/db.server";
import { checkRepoAvailability, getFileAtRef, getRepoHead, getSubtreeOids, listSubtreeFiles } from "~/lib/github.server";
import type { SubtreeAt } from "~/lib/github.server";
import type { OwnRepoAccess } from "~/lib/repo-access";
import { carriedPageFile, renderStoryFiles } from "~/lib/publish.server";
import { holdsReducedPair } from "~/lib/page-files-check.server";
import { PAGE_TEXTS_DIR, heldPageFileName, pageFileReader, publishedPageFile } from "~/lib/page-content.server";
import { isRecordedPageFileName, parsePageFilesRecord, serialisePageFilesRecord } from "~/lib/page-files-record";
import { heldPagesRecord, pageFilesRecordAdvancedFrom } from "~/lib/page-files-record.server";
import type { PageCheckD1Page } from "~/lib/page-content.server";
import type { CommitFile } from "~/lib/commit.server";
import { gitBlobSha } from "~/lib/story-files.server";
import { computeFullSyncDiff, hasDivergentChanges } from "~/lib/sync.server";
import { legacyRecordRef } from "~/lib/legacy-object-ids.server";
import { readSiteTelarVersion } from "~/lib/site-version.server";
import { recordIfLeaseFree } from "~/lib/operation-lease.server";
import { syncedRowsFingerprint } from "~/lib/synced-rows-fingerprint.server";
import { fetchLatestRelease } from "~/lib/upgrade.server";
import type { ReleaseLookupError } from "~/lib/upgrade.server";

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
 * `objectsReadAdvancedFrom` has it.
 */
export async function bumpProjectHeadFrom(
  db: ReturnType<typeof getDb>,
  projectId: number,
  fromSha: string | null,
  toSha: string,
  now = Date.now(),
  also: { last_synced_at?: string; page_files_json?: string } = {},
): Promise<boolean> {
  const atFrom = fromSha === null ? isNull(projects.head_sha) : eq(projects.head_sha, fromSha);
  const updated = await db
    .update(projects)
    .set({
      ...also,
      head_sha: toSha,
      objects_read_sha: objectsReadAdvancedFrom(fromSha, toSha),
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
 * write it.
 */
export function objectsReadAdvancedFrom(fromSha: string | null, toSha: string): SQL {
  return sql`CASE WHEN ${projects.head_sha} IS ${fromSha} AND ${projects.objects_read_sha} IS ${fromSha} THEN ${toSha} ELSE ${projects.objects_read_sha} END`;
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
 * objects.csv without reading the rest of the commit: the objects sync, and
 * the objects commits, whose objects.csv is the one they wrote from D1. Lands
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

const SPREADSHEETS_DIR = "telar-content/spreadsheets";
const STORY_TEXTS_DIR = "telar-content/texts/stories";

type Db = ReturnType<typeof getDb>;

const INCONCLUSIVE = null;

/**
 * One story subtree at both commits, as a comparable pair: both files maps,
 * with an absent subtree as an empty map, or null when the trees cannot
 * settle it (anything but a tree at the path, a tree at one commit only, or
 * a listing `listSubtreeFiles` cannot trust). Equal oids are listed once.
 */
async function subtreePair(
  token: string,
  owner: string,
  repo: string,
  before: SubtreeAt,
  after: SubtreeAt,
): Promise<{ same: boolean; before: Map<string, string>; after: Map<string, string> } | null> {
  if (before.kind === "absent" && after.kind === "absent") return { same: true, before: new Map(), after: new Map() };
  if (before.kind !== "tree" || after.kind !== "tree") return INCONCLUSIVE;
  if (before.oid === after.oid) {
    const files = await listSubtreeFiles(token, owner, repo, before.oid);
    return files === null ? INCONCLUSIVE : { same: true, before: files, after: files };
  }
  const [b, a] = await Promise.all([
    listSubtreeFiles(token, owner, repo, before.oid),
    listSubtreeFiles(token, owner, repo, after.oid),
  ]);
  return b === null || a === null ? INCONCLUSIVE : { same: false, before: b, after: a };
}

/**
 * Whether the files of a D1 story or page may have changed between `base`
 * and `head`, decided from trees alone, all three subtrees read in one
 * request: any blob change under `texts/stories`, a change to
 * `spreadsheets/<story>.csv` for a story D1 holds, or a page file added,
 * removed or changed as the change check reads it (`pageFilesMayHaveChanged`).
 *
 * It answers "may have changed" whenever the trees cannot settle it: a commit
 * that does not resolve or a malformed answer (`getSubtreeOids`), anything
 * but a tree at a subtree path, a story subtree at one commit only, a
 * truncated listing, or a symlink or submodule anywhere in a subtree it
 * lists. A story subtree absent at both commits is no change.
 */
async function contentFilesMayHaveChanged(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
  storyIds: readonly string[],
  pageFileNames: ReadonlySet<string>,
): Promise<boolean> {
  const trees = await getSubtreeOids(token, owner, repo, [base, head], [SPREADSHEETS_DIR, STORY_TEXTS_DIR, PAGE_TEXTS_DIR]);
  if (!trees.ok) return true;
  if (await storyFilesMayHaveChanged(token, owner, repo, base, head, trees, storyIds)) return true;
  return pageFilesMayHaveChanged(token, owner, repo, trees.at(base, PAGE_TEXTS_DIR), trees.at(head, PAGE_TEXTS_DIR), pageFileNames);
}

type SubtreeAnswers = Extract<Awaited<ReturnType<typeof getSubtreeOids>>, { ok: true }>;

/** The story half of `contentFilesMayHaveChanged`. */
async function storyFilesMayHaveChanged(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
  trees: SubtreeAnswers,
  storyIds: readonly string[],
): Promise<boolean> {
  const texts = trees.at(base, STORY_TEXTS_DIR);
  const textsAfter = trees.at(head, STORY_TEXTS_DIR);
  if (texts.kind === "tree" && textsAfter.kind === "tree" && texts.oid !== textsAfter.oid) return true;
  const [sheets, textPair] = await Promise.all([
    subtreePair(token, owner, repo, trees.at(base, SPREADSHEETS_DIR), trees.at(head, SPREADSHEETS_DIR)),
    subtreePair(token, owner, repo, texts, textsAfter),
  ]);
  if (sheets === null || textPair === null) return true;
  if (sheets.same) return false;
  return storyIds.some((id) => sheets.before.get(`${id}.csv`) !== sheets.after.get(`${id}.csv`));
}

/**
 * Whether the page files may have changed between the two commits as the
 * change check reads them: a `.md` file directly in the pages
 * folder added, or one of `watchedNames` (the files a page holds or the
 * record gives a page) removed or with a different blob. A file in a
 * subfolder, which the framework does not build, is not a change.
 *
 * It answers "may have changed" whenever the trees cannot settle it: anything
 * but a tree at the path, or a listing `listSubtreeFiles` cannot trust. The
 * folder absent at both commits is no change, and absent at one only is one.
 */
async function pageFilesMayHaveChanged(
  token: string,
  owner: string,
  repo: string,
  before: SubtreeAt,
  after: SubtreeAt,
  watchedNames: ReadonlySet<string>,
): Promise<boolean> {
  if (before.kind === "other" || after.kind === "other") return true;
  if (before.kind === "absent" || after.kind === "absent") return before.kind !== after.kind;
  const pair = await subtreePair(token, owner, repo, before, after);
  if (pair === null) return true;
  if (pair.same) return false;
  const added = [...pair.after.keys()].some((name) => isRecordedPageFileName(name) && !pair.before.has(name));
  return added || [...watchedNames].some((name) => pair.before.get(name) !== pair.after.get(name));
}

/** A project's story rows. */
function storyRowsOf(db: Db, projectId: number) {
  return db.select().from(stories).where(eq(stories.project_id, projectId));
}

type StoryRow = Awaited<ReturnType<typeof storyRowsOf>>[number];

/** A story's step and layer rows, read as a publish reads them. */
async function storyContentRows(db: Db, story: StoryRow) {
  const stepRows = await db.select().from(steps).where(eq(steps.story_id, story.id));
  const layerRows: (typeof layers.$inferSelect)[] = [];
  for (const step of stepRows) {
    layerRows.push(...(await db.select().from(layers).where(eq(layers.step_id, step.id))));
  }
  return { stepRows, layerRows };
}

/**
 * Whether HEAD already holds exactly what a publish of D1's stories would
 * commit: each story's step CSV and layer files, rendered by
 * `renderStoryFiles`, have the git blob SHA HEAD's tree gives their paths.
 * A differing or missing file is a difference. A file HEAD has that the
 * render does not produce is one only if a story's step CSV names it, and
 * then that CSV differs from the rendered one, so it is already counted;
 * a file no CSV names changes no story. Blob SHAs are compared; the only file
 * read is a story CSV whose blob is not the plain render, which the publish
 * wrote in the file's own layout (`storyFilesAsPublished`).
 *
 * A HEAD the trees cannot settle is no match: a commit that does not resolve
 * or a malformed answer, anything but a tree at a subtree path, a truncated
 * listing, or a symlink or submodule in a story subtree (`listSubtreeFiles`), so a
 * symlink where a rendered file should be is a mismatch even when its blob
 * SHA happens to equal the rendered file's.
 */
async function renderedStoriesMatchHead(
  token: string,
  owner: string,
  repo: string,
  head: string,
  db: Db,
  projectId: number,
  storyRows: StoryRow[],
): Promise<boolean> {
  const trees = await getSubtreeOids(token, owner, repo, [head], [SPREADSHEETS_DIR, STORY_TEXTS_DIR]);
  if (!trees.ok) return false;
  const headBlobs = new Map<string, string>();
  for (const dir of [SPREADSHEETS_DIR, STORY_TEXTS_DIR]) {
    const at = trees.at(head, dir);
    if (at.kind === "other") return false;
    if (at.kind === "absent") continue;
    const files = await listSubtreeFiles(token, owner, repo, at.oid);
    if (files === null) return false;
    for (const [path, sha] of files) headBlobs.set(`${dir}/${path}`, sha);
  }
  const [config] = await db
    .select({ lang: project_config.lang })
    .from(project_config)
    .where(eq(project_config.project_id, projectId));
  const siteLang = config?.lang ?? undefined;
  for (const story of storyRows) {
    const { stepRows, layerRows } = await storyContentRows(db, story);
    const at = { token, owner, repo, head, headBlobs };
    if (!(await storyMatchesHead(at, story.story_id, stepRows, layerRows, siteLang))) return false;
  }
  return true;
}

/** What reading a story's files at HEAD needs: the repository, HEAD, and the blob SHAs HEAD's story subtrees hold. */
interface StoryHeadRead {
  token: string;
  owner: string;
  repo: string;
  head: string;
  headBlobs: ReadonlyMap<string, string>;
}

/** Whether HEAD's blobs hold every file a publish writes for one story, in the layout of the story's CSV at HEAD. */
async function storyMatchesHead(
  at: StoryHeadRead,
  storyId: string,
  stepRows: Parameters<typeof renderStoryFiles>[1],
  layerRows: Parameters<typeof renderStoryFiles>[2],
  siteLang: string | undefined,
): Promise<boolean> {
  const files = await storyFilesAsPublished(
    at,
    storyId,
    await renderStoryFiles(storyId, stepRows, layerRows, siteLang),
    (existingCsv) => renderStoryFiles(storyId, stepRows, layerRows, siteLang, existingCsv),
  );
  if (files === null) return false;
  for (const file of files) {
    if (at.headBlobs.get(file.path) !== (await gitBlobSha(file.content))) return false;
  }
  return true;
}

/**
 * A story's files as a publish writes them. The publish writes the step CSV in
 * the file's own layout, so when HEAD's CSV is another blob than the plain
 * render, it is read strictly at HEAD and the story rendered again in that
 * layout, as `storyFilesForPublish` does. A CSV HEAD lacks, or one that cannot
 * be read, gives no files: the story does not match.
 */
async function storyFilesAsPublished(
  at: StoryHeadRead,
  storyId: string,
  plain: CommitFile[],
  renderIn: (existingCsv: string) => Promise<CommitFile[]>,
): Promise<CommitFile[] | null> {
  const path = `${SPREADSHEETS_DIR}/${storyId}.csv`;
  const headSha = at.headBlobs.get(path);
  const plainCsv = plain.find((file) => file.path === path);
  if (headSha === undefined || plainCsv === undefined || headSha === (await gitBlobSha(plainCsv.content))) return plain;
  const read = await getFileAtRef(at.token, at.owner, at.repo, path, at.head, { strict: true });
  return read.status === "ok" ? renderIn(read.content) : null;
}

/** The files a page holds, and those the stored record gives a page. */
async function watchedPageFiles(db: Db, projectId: number, pageRows: readonly PageCheckD1Page[]): Promise<Set<string>> {
  const [stored] = await db.select({ record: projects.page_files_json }).from(projects).where(eq(projects.id, projectId));
  const recorded = Object.entries(parsePageFilesRecord(stored?.record)?.files ?? {}).flatMap(([name, id]) => (id === null ? [] : [name]));
  return new Set([...pageRows.flatMap((page) => heldPageFileName(page) ?? []), ...recorded]);
}

/** The page files record the diff's page check gives at its head, for the silent bump; none when it gives none. */
function checkedRecord(diff: Awaited<ReturnType<typeof computeFullSyncDiff>>): { recordJson?: string } {
  const record = diff.pages?.conclusive ? diff.pages.record : undefined;
  return record ? { recordJson: serialisePageFilesRecord(record) } : {};
}

/** A verdict that records `remoteHead`, over D1's rows as `d1Fingerprint` read them. */
function advanceTo(remoteHead: string, d1Fingerprint: string): HeadVerdict {
  return { diverged: 0, against: remoteHead, headToWrite: remoteHead, d1Fingerprint };
}

/** A project's pages, as the refresh compares them. */
function pageRowsOf(db: Db, projectId: number): Promise<PageCheckD1Page[]> {
  return db
    .select({
      id: project_pages.id,
      slug: project_pages.slug,
      title: project_pages.title,
      body: project_pages.body,
      frontmatter: project_pages.frontmatter,
      frontmatter_source: project_pages.frontmatter_source,
    })
    .from(project_pages)
    .where(eq(project_pages.project_id, projectId));
}

/**
 * Whether HEAD already holds exactly what a publish of D1's pages would
 * commit: each page's file (`publishedPageFile`), directly in the pages
 * folder, has the git blob SHA HEAD's tree gives its path. A differing or
 * missing file is a difference, and so is a `.md` file directly in the
 * folder that no page holds, which the change check reads as an addition. A page whose block was never captured is rendered with the block
 * of the file publish carries it from, read at HEAD by publish's own rule
 * (`carriedPageFile`), and that read is the only file read here; a captured
 * page reads none. A page whose title is blank, for which a publish writes no
 * file, is no match while HEAD holds a file at its slug (`heldPageFileName`).
 *
 * A HEAD the trees cannot settle is no match, as for the stories: a commit
 * that does not resolve, anything but a tree at the path, a listing that
 * cannot be trusted, a carried file that cannot be read, and a page whose
 * front matter no publish could write.
 */
async function renderedPagesMatchHead(
  token: string,
  owner: string,
  repo: string,
  head: string,
  pageRows: readonly PageCheckD1Page[],
): Promise<boolean> {
  const held = pageRows.flatMap((page) => {
    const name = heldPageFileName(page);
    return name === null ? [] : [{ page, name }];
  });
  const files = await pageFilesAtHead(token, owner, repo, head);
  if (files === null) return false;
  const heldNames = new Set(held.map(({ name }) => name));
  if ([...files.keys()].some((name) => isRecordedPageFileName(name) && !heldNames.has(name))) return false;
  const read = pageFileReader({ token, owner, repo }, head, files);
  try {
    for (const { page, name } of held) {
      if (!(await renderedPageMatches(page, name, files, read))) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * The pages folder at `head`, blob SHAs by path relative to it, or null when
 * the tree cannot settle it (`renderedPagesMatchHead`). A folder absent at a
 * commit that resolves is empty.
 */
async function pageFilesAtHead(token: string, owner: string, repo: string, head: string): Promise<Map<string, string> | null> {
  const trees = await getSubtreeOids(token, owner, repo, [head], [PAGE_TEXTS_DIR]);
  if (!trees.ok) return null;
  const at = trees.at(head, PAGE_TEXTS_DIR);
  if (at.kind === "other") return null;
  if (at.kind === "absent") return new Map();
  return listSubtreeFiles(token, owner, repo, at.oid);
}

/**
 * Whether HEAD holds, at `name`, the blob a publish of `page` would commit,
 * the block of a page never captured carried by publish's rule through
 * `read`. A page a publish writes no file for, and a carried file that cannot
 * be read, are no match; a block no publish could write throws.
 */
async function renderedPageMatches(
  page: PageCheckD1Page,
  name: string,
  files: ReadonlyMap<string, string>,
  read: ReturnType<typeof pageFileReader>,
): Promise<boolean> {
  const carried = page.frontmatter === null ? await carriedPageFile(page, read) : { ok: true as const, content: "" };
  if (!carried.ok) return false;
  const slug = name.slice(0, -".md".length);
  const file = await publishedPageFile({ slug, title: page.title, body: page.body, frontmatter: page.frontmatter }, carried.content);
  return file !== null && files.get(name) === (await gitBlobSha(file.content));
}

/**
 * Whether HEAD already holds what a publish of D1's stories and pages would
 * commit (`renderedStoriesMatchHead`, `renderedPagesMatchHead`). No story
 * reads no story tree.
 */
async function renderedContentMatchesHead(
  token: string,
  owner: string,
  repo: string,
  head: string,
  db: Db,
  projectId: number,
  storyRows: StoryRow[],
  pageRows: readonly PageCheckD1Page[],
): Promise<boolean> {
  const storiesMatch =
    storyRows.length === 0 || (await renderedStoriesMatchHead(token, owner, repo, head, db, projectId, storyRows));
  return storiesMatch && renderedPagesMatchHead(token, owner, repo, head, pageRows);
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
    // Repo is available (or transient "error" → fail-open). If the head fetch
    // failed, do NOT clobber the last-known verdict — leave prior gh_* intact.
    if (!remoteHead) {
      console.warn("[github-status] getRepoHead returned null for", project.github_repo_full_name);
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
    // Fail open — leave the claimed gh_checked_at; retry after TTL.
    console.warn("[github-status] refreshGithubStatus failed", err);
  }
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
 * objects_read_sha advances only from a recorded head, whose advance the diff
 * settled with objects.csv read.
 */
function refreshHeadAdvance(loadedHead: string | null, verdict: HeadVerdict, updatedAt: SQL) {
  const { headToWrite, recordJson } = verdict;
  if (!headToWrite) return {};
  const head = {
    head_sha: headAdvancedFrom(loadedHead, headToWrite), updated_at: updatedAt,
    ...(recordJson ? { page_files_json: pageFilesRecordAdvancedFrom(loadedHead, recordJson) } : {}),
  };
  if (loadedHead === null) return head;
  return { ...head, objects_read_sha: objectsReadAdvancedFrom(loadedHead, headToWrite) };
}

interface HeadVerdict {
  diverged: 0 | 1;
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
}

/** Whether the project holds a pair of page files the one-language reduction would change, over its site's language. */
async function holdsPairOfPages(
  project: RefreshableProject,
  token: string,
  owner: string,
  repo: string,
  db: Db,
  head: string,
  pageRows?: readonly PageCheckD1Page[],
): Promise<boolean> {
  const [config] = await db.select({ lang: project_config.lang }).from(project_config).where(eq(project_config.project_id, project.id));
  return holdsReducedPair({ token, owner, repo }, head, pageRows ?? (await pageRowsOf(db, project.id)), config?.lang);
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
 * With no base, HEAD is backfilled as acknowledged only when it already holds
 * what a publish of D1's stories and pages would commit
 * (`renderedStoriesMatchHead`, `renderedPagesMatchHead`); otherwise the site
 * is divergent against no head. With a base, a possible change to a D1 story's
 * or page's files (`contentFilesMayHaveChanged`) is divergence; everything
 * else is decided by the existing diff, as before. Any failure is divergence,
 * and the head never advances on one. A project holding a pair of page files
 * the one-language reduction would change is divergent whether or not GitHub
 * moved (`holdsPairOfPages`); it reads D1's blocks, and GitHub only for a
 * page whose block D1 does not hold.
 */
async function headVerdict(
  project: RefreshableProject,
  token: string,
  owner: string,
  repo: string,
  db: Db,
  remoteHead: string,
): Promise<HeadVerdict> {
  const base = project.head_sha;
  if (base === remoteHead) {
    // Nothing moved on GitHub; a pair the reduction would change is still a change,
    // and a pair check that cannot finish cannot rule one out.
    const pair = await holdsPairOfPages(project, token, owner, repo, db, remoteHead).catch(() => true);
    return { diverged: pair ? 1 : 0, against: base };
  }
  try {
    // Everything in D1 the verdict compares, taken before it reads any of it.
    const d1Fingerprint = await syncedRowsFingerprint(db, project.id);
    const storyRows = await storyRowsOf(db, project.id);
    const pageRows = await pageRowsOf(db, project.id);
    if (!base) {
      if (await holdsPairOfPages(project, token, owner, repo, db, remoteHead, pageRows)) return { diverged: 1, against: null };
      const matches = await renderedContentMatchesHead(token, owner, repo, remoteHead, db, project.id, storyRows, pageRows);
      if (!matches) return { diverged: 1, against: null };
      return { ...advanceTo(remoteHead, d1Fingerprint), recordJson: serialisePageFilesRecord(heldPagesRecord(remoteHead, pageRows)) };
    }
    if (await holdsPairOfPages(project, token, owner, repo, db, remoteHead, pageRows)) return { diverged: 1, against: base };
    const storyIds = storyRows.map((s) => s.story_id);
    const watched = await watchedPageFiles(db, project.id, pageRows);
    if (await contentFilesMayHaveChanged(token, owner, repo, base, remoteHead, storyIds, watched)) {
      return { diverged: 1, against: base };
    }
    const diff = await computeFullSyncDiff(project.id, token, owner, repo, db, base, {
      headRef: remoteHead,
      frameworkVersion: await readSiteTelarVersion(db, project.id),
      // Until the ids are repaired, a row stored stripped is divergence
      // (`respelled`), which sends the author to the sync that repairs it.
      legacyRef: project.legacy_ids_repaired_at == null ? legacyRecordRef(project) : undefined,
    });
    if (hasDivergentChanges(diff)) return { diverged: 1, against: base };
    return { ...advanceTo(remoteHead, d1Fingerprint), ...checkedRecord(diff) };
  } catch {
    return { diverged: 1, against: base };
  }
}

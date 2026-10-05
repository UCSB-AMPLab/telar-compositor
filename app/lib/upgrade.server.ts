/**
 * This file is the library powering the site-upgrade flow — framework tree
 * diffing, line-based config mutation, GitHub Releases lookup,
 * manifest-chain loading, and best-effort publish-time
 * healing of build-critical framework files missing from a user's repo.
 *
 * Design notes:
 *   - Pure functions (isFrameworkPath, findMissingFrameworkFiles,
 *     buildYmlUsesNpmCi, updateTelarVersionInConfig) are unit-testable without
 *     any network calls. Version parsing and comparison live in
 *     telar-version.ts.
 *   - Async functions (fetchLatestRelease, fetchAllReleases,
 *     getFrameworkTreeAtTag, computeUpgradeDiff, checkTelarVersion,
 *     fetchFrameworkFilesAtVersion, frameworkTagExists, resolveHealTag,
 *     dropUnneededLockfile, healMissingFrameworkFiles) interact with the
 *     GitHub REST API and are tested with mocked fetch.
 *   - `_config.yml` mutation is line-based (not full YAML parse) to preserve
 *     comments, whitespace, and user-authored content exactly.
 *   - checkTelarVersion fails open: if the GitHub API is unreachable, the
 *     function returns `needsUpgrade: false` rather than blocking the user.
 *   - healMissingFrameworkFiles fails open too: any failure (bad tag, tree
 *     read, content fetch) degrades to an empty result so publish is never
 *     blocked; the missing file retries on the next publish.
 *
 * Framework repo: UCSB-AMPLab/telar (public — user OAuth token is sufficient).
 * Truncation note: the framework repo has no IIIF tiles, so its tree stays
 * under the 100,000-entry git tree limit; a truncated release tree fails the
 * read (getFrameworkTreeAtTag) rather than being diffed. For user repo
 * trees, framework paths are shallow and appear before IIIF tiles
 * alphabetically, so they will be present even in a truncated tree. Revisit
 * if truncation is ever detected in practice.
 *
 * @version v1.5.0-beta
 */

import { githubHeaders, getRepoTree, getFileContent, getFileBytesAtRef } from "~/lib/github.server";
import { arrayBufferToBase64 } from "~/lib/upload.server";
import type { TreeEntry } from "~/lib/github.server";
import type { CommitFile } from "~/lib/commit.server";
import {
  ManifestValidationError,
  isPathInScope,
  validateManifest,
  type Language,
  type Manifest,
  type Operation,
} from "~/lib/manifest-schema.server";
import { applyOperation } from "~/lib/manifest-runner.server";
import { BUILT_IN_PAGES } from "~/lib/framework-page-frontmatter.server";
import { BUNDLED_MANIFESTS } from "~/../migrations";
import { compareTelarVersion, compareVersions, frameworkVersionForTag, parseTelarVersion } from "~/lib/telar-version";
import { mutateYamlBlock } from "~/lib/config-yaml-block.server";
import {
  DELIVERED_WHEN_ABSENT,
  FRAMEWORK_FILES,
  FRAMEWORK_PREFIXES,
  isFrameworkPath,
} from "~/lib/framework-paths.server";
import {
  DEV_ONLY_FILES_PATH,
  KNOWN_DEV_ONLY_FRAMEWORK_FILES,
  isDevOnlyPath,
  releaseDevOnlyEntries,
  type ReleaseFileRead,
} from "~/lib/dev-only-paths.server";
import {
  ReleaseFileUnreadableError,
  ReleaseListUnreadableError,
  ReleaseManifestInvalidError,
  ReleaseTreeUnreadableError,
} from "~/lib/upgrade-reads.server";

export { FRAMEWORK_FILES, FRAMEWORK_PREFIXES, isFrameworkPath };

const GITHUB_API = "https://api.github.com";
const FRAMEWORK_OWNER = "UCSB-AMPLab";
const FRAMEWORK_REPO = "telar";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelarRelease {
  tagName: string;
  body: string;
  publishedAt: string;
}

export interface UpgradeSummary {
  layouts: number;
  includes: number;
  stylesheets: number;
  scripts: number;
  workflows: number;
  dataFiles: number;
  other: number;
  deletions: number;
  total: number;
}

export interface UpgradeDiff {
  /** New and changed framework files with content fetched from the release. */
  additions: CommitFile[];
  /** Framework paths present in the user's repo but absent in the release tree. */
  deletions: string[];
  /** Grouped file counts for the upgrade summary UI. */
  summary: UpgradeSummary;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Returns the FRAMEWORK_FILES entries that are entirely absent from a user
 * repo's tree paths. Exact-path match only — "docs/package.json" does NOT
 * count as "package.json". Used by the publish-time heal to restore
 * build-critical framework files the version-gated upgrade flow can't deliver.
 */
export function findMissingFrameworkFiles(repoTreePaths: string[]): string[] {
  const present = new Set(repoTreePaths);
  return FRAMEWORK_FILES.filter((path) => !present.has(path));
}

/**
 * Returns true if a build workflow YAML genuinely invokes `npm ci` — i.e. a
 * site that still depends on a committed package-lock.json to build.
 *
 * The framework reverted user-site builds to `npm install` (no lockfile
 * required), so the publish-time heal only delivers package-lock.json to
 * legacy sites whose build.yml still runs `npm ci`. This detector decides that.
 *
 * Matching is line-based and deliberately strict:
 *   - The npm command on the line must be exactly `ci` (word boundary, so
 *     `npm cilantro` does not match).
 *   - A `npm ci || npm install` fallback line does NOT count — those sites
 *     already degrade to npm install when the lockfile is absent, so they
 *     don't need one delivered.
 *   - Commented lines (`# npm ci`) are ignored.
 */
export function buildYmlUsesNpmCi(content: string): boolean {
  if (!content) return false;
  return content.split("\n").some((line) => {
    // Drop anything after a `#` comment marker so commented commands don't match.
    const code = line.replace(/#.*$/, "");
    if (!/(^|\s)npm\s+ci\b/.test(code)) return false;
    // Exclude the `npm ci || npm install` fallback — those sites don't need a
    // lockfile delivered (they fall back to npm install when it's absent).
    if (/npm\s+ci\b\s*\|\|\s*npm\s+install\b/.test(code)) return false;
    return true;
  });
}

/**
 * Fetches the given framework file paths from the framework repo at a specific
 * version tag, returning a CommitFile for each one that exists. Paths the
 * framework did not ship at that tag (content fetch returns null) OR that fail
 * to fetch due to transient error are dropped — e.g. a site pinned below the
 * version that introduced package-lock.json has nothing to restore, and a
 * network failure on one file doesn't block the rest. Order of the returned
 * array follows the input order.
 */
export async function fetchFrameworkFilesAtVersion(
  token: string,
  paths: string[],
  tagName: string,
): Promise<CommitFile[]> {
  // Fetch in parallel so a fresh repo missing many files doesn't serialise into
  // a multi-second stall on the publish hot path. Order is preserved by
  // Promise.all. A file absent at that tag (null) OR a transient fetch error is
  // dropped so one failure never loses the files that did resolve.
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        return await getFrameworkFile(token, path, tagName);
      } catch {
        return null;
      }
    }),
  );
  return results.filter((f): f is CommitFile => f !== null);
}

/**
 * Whether `tagName` names a published release on the framework repo. Uses
 * the Releases API (`releases/tags/<tag>`) rather than a tree or content
 * fetch — the same lookup `fetchLatestRelease` uses for a pinned tag. The
 * lookup asks whether a *published release* exists for that tag, which is
 * what the heal needs, since it fetches release-tagged content; a 404 here
 * does not establish that the git tag itself is absent — releases and tags
 * are distinct — only that no release is published under it.
 *
 * Returns false for a 404 (no published release under that tag). Any other
 * non-OK status throws, so a transient GitHub error is not misread as "no
 * release published here".
 */
async function frameworkTagExists(token: string, tagName: string): Promise<boolean> {
  const res = await fetch(
    `${GITHUB_API}/repos/${FRAMEWORK_OWNER}/${FRAMEWORK_REPO}/releases/tags/${encodeURIComponent(tagName)}`,
    { headers: githubHeaders(token) },
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`GitHub API error checking release tag ${tagName}: ${res.status}`);
  }
  return true;
}

/** The outcome of resolving the heal's tag — see {@link resolveHealTag}. */
type HealTagResolution =
  | { kind: "resolved"; tag: string }
  | { kind: "mismatch"; pinnedTag: string }
  | { kind: "unresolved" };

/**
 * Resolves the tag the heal should fetch missing files at: `tagName` (the
 * site's stamped version) when it names a real framework release, else
 * `pinnedTag` (the deployment's `TELAR_RELEASE_TAG`) — but only when the pin
 * is plausibly the site's own release. A release candidate stamps the
 * release it is a candidate for, so a genuine candidate's stamp and its
 * deployment's pin carry the same framework version (`frameworkVersionForTag`
 * on each must agree); a pin that resolves but names a different release is
 * rejected rather than used, since healing from it would take a missing
 * file from an unrelated release into this site's repo. `pinnedTag` is
 * checked only when `tagName` does not resolve — a site whose stamp names a
 * real tag never has the pin consulted.
 *
 * Returns `{ kind: "resolved", tag }` on success, `{ kind: "mismatch",
 * pinnedTag }` when the pin resolves but is for a different release than
 * the stamp, or `{ kind: "unresolved" }` when neither resolves. The caller
 * turns each outcome into its own warning.
 */
async function resolveHealTag(
  frameworkToken: string,
  tagName: string,
  pinnedTag?: string,
): Promise<HealTagResolution> {
  if (await frameworkTagExists(frameworkToken, tagName)) {
    return { kind: "resolved", tag: tagName };
  }
  if (!pinnedTag || !(await frameworkTagExists(frameworkToken, pinnedTag))) {
    return { kind: "unresolved" };
  }
  if (frameworkVersionForTag(tagName) !== frameworkVersionForTag(pinnedTag)) {
    return { kind: "mismatch", pinnedTag };
  }
  return { kind: "resolved", tag: pinnedTag };
}

/** Renders a pinned tag for the heal's skip warning: quoted, or "(none)" when unset. */
function describePinnedTagForWarning(pinnedTag?: string): string {
  return pinnedTag ? `"${pinnedTag}"` : "(none)";
}

/**
 * package-lock.json is delivered ONLY to legacy sites whose build.yml still
 * runs `npm ci` — the framework otherwise builds with `npm install` and needs
 * no lockfile. The extra build.yml read is paid only when the lockfile is
 * actually among the missing files; sites missing nothing else pay nothing.
 * Fail-OPEN by dropping the lockfile whenever npm ci can't be positively
 * confirmed (build.yml uses npm install, is absent, or fails to read), so an
 * unneeded lockfile is never delivered.
 */
async function dropUnneededLockfile(
  projectToken: string, owner: string, repo: string, missing: string[], ref?: string,
): Promise<string[]> {
  if (!missing.includes("package-lock.json")) return missing;
  let usesNpmCi = false;
  try {
    const buildYml = await getFileContent(
      projectToken,
      owner,
      repo,
      ".github/workflows/build.yml",
      ref,
    );
    usesNpmCi = buildYml !== null && buildYmlUsesNpmCi(buildYml);
  } catch {
    usesNpmCi = false;
  }
  return usesNpmCi ? missing : missing.filter((p) => p !== "package-lock.json");
}

/**
 * `paths` without the developer-only paths of the release at `tagName`, which
 * a site does not carry and the heal therefore never restores. When the list
 * cannot be read, the framework files a release's list is known to name are
 * withheld and the rest restored, so an outage never delivers them and never
 * holds back the files a site does need.
 */
async function withoutDevOnlyPaths(
  frameworkToken: string, tagName: string, paths: string[],
): Promise<string[]> {
  let entries: readonly string[];
  try {
    entries = await releaseDevOnlyEntries(
      (path) => fetchFrameworkFile(frameworkToken, path, tagName),
      frameworkVersionForTag(tagName),
    );
  } catch (err) {
    console.warn("healMissingFrameworkFiles: developer-only list unreadable; withholding the known ones —", err);
    entries = KNOWN_DEV_ONLY_FRAMEWORK_FILES;
  }
  return paths.filter((path) => !isDevOnlyPath(path, entries));
}

/**
 * Best-effort publish-time heal: restores framework files that are entirely
 * missing from the user's repo.
 *
 * The tag to fetch them at is resolved, not assumed:
 *   1. The site's stamped version, normalised into tag shape — this stays
 *      first on purpose. The heal restores files that are entirely missing,
 *      and they should match the version the site is actually on; falling
 *      straight to a pin would drop a mismatched framework version's copy of
 *      a missing file into an unrelated site. Note: resolving to a real
 *      release only proves the release exists, not that it is the release
 *      the site actually ran. A stamp that names a real but incorrect
 *      release (a handful of historical prereleases mis-stamp their own
 *      predecessor) heals from that incorrect release's files, and nothing
 *      here can detect it — the stamp is the only evidence available, and it
 *      is wrong.
 *   2. If that tag does not resolve to a real framework release — a release
 *      candidate's stamp names the release it is a candidate for, not its own
 *      tag, so this is the expected case for a site on a pre-release — fall
 *      back to `pinnedTag` (the deployment's `TELAR_RELEASE_TAG`), when set
 *      AND it names the same release as the stamp (`frameworkVersionForTag`
 *      on each must agree). A pin that resolves but is for a different
 *      release is never used — that would take a missing file from an
 *      unrelated release into this site's repo. The pin is only ever
 *      consulted here: when the stamped tag already resolves, it is never
 *      checked.
 *   3. If neither resolves — no pin is set, the pin doesn't exist, or the
 *      pin exists but names a different release — the heal is skipped with
 *      a distinct warning naming both tags tried, so an unresolvable or
 *      mismatched tag can never look like a clean "nothing was missing"
 *      result.
 *
 * NEVER throws and NEVER blocks publish — any failure (falsy tag, tree read
 * error, content fetch error) degrades to an empty result, and the missing
 * file gets another chance on the next publish. This is deliberately fail-OPEN,
 * unlike the publish snapshot guard, which fails closed: a heal miss only
 * delays a fix, whereas a stale snapshot would ship wrong data.
 *
 * Additive only — returns files to ADD; it does not detect or overwrite files
 * the user already has. A developer-only path of the release is never
 * restored: a site does not carry one. projectToken reads the project's repo; frameworkToken
 * fetches the separate, public framework repo (never covered by that install).
 */
export async function healMissingFrameworkFiles(
  projectToken: string, owner: string, repo: string, tagName: string, frameworkToken: string,
  pinnedTag?: string,
  ref?: string,
): Promise<CommitFile[]> {
  if (!tagName) return [];
  try {
    // Every read of the project's own repository is taken at `ref` when the
    // caller names one. A publish names the revision it is committing against,
    // because a read without one takes the repository's DEFAULT branch: on a
    // site whose default is not the branch being published, this heal judged a
    // file missing from a branch nobody was publishing and added a framework
    // copy over the one the target branch already had.
    const { tree, truncated } = await getRepoTree(projectToken, owner, repo, ref);
    // A truncated tree (very large repos — e.g. thousands of self-hosted IIIF
    // tiles exceeding GitHub's 100k-entry recursive limit) may OMIT framework
    // files that are actually present. Treating them as missing would re-fetch
    // and re-commit them on every publish, breaking the additive-only / never-
    // overwrite guarantee. We cannot trust absence here, so skip the heal.
    if (truncated) {
      console.warn(
        "healMissingFrameworkFiles: repo tree truncated, skipping heal",
      );
      return [];
    }
    const paths = tree.filter((e) => e.type === "blob").map((e) => e.path);
    let missing = findMissingFrameworkFiles(paths);
    if (missing.length === 0) return [];

    missing = await dropUnneededLockfile(projectToken, owner, repo, missing, ref);
    if (missing.length === 0) return [];

    // Resolve the tag once, up front — letting per-file 404s stand in for
    // this is exactly the ambiguity being fixed (a nonexistent tag makes
    // every file fetch fail, so the batch silently returns [] indistinguishable
    // from "nothing was missing").
    const resolution = await resolveHealTag(frameworkToken, tagName, pinnedTag);
    if (resolution.kind === "mismatch") {
      console.warn(
        `healMissingFrameworkFiles: pinned tag "${resolution.pinnedTag}" is for a different ` +
          `release than the stamped tag "${tagName}" — skipping heal`,
      );
      return [];
    }
    if (resolution.kind === "unresolved") {
      console.warn(
        `healMissingFrameworkFiles: unable to resolve a framework release tag — ` +
          `stamped tag "${tagName}" not found, pinned tag ${describePinnedTagForWarning(pinnedTag)} not found; skipping heal`,
      );
      return [];
    }

    const delivered = await withoutDevOnlyPaths(frameworkToken, resolution.tag, missing);
    return await fetchFrameworkFilesAtVersion(frameworkToken, delivered, resolution.tag);
  } catch (err) {
    // warn, not error: this is a best-effort skip (publish still succeeds), so
    // a transient GitHub 5xx here should not trip error-level log alerts.
    console.warn("healMissingFrameworkFiles: skipping heal —", err);
    return [];
  }
}

/**
 * The `telar.release_date` an upgrade stamps: the date the framework declares
 * for the release, carried by the last manifest of the chain, which is the
 * one that installs it. The framework's own engine stamps the same declared
 * date, so a site reads the same value whichever route upgraded it.
 * A manifest from before v1.8.0 carries none, and then the release's
 * publication date stands in, as the UTC day GitHub records.
 */
export function releaseDateForUpgrade(chain: Manifest[], publishedAt: string): string {
  return chain.at(-1)?.release_date ?? publishedAt.slice(0, 10);
}

/**
 * Updates telar.version and telar.release_date inside the telar: block of a
 * _config.yml string using line-based iteration. Content outside those two
 * lines (user values, comments, whitespace) is preserved verbatim; the
 * `version:` and `release_date:` lines themselves are rewritten whole, so a
 * trailing comment on either line is not preserved.
 *
 * Delegates the block-walking (enter on `telar:`, exit on the next
 * non-indented non-comment non-empty line) to the shared
 * `mutateYamlBlock` in config-yaml-block.server.ts — the same walker
 * `disableGoogleSheetsInConfig` in commit.server.ts uses.
 */
export function updateTelarVersionInConfig(
  content: string,
  newVersion: string,
  newReleaseDate: string,
): string {
  return mutateYamlBlock(content, "telar", (line) => {
    if (/^\s+version:/.test(line)) {
      return line.replace(/^(\s+version:\s*).*/, `$1"${newVersion}"`);
    }
    if (/^\s+release_date:/.test(line)) {
      return line.replace(/^(\s+release_date:\s*).*/, `$1"${newReleaseDate}"`);
    }
    return null;
  });
}

/** Prefix identifying GitHub Actions workflow files. Committing these requires
 *  the App's `workflows: write` permission — which GitHub does not auto-grant
 *  to existing installations when newly declared, so a sizeable fraction of
 *  installs lack it (the v1.5.0 accept-gap). The upgrade commit is split so a
 *  rejection here can't zero the rest of the upgrade. */
const WORKFLOW_PATH_PREFIX = ".github/workflows/";

/** True only for files under .github/workflows/ — NOT other .github/ files
 *  (e.g. dependabot.yml), which commit fine with plain contents:write. */
function isWorkflowPath(path: string): boolean {
  return path.startsWith(WORKFLOW_PATH_PREFIX);
}

interface WorkflowPartition {
  /** Additions that commit with plain contents:write (no workflows scope). */
  contentAdditions: CommitFile[];
  /** Additions under .github/workflows/ — need workflows:write. */
  workflowAdditions: CommitFile[];
  /** Deletions outside .github/workflows/. */
  contentDeletions: string[];
  /** Deletions under .github/workflows/ — need workflows:write. */
  workflowDeletions: string[];
  /** True when any addition or deletion touches .github/workflows/. */
  hasWorkflows: boolean;
}

/**
 * Splits an upgrade's file changes into a workflow group (paths under
 * .github/workflows/, which need the App's workflows:write scope) and a content
 * group (everything else, committable with plain contents:write). The upgrade
 * action commits the content group first so a workflow-permission rejection
 * can't zero the whole upgrade; preserves input order within each group.
 */
export function partitionWorkflowFiles(
  additions: CommitFile[],
  deletions: string[],
): WorkflowPartition {
  const contentAdditions: CommitFile[] = [];
  const workflowAdditions: CommitFile[] = [];
  for (const add of additions) {
    (isWorkflowPath(add.path) ? workflowAdditions : contentAdditions).push(add);
  }
  const contentDeletions: string[] = [];
  const workflowDeletions: string[] = [];
  for (const del of deletions) {
    (isWorkflowPath(del) ? workflowDeletions : contentDeletions).push(del);
  }
  return {
    contentAdditions,
    workflowAdditions,
    contentDeletions,
    workflowDeletions,
    hasWorkflows: workflowAdditions.length > 0 || workflowDeletions.length > 0,
  };
}

/**
 * The deletions the site has, by the tree prepare listed at the
 * head the commit is made on. A truncated tree can omit a path the site has,
 * so it cannot show one absent, and every deletion is kept; the commit narrows
 * its deletions to the paths present at that head in any case.
 */
export function deletionsPresentInTree(
  deletions: string[],
  tree: TreeEntry[],
  truncated: boolean,
): string[] {
  if (truncated) return deletions;
  const present = new Set(tree.filter((e) => e.type === "blob").map((e) => e.path));
  return deletions.filter((path) => present.has(path));
}

/**
 * The upgrade's file changes. Additions are the tree diff's, overwritten by
 * every file the manifest chain and the page transforms hold; deletions are
 * the union of both. A path is never carried both ways: deleting is what the
 * manifest says, so every path either side deletes is dropped from the
 * additions, whether or not the site has it (a file the release ships and the
 * manifest deletes is not delivered). Only then are the manifest's deletions
 * narrowed to the paths the site's tree has; the tree diff's are taken from
 * that tree already.
 */
export function mergeUpgradeChanges(
  diff: { additions: CommitFile[]; deletions: string[] },
  manifest: { files: Map<string, string>; deletions: string[] },
  site: { tree: TreeEntry[]; truncated: boolean },
): { additions: CommitFile[]; deletions: string[] } {
  const additions = new Map<string, CommitFile>();
  for (const add of diff.additions) additions.set(add.path, add);
  for (const [path, content] of manifest.files) additions.set(path, { path, content });
  for (const path of [...diff.deletions, ...manifest.deletions]) additions.delete(path);
  const present = deletionsPresentInTree(manifest.deletions, site.tree, site.truncated);
  return {
    additions: Array.from(additions.values()),
    deletions: Array.from(new Set([...diff.deletions, ...present])),
  };
}

/**
 * The upgrade as the review page shows it: the changes the commit makes,
 * from the same merge, with the manifest's deletions as the chain names them
 * and the summary counted over the merged additions and deletions. A path the
 * manifest deletes is not counted as an addition.
 */
export function reviewedUpgradeDiff(
  diff: { additions: CommitFile[]; deletions: string[] },
  manifestDeletions: string[],
  site: { tree: TreeEntry[]; truncated: boolean },
): UpgradeDiff {
  const merged = mergeUpgradeChanges(diff, { files: new Map(), deletions: manifestDeletions }, site);
  return { ...merged, summary: buildUpgradeSummary(merged.additions, merged.deletions) };
}

/** The individually listed framework files the summary counts as data files. */
const DATA_FILE_PATHS: ReadonlySet<string> = new Set([
  "_data/navigation.yml",
  "_data/katex.yml",
  "_data/glossary_kinds.yml",
  "CHANGELOG.md",
  "README.md",
]);

/**
 * Maps a framework file path to a summary category for display grouping.
 */
export function categorizeFrameworkPath(path: string): keyof UpgradeSummary {
  if (path.startsWith("_layouts/")) return "layouts";
  if (path.startsWith("_includes/")) return "includes";
  if (path.startsWith("_sass/") || path.startsWith("assets/")) return "stylesheets";
  if (path.startsWith("scripts/")) return "scripts";
  if (path.startsWith(".github/workflows/")) return "workflows";
  if (
    path.startsWith("_data/languages/") ||
    path.startsWith("_data/themes/") ||
    DATA_FILE_PATHS.has(path)
  ) {
    return "dataFiles";
  }
  return "other";
}

/**
 * Counts additions and deletions by category for the upgrade summary UI.
 * total counts additions only (not deletions — they are counted separately).
 */
export function buildUpgradeSummary(
  additions: CommitFile[],
  deletions: string[],
): UpgradeSummary {
  const summary: UpgradeSummary = {
    layouts: 0,
    includes: 0,
    stylesheets: 0,
    scripts: 0,
    workflows: 0,
    dataFiles: 0,
    other: 0,
    deletions: 0,
    total: 0,
  };

  for (const file of additions) {
    const category = categorizeFrameworkPath(file.path);
    if (category !== "deletions" && category !== "total") {
      (summary as unknown as Record<string, number>)[category]++;
    }
    summary.total++;
  }

  summary.deletions = deletions.length;

  return summary;
}

// ---------------------------------------------------------------------------
// Async functions (GitHub API)
// ---------------------------------------------------------------------------

/**
 * A release lookup GitHub answered with an error status. It carries the
 * status and, for a rate-limit answer (403 or 429), when GitHub says the next
 * request may be made: `Retry-After` in seconds, or `x-ratelimit-reset` as an
 * epoch second when `x-ratelimit-remaining` is 0. Both are null otherwise.
 * The message is the one callers have always logged.
 */
export class ReleaseLookupError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly rateLimitResetEpochSeconds: number | null;

  constructor(res: Response) {
    super(`GitHub API error fetching latest release: ${res.status}`);
    this.name = "ReleaseLookupError";
    this.status = res.status;
    const rateLimited = res.status === 403 || res.status === 429;
    const headers = res.headers;
    this.retryAfterSeconds = rateLimited ? readHeaderNumber(headers, "retry-after") : null;
    const exhausted = headers?.get("x-ratelimit-remaining") === "0";
    this.rateLimitResetEpochSeconds =
      rateLimited && exhausted ? readHeaderNumber(headers, "x-ratelimit-reset") : null;
  }
}

/** A non-negative numeric header, or null when absent or unreadable. */
function readHeaderNumber(headers: Headers | undefined, name: string): number | null {
  const raw = headers?.get(name);
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Fetches the release UCSB-AMPLab/telar is to be upgraded to, via the GitHub
 * Releases API.
 *
 * With no `releaseTag` — the deployment's normal state — the target is
 * `releases/latest`, GitHub's newest published non-prerelease. An empty string
 * counts as no tag, so a deployment can carry the variable unset.
 *
 * A non-empty `releaseTag` targets `releases/tags/<tag>` instead, which is the
 * only lookup that resolves a prerelease. That is the point of the parameter:
 * a deployment pinned to a release candidate rehearses the upgrade against it
 * before the release is published.
 *
 * An error status throws ReleaseLookupError; a network failure throws
 * whatever fetch threw.
 */
export async function fetchLatestRelease(
  token: string,
  releaseTag?: string,
): Promise<TelarRelease> {
  const target = releaseTag
    ? `releases/tags/${encodeURIComponent(releaseTag)}`
    : "releases/latest";
  const res = await fetch(
    `${GITHUB_API}/repos/${FRAMEWORK_OWNER}/${FRAMEWORK_REPO}/${target}`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) throw new ReleaseLookupError(res);
  const release = (await res.json()) as {
    tag_name: string;
    body: string;
    published_at: string;
  };
  return {
    tagName: release.tag_name,
    body: release.body ?? "",
    publishedAt: release.published_at,
  };
}

/**
 * Fetches all releases from UCSB-AMPLab/telar, sorted by version descending.
 * Uses the list releases endpoint (max 100 per page). Excludes GitHub
 * prereleases and drafts — they aren't part of the published upgrade path.
 */
export async function fetchAllReleases(token: string): Promise<TelarRelease[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${FRAMEWORK_OWNER}/${FRAMEWORK_REPO}/releases?per_page=100`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`GitHub API error fetching releases: ${res.status}`);
  }
  const releases = (await res.json()) as Array<{
    tag_name: string;
    body: string;
    published_at: string;
    prerelease: boolean;
    draft: boolean;
  }>;
  const mapped: TelarRelease[] = releases
    .filter((r) => !r.prerelease && !r.draft)
    .map((r) => ({
      tagName: r.tag_name,
      body: r.body ?? "",
      publishedAt: r.published_at,
    }));
  // Sort by version descending (newest first)
  return mapped.sort((a, b) => compareVersions(b.tagName, a.tagName));
}

/**
 * Fetches the full recursive file tree for a specific release tag of the
 * UCSB-AMPLab/telar framework repo.
 *
 * The Git Trees API accepts tag names directly as the tree_sha parameter. A
 * tree that cannot be read, or comes back truncated, throws
 * ReleaseTreeUnreadableError naming the release: a partial tree would read
 * the paths it leaves out as files the release does not ship, and delete
 * them.
 */
async function getFrameworkTreeAtTag(
  token: string,
  tagName: string,
): Promise<TreeEntry[]> {
  let data: { tree: TreeEntry[]; truncated: boolean };
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${FRAMEWORK_OWNER}/${FRAMEWORK_REPO}/git/trees/${encodeURIComponent(tagName)}?recursive=1`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) throw new Error(`GitHub API error fetching framework tree at ${tagName}: ${res.status}`);
    data = (await res.json()) as { tree: TreeEntry[]; truncated: boolean };
  } catch (err) {
    throw new ReleaseTreeUnreadableError(frameworkVersionForTag(tagName), { cause: err });
  }
  if (data.truncated !== false || !Array.isArray(data.tree)) {
    throw new ReleaseTreeUnreadableError(frameworkVersionForTag(tagName));
  }
  return data.tree;
}

/**
 * A file of the framework release the upgrade delivers, as it is committed.
 * The tree listed it, so a 404 is as much a failure as an error status or a
 * network throw: each throws ReleaseFileUnreadableError naming the path and
 * the release, since leaving the file out would commit an upgrade without it.
 */
async function releaseFile(token: string, path: string, tagName: string): Promise<CommitFile> {
  let file: ReleaseFileRead;
  try {
    file = await fetchFrameworkFile(token, path, tagName, { write: true });
  } catch (err) {
    throw new ReleaseFileUnreadableError(path, frameworkVersionForTag(tagName), { cause: err });
  }
  if (file.kind !== "found") throw new ReleaseFileUnreadableError(path, frameworkVersionForTag(tagName));
  return asCommitFile(path, file);
}

/** A found release file as a commit writes it: text, or its bytes in base64. */
function asCommitFile(path: string, file: { content: string; encoding?: "base64" }): CommitFile {
  return file.encoding ? { path, content: file.content, encoding: file.encoding } : { path, content: file.content };
}

/**
 * A framework file at a release tag as the heal writes it, or null for any
 * answer that is not the whole file.
 */
async function getFrameworkFile(token: string, path: string, tagName: string): Promise<CommitFile | null> {
  const file = await fetchFrameworkFile(token, path, tagName, { write: true });
  return file.kind === "found" ? asCommitFile(path, file) : null;
}

/**
 * A framework file at a release tag, telling a file the release does not ship
 * (404) apart from one that could not be read. `getFrameworkFile` answers
 * null for both, which is right for a caller filling gaps and wrong for one
 * that must not mistake an outage for an answer.
 *
 * The read is `getFileAtRef`'s strict one: a file of 1 MB or more is read
 * again as raw bytes, and an answer whose bytes are not the file's `size`
 * fails, as does a network throw. Whether the file is text is decided from
 * its bytes: valid UTF-8 is text, anything else is binary.
 *
 * `write` is for a caller that commits the file, which must be the release's
 * bytes so its blob is the release's: text keeps a leading byte-order mark,
 * and a binary file comes as its bytes in base64 (`encoding: "base64"`).
 * Without it the mark is dropped from text, and a binary file fails, for a
 * caller that parses what it reads.
 */
export async function fetchFrameworkFile(
  token: string,
  path: string,
  tagName: string,
  options?: { write?: boolean },
): Promise<ReleaseFileRead> {
  const read = await getFileBytesAtRef(token, FRAMEWORK_OWNER, FRAMEWORK_REPO, path, tagName);
  if (read.status === "absent") return { kind: "absent" };
  if (read.status === "error") return { kind: "failed" };
  const write = options?.write === true;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
  } catch {
    return write
      ? { kind: "found", content: arrayBufferToBase64(read.bytes.slice().buffer), encoding: "base64" }
      : { kind: "failed" };
  }
  return { kind: "found", content: text.startsWith("\uFEFF") && !write ? text.slice(1) : text };
}

/**
 * Whether an upgrade writes the release's copy of a framework path: where the
 * site has none, or has a different one, except that a DELIVERED_WHEN_ABSENT
 * path the site already has is the site's own. A truncated tree can omit a
 * path the site has, so it cannot show such a path absent.
 */
function upgradeDelivers(
  path: string,
  userSha: string | undefined,
  releaseSha: string,
  userTreeTruncated: boolean,
): boolean {
  const siteOwned = DELIVERED_WHEN_ABSENT.includes(path);
  if (userSha === undefined) return !(siteOwned && userTreeTruncated);
  return userSha !== releaseSha && !siteOwned;
}

/**
 * Whether an upgrade deletes a framework path the release no longer ships,
 * never a DELIVERED_WHEN_ABSENT one.
 */
function upgradeDeletes(path: string, releaseMap: Map<string, string>): boolean {
  return !releaseMap.has(path) && !DELIVERED_WHEN_ABSENT.includes(path);
}

/**
 * The developer-only entries of the release whose tree is `releaseTree`. A
 * release whose tree does not list the file (every release before 1.8.0)
 * has none, and is not asked for it.
 */
async function releaseTreeDevOnlyEntries(
  token: string,
  releaseTree: TreeEntry[],
  releaseTag: string,
): Promise<string[]> {
  if (!releaseTree.some((entry) => entry.path === DEV_ONLY_FILES_PATH)) return [];
  return releaseDevOnlyEntries(
    (path) => fetchFrameworkFile(token, path, releaseTag),
    frameworkVersionForTag(releaseTag),
  );
}

/**
 * Whether the tree diff compares `path`: a framework path that is not one of
 * the release's developer-only paths. The diff neither adds nor deletes a
 * developer-only path; a site's own copy is the manifest's to delete.
 */
function isDiffedFrameworkPath(path: string, devOnly: readonly string[]): boolean {
  return isFrameworkPath(path) && !isDevOnlyPath(path, devOnly);
}

/**
 * Computes the upgrade diff between a user's repo tree and a specific release
 * of the Telar framework.
 *
 * Algorithm:
 *   1. Fetch the framework tree at the release tag.
 *   2. Build SHA maps for both trees, filtered to isFrameworkPath entries
 *      that are not developer-only paths of the release.
 *   3. For each framework path in the release tree:
 *      - If absent from user tree OR SHA differs: fetch content and add to additions,
 *        except a DELIVERED_WHEN_ABSENT path the user tree already has.
 *   4. For each framework path in the user tree:
 *      - If absent from release tree: add to deletions, except a
 *        DELIVERED_WHEN_ABSENT path.
 *   5. Build summary counts.
 *
 * A release tree that cannot be read whole throws ReleaseTreeUnreadableError;
 * a developer-only list or release file that cannot be read throws
 * ReleaseFileUnreadableError. Nothing is left out of the diff.
 */
export async function computeUpgradeDiff(
  token: string,
  userTree: TreeEntry[],
  releaseTag: string,
  options: { fetchContent?: boolean; userTreeTruncated?: boolean } = {},
): Promise<UpgradeDiff> {
  const fetchContent = options.fetchContent ?? true;
  const userTreeTruncated = options.userTreeTruncated ?? false;

  // 1. Fetch framework tree at the release tag
  const releaseTree = await getFrameworkTreeAtTag(token, releaseTag);
  const devOnly = await releaseTreeDevOnlyEntries(token, releaseTree, releaseTag);

  // 2. Build SHA maps filtered to framework paths (blobs only)
  const releaseMap = new Map<string, string>();
  for (const entry of releaseTree) {
    if (entry.type === "blob" && isDiffedFrameworkPath(entry.path, devOnly)) {
      releaseMap.set(entry.path, entry.sha);
    }
  }

  const userMap = new Map<string, string>();
  for (const entry of userTree) {
    if (entry.type === "blob" && isDiffedFrameworkPath(entry.path, devOnly)) {
      userMap.set(entry.path, entry.sha);
    }
  }

  // 3. Compute additions (new files + changed files).
  // When fetchContent=false (the review-page loader path), we only collect
  // paths — this skips N sequential GitHub API calls (one per changed file)
  // that can otherwise dominate page load time. The upgrade action path
  // (fetchContent=true, default) still fetches real content for the commit.
  const additions: CommitFile[] = [];
  for (const [path, releaseSha] of releaseMap.entries()) {
    if (upgradeDelivers(path, userMap.get(path), releaseSha, userTreeTruncated)) {
      if (fetchContent) {
        additions.push(await releaseFile(token, path, releaseTag));
      } else {
        additions.push({ path, content: "" });
      }
    }
  }

  // 4. Compute deletions (framework files in user repo absent from release)
  const deletions: string[] = [];
  for (const path of userMap.keys()) {
    if (upgradeDeletes(path, releaseMap)) {
      deletions.push(path);
    }
  }

  // 5. Build summary
  const summary = buildUpgradeSummary(additions, deletions);

  return { additions, deletions, summary };
}

/**
 * Checks whether the user's site needs an upgrade.
 *
 * Fetches the target release from GitHub and compares against the site's
 * current version. Fails open: if the GitHub API is unreachable, returns
 * needsUpgrade: false rather than blocking the user.
 *
 * `releaseTag` pins the comparison to one release rather than the newest
 * published one; see fetchLatestRelease.
 *
 * Returns:
 *   needsUpgrade    — true if siteVersion is older than the target release
 *   latestTag       — the target release tag, or null if API call failed
 *   isBelowMinimum  — true if siteVersion is older than MIN_SUPPORTED_VERSION
 */
export async function checkTelarVersion(
  token: string,
  siteVersion: string | null,
  releaseTag?: string,
): Promise<{ needsUpgrade: boolean; latestTag: string | null; isBelowMinimum: boolean }> {
  try {
    const latest = await fetchLatestRelease(token, releaseTag);
    const { needsUpgrade, isBelowMinimum } = compareTelarVersion(siteVersion, latest.tagName);
    return { needsUpgrade, latestTag: latest.tagName, isBelowMinimum };
  } catch {
    // Fail open: GitHub API failure should not block the user
    return { needsUpgrade: false, latestTag: null, isBelowMinimum: false };
  }
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/**
 * In-memory cache for release-asset manifests within a single Worker isolate.
 * Keyed by tag name. Release assets are immutable for a given tag, so entries
 * need no TTL during a request chain. Isolate recycling naturally clears.
 */
const manifestCache = new Map<string, Manifest>();

/**
 * Test-only helper to clear the release-asset cache between tests. Not part of
 * the runtime API — tests call this in beforeEach to avoid cross-test bleed.
 */
export function __clearManifestCacheForTests(): void {
  manifestCache.clear();
}

/**
 * Fetch migration.json from a specific framework release. Returns null when
 * the release has no migration.json asset, or when the release tag 404s —
 * callers treat null as "no manifest available" and fail closed. Throws on
 * validation failure and on non-404 GitHub API errors so upgrade actions
 * surface the failure rather than silently proceed.
 */
export async function fetchReleaseManifest(
  token: string,
  tagName: string,
): Promise<Manifest | null> {
  if (manifestCache.has(tagName)) return manifestCache.get(tagName)!;
  const relRes = await fetch(
    `${GITHUB_API}/repos/${FRAMEWORK_OWNER}/${FRAMEWORK_REPO}/releases/tags/${encodeURIComponent(tagName)}`,
    { headers: githubHeaders(token) },
  );
  if (relRes.status === 404) return null;
  if (!relRes.ok) {
    throw new Error(
      `GitHub API error fetching release ${tagName}: ${relRes.status}`,
    );
  }
  const release = (await relRes.json()) as {
    assets?: Array<{ name: string; url: string }>;
  };
  const asset = release.assets?.find((a) => a.name === "migration.json");
  if (!asset) return null;
  const assetRes = await fetch(asset.url, {
    headers: { ...githubHeaders(token), Accept: "application/octet-stream" },
  });
  if (!assetRes.ok) {
    throw new Error(
      `GitHub API error fetching migration asset for ${tagName}: ${assetRes.status}`,
    );
  }
  // A body that is not JSON is a manifest that does not validate, as an
  // invalid shape is; a body cut off in transit throws something else.
  let raw: unknown;
  try {
    raw = await assetRes.json();
  } catch (err) {
    if (err instanceof SyntaxError) throw new ManifestValidationError("migration.json is not JSON", "$");
    throw err;
  }
  // Validator throws ManifestValidationError on invalid shape.
  const validated = validateManifest(raw);
  manifestCache.set(tagName, validated);
  return validated;
}

/**
 * Build the sequential chain of manifests that upgrades a site from
 * `fromVersion` to `toVersion`. Uses EXACT string equality on from_version
 * and to_version — no version normalisation.
 *
 * Returns manifests in application order. Throws if no chain reaches
 * toVersion, or if a loop is detected.
 */
export function chainManifests(
  fromVersion: string,
  toVersion: string,
  available: Manifest[],
): Manifest[] {
  if (fromVersion === toVersion) return [];
  const byFrom = new Map<string, Manifest>();
  for (const m of available) byFrom.set(m.from_version, m);
  const chain: Manifest[] = [];
  let current = fromVersion;
  const visited = new Set<string>();
  while (current !== toVersion) {
    if (visited.has(current)) {
      throw new Error(`Manifest chain loop detected at ${current}`);
    }
    visited.add(current);
    const next = byFrom.get(current);
    if (!next) {
      throw new Error(
        `Unsupported upgrade path: no manifest from ${current} (target ${toVersion}). ` +
          `Available starting versions: ${Array.from(byFrom.keys()).join(", ")}`,
      );
    }
    chain.push(next);
    current = next.to_version;
  }
  return chain;
}

/**
 * Find the migration manifest whose `from_version === deadEnd` by walking
 * candidate release tags between `deadEnd` and `toVersion`.
 *
 * Strategy, in order:
 *   1. Try `v{toVersion}` directly — the common single-hop case.
 *   2. List the framework's releases and filter to semver tags in the half-
 *      open range (deadEnd, toVersion]. Try each ascending; first manifest
 *      whose `from_version` matches the dead-end wins. This covers skip-
 *      version chains (e.g. v1.2.0 → v1.2.1 → v1.3.0 where v1.3.0's manifest
 *      starts at 1.2.1, not 1.2.0).
 *   3. Legacy fallback (`v{deadEnd}`, bare `deadEnd`, bare `toVersion`) for
 *      non-semver tags.
 *
 * Returns null when no candidate yields a matching manifest. Throws
 * ReleaseManifestInvalidError when a candidate's manifest does not validate,
 * ReleaseFileUnreadableError when a candidate's release or manifest cannot be
 * read, and ReleaseListUnreadableError when the listing cannot be read. Each
 * names the candidate's release, not the target's.
 */
async function discoverNextManifest(
  token: string,
  deadEnd: string,
  toVersion: string,
  releaseTag?: string,
): Promise<Manifest | null> {
  // A tag with no release or no manifest (null), or whose manifest starts
  // elsewhere, is passed over. Any other failure, a manifest that does not
  // validate included, stops the search: passing over an unreadable manifest
  // could build the chain from a later one, or report none.
  const tryTag = async (tag: string): Promise<Manifest | null> => {
    let m: Manifest | null;
    try {
      m = await fetchReleaseManifest(token, tag);
    } catch (err) {
      const version = frameworkVersionForTag(tag);
      if (err instanceof ManifestValidationError) throw new ReleaseManifestInvalidError(version, { cause: err });
      throw new ReleaseFileUnreadableError("migration.json", version, { cause: err });
    }
    return m && m.from_version === deadEnd ? m : null;
  };

  // 0. A pinned deployment names the release its manifest must come from.
  // The release listing below drops prereleases, so a pinned release candidate
  // is invisible to every other branch of this search and has to be asked for
  // by name.
  if (releaseTag) {
    const pinned = await tryTag(releaseTag);
    if (pinned) return pinned;
  }

  // 1. Single-hop fast path.
  const direct = await tryTag(`v${toVersion}`);
  if (direct) return direct;

  // 2. Release listing + semver-range walk.
  const dSemver = parseTelarVersion(deadEnd);
  const tSemver = parseTelarVersion(toVersion);
  if (dSemver && tSemver) {
    let releases: TelarRelease[];
    try {
      releases = await fetchAllReleases(token);
    } catch (err) {
      throw new ReleaseListUnreadableError({ cause: err });
    }
    const candidates = releases
      .map((r) => ({ tag: r.tagName, sv: parseTelarVersion(r.tagName) }))
      .filter(
        (r) =>
          r.sv !== null &&
          compareVersions(r.tag, deadEnd) > 0 &&
          compareVersions(r.tag, toVersion) <= 0,
      )
      .sort((a, b) => compareVersions(a.tag, b.tag));

    for (const c of candidates) {
      const m = await tryTag(c.tag);
      if (m) return m;
    }
  }

  // 3. Legacy fallback for non-semver tags or list-API failure.
  for (const tag of [`v${deadEnd}`, deadEnd, toVersion]) {
    const m = await tryTag(tag);
    if (m) return m;
  }

  return null;
}

/**
 * Load + chain manifests from bundled + release-asset sources. Bundled
 * manifests cover historical versions; anything not bundled is discovered
 * via the framework repo's releases.
 *
 * Algorithm:
 *   1. Seed the accumulated set with BUNDLED_MANIFESTS.
 *   2. Try chainManifests. On "no manifest from X" error, call
 *      discoverNextManifest to find the missing link, push it, and retry.
 *   3. Fail closed after 10 attempts or when no candidate yields the
 *      required manifest.
 */
export async function loadManifestChain(
  token: string,
  fromVersion: string,
  toVersion: string,
  releaseTag?: string,
): Promise<Manifest[]> {
  if (fromVersion === toVersion) return [];
  const accumulated: Manifest[] = [...BUNDLED_MANIFESTS];
  let attempts = 0;
  while (attempts < 10) {
    try {
      return chainManifests(fromVersion, toVersion, accumulated);
    } catch (err) {
      const msg = (err as Error).message;
      const match = msg.match(/no manifest from ([^\s]+)/);
      if (!match) throw err;
      const deadEnd = match[1];
      const fetched = await discoverNextManifest(
        token,
        deadEnd,
        toVersion,
        releaseTag,
      );
      if (!fetched) {
        throw new Error(
          `Missing migration manifest for upgrade path ${deadEnd} → (toward ${toVersion}). ` +
            `Ensure the framework releases between ${deadEnd} and ${toVersion} include migration.json assets.`,
        );
      }
      accumulated.push(fetched);
      attempts++;
    }
  }
  throw new Error(
    `loadManifestChain: exceeded 10 attempts building chain ${fromVersion} → ${toVersion}`,
  );
}

/** The project sheets a glob-scoped CSV operation is assumed to name. */
const PROJECT_SHEETS: readonly string[] = [
  "telar-content/spreadsheets/project.csv",
  "telar-content/spreadsheets/proyecto.csv",
];

/**
 * The file a glob names when it has no wildcard, and so can name only
 * itself, provided an operation may write it; otherwise none.
 */
function literalGlobPaths(glob: string): string[] {
  return !/[*?[\]{}]/.test(glob) && isPathInScope(glob) ? [glob] : [];
}

/** The files each operation type reads, from the operation alone. */
const REFERENCED_FILES: {
  readonly [K in Operation["type"]]: (op: Extract<Operation, { type: K }>) => readonly string[];
} = {
  config_add_field: () => ["_config.yml"],
  config_update_value: () => ["_config.yml"],
  config_rename_field: () => ["_config.yml"],
  // The runner deletes a path without reading it, so a path is never fetched
  // only to be deleted; whether the site has it is read from its tree.
  file_delete: () => [],
  gitignore_add: () => [".gitignore"],
  csv_add_column: () => PROJECT_SHEETS,
  csv_rename_column: () => PROJECT_SHEETS,
  // A guarded page-line edit names its page literally: the pages are loaded
  // after the chain runs, so a page it does not load here it never sees.
  regex_replace: (op) => [...PROJECT_SHEETS, ...literalGlobPaths(op.file_glob)],
  yaml_list_add: (op) => [op.file],
  create_directory: () => [],
};

function filesReferencedBy(op: Operation): readonly string[] {
  const referenced = REFERENCED_FILES[op.type] as ((op: Operation) => readonly string[]) | undefined;
  return referenced ? referenced(op) : [];
}

/**
 * Collect the set of repo-relative paths the manifest chain will need to
 * read before applyManifestChain runs. For ops scoped by file_glob, this is
 * heuristic — we cannot fully expand globs statically: a glob with no
 * wildcard names its own file, and the project sheets stand in for the
 * rest. Callers extend with known file sets (e.g. always include _config.yml).
 */
export function collectFilesReferencedByChain(chain: Manifest[]): Set<string> {
  const paths = new Set<string>();
  for (const m of chain) {
    for (const op of m.operations) {
      for (const path of filesReferencedBy(op)) paths.add(path);
    }
  }
  return paths;
}

/**
 * Runs again, over `files`, the chain's `regex_replace` operations whose glob
 * names a built-in page literally. The v1.3.0 ingest runs after the chain and
 * writes the 1.3.0 template's page lines over a 1.2.x site's pages, so a
 * later release's guarded line edit has to follow it; the edits replace an
 * exact line with one that does not match again, so a second run is safe.
 */
export function reapplyBuiltInPageEdits(chain: Manifest[], files: Map<string, string>, lang: Language): void {
  for (const m of chain) {
    for (const op of m.operations) {
      if (op.type !== "regex_replace") continue;
      if (literalGlobPaths(op.file_glob).some((path) => Object.hasOwn(BUILT_IN_PAGES, path))) {
        applyOperation(files, op, lang, []);
      }
    }
  }
}

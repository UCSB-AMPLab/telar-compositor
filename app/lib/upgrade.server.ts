/**
 * This file is the library powering the site-upgrade flow — version
 * comparison, framework tree diffing, line-based config mutation, GitHub
 * Releases lookup, manifest-chain loading, and best-effort publish-time
 * healing of build-critical framework files missing from a user's repo.
 *
 * Design notes:
 *   - Pure functions (parseTelarVersion, compareVersions, compareTelarVersion,
 *     isFrameworkPath, findMissingFrameworkFiles, buildYmlUsesNpmCi,
 *     updateTelarVersionInConfig) are unit-testable without any network calls.
 *   - Async functions (fetchLatestRelease, fetchAllReleases,
 *     getFrameworkTreeAtTag, computeUpgradeDiff, checkTelarVersion,
 *     fetchFrameworkFilesAtVersion, healMissingFrameworkFiles) interact
 *     with the GitHub REST API and are tested with mocked fetch.
 *   - `_config.yml` mutation is line-based (not full YAML parse) to preserve
 *     comments, whitespace, and user-authored content exactly.
 *   - checkTelarVersion fails open: if the GitHub API is unreachable, the
 *     function returns `needsUpgrade: false` rather than blocking the user.
 *   - healMissingFrameworkFiles fails open too: any failure (bad tag, tree
 *     read, content fetch) degrades to an empty result so publish is never
 *     blocked; the missing file retries on the next publish.
 *
 * Framework repo: UCSB-AMPLab/telar (public — user OAuth token is sufficient).
 * Truncation note: the framework repo has no IIIF tiles, so the 100,000-entry
 * git tree limit is not a concern for getFrameworkTreeAtTag. For user repo
 * trees, framework paths are shallow and appear before IIIF tiles
 * alphabetically, so they will be present even in a truncated tree. Revisit
 * if truncation is ever detected in practice.
 *
 * @version v1.3.0-beta
 */

import { githubHeaders, decodeGitHubContent, getRepoTree, getFileContent } from "~/lib/github.server";
import type { TreeEntry } from "~/lib/github.server";
import type { CommitFile } from "~/lib/commit.server";
import { validateManifest, type Manifest } from "~/lib/manifest-schema.server";
import { BUNDLED_MANIFESTS } from "~/../migrations";

const GITHUB_API = "https://api.github.com";
const FRAMEWORK_OWNER = "UCSB-AMPLab";
const FRAMEWORK_REPO = "telar";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum Telar version the compositor supports. Sites older than this must
 *  run the manual upgrade script before connecting. */
export const MIN_SUPPORTED_VERSION = "v0.9.0-beta";

/** Path prefixes that belong to the Telar framework (not user content). */
export const FRAMEWORK_PREFIXES = [
  "_layouts/",
  "_includes/",
  "_sass/",
  "assets/",
  "scripts/",
  ".github/workflows/",
  "_data/languages/",
  "_data/themes/",
] as const;

/** Individual files that belong to the Telar framework.
 *
 * Dependency manifests (package.json, package-lock.json, Gemfile, Gemfile.lock,
 * requirements.txt) must travel with upgrades: the framework's JS/Ruby/Python
 * build steps break when source files (e.g. scroll-engine.js) import libraries
 * that haven't been added to the user's manifest. Before they were listed here,
 * upgrades shipped new framework code without bumping the deps and CI failed with
 * unresolved-module errors.
 *
 * package-lock.json specifically: the framework now builds user sites with
 * `npm install` (no lockfile required), so it is NOT delivered universally. The
 * publish-time heal scopes lockfile delivery to legacy sites whose
 * .github/workflows/build.yml still runs `npm ci` — those break at the build
 * step without a committed lockfile. See healMissingFrameworkFiles /
 * buildYmlUsesNpmCi. It stays listed here so findMissingFrameworkFiles still
 * detects its absence; the heal then decides whether to actually deliver it.
 */
export const FRAMEWORK_FILES = [
  "_data/navigation.yml",
  "CHANGELOG.md",
  // README.md is the only v1.3.0 framework file not covered by FRAMEWORK_PREFIXES.
  "README.md",
  // Dependency manifests — source files assume these deps, CI fails otherwise.
  // package-lock.json is listed for detection only; the heal delivers it just to
  // legacy `npm ci` sites (see the package-lock.json note above).
  "package.json",
  "package-lock.json",
  "Gemfile",
  "Gemfile.lock",
  "requirements.txt",
  // Framework-owned root files users don't customise.
  "LICENSE",
  "NOTICE",
  "pytest.ini",
  "vitest.config.js",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelarVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

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
  /** Version and release_date to patch into _config.yml. */
  configPatch: { version: string; releaseDate: string } | null;
  /** Grouped file counts for the upgrade summary UI. */
  summary: UpgradeSummary;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Parses a Telar version tag string (e.g. "v0.9.0" or "v0.9.0-beta") into
 * a structured version object. Returns null for unparseable strings.
 */
export function parseTelarVersion(tag: string): TelarVersion | null {
  if (!tag) return null;

  // Strip leading "v"
  const stripped = tag.startsWith("v") ? tag.slice(1) : tag;

  // Split on "-" to separate the prerelease suffix
  const dashIdx = stripped.indexOf("-");
  const versionPart = dashIdx >= 0 ? stripped.slice(0, dashIdx) : stripped;
  const prerelease = dashIdx >= 0 ? stripped.slice(dashIdx + 1) : null;

  const parts = versionPart.split(".");
  if (parts.length !== 3) return null;

  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  const patch = parseInt(parts[2], 10);

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) return null;

  return { major, minor, patch, prerelease };
}

/**
 * Compares two Telar version tag strings.
 *
 * Returns:
 *   -1 if a is older than b
 *    0 if equal
 *    1 if a is newer than b
 *
 * Pre-release versions are treated as older than the equivalent release
 * (e.g. "v0.9.0-beta" < "v0.9.0"). Two identical pre-release tags are equal.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseTelarVersion(a);
  const vb = parseTelarVersion(b);

  // Treat unparseable as oldest possible version
  if (!va && !vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;

  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;

  // Same major.minor.patch — compare prerelease
  // null (release) > any prerelease string
  if (va.prerelease === vb.prerelease) return 0;
  if (va.prerelease === null) return 1;  // a is release, b is pre-release
  if (vb.prerelease === null) return -1; // b is release, a is pre-release

  // Both have prerelease — compare lexicographically
  return va.prerelease > vb.prerelease ? 1 : va.prerelease < vb.prerelease ? -1 : 0;
}

/**
 * Returns true if the given path belongs to the Telar framework and should be
 * updated during an upgrade.
 *
 * Note: _config.yml always returns false — it is handled separately via
 * updateTelarVersionInConfig to avoid overwriting user values.
 */
export function isFrameworkPath(path: string): boolean {
  if (path === "_config.yml") return false;
  if ((FRAMEWORK_FILES as readonly string[]).includes(path)) return true;
  return (FRAMEWORK_PREFIXES as readonly string[]).some((prefix) =>
    path.startsWith(prefix),
  );
}

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
        const content = await getFrameworkFileContent(token, path, tagName);
        return content !== null ? { path, content } : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((f): f is CommitFile => f !== null);
}

/**
 * Best-effort publish-time heal: restores framework files that are entirely
 * missing from the user's repo, fetched at the site's pinned version tag.
 *
 * NEVER throws and NEVER blocks publish — any failure (falsy tag, tree read
 * error, content fetch error) degrades to an empty result, and the missing
 * file gets another chance on the next publish. This is deliberately fail-OPEN,
 * unlike the publish snapshot guard, which fails closed: a heal miss only
 * delays a fix, whereas a stale snapshot would ship wrong data.
 *
 * Additive only — returns files to ADD; it does not detect or overwrite files
 * the user already has (that is the upgrade flow's responsibility).
 */
export async function healMissingFrameworkFiles(
  token: string,
  owner: string,
  repo: string,
  tagName: string,
): Promise<CommitFile[]> {
  if (!tagName) return [];
  try {
    const { tree, truncated } = await getRepoTree(token, owner, repo);
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

    // package-lock.json is delivered ONLY to legacy sites whose build.yml still
    // runs `npm ci` — the framework otherwise builds with `npm install` and
    // needs no lockfile. We only pay the extra build.yml read when the lockfile
    // is actually among the missing files; sites missing nothing else pay
    // nothing. Fail-OPEN by dropping the lockfile whenever we can't positively
    // confirm npm ci (build.yml uses npm install, is absent, or fails to read),
    // so we never deliver an unneeded lockfile.
    if (missing.includes("package-lock.json")) {
      let usesNpmCi = false;
      try {
        const buildYml = await getFileContent(
          token,
          owner,
          repo,
          ".github/workflows/build.yml",
        );
        usesNpmCi = buildYml !== null && buildYmlUsesNpmCi(buildYml);
      } catch {
        usesNpmCi = false;
      }
      if (!usesNpmCi) {
        missing = missing.filter((p) => p !== "package-lock.json");
        if (missing.length === 0) return [];
      }
    }

    return await fetchFrameworkFilesAtVersion(token, missing, tagName);
  } catch (err) {
    // warn, not error: this is a best-effort skip (publish still succeeds), so
    // a transient GitHub 5xx here should not trip error-level log alerts.
    console.warn("healMissingFrameworkFiles: skipping heal —", err);
    return [];
  }
}

/**
 * Updates telar.version and telar.release_date inside the telar: block of a
 * _config.yml string using line-based iteration. All other content (user
 * values, comments, whitespace) is preserved verbatim.
 *
 * Pattern: identical to disableGoogleSheetsInConfig in commit.server.ts —
 * tracks inTelarBlock state, enters on /^telar:/, exits on next non-indented
 * non-comment non-empty line.
 */
export function updateTelarVersionInConfig(
  content: string,
  newVersion: string,
  newReleaseDate: string,
): string {
  const lines = content.split("\n");
  let inTelarBlock = false;
  const result: string[] = [];

  for (const line of lines) {
    if (/^telar:/.test(line)) {
      inTelarBlock = true;
      result.push(line);
      continue;
    }

    if (inTelarBlock) {
      // End of telar: block when a non-indented, non-comment, non-empty line appears
      if (/^[^\s#]/.test(line) && line.trim() !== "") {
        inTelarBlock = false;
      } else if (/^\s+version:/.test(line)) {
        result.push(line.replace(/^(\s+version:\s*).*/, `$1"${newVersion}"`));
        continue;
      } else if (/^\s+release_date:/.test(line)) {
        result.push(line.replace(/^(\s+release_date:\s*).*/, `$1"${newReleaseDate}"`));
        continue;
      }
    }

    result.push(line);
  }

  return result.join("\n");
}

/** Prefix identifying GitHub Actions workflow files. Committing these requires
 *  the App's `workflows: write` permission — which GitHub does not auto-grant
 *  to existing installations when newly declared, so a sizeable fraction of
 *  installs lack it (the v1.5.0 accept-gap). The upgrade commit is split so a
 *  rejection here can't zero the rest of the upgrade. */
export const WORKFLOW_PATH_PREFIX = ".github/workflows/";

/** True only for files under .github/workflows/ — NOT other .github/ files
 *  (e.g. dependabot.yml), which commit fine with plain contents:write. */
export function isWorkflowPath(path: string): boolean {
  return path.startsWith(WORKFLOW_PATH_PREFIX);
}

export interface WorkflowPartition {
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
    path === "_data/navigation.yml" ||
    path === "CHANGELOG.md" ||
    path === "README.md"
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
 * Fetches the latest release from UCSB-AMPLab/telar via the GitHub Releases API.
 */
export async function fetchLatestRelease(token: string): Promise<TelarRelease> {
  const res = await fetch(
    `${GITHUB_API}/repos/${FRAMEWORK_OWNER}/${FRAMEWORK_REPO}/releases/latest`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`GitHub API error fetching latest release: ${res.status}`);
  }
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
 * Uses the list releases endpoint (max 100 per page).
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
  }>;
  const mapped: TelarRelease[] = releases.map((r) => ({
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
 * The framework repo has no IIIF tiles, so truncation is not a concern here.
 * The Git Trees API accepts tag names directly as the tree_sha parameter.
 */
async function getFrameworkTreeAtTag(
  token: string,
  tagName: string,
): Promise<TreeEntry[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${FRAMEWORK_OWNER}/${FRAMEWORK_REPO}/git/trees/${tagName}?recursive=1`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub API error fetching framework tree at ${tagName}: ${res.status}`,
    );
  }
  const data = (await res.json()) as { tree: TreeEntry[]; truncated: boolean };
  return data.tree;
}

/**
 * Fetches a file's content from the framework repo at a specific release tag.
 * Returns null if the file is not found (404).
 */
async function getFrameworkFileContent(
  token: string,
  path: string,
  tagName: string,
): Promise<string | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${FRAMEWORK_OWNER}/${FRAMEWORK_REPO}/contents/${path}?ref=${tagName}`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (data.encoding === "base64" && data.content) {
    return decodeGitHubContent(data.content);
  }
  return null;
}

/**
 * Computes the upgrade diff between a user's repo tree and a specific release
 * of the Telar framework.
 *
 * Algorithm:
 *   1. Fetch the framework tree at the release tag.
 *   2. Build SHA maps for both trees, filtered to isFrameworkPath entries.
 *   3. For each framework path in the release tree:
 *      - If absent from user tree OR SHA differs: fetch content and add to additions.
 *   4. For each framework path in the user tree:
 *      - If absent from release tree: add to deletions.
 *   5. Extract version and release date from the tag for configPatch.
 *   6. Build summary counts.
 */
export async function computeUpgradeDiff(
  token: string,
  userTree: TreeEntry[],
  releaseTag: string,
  options: { fetchContent?: boolean } = {},
): Promise<UpgradeDiff> {
  const fetchContent = options.fetchContent ?? true;

  // 1. Fetch framework tree at the release tag
  const releaseTree = await getFrameworkTreeAtTag(token, releaseTag);

  // 2. Build SHA maps filtered to framework paths (blobs only)
  const releaseMap = new Map<string, string>();
  for (const entry of releaseTree) {
    if (entry.type === "blob" && isFrameworkPath(entry.path)) {
      releaseMap.set(entry.path, entry.sha);
    }
  }

  const userMap = new Map<string, string>();
  for (const entry of userTree) {
    if (entry.type === "blob" && isFrameworkPath(entry.path)) {
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
    const userSha = userMap.get(path);
    if (userSha === undefined || userSha !== releaseSha) {
      if (fetchContent) {
        const content = await getFrameworkFileContent(token, path, releaseTag);
        if (content !== null) {
          additions.push({ path, content });
        }
      } else {
        additions.push({ path, content: "" });
      }
    }
  }

  // 4. Compute deletions (framework files in user repo absent from release)
  const deletions: string[] = [];
  for (const path of userMap.keys()) {
    if (!releaseMap.has(path)) {
      deletions.push(path);
    }
  }

  // 5. Extract version and release date from the tag name
  // Tag format: "v0.9.1" — release_date is not available from tree alone,
  // use the tag name for version and today's date as a fallback.
  // The upgrade route action should pass the actual release publishedAt date
  // when building the configPatch.
  const version = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;
  const configPatch = { version, releaseDate: new Date().toISOString().slice(0, 10) };

  // 6. Build summary
  const summary = buildUpgradeSummary(additions, deletions);

  return { additions, deletions, configPatch, summary };
}

/**
 * Pure version-comparison logic extracted from checkTelarVersion.
 *
 * Derives needsUpgrade and isBelowMinimum from a pre-fetched latestTag and the
 * site's current version, with no network calls. Callers that cache the latest
 * tag (e.g. github-status.server.ts) can call this directly.
 *
 * Fails open: if latestTag is null, returns { needsUpgrade: false,
 * isBelowMinimum: false } rather than blocking the user.
 */
export function compareTelarVersion(
  siteVersion: string | null,
  latestTag: string | null,
): { needsUpgrade: boolean; isBelowMinimum: boolean } {
  if (!latestTag) return { needsUpgrade: false, isBelowMinimum: false };

  // Normalise site version: the DB stores version without "v" prefix
  const siteTag = siteVersion
    ? siteVersion.startsWith("v")
      ? siteVersion
      : `v${siteVersion}`
    : null;

  const isBelowMinimum = siteTag
    ? compareVersions(siteTag, MIN_SUPPORTED_VERSION) < 0
    : false;

  const needsUpgrade = siteTag
    ? compareVersions(siteTag, latestTag) < 0
    : false;

  return { needsUpgrade, isBelowMinimum };
}

/**
 * Checks whether the user's site needs an upgrade.
 *
 * Fetches the latest release from GitHub and compares against the site's
 * current version. Fails open: if the GitHub API is unreachable, returns
 * needsUpgrade: false rather than blocking the user.
 *
 * Returns:
 *   needsUpgrade    — true if siteVersion is older than the latest release
 *   latestTag       — the latest release tag, or null if API call failed
 *   isBelowMinimum  — true if siteVersion is older than MIN_SUPPORTED_VERSION
 */
export async function checkTelarVersion(
  token: string,
  siteVersion: string | null,
): Promise<{ needsUpgrade: boolean; latestTag: string | null; isBelowMinimum: boolean }> {
  try {
    const latest = await fetchLatestRelease(token);
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
  const raw = await assetRes.json();
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
 *      non-semver tags or transient list-API failures.
 *
 * Returns null when no candidate yields a matching manifest.
 */
async function discoverNextManifest(
  token: string,
  deadEnd: string,
  toVersion: string,
): Promise<Manifest | null> {
  const tryTag = async (tag: string): Promise<Manifest | null> => {
    try {
      const m = await fetchReleaseManifest(token, tag);
      if (m && m.from_version === deadEnd) return m;
    } catch {
      // Non-404 errors bubble up to the caller eventually; for discovery we
      // treat any fetch failure as "try the next tag".
    }
    return null;
  };

  // 1. Single-hop fast path.
  const direct = await tryTag(`v${toVersion}`);
  if (direct) return direct;

  // 2. Release listing + semver-range walk.
  const dSemver = parseTelarVersion(deadEnd);
  const tSemver = parseTelarVersion(toVersion);
  if (dSemver && tSemver) {
    let releases: TelarRelease[] = [];
    try {
      releases = await fetchAllReleases(token);
    } catch {
      // Listing failed — fall through to legacy fallback below.
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
      const fetched = await discoverNextManifest(token, deadEnd, toVersion);
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

/**
 * Collect the set of repo-relative paths the manifest chain will need to
 * read before applyManifestChain runs. For ops scoped by file_glob, this is
 * heuristic — we cannot fully expand globs statically. Callers extend with
 * known file sets (e.g. always include _config.yml).
 */
export function collectFilesReferencedByChain(chain: Manifest[]): Set<string> {
  const paths = new Set<string>();
  for (const m of chain) {
    for (const op of m.operations) {
      switch (op.type) {
        case "config_add_field":
        case "config_update_value":
        case "config_rename_field":
          paths.add("_config.yml");
          break;
        case "file_delete":
          for (const p of op.paths) paths.add(p);
          break;
        case "gitignore_add":
          paths.add(".gitignore");
          break;
        case "csv_add_column":
        case "csv_rename_column":
        case "regex_replace":
          // Glob-scoped — known CSV paths enumerated here.
          paths.add("telar-content/spreadsheets/project.csv");
          paths.add("telar-content/spreadsheets/proyecto.csv");
          break;
        case "create_directory":
          break;
      }
    }
  }
  return paths;
}

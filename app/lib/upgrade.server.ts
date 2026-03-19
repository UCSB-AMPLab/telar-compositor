/**
 * Upgrade library for the Telar Compositor.
 *
 * Provides version comparison, framework tree diffing, config mutation, and
 * GitHub Releases API access for the site upgrade flow.
 *
 * Design notes:
 *   - Pure functions (parseTelarVersion, compareVersions, isFrameworkPath,
 *     updateTelarVersionInConfig) are unit-testable without any network calls.
 *   - Async functions (fetchLatestRelease, fetchAllReleases,
 *     getFrameworkTreeAtTag, computeUpgradeDiff, checkTelarVersion) interact
 *     with the GitHub REST API and are tested with mocked fetch.
 *   - _config.yml mutation is line-based (not full YAML parse) to preserve
 *     comments, whitespace, and user-authored content exactly.
 *   - checkTelarVersion fails open: if the GitHub API is unreachable, the
 *     function returns needsUpgrade: false rather than blocking the user.
 *
 * Framework repo: UCSB-AMPLab/telar (public — user OAuth token is sufficient)
 * Truncation note: the framework repo has no IIIF tiles, so the 100,000-entry
 * git tree limit is not a concern for getFrameworkTreeAtTag. For user repo
 * trees, framework paths are shallow and appear before IIIF tiles alphabetically,
 * so they will be present even in a truncated tree. Revisit if truncation is
 * ever detected in practice.
 */

import { githubHeaders, decodeGitHubContent } from "~/lib/github.server";
import type { TreeEntry } from "~/lib/github.server";
import type { CommitFile } from "~/lib/commit.server";

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

/** Individual files that belong to the Telar framework. */
export const FRAMEWORK_FILES = ["_data/navigation.yml", "CHANGELOG.md"] as const;

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
    path === "CHANGELOG.md"
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
      (summary as Record<string, number>)[category]++;
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
export async function getFrameworkTreeAtTag(
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
): Promise<UpgradeDiff> {
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

  // 3. Compute additions (new files + changed files)
  const additions: CommitFile[] = [];
  for (const [path, releaseSha] of releaseMap.entries()) {
    const userSha = userMap.get(path);
    if (userSha === undefined || userSha !== releaseSha) {
      // File is new or changed — fetch content from framework repo at release tag
      const content = await getFrameworkFileContent(token, path, releaseTag);
      if (content !== null) {
        additions.push({ path, content });
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
    const latestTag = latest.tagName;

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

    return { needsUpgrade, latestTag, isBelowMinimum };
  } catch {
    // Fail open: GitHub API failure should not block the user
    return { needsUpgrade: false, latestTag: null, isBelowMinimum: false };
  }
}

/**
 * Telar version handling: parsing a release tag, ordering two tags, the
 * framework version a tag carries, and the upgrade-needed / below-minimum
 * decision for a site. Every function is pure: no network, no environment,
 * so none of it needs the GitHub release code in upgrade.server.ts.
 *
 * @version v1.5.0-beta
 */

import { normalizeVersionTag, stripVersionPrefix } from "~/lib/version";

/** Minimum Telar version the compositor supports. Sites older than this must
 *  run the manual upgrade script before connecting. */
export const MIN_SUPPORTED_VERSION = "v0.9.0-beta";

interface TelarVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

/**
 * Parses a Telar version tag string (e.g. "v0.9.0" or "v0.9.0-beta") into
 * a structured version object. Returns null for unparseable strings.
 */
export function parseTelarVersion(tag: string): TelarVersion | null {
  if (!tag) return null;

  // Strip leading "v"
  const stripped = stripVersionPrefix(tag);

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

/** The framework version a release tag carries.
 *
 * A release-candidate tag such as `v1.7.0-rc.1` publishes the tree of the
 * release it rehearses, so the version its content declares is that release's:
 * the `migration.json` it ships names `1.7.0` as its destination, and a site it
 * upgrades must stamp `1.7.0`. Taking the version from the tag verbatim instead
 * leaves the manifest chain hunting for a step from 1.7.0 to 1.7.0-rc.1, which
 * no release publishes, and writes an rc number into a user's `_config.yml`.
 *
 * Only a pinned deployment can select such a tag: `releases/latest` excludes
 * prereleases, so for every tag reachable in production this returns the tag
 * without its `v`. A suffix that is part of the version proper, as in
 * `v0.9.0-beta`, is not an rc suffix and stays.
 */
export function frameworkVersionForTag(tagName: string): string {
  return tagName.replace(/^v/, "").replace(/-rc\.\d+$/, "");
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
 * The version decision behind checkTelarVersion (upgrade.server.ts).
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
  const siteTag = siteVersion ? normalizeVersionTag(siteVersion) : null;

  const isBelowMinimum = siteTag
    ? compareVersions(siteTag, MIN_SUPPORTED_VERSION) < 0
    : false;

  const needsUpgrade = siteTag
    ? compareVersions(siteTag, latestTag) < 0
    : false;

  return { needsUpgrade, isBelowMinimum };
}

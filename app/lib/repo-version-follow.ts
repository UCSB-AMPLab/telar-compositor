/**
 * Which version the Compositor records for a site whose repository names a
 * different one.
 *
 * The repository's `_config.yml` decides which Telar version a site's files
 * are on; D1's `project_config.telar_version` follows it in both directions.
 * A site upgraded on GitHub is ahead of D1, and one reverted on GitHub is
 * behind it. Either way the upgrade loader and the full sync's apply record
 * the repository's version, so the Upgrade page offers what the files need.
 *
 * A repository version that does not parse as a Telar version is never
 * followed down: it would replace a readable version with text no comparison
 * can use. An empty D1 value takes whatever the repository names.
 *
 * @version v1.5.3-beta
 */

import { compareVersions, parseTelarVersion } from "~/lib/telar-version";
import { normalizeVersionTag } from "~/lib/version";

/** The repository's version when D1 should be set to it, or null when D1 already holds it. */
export function repoVersionToFollow(
  repoVersion: string | null | undefined,
  d1Version: string | null | undefined,
): string | null {
  if (!repoVersion) return null;
  if (!d1Version) return repoVersion;
  if (!parseTelarVersion(repoVersion)) return null;
  return compareVersions(normalizeVersionTag(repoVersion), normalizeVersionTag(d1Version)) === 0
    ? null
    : repoVersion;
}

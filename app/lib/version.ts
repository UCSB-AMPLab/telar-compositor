/**
 * Telar version-tag normalization.
 *
 * The D1 `project_config.telar_version` column stores versions WITHOUT the
 * "v" prefix (e.g. "1.4.0"), while GitHub release tags and `_config.yml`'s
 * `version:` key are compared and displayed WITH it (e.g. "v1.4.0"). Call
 * sites that read one representation and need the other reimplemented the
 * same ternary independently; this module is the single source for both
 * directions.
 *
 * @version v1.4.0-beta
 */

/** Adds a leading "v" if the tag doesn't already have one. Idempotent. */
export function normalizeVersionTag(tag: string): string {
  return tag.startsWith("v") ? tag : `v${tag}`;
}

/** Strips a leading "v" if present. Idempotent. */
export function stripVersionPrefix(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

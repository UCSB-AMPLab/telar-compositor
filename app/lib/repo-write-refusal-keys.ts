/**
 * The `objects` message for each version refusal of a repository write
 * (`readRepoWriteRefusal`), by the code an action answers. A Map, because the
 * code is a string from a response body.
 *
 * @version v1.5.0-beta
 */

export const REPO_WRITE_REFUSAL_KEYS: ReadonlyMap<string, string> = new Map([
  ["upgrade_required", "repo_write_upgrade_required"],
  ["upgrade_awaits_convenor", "repo_write_upgrade_awaits_convenor"],
  ["release_unknown", "repo_write_release_unknown"],
]);

/**
 * Which rows of a story sheet the import keeps as steps, shared by the import
 * and by the upgrade's answer list so the two count steps alike. Kept apart
 * from `import.server.ts` so a module can read the rule without loading the
 * importer.
 *
 * @version v1.5.0-beta
 */

import { pythonStrip } from "~/lib/column-mapping";
import { hasStoryRowContent } from "~/lib/extra-columns";

/** The story columns whose content makes a row a step. */
const STEP_CONTENT_FIELDS = ["object", "question", "answer", "layer1_button", "layer1_content", "layer2_button", "layer2_content", "alt_text"];

/**
 * Whether the import keeps a story row as a step: a step-content column holds
 * something, or a kept column outside the known keys does (`extras`, from
 * `collectExtraColumns`; see `hasStoryRowContent`).
 */
export function isStoryStepRow(row: Readonly<Record<string, string | undefined>>, extras: Record<string, unknown>): boolean {
  return STEP_CONTENT_FIELDS.some((f) => pythonStrip(row[f] ?? "") !== "") || hasStoryRowContent(extras);
}

/**
 * A story sheet's columns the steps and layers mappers consume. Every other
 * column's non-empty cells are kept per step in `extra_columns` and written
 * back after these at publish. Rows reach the mapper under
 * STORY_CANONICAL_SCOPE, so a Spanish or aliased header of one of these
 * arrives already renamed onto it and is consumed with it.
 */
export const KNOWN_STORY_KEYS: ReadonlySet<string> = new Set([
  "step", "object", "x", "y", "zoom", "page", "question", "answer", "alt_text",
  "layer1_button", "layer1_content", "layer2_button", "layer2_content",
  "clip_start", "clip_end", "loop",
]);

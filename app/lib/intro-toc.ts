/**
 * The titles the published story intro lists under "Sections".
 *
 * The framework's story layout lists every step of the story JSON whose
 * `object` is exactly the empty string and that has a `question` key
 * (`_layouts/story.html`, `obj == "" and s.question`). Publish writes a row
 * for every step but a fully empty one (`isFullyEmptyStep`), with the
 * question column always present, and writes the `object` cell as "" for a
 * section step and as the stored object id, cleaned (`cleanText`), otherwise.
 * The build then fills a blank cell with "" and leaves the cell as the
 * reference pass leaves it (`stepObjectCellResolver`), so a cell of spaces
 * is not empty. Liquid holds an empty string true, so a listed step with no
 * question is an empty entry. A media step with no object is listed as a
 * section card is.
 *
 * @version v1.5.0-beta
 */

import { stepObjectCellResolver } from "~/lib/object-id";
import { isFullyEmptyStep, type StepContent } from "~/lib/story-rows";
import { cleanText } from "~/lib/unsafe-text";

export function introSectionTitles(
  steps: readonly StepContent[],
  objects: ReadonlyArray<{ object_id: string }> = [],
  frameworkVersion: string | null = null,
): string[] {
  // Publish cleans objects.csv as it cleans the story, so a cell is matched
  // against the cleaned ids, as `sceneRun` matches it.
  const cellFor = stepObjectCellResolver(
    objects.map((object) => ({ object_id: cleanText(object.object_id) })),
    frameworkVersion,
  );
  const objectless = (step: StepContent) => cellFor(step.kind === "section" ? "" : cleanText(step.object_id ?? "")) === "";
  return steps
    .filter((step) => !isFullyEmptyStep(step) && objectless(step))
    .map((step) => cleanText(step.question ?? ""));
}

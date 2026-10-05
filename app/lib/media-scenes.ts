/**
 * media-scenes — the steps the published page arranges together.
 *
 * A scene is a run of consecutive steps showing the same object, as the
 * framework groups them (`_buildSceneMaps` and `computeZIndexPlan`,
 * card-pool.js). A video or audio scene's cards go below its player or stay
 * beside it together, decided by the scene's tallest card (`mediaCardBelow`
 * in framing-stage.ts), so the editor needs every step of the scene, not only
 * the one it shows.
 *
 * The framework keys each step by its `object` in the story JSON, compared
 * exactly. That value is the cell publish writes (empty for a section step,
 * else the stored object id, cleaned as the committed file is by `cleanText`)
 * as the reference pass leaves it (`stepObjectCellResolver`): the pass writes
 * back the stripped value or the matched id only when an extension came off
 * or the match was case-insensitive, and never writes back a trimmed value on
 * its own, so `map`, `map.jpg` and `MAP` are one scene and ` map` beside
 * `map` is two. The Nth empty cell of the story is keyed `__title_N__`, which
 * is a scene of its own unless a neighbouring step names an object with that
 * id.
 *
 * Only the steps publish writes are on the site: a fully empty step
 * (`isFullyEmptyStep`) neither separates two scenes nor takes a title number.
 *
 * @version v1.5.0-beta
 */

import { stepObjectCellResolver } from "~/lib/object-id";
import { isFullyEmptyStep, type StepContent } from "~/lib/story-rows";
import { cleanText } from "~/lib/unsafe-text";

/**
 * The run of steps in `steps` sharing `steps[index]`'s scene key, in order,
 * for a site whose objects are `objects` (in objects.csv order); empty for an
 * index outside. A section step's cell is empty whatever it stores. The run
 * holds only steps publish writes; a step it leaves out is a run of its own.
 */
export function sceneRun<T extends StepContent>(
  steps: readonly T[],
  index: number,
  objects: ReadonlyArray<{ object_id: string }> = [],
  frameworkVersion: string | null = null,
): T[] {
  const step = steps[index];
  if (!step) return [];
  if (isFullyEmptyStep(step)) return [step];
  const written = steps.filter((s) => !isFullyEmptyStep(s));
  // Publish cleans objects.csv as it cleans the story (`cleanCommitContent`),
  // so a cell is matched against the cleaned ids.
  const cellFor = stepObjectCellResolver(
    objects.map((object) => ({ object_id: cleanText(object.object_id) })),
    frameworkVersion,
  );
  let titleCounter = 0;
  const keys = written.map((s) => {
    const cell = cellFor(s.kind === "section" ? "" : cleanText(s.object_id ?? ""));
    return cell === "" ? `__title_${titleCounter++}__` : cell;
  });
  const at = written.indexOf(step);
  const key = keys[at];
  let first = at;
  while (first > 0 && keys[first - 1] === key) first -= 1;
  let last = at;
  while (last < written.length - 1 && keys[last + 1] === key) last += 1;
  return written.slice(first, last + 1);
}

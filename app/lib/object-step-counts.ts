/**
 * How many steps show each object, from the step values a project's stories
 * hold: the loader reads them from D1, the page reads them from the shared
 * document, and both resolve them to objects here, so the two cannot come to
 * differ over which object a step value names.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { stepObjectResolver } from "~/lib/object-id";

/**
 * `object_id -> steps` for the objects `projectObjects` (in objects.csv order)
 * holds, keyed by the id of the object each step shows. A step bound to no
 * object, or naming none the site has, is skipped; an object no step shows is
 * absent.
 */
export function tallyStepObjects(
  stepValues: ReadonlyArray<{ value: string | null; count: number }>,
  projectObjects: ReadonlyArray<{ object_id: string }>,
  frameworkVersion: string | null,
): Record<string, number> {
  const showsFor = stepObjectResolver(projectObjects, frameworkVersion);
  // A Map, since an object id may name an Object.prototype property
  // (`constructor`), which a plain object would read as its inherited value.
  const counts = new Map<string, number>();
  for (const { value, count } of stepValues) {
    const shown = showsFor(value);
    if (shown) counts.set(shown.object_id, (counts.get(shown.object_id) ?? 0) + count);
  }
  return Object.fromEntries(counts);
}

/** The `object_id` of every step in one story of the shared document, one entry per step. */
export function storyStepObjects(story: Y.Map<unknown>): { value: string | null; count: number }[] {
  const steps = story.get("steps");
  if (!(steps instanceof Y.Array)) return [];
  return steps
    .toArray()
    .filter((step): step is Y.Map<unknown> => step instanceof Y.Map)
    .map((step) => {
      const value = step.get("object_id");
      return { value: typeof value === "string" ? value : null, count: 1 };
    });
}

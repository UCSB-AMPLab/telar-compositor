/**
 * The objects list's usage counts as the shared document holds them, so a step
 * given an object, or taken off one, changes its count without a reload.
 * `loaderCounts` stand while there is no document.
 *
 * @version v1.5.0-beta
 */

import { useMemo } from "react";
import type * as Y from "yjs";
import { useYjsArraySync } from "~/hooks/use-yjs-array-sync";
import { storyStepObjects, tallyStepObjects } from "~/lib/object-step-counts";

const objectIdOf = (object: Y.Map<unknown>) => ({ object_id: String(object.get("object_id") ?? "") });

export function useDocumentStepCounts(
  ydoc: Y.Doc | null,
  frameworkVersion: string | null,
  loaderCounts: Record<string, number>,
): Record<string, number> {
  const perStory = useYjsArraySync(ydoc ? ydoc.getArray<Y.Map<unknown>>("stories") : null, storyStepObjects);
  const projectObjects = useYjsArraySync(ydoc ? ydoc.getArray<Y.Map<unknown>>("objects") : null, objectIdOf);
  return useMemo(
    () =>
      perStory && projectObjects
        ? tallyStepObjects(perStory.flat(), projectObjects, frameworkVersion)
        : loaderCounts,
    [perStory, projectObjects, frameworkVersion, loaderCounts],
  );
}

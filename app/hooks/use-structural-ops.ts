/**
 * This file is the hook that exposes client-side Y.Array mutation
 * operations for every collaborative entity (stories, steps,
 * layers, pages, IIIF objects, glossary terms).
 *
 * Replaces D1 route actions with direct Yjs mutations so
 * structural changes propagate to all connected collaborators in
 * real time. The Durable Object's `snapshotToD1` cycle reconciles
 * Y.Array state back to D1 entity tables.
 *
 * Every newly-created Y.Map carries three sentinel fields:
 *   - `_id: null`             (will be backfilled by snapshotToD1)
 *   - `_temp_id: <UUID>`      (stable UI key until `_id` is
 *     assigned)
 *   - `created_by: <userId>`  (permission tracking)
 *
 * Permission model: `canDelete` allows the convenor to delete
 * anything; collaborators can delete only items they created
 * themselves.
 *
 * @version v1.4.1-beta
 */

import { useMemo } from "react";
import * as Y from "yjs";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { findYMapIndex } from "~/lib/yjs-helpers";
import { normaliseSlug, makeUniqueSlug, slugifyTermId } from "~/lib/slug";
import { makeUniqueTermId } from "~/lib/glossary-slug";
import { makeObjectYMap } from "~/lib/object-ymap";

export type StructuralRole = "convenor" | "collaborator";

export interface StructuralOps {
  // Permission check.
  canDelete: (yMap: Y.Map<unknown>) => boolean;

  // Stories.
  addStory: (
    title: string,
    storyId: string,
    subtitle?: string,
    byline?: string
  ) => void;
  deleteStory: (id: number | null, tempId: string | null) => void;
  reorderStories: (oldIndex: number, newIndex: number) => void;

  // Steps.
  addStep: (storyYMap: Y.Map<unknown>) => void;
  addSectionCard: (storyYMap: Y.Map<unknown>) => void;
  deleteStep: (
    storyYMap: Y.Map<unknown>,
    stepId: number | null,
    tempId: string | null
  ) => void;
  reorderSteps: (
    storyYMap: Y.Map<unknown>,
    oldIndex: number,
    newIndex: number
  ) => void;

  // Layers.
  addLayer: (
    stepYMap: Y.Map<unknown>,
    layerNumber: number,
    buttonLabel: string
  ) => void;
  deleteLayer: (
    stepYMap: Y.Map<unknown>,
    layerId: number | null,
    tempId: string | null
  ) => void;

  // Pages.
  addPage: () => void;
  deletePage: (id: number | null, tempId: string | null) => void;
  reorderPages: (oldIndex: number, newIndex: number) => void;

  // Objects (IIIF only; self-hosted uploads stay as a route action).
  addIiifObject: (objectId: string, title: string, sourceUrl: string) => string;
  /**
   * Create an external-media object (YouTube/Vimeo/Drive/audio). Mirrors
   * `addIiifObject` but the Y.Map is born NON-pending (`_validation_state:
   * "valid"`) because external media has no IIIF manifest to validate — a
   * `"pending"` state would make the Durable Object skip the row on D1 INSERT
   * (`collaboration.ts:1506`) and the object would never persist. `origin` is
   * `"compositor"` (NOT `"external"`) — the exact sentinel the sync
   * missing-from-repo guard skips (`sync.server.ts:295,500`). External media
   * has no poster subsystem: `thumbnail` stays empty and
   * `image_available` stays false.
   */
  addExternalMediaObject: (objectId: string, title: string, sourceUrl: string) => string;
  deleteObject: (id: number | null, tempId: string | null) => void;

  // Glossary.
  addGlossaryTerm: (title: string) => void;
  /**
   * Quick-create a glossary term with a caller-supplied `term_id`.
   * The candidate term_id is normalised + deduped via `makeUniqueTermId`
   * against the existing set so the new slug stays unique. Definition starts
   * empty. Used by the unresolved-chip CTA so authoring an `[[foo]]` link that
   * has no term yet resolves it in one transaction without leaving the route.
   */
  addGlossaryTermWithId: (termId: string, title: string) => void;
  deleteGlossaryTerm: (id: number | null, tempId: string | null) => void;
}

/**
 * cloneYMap — deep-clone a Y.Map, preserving Y.Text content and nested
 * Y.Array/Y.Map structures. Returns a fresh Y.Map that can be inserted
 * into a Y.Array without tombstone issues.
 */
function cloneYMap(source: Y.Map<unknown>): Y.Map<unknown> {
  const clone = new Y.Map<unknown>();
  for (const [key, value] of source.entries()) {
    if (value instanceof Y.Text) {
      clone.set(key, new Y.Text(value.toString()));
    } else if (value instanceof Y.Array) {
      // Deep-clone nested arrays (e.g. steps, layers)
      const clonedArray = new Y.Array<unknown>();
      for (let i = 0; i < value.length; i++) {
        const child = value.get(i);
        if (child instanceof Y.Map) {
          clonedArray.push([cloneYMap(child)]);
        } else {
          clonedArray.push([child]);
        }
      }
      clone.set(key, clonedArray);
    } else if (value instanceof Y.Map) {
      clone.set(key, cloneYMap(value));
    } else {
      clone.set(key, value);
    }
  }
  return clone;
}

/**
 * reorderInPlace — shared helper for Y.Array reorder operations.
 *
 * Clones the Y.Map at oldIndex into a fresh Y.Map, deletes the original,
 * and inserts the clone at newIndex. This avoids the Yjs tombstone bug
 * where re-inserting a deleted Y.Map corrupts its nested Y.Text children.
 * The trade-off is that collaborative cursors on text fields inside the
 * moved item will reset — acceptable for a reorder operation.
 *
 * Must be called inside a ydoc.transact() block.
 */
export function reorderInPlace(
  yArray: Y.Array<Y.Map<unknown>>,
  oldIndex: number,
  newIndex: number
): void {
  if (oldIndex === newIndex) return;
  if (oldIndex < 0 || oldIndex >= yArray.length) return;
  if (newIndex < 0 || newIndex > yArray.length - 1) return;
  const clone = cloneYMap(yArray.get(oldIndex));
  yArray.delete(oldIndex, 1);
  yArray.insert(newIndex, [clone]);
}

/**
 * deleteFromArray — shared body for every structural delete operation
 * (stories, steps, layers, pages, objects, glossary terms).
 *
 * Resolves the target index via `findYMapIndex` and deletes it if found.
 * `array` is `unknown` rather than `Y.Array<Y.Map<unknown>>` because callers
 * pass both root arrays (`ydoc.getArray(...)`, always a real `Y.Array`) and
 * nested arrays read off a parent `Y.Map` via `.get(...)` (typed as
 * `unknown` until runtime-checked) — the `instanceof` guard is a no-op for
 * the former and the load-bearing check for the latter, so one helper
 * covers both without weakening either call site's existing guard.
 *
 * Must be called inside a ydoc.transact() block.
 */
function deleteFromArray(
  array: unknown,
  id: number | null,
  tempId: string | null
): void {
  if (!(array instanceof Y.Array)) return;
  const idx = findYMapIndex(array as Y.Array<Y.Map<unknown>>, id, tempId);
  if (idx >= 0) array.delete(idx, 1);
}

/**
 * buildStepYMap — shared field-by-field construction for the two step
 * kinds (`addStep` / `addSectionCard`). The two kinds differ only in the
 * `kind` sentinel and in two field comments below; every other field is
 * identical, including the always-empty `layers` array for section cards
 * (kept for Y.Map shape consistency across both kinds) and the always-empty
 * `object_id` (empty signals "section card, no media" to the framework on
 * publish for both kinds — media steps fill it in later via the object
 * picker).
 */
function buildStepYMap(
  currentUserId: number,
  stepNumber: number,
  kind: "media" | "section"
): Y.Map<unknown> {
  const stepMap = new Y.Map<unknown>();
  stepMap.set("_id", null);
  stepMap.set("_temp_id", crypto.randomUUID());
  stepMap.set("created_by", currentUserId);
  stepMap.set("step_number", stepNumber);
  stepMap.set("kind", kind);
  stepMap.set("object_id", "");
  stepMap.set("x", null);
  stepMap.set("y", null);
  stepMap.set("zoom", null);
  stepMap.set("page", "");
  // The heading text for section cards lives in this same `question` field —
  // Y.Text so collaborative edits work for both kinds.
  stepMap.set("question", new Y.Text(""));
  stepMap.set("answer", new Y.Text(""));
  stepMap.set("alt_text", new Y.Text(""));
  stepMap.set("clip_start", "");
  stepMap.set("clip_end", "");
  stepMap.set("loop", "");
  stepMap.set("layers", new Y.Array<Y.Map<unknown>>());
  return stepMap;
}

export const __test__ = { reorderInPlace, buildStepYMap };

/**
 * useStructuralOps — returns the mutation API for structural Y.Array
 * operations, or null if the Y.Doc is not yet available (SSR or
 * pre-connection). Consumers must null-check before calling.
 *
 * @param currentUserId The signed-in user's D1 `users.id`.
 * @param role          The user's project role — "convenor" or "collaborator".
 */
export function useStructuralOps(
  currentUserId: number,
  role: StructuralRole
): StructuralOps | null {
  const { ydoc } = useCollaborationContext();

  return useMemo<StructuralOps | null>(() => {
    if (!ydoc) return null;

    const canDelete = (yMap: Y.Map<unknown>): boolean => {
      if (role === "convenor") return true;
      return yMap.get("created_by") === currentUserId;
    };

    // ---- Stories ----

    const addStory: StructuralOps["addStory"] = (
      title,
      storyId,
      subtitle,
      byline
    ) => {
      ydoc.transact(() => {
        const storiesArray = ydoc.getArray<Y.Map<unknown>>("stories");
        const storyMap = new Y.Map<unknown>();
        storyMap.set("_id", null);
        storyMap.set("_temp_id", crypto.randomUUID());
        storyMap.set("created_by", currentUserId);
        storyMap.set("story_id", storyId);
        storyMap.set("title", new Y.Text(title));
        // Seed subtitle/byline from the creation form. Both are collaborative
        // Y.Text so they stay editable inline on the story editor afterwards;
        // an omitted value starts empty.
        storyMap.set("subtitle", new Y.Text(subtitle ?? ""));
        storyMap.set("byline", new Y.Text(byline ?? ""));
        storyMap.set("order", storiesArray.length);
        storyMap.set("private", false);
        storyMap.set("draft", false);
        storyMap.set("steps", new Y.Array<Y.Map<unknown>>());
        storiesArray.push([storyMap]);
      });
    };

    const deleteStory: StructuralOps["deleteStory"] = (id, tempId) => {
      ydoc.transact(() => {
        deleteFromArray(ydoc.getArray<Y.Map<unknown>>("stories"), id, tempId);
      });
    };

    const reorderStories: StructuralOps["reorderStories"] = (
      oldIndex,
      newIndex
    ) => {
      ydoc.transact(() => {
        const storiesArray = ydoc.getArray<Y.Map<unknown>>("stories");
        reorderInPlace(storiesArray, oldIndex, newIndex);
      });
    };

    // ---- Steps ----

    const addStep: StructuralOps["addStep"] = (storyYMap) => {
      ydoc.transact(() => {
        const stepsArray = storyYMap.get("steps") as Y.Array<Y.Map<unknown>>;
        if (!(stepsArray instanceof Y.Array)) return;
        stepsArray.push([
          buildStepYMap(currentUserId, stepsArray.length + 1, "media"),
        ]);
      });
    };

    const addSectionCard: StructuralOps["addSectionCard"] = (storyYMap) => {
      ydoc.transact(() => {
        const stepsArray = storyYMap.get("steps") as Y.Array<Y.Map<unknown>>;
        if (!(stepsArray instanceof Y.Array)) return;
        stepsArray.push([
          buildStepYMap(currentUserId, stepsArray.length + 1, "section"),
        ]);
      });
    };

    const deleteStep: StructuralOps["deleteStep"] = (storyYMap, stepId, tempId) => {
      ydoc.transact(() => {
        deleteFromArray(storyYMap.get("steps"), stepId, tempId);
      });
    };

    const reorderSteps: StructuralOps["reorderSteps"] = (
      storyYMap,
      oldIndex,
      newIndex
    ) => {
      ydoc.transact(() => {
        const stepsArray = storyYMap.get("steps") as Y.Array<Y.Map<unknown>>;
        if (!(stepsArray instanceof Y.Array)) return;
        reorderInPlace(stepsArray, oldIndex, newIndex);
      });
    };

    // ---- Layers ----

    const addLayer: StructuralOps["addLayer"] = (
      stepYMap,
      layerNumber,
      buttonLabel
    ) => {
      ydoc.transact(() => {
        const layersArray = stepYMap.get("layers") as Y.Array<Y.Map<unknown>>;
        if (!(layersArray instanceof Y.Array)) return;
        const layerMap = new Y.Map<unknown>();
        layerMap.set("_id", null);
        layerMap.set("_temp_id", crypto.randomUUID());
        layerMap.set("created_by", currentUserId);
        layerMap.set("layer_number", layerNumber);
        layerMap.set("title", new Y.Text(buttonLabel));
        layerMap.set("button_label", new Y.Text(buttonLabel));
        layerMap.set("content", new Y.Text(""));
        layersArray.push([layerMap]);
      });
    };

    const deleteLayer: StructuralOps["deleteLayer"] = (stepYMap, layerId, tempId) => {
      ydoc.transact(() => {
        deleteFromArray(stepYMap.get("layers"), layerId, tempId);
      });
    };

    // ---- Pages ----

    const addPage: StructuralOps["addPage"] = () => {
      ydoc.transact(() => {
        const pagesArray = ydoc.getArray<Y.Map<unknown>>("pages");
        // Temporary unique slug avoids UNIQUE(project_id, slug) violation when
        // multiple pages are created before either gets a title. Replaced by
        // title-derived slug once the user edits the title (deferred generation).
        const existingSlugs = new Set<string>();
        for (let i = 0; i < pagesArray.length; i++) {
          const s = pagesArray.get(i).get("slug") as string;
          if (s) existingSlugs.add(s);
        }
        const { slug: tempSlug } = makeUniqueSlug("untitled", existingSlugs);
        const pageMap = new Y.Map<unknown>();
        pageMap.set("_id", null);
        pageMap.set("_temp_id", crypto.randomUUID());
        pageMap.set("created_by", currentUserId);
        pageMap.set("title", new Y.Text(""));
        pageMap.set("slug", tempSlug);
        pageMap.set("body", new Y.Text(""));
        pageMap.set("order", pagesArray.length);
        pagesArray.push([pageMap]);
      });
    };

    const deletePage: StructuralOps["deletePage"] = (id, tempId) => {
      ydoc.transact(() => {
        deleteFromArray(ydoc.getArray<Y.Map<unknown>>("pages"), id, tempId);
      });
    };

    const reorderPages: StructuralOps["reorderPages"] = (oldIndex, newIndex) => {
      ydoc.transact(() => {
        const pagesArray = ydoc.getArray<Y.Map<unknown>>("pages");
        reorderInPlace(pagesArray, oldIndex, newIndex);
      });
    };

    // ---- Objects (IIIF only) ----

    const addIiifObject: StructuralOps["addIiifObject"] = (
      objectId,
      title,
      sourceUrl
    ) => {
      const tempId = crypto.randomUUID();
      ydoc.transact(() => {
        const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
        // Dedupe object_id against the live set. There is no UNIQUE
        // constraint on objects.object_id, so two un-deduped adds would
        // both persist, collapse in objects.csv, and make step→object
        // lookups ambiguous on the published site. Mirrors addGlossaryTerm.
        const existing = new Set<string>();
        for (let i = 0; i < objectsArray.length; i++) {
          const oid = objectsArray.get(i).get("object_id");
          if (typeof oid === "string") existing.add(oid);
        }
        const { slug: uniqueObjectId } = makeUniqueSlug(objectId, existing);
        // Factory sets EVERY snapshot-bound key (object_type/subjects/source/
        // credit/dimensions/extra_columns included) — an absent key would be
        // erased in D1 by the next snapshot and unbindable in the editors.
        const objMap = makeObjectYMap({
          tempId,
          createdBy: currentUserId,
          objectId: uniqueObjectId,
          title,
          sourceUrl,
          validationState: "pending",
          origin: "iiif",
        });
        objectsArray.push([objMap]);
      });
      // Return the stable handle so the caller can locate this exact object
      // (by _temp_id) without a race-prone array.get(length - 1) read.
      return tempId;
    };

    const addExternalMediaObject: StructuralOps["addExternalMediaObject"] = (
      objectId,
      title,
      sourceUrl
    ) => {
      const tempId = crypto.randomUUID();
      ydoc.transact(() => {
        const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
        // Dedupe object_id against the live set (no UNIQUE constraint on
        // objects.object_id; two un-deduped adds would collide). Mirrors
        // addGlossaryTerm and the IIIF path.
        const existing = new Set<string>();
        for (let i = 0; i < objectsArray.length; i++) {
          const oid = objectsArray.get(i).get("object_id");
          if (typeof oid === "string") existing.add(oid);
        }
        const { slug: uniqueObjectId } = makeUniqueSlug(objectId, existing);
        // Factory sets EVERY snapshot-bound key. Notes preserved from the
        // hand-rolled version: image stays unavailable (no poster subsystem for
        // external media); NON-pending so the DO snapshot INSERTs it (no
        // manifest to validate); origin "compositor" is the verified
        // missing-from-repo sentinel (NOT "external"); empty thumbnail (no
        // poster fetch/upload/gate).
        const objMap = makeObjectYMap({
          tempId,
          createdBy: currentUserId,
          objectId: uniqueObjectId,
          title,
          sourceUrl,
          validationState: "valid",
          origin: "compositor",
        });
        objectsArray.push([objMap]);
      });
      // Return the stable handle so the caller can locate this exact object
      // (by _temp_id) without a race-prone array.get(length - 1) read.
      return tempId;
    };

    const deleteObject: StructuralOps["deleteObject"] = (id, tempId) => {
      ydoc.transact(() => {
        deleteFromArray(ydoc.getArray<Y.Map<unknown>>("objects"), id, tempId);
      });
    };

    // ---- Glossary ----

    const addGlossaryTerm: StructuralOps["addGlossaryTerm"] = (title) => {
      ydoc.transact(() => {
        const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
        // Collect existing term_ids so the auto-slug is deduped. Without
        // this, two "New term" clicks both produce e.g. `untitled-term`, which
        // breaks [[term]] resolution and the eventual UNIQUE constraint on the
        // D1 snapshot. Mirrors addGlossaryTermWithId.
        const existing: string[] = [];
        for (let i = 0; i < glossaryArray.length; i++) {
          const id = glossaryArray.get(i).get("term_id");
          if (typeof id === "string") existing.push(id);
        }
        const uniqueId = makeUniqueTermId(slugifyTermId(title), existing);
        const termMap = new Y.Map<unknown>();
        termMap.set("_id", null);
        termMap.set("_temp_id", crypto.randomUUID());
        termMap.set("created_by", currentUserId);
        termMap.set("title", new Y.Text(title));
        termMap.set("term_id", uniqueId);
        termMap.set("definition", new Y.Text(""));
        glossaryArray.push([termMap]);
      });
    };

    const addGlossaryTermWithId: StructuralOps["addGlossaryTermWithId"] = (
      termId,
      title,
    ) => {
      ydoc.transact(() => {
        const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
        // Collect existing term_ids so the candidate is deduped.
        const existing: string[] = [];
        for (let i = 0; i < glossaryArray.length; i++) {
          const id = glossaryArray.get(i).get("term_id");
          if (typeof id === "string") existing.push(id);
        }
        const uniqueId = makeUniqueTermId(termId, existing);
        const termMap = new Y.Map<unknown>();
        termMap.set("_id", null);
        termMap.set("_temp_id", crypto.randomUUID());
        termMap.set("created_by", currentUserId);
        termMap.set("title", new Y.Text(title));
        termMap.set("term_id", uniqueId);
        termMap.set("definition", new Y.Text(""));
        glossaryArray.push([termMap]);
      });
    };

    const deleteGlossaryTerm: StructuralOps["deleteGlossaryTerm"] = (id, tempId) => {
      ydoc.transact(() => {
        deleteFromArray(ydoc.getArray<Y.Map<unknown>>("glossary"), id, tempId);
      });
    };

    return {
      canDelete,
      addStory,
      deleteStory,
      reorderStories,
      addStep,
      addSectionCard,
      deleteStep,
      reorderSteps,
      addLayer,
      deleteLayer,
      addPage,
      deletePage,
      reorderPages,
      addIiifObject,
      addExternalMediaObject,
      deleteObject,
      addGlossaryTerm,
      addGlossaryTermWithId,
      deleteGlossaryTerm,
    };
  }, [ydoc, currentUserId, role]);
}

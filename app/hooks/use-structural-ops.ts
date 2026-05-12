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
 * @version v1.2.0-beta
 */

import { useMemo } from "react";
import * as Y from "yjs";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { findYMapIndex } from "~/lib/yjs-helpers";
import { normaliseSlug, makeUniqueSlug, slugifyTermId } from "~/lib/slug";

export type StructuralRole = "convenor" | "collaborator";

export interface StructuralOps {
  // Permission check.
  canDelete: (yMap: Y.Map<unknown>) => boolean;

  // Stories.
  addStory: (title: string, storyId: string) => void;
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
  addIiifObject: (objectId: string, title: string, sourceUrl: string) => void;
  deleteObject: (id: number | null, tempId: string | null) => void;
  reorderObjects: (oldIndex: number, newIndex: number) => void;

  // Glossary.
  addGlossaryTerm: (title: string) => void;
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
function reorderInPlace(
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

export const __test__ = { reorderInPlace };

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

    const addStory: StructuralOps["addStory"] = (title, storyId) => {
      ydoc.transact(() => {
        const storiesArray = ydoc.getArray<Y.Map<unknown>>("stories");
        const storyMap = new Y.Map<unknown>();
        storyMap.set("_id", null);
        storyMap.set("_temp_id", crypto.randomUUID());
        storyMap.set("created_by", currentUserId);
        storyMap.set("story_id", storyId);
        storyMap.set("title", new Y.Text(title));
        storyMap.set("subtitle", new Y.Text(""));
        storyMap.set("byline", new Y.Text(""));
        storyMap.set("order", storiesArray.length);
        storyMap.set("private", false);
        storyMap.set("draft", false);
        storyMap.set("steps", new Y.Array<Y.Map<unknown>>());
        storiesArray.push([storyMap]);
      });
    };

    const deleteStory: StructuralOps["deleteStory"] = (id, tempId) => {
      ydoc.transact(() => {
        const storiesArray = ydoc.getArray<Y.Map<unknown>>("stories");
        const idx = findYMapIndex(storiesArray, id, tempId);
        if (idx >= 0) storiesArray.delete(idx, 1);
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
        const stepMap = new Y.Map<unknown>();
        stepMap.set("_id", null);
        stepMap.set("_temp_id", crypto.randomUUID());
        stepMap.set("created_by", currentUserId);
        stepMap.set("step_number", stepsArray.length + 1);
        stepMap.set("kind", "media");
        stepMap.set("object_id", "");
        stepMap.set("x", null);
        stepMap.set("y", null);
        stepMap.set("zoom", null);
        stepMap.set("page", "");
        stepMap.set("question", new Y.Text(""));
        stepMap.set("answer", new Y.Text(""));
        stepMap.set("alt_text", new Y.Text(""));
        stepMap.set("clip_start", "");
        stepMap.set("clip_end", "");
        stepMap.set("loop", "");
        stepMap.set("layers", new Y.Array<Y.Map<unknown>>());
        stepsArray.push([stepMap]);
      });
    };

    const addSectionCard: StructuralOps["addSectionCard"] = (storyYMap) => {
      ydoc.transact(() => {
        const stepsArray = storyYMap.get("steps") as Y.Array<Y.Map<unknown>>;
        if (!(stepsArray instanceof Y.Array)) return;
        const stepMap = new Y.Map<unknown>();
        stepMap.set("_id", null);
        stepMap.set("_temp_id", crypto.randomUUID());
        stepMap.set("created_by", currentUserId);
        stepMap.set("step_number", stepsArray.length + 1);
        stepMap.set("kind", "section");
        // Section cards have no media — empty object_id signals a section card to the framework on publish
        stepMap.set("object_id", "");
        stepMap.set("x", null);
        stepMap.set("y", null);
        stepMap.set("zoom", null);
        stepMap.set("page", "");
        // The heading text lives in the existing `question` field — Y.Text so collaborative edits work
        stepMap.set("question", new Y.Text(""));
        stepMap.set("answer", new Y.Text(""));
        stepMap.set("alt_text", new Y.Text(""));
        stepMap.set("clip_start", "");
        stepMap.set("clip_end", "");
        stepMap.set("loop", "");
        // Section cards never carry layers; store an empty Y.Array for shape consistency
        stepMap.set("layers", new Y.Array<Y.Map<unknown>>());
        stepsArray.push([stepMap]);
      });
    };

    const deleteStep: StructuralOps["deleteStep"] = (storyYMap, stepId, tempId) => {
      ydoc.transact(() => {
        const stepsArray = storyYMap.get("steps") as Y.Array<Y.Map<unknown>>;
        if (!(stepsArray instanceof Y.Array)) return;
        const idx = findYMapIndex(stepsArray, stepId, tempId);
        if (idx >= 0) stepsArray.delete(idx, 1);
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
        const layersArray = stepYMap.get("layers") as Y.Array<Y.Map<unknown>>;
        if (!(layersArray instanceof Y.Array)) return;
        const idx = findYMapIndex(layersArray, layerId, tempId);
        if (idx >= 0) layersArray.delete(idx, 1);
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
        const pagesArray = ydoc.getArray<Y.Map<unknown>>("pages");
        const idx = findYMapIndex(pagesArray, id, tempId);
        if (idx >= 0) pagesArray.delete(idx, 1);
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
      ydoc.transact(() => {
        const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
        const objMap = new Y.Map<unknown>();
        objMap.set("_id", null);
        objMap.set("_temp_id", crypto.randomUUID());
        objMap.set("created_by", currentUserId);
        objMap.set("object_id", objectId);
        objMap.set("title", new Y.Text(title));
        objMap.set("creator", new Y.Text(""));
        objMap.set("description", new Y.Text(""));
        objMap.set("alt_text", new Y.Text(""));
        objMap.set("source_url", sourceUrl);
        objMap.set("period", new Y.Text(""));
        objMap.set("year", new Y.Text(""));
        objMap.set("featured", false);
        objMap.set("image_available", false);
        objMap.set("_validation_state", "pending");
        objMap.set("order", objectsArray.length);
        objMap.set("origin", "iiif");
        objMap.set("missing_from_repo", false);
        objMap.set("thumbnail", "");
        objectsArray.push([objMap]);
      });
    };

    const deleteObject: StructuralOps["deleteObject"] = (id, tempId) => {
      ydoc.transact(() => {
        const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
        const idx = findYMapIndex(objectsArray, id, tempId);
        if (idx >= 0) objectsArray.delete(idx, 1);
      });
    };

    const reorderObjects: StructuralOps["reorderObjects"] = (oldIndex, newIndex) => {
      ydoc.transact(() => {
        const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
        reorderInPlace(objectsArray, oldIndex, newIndex);
      });
    };

    // ---- Glossary ----

    const addGlossaryTerm: StructuralOps["addGlossaryTerm"] = (title) => {
      ydoc.transact(() => {
        const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
        const termMap = new Y.Map<unknown>();
        termMap.set("_id", null);
        termMap.set("_temp_id", crypto.randomUUID());
        termMap.set("created_by", currentUserId);
        termMap.set("title", new Y.Text(title));
        termMap.set("term_id", slugifyTermId(title));  // auto-slugify
        termMap.set("definition", new Y.Text(""));
        glossaryArray.push([termMap]);
      });
    };

    const deleteGlossaryTerm: StructuralOps["deleteGlossaryTerm"] = (id, tempId) => {
      ydoc.transact(() => {
        const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
        const idx = findYMapIndex(glossaryArray, id, tempId);
        if (idx >= 0) glossaryArray.delete(idx, 1);
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
      deleteObject,
      reorderObjects,
      addGlossaryTerm,
      deleteGlossaryTerm,
    };
  }, [ydoc, currentUserId, role]);
}

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
 * anything; collaborators and instructors can delete only items
 * they created themselves. An object carrying `course_project_id`
 * is undeletable for everyone while the marker is set.
 *
 * A new media step may be seeded from another step: `addStep` takes a
 * `StepSeed` of plain scalars and writes them into the fresh Y.Map inside the
 * same transaction, so peers and the snapshot see the step with its object
 * already set rather than an empty step that acquires one a moment later. The
 * seeded keys are ordinary step values from that moment on.
 *
 * @version v1.5.0-beta
 */

import { useMemo } from "react";
import * as Y from "yjs";
import {
  ORDER_KEY,
  nextOrderKeyAfterLast,
  reorderByOrderKey,
} from "~/lib/field-order";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { findYMapIndex } from "~/lib/yjs-helpers";
import { normaliseSlug, makeUniqueSlug, slugifyTermId } from "~/lib/slug";
import { makeUniqueTermId } from "~/lib/glossary-slug";
import { makeObjectYMap } from "~/lib/object-ymap";

export type StructuralRole = "convenor" | "collaborator" | "instructor";

/**
 * Y.Map key naming the course an object was preloaded from. Mirrors
 * `workers/can-delete.ts` COURSE_MARKER_KEY — the two gates must agree on
 * the key or the client would offer a delete the Durable Object reverts.
 */
export const COURSE_MARKER_KEY = "course_project_id";

/**
 * True for an object preloaded from a course and still attached to it. The
 * marker is an integer when set and absent when not; a null value means
 * unmarked, so only an integer gates.
 */
export function isCourseItemYMap(yMap: Y.Map<unknown>): boolean {
  return typeof yMap.get(COURSE_MARKER_KEY) === "number";
}

/**
 * The delete gate, mirroring the Durable Object's server-side enforcement.
 * The course-item clause is first and role-independent: a marked object is
 * refused here so a forbidden delete is never applied, reverted by the DO
 * and — on the third attempt in a minute — punished with a closed socket.
 */
export function canDeleteYMap(
  yMap: Y.Map<unknown>,
  role: StructuralRole,
  currentUserId: number,
): boolean {
  if (isCourseItemYMap(yMap)) return false;
  if (role === "convenor") return true;
  return yMap.get("created_by") === currentUserId;
}

/**
 * The values a new step inherits from the step it was seeded off: the object
 * and the view of it. Clip values are not inherited — a clip belongs to the
 * moment an author chose in one step, not to the object.
 */
export interface StepSeed {
  object_id: string;
  page: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
}

/** A new panel's text as the author first wrote it, and the key it was held under. */
export interface NewLayerText {
  tempId?: string;
  title?: string;
  content?: string;
}

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
  addStep: (storyYMap: Y.Map<unknown>, seed?: StepSeed) => string | null;
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
  /**
   * Writes a panel with its first content (`initial`), held in the editor
   * until then (use-pending-layers.ts). False, and nothing written, where
   * the step already has a panel of that number.
   */
  addLayer: (
    stepYMap: Y.Map<unknown>,
    layerNumber: number,
    buttonLabel: string,
    initial?: NewLayerText
  ) => boolean;
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
 * Reordering used to live here, as `reorderInPlace`: deep-clone the Y.Map at
 * `oldIndex`, delete the original, insert the clone at `newIndex`. It is gone,
 * and nothing replaced it in this file — every list now moves an entry by
 * writing its `order_key` (`reorderByOrderKey`, app/lib/field-order.ts).
 *
 * The reason is not tidiness. A delete-plus-reinsert is, on the wire, exactly
 * what "delete a colleague's entity and put a hollow one carrying their
 * identity in its place" looks like, so the server's own-content delete rule
 * could not refuse the attack without refusing the drag. It carried an
 * exemption instead, decided on `_temp_id` and `created_by` — both of which
 * any collaborator can write. With no list reordering this way, the exemption
 * is gone too (workers/can-delete.ts).
 */

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
  orderKey: string,
  kind: "media" | "section"
): Y.Map<unknown> {
  const stepMap = new Y.Map<unknown>();
  stepMap.set("_id", null);
  stepMap.set("_temp_id", crypto.randomUUID());
  stepMap.set("created_by", currentUserId);
  // Advisory: the published `step` number is the rank the snapshot derives from
  // order_key order, so this copy is a hint for the editor, never the ordering.
  stepMap.set("step_number", stepNumber);
  stepMap.set(ORDER_KEY, orderKey);
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
  // The kept cells of story CSV columns the Compositor does not map; a new
  // step has none, whatever step its view was seeded from.
  stepMap.set("extra_columns", "");
  stepMap.set("layers", new Y.Array<Y.Map<unknown>>());
  return stepMap;
}

export const __test__ = { buildStepYMap };

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

    const canDelete = (yMap: Y.Map<unknown>): boolean =>
      canDeleteYMap(yMap, role, currentUserId);

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
        storyMap.set(ORDER_KEY, nextOrderKeyAfterLast(storiesArray));
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
      // Every list moves an entry by writing its own place, not by moving it
      // between Y.Array positions: nothing is deleted, so the server's
      // own-content delete rule has nothing to judge and two concurrent drags
      // settle as last-write-wins on two independent fields.
      ydoc.transact(() => {
        const storiesArray = ydoc.getArray<Y.Map<unknown>>("stories");
        reorderByOrderKey(storiesArray, oldIndex, newIndex);
      });
    };

    // ---- Steps ----

    const addStep: StructuralOps["addStep"] = (storyYMap, seed) => {
      let tempId: string | null = null;
      ydoc.transact(() => {
        const stepsArray = storyYMap.get("steps") as Y.Array<Y.Map<unknown>>;
        if (!(stepsArray instanceof Y.Array)) return;
        const stepMap = buildStepYMap(
          currentUserId,
          stepsArray.length + 1,
          nextOrderKeyAfterLast(stepsArray),
          "media",
        );
        if (seed) {
          stepMap.set("object_id", seed.object_id);
          stepMap.set("page", seed.page);
          stepMap.set("x", seed.x);
          stepMap.set("y", seed.y);
          stepMap.set("zoom", seed.zoom);
        }
        // A Y.Map's entries live in preliminary content until it joins the
        // document, and `get` reads nothing there, so the temp id is read back
        // after the push.
        stepsArray.push([stepMap]);
        tempId = (stepMap.get("_temp_id") as string | null) ?? null;
      });
      return tempId;
    };

    const addSectionCard: StructuralOps["addSectionCard"] = (storyYMap) => {
      ydoc.transact(() => {
        const stepsArray = storyYMap.get("steps") as Y.Array<Y.Map<unknown>>;
        if (!(stepsArray instanceof Y.Array)) return;
        stepsArray.push([
          buildStepYMap(
            currentUserId,
            stepsArray.length + 1,
            nextOrderKeyAfterLast(stepsArray),
            "section",
          ),
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
      // One field write on one map. Nothing leaves the steps Y.Array, so the
      // server's own-content delete rule has nothing to judge and two
      // concurrent drags settle as last-write-wins on two independent fields.
      ydoc.transact(() => {
        const stepsArray = storyYMap.get("steps") as Y.Array<Y.Map<unknown>>;
        if (!(stepsArray instanceof Y.Array)) return;
        reorderByOrderKey(stepsArray, oldIndex, newIndex);
      });
    };

    // ---- Layers ----

    const addLayer: StructuralOps["addLayer"] = (
      stepYMap,
      layerNumber,
      buttonLabel,
      initial = {}
    ) => {
      let added = false;
      ydoc.transact(() => {
        const layersArray = stepYMap.get("layers") as Y.Array<Y.Map<unknown>>;
        if (!(layersArray instanceof Y.Array)) return;
        // A collaborator's panel in the same place was written first.
        if (layersArray.toArray().some((m) => m.get("layer_number") === layerNumber)) return;
        const layerMap = new Y.Map<unknown>();
        layerMap.set("_id", null);
        layerMap.set("_temp_id", initial.tempId ?? crypto.randomUUID());
        layerMap.set("created_by", currentUserId);
        // Also the published slot (layer1_* versus layer2_* cells), which is
        // why it stays a field of its own rather than becoming the ordering.
        layerMap.set("layer_number", layerNumber);
        layerMap.set(ORDER_KEY, nextOrderKeyAfterLast(layersArray));
        // No title: the panel is headed as the site heads an untitled one
        // (`panelHeading`), from its button label, which the author may change.
        layerMap.set("title", new Y.Text(initial.title ?? ""));
        layerMap.set("button_label", new Y.Text(buttonLabel));
        layerMap.set("content", new Y.Text(initial.content ?? ""));
        layersArray.push([layerMap]);
        added = true;
      });
      return added;
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
        // A new page has a file with no front matter yet, which is "", not
        // the null of a file never read.
        pageMap.set("frontmatter", "");
        pageMap.set(ORDER_KEY, nextOrderKeyAfterLast(pagesArray));
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
        reorderByOrderKey(pagesArray, oldIndex, newIndex);
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
          orderKey: nextOrderKeyAfterLast(objectsArray),
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
          orderKey: nextOrderKeyAfterLast(objectsArray),
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
        termMap.set(ORDER_KEY, nextOrderKeyAfterLast(glossaryArray));
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
        termMap.set(ORDER_KEY, nextOrderKeyAfterLast(glossaryArray));
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

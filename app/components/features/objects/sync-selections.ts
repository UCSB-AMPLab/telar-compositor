/**
 * What the objects page's sync dialog (SyncDiffDialog) shows ticked and
 * chosen, and what it posts for them. Pure; the dialog holds the author's
 * selections and renders what these answer.
 *
 * An entry the author has not touched takes the default. A three-way check
 * (one compared against a base, `suppressedEditorOnly` present) opens on the
 * full sync's defaults (`buildThreeWayChanges`): an object deleted here and
 * edited on GitHub is left deleted, an object deleted on GitHub and edited
 * here is kept, and a changed field takes `threeWayFieldDefault`. A two-way
 * check, with no base, ticks every row and keeps the editor's value of every
 * field: without a base the D1 value may be an edit made here and not yet
 * published, and one press of Apply must not overwrite it.
 *
 * @version v1.5.0-beta
 */

import type { ChangedObject, MissingObject, NewObject, SyncDiff, SyncField } from "~/lib/sync.server";
import { fieldsSeenFor, ownValue, threeWayFieldDefault } from "~/components/features/dashboard/sync-changes";

/** The author's own ticks and field choices, by object_id; an absent key is the default. */
export interface ObjectsSyncSelections {
  checkedNew: Record<string, boolean>;
  checkedChanged: Record<string, boolean>;
  checkedMissing: Record<string, boolean>;
  checkedUnregistered: Record<string, boolean>;
  fieldChoices: Record<string, Record<string, "repo" | "d1">>;
}

export function emptyObjectsSyncSelections(): ObjectsSyncSelections {
  return { checkedNew: {}, checkedChanged: {}, checkedMissing: {}, checkedUnregistered: {}, fieldChoices: {} };
}

/** What the objects page's apply posts. */
export interface SyncApplyPayload {
  newObjectIds: string[];
  changedObjectIds: string[];
  /** The D1 id each changed object was shown with, so the apply updates that row and no other. */
  changedDocIds: Record<string, number>;
  fieldChoices: Record<string, Record<string, "repo" | "d1">>;
  /** The Compositor's value of each field taken from GitHub, as the check showed it (`fieldsSeenFor`). */
  fieldsSeen: Record<string, Record<string, string | boolean | null>>;
  removedObjectIds: string[];
  /** The D1 id each removed object was shown with, so the apply removes that row and no other. */
  removedDocIds: Record<string, number>;
  unregisteredObjectIds: string[];
  /** The commit the check the author reviewed was read at. */
  headSha?: string;
  /** The objects_read_sha the check was compared against, null for none. */
  baseSha?: string | null;
}

/** Whether the check compared against a base. */
export function isThreeWayCheck(diff: SyncDiff | null): boolean {
  return diff?.suppressedEditorOnly !== undefined;
}

/**
 * Whether the check lists an object deleted on one side and edited on the
 * other. Its default, unticked, keeps the Compositor's side, and is a choice
 * the author can apply with nothing else ticked.
 */
export function listsDeletionConflict(diff: SyncDiff): boolean {
  return diff.newObjects.some((o) => o.deletedInCompositor) || diff.missingObjects.some((o) => o.editedInCompositor);
}

export function newObjectTicked(sel: ObjectsSyncSelections, obj: NewObject): boolean {
  return ownValue(sel.checkedNew, obj.object_id) ?? !obj.deletedInCompositor;
}

export function changedObjectTicked(sel: ObjectsSyncSelections, objectId: string): boolean {
  return ownValue(sel.checkedChanged, objectId) ?? true;
}

export function missingObjectTicked(sel: ObjectsSyncSelections, obj: MissingObject): boolean {
  return ownValue(sel.checkedMissing, obj.object_id) ?? !obj.editedInCompositor;
}

export function unregisteredFileTicked(sel: ObjectsSyncSelections, objectId: string): boolean {
  return ownValue(sel.checkedUnregistered, objectId) ?? true;
}

export function objectsFieldChoice(
  sel: ObjectsSyncSelections,
  threeWay: boolean,
  obj: ChangedObject,
  field: SyncField,
): "repo" | "d1" {
  const own = ownValue(sel.fieldChoices, obj.object_id)?.[field];
  if (own) return own;
  return threeWay ? threeWayFieldDefault(obj, field) : "d1";
}

/**
 * The payload for `diff` under `sel`. Field choices are built from the fields
 * on screen, not from the ones the author clicked, so that what is submitted
 * is what the radios show whatever the default is; an unticked object
 * contributes nothing. Built from entries, so every object id, a `__proto__`
 * included, is an own property.
 */
export function buildObjectsSyncPayload(diff: SyncDiff, sel: ObjectsSyncSelections): SyncApplyPayload {
  const threeWay = isThreeWayCheck(diff);
  const changedObjects = diff.changedObjects.filter((o) => changedObjectTicked(sel, o.object_id));
  const removedObjects = diff.missingObjects.filter((o) => missingObjectTicked(sel, o));
  const fieldChoices: Record<string, Record<string, "repo" | "d1">> = Object.fromEntries(
    changedObjects.map((obj) => [
      obj.object_id,
      Object.fromEntries(obj.changedFields.map((field) => [field, objectsFieldChoice(sel, threeWay, obj, field)])),
    ]),
  );
  return {
    newObjectIds: diff.newObjects.filter((o) => newObjectTicked(sel, o)).map((o) => o.object_id),
    changedObjectIds: changedObjects.map((o) => o.object_id),
    changedDocIds: Object.fromEntries(changedObjects.map((o) => [o.object_id, o.dbId])),
    fieldChoices,
    fieldsSeen: fieldsSeenFor(changedObjects, fieldChoices),
    removedObjectIds: removedObjects.map((o) => o.object_id),
    removedDocIds: Object.fromEntries(removedObjects.map((o) => [o.object_id, o.dbId])),
    unregisteredObjectIds: diff.unregisteredFiles
      .map((f) => f.object_id)
      .filter((id) => unregisteredFileTicked(sel, id)),
    headSha: diff.headSha,
    ...(diff.baseSha !== undefined ? { baseSha: diff.baseSha } : {}),
  };
}

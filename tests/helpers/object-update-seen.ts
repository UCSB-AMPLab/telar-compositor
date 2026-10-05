/**
 * The `seen` values a sync check would have read, for tests that post object
 * updates straight to the collaboration object or build an apply's choices by
 * hand. The collaboration object writes a field only when it carries the value
 * the check read (`fieldsUnchangedSinceReview`), and the applies refuse a field
 * taken from GitHub without one, so a test about something else states them.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import type { SyncChanges } from "~/lib/sync.server";

type SeenValue = string | boolean | null;

/** The object `objectId`'s value of `field` in the document, as a check reads it. */
export function documentSeenValue(ydoc: Y.Doc, objectId: string, field: string): SeenValue {
  const held = ydoc.getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("object_id") === objectId);
  const value = held?.get(field);
  if (field === "featured") return Boolean(value);
  if (value instanceof Y.Text) return value.toString();
  return value === undefined || value === null ? null : String(value);
}

/**
 * `body` with a `seen` map on each `objects.update` entry whose `fields` is a
 * plain object and which states none: the document's current value of each
 * field, as a check that read it now would send.
 */
export function withDocumentSeen(ydoc: Y.Doc, body: unknown): unknown {
  const objects = (body as { objects?: { update?: unknown } } | null)?.objects;
  if (!objects || !Array.isArray(objects.update)) return body;
  const update = objects.update.map((entry: unknown) => {
    const held = entry as { objectId?: unknown; fields?: unknown; seen?: unknown } | null;
    if (!held || typeof held !== "object" || held.seen !== undefined) return entry;
    if (typeof held.objectId !== "string" || !held.fields || typeof held.fields !== "object" || Array.isArray(held.fields)) {
      return entry;
    }
    const objectId = held.objectId;
    const seen = Object.fromEntries(Object.keys(held.fields).map((f) => [f, documentSeenValue(ydoc, objectId, f)]));
    return { ...held, seen };
  });
  return { ...(body as object), objects: { ...objects, update } };
}

/** The document a test loaded, whose values `withChoicesSeen` reads by default; null for none. */
let seenDocument: Y.Doc | null = null;

/** Read the values a check saw from `ydoc` (null: from no document, every value null). */
export function readSeenFrom(ydoc: Y.Doc | null): void {
  seenDocument = ydoc;
}

/**
 * `changes` with `fieldsSeen` stating `value(objectId, field)` for each field
 * its choices take from GitHub, unless it states its own: by default the
 * document `readSeenFrom` named, or null where it named none.
 */
export function withChoicesSeen(
  changes: SyncChanges,
  value: (objectId: string, field: string) => SeenValue = (objectId, field) =>
    seenDocument ? documentSeenValue(seenDocument, objectId, field) : null,
): SyncChanges {
  if (changes.fieldsSeen !== undefined) return changes;
  const fieldsSeen = Object.fromEntries(
    Object.entries(changes.fieldChoices).map(([objectId, choices]) => [
      objectId,
      Object.fromEntries(
        Object.entries(choices).filter(([, choice]) => choice === "repo").map(([field]) => [field, value(objectId, field)]),
      ),
    ]),
  );
  return { ...changes, fieldsSeen };
}

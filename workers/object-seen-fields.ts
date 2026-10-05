/**
 * The `/ingest-sync` object update's `seen` map: each field's value as the
 * sync check read it from D1. A field whose value in the document differs
 * from it was edited here after the author reviewed the change, and is left
 * as it is; the rest of the update applies. Every field an update writes is a
 * value the author took from GitHub, so a field with no `seen` value is left
 * too: nothing says what the author reviewed it against.
 *
 * `image_available` is the exception: the sync recomputes it by the tiler's
 * rule and the author never reviews it, so a document value that differs
 * from its `seen` value is left without counting as a change since review,
 * and never holds an apply back.
 *
 * Both sides are compared as the snapshot writes them to D1: `featured` and
 * `image_available` as booleans, every other field as its text, with an
 * absent or null value read as empty.
 *
 * @version v1.5.0-beta
 */

import type * as Y from "yjs";
import { yTextToString } from "./collaboration-helpers";

type ObjectFieldValues = Partial<Record<string, string | boolean | null>>;

/** The fields the sync recomputes rather than the author reviewing them. */
const RECOMPUTED_FIELDS: ReadonlySet<string> = new Set(["image_available"]);

/** A field value as D1 holds it, for comparison. */
function comparableFieldValue(field: string, value: unknown): string {
  return field === "featured" || RECOMPUTED_FIELDS.has(field) ? String(Boolean(value)) : yTextToString(value);
}

/**
 * The update's fields without those whose document value has changed since
 * the check read `seen`, or that carry no `seen` value, and whether any was
 * left. `customBlob` is the object's `extra_columns` as the snapshot writes it,
 * which the document's own string stops being once a custom field is edited.
 */
export function fieldsUnchangedSinceReview(
  map: Y.Map<unknown>,
  update: { fields?: ObjectFieldValues; seen?: ObjectFieldValues },
  customBlob?: (map: Y.Map<unknown>) => string,
): { fields: ObjectFieldValues; changed: boolean } {
  const seen = update.seen ?? {};
  const fields: ObjectFieldValues = {};
  let changed = false;
  for (const [field, value] of Object.entries(update.fields ?? {})) {
    const reviewed = Object.hasOwn(seen, field)
      && comparableFieldValue(field, field === "extra_columns" && customBlob ? customBlob(map) : map.get(field))
        === comparableFieldValue(field, seen[field]);
    if (reviewed) fields[field] = value;
    else if (!RECOMPUTED_FIELDS.has(field)) changed = true;
  }
  return { fields, changed };
}

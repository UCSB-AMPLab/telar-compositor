/**
 * The `/ingest-sync` glossary update's `seen` map: each field's value as its
 * caller read it. A field whose value in the document differs from it was
 * edited after that read and is left as it is; the rest of the update
 * applies. A field with no `seen` value applies as stated, which is how every
 * glossary update that carries no `seen` map is applied.
 *
 * Both sides are compared as text, with an absent or null value read as empty
 * and CRLF read as LF, since a definition read from a CSV and the same
 * definition in the document can differ only in their line endings.
 *
 * @version v1.5.5-beta
 */

import type * as Y from "yjs";
import { yTextToString } from "./collaboration-helpers";

export type GlossaryFieldValues = { title?: string; definition?: string; kind?: string };

const GLOSSARY_FIELDS = ["title", "definition", "kind"] as const;

/** A field value as text, its line breaks read as LF. */
function comparableText(value: unknown): string {
  return yTextToString(value).replace(/\r\n/g, "\n");
}

/**
 * The update's fields without those whose document value differs from their
 * `seen` value, and whether any was left.
 */
export function glossaryFieldsUnchangedSinceRead(
  map: Y.Map<unknown>,
  update: GlossaryFieldValues & { seen?: GlossaryFieldValues },
): { fields: GlossaryFieldValues; changed: boolean } {
  const seen = update.seen ?? {};
  const fields: GlossaryFieldValues = {};
  let changed = false;
  for (const field of GLOSSARY_FIELDS) {
    if (update[field] === undefined) continue;
    if (Object.hasOwn(seen, field) && comparableText(map.get(field)) !== comparableText(seen[field])) {
      changed = true;
      continue;
    }
    fields[field] = update[field];
  }
  return { fields, changed };
}

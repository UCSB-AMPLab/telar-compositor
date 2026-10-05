/**
 * This file holds the glossary page's term shape and the two readers that
 * every view of a term goes through. It is kept out of the route so the route
 * module exports only route members.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

export interface TermItem {
  _id: number | null;
  _temp_id: string | null;
  title: string;
  term_id: string;
  definition: string;
  /** The kind as stored (an id, a value that names one, or text that names none); "" when none. */
  kind: string;
  yMap: Y.Map<unknown>;
}

/**
 * Stable key for React and selection tracking.
 *
 * Prefer `_temp_id` whenever it exists: a term created in this session keeps its
 * `_temp_id` for the lifetime of the doc, but its `_id` flips from null to a real
 * number the moment the snapshot first persists it (collaboration.ts backfill).
 * Keying on `_id` would change the term's identity mid-edit, so `selectedKey`
 * (captured before the backfill) would stop matching, `selectedTerm` would resolve
 * to null, and the open definition editor would unmount — discarding everything
 * typed after the backfill and leaving only the first character or two in the
 * Y.Text (telar-compositor#26). `_temp_id` is immutable across that backfill, so it
 * keeps the selection — and the editor — stable. Terms loaded from D1 carry no
 * `_temp_id` and key stably on `id:`.
 */
export function termKey(t: TermItem): string {
  return t._temp_id ? `tmp:${t._temp_id}` : `id:${t._id}`;
}

/**
 * One of a term's text fields as a plain string. Every such field is a Y.Text
 * once the editor has touched it and may still be a plain string on a map built
 * elsewhere, so both shapes are read here and anything else reads as empty —
 * the map is collaborative, so no value on it is guaranteed to be either.
 */
export function readTermText(m: Y.Map<unknown>, key: string): string {
  const raw = m.get(key);
  if (raw instanceof Y.Text) return raw.toString();
  return typeof raw === "string" ? raw : "";
}

/** A term's stored kind: the string its map holds, "" for none or for anything else. */
export function readTermKind(m: Y.Map<unknown>): string {
  const raw = m.get("kind");
  return typeof raw === "string" ? raw : "";
}

/**
 * Shared factory for object Y.Maps — the single source of truth for which keys
 * a client-created object carries in the collaborative doc.
 *
 * Why this exists: the DO snapshot (workers/collaboration.ts pushObjectUpdate)
 * binds EVERY editable object column from the Y.Map on every cycle, and
 * yTextToString(undefined) === "" — so a creation site that omits a key
 * silently ERASES that column in D1 on the next snapshot. Separately, the
 * detail editor binds fields with getYText(map, key), which returns null for
 * absent keys, so edits to those fields update only local React state and are
 * lost. Before this factory, three call sites (the upload-completion mirror in
 * _app.objects.tsx, addIiifObject and addExternalMediaObject in
 * use-structural-ops.ts) each hand-rolled their key sets and drifted — the
 * upload mirror dropped source/credit/object_type/subjects (wiping
 * just-uploaded metadata) and wrote the title into alt_text.
 *
 * tests/object-ymap-factory.test.ts pins the factory's key set against the
 * snapshot UPDATE's bind list. If you add a column to pushObjectUpdate, add it
 * here (and to the test's canonical list) in the same change.
 *
 * @version v1.3.0-beta
 */

import * as Y from "yjs";

/** Collaboratively-edited text fields — stored as Y.Text so getYText() binds. */
export const OBJECT_YTEXT_KEYS = [
  "title",
  "creator",
  "description",
  "alt_text",
  "period",
  "year",
  "object_type",
  "subjects",
  "source",
  "credit",
] as const;

/** Passthrough fields — plain values, not collaboratively merged. */
export const OBJECT_PLAIN_KEYS = [
  "source_url",
  "thumbnail",
  "dimensions",
  "extra_columns",
  "featured",
  "image_available",
  "origin",
  "missing_from_repo",
] as const;

export interface ObjectYMapFields {
  /** D1 row id when known (the snapshot UPDATEs); null → snapshot INSERTs. */
  id?: number | null;
  /** Stable client handle; generated when omitted. */
  tempId?: string;
  createdBy?: number | null;
  objectId: string;
  title?: string | null;
  creator?: string | null;
  description?: string | null;
  altText?: string | null;
  sourceUrl?: string | null;
  period?: string | null;
  year?: string | null;
  objectType?: string | null;
  subjects?: string | null;
  source?: string | null;
  credit?: string | null;
  thumbnail?: string | null;
  dimensions?: string | null;
  extraColumns?: string | null;
  featured?: boolean;
  imageAvailable?: boolean;
  /** "pending" IIIF objects are skipped by the snapshot until validated. */
  validationState: "pending" | "valid";
  origin: string;
}

/**
 * Builds a complete object Y.Map. Every key the snapshot UPDATE reads is set —
 * text fields as Y.Text (empty when not provided), passthroughs as plain
 * values — so the snapshot writes faithfully and every field is editable
 * immediately, without waiting for a DO reload to backfill missing keys.
 */
export function makeObjectYMap(fields: ObjectYMapFields): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("_id", fields.id ?? null);
  map.set("_temp_id", fields.tempId ?? crypto.randomUUID());
  map.set("created_by", fields.createdBy ?? null);
  map.set("object_id", fields.objectId);
  map.set("title", new Y.Text(fields.title ?? ""));
  map.set("creator", new Y.Text(fields.creator ?? ""));
  map.set("description", new Y.Text(fields.description ?? ""));
  map.set("alt_text", new Y.Text(fields.altText ?? ""));
  map.set("period", new Y.Text(fields.period ?? ""));
  map.set("year", new Y.Text(fields.year ?? ""));
  map.set("object_type", new Y.Text(fields.objectType ?? ""));
  map.set("subjects", new Y.Text(fields.subjects ?? ""));
  map.set("source", new Y.Text(fields.source ?? ""));
  map.set("credit", new Y.Text(fields.credit ?? ""));
  map.set("source_url", fields.sourceUrl ?? "");
  map.set("thumbnail", fields.thumbnail ?? "");
  map.set("dimensions", fields.dimensions ?? "");
  map.set("extra_columns", fields.extraColumns ?? "");
  map.set("featured", fields.featured ?? false);
  map.set("image_available", fields.imageAvailable ?? false);
  map.set("_validation_state", fields.validationState);
  map.set("origin", fields.origin);
  map.set("missing_from_repo", false);
  return map;
}

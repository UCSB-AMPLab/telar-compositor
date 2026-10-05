/**
 * The values an ingested object insert writes onto its Y.Map, beside `_id`
 * and its place (`order_key`).
 *
 * One table, read by the two places that must agree on it: the ingest builds
 * the insert's Y.Map from it (`buildObjectYMap`), and an all-or-nothing ingest
 * compares a row already holding the key against it (`ingest-held-back.ts`).
 * A field added to the insert is therefore compared as soon as it is written.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import type { IngestObjectInsert } from "./collaboration";

/** The fields the insert carries as `Y.Text`, as `buildFromD1Rows` builds them. */
const OBJECT_INSERT_YTEXT_FIELDS: ReadonlySet<string> = new Set([
  "title", "creator", "description", "alt_text", "period", "year",
  "object_type", "subjects", "source", "credit",
]);

/** One value an insert writes, as the Y.Map holds it once read back (`Y.Text` as its string). */
export type ObjectInsertValue = string | boolean | number | null;

/**
 * The values `p` writes, in the order the Y.Map takes them. `origin` is
 * carried only for "compositor" and "repo" and `course_project_id` only for a
 * positive integer: an absent key is what "not set" means for both.
 */
export function objectInsertValues(p: IngestObjectInsert): Array<[string, ObjectInsertValue]> {
  const values: Array<[string, ObjectInsertValue]> = [
    ["object_id", p.object_id],
    ["title", p.title ?? ""],
    ["creator", p.creator ?? ""],
    ["description", p.description ?? ""],
    ["alt_text", p.alt_text ?? ""],
    ["source_url", p.source_url ?? ""],
    ["period", p.period ?? ""],
    ["year", p.year ?? ""],
    ["object_type", p.object_type ?? ""],
    ["subjects", p.subjects ?? ""],
    ["source", p.source ?? ""],
    ["credit", p.credit ?? ""],
    ["thumbnail", p.thumbnail ?? ""],
    ["dimensions", p.dimensions ?? ""],
    ["extra_columns", p.extra_columns ?? ""],
    ["featured", Boolean(p.featured)],
    ["image_available", Boolean(p.image_available)],
    ["created_by", p.created_by ?? null],
  ];
  if (p.origin === "compositor" || p.origin === "repo") values.push(["origin", p.origin]);
  if (Number.isInteger(p.course_project_id) && (p.course_project_id as number) > 0) {
    values.push(["course_project_id", p.course_project_id as number]);
  }
  return values;
}

/** `value` as the Y.Map stores it for `field`: a `Y.Text` for the text fields, else as it is. */
export function objectInsertYValue(field: string, value: ObjectInsertValue): unknown {
  return OBJECT_INSERT_YTEXT_FIELDS.has(field) ? new Y.Text(value as string) : value;
}

/** A Y.Map value as an insert's value reads: a `Y.Text` as its string, an absent value as null. */
export function objectInsertValueOf(held: unknown): unknown {
  if (held instanceof Y.Text) return held.toString();
  return held ?? null;
}

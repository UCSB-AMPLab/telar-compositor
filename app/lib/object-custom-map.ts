/**
 * An object's custom fields in the collaborative document: a nested Y.Map,
 * `custom_fields`, holding one Y.Text per column, so two people editing
 * different columns of one object both keep their edit, and two typing in one
 * column merge as in the modelled text fields.
 *
 * D1 and the published file still hold the whole blob, `extra_columns`. Beside
 * the map the object keeps two strings: `extra_columns`, which a browser still
 * running the previous bundle reads and writes whole, and `_custom_fields_base`,
 * the blob the map was last set from. A write of a whole blob is applied as the
 * columns that differ from the base and no others, so it cannot overwrite a
 * column someone edited in the map since.
 *
 * Imports only yjs and the blob parsing, so the page, the worker and the tests
 * can take it.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { parseExtraColumns } from "./extra-columns";
import { customColumnOrder } from "./object-custom-fields";

export const CUSTOM_FIELDS_KEY = "custom_fields";
const BASE_KEY = "_custom_fields_base";
/** The keys an object holds for its custom fields beside `extra_columns`. */
export const CUSTOM_FIELD_KEYS: readonly string[] = [CUSTOM_FIELDS_KEY, BASE_KEY];

/** A blob's cell as the text a field holds. */
function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function stringAt(map: Y.Map<unknown>, key: string): string {
  const value = map.get(key);
  return typeof value === "string" ? value : "";
}

/** The object's custom-field map, or null where the document predates it. */
export function customFieldsOf(objMap: Y.Map<unknown> | null): Y.Map<Y.Text> | null {
  const fields = objMap?.get(CUSTOM_FIELDS_KEY);
  return fields instanceof Y.Map ? (fields as Y.Map<Y.Text>) : null;
}

function setField(fields: Y.Map<Y.Text>, key: string, value: string): void {
  const held = fields.get(key);
  if (!(held instanceof Y.Text)) {
    fields.set(key, new Y.Text(value));
  } else if (held.toString() !== value) {
    held.delete(0, held.length);
    held.insert(0, value);
  }
}

/**
 * Write the whole blob `raw` onto an object, column by column: a column whose
 * value differs from the base is set, a column the base held and `raw` does
 * not is removed, and every other column is left as the map holds it. An
 * object with no map, or one not yet in a document (which cannot be read),
 * gets a new map holding all of `raw`. Call inside a transaction.
 */
export function applyCustomBlob(objMap: Y.Map<unknown>, raw: string): void {
  const attached = objMap.doc !== null;
  const fields = attached ? customFieldsOf(objMap) : null;
  const next = parseExtraColumns(raw);
  if (fields) writeOverBase(fields, parseExtraColumns(stringAt(objMap, BASE_KEY)), next);
  else objMap.set(CUSTOM_FIELDS_KEY, customMapOf(next));
  for (const key of ["extra_columns", BASE_KEY]) {
    if (!attached || objMap.get(key) !== raw) objMap.set(key, raw);
  }
}

/** The columns of `next` that differ from `base` set, and those `next` dropped removed. */
function writeOverBase(fields: Y.Map<Y.Text>, base: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(next)) {
    if (!(key in base) || cellText(base[key]) !== cellText(next[key])) setField(fields, key, cellText(next[key]));
  }
  for (const key of Object.keys(base)) if (!(key in next)) fields.delete(key);
}

/** A new map holding every column of `blob`. */
function customMapOf(blob: Record<string, unknown>): Y.Map<Y.Text> {
  const created = new Y.Map<Y.Text>();
  for (const key of Object.keys(blob)) created.set(key, new Y.Text(cellText(blob[key])));
  return created;
}

/**
 * Whether the load's repair has work on this object: it has no map yet, or a
 * browser on the previous bundle has written `extra_columns` since the map was
 * last set from it.
 */
export function needsCustomFold(objMap: Y.Map<unknown>): boolean {
  const raw = objMap.get("extra_columns");
  if (typeof raw !== "string") return false;
  return customFieldsOf(objMap) === null || objMap.get(BASE_KEY) !== raw;
}

/** The repair's write for one object: `extra_columns` applied over the base. */
export function foldCustomFields(objMap: Y.Map<unknown>): void {
  applyCustomBlob(objMap, stringAt(objMap, "extra_columns"));
}

/**
 * The blob the snapshot writes for an object. An object with no map writes its
 * `extra_columns` as it stands. One whose map holds what its base holds writes
 * the base itself, byte for byte, so opening a project rewrites no row. Any
 * other is written with its columns in the order the base blobs of the
 * project's objects give (`allBases`, read only here), then any column of its
 * own base they leave out, then the rest by name: never the map's own key
 * order, which differs between copies of the document. A column the base never
 * held and the map holds empty is left out, as the page writes none for a
 * field it only focused.
 */
export function customFieldsBlob(objMap: Y.Map<unknown>, allBases: () => string[]): string {
  const fields = customFieldsOf(objMap);
  if (!fields) {
    const raw = objMap.get("extra_columns");
    return typeof raw === "string" ? raw : "";
  }
  const baseRaw = stringAt(objMap, BASE_KEY);
  const base = parseExtraColumns(baseRaw);
  const values = new Map<string, string>();
  fields.forEach((text, key) => {
    const value = text instanceof Y.Text ? text.toString() : "";
    if (key in base || value !== "") values.set(key, value);
  });
  const baseKeys = Object.keys(base);
  if (baseKeys.length === values.size && baseKeys.every((k) => values.get(k) === cellText(base[k]))) return baseRaw;
  if (values.size === 0) return "";
  const known = [...customColumnOrder([baseRaw, ...allBases()]), ...baseKeys];
  const keys = [...new Set([...known.filter((k) => values.has(k)), ...[...values.keys()].sort()])];
  const blob: Record<string, string> = {};
  for (const k of keys) {
    // `k` is an author's header, so it can be `__proto__`.
    Object.defineProperty(blob, k, { value: values.get(k), writable: true, enumerable: true, configurable: true });
  }
  return JSON.stringify(blob);
}

/** The blob an object's map was last set from, or its `extra_columns` where it has no map yet. */
function baseOf(objMap: unknown): string {
  return objMap instanceof Y.Map ? stringAt(objMap, BASE_KEY) || stringAt(objMap, "extra_columns") : "";
}

/** The base blob each object of `objects` was last set from, for `customFieldsBlob`'s order. */
export function customFieldBases(objects: { toArray(): unknown[] }): string[] {
  return objects.toArray().map(baseOf);
}

/** Each object's map and a custom column any object has that the map has no entry for. */
function customFieldGaps(objects: Y.Map<unknown>[]): Array<[Y.Map<Y.Text>, string]> {
  const columns = customColumnOrder(objects.map(baseOf));
  return objects.flatMap((m) => {
    const fields = customFieldsOf(m);
    return fields ? columns.filter((c) => !fields.has(c)).map((c): [Y.Map<Y.Text>, string] => [fields, c]) : [];
  });
}

/**
 * The server's pass over the objects, at load and before each snapshot reads
 * them: fold in any whole blob a browser on the previous bundle wrote since,
 * then give every object an empty entry for each custom column any object has.
 * A browser never creates an entry, because two creating one key keep only one
 * of them and the other's typing is lost. Each step is one transaction under a
 * null origin, opened only when it has something to write. Returns whether it
 * wrote.
 */
export function settleCustomFields(doc: Y.Doc): boolean {
  const settledObjects = () => doc.getArray("objects").toArray().filter((m): m is Y.Map<unknown> => m instanceof Y.Map);
  const folds = settledObjects().filter(needsCustomFold);
  if (folds.length > 0) doc.transact(() => folds.forEach(foldCustomFields), null);
  const gaps = customFieldGaps(settledObjects());
  if (gaps.length > 0) doc.transact(() => gaps.forEach(([fields, key]) => fields.set(key, new Y.Text(""))), null);
  return folds.length + gaps.length > 0;
}

/**
 * Whether `tr` wrote the `extra_columns` of an object in `objects`, or added
 * an object there: a new object can bring a column, or arrive with no map from
 * a browser on the previous bundle.
 */
export function changesCustomBlob(tr: Y.Transaction, objects: Y.Array<unknown>): boolean {
  for (const [type, keys] of tr.changed) {
    if (type === objects) return true;
    if (type instanceof Y.Map && type.parent === objects && keys.has("extra_columns")) return true;
  }
  return false;
}

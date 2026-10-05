/**
 * The `extra_columns` passthrough blob — collection, parsing, canonicalisation.
 *
 * `extra_columns` is a JSON catch-all carrying whatever custom CSV columns a
 * user's sheet has beyond the schema. objects.csv and glossary.csv both carry
 * one, and every subsystem that reads a blob reads it through this module,
 * or through `extra-columns.ts`, which holds the parts a client module needs
 * and whose exports this module re-exports.
 *
 * Two subsystems must judge "same data" identically for it: the publish entity
 * hash (decides whether a row changed and needs re-emitting) and the sync diff
 * (decides whether a repo-side edit should surface in sync review). If their
 * judgments ever diverge, a semantically unchanged row oscillates between
 * "changed" and "unchanged" across a publish/sync cycle. That is why this lives
 * here as the single shared implementation — never fork a local copy into
 * either consumer.
 *
 * Equivalent data canonicalises identically regardless of stored key order;
 * corrupt or absent blobs collapse to "".
 *
 * @version v1.5.0-beta
 */

import {
  COLUMN_NAME_MAPPING,
  KNOWN_OBJECT_KEYS,
  PROMOTABLE_OBJECT_FIELDS,
  foldHeader,
  pythonStrip,
} from "~/lib/column-mapping";
import { isInstructionColumnName } from "~/lib/extra-columns";

export { hasStoryRowContent, isInstructionColumnName, parseExtraColumns } from "~/lib/extra-columns";

/**
 * Column names Telar's framework build reserves for itself. A row carrying
 * one of these under any of its custom columns is read by the framework's
 * `_refuse_reserved_columns` (scripts/telar/csv_utils.py) as the build's own
 * bookkeeping rather than as content, and the framework refuses to build.
 * Matched the same way the framework matches: case-insensitively,
 * after stripping surrounding whitespace, never as a substring.
 */
export const RESERVED_COLUMN_NAMES = new Set(["_metadata"]);

/** Whether `name` is a reserved column name under the shared header fold. */
export function isReservedColumnName(name: string): boolean {
  return RESERVED_COLUMN_NAMES.has(foldHeader(name));
}

/** A collected extras record as the stored blob: JSON, or undefined when empty. */
export function extrasBlob(extras: Record<string, string>): string | undefined {
  return Object.keys(extras).length > 0 ? JSON.stringify(extras) : undefined;
}

/**
 * A stored blob as an ingest payload carries it: the string, or absent. The
 * wire has no null for this field; `buildStoryYMap` reads absence as none.
 */
export function extrasOnWire(raw: string | null | undefined): string | undefined {
  return raw ?? undefined;
}

/**
 * Reserved keys present in an `extra_columns` JSON blob, returned verbatim
 * (not normalised) so a caller can name the column exactly as the author
 * spelled it. Parses as defensively as `serializeObjectsCsv`'s own safeParse —
 * a corrupt or non-object blob yields no keys, never throws.
 */
export function reservedColumnsIn(rawExtraColumns: string | null | undefined): string[] {
  if (!rawExtraColumns) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawExtraColumns);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.keys(parsed as Record<string, unknown>).filter(isReservedColumnName);
}

/**
 * A row's custom columns: every cell whose column name is not one the mapper
 * consumes first-class. Empty and whitespace-only cells are dropped, matching
 * the framework's extra_metadata collection in generate_collections.py —
 * whitespace under CPython's `str.strip()`, which is the one the framework
 * weighs the same cell with. A cell holding nothing but U+FEFF is content
 * there, so it is a custom value here, and a value the mark edges keeps it.
 *
 * `reserved` names, verbatim (not normalised), every captured column the
 * framework reserves for itself, so a caller can name the column exactly as the
 * author spelled it. Capture is not refusal: a reserved column is kept like any
 * other custom column, and the caller decides whether to warn (import) or block
 * (publish).
 *
 * `instruction` names, the same way, every captured column the framework reads
 * as an instruction rather than as data (see `isInstructionColumnName`). It is
 * populated by definition — a column no cell fills is never captured at all —
 * so a caller has what it needs to warn about exactly the columns whose values
 * the site will never show.
 *
 * Keys come from a user's own CSV header, so `__proto__` is a possible column
 * name: `Object.defineProperty` is what makes the value an own property, where
 * a plain assignment would hit the inherited accessor and lose it.
 */
export function collectExtraColumns(
  row: Record<string, string>,
  knownKeys: ReadonlySet<string>,
): { extras: Record<string, string>; reserved: string[]; instruction: string[] } {
  const extras: Record<string, string> = {};
  const reserved: string[] = [];
  const instruction: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (knownKeys.has(key)) continue;
    const v = pythonStrip(value ?? "");
    if (!v) continue;
    Object.defineProperty(extras, key, { value: v, writable: true, enumerable: true, configurable: true });
    if (isReservedColumnName(key)) reserved.push(key);
    if (isInstructionColumnName(key)) instruction.push(key);
  }
  return { extras, reserved, instruction };
}

/**
 * The union of every custom key across a file's rows, sorted alphabetically, so
 * the emitted column order is deterministic and a rewrite of unchanged data
 * produces an identical file.
 */
export function extraColumnUnion(parsedRows: Array<Record<string, string>>): string[] {
  return [...new Set(parsedRows.flatMap((p) => Object.keys(p)))].sort();
}

/**
 * One CSV data row as a record PapaParse can read no inherited property from.
 *
 * Custom column names come from a user's own sheet, so `constructor` and
 * `__proto__` are possible column names. PapaParse reads each column off the
 * row object by key, so on a plain `{}` a row that simply LACKS that column
 * yields the inherited value — `[object Object]` for `constructor`, the
 * prototype for `__proto__` — and publishes it as the author's data. A
 * null-prototype record has nothing to inherit, so an absent column reads
 * `undefined` and emits an empty cell, which is what a blank cell is.
 */
export function csvDataRow(fields: Record<string, string>): Record<string, string> {
  const row: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(row, key, { value, writable: true, enumerable: true, configurable: true });
  }
  return row;
}

export function canonicalExtraColumns(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return "";
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      // `k` is a custom column name a user's own objects.csv supplied, so it
      // can be `__proto__`: plain `sorted[k] = o[k]` would hit the inherited
      // accessor on Object.prototype instead of creating a property, and the
      // value would vanish from the canonicalised output. defineProperty
      // always defines an own property, whatever the key is.
      Object.defineProperty(sorted, k, { value: o[k], writable: true, enumerable: true, configurable: true });
    }
    return JSON.stringify(sorted);
  } catch {
    return "";
  }
}

/**
 * Every objects header the Compositor models, mapped to the key that field
 * uses in D1 and in the objects Y.Map.
 *
 * Derived from `COLUMN_NAME_MAPPING`, never listed: an entry is here exactly
 * when the header resolves to a name the objects mapper consumes. A spelling
 * added to the mapping is therefore covered without a second edit, which is
 * the whole point — a hand-written copy of this is a copy that goes stale, and
 * a stale entry means that header's cell stays in the passthrough blob and is
 * republished beside its own field as a second column claiming one canonical
 * name.
 *
 * The canonical name and the D1 column differ for two fields; everywhere else
 * they are the same name.
 */
const CANONICAL_TO_D1_COLUMN: Record<string, string> = {
  medium_genre: "object_type",
  iiif_manifest: "source_url",
};

export const MODELLED_OBJECT_EXTRA_ALIASES: Record<string, string> =
  Object.create(null) as Record<string, string>;
for (const [header, canonical] of Object.entries(COLUMN_NAME_MAPPING)) {
  if (!KNOWN_OBJECT_KEYS.has(canonical)) continue;
  MODELLED_OBJECT_EXTRA_ALIASES[header] = CANONICAL_TO_D1_COLUMN[canonical] ?? canonical;
}

/** What `promoteModelledExtras` changed, so a caller can write exactly that. */
export interface PromotedExtras {
  /** The blob with every modelled key removed. */
  extras: Record<string, string>;
  /** First-class key -> value to write. Empty when only removals happened. */
  fields: Record<string, string>;
  /** Extras keys removed, as the author spelled them. */
  removed: string[];
  /** True when anything at all changed, so a healthy blob writes nothing. */
  changed: boolean;
}

/**
 * A blob value as a string, or null when it is not something a CSV cell could
 * have held.
 *
 * A blob is JSON a previous import wrote, but nothing guarantees its shape: a
 * hand-edited repo file or an older writer can leave a number, a boolean, null,
 * an array or an object under a modelled key. A string method called on one
 * throws, and this repair runs before the document is admitted, so the throw
 * would fail the load and every publish snapshot behind it.
 *
 * Numbers and booleans round-trip through a CSV cell as text, so they are kept
 * as text. null, arrays and objects have no cell form: they are dropped with
 * nothing promoted, which is what publish already does with them.
 */
function blobValueAsString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** One blob key that names a modelled field, with its value as a cell. */
interface ModelledCandidate {
  header: string;
  field: string;
  value: string;
}

/**
 * Sorts a blob's keys into the ones this function has a mandate over and the
 * ones it does not.
 *
 * `keep` is the author's own columns, left byte for byte whatever their type.
 * `remove` is a modelled key whose value has no cell form at all — null, an
 * array, an object — so there is nothing to promote and nothing worth keeping.
 *
 * Key order is preserved, and it is meaningful: `mapObjectsCsv` builds the blob
 * by walking the row left to right, so a blob's key order is the sheet's header
 * order.
 */
function classifyExtraKeys(extras: Record<string, unknown>): {
  keep: string[];
  remove: string[];
  candidates: ModelledCandidate[];
} {
  const keep: string[] = [];
  const remove: string[] = [];
  const candidates: ModelledCandidate[] = [];
  for (const header of Object.keys(extras)) {
    const field = MODELLED_OBJECT_EXTRA_ALIASES[foldHeader(header)];
    if (field === undefined) {
      keep.push(header);
      continue;
    }
    const asString = blobValueAsString(extras[header]);
    if (asString === null) remove.push(header);
    else candidates.push({ header, field, value: pythonStrip(asString) });
  }
  return { keep, remove, candidates };
}

/**
 * Lifts a modelled objects field out of an `extra_columns` blob and into the
 * field it belongs to, leaving no modelled key behind.
 *
 * A sheet imported before the header mapping covered a spelling left that
 * column in the passthrough blob, and publish then writes it beside the field's
 * own column — two columns the framework folds onto one canonical name, which
 * the current release refuses to build.
 *
 * The rule, for each field a blob names:
 *
 *   - the field is EMPTY   -> the blob's value fills it; where several
 *                             spellings name one field, the LAST key wins.
 *                             Blob key order is the sheet's header order, so
 *                             that is the same last-position rule the parser
 *                             applies to two columns claiming one name.
 *   - the field is SET     -> the FIELD wins and every spelling is removed,
 *                             whatever they say.
 *
 * Which value the author meant is not knowable from the row: nothing here
 * records where either came from. What is knowable is that the field is the
 * value the Compositor shows and lets them edit, and the blob's value was never
 * visible in it — it has sat in a passthrough column since the import. Choosing
 * the value the author can see over the one they cannot is the least-surprise
 * rule, the file has to carry exactly one column per canonical name to build at
 * all, and the value that goes is one they still have in their spreadsheet.
 *
 * `PROMOTABLE_OBJECT_FIELDS` is narrower than "every modelled field": a
 * non-text column cannot hold a cell (a string written into `featured` is a
 * flag the snapshot then refuses), and `object_id` is identity, never repaired
 * from a passthrough blob. Their keys are removed once the field is populated —
 * a boolean always is — and nothing is written.
 *
 * Known limitation, deliberately not addressed here: the object detail page
 * derives its source display, media classification and viewer URLs from loader
 * data, so on the first visit after a repair that promotes `iiif_manifest` into
 * `source_url` the page still shows the pre-repair state until it is reloaded.
 * One-time, self-healing, and confined to the legacy manifest-only sheets that
 * have such a blob at all.
 *
 * Pure: it reads `current` and returns what to write, touching nothing.
 */
/**
 * What becomes of every blob key naming one field.
 *
 * `promote` is set only where a value may be written; otherwise the keys are
 * either removed or left, and the caller does not need to know which rule
 * decided that.
 */
function resolveFieldGroup(
  field: string,
  group: ModelledCandidate[],
  held: string,
): { promote?: string; remove: string[]; keep: string[] } {
  const headers = group.map((c) => c.header);

  if (!PROMOTABLE_OBJECT_FIELDS.has(field)) {
    // Nothing may be written here. The keys go once the field has a value of
    // its own to stand on; until then they are left rather than discarded.
    return held ? { remove: headers, keep: [] } : { remove: [], keep: headers };
  }
  if (held) return { remove: headers, keep: [] };

  // Last spoken key wins, which is the header order the sheet had.
  const spoken = group.filter((c) => c.value !== "");
  const promote = spoken.length > 0 ? spoken[spoken.length - 1].value : undefined;
  return { promote, remove: headers, keep: [] };
}

export function promoteModelledExtras(
  extras: Record<string, unknown>,
  current: Record<string, string>,
): PromotedExtras {
  const kept: Record<string, string> = {};
  const fields: Record<string, string> = {};
  const removed: string[] = [];

  const keep = (header: string) => {
    Object.defineProperty(kept, header, {
      value: extras[header], writable: true, enumerable: true, configurable: true,
    });
  };

  const { keep: ownColumns, remove, candidates } = classifyExtraKeys(extras);
  ownColumns.forEach(keep);
  removed.push(...remove);

  const byField = new Map<string, ModelledCandidate[]>();
  for (const candidate of candidates) {
    const group = byField.get(candidate.field);
    if (group) group.push(candidate);
    else byField.set(candidate.field, [candidate]);
  }

  for (const [field, group] of byField) {
    const outcome = resolveFieldGroup(field, group, pythonStrip(current[field] ?? ""));
    if (outcome.promote !== undefined) fields[field] = outcome.promote;
    removed.push(...outcome.remove);
    outcome.keep.forEach(keep);
  }

  return { extras: kept, fields, removed, changed: removed.length > 0 };
}

/** Every D1 / Y.Map key a modelled alias can target. */
export const MODELLED_OBJECT_FIELDS: ReadonlySet<string> = new Set(
  Object.values(MODELLED_OBJECT_EXTRA_ALIASES),
);


/**
 * The canonical form of an extras blob with every modelled key removed.
 *
 * For COMPARING two blobs only — never for storing one. After the repair there
 * are no modelled keys on either side: it resolves every one of them at load,
 * and the export guard keeps any survivor out of the published file. This drops
 * them anyway, on both sides, so a blob that reached a comparison without
 * having been through the repair — a document not yet loaded, a hand-edited
 * repo file — cannot fabricate a difference out of a key that was never going
 * to be published. The author's own columns compare exactly as before.
 */
export function comparableExtraColumns(raw: string | null | undefined): string {
  if (!raw) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const own = parsed as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(own).sort()) {
    if (MODELLED_OBJECT_EXTRA_ALIASES[foldHeader(key)] !== undefined) continue;
    Object.defineProperty(sorted, key, {
      value: own[key], writable: true, enumerable: true, configurable: true,
    });
  }
  // No columns left is the same state as no blob at all, and must compare as
  // one: an absent blob yields "" here, so a blob that filtered down to nothing
  // — or one literally stored as "{}" — would otherwise read as a difference
  // against it and report a change nobody made.
  return Object.keys(sorted).length > 0 ? JSON.stringify(sorted) : "";
}

/**
 * Whether an all-or-nothing `/ingest-sync` is held back whole.
 *
 * A sync apply records the commit it applied only when it applied everything
 * it was sent; one that applied part of it keeps its record at the commit it
 * was reviewed against, while D1 holds the applied part from the newer
 * commit, and the next check reads that part as the Compositor's own edit.
 * So a sync apply asks for all or nothing (`allOrNothing`): before anything
 * is written, each object update is checked against the value the check read
 * (`fieldsUnchangedSinceReview`), each row an update, an order entry or a
 * removal names is looked for under its key and D1 id, each new row's key is
 * looked for to be free of a row of the Compositor's own (`keyHeldByOwnRow`), and each story's and
 * page's content against the hash the check recorded, the story or page
 * itself included: one the document no longer holds, or cannot read, is
 * found while the content is planned. Each page insert's slug is looked for
 * to be free of a page of the Compositor's own (`pageInsertsHeldBack`), as an
 * object insert's key is. A page's removal and rename are found
 * the same way, while they are planned (`planPageSlugChanges`): a page edited
 * or moved since the check, a page the rename cannot find, and an address
 * another page holds. What the ingest cannot store at all is
 * found there too: an entry its boundary refused as malformed, and an insert
 * whose row is over D1's row size (`overD1RowSize`). Any of them holds the
 * whole ingest back, in every domain.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { fieldsUnchangedSinceReview } from "./object-seen-fields";
import { ORDER_KEY } from "~/lib/field-order";
import { CUSTOM_FIELD_KEYS, customFieldBases, customFieldsBlob } from "~/lib/object-custom-map";
import type { IngestObjectInsert, IngestPageInsert } from "./collaboration";
import { objectInsertValueOf, objectInsertValues } from "./object-insert-values";

/** An object row an entry names: by key, and by D1 id where it gives one. */
interface NamedRow {
  objectId: string;
  docId?: number;
}

type HeldUpdate = NamedRow & {
  fields?: Partial<Record<string, string | boolean | null>>;
  seen?: Partial<Record<string, string | boolean | null>>;
};

/** What in the object arms holds an all-or-nothing ingest back, by object_id. */
export interface ObjectArmsHeldBack {
  /** Updates with a field changed since the check, or with no value the check read. */
  changedSinceReview: string[];
  /** Updates whose row is held under the key by another D1 id: re-created since the check. */
  supersededUpdates: string[];
  /** Order entries likewise. */
  supersededOrder: string[];
  /** Removals likewise. */
  supersededRemoves: string[];
  /**
   * Inserts whose key a row already holds as an object made in the Compositor
   * since the check: a row with a D1 id, or one with none whose values are not
   * the insert's. A row with no D1 id holding the insert's own values is the
   * same insert awaiting its D1 row, which the ingest's receipt path settles.
   */
  presentInserts: string[];
  /** Inserts whose row D1 would refuse for its size (`overD1RowSize`). */
  oversizedInserts: string[];
}

/**
 * The Y.Map holding `row`'s key, under its D1 id where it names one, or
 * whether another row holds the key instead (`superseded`) or none does.
 */
function namedRowIn(objectsArray: Y.Array<Y.Map<unknown>>, row: NamedRow): Y.Map<unknown> | "superseded" | null {
  const members = objectsArray.toArray().filter((m): m is Y.Map<unknown> => m instanceof Y.Map);
  const byKey = members.filter((m) => m.get("object_id") === row.objectId);
  if (row.docId === undefined) return byKey[0] ?? null;
  const held = byKey.find((m) => m.get("_id") === row.docId);
  if (held) return held;
  return byKey.length > 0 ? "superseded" : null;
}

/**
 * The keys an insert's Y.Map holds beside the values it writes: its D1 id, its
 * place, and the custom-field map its `extra_columns` is written into, which
 * is compared as the blob the snapshot writes from it.
 */
const INSERT_BOOKKEEPING_KEYS: ReadonlySet<string> = new Set(["_id", ORDER_KEY, ...CUSTOM_FIELD_KEYS]);

/**
 * The insert's value that records who acted, not what the row holds: another
 * convenor's retry of the same insert differs in it alone.
 */
const ATTRIBUTION_FIELD = "created_by";

/** The insert's value a row built before it was carried may lack: its provenance. */
const LATE_FIELD = "origin";

/**
 * Whether `held` holds exactly what `entry` writes (`objectInsertValues`):
 * every value equal but its attribution, and no key of its own beyond the
 * insert's D1 id and place. Only a row the insert itself built, awaiting its
 * D1 row, does. A row built by a version that did not carry the origin holds
 * none; it holds the insert's values all the same, and the receipt path gives
 * it the origin (`carryMissingOrigin`).
 */
function holdsInsertValues(held: Y.Map<unknown>, entry: IngestObjectInsert): boolean {
  const values = objectInsertValues(entry);
  const written = new Set(values.map(([field]) => field));
  return values.every(([field, value]) => field === ATTRIBUTION_FIELD
      || (field === LATE_FIELD && !held.has(field))
      || (field === "extra_columns" ? customFieldsBlob(held, () => []) : objectInsertValueOf(held.get(field))) === value)
    && [...held.keys()].every((key) => written.has(key) || INSERT_BOOKKEEPING_KEYS.has(key));
}

/**
 * Whether a row holds `entry`'s key as an object of the Compositor's own: a
 * row with a D1 id, or one awaiting its D1 row that does not hold exactly
 * what the insert writes (`holdsInsertValues`).
 */
function keyHeldByOwnRow(objectsArray: Y.Array<Y.Map<unknown>>, entry: IngestObjectInsert): boolean {
  return objectsArray.toArray().some((m) => m instanceof Y.Map && m.get("object_id") === entry.object_id
    && (m.get("_id") != null || !holdsInsertValues(m, entry)));
}

/**
 * Gives `held` the origin `entry` carries when it holds none and is the row
 * the insert itself built. Never replaces an origin the row has, and never
 * labels a row made with other values.
 */
export function carryMissingOrigin(held: Y.Map<unknown>, entry: IngestObjectInsert): void {
  if (entry.origin !== undefined && !held.has(LATE_FIELD) && holdsInsertValues(held, entry)) {
    held.set(LATE_FIELD, entry.origin);
  }
}

/**
 * D1's largest row, in bytes, and what of it to leave for the columns an
 * insert binds beyond its payload (project, place, origin, actors, time) and
 * the record's own header.
 */
const D1_ROW_BYTES = 2_000_000;
const D1_ROW_ALLOWANCE = 1_024;

const utf8 = new TextEncoder();

/**
 * Whether D1 would refuse `entry`'s row for its size: the text it writes, as
 * UTF-8, past what a row may hold. Of the ways the INSERT can fail, the one
 * its payload shows; the others (a foreign key whose row went, D1 itself
 * failing) only the write finds.
 */
function overD1RowSize(entry: IngestObjectInsert): boolean {
  let bytes = D1_ROW_ALLOWANCE;
  for (const [, value] of objectInsertValues(entry)) {
    if (typeof value === "string") bytes += utf8.encode(value).length;
  }
  return bytes > D1_ROW_BYTES;
}

/** The keys a page insert's Y.Map holds beside the values it writes. */
const PAGE_INSERT_KEYS: ReadonlySet<string> = new Set(["slug", "title", "body", "frontmatter", ATTRIBUTION_FIELD]);

/** Whether `value` is a Y.Text of exactly `text`, an absent text being empty. */
function holdsText(value: unknown, text: string | null | undefined): boolean {
  return value instanceof Y.Text && value.toString() === (text ?? "");
}

/**
 * Whether `held` holds exactly what `entry` writes (`buildPageYMap`): its
 * title, body, block and attribution, and no key of its own beyond those, its
 * D1 id and its place. Only the page the insert itself built, awaiting its D1
 * row, does. Unlike an object, a page made by an author with the same text is
 * not a retry: the sync's inserts carry no attribution and an import's carry
 * the importer's, so a different `created_by` is a different page.
 */
function holdsPageInsertValues(held: Y.Map<unknown>, entry: IngestPageInsert): boolean {
  return holdsText(held.get("title"), entry.title)
    && holdsText(held.get("body"), entry.body)
    && held.get("frontmatter") === (entry.frontmatter ?? null)
    && (held.get(ATTRIBUTION_FIELD) ?? null) === (entry.created_by ?? null)
    && [...held.keys()].every((key) => PAGE_INSERT_KEYS.has(key) || INSERT_BOOKKEEPING_KEYS.has(key));
}

/**
 * The slugs of the page inserts a page of the Compositor's own already holds:
 * a page with a D1 id, made at that address since the check, or one awaiting
 * its D1 row that does not hold exactly what the insert writes. A page
 * awaiting its row with the insert's own values is the same insert retried,
 * which the ingest's receipt path settles.
 */
export function pageInsertsHeldBack(
  pagesArray: Y.Array<Y.Map<unknown>>,
  inserts: readonly IngestPageInsert[],
): string[] {
  return inserts
    .filter((entry) => pagesArray.toArray().some((m) => m instanceof Y.Map && m.get("slug") === entry.slug
      && (m.get("_id") != null || !holdsPageInsertValues(m, entry))))
    .map((entry) => entry.slug);
}

/** The entries of `rows` whose row another D1 id holds under the key. */
function supersededAmong(objectsArray: Y.Array<Y.Map<unknown>>, rows: readonly NamedRow[]): string[] {
  return rows.filter((row) => namedRowIn(objectsArray, row) === "superseded").map((row) => row.objectId);
}

/** What in the object arms, as the document holds them now, holds the ingest back. */
export function objectArmsHeldBack(
  objectsArray: Y.Array<Y.Map<unknown>>,
  arms: {
    update: readonly HeldUpdate[];
    order: readonly NamedRow[];
    remove: ReadonlyArray<string | NamedRow>;
    insert: readonly IngestObjectInsert[];
  },
): ObjectArmsHeldBack {
  const changedSinceReview: string[] = [];
  const blob = (m: Y.Map<unknown>) => customFieldsBlob(m, () => customFieldBases(objectsArray));
  for (const upd of arms.update) {
    const row = namedRowIn(objectsArray, upd);
    if (row instanceof Y.Map && fieldsUnchangedSinceReview(row, upd, blob).changed) changedSinceReview.push(upd.objectId);
  }
  const removals = arms.remove.flatMap((entry) => (typeof entry === "string" ? [] : [entry]));
  return {
    changedSinceReview,
    supersededUpdates: supersededAmong(objectsArray, arms.update),
    supersededOrder: supersededAmong(objectsArray, arms.order),
    supersededRemoves: supersededAmong(objectsArray, removals),
    presentInserts: arms.insert
      .filter((entry) => keyHeldByOwnRow(objectsArray, entry))
      .map((entry) => entry.object_id),
    oversizedInserts: arms.insert.filter(overD1RowSize).map((entry) => entry.object_id),
  };
}

/**
 * Whether the ingest is held back: anything in the object arms
 * (`objectArmsHeldBack`), a story's or page's content, or a page's removal
 * or rename, that cannot be applied as planned (`contentHeld`: each such
 * outcome's `changedSinceReview` and `failed`, filled as it was planned), a
 * page insert whose slug a page of the Compositor's own holds
 * (`contentHeld.pageInsert`, from `pageInsertsHeldBack`), or
 * an entry the boundary refused as malformed (`refused`, by arm).
 */
export function ingestHeldBack(
  objects: ObjectArmsHeldBack,
  contentHeld: { story: readonly unknown[]; page: readonly unknown[]; pageInsert: readonly string[] },
  refused: Readonly<Record<string, readonly number[]>>,
): boolean {
  return Object.values(objects).some((ids: string[]) => ids.length > 0)
    || contentHeld.story.length > 0
    || contentHeld.page.length > 0
    || contentHeld.pageInsert.length > 0
    || Object.values(refused).some((positions) => positions.length > 0);
}

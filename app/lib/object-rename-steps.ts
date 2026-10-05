/**
 * Which step values an object's rename rewrites, and whether the rename sits
 * inside a collision.
 *
 * A rename is inside a collision when another row's id is read by the site as
 * the same object (`sharedSiteIds`): `map` beside `map.jpg`. One id written
 * in several rows is one object, not a collision. The question is asked of
 * both orders the object rows are known in, objects.csv at the head in file
 * order and D1's rows in sheet order, and either answering yes counts.
 *
 * Outside a collision, a step value is rewritten when the site shows the
 * object for it, under either order (`stepObjectResolver`). Inside one, the
 * site may show the other row for the very values that name this one, so only
 * values whose trimmed form is exactly the old id are rewritten, and every
 * other step keeps the object the site already showed for it.
 *
 * @version v1.5.0-beta
 */

import { pythonStrip } from "~/lib/python-whitespace";
import { sharedSiteIds, stepObjectResolver } from "~/lib/object-id";

/** Object rows in one order, by the id each carries as written. */
type ObjectRows = ReadonlyArray<{ object_id: string }>;

/** The two orders a rename reads the object rows in, and the site version both are read under. */
export interface RenameObjectRows {
  /** objects.csv's rows at the head, in file order. */
  sheet: ObjectRows;
  /** D1's rows, in `compareSheetOrder` order. */
  d1: ObjectRows;
  version: string | null | undefined;
}

/** True when another row shares `oldId`'s site id in either order. */
export function renameInsideCollision(oldId: string, rows: RenameObjectRows): boolean {
  return [rows.sheet, rows.d1].some(
    (order) => (sharedSiteIds(order, rows.version).get(oldId)?.others.length ?? 0) > 0,
  );
}

/**
 * The raw step values the rename rewrites, from `candidates` (every story
 * CSV's raw `object` cells at the head and every D1 step's `object_id`), each
 * once, in the order first met.
 */
export function renameStepValues(
  oldId: string,
  candidates: Iterable<string | null | undefined>,
  rows: RenameObjectRows,
): string[] {
  const inside = renameInsideCollision(oldId, rows);
  const resolvers = [rows.sheet, rows.d1].map((order) => stepObjectResolver(order, rows.version));
  const isRenamed = (value: string) =>
    inside ? pythonStrip(value) === oldId : resolvers.some((resolve) => resolve(value)?.object_id === oldId);

  const values = new Set<string>();
  for (const value of candidates) {
    if (value && !values.has(value) && isRenamed(value)) values.add(value);
  }
  return [...values];
}

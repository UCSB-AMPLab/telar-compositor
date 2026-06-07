/**
 * This file holds the objects-table `?q=` filter predicate. It decides
 * whether a single object matches a free-text query by a case-insensitive
 * substring match against ANY of its title, creator, year (compared as a
 * string), or object_id. An empty query matches every object (no filtering).
 *
 * Object fields are nullable (all but object_id, which is always present); the
 * predicate guards them with `?? ""` so a null field never throws. `year` is
 * text in the data model — it is compared as a lowercased string, never
 * numeric-parsed.
 *
 * Pure function, no React or component state — the objects route calls it per
 * object to drive the filtered list.
 *
 * Exports:
 *   - `matchesObjectFilter({ title, creator, year, object_id }, q)` — the predicate
 *   - `FilterableObject` — the minimal shape the predicate reads
 *
 * @version v1.3.0-beta
 */

export interface FilterableObject {
  title: string | null;
  creator: string | null;
  year: string | null;
  object_id: string;
}

/**
 * matchesObjectFilter — case-insensitive substring match on title OR creator
 * OR year (as a string) OR object_id. An empty (or whitespace-only) query
 * matches every object. Null fields are coalesced to "" so they never throw.
 */
export function matchesObjectFilter(object: FilterableObject, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (query === "") return true;
  return (
    (object.title ?? "").toLowerCase().includes(query) ||
    (object.creator ?? "").toLowerCase().includes(query) ||
    (object.year ?? "").toLowerCase().includes(query) ||
    object.object_id.toLowerCase().includes(query)
  );
}

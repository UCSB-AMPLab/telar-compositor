/**
 * This file holds the glossary `?q=` filter predicate. It
 * decides whether a single term matches a free-text query by a
 * case-insensitive substring match against EITHER the term's title OR its
 * definition body. An empty query matches every term (no filtering).
 *
 * Pure function, no React or component state — the glossary route
 * calls it per term to drive the filtered list.
 *
 * Exports:
 *   - `matchesTermFilter({ title, definition }, q)` — the substring predicate
 *
 * @version v1.3.0-beta
 */

export interface FilterableTerm {
  title: string;
  definition: string;
}

/**
 * matchesTermFilter — case-insensitive substring match on title OR definition.
 * An empty (or whitespace-only) query matches every term.
 */
export function matchesTermFilter(term: FilterableTerm, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (query === "") return true;
  return (
    term.title.toLowerCase().includes(query) ||
    term.definition.toLowerCase().includes(query)
  );
}

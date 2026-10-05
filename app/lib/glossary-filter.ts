/**
 * This file holds the glossary list's predicates. The `?q=` filter
 * decides whether a single term matches a free-text query by a
 * case-insensitive substring match against EITHER the term's title OR its
 * definition body. An empty query matches every term (no filtering).
 *
 * Pure functions, no React or component state — the glossary route
 * calls them per term to drive the list.
 *
 * Exports:
 *   - `matchesTermFilter({ title, definition }, q)` — the substring predicate
 *   - `listsTerm(termId)` — whether the list shows a term at all
 *
 * @version v1.5.0-beta
 */

import { isHeldTermId } from "~/lib/csv-records";

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

/**
 * Whether the glossary list and editor show a term whose document `term_id` is
 * `termId`. A term whose id publishes none (`isHeldTermId`) is never on the
 * site, and the next sync removes it; the editor cannot give a term such an id.
 */
export function listsTerm(termId: unknown): boolean {
  return !(typeof termId === "string" && isHeldTermId(termId));
}

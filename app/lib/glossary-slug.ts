/**
 * This file holds the glossary term_id slug-lock state machine and the
 * uniqueness guard. It is the single place that decides whether a term's
 * `term_id` still auto-tracks its title (UNLOCKED) or has been hand-edited
 * away from it (LOCKED), and that dedupes a candidate term_id against the
 * existing set.
 *
 * Slug-lock model: a `term_id` equal to `slugifyTermId(title)` is still
 * AUTO — the slug follows the title as the user types. The moment the user
 * hand-edits `term_id` so it diverges from `slugifyTermId(title)`, the slug
 * is LOCKED and stops tracking the title.
 *
 * All slug normalisation and collision-dedupe logic is reused from
 * `~/lib/slug` rather than re-implemented here; this module does NOT define
 * its own slug rules. Pure functions only — no React, no component state.
 *
 * Exports:
 *   - `isSlugLocked(termId, title)` — true once term_id diverges from the
 *     title-derived slug
 *   - `effectiveSlug(termId, title, locked)` — title-derived slug when
 *     unlocked, the hand-edited term_id when locked
 *   - `makeUniqueTermId(candidate, existing)` — uniqueness guard via
 *     makeUniqueSlug semantics (`-2`, `-3`, …)
 *
 * @version v1.3.0-beta
 */

import { slugifyTermId, makeUniqueSlug } from "~/lib/slug";

/**
 * isSlugLocked — true when the term_id has been hand-edited away from the
 * slug derived from the title. When term_id === slugifyTermId(title) the slug
 * is still auto (unlocked).
 *
 * A collision-deduped auto-slug stays UNLOCKED: when two terms slugify to the
 * same base, the second is written as `base-2`, `base-3`, … by
 * makeUniqueTermId. That dedupe is automatic, not a hand-edit, so a term_id
 * that equals the title-derived base OR a numeric-suffixed variant of it is
 * still tracking the title. Without this, the first collision would silently
 * flip the term to LOCKED and halt title-tracking.
 */
export function isSlugLocked(termId: string, title: string): boolean {
  const base = slugifyTermId(title);
  if (termId === base) return false;
  // Accept `base-2`, `base-3`, … as an auto-slug that merely got deduped.
  if (base !== "" && new RegExp(`^${escapeRegExp(base)}-\\d+$`).test(termId)) {
    return false;
  }
  return true;
}

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * effectiveSlug — the term_id that should actually apply given the lock state.
 * When unlocked, the slug tracks the (re-derived) title; when locked, the
 * hand-edited term_id is preserved verbatim.
 */
export function effectiveSlug(
  termId: string,
  title: string,
  locked: boolean,
): string {
  return locked ? termId : slugifyTermId(title);
}

/**
 * makeUniqueTermId — normalise a candidate term_id and dedupe it against the
 * existing set, appending `-2`, `-3`, … on collision via makeUniqueSlug
 * semantics.
 */
export function makeUniqueTermId(
  candidate: string,
  existing: readonly string[],
): string {
  const base = slugifyTermId(candidate);
  return makeUniqueSlug(base, new Set(existing)).slug;
}

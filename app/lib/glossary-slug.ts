/**
 * This file holds the rules for a glossary term's ID. `makeUniqueTermId`
 * normalizes a candidate term_id and dedupes it against the existing set,
 * appending `-2`, `-3`, … on a collision as `makeUniqueSlug` does.
 * `filterTermId` is what an ID field keeps of typed text, and the term ID
 * field and the glossary kinds dialog both read it. A term's ID follows its
 * title only while the term is new, which the glossary route decides; this
 * module does not.
 *
 * All slug normalisation and collision-dedupe logic is reused from
 * `~/lib/slug` rather than re-implemented here; this module does NOT define
 * its own slug rules. Pure functions only — no React, no component state.
 *
 * @version v1.5.5-beta
 */

import { slugifyTermId, makeUniqueSlug } from "~/lib/slug";

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

/**
 * What an ID field keeps of typed text: accents stripped, letters lower-cased,
 * a space typed as a hyphen, anything outside `[a-z0-9-]` dropped. A leading,
 * trailing or doubled hyphen is left for the caller to settle.
 */
export function filterTermId(raw: string): string {
  return raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

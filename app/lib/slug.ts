/**
 * This file holds the slug utilities — normalisation and uniqueness for
 * page slugs and glossary term IDs. Anywhere user-entered titles need to
 * become URL-safe identifiers, the path goes through here.
 *
 * Exports:
 *   - `normaliseSlug(input)` — normalise a string to a URL-safe slug
 *     `[a-z0-9-]`
 *   - `makeUniqueSlug(base, existingSlugs, selfSlug?)` — collision-safe
 *     slug, appending `-2`, `-3`, etc. as needed
 *   - `slugifyTermId(title)` — normalise a glossary term title to a
 *     `term_id`
 *   - `isTemporaryPageSlug(slug)` — true for the `untitled` /
 *     `untitled-N` placeholder slug assigned by `addPage` to dodge
 *     `UNIQUE(project_id, slug)`. Used by the deferred-slug effect to
 *     detect when a placeholder slug should be replaced with one
 *     derived from the page title.
 *
 * @version v1.2.0-beta
 */

/** Normalise a string to a URL-safe slug: lowercase, [a-z0-9-] only. */
export function normaliseSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Generate a unique slug by appending -2, -3, etc. if the base slug collides
 * with existing slugs. Excludes `selfSlug` from the collision set (for editing
 * a page's own slug without colliding with itself).
 */
export function makeUniqueSlug(
  base: string,
  existingSlugs: Set<string>,
  selfSlug?: string,
): { slug: string; wasAdjusted: boolean } {
  const candidates = new Set(
    [...existingSlugs].filter((s) => s !== selfSlug),
  );
  if (!base || !candidates.has(base)) return { slug: base || "untitled", wasAdjusted: !base };
  let n = 2;
  while (candidates.has(`${base}-${n}`)) n++;
  return { slug: `${base}-${n}`, wasAdjusted: true };
}

/**
 * Slugify a glossary term title to produce a term_id.
 * Same normalisation as page slugs — lowercase + hyphenated.
 */
export function slugifyTermId(title: string): string {
  return normaliseSlug(title);
}

/**
 * Detect a placeholder slug assigned by `addPage` (`untitled` or `untitled-N`).
 *
 * `addPage` in `app/hooks/use-structural-ops.ts` sets a temporary slug at
 * creation to satisfy the `UNIQUE(project_id, slug)` constraint when multiple
 * pages exist with empty titles. This helper lets the deferred-slug effect
 * recognise such placeholders and replace them with a title-derived slug as
 * soon as the user types a title — restoring the auto-slug-from-title UX
 * that was broken by commit f839a91 (2026-04-15).
 */
export function isTemporaryPageSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return slug === "untitled" || /^untitled-\d+$/.test(slug);
}

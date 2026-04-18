/**
 * Slug utilities — normalisation and uniqueness for page slugs and term IDs.
 *
 * Exports:
 *   normaliseSlug(input) — normalise string to URL-safe slug [a-z0-9-]
 *   makeUniqueSlug(base, existingSlugs, selfSlug?) — collision-safe slug
 *   slugifyTermId(title) — normalise glossary term title to a term_id
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

/**
 * The addresses a page may not take. The built site already serves the first
 * path segment of the stories, objects and glossary collections (`_config.yml`
 * permalinks, and the objects and glossary index pages) and of the folders the
 * build copies into the site (`assets`, `iiif`, `telar-content`), so a page at
 * `/:name/` on one of them would overwrite or be overwritten by it. The page
 * address field, the address a new page's title produces and the Durable
 * Object's check of a page slug all read this one rule.
 *
 * @version v1.5.5-beta
 */

import { siteAddressOfPage } from "~/lib/jekyll-slug";
import { makeUniqueSlug } from "~/lib/slug";

const SITE_PATHS: ReadonlySet<string> = new Set([
  "stories", "objects", "glossary", "assets", "iiif", "telar-content",
]);

/** True when the address `slug` is served at is one the site already uses. */
export function isReservedPageAddress(slug: string): boolean {
  return SITE_PATHS.has(siteAddressOfPage(slug));
}

/**
 * The slug a page takes from its title: `base` when no page has it and the
 * site does not use it, otherwise the next free one. A reserved base takes the
 * `-page` suffix first (`objects-page`), then `-2`, `-3`, … if that is taken.
 */
export function freePageSlug(base: string, taken: Set<string>): string {
  const start = base !== "" && isReservedPageAddress(base) ? `${base}-page` : base;
  return makeUniqueSlug(start, taken).slug;
}

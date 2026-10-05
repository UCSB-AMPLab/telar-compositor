/**
 * Jekyll's default `slugify`, as the framework's `jekyll_slug`
 * (`scripts/telar/story_pages.py`) reproduces it: a code point that is a mark,
 * a letter or a decimal digit passes through lower-cased on its own; every
 * other run becomes one hyphen; a hyphen at either end is dropped. The case
 * is folded one code point at a time, so a final sigma stays `σ` (`ΟΣ` is
 * `οσ`), which is what Ruby's `downcase` gives Jekyll's `:name` and
 * `:slug`; a whole-string lower-casing would give `ος`.
 *
 * @version v1.5.0-beta
 */

export function jekyllSlug(value: string): string {
  let out = "";
  let previousHyphen = false;
  for (const ch of value) {
    if (/[\p{M}\p{L}\p{Nd}]/u.test(ch)) {
      out += ch.toLowerCase();
      previousHyphen = false;
    } else if (!previousHyphen) {
      out += "-";
      previousHyphen = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

/** The address the site builds a page at: Jekyll's `:name` of its file name. */
export const siteAddressOfPage = jekyllSlug;

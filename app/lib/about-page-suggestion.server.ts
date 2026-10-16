/**
 * The Publish page's invitation to make the template's About page the site's
 * own.
 *
 * Every Telar site starts with an About page that describes Telar and credits
 * its developers as though the page were the site's. While a page still holds
 * the template's text (`isTemplatePage`), the checks say so once, as a
 * suggestion. It never blocks a publish and never needs acknowledging; the
 * first edit to the body stops it, because the hash no longer matches.
 *
 * Only text the site publishes is named. Which file the build serves at a
 * page's address is the framework's rule, read by `reducePageFiles`: a file
 * with `localized_for` and the site's exact `language` is served in place of
 * the page it names, and one in another language is not served at all. The
 * suggestion names the file whose text is served, since that is the page the
 * author edits.
 *
 * @version v1.5.5-beta
 */

import { isTemplatePage } from "~/lib/template-content.server";
import { reducePageFiles } from "~/lib/one-language-pages";
import type { ValidationItem } from "~/lib/publish.server";

/** The page fields the suggestion reads. */
export interface AboutPageRow {
  id: number;
  slug: string;
  title: string;
  body: string | null;
  frontmatter: string | null;
}

/**
 * One `about_page_template` suggestion for each page the site serves with a
 * template About body.
 */
export async function aboutPageSuggestions(
  pages: readonly AboutPageRow[],
  lang: string | null | undefined,
): Promise<ValidationItem[]> {
  const files = pages.map((page) => ({
    name: `${page.slug}.md`,
    frontmatter: page.frontmatter ?? "",
    body: page.body ?? "",
    page,
  }));
  const served = reducePageFiles(files, lang).kept.map((kept) => kept.source.page);
  const flags = await Promise.all(served.map((page) => isTemplatePage(page)));
  return served.filter((_, i) => flags[i]).map((page) => ({
    code: "about_page_template",
    message: "about_page_template",
    entityId: page.slug,
    params: { title: page.title },
  }));
}

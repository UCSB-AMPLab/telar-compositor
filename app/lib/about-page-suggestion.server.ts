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
 * A site whose About page was never imported holds no row for it, and the build
 * still serves the repository's file. Only then are the two files that can be
 * the About page, `about.md` and `acerca.md` in the pages folder, read through
 * the caller's `readFile`, and the same rule is run over them; the
 * suggestion's code is `about_page_template_unimported`. No read is made while
 * the project holds an About or Acerca page, nor while the Compositor has known
 * one (`knownSlugs`: the import's record of page files and the last publish's
 * snapshot), since a page deleted in the Compositor and not yet published is
 * still a file on GitHub. A file that is absent is not there; a read that
 * errors yields no suggestion.
 *
 * @version v1.5.5-beta
 */

import { isTemplatePage, TEMPLATE_PAGE_SLUGS } from "~/lib/template-content.server";
import { reducePageFiles } from "~/lib/one-language-pages";
import { parsePageMarkdown } from "~/lib/import.server";
import { parsePageFilesRecord } from "~/lib/page-files-record";
import type { FileAtRef } from "~/lib/github.server";
import type { ValidationItem } from "~/lib/publish.server";

const PAGES_FOLDER = "telar-content/texts/pages/";

/** The page fields the suggestion reads. */
export interface AboutPageRow {
  id: number;
  slug: string;
  title: string;
  body: string | null;
  frontmatter: string | null;
}

/** What the repository fallback reads, and what rules it out. */
export interface RepoAboutSource {
  /** Page slugs the Compositor has known: those in the import's record and in the last publish snapshot. */
  knownSlugs: readonly string[];
  /** One file of the repository at the head the check read. */
  readFile: (path: string) => Promise<FileAtRef>;
}

/**
 * The slugs the Compositor has known, from the project's record of the page
 * files read at import (`page_files_json`) and the last publish snapshot's
 * pages. Text that does not parse names none.
 */
export function knownPageSlugs(
  pageFilesJson: string | null | undefined,
  publishSnapshot: string | null | undefined,
): string[] {
  const slugs = Object.keys(parsePageFilesRecord(pageFilesJson)?.files ?? {}).map((name) => name.replace(/\.md$/, ""));
  try {
    const pages: unknown = publishSnapshot ? (JSON.parse(publishSnapshot) as { pages?: unknown }).pages : null;
    if (typeof pages === "object" && pages !== null && !Array.isArray(pages)) slugs.push(...Object.keys(pages));
  } catch {
    // A snapshot that is not JSON names no page.
  }
  return slugs;
}

/**
 * One `about_page_template` suggestion for each page the site serves with a
 * template About body, or, when the project holds no About page of its own and
 * `repo` is given, one `about_page_template_unimported` for each
 * template page the repository serves.
 */
export async function aboutPageSuggestions(
  pages: readonly AboutPageRow[],
  lang: string | null | undefined,
  repo?: RepoAboutSource | null,
): Promise<ValidationItem[]> {
  const held = pages.some((page) => TEMPLATE_PAGE_SLUGS.includes(page.slug.trim().toLowerCase()));
  if (!held) return repo ? unimportedSuggestions(repo, lang) : [];
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

async function unimportedSuggestions(
  repo: RepoAboutSource,
  lang: string | null | undefined,
): Promise<ValidationItem[]> {
  if (repo.knownSlugs.some((slug) => TEMPLATE_PAGE_SLUGS.includes(slug.trim().toLowerCase()))) return [];
  const reads = await Promise.all(
    TEMPLATE_PAGE_SLUGS.map(async (slug) => {
      try {
        return { slug, read: await repo.readFile(`${PAGES_FOLDER}${slug}.md`) };
      } catch {
        return { slug, read: { status: "error" } as const };
      }
    }),
  );
  if (reads.some(({ read }) => read.status === "error")) return [];
  const scanned = reads.flatMap(({ slug, read }) =>
    read.status === "ok" ? [{ slug, ...parsePageMarkdown(read.content, slug) }] : [],
  );
  const served = reducePageFiles(
    scanned.map((page) => ({ ...page, name: `${page.slug}.md` })),
    lang,
  ).kept.map((kept) => kept.source);
  const flags = await Promise.all(served.map((page) => isTemplatePage(page)));
  return served.filter((_, i) => flags[i]).map((page) => ({
    code: "about_page_template_unimported",
    message: "about_page_template_unimported",
    entityId: page.slug,
    params: { title: page.title },
  }));
}

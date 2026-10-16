/**
 * What the publish page and its action share about a page held in more than
 * one language: how each version is named, and the form field the kept
 * versions travel in. Reading and applying the choice is in
 * `page-language-choice.server.ts`.
 *
 * @version v1.5.5-beta
 */

/** The form field a publish names the kept versions in: a JSON list of file names. */
export const KEEP_PAGE_FILES = "keepPageFiles";

/** One version of a page, as the publish page names it. */
export interface PageLanguageVersion {
  pageId: number;
  /** Its file in the pages folder. */
  file: string;
  title: string;
}

/** A page held in more than one language: its own version, and the others in name order. */
export interface PageLanguageGroup {
  page: PageLanguageVersion;
  others: PageLanguageVersion[];
}

/** The kept file of each group, by its page's file; a group with none chosen is left out. */
export type PageLanguageChoices = Record<string, string>;

/** Whether every group has one of its own versions chosen. */
export function everyPageLanguageChosen(groups: readonly PageLanguageGroup[], choices: PageLanguageChoices): boolean {
  return groups.every((g) => [g.page, ...g.others].some((v) => v.file === choices[g.page.file]));
}

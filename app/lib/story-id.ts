/**
 * The rule a story ID is held to when an author changes it. A story ID is
 * the story's address on the site and the name of its step CSV, so it takes
 * only the characters the framework accepts in project.csv
 * (`^[a-z0-9\-_]+$`; a row with any other is skipped,
 * scripts/telar/processors/project.py), is no other story's, and is not the
 * name of a sheet the site reads as its project, objects or glossary, which a
 * story's CSV would overwrite.
 *
 * @version v1.5.0-beta
 */

import { makeUniqueSlug } from "~/lib/slug";
import { slugify } from "~/lib/slugify";

const FRAMEWORK_STORY_ID = /^[a-z0-9_-]+$/;

export const SITE_SHEET_NAMES: ReadonlySet<string> = new Set([
  "project", "proyecto", "objects", "objetos", "glossary", "glosario",
]);

export type StoryIdProblem = { code: "invalid" | "taken" | "reserved" | "unchanged" };

/** Why `id` can never be a story's ID, whatever the other stories are called; null when it can. */
export function storyIdRefusal(id: string): "invalid" | "reserved" | null {
  if (!FRAMEWORK_STORY_ID.test(id)) return "invalid";
  return SITE_SHEET_NAMES.has(id) ? "reserved" : null;
}

/** Why `candidate` cannot replace `currentId`, or null when it can. */
export function storyIdProblem(
  candidate: string,
  currentId: string,
  storyIds: readonly string[],
): StoryIdProblem | null {
  if (candidate === currentId) return { code: "unchanged" };
  const refusal = storyIdRefusal(candidate);
  if (refusal) return { code: refusal };
  if (storyIds.includes(candidate)) return { code: "taken" };
  return null;
}

/**
 * The ID a new story takes from its title: the title's slug, numbered past
 * the IDs already in use and past the sheet names, so it is never the name of
 * a sheet the story's CSV would overwrite.
 */
export function newStoryId(title: string, storyIds: Iterable<string>): string {
  const taken = new Set([...storyIds, ...SITE_SHEET_NAMES]);
  return makeUniqueSlug(slugify(title) || "story", taken).slug;
}

/**
 * The word count shown under a layer panel's editor. A step's answer is
 * measured otherwise, against the framework's budget (`~/lib/answer-budget`).
 *
 * @version v1.5.0-beta
 */

/** Words in `text`, split on JavaScript's whitespace. Whitespace-only input is 0. */
export function computeWordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

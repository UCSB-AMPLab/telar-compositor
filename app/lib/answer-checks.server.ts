/**
 * What the checks have to say about step answers, read off each answer as the
 * build renders it (`renderAnswer`). Publish runs it over the editor's steps;
 * the upgrade to 1.8.0 runs it over the site's sheets as the commit leaves
 * them, so both name the same answers in the same words (publish.json's
 * `checks.step_answer_*`).
 *
 * @version v1.5.0-beta
 */

import "~/lib/html-unescape.server";
import { ANSWER_FORMAT_KINDS, ANSWER_REMOVED_KINDS, renderAnswer, type GlossaryContext } from "~/lib/answer-preview";
import { ANSWER_BUDGET, BREAK_LINES, LINE_CHARS, MAX_PARAGRAPHS } from "~/lib/answer-budget";
import type { ValidationResult } from "~/lib/publish.server";

/** The fields of a step the answer checks read. */
export interface AnswerStep {
  id: number | string;
  /** The step as a message names it: the editor's number, or a sheet's `step` cell. */
  step_number: number | string;
  answer: string | null;
  story_id?: string | null;
  story_title?: string | null;
}

/**
 * The name a step's blocker calls its story by: its title, falling back to its
 * story_id, because a step number alone identifies nothing on a site with
 * several stories. An untitled story is separately blocked by story_no_title,
 * so the fallback is only ever read on a draft.
 */
export function storyNameOf(step: Pick<AnswerStep, "story_id" | "story_title">): string {
  return step.story_title?.trim() || step.story_id || "";
}

/**
 * Everything the checks have to say about each step's answer, glossary links
 * included, since a link's text is what its lines count.
 *
 * Past ANSWER_BUDGET or MAX_PARAGRAPHS the answer is a blocker, because the site cuts it. The
 * removed kinds are blockers whatever the length, because the build drops them
 * with their words. The kinds that keep their words and lose their look are
 * one warning; the horizontal rule is among them although the build removes
 * it, since it carries no words.
 */
export function answerChecks(steps: readonly AnswerStep[], glossary: GlossaryContext): ValidationResult {
  const blockers: ValidationResult["blockers"] = [];
  const warnings: ValidationResult["warnings"] = [];
  for (const step of steps) {
    const { kinds, measure, cut } = renderAnswer(step.answer ?? "", glossary);
    const named = { number: String(step.step_number), story: storyNameOf(step) };
    const entityId = String(step.id);

    if (cut) {
      blockers.push({
        code: "step_answer_over_limit",
        message: "step_answer_over_limit",
        entityId,
        params: {
          ...named,
          lines: measure.lines,
          count: measure.paragraphs,
          budget: String(ANSWER_BUDGET),
          max_paragraphs: String(MAX_PARAGRAPHS),
          line_chars: String(LINE_CHARS),
          break_lines: String(BREAK_LINES),
        },
      });
    }

    for (const kind of ANSWER_REMOVED_KINDS) {
      const held = kinds[kind];
      if (held === 0) continue;
      blockers.push({
        code: `step_answer_has_${kind}`,
        message: `step_answer_has_${kind}`,
        entityId,
        params: { ...named, count: held },
      });
    }

    const formats = ANSWER_FORMAT_KINDS.filter((kind) => kinds[kind] > 0);
    if (formats.length > 0) {
      warnings.push({
        code: "step_answer_has_formatting",
        message: "step_answer_has_formatting",
        entityId,
        params: { ...named, kinds: formats },
      });
    }
  }
  return { blockers, warnings };
}

/**
 * The steps whose answers the upgraded site publishes differently:
 * one item per step, with what publish's own checks say about its answer and a
 * link to the step in the editor. Shown on the confirmation screen and again
 * on the done screen; it never stops the upgrade.
 *
 * @version v1.5.0-beta
 */
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { checkMessage } from "~/components/features/publish/ValidationChecks";
import type { UpgradeAnswer } from "~/lib/upgrade-answers.server";

/**
 * The editor's address for a step. The editor selects a step by its place in
 * the story, counted from one, so the link carries the place the server found
 * in the editor's order and not the sheet's `step` cell. A step that cannot be
 * identified there links to its story alone; a story the project does not hold
 * has no link.
 */
function stepPath(answer: UpgradeAnswer): string | null {
  if (!answer.storyHeld) return null;
  const story = `/stories/${encodeURIComponent(answer.story)}`;
  return answer.position === null ? story : `${story}?step=${answer.position}`;
}

export function UpgradeAnswerList({ answers, className = "" }: { answers: readonly UpgradeAnswer[]; className?: string }) {
  const { t } = useTranslation("upgrade");
  const { t: tPublish } = useTranslation("publish");
  if (answers.length === 0) return null;
  return (
    <section className={`bg-cream-dark rounded-lg p-4 mb-6 ${className}`} data-testid="upgrade-answer-list">
      <h3 className="font-heading font-semibold text-sm text-charcoal mb-2">{t("answersHeading")}</h3>
      <p className="font-body text-sm text-charcoal mb-2">{t("answersIntro")}</p>
      <ul className="list-disc pl-6 space-y-2">
        {answers.map((answer, index) => (
          <li key={`${answer.story}:${answer.step}:${index}`} className="font-body text-sm text-charcoal">
            {answer.checks.map((check) => (
              <p key={check.code}>{checkMessage(tPublish, check)}</p>
            ))}
            {answer.cellsDropped && <p>{t("answerCellsDropped", { step: answer.step, story: answer.story })}</p>}
            {stepPath(answer) && (
              <Link to={stepPath(answer) as string} className="underline">
                {t("answerEditStep")}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

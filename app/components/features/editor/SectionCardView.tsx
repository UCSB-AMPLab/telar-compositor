/**
 * A section card (`kind='section'`) on the framing stage: the framework's
 * centred card (`.title-card`, built by card-pool.js), with the step's
 * question as its heading and its answer under it, each edited in place. The
 * card frames nothing, so it has no frame, circle or capture.
 *
 * The heading shows as escaped plain text. The answer shows as the build
 * publishes it and is edited as the step card's answer is (`AnswerField`):
 * its field refuses what the step answer's refuses (images, tables, code,
 * footnotes, widgets), in words that fit a card with no layer panel.
 *
 * With a Y.Text a field saves as it is typed; without one, `onSaveField`
 * saves it when the field is finished, through the route's step-field save
 * the step card uses, and a failed save keeps the field open with its draft.
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { InPlaceText } from "~/components/ui/InPlaceText";
import { StageIntroHint } from "~/components/features/editor/TitleCardView";
import { AnswerField, routeSaveFor, type StepTextField } from "~/components/features/editor/StepCard";
import type { GlossaryContext } from "~/lib/card-markdown";
import type { MathDelimiter } from "~/components/ui/markdown-editor/panelMath";

interface SectionCardViewProps {
  step: {
    id: number;
    question: string | null;
    answer: string | null;
  };
  /** The step being edited, as the editor keys a selection. */
  target: string;
  /** The awareness key's stem for the step's fields. */
  fieldKeyPrefix: string;
  questionYText: Y.Text | null;
  answerYText: Y.Text | null;
  /** Saves a field finished without a Y.Text. */
  onSaveField?: (field: StepTextField, value: string) => Promise<unknown>;
  /** Shown under a save that failed. */
  saveErrorMessage?: string;
  /** Where a failed draft of each field is kept across a reload of the tab. */
  recoveryKeys?: { question?: string; answer?: string };
  glossary: GlossaryContext;
  /** The site's formula delimiters; formulas stay as typed without them. */
  delimiters?: MathDelimiter[];
}

export function SectionCardView({
  step,
  target,
  fieldKeyPrefix,
  questionYText,
  answerYText,
  onSaveField,
  saveErrorMessage,
  recoveryKeys = {},
  glossary,
  delimiters,
}: SectionCardViewProps) {
  const { t } = useTranslation("editor");
  const saveFor = routeSaveFor(onSaveField);

  return (
    <div data-testid="section-card" className="title-card">
      <div className="title-card-inner">
        <h2 className="title-card-heading">
          <InPlaceText
            target={`${target}:question`}
            yText={questionYText}
            initialValue={step.question ?? ""}
            placeholder={t("section_card.heading_label")}
            label={t("section_card.heading_label")}
            fieldKey={`${fieldKeyPrefix}-section-heading`}
            onSave={saveFor(questionYText, "question")}
            saveErrorMessage={saveErrorMessage}
            recoveryKey={recoveryKeys.question}
          />
        </h2>
        <div className="title-card-body group/answer">
          <p className="hidden group-has-[textarea]/answer:block font-body text-xs uppercase tracking-wider text-anil-ink mb-1">
            {t("stage.answer_field_label")}
          </p>
          <AnswerField
            target={`${target}:answer`}
            yText={answerYText}
            initialValue={step.answer ?? ""}
            placeholder={t("section_card.subtitle_label")}
            label={t("section_card.subtitle_label")}
            fieldKey={`${fieldKeyPrefix}-section-subtitle`}
            onSave={saveFor(answerYText, "answer")}
            saveErrorMessage={saveErrorMessage}
            recoveryKey={recoveryKeys.answer}
            glossary={glossary}
            delimiters={delimiters}
            textOnlyMessageKey="section_card.subtitle_text_only"
          />
          <p className="hidden group-has-[textarea]/answer:block font-body text-xs text-gray-500 mt-1">
            {t("stage.answer_field_hint")}
          </p>
        </div>
        <StageIntroHint text={t("stage.edit_hint")} />
      </div>
    </div>
  );
}

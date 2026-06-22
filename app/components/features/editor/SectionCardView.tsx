/**
 * This file renders the editor panel for a section-card step
 * (`kind='section'`) — a heading-only preview with a centred large
 * editable heading input bound to the step's `question` Y.Text. No
 * IIIF viewer, no narrative column, no layers/panels — section
 * cards are chapter breaks in published stories.
 *
 * Mirrors `TitleCardView`'s centred-card chrome so authors get a
 * consistent editor shape across the two heading-only step types.
 *
 * @version v1.3.7-beta
 */

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { PencilLine } from "lucide-react";
import * as Y from "yjs";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";

interface SectionCardViewProps {
  step: {
    id: number;
    step_number: number;
    question: string | null;
    answer: string | null;
  };
  storyId: string;
  questionYText: Y.Text | null;
  answerYText: Y.Text | null;
}

export function SectionCardView({ step, storyId, questionYText, answerYText }: SectionCardViewProps) {
  const { t } = useTranslation("editor");
  const headingRef = useRef<HTMLDivElement>(null);
  const subtitleRef = useRef<HTMLDivElement>(null);

  function focusHeading() {
    const el = headingRef.current?.querySelector("input, textarea") as HTMLElement | null;
    el?.focus();
  }

  function focusSubtitle() {
    const el = subtitleRef.current?.querySelector("input, textarea") as HTMLElement | null;
    el?.focus();
  }

  return (
    <div className="px-8 py-12 flex flex-col items-center justify-center min-h-full">
      <div className="w-full max-w-lg rounded-lg bg-white px-6 py-8 shadow-sm border border-gray-100 space-y-4">
        <div>
          <span className="font-body text-xs font-medium text-gray-500 uppercase tracking-wider">
            {t("section_card.heading_label")}
          </span>
          <div className="group/field relative" ref={headingRef}>
            <button
              type="button"
              onClick={focusHeading}
              className="absolute top-0 right-0 flex items-center gap-1 cursor-pointer"
              aria-label={t("step.click_to_edit")}
            >
              <span className="font-body text-xs text-gray-400 opacity-0 group-hover/field:opacity-100 pointer-coarse:opacity-100 transition-opacity">
                {t("step.click_to_edit")}
              </span>
              <PencilLine className="w-3.5 h-3.5 text-gray-300 group-hover/field:text-charcoal transition-colors" />
            </button>
            <InlineTextField
              initialValue={step.question ?? ""}
              yText={questionYText}
              placeholder=""
              inputClassName="font-heading text-3xl font-semibold text-charcoal"
              fieldKey={`step-${step.id}-section-heading`}
            />
          </div>
        </div>

        <div>
          <span className="font-body text-xs font-medium text-gray-500 uppercase tracking-wider">
            {t("section_card.subtitle_label")}
          </span>
          <div className="group/field relative" ref={subtitleRef}>
            <button
              type="button"
              onClick={focusSubtitle}
              className="absolute top-0 right-0 flex items-center gap-1 cursor-pointer"
              aria-label={t("step.click_to_edit")}
            >
              <span className="font-body text-xs text-gray-400 opacity-0 group-hover/field:opacity-100 pointer-coarse:opacity-100 transition-opacity">
                {t("step.click_to_edit")}
              </span>
              <PencilLine className="w-3.5 h-3.5 text-gray-300 group-hover/field:text-charcoal transition-colors" />
            </button>
            <InlineTextArea
              initialValue={step.answer ?? ""}
              yText={answerYText}
              placeholder=""
              inputClassName="font-body text-base text-charcoal"
              rows={2}
              fieldKey={`step-${step.id}-section-subtitle`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

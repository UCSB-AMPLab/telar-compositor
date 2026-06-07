/**
 * This file renders the editor panel for step 0 of a story — the
 * title card. Where the author edits the headline, subtitle, and
 * byline that appear above the first scrolling step.
 *
 * Renders inline-editable title, subtitle, and byline fields that
 * write directly to Yjs Y.Text instances via `InlineTextField`.
 * Falls back to `initialValue` (from D1 SSR render) when `yText` is
 * null (pre-connection).
 *
 * Each field has a pencil icon that darkens on hover with a "Click
 * to edit" affordance.
 *
 * @version v1.3.0-beta
 */

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { PencilLine } from "lucide-react";
import * as Y from "yjs";
import { InlineTextField } from "~/components/ui/InlineTextField";

interface TitleCardViewProps {
  story: {
    id: number;
    title: string | null;
    subtitle: string | null;
    byline: string | null;
    order: number | null;
    show_sections: boolean;
  };
  storyId: string;
  titleYText: Y.Text | null;
  subtitleYText: Y.Text | null;
  bylineYText: Y.Text | null;
  /** Number of kind='section' steps in this story — controls helper-text visibility */
  sectionCardCount: number;
  /** Called immediately on toggle; writes to the story Y.Map.show_sections boolean */
  onToggleShowSections: (value: boolean) => void;
}

/**
 * ShowSectionsSwitch — slimmer inline variant of ToggleField sized for the
 * centred max-w-lg title card chrome. Reuses the same role="switch" /
 * aria-checked semantics as ToggleField.
 */
function ShowSectionsSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
        checked ? "bg-anil" : "bg-gray-200"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transform transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function EditableField({
  children,
  containerRef,
  label,
}: {
  children: React.ReactNode;
  containerRef: React.RefObject<HTMLDivElement | null>;
  label: string;
}) {
  function focusField() {
    const el = containerRef.current?.querySelector("input, textarea") as HTMLElement | null;
    el?.focus();
  }

  return (
    <div className="group/field relative" ref={containerRef}>
      <button
        type="button"
        onClick={focusField}
        className="absolute top-0 right-0 flex items-center gap-1 cursor-pointer"
      >
        <span className="font-body text-xs text-gray-400 opacity-0 group-hover/field:opacity-100 transition-opacity">
          {label}
        </span>
        <PencilLine className="w-3.5 h-3.5 text-gray-300 group-hover/field:text-charcoal transition-colors" />
      </button>
      {children}
    </div>
  );
}

export function TitleCardView({
  story,
  storyId,
  titleYText,
  subtitleYText,
  bylineYText,
  sectionCardCount,
  onToggleShowSections,
}: TitleCardViewProps) {
  const { t } = useTranslation("editor");
  const titleRef = useRef<HTMLDivElement>(null);
  const subtitleRef = useRef<HTMLDivElement>(null);
  const bylineRef = useRef<HTMLDivElement>(null);

  return (
    <div className="px-8 py-12 flex flex-col items-center justify-center min-h-full">
      <div className="w-full max-w-lg rounded-lg bg-white px-6 py-8 shadow-sm border border-gray-100 space-y-6">
        {/* Title */}
        <div>
          {story.order != null && (
            <span className="block font-heading text-sm font-semibold text-gray-400 mb-6">
              {t("title_card.story_number", { number: story.order + 1 })}
            </span>
          )}
          <span className="font-body text-xs font-medium text-gray-500 uppercase tracking-wider">
            {t("title_card.title_label")}
          </span>
          <EditableField containerRef={titleRef} label={t("step.click_to_edit")}>
            <InlineTextField
              initialValue={story.title ?? ""}
              yText={titleYText}
              placeholder={t("title_card.title_placeholder")}
              inputClassName="font-heading text-3xl font-semibold text-charcoal"
              fieldKey={`story-${storyId}-title`}
            />
          </EditableField>
        </div>

        {/* Subtitle */}
        <div>
          <span className="font-body text-xs font-medium text-gray-500 uppercase tracking-wider">
            {t("title_card.subtitle_label")}
          </span>
          <EditableField containerRef={subtitleRef} label={t("step.click_to_edit")}>
            <InlineTextField
              initialValue={story.subtitle ?? ""}
              yText={subtitleYText}
              placeholder={t("title_card.subtitle_placeholder")}
              inputClassName="font-body text-lg text-gray-600"
              fieldKey={`story-${storyId}-subtitle`}
            />
          </EditableField>
        </div>

        {/* Byline */}
        <div>
          <span className="font-body text-xs font-medium text-gray-500 uppercase tracking-wider">
            {t("title_card.byline_label")}
          </span>
          <EditableField containerRef={bylineRef} label={t("step.click_to_edit")}>
            <InlineTextField
              initialValue={story.byline ?? ""}
              yText={bylineYText}
              placeholder={t("title_card.byline_placeholder")}
              inputClassName="font-body text-base text-gray-500"
              fieldKey={`story-${storyId}-byline`}
            />
          </EditableField>
        </div>

        {/* show_sections toggle — inline below byline */}
        <div className="border-t border-gray-100 pt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-body text-sm text-charcoal flex-1">
              {t("title_card.show_sections_label")}
            </span>
            <ShowSectionsSwitch
              checked={story.show_sections}
              onChange={onToggleShowSections}
              ariaLabel={t("title_card.show_sections_label")}
            />
          </div>
          {sectionCardCount === 0 && (
            <p className="font-body text-xs text-gray-400 mt-2">
              {t("title_card.show_sections_empty_helper")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

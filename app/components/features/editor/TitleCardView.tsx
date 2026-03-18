/**
 * TitleCardView — editor panel for step 0 (the title card).
 *
 * Renders inline-editable title, subtitle, and byline fields
 * that autosave to the stories table via the "autosave-story-field" intent.
 * Each field has a pencil icon that darkens on hover with "Click to edit" text.
 */

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { PencilLine } from "lucide-react";
import { InlineTextField } from "~/components/ui/InlineTextField";

interface TitleCardViewProps {
  story: {
    id: number;
    title: string | null;
    subtitle: string | null;
    byline: string | null;
  };
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
        className="absolute -top-5 right-0 flex items-center gap-1 cursor-pointer"
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

export function TitleCardView({ story }: TitleCardViewProps) {
  const { t } = useTranslation("editor");
  const titleRef = useRef<HTMLDivElement>(null);
  const subtitleRef = useRef<HTMLDivElement>(null);
  const bylineRef = useRef<HTMLDivElement>(null);

  return (
    <div className="px-8 py-12 flex flex-col items-center justify-center min-h-full border-l-4 border-lavender">
      <div className="w-full max-w-md space-y-6">
        {/* Title */}
        <EditableField containerRef={titleRef} label={t("step.click_to_edit")}>
          <InlineTextField
            initialValue={story.title ?? ""}
            fieldName="title"
            entityId={story.id}
            intent="autosave-story-field"
            placeholder={t("title_card.title_placeholder")}
            inputClassName="font-heading text-3xl font-semibold text-charcoal"
          />
        </EditableField>

        {/* Subtitle */}
        <EditableField containerRef={subtitleRef} label={t("step.click_to_edit")}>
          <InlineTextField
            initialValue={story.subtitle ?? ""}
            fieldName="subtitle"
            entityId={story.id}
            intent="autosave-story-field"
            placeholder={t("title_card.subtitle_placeholder")}
            inputClassName="font-body text-lg text-gray-600"
          />
        </EditableField>

        {/* Byline */}
        <EditableField containerRef={bylineRef} label={t("step.click_to_edit")}>
          <InlineTextField
            initialValue={story.byline ?? ""}
            fieldName="byline"
            entityId={story.id}
            intent="autosave-story-field"
            placeholder={t("title_card.byline_placeholder")}
            inputClassName="font-body text-base text-gray-500"
          />
        </EditableField>
      </div>
    </div>
  );
}

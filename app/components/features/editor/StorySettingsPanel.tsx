/**
 * The story's settings, in a panel on the right of the stage, opened from the
 * button in the editor's bar: the story's ID and whether the title card lists
 * the section titles. At `lg` and above the stage narrows to make room, so the
 * title card stays in view and the switch updates it as it is toggled; below
 * it the panel lies over the stage. Escape closes the panel unless the ID
 * editor inside it takes the key first.
 *
 * @version v1.5.5-beta
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { StoryIdField } from "~/components/features/editor/StoryIdField";
import { ShowSectionsSwitch, type TitleCardData } from "~/components/features/editor/TitleCardView";

type StorySettingsData = Pick<
  TitleCardData,
  "story" | "storyId" | "sectionCardCount" | "onToggleShowSections" | "storyIds" | "canRenameId" | "onRenameId"
>;

export function StorySettingsPanel({
  story,
  storyId,
  sectionCardCount,
  onToggleShowSections,
  storyIds,
  canRenameId,
  onRenameId,
  onClose,
}: StorySettingsData & { onClose: () => void }) {
  const { t } = useTranslation("editor");

  useEffect(() => {
    function closeSettingsOnEscape(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    }
    document.addEventListener("keydown", closeSettingsOnEscape);
    return () => document.removeEventListener("keydown", closeSettingsOnEscape);
  }, [onClose]);

  return (
    <aside
      data-testid="story-settings"
      aria-label={t("story_settings.title")}
      className="absolute inset-y-0 right-0 z-20 lg:static shrink-0 w-[340px] max-w-full flex flex-col bg-cream border-l border-gray-200 shadow-xl lg:shadow-none"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <h2 className="font-heading text-[15px] font-semibold text-charcoal">{t("story_settings.title")}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("story_settings.close")}
          className="inline-flex items-center justify-center w-8 h-8 rounded text-gray-500 hover:text-charcoal hover:bg-black/5 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col gap-5">
          <StoryIdField key={storyId} storyId={storyId} storyIds={storyIds} canRename={canRenameId} onRename={onRenameId} />
          <div>
            <p className="font-body text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
              {t("story_settings.sections_label")}
            </p>
            <div className="flex items-center justify-between gap-3">
              <span className="font-body text-sm text-charcoal">{t("story_settings.sections_help")}</span>
              <ShowSectionsSwitch
                checked={story.show_sections}
                onChange={onToggleShowSections}
                ariaLabel={t("story_settings.sections_label")}
              />
            </div>
            {sectionCardCount === 0 && (
              <p className="font-body text-xs text-gray-400 mt-2">{t("title_card.show_sections_empty_helper")}</p>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

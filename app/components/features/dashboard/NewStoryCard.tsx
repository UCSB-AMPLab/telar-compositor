/**
 * NewStoryCard — inline story creation card with title input.
 *
 * Appears in the story grid when the user clicks "+ New Story".
 * Submits via Enter or the Save button; dismisses via Escape or Cancel.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

interface NewStoryCardProps {
  onSave: (title: string, subtitle: string, byline: string) => void;
  onCancel: () => void;
}

export function NewStoryCard({ onSave, onCancel }: NewStoryCardProps) {
  const { t } = useTranslation("dashboard");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [byline, setByline] = useState("");

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const trimmed = title.trim();
      if (trimmed) onSave(trimmed, subtitle.trim(), byline.trim());
    } else if (e.key === "Escape") {
      onCancel();
    }
  }

  function handleSave() {
    const trimmed = title.trim();
    if (trimmed) onSave(trimmed, subtitle.trim(), byline.trim());
  }

  const isEmpty = title.trim().length === 0;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-lavender p-4 flex flex-col gap-2">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("new_story_placeholder")}
        autoFocus
        className="font-heading font-semibold text-charcoal w-full border-none outline-none bg-transparent placeholder:text-gray-400"
      />
      <input
        type="text"
        value={subtitle}
        onChange={(e) => setSubtitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("new_story_subtitle_placeholder")}
        className="font-body text-sm text-charcoal w-full border-none outline-none bg-transparent placeholder:text-gray-400"
      />
      <input
        type="text"
        value={byline}
        onChange={(e) => setByline(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("new_story_byline_placeholder")}
        className="font-body text-xs text-charcoal w-full border-none outline-none bg-transparent placeholder:text-gray-400"
      />
      <div className="flex items-center gap-2 pt-2 border-t border-gray-100 mt-auto">
        <button
          type="button"
          onClick={handleSave}
          disabled={isEmpty}
          className="flex-1 px-3 py-2 bg-lavender text-charcoal rounded-md font-body font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 text-gray-500 font-body text-sm hover:text-gray-700 transition-colors"
        >
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

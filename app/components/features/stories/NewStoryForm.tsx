/**
 * NewStoryForm — inline story creation form for the Stories list view.
 *
 * Horizontal form row with title (required), subtitle, and byline inputs.
 * Title autofocuses on mount. Submit via Enter key or Save button;
 * dismiss via Escape key or Cancel button.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

interface NewStoryFormProps {
  onSave: (title: string, subtitle: string, byline: string) => void;
  onCancel: () => void;
}

export function NewStoryForm({ onSave, onCancel }: NewStoryFormProps) {
  const { t } = useTranslation("stories");
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
    <div className="bg-white border border-anil rounded-lg px-4 py-3 mb-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("new_story_placeholder")}
          autoFocus
          className="flex-1 font-heading font-semibold text-charcoal border-none outline-none bg-transparent placeholder:text-gray-400"
        />
        <input
          type="text"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("new_story_subtitle_placeholder")}
          className="flex-1 font-body text-sm text-charcoal border-none outline-none bg-transparent placeholder:text-gray-400"
        />
        <input
          type="text"
          value={byline}
          onChange={(e) => setByline(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("new_story_byline_placeholder")}
          className="flex-1 font-body text-xs text-charcoal border-none outline-none bg-transparent placeholder:text-gray-400"
        />
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleSave}
            disabled={isEmpty}
            className="px-3 py-1.5 bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-xs uppercase tracking-wider rounded-full transition-colors disabled:bg-disabled disabled:text-fg-disabled disabled:cursor-not-allowed"
          >
            {t("save")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-gray-500 font-body text-sm hover:text-gray-700 transition-colors"
          >
            {t("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * SlugField — read/edit URL slug preview with normalisation and uniqueness checking.
 *
 * Default (read) state: shows `/slug/` in 12px Roboto Condensed, text-gray-500.
 * A Pencil icon (12px, text-gray-400) appears on hover; clicking it or the URL
 * preview text enters edit mode.
 *
 * Edit state: controlled input with periwinkle border. normaliseSlug runs on every
 * keystroke. Confirms on blur or Enter; cancels on Escape.
 *
 * Auto-suffix alert: when makeUniqueSlug returns wasAdjusted:true, an amber inline
 * banner appears below the field. It dismisses when the user edits further.
 */

import { useState, useRef, useCallback } from "react";
import { Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { normaliseSlug, makeUniqueSlug } from "~/lib/slug";

interface SlugFieldProps {
  slug: string;
  existingSlugs: Set<string>;
  onSlugChange: (newSlug: string) => void;
  className?: string;
}

export function SlugField({
  slug,
  existingSlugs,
  onSlugChange,
  className,
}: SlugFieldProps) {
  const { t } = useTranslation("pages");

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(slug);
  const [isAdjusted, setIsAdjusted] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const enterEditMode = useCallback(() => {
    setEditValue(slug);
    setIsAdjusted(false);
    setIsEditing(true);
    // Focus input on next paint
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [slug]);

  const commitEdit = useCallback(() => {
    const normalised = normaliseSlug(editValue);
    const { slug: finalSlug } = makeUniqueSlug(normalised, existingSlugs, slug);
    onSlugChange(finalSlug);
    setIsEditing(false);
    setIsAdjusted(false);
  }, [editValue, existingSlugs, onSlugChange, slug]);

  const cancelEdit = useCallback(() => {
    setEditValue(slug);
    setIsEditing(false);
    setIsAdjusted(false);
  }, [slug]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    const normalised = normaliseSlug(raw);
    setEditValue(normalised);
    // Check uniqueness as user types
    const { wasAdjusted } = makeUniqueSlug(normalised, existingSlugs, slug);
    setIsAdjusted(wasAdjusted);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  }

  if (!slug && !isEditing) return null;

  if (isEditing) {
    return (
      <div className={className}>
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={commitEdit}
          placeholder={t("slug_placeholder")}
          className="font-body text-sm border border-periwinkle rounded-md px-2 py-1 w-full focus:outline-none"
        />
        {isAdjusted && (
          <div className="mt-1 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-800">
            {t("slug_adjusted")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center gap-1.5 py-[12px] cursor-pointer ${className ?? ""}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={enterEditMode}
    >
      <span className="font-body text-xs text-gray-500">/{slug}/</span>
      <button
        type="button"
        aria-label="Edit URL slug"
        className={`transition-opacity ${isHovered ? "opacity-100" : "opacity-0"}`}
        onClick={(e) => {
          e.stopPropagation();
          enterEditMode();
        }}
      >
        <Pencil className="w-3 h-3 text-gray-400" />
      </button>
    </div>
  );
}

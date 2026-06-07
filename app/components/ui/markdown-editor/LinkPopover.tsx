/**
 * LinkPopover — inline URL input popover for link insertion in the MarkdownEditor.
 *
 * Appears absolutely positioned near the cursor when the user triggers
 * the link toolbar button or presses Cmd+K. Accepts a URL and inserts
 * a markdown link on Enter or button click.
 */

import { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface LinkPopoverProps {
  position: { top: number; left: number };
  selectedText: string;
  onInsert: (url: string) => void;
  onCancel: () => void;
}

export function LinkPopover({ position, selectedText, onInsert, onCancel }: LinkPopoverProps) {
  const { t } = useTranslation("editor");
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Auto-focus the URL input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onCancel();
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onCancel]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && url.trim()) {
      onInsert(url.trim());
    } else if (e.key === "Escape") {
      onCancel();
    }
  }

  return (
    <div
      ref={popoverRef}
      style={{ top: position.top, left: position.left }}
      className="absolute z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-3 w-72"
    >
      {selectedText && (
        <p className="font-body text-xs text-gray-500 mb-2 truncate">
          Link text: <span className="font-medium text-charcoal">{selectedText}</span>
        </p>
      )}
      <input
        ref={inputRef}
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("link_popover.url_placeholder")}
        className="w-full font-body text-sm border border-gray-200 rounded px-2 py-1.5 focus:border-anil mb-2"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="font-body text-sm text-gray-500 hover:text-charcoal px-2 py-1 transition-colors"
        >
          {t("link_popover.cancel")}
        </button>
        <button
          type="button"
          onClick={() => url.trim() && onInsert(url.trim())}
          disabled={!url.trim()}
          className="font-body text-sm bg-terracotta text-cream px-3 py-1 rounded-md hover:bg-terracotta/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {t("link_popover.insert")}
        </button>
      </div>
    </div>
  );
}

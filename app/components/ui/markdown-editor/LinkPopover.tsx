/**
 * LinkPopover — inline URL input popover for link insertion in the MarkdownEditor.
 *
 * Opens under the cursor when the user triggers the link toolbar button or
 * presses Cmd+K, placed from `anchor` in screen pixels through
 * EditorPopover's portal, which calls `onDetach` when the cursor scrolls out
 * of view. Accepts a URL and inserts a markdown link on Enter or button
 * click. The selected text it shows is read back with the entities
 * `authorText` writes decoded.
 *
 * @version v1.5.0-beta
 */

import { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorPopover, type PopoverAnchor } from "./EditorPopover";
import { decodeWrittenEntities } from "./authorText";
import { useOverlayOpen } from "~/hooks/use-overlay-open";

export const LINK_POPOVER_WIDTH = 288;

interface LinkPopoverProps {
  anchor: PopoverAnchor;
  selectedText: string;
  onInsert: (url: string) => void;
  onCancel: () => void;
  /** Called when the cursor has scrolled out of view or its editor is gone. */
  onDetach: () => void;
}

export function LinkPopover({ anchor, selectedText, onInsert, onCancel, onDetach }: LinkPopoverProps) {
  const { t } = useTranslation("editor");
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useOverlayOpen(true);

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
    <EditorPopover
      anchor={anchor}
      width={LINK_POPOVER_WIDTH}
      onDetach={onDetach}
      rootRef={(el) => {
        popoverRef.current = el;
      }}
    >
      {selectedText && (
        <p className="font-body text-xs text-gray-500 mb-2 truncate">
          {t("link_popover.link_text")}<span className="font-medium text-charcoal">{decodeWrittenEntities(selectedText)}</span>
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
    </EditorPopover>
  );
}

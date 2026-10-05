/**
 * HeadingMenu — the Markdown editor toolbar's heading dropdown: a button that
 * opens a menu of heading levels, each applied to the line at the cursor.
 *
 * The menu closes on a press outside it, on a level chosen, and on Escape,
 * which it takes before the editor does (`useEscapeFirst`): opened with the
 * pointer, it leaves focus in the editor. A dialog or popover opened above
 * it takes the key first. While open it counts as an overlay
 * (`useOverlayOpen`), so one press closes it and nothing else.
 * Its open state is its own, so it goes with the toolbar when the toolbar
 * goes, as focus leaves the editor; nothing is left counted as open.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { EditorView } from "@codemirror/view";
import { ChevronDown, Heading } from "lucide-react";
import { toggleHeading } from "~/components/ui/markdown-editor/commands";
import { toolbarPress } from "~/components/ui/markdown-editor/toolbar-press";
import { useEscapeFirst } from "~/hooks/use-escape-to-close";
import { useOverlayOpen } from "~/hooks/use-overlay-open";

export function HeadingMenu({ viewRef }: { viewRef: MutableRefObject<EditorView | null> }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const overlay = useOverlayOpen(open);

  useEscapeFirst(() => setOpen(false), open, overlay.isTop);

  useEffect(() => {
    if (!open) return;
    function closeOnPressElsewhere(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", closeOnPressElsewhere);
    return () => document.removeEventListener("mousedown", closeOnPressElsewhere);
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title={t("toolbar.heading")}
        aria-expanded={open}
        {...toolbarPress(() => setOpen((v) => !v))}
        className="flex items-center gap-0.5 p-1.5 pointer-coarse:min-h-11 text-gray-500 hover:text-charcoal hover:bg-cream-dark rounded transition-colors"
      >
        <Heading className="w-4 h-4" />
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-md shadow-md z-10 py-1 min-w-[7rem]">
          {([1, 2, 3, 4] as const).map((level) => (
            <button
              key={level}
              type="button"
              {...toolbarPress(() => {
                if (viewRef.current) toggleHeading(viewRef.current, level);
                setOpen(false);
              })}
              className="w-full text-left px-3 py-1.5 font-heading text-sm text-charcoal hover:bg-cream-dark transition-colors"
            >
              {t("toolbar.heading_level", { level })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

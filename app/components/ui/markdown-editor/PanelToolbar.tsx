/**
 * PanelToolbar — the layer panel editor's own toolbar buttons: Bibliography,
 * the Widget menu (accordion, tabs, carousel, glossary callout) and Math.
 * Each runs on click only, through toolbarPress, like every other toolbar
 * button. The glossary callout's item opens GlossaryCalloutDialog for its
 * entry and side, and the block is written where the caret is when the
 * dialog's Insert is pressed, as the other widgets are written at it.
 *
 * Each insertion is its own step on the shared undo stack: the capture is
 * closed before and after it, so one undo removes the widget or formula and
 * nothing typed around it. Math acts on the focused widget field at its
 * caret when there is one (fieldFocus.ts), refuses while that field has
 * gone away, and uses the site's first inline delimiter pair, or the
 * framework's default pairs until the site's configuration has arrived.
 *
 * @version v1.5.0-beta
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditorView } from "@codemirror/view";
import type * as Y from "yjs";
import { BookOpen, PanelsTopLeft, Sigma } from "lucide-react";
import { toolbarPress } from "./toolbar-press";
import { insertGlossaryCallout, insertPanelMath, insertPanelWidget } from "./panelAuthoring";
import { GlossaryCalloutDialog } from "./GlossaryCalloutDialog";
import { mathInFocusedField } from "./fieldFocus";
import { panelMathDelimiters, type MathDelimiter } from "./panelMath";
import type { WidgetKind } from "./panelSource";
import type { PanelPreviewConfig } from "~/lib/panel-preview-config";
import { useOverlayOpen } from "~/hooks/use-overlay-open";
import { useEscapeFirst } from "~/hooks/use-escape-to-close";

const BUTTON =
  "inline-flex items-center justify-center p-1.5 pointer-coarse:min-w-11 pointer-coarse:min-h-11 text-gray-500 hover:text-charcoal hover:bg-cream-dark rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const MENU_WIDGETS: WidgetKind[] = ["accordion", "tabs", "carousel"];

interface PanelToolbarProps {
  /** False renders nothing: panel authoring is off in this editor. */
  enabled?: boolean;
  view: EditorView | null;
  undoManager: Y.UndoManager | null | undefined;
  disabled: boolean;
  preview?: PanelPreviewConfig;
  /** While set, Math is disabled to assistive technology and a press calls this instead. */
  refusing?: () => void;
}

/** Runs `edit` as a step of its own on the shared undo stack. */
function isolated(undoManager: PanelToolbarProps["undoManager"], edit: () => void) {
  undoManager?.stopCapturing();
  edit();
  undoManager?.stopCapturing();
}

function delimitersFor(preview?: PanelPreviewConfig): MathDelimiter[] {
  return preview?.delimiters.length ? preview.delimiters : panelMathDelimiters;
}

function WidgetMenu({
  onInsert,
  onGlossary,
  disabled,
}: {
  onInsert: (kind: WidgetKind) => void;
  onGlossary: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const overlay = useOverlayOpen(open);
  useEscapeFirst(() => setOpen(false), open, overlay.isTop);
  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePress(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsidePress);
    return () => document.removeEventListener("mousedown", closeOnOutsidePress);
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title={t("panel.widget")}
        aria-expanded={open}
        disabled={disabled}
        {...toolbarPress(() => setOpen((v) => !v), disabled)}
        className={BUTTON}
      >
        <PanelsTopLeft className="w-4 h-4" />
      </button>
      {open && (
        <div className="cm-panel-menu">
          {MENU_WIDGETS.map((kind) => (
            <button
              type="button"
              key={kind}
              {...toolbarPress(() => {
                onInsert(kind);
                setOpen(false);
              })}
            >
              {t(`panel.${kind}`)}
            </button>
          ))}
          <button
            type="button"
            {...toolbarPress(() => {
              onGlossary();
              setOpen(false);
            })}
          >
            {t("panel.glossary")}
          </button>
        </div>
      )}
    </div>
  );
}

export function PanelToolbar({ enabled, ...props }: PanelToolbarProps) {
  return enabled ? <PanelButtons {...props} /> : null;
}

function PanelButtons({ view, undoManager, disabled, preview, refusing }: Omit<PanelToolbarProps, "enabled">) {
  const { t } = useTranslation("editor");
  const [calloutOpen, setCalloutOpen] = useState(false);
  const writable = () => (view && !view.state.readOnly ? view : null);
  const insertWidget = (kind: WidgetKind) => {
    const target = writable();
    if (target) isolated(undoManager, () => insertPanelWidget(target, kind, t("panel.section")));
  };
  const insertCallout = (entry: string, side: "right" | "left") => {
    const target = writable();
    if (!target) return;
    isolated(undoManager, () => insertGlossaryCallout(target, entry, side));
    target.focus();
  };
  const insertMath = () => {
    const target = writable();
    if (!target) return;
    const delimiters = delimitersFor(preview);
    const inline = delimiters.find((d) => !d.display) ?? delimiters[0];
    const inView = (v: EditorView) => insertPanelMath(v, delimiters);
    isolated(undoManager, () => {
      if (!mathInFocusedField(target, inline, inView)) inView(target);
    });
  };
  return (
    <>
      <button
        type="button"
        title={t("panel.bibliography")}
        disabled={disabled}
        {...toolbarPress(() => insertWidget("bibliography"), disabled)}
        className={BUTTON}
      >
        <BookOpen className="w-4 h-4" />
      </button>
      <WidgetMenu onInsert={insertWidget} onGlossary={() => setCalloutOpen(true)} disabled={disabled} />
      <GlossaryCalloutDialog open={calloutOpen} onClose={() => setCalloutOpen(false)} onInsert={insertCallout} />
      <button
        type="button"
        title={t("panel.math")}
        disabled={disabled}
        aria-disabled={refusing ? true : undefined}
        {...toolbarPress(refusing ?? insertMath, disabled)}
        className={`${BUTTON} aria-disabled:opacity-40`}
      >
        <Sigma className="w-4 h-4" />
      </button>
    </>
  );
}

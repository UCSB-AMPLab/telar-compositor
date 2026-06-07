/**
 * InlineHtmlEditor — collaborative single-field inline-HTML editor with a
 * click-to-edit display.
 *
 * Used for config.description, which is stored and rendered as raw HTML inside
 * the homepage <p class="lead"> (telar/_layouts/index.html). The document is
 * HTML (the canonical stored form).
 *
 * Display model: when NOT editing, the box shows the live, sanitised RENDER of
 * the value (so the user sees the formatted result, not raw tags). Clicking the
 * box switches to an inline HTML source editor (CodeMirror + a bold/italic/link
 * toolbar); blurring it switches back to the render. The editor is mounted only
 * while editing.
 *
 * Built on CodeMirror 6 + y-codemirror.next, bound to the shared
 * config.description Y.Text — character-level collaboration while editing. The
 * value is observed independently so the render stays live (e.g. a collaborator's
 * remote edit) even when this client isn't editing.
 *
 * @version v1.3.0-beta
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bold, Italic, Link } from "lucide-react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { sanitiseInlineHtml } from "~/lib/sanitise-html";
import { wrapHtml, insertHtmlLink, type LinkSnapshot } from "~/components/ui/html-commands";
import { LinkPopover } from "~/components/ui/markdown-editor/LinkPopover";

export interface InlineHtmlEditorProps {
  initialValue: string;          // SSR / pre-connection fallback (raw HTML)
  yText: Y.Text | null;
  placeholder?: string;
  className?: string;
  /**
   * Accessible name for the field. CodeMirror renders its own contentEditable
   * DOM, so a sibling <label htmlFor> can't bind to it — pass the field's label
   * here to name both the click-to-edit box and the editor textbox.
   */
  ariaLabel?: string;
}

// Box chrome shared by the render view and the editor so the swap is seamless.
const BOX = "rounded-md border border-gray-200 bg-white px-3 py-2 text-sm";

function ToolbarButton({ icon: Icon, tooltip, onAction }: {
  icon: React.ElementType; tooltip: string; onAction: () => void;
}) {
  return (
    <button
      type="button"
      title={tooltip}
      onMouseDown={(e) => { e.preventDefault(); onAction(); }}
      className="p-1.5 text-gray-500 hover:text-charcoal hover:bg-cream-dark rounded transition-colors"
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

export function InlineHtmlEditor({
  initialValue, yText, placeholder, className = "", ariaLabel,
}: InlineHtmlEditorProps) {
  const { t } = useTranslation("editor");
  const { provider, isPublishing } = useCollaborationContext();
  const [mounted, setMounted] = useState(false);
  const [editing, setEditing] = useState(false);
  // Live value, mirrored from the Y.Text so the render reflects remote edits
  // even when this client isn't editing.
  const [value, setValue] = useState(initialValue);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkPos, setLinkPos] = useState<{ top: number; left: number } | null>(null);
  const [linkSelected, setLinkSelected] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnly = useRef(new Compartment());
  // Selection snapshot captured when the link popover opens. The popover input
  // autofocuses (blurring the editor), so the live selection is unreliable at
  // insert time — we insert using this snapshot instead.
  const linkSnapshotRef = useRef<LinkSnapshot | null>(null);

  useEffect(() => { setMounted(true); }, []);

  // Keep `value` in sync with the Y.Text (drives the live render).
  useEffect(() => {
    if (!yText) return;
    setValue(yText.toString());
    const obs = () => setValue(yText.toString());
    yText.observe(obs);
    return () => yText.unobserve(obs);
  }, [yText]);

  const previewHtml = useMemo(() => sanitiseInlineHtml(value), [value]);

  function openLinkPopover() {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    linkSnapshotRef.current = { from, to, text };
    setLinkSelected(text);
    const coords = view.coordsAtPos(from);
    const wrapRect = wrapperRef.current?.getBoundingClientRect();
    if (coords && wrapRect) {
      setLinkPos({ top: coords.bottom - wrapRect.top + 4, left: coords.left - wrapRect.left });
    }
    setLinkOpen(true);
  }

  // EditorView lifecycle — mounted ONLY while editing (the box otherwise shows
  // the render). Creates a LOCAL Y.UndoManager scoped to this editor's own
  // yText so that Ctrl/Cmd-Z only ever affects the description field and never
  // pops items off the shared document-level undo stack (which is scoped to the
  // stories/objects/glossary/pages arrays).
  useEffect(() => {
    if (!mounted || !editing || !containerRef.current) return;
    // Field-scoped undo: isolated to this Y.Text — does not touch the shared
    // document-level UndoManager (use-collaboration.tsx) that drives structural
    // operations on the root Y.Arrays.
    const localUndo = yText ? new Y.UndoManager(yText, { captureTimeout: 500 }) : null;
    const startDoc = yText ? yText.toString() : value;
    const view = new EditorView({
      state: EditorState.create({
        doc: startDoc,
        extensions: [
          keymap.of([
            ...defaultKeymap,
            { key: "Mod-b", run: (v) => { wrapHtml(v, "strong"); return true; } },
            { key: "Mod-i", run: (v) => { wrapHtml(v, "em"); return true; } },
            { key: "Mod-k", run: () => { openLinkPopover(); return true; } },
          ]),
          EditorView.lineWrapping,
          ...(ariaLabel ? [EditorView.contentAttributes.of({ "aria-label": ariaLabel })] : []),
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
          readOnly.current.of(EditorState.readOnly.of(isPublishing)),
          ...(yText ? [yCollab(yText, provider?.awareness ?? null, { undoManager: localUndo ?? false })] : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setValue(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: (e) => {
              const rt = e.relatedTarget as Node | null;
              // Stay in edit mode while focus is inside the field (toolbar / link popover).
              if (!wrapperRef.current?.contains(rt)) setEditing(false);
              return false;
            },
          }),
        ],
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    // Focus and place the caret at the end so typing continues the text.
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    return () => { view.destroy(); viewRef.current = null; localUndo?.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, editing, yText]);

  // Publish-lock: reconfigure when isPublishing changes during an edit session.
  useEffect(() => {
    if (!editing || !viewRef.current) return;
    viewRef.current.dispatch({
      effects: readOnly.current.reconfigure(EditorState.readOnly.of(isPublishing)),
    });
  }, [isPublishing, editing]);

  function startEditing() {
    if (!isPublishing) setEditing(true);
  }

  if (!mounted) {
    return <div className={`relative ${className}`}><div className={`${BOX} min-h-[3rem]`} /></div>;
  }

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      {editing ? (
        <>
          <div className="flex items-center gap-0.5 px-2 py-1 mb-2 border-b border-gray-100 bg-black/5 rounded-t">
            <ToolbarButton icon={Bold} tooltip={t("toolbar.bold")} onAction={() => viewRef.current && wrapHtml(viewRef.current, "strong")} />
            <ToolbarButton icon={Italic} tooltip={t("toolbar.italic")} onAction={() => viewRef.current && wrapHtml(viewRef.current, "em")} />
            <ToolbarButton icon={Link} tooltip={t("toolbar.link")} onAction={openLinkPopover} />
          </div>
          <div
            ref={containerRef}
            className={`${BOX} [&_.cm-editor]:outline-none [&_.cm-content]:font-body`}
          />
          {linkOpen && linkPos && (
            <LinkPopover
              position={linkPos}
              selectedText={linkSelected}
              onInsert={(url) => { if (viewRef.current) insertHtmlLink(viewRef.current, url, linkSnapshotRef.current ?? undefined); setLinkOpen(false); setLinkPos(null); }}
              onCancel={() => { setLinkOpen(false); setLinkPos(null); }}
            />
          )}
        </>
      ) : (
        <div
          data-description-preview
          role="button"
          tabIndex={0}
          aria-label={ariaLabel}
          onClick={startEditing}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startEditing(); } }}
          className={`${BOX} min-h-[3rem] cursor-text hover:border-gray-300 focus:border-anil focus:outline-none ${isPublishing ? "opacity-60 cursor-not-allowed" : ""}`}
        >
          {value.trim() ? (
            <span
              aria-hidden="true"
              className="pointer-events-none [&_a]:text-anil-ink [&_a]:underline"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <span className="pointer-events-none text-gray-400">{placeholder}</span>
          )}
        </div>
      )}
    </div>
  );
}

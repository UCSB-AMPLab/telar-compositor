/**
 * FootnotePopover — writes a new footnote, or reuses one of the notes in
 * the same conversion, at the cursor of the layer panel editor. Where a
 * reference cannot go (`scope` is null) it shows only why, and a Close
 * button.
 *
 * The document is untouched until Insert. The insertion point is held in the
 * editor's `panelTarget` field, which follows remote edits while the popover
 * is open and is cleared when one touches it; Insert then refuses and says so.
 * Only a refused insert keeps the author's text: the popover hands it back
 * through `onClose`, and the editor passes it in as `initialText` the next
 * time the popover opens. Cancel, Escape or a click outside before any
 * refusal close with nothing kept. Escape stops at the popover, so an
 * enclosing dialog stays open.
 *
 * `FootnoteEdit` changes the text of an existing note, opened from its
 * number or from the note list. The note's text is held in `panelTarget`
 * like an insertion point: an edit by anyone else inside it clears the
 * target, and Save then refuses and keeps what the author wrote on screen.
 * Save replaces only the note's text; the label and the references stay.
 *
 * Both open through EditorPopover, portalled and placed in screen pixels
 * from an anchor. When the anchor scrolls out of view or is gone, the
 * popover closes and hands back what the author had written, through
 * `onClose` for a new note and `onDetach` for an edit, so opening it again
 * brings the text back.
 *
 * @version v1.5.0-beta
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EditorView } from "@codemirror/view";
import {
  insertFootnote,
  panelTarget,
  reusableDefinitions,
  setPanelTarget,
} from "./footnoteSource";
import type { FootnoteScope } from "./footnoteScopes";
import type { NoteDefinition, SourceRange } from "./footnoteSyntax";
import { replacePanelField } from "./panelSource";
import { EditorPopover, type PopoverAnchor } from "./EditorPopover";
import { useOverlayOpen } from "~/hooks/use-overlay-open";

export const FOOTNOTE_POPOVER_WIDTH = 328;

/** Characters of a note's text shown in the reuse list. */
const NOTE_PREVIEW_LENGTH = 60;

/**
 * Focus back to the text after a popover that scrolled out of view, without
 * scrolling the page back to it.
 */
function refocusQuietly(view: EditorView) {
  if (view.dom.isConnected) view.contentDOM.focus({ preventScroll: true });
}

export function notePreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NOTE_PREVIEW_LENGTH
    ? `${flat.slice(0, NOTE_PREVIEW_LENGTH - 1).trimEnd()}…`
    : flat;
}

interface FootnotePopoverProps {
  view: EditorView;
  anchor: PopoverAnchor;
  /** The conversion the reference would join; null where it cannot go. */
  scope: FootnoteScope | null;
  /** Text kept from a refused insert; empty for a fresh note. */
  initialText: string;
  /** Called with the text to keep for the next opening ("" keeps nothing). */
  onClose: (keptText: string) => void;
  /** Ends the shared undo capture so the insert is its own undo step. */
  isolateUndo: () => void;
}

const BUTTON_QUIET =
  "font-body text-sm text-gray-500 hover:text-charcoal px-2 py-1 transition-colors";
const BUTTON_PRIMARY =
  "font-body text-sm bg-terracotta text-cream px-3 py-1 rounded-md hover:bg-terracotta/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
const FIELD =
  "block w-full mt-1 font-body text-sm text-charcoal border border-gray-200 rounded px-2 py-1.5 focus:border-anil";

/** Positioning, focus, and dismissal by Escape or a click outside. */
function FootnotePopoverShell({
  anchor,
  onDismiss,
  onDetach,
  children,
}: {
  anchor: PopoverAnchor;
  onDismiss: () => void;
  onDetach: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("editor");
  const root = useRef<HTMLDivElement | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useOverlayOpen(true);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("textarea, button")?.focus();
    function outside(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) dismissRef.current();
    }
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);

  return (
    <EditorPopover
      anchor={anchor}
      width={FOOTNOTE_POPOVER_WIDTH}
      onDetach={onDetach}
      role="dialog"
      aria-label={t("footnote.button")}
      rootRef={(el) => {
        root.current = el;
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }}
    >
      {children}
    </EditorPopover>
  );
}

export function FootnotePopover(props: FootnotePopoverProps) {
  return props.scope ? (
    <FootnoteForm {...props} scope={props.scope} />
  ) : (
    <FootnoteNotHere {...props} />
  );
}

function FootnoteNotHere({ view, anchor, initialText, onClose }: FootnotePopoverProps) {
  const { t } = useTranslation("editor");
  function dismissNotHere() {
    onClose(initialText);
    view.focus();
  }
  return (
    <FootnotePopoverShell
      anchor={anchor}
      onDismiss={dismissNotHere}
      onDetach={() => {
        onClose(initialText);
        refocusQuietly(view);
      }}
    >
      <p role="alert" className="font-body text-sm text-charcoal mb-2">
        {t("footnote.not_here")}
      </p>
      <div className="flex justify-end">
        <button type="button" onClick={dismissNotHere} className={BUTTON_QUIET}>
          {t("link_popover.cancel")}
        </button>
      </div>
    </FootnotePopoverShell>
  );
}

function FootnoteForm({
  view,
  anchor,
  scope,
  initialText,
  onClose,
  isolateUndo,
}: FootnotePopoverProps & { scope: FootnoteScope }) {
  const { t } = useTranslation("editor");
  const [body, setBody] = useState(initialText);
  const [reuse, setReuse] = useState("");
  const [refused, setRefused] = useState(false);
  const [notes] = useState(() => reusableDefinitions(view.state, scope));

  function dismissForm() {
    view.dispatch({ effects: setPanelTarget.of(null) });
    onClose(refused ? body : "");
    view.focus();
  }

  // Closed by a scroll, not by the author: what they wrote is kept.
  function detachForm() {
    view.dispatch({ effects: setPanelTarget.of(null) });
    onClose(body);
    refocusQuietly(view);
  }

  function insertNote() {
    isolateUndo();
    const inserted = insertFootnote(view, body, reuse || undefined);
    isolateUndo();
    if (inserted) onClose("");
    else setRefused(true);
  }

  return (
    <FootnotePopoverShell anchor={anchor} onDismiss={dismissForm} onDetach={detachForm}>
      <label className="block font-body text-xs text-gray-500 mb-2">
        {t("footnote.text")}
        <textarea
          value={body}
          disabled={!!reuse}
          onChange={(e) => setBody(e.target.value)}
          className={`${FIELD} min-h-24 resize-y disabled:opacity-40`}
        />
      </label>
      {notes.length > 0 && (
        <label className="block font-body text-xs text-gray-500 mb-2">
          {t("footnote.reuse")}
          <select
            value={reuse}
            onChange={(e) => setReuse(e.target.value)}
            className={`${FIELD} truncate`}
          >
            <option value="">{t("footnote.new")}</option>
            {notes.map((n) => (
              <option key={n.label} value={n.label}>
                {notePreview(n.text)}
              </option>
            ))}
          </select>
        </label>
      )}
      {refused && (
        <p role="alert" className="font-body text-xs text-terracotta mb-2">
          {t("footnote.target_changed")}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={dismissForm} className={BUTTON_QUIET}>
          {t("link_popover.cancel")}
        </button>
        <button
          type="button"
          onClick={insertNote}
          disabled={(!body.trim() && !reuse) || view.state.readOnly}
          className={BUTTON_PRIMARY}
        >
          {t("link_popover.insert")}
        </button>
      </div>
    </FootnotePopoverShell>
  );
}

/** The span of a note's text: after its marker and the spaces that follow. */
export function noteTextRange(view: EditorView, note: NoteDefinition): SourceRange {
  const after = view.state.sliceDoc(note.marker.to, note.to);
  return { from: note.marker.to + (after.length - after.trimStart().length), to: note.to };
}

interface FootnoteEditProps {
  view: EditorView;
  anchor: PopoverAnchor;
  /** The note's text as written; `panelTarget` holds its span. */
  source: string;
  /** The text the field starts with: the note's, or what was kept for it. */
  text: string;
  onClose: () => void;
  /** Called with what the author wrote when the note scrolls out of view. */
  onDetach: (body: string) => void;
  isolateUndo: () => void;
}

export function FootnoteEdit({ view, anchor, source, text, onClose, onDetach, isolateUndo }: FootnoteEditProps) {
  const { t } = useTranslation("editor");
  const [body, setBody] = useState(text);
  const [refused, setRefused] = useState(false);

  function dismissEdit() {
    view.dispatch({ effects: setPanelTarget.of(null) });
    onClose();
    view.focus();
  }

  function saveNote() {
    const target = view.state.field(panelTarget, false);
    const next = body.trim().replace(/\n/g, "\n    ");
    isolateUndo();
    const saved = !!target && replacePanelField(view, target, source, next);
    isolateUndo();
    if (saved) dismissEdit();
    else setRefused(true);
  }

  return (
    <FootnotePopoverShell
      anchor={anchor}
      onDismiss={dismissEdit}
      onDetach={() => {
        view.dispatch({ effects: setPanelTarget.of(null) });
        onDetach(body);
        refocusQuietly(view);
      }}
    >
      <label className="block font-body text-xs text-gray-500 mb-2">
        {t("footnote.text")}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={`${FIELD} min-h-24 resize-y`}
        />
      </label>
      {refused && (
        <p role="alert" className="font-body text-xs text-terracotta mb-2">
          {t("footnote.target_changed")}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={dismissEdit} className={BUTTON_QUIET}>
          {t("link_popover.cancel")}
        </button>
        <button
          type="button"
          onClick={saveNote}
          disabled={!body.trim() || view.state.readOnly}
          className={BUTTON_PRIMARY}
        >
          {t("save_discard.save")}
        </button>
      </div>
    </FootnotePopoverShell>
  );
}

/**
 * This file is the compositor's shared markdown editing surface — a
 * CodeMirror 6 editor with an Obsidian-style live preview, where syntax
 * markers stay hidden except on the line the cursor sits on, so authors
 * see formatted prose while still editing raw markdown.
 *
 * It lives in app/components/ui/ as a single primitive that every
 * markdown field reuses: the dashboard landing fields, the story layer
 * editor, glossary definitions, and pages. A formatting toolbar and the
 * usual keyboard shortcuts (Cmd+B/I/K and undo/redo) drive the standard
 * markdown insertions; pasting HTML from a web page is converted to
 * markdown via turndown so authors can bring in formatted text cleanly.
 *
 * The component runs in two persistence modes that share one UI. In
 * collaborative mode a Yjs `Y.Text` is passed in: yCollab binds it to
 * CodeMirror for real-time multi-editor sync, the shared doc-level
 * Y.UndoManager replaces CodeMirror's own history() so undo spans both
 * text edits and structural operations on the same stack, and an
 * EditorState.readOnly compartment locks the editor while a publish is
 * in flight. With no `Y.Text` it falls back to a self-contained editor
 * with built-in history() and debounced autosave through a React Router
 * fetcher.
 *
 * When enabled on the link-bearing surfaces, `[[term]]` glossary chips
 * are layered in via glossaryChipPlugin: resolved terms render as title
 * pills, unresolved slugs get a quick-create affordance, and clicking
 * either is routed back to the caller through onChipClick /
 * onUnresolvedChipClick. A live preview guard returns null during
 * server-side render since all of CodeMirror is browser-only.
 *
 * With `enableFootnotes` (the layer panel editor only) a Footnote button
 * opens FootnotePopover at the cursor. The insertion point is held in the
 * `panelTarget` state field so a remote edit around it makes the insert
 * refuse, and the insert is isolated on both undo stacks so one undo removes
 * the reference and its definition together.
 *
 * With `enablePanelAuthoring` (the layer panel editor only) widgets,
 * footnote numbers and formulas are drawn in place by panelAuthoring, and
 * PanelToolbar adds Bibliography, Widget and Math. The site's preview
 * settings arrive as `panelPreview`, which the story loader streams; until
 * they do, formulas stay as source. A widget field the author is typing in
 * takes the toolbar's Bold, Italic, Math and Footnote at its own caret
 * (fieldFocus.ts).
 *
 * Focus is judged by a logical scope (focus-scope.ts), not by DOM
 * containment: the link and footnote popovers and the image dialog are
 * portalled to `document.body` and register with the editor's scope, so
 * focus moving into them is not focus leaving the editor. `onFocusLeave`
 * fires once focus has left the editor and all of them.
 *
 * A standalone autosave is debounced; when the editor unmounts with one
 * pending, it is sent then rather than dropped, so a field closed straight
 * after typing keeps the change. When a Y.Text arrives and replaces the
 * standalone view, the view's pending save is dropped, by its timer and at
 * unmount alike: the shared text is the value from then on. A fetcher submitted as its component
 * unmounts still completes: React Router keeps a fetcher until it is idle.
 * A save the action refuses answers `{ ok: false }` and is logged as a failed
 * save, like one whose request failed; with `saveErrorMessage` the editor
 * also says so under itself until a later save is not refused.
 * In `controlled` mode the editor saves nothing and reports each change
 * through `onChange`; the caller owns the draft and its save.
 *
 * @version v1.5.0-beta
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Bold,
  Italic,
  Link,
  Image,
  List,
  ListOrdered,
  Quote,
  Undo,
  Redo,
  Indent,
  Outdent,
  Superscript,
} from "lucide-react";

// CodeMirror imports — all browser-only; SSR guard prevents server execution
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo, redo, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

// Collaborative editing — yCollab binds Y.Text to CodeMirror 6
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

import { livePreviewPlugin } from "~/components/ui/markdown-editor/livePreviewPlugin";
import { glossaryChipPlugin } from "~/components/ui/markdown-editor/glossaryChipPlugin";
import {
  glossaryMapField,
  installGlossaryResolution,
} from "~/components/ui/markdown-editor/glossaryResolution";
import { richPasteExtension } from "~/components/ui/markdown-editor/richPaste";
import { cleanPasteExtension } from "~/components/ui/markdown-editor/cleanPaste";
import {
  insertMarkdownWrap,
  insertLink,
  insertImage,
  toggleBulletList,
  toggleOrderedList,
  toggleBlockquote,
  indentLine,
  outdentLine,
} from "~/components/ui/markdown-editor/commands";
import { LinkPopover } from "~/components/ui/markdown-editor/LinkPopover";
import { ImageInsertDialog } from "~/components/ui/markdown-editor/ImageInsertDialog";
import { GlossaryLinkButton } from "~/components/ui/markdown-editor/GlossaryLinkButton";
import { useFootnoteButton } from "~/components/ui/markdown-editor/useFootnoteButton";
import { panelAuthoring } from "~/components/ui/markdown-editor/panelAuthoring";
import { panelOptions, type PanelOptions } from "~/components/ui/markdown-editor/panelOptions";
import { PanelToolbar } from "~/components/ui/markdown-editor/PanelToolbar";
import { wrapFocusedField } from "~/components/ui/markdown-editor/fieldFocus";
import { FieldGoneNotice, useLostField } from "~/components/ui/markdown-editor/useLostField";
import {
  bookmarkField,
  releaseBookmark,
  replaceBookmarkedField,
  type FieldBookmark,
} from "~/components/ui/markdown-editor/panelSource";
import {
  unavailablePanelPreview,
  type PanelPreviewConfig,
  type PanelPreviewSource,
} from "~/lib/panel-preview-config";
import { toolbarPress } from "~/components/ui/markdown-editor/toolbar-press";
import { caretAnchor, type PopoverAnchor } from "~/components/ui/markdown-editor/EditorPopover";
import { FocusScopeContext, useFocusScope } from "~/components/ui/focus-scope";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { KeptDraftNotice } from "~/components/ui/markdown-editor/KeptDraftNotice";
import { useKeptDraft } from "~/components/ui/markdown-editor/use-kept-draft";
import { isRefusedSave, useReportRefusedSave } from "~/hooks/use-report-refused-save";
import { isPersistableLayerId } from "~/lib/yjs-helpers";
import { computeWordCount } from "~/lib/word-count";
import { HeadingMenu } from "~/components/ui/markdown-editor/HeadingMenu";
import { useEditorPresence, useFirstViewCaret } from "~/components/ui/markdown-editor/editor-focus-extras";
import { usePublishLock } from "~/components/ui/markdown-editor/use-publish-lock";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MarkdownEditorProps {
  initialValue: string;
  fieldName: string;
  projectId: number;
  intent?: string;
  actionUrl?: string;
  debounceMs?: number;
  className?: string;
  /**
   * `autosave` posts through a fetcher after `debounceMs`; `save-discard`
   * shows Save and Discard and calls `onSave`; `controlled` saves nothing and
   * leaves the draft to the caller, through `onChange`.
   */
  mode?: "autosave" | "save-discard" | "controlled";
  onSave?: (markdown: string) => void;
  /** Called with the document after every change, in every mode. */
  onChange?: (markdown: string) => void;
  /** Focus the editor when it mounts, with the caret at the end. */
  autoFocus?: boolean;
  /**
   * Called when focus leaves the editor, its toolbar and every popover or
   * dialog opened from it.
   */
  onFocusLeave?: () => void;
  onDiscard?: () => void;
  /** Called whenever the dirty state changes — used by LayerPanel for unsaved-changes guard */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Object list for the image picker dialog. `source_url` tells an external
   * object, whose image is its own, from a self-hosted one under the site's tiles.
   */
  objects?: Array<{ object_id: string; title: string | null; thumbnail: string | null; image_available?: boolean | null; source_url: string | null }>;
  /** Site base URL for constructing IIIF image URLs in the image picker */
  siteBaseUrl?: string | null;
  /** The site's `telar_version`, which decides the id a self-hosted object's tiles are under. */
  frameworkVersion?: string | null;
  /** Make editor background transparent (for coloured panel backgrounds) */
  transparent?: boolean;
  /** Use light colours for toolbar/text on dark backgrounds */
  darkTheme?: boolean;
  /**
   * Yjs shared text instance for collaborative mode.
   * When provided, yCollab replaces the autosave updateListener and history().
   * When null/undefined, the editor falls back to the standard autosave + history() behaviour.
   */
  yText?: Y.Text | null;
  /** Show toolbar even when the editor is not focused */
  alwaysShowToolbar?: boolean;
  /**
   * When true, a glossary link button is shown in the toolbar.
   * Available for content that goes through generate_collections.py:
   * story layers, pages, and glossary definitions.
   * Not available in config fields or metadata.
   */
  enableGlossaryLinks?: boolean;
  /**
   * When true, a footnote button is shown in the toolbar. Only the story
   * layer panel passes it: its text is converted with Python Markdown's
   * footnotes extension.
   */
  enableFootnotes?: boolean;
  /**
   * When true, widgets, footnote numbers and formulas are drawn in place and
   * the toolbar offers Bibliography, Widget and Math. Only the story layer
   * panel passes it.
   */
  enablePanelAuthoring?: boolean;
  /** The site's widget and formula settings, or the loader's promise of them. */
  panelPreview?: PanelPreviewSource;
  /**
   * Called when a resolved `[[term]]` chip is clicked.
   * Receives the chip's `term_id`. Surface-specific behaviour is supplied by the caller:
   * the glossary definition editor selects the term in place; story/page editors navigate
   * to `/glossary?term=<termId>`. When omitted, a chip click is a no-op (cursor lands as
   * normal). Only meaningful when `enableGlossaryLinks` is true.
   */
  onChipClick?: (termId: string) => void;
  /**
   * Called when an UNRESOLVED `[[term]]` token (a `cm-glossary-unresolved`
   * range — a slug with no matching glossary term) is clicked. Receives
   * the unresolved `term_id`. The glossary definition editor wires this to a
   * one-transaction quick-create; other surfaces may leave it omitted (a click
   * on an unresolved token is then a no-op). Only meaningful when
   * `enableGlossaryLinks` is true.
   */
  onUnresolvedChipClick?: (termId: string) => void;
  /**
   * Override the form-field name used by the autosave fetcher (non-collaborative
   * fallback). Defaults to "projectId" to preserve all existing call sites.
   * LayerPanel passes "layerId" so the autosave-layer action handler — which
   * reads `formData.get("layerId")` — sees the correctly-named field.
   * The `projectId` prop value is still used as the form value; only the field
   * key changes.
   */
  formFieldName?: string;
  /**
   * Greyed placeholder shown when the editor is empty (both collaborative and
   * non-collaborative modes). Used by the homepage Welcome editor to surface
   * the localized canned default without injecting it as editable content —
   * the same "show a default when empty" pattern the sibling landing fields
   * use via InlineTextField's `placeholder`.
   */
  placeholder?: string;
  /**
   * Set while what holds the editor is covered, as a layer panel is by the
   * one over it: the editor's popovers and menus close.
   */
  dismissed?: boolean;
  /**
   * Shown under the editor while its last autosave was refused or failed in
   * transit. Without it such a save is only logged.
   */
  saveErrorMessage?: string;
  /**
   * Shown under the editor, inside its focus scope: moving focus into it, by
   * pointer or by Tab, is not focus leaving the editor.
   */
  footer?: React.ReactNode;
  /**
   * The awareness key the author's location names while focus is in the
   * editor, as an inline field's does; cleared as focus leaves or the editor
   * goes, unless the location has moved on to another field.
   */
  presenceKey?: string;
  /**
   * With `autoFocus`, places the caret in the editor's first view in place
   * of putting it at the end. Called once: a view that replaces it (a
   * Y.Text arriving) takes focus back without it.
   */
  placeCaret?: (view: EditorView) => void;
  /** Shows the word count while the editor has focus, whatever saves it; by default only in `autosave` mode. */
  showWordCount?: boolean;
  /** Read-only while a publish holds the document, as an editor with a Y.Text is (use-publish-lock.ts). */
  lockWhilePublishing?: boolean;
}

// ---------------------------------------------------------------------------
// Toolbar button
// ---------------------------------------------------------------------------

function ToolbarButton({
  icon: Icon,
  tooltip,
  onAction,
  disabled = false,
  refusing,
}: {
  icon: React.ElementType;
  tooltip: string;
  onAction: () => void;
  disabled?: boolean;
  /** While set, the button is disabled to assistive technology and a press calls this instead. */
  refusing?: () => void;
}) {
  return (
    <button
      type="button"
      title={tooltip}
      disabled={disabled}
      aria-disabled={refusing ? true : undefined}
      {...toolbarPress(refusing ?? onAction, disabled)}
      className="inline-flex items-center justify-center p-1.5 pointer-coarse:min-w-11 pointer-coarse:min-h-11 text-gray-500 hover:text-charcoal hover:bg-cream-dark rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed aria-disabled:opacity-40"
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

/**
 * Extract the `term_id` (group 1, trimmed) from an unresolved `[[term]]` /
 * `[[term|display]]` token's raw text content. Returns null when the text does
 * not match the locked glossary link shape. Mirrors the `LINK_RE` used by the
 * chip plugin so a clicked `cm-glossary-unresolved` range resolves to the same
 * slug the quick-create op will use.
 */
function wrapperClassName(o: { transparent: boolean; darkTheme: boolean; locked: boolean; className: string }) {
  const parts = ["relative", o.transparent && "cm-transparent", o.darkTheme && "cm-dark-theme", o.locked && "opacity-50"];
  return [...parts.filter(Boolean), o.className].join(" ");
}

/** Whether the word count shows: as the caller asks, else in `autosave` mode only. */
function showsWordCount(mode: MarkdownEditorProps["mode"], asked: boolean | undefined): boolean {
  return asked ?? mode === "autosave";
}

/** A key binding's command: runs `action` and stops other bindings. */
function runAndStop(action: () => void): boolean {
  action();
  return true;
}

function extractUnresolvedTermId(text: string | null): string | null {
  if (!text) return null;
  const m = /\[\[\s*([^|\]]+?)(?:\s*\|\s*([^|\]]+?))?\s*\]\]/.exec(text);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// MarkdownEditor
// ---------------------------------------------------------------------------

export function MarkdownEditor({
  initialValue,
  fieldName,
  projectId,
  intent = "autosave-landing",
  actionUrl = "/dashboard",
  debounceMs = 1500,
  className = "",
  mode = "autosave",
  onSave,
  onChange,
  autoFocus = false,
  onFocusLeave,
  onDiscard,
  onDirtyChange,
  objects,
  siteBaseUrl,
  frameworkVersion,
  transparent = false,
  darkTheme = false,
  yText = null,
  alwaysShowToolbar = false,
  enableGlossaryLinks = false,
  enableFootnotes,
  enablePanelAuthoring,
  panelPreview,
  onChipClick,
  onUnresolvedChipClick,
  formFieldName = "projectId",
  placeholder,
  dismissed = false,
  saveErrorMessage,
  footer,
  presenceKey,
  placeCaret,
  showWordCount,
  lockWhilePublishing,
}: MarkdownEditorProps) {
  const [mounted, setMounted] = useState(false);
  const { t } = useTranslation("editor");
  const fetcher = useFetcher();
  // A save the action refuses answers `{ ok: false }`; it is a failed save.
  useReportRefusedSave(fetcher.data, "MarkdownEditor autosave failed");
  // Whether the last autosave's answer was a refusal, or it failed in
  // transit (answered `{ ok: false }` the same way, or rejected); the next
  // answer that is not a refusal clears it.
  const [saveFailed, setSaveFailed] = useState(false);
  const saveFailedRef = useRef(saveFailed);
  saveFailedRef.current = saveFailed;
  // Text typed before the shared text arrived and not saved: offered back to
  // the author, never written over the shared text.
  const keptDraft = useKeptDraft(yText);
  useEffect(() => {
    if (fetcher.data === undefined) return;
    setSaveFailed(isRefusedSave(fetcher.data));
    keptDraft.answered(isRefusedSave(fetcher.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // A popover whose caret cannot be measured opens under the toolbar.
  const popoverFallback = () => toolbarRef.current ?? wrapperRef.current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The save the debounce is holding back, and the editor generation (one
  // EditorView) that made it. Sent at once if the editor unmounts; dropped
  // if a Y.Text replaces that view, since the shared text is then the value.
  const pendingSaveRef = useRef<{ generation: number; send: () => void } | null>(null);
  const generationRef = useRef(0);
  const latestYText = useRef(yText);
  latestYText.current = yText;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onFocusLeaveRef = useRef(onFocusLeave);
  onFocusLeaveRef.current = onFocusLeave;
  // Whether the view had focus when it was last destroyed, so the view that
  // replaces it (a Y.Text arriving) takes focus back.
  const refocusRef = useRef(autoFocus);
  const focusNewView = useFirstViewCaret(placeCaret);

  // Compartment for toggling readOnly during publish lock
  const readOnlyCompartment = useRef(new Compartment());

  const [isFocused, setIsFocused] = useState(false);
  const { ydoc, provider, isPublishing, undoManager } = useCollaborationContext();
  const presence = useEditorPresence(provider, presenceKey);
  const focusScope = useFocusScope(wrapperRef, {
    onEnter: () => {
      setIsFocused(true);
      presence.enter();
    },
    onLeave: () => {
      setIsFocused(false);
      presence.leave();
      onFocusLeaveRef.current?.();
    },
  });
  const [isDirty, setIsDirty] = useState(false);
  const [wordCount, setWordCount] = useState(computeWordCount(initialValue));
  const [linkAnchor, setLinkAnchor] = useState<PopoverAnchor | null>(null);
  const [linkSelectedText, setLinkSelectedText] = useState("");
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const previewCompartment = useRef(new Compartment());
  const [preview, setPreview] = useState<PanelPreviewConfig | undefined>();
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const lostField = useLostField(viewRef.current);
  const refusing = lostField.lost ? lostField.refuse : undefined;
  const carouselImageTarget = useRef<{ view: EditorView; bookmark: FieldBookmark } | null>(null);

  // Collaboration context — provider.awareness for cursor sync; isPublishing for publish lock;
  // undoManager is the shared doc-level Y.UndoManager so that undo/redo spans text edits and
  // structural operations alike. In non-collaborative mode (no yText), CodeMirror's
  // built-in history() is used instead.
  const footnotes = useFootnoteButton({
    enabled: Boolean(enableFootnotes),
    viewRef,
    anchorFallback: popoverFallback,
    undoManager,
    yText,
    isPublishing,
    initialValue,
  });

  // Keep the latest onChipClick in a ref so the (rarely-rebuilt) EditorView click handler
  // always calls the current callback without re-running the EditorView lifecycle effect.
  const onChipClickRef = useRef(onChipClick);
  useEffect(() => {
    onChipClickRef.current = onChipClick;
  }, [onChipClick]);

  // Same ref-stable treatment for the unresolved-token quick-create CTA.
  const onUnresolvedChipClickRef = useRef(onUnresolvedChipClick);
  useEffect(() => {
    onUnresolvedChipClickRef.current = onUnresolvedChipClick;
  }, [onUnresolvedChipClick]);

  // Notify parent when dirty state changes
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Save-discard handlers
  function handleSave() {
    const view = viewRef.current;
    if (!view) return;
    onSave?.(view.state.doc.toString());
    setIsDirty(false);
  }

  function handleDiscard() {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: initialValue },
    });
    setIsDirty(false);
    onDiscard?.();
  }

  // Covered: nothing the editor opened stays open over what covers it. The
  // popovers are portalled to the body, so the inertness of what holds the
  // editor does not reach them; the toolbar's menus go with the toolbar as
  // focus leaves the editor.
  useEffect(() => {
    if (!dismissed) return;
    setLinkAnchor(null);
    footnotes.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed]);

  // Open link popover at cursor position
  function openLinkPopover() {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    setLinkSelectedText(selected);

    setLinkAnchor(caretAnchor(view, from, popoverFallback));
  }

  /** Closes the link popover and gives focus back to the text. */
  function closeLinkPopover() {
    setLinkAnchor(null);
    viewRef.current?.focus();
  }

  /** Closes a link popover whose place scrolled away, without scrolling back to it. */
  function detachLinkPopover() {
    setLinkAnchor(null);
    const view = viewRef.current;
    if (view?.dom.isConnected) view.contentDOM.focus({ preventScroll: true });
  }

  function handleLinkInsert(url: string) {
    const view = viewRef.current;
    if (!view) return;
    insertLink(view, url, linkSelectedText || undefined);
    closeLinkPopover();
  }

  function closeImageDialog() {
    const target = carouselImageTarget.current;
    if (target) releaseBookmark(target.view, target.bookmark);
    carouselImageTarget.current = null;
    setImageDialogOpen(false);
  }

  function handleImageInsert(url: string, alt: string) {
    // An empty address would erase a carousel image or insert `![alt]()`.
    if (!url) return;
    const target = carouselImageTarget.current;
    if (target) {
      undoManager?.stopCapturing();
      replaceBookmarkedField(target.view, target.bookmark, url);
      undoManager?.stopCapturing();
      closeImageDialog();
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    insertImage(view, url, alt);
    setImageDialogOpen(false);
  }

  /** Bold or italic on the focused widget field, or else on the text. */
  function wrapSelection(marker: string) {
    const view = viewRef.current;
    if (view && !wrapFocusedField(view, marker)) insertMarkdownWrap(view, marker);
  }

  function panelExtensions() {
    if (!enablePanelAuthoring) return [];
    const options: PanelOptions = {
      footnoteName: t("footnote.button"),
      openFootnote: (from) => footnotes.edit(from),
      siteBaseUrl,
      pickImage: (field) => {
        const view = viewRef.current;
        if (!view || view.state.readOnly) return;
        carouselImageTarget.current = { view, bookmark: bookmarkField(view, field) };
        setImageDialogOpen(true);
      },
    };
    return [
      panelAuthoring(options),
      previewCompartment.current.of(panelOptions.of({ preview: previewRef.current })),
    ];
  }

  // SSR guard — mark mounted on client so hooks run consistently
  useEffect(() => {
    setMounted(true);
  }, []);

  // A glossary chip opens its term entry; an unresolved `[[term]]` token
  // quick-creates the term. Cmd/Ctrl-click falls through, so a future "open
  // in new context" gesture stays available.
  function handleGlossaryClick(target: HTMLElement): (() => void) | null {
    const termId = (target.closest(".cm-glossary-chip") as HTMLElement | null)?.dataset.termId;
    const onChip = onChipClickRef.current;
    if (termId && onChip) return () => onChip(termId);
    const unresolved = target.closest(".cm-glossary-unresolved");
    const slug = unresolved && extractUnresolvedTermId(unresolved.textContent);
    const onUnresolved = onUnresolvedChipClickRef.current;
    return slug && onUnresolved ? () => onUnresolved(slug) : null;
  }

  // Chip, unresolved-token and link clicks, shared by both persistence modes.
  // A plain click on a link keeps the cursor in the editor; Cmd/Ctrl+click
  // lets the <a> open naturally in a new tab.
  function handleEditorClick(event: MouseEvent): boolean {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey) return false;
    const glossary = handleGlossaryClick(target);
    if (!glossary && target.tagName !== "A") return false;
    event.preventDefault();
    glossary?.();
    return true;
  }

  /** Extensions both persistence modes share, in the order they take effect. */
  function commonExtensions(withHistory: boolean) {
    return [
      keymap.of([
        ...defaultKeymap,
        // Collaborative mode has no history(): Y.UndoManager replaces it, and
        // historyKeymap without history() crashes on an undo keypress.
        ...(withHistory ? historyKeymap : []),
        indentWithTab,
        { key: "Mod-b", run: (v: EditorView) => runAndStop(() => insertMarkdownWrap(v, "**")) },
        { key: "Mod-i", run: (v: EditorView) => runAndStop(() => insertMarkdownWrap(v, "_")) },
        { key: "Mod-k", run: () => runAndStop(openLinkPopover) },
      ]),
      markdown(),
      EditorView.lineWrapping,
      livePreviewPlugin,
      // Glossary `[[term]]` chips — only on the three link-bearing surfaces.
      // glossaryMapField carries the term_id→title map dispatched from the Y.Array observer.
      ...(enableGlossaryLinks ? [glossaryMapField, glossaryChipPlugin] : []),
      ...footnotes.extensions,
      ...panelExtensions(),
      richPasteExtension,
      cleanPasteExtension,
      ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      EditorView.domEventHandlers({
        focus: () => {
          setIsFocused(true);
          return false;
        },
        blur: (event) => {
          // Focus going to the toolbar or to a popover or dialog opened from
          // it is still focus in the editor.
          if (!focusScope.contains(event.relatedTarget as Node | null)) setIsFocused(false);
          return false;
        },
        click: handleEditorClick,
      }),
    ];
  }

  // Non-collaborative fallback: autosave + history()
  function handleContentChange(doc: string) {
    setWordCount(computeWordCount(doc));
    onChangeRef.current?.(doc);
    if (mode === "controlled") return;
    if (mode !== "autosave") {
      // save-discard mode: track dirty state only, no autosave
      setIsDirty(doc !== initialValue);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    const save = () => {
      // For layer autosave (formFieldName === "layerId"), a Yjs-only layer
      // has projectId === 0 and would trip the action's 400 guard.
      // Other call sites post a real project id — leave them unguarded.
      if (formFieldName === "layerId" && !isPersistableLayerId(projectId)) return;
      const sent = keptDraft.sent();
      fetcher
        .submit(
          { intent, field: fieldName, value: doc, [formFieldName]: String(projectId) },
          { method: "post", action: actionUrl }
        )
        .catch((err) => {
          console.error("MarkdownEditor autosave failed", err);
          setSaveFailed(true);
          keptDraft.answered(true, sent);
        });
    };
    const pending = { generation: generationRef.current, send: save };
    pendingSaveRef.current = pending;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (pendingSaveRef.current !== pending || pending.generation !== generationRef.current) return;
      pendingSaveRef.current = null;
      save();
    }, debounceMs);
  }

  /**
   * Collaborative mode: yCollab binds the Y.Text, with the shared doc-level
   * UndoManager from CollaborationContext so text edits and structural ops
   * share one history stack; yCollab takes `false` as the pre-sync
   * placeholder. The readOnly compartment is the publish lock.
   */
  function collaborativeExtensions(shared: Y.Text) {
    return [
      ...commonExtensions(false),
      readOnlyCompartment.current.of(EditorState.readOnly.of(false)),
      yCollab(shared, provider?.awareness ?? null, { undoManager: undoManager ?? false }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const doc = update.state.doc.toString();
        setWordCount(computeWordCount(doc));
        onChangeRef.current?.(doc);
      }),
    ];
  }

  function standaloneExtensions() {
    return [
      history(),
      ...commonExtensions(true),
      readOnlyCompartment.current.of(EditorState.readOnly.of(false)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) handleContentChange(update.state.doc.toString());
      }),
    ];
  }

  // EditorView lifecycle — recreated when mounted or yText instance changes
  useEffect(() => {
    if (!mounted || !containerRef.current) return;
    const generation = ++generationRef.current;
    const view = new EditorView({
      state: EditorState.create({
        doc: yText ? yText.toString() : initialValue,
        extensions: yText ? collaborativeExtensions(yText) : standaloneExtensions(),
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    if (refocusRef.current) focusNewView(view, yText);
    // Glossary chip resolution: installGlossaryResolution observes the
    // glossary Y.Array and pushes the term_id→title map into the view (never a
    // doc edit), deferred out of the update cycle: editing a definition
    // mutates the array it observes, and a synchronous dispatch there would
    // crash yCollab's sync mid-update and drop typed text
    // (telar-compositor#26). No-op without a ydoc (SSR / pre-connection).
    const detachGlossary = enableGlossaryLinks && ydoc ? installGlossaryResolution(view, ydoc) : undefined;
    return () => {
      // The view ends by unmounting when its Y.Text is still the one asked
      // for, and by being replaced otherwise.
      const unmounting = latestYText.current === yText;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (unmounting && pending?.generation === generation) pending.send();
      if (!unmounting && !yText) keptDraft.replaced(view.state.doc.toString(), latestYText.current, !!pending, saveFailedRef.current);
      if (!unmounting) focusNewView.replaced(view);
      refocusRef.current = view.hasFocus;
      detachGlossary?.();
      footnotes.reset();
      closeImageDialog();
      viewRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, yText]);

  // The site's preview settings: resolved from the loader's promise, and
  // unavailable when there are none or they fail.
  useEffect(() => {
    if (!enablePanelAuthoring) return;
    let current = true;
    setPreview(undefined);
    Promise.resolve(panelPreview ?? unavailablePanelPreview())
      .catch(() => unavailablePanelPreview())
      .then((config) => {
        if (current) setPreview(config);
      });
    return () => {
      current = false;
    };
  }, [enablePanelAuthoring, panelPreview]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: previewCompartment.current.reconfigure(panelOptions.of({ preview })),
    });
  }, [preview]);

  const locked = usePublishLock(viewRef, readOnlyCompartment.current, { isPublishing, binding: yText, lockWhilePublishing });

  if (!mounted) {
    return (
      <div className={`relative ${className}`}>
        <div className="min-h-[3rem]" />
      </div>
    );
  }

  return (
    <FocusScopeContext.Provider value={focusScope}>
    <div
      ref={wrapperRef}
      className={wrapperClassName({ transparent, darkTheme, locked, className })}
    >
      {/* Toolbar — appears on focus (or always if alwaysShowToolbar) */}
      {(isFocused || alwaysShowToolbar) && (
        <div ref={toolbarRef} data-editor-toolbar="" className={`flex flex-wrap items-center gap-0.5 px-4 py-1.5 mb-3 border-b bg-black/5 ${transparent ? "mx-0 mt-0 rounded-t-lg border-gray-200/30" : "-mx-6 -mt-6 border-gray-100/30"}`}>
          <ToolbarButton
            icon={Bold}
            tooltip={t("toolbar.bold")}
            onAction={() => wrapSelection("**")}
            refusing={refusing}
          />
          <ToolbarButton
            icon={Italic}
            tooltip={t("toolbar.italic")}
            onAction={() => wrapSelection("_")}
            refusing={refusing}
          />
          <ToolbarButton
            icon={Link}
            tooltip={t("toolbar.link")}
            onAction={openLinkPopover}
          />
          <ToolbarButton
            icon={Image}
            tooltip={t("toolbar.image")}
            onAction={() => setImageDialogOpen(true)}
          />
          {enableGlossaryLinks && (
            <GlossaryLinkButton editorView={viewRef.current} />
          )}
          {enableFootnotes && (
            <ToolbarButton
              icon={Superscript}
              tooltip={t("footnote.button")}
              disabled={footnotes.disabled}
              onAction={footnotes.open}
            />
          )}
          <PanelToolbar
            enabled={enablePanelAuthoring}
            view={viewRef.current}
            undoManager={undoManager}
            disabled={footnotes.disabled}
            preview={preview}
            refusing={refusing}
          />
          <span className="w-px h-4 bg-gray-200 mx-1" />
          <HeadingMenu viewRef={viewRef} />
          <ToolbarButton
            icon={List}
            tooltip={t("toolbar.bullet_list")}
            onAction={() => viewRef.current && toggleBulletList(viewRef.current)}
          />
          <ToolbarButton
            icon={ListOrdered}
            tooltip={t("toolbar.ordered_list")}
            onAction={() => viewRef.current && toggleOrderedList(viewRef.current)}
          />
          <ToolbarButton
            icon={Quote}
            tooltip={t("toolbar.blockquote")}
            onAction={() => viewRef.current && toggleBlockquote(viewRef.current)}
          />
          <span className="w-px h-4 bg-gray-200 mx-1" />
          <ToolbarButton
            icon={Indent}
            tooltip={t("toolbar.indent")}
            onAction={() => viewRef.current && indentLine(viewRef.current)}
          />
          <ToolbarButton
            icon={Outdent}
            tooltip={t("toolbar.outdent")}
            onAction={() => viewRef.current && outdentLine(viewRef.current)}
          />
          <span className="w-px h-4 bg-gray-200 mx-1" />
          <ToolbarButton
            icon={Undo}
            tooltip={t("toolbar.undo")}
            onAction={() => {
              if (yText) {
                // Shared doc-level manager — also reverses structural ops.
                // In collaborative mode, the global TabNav undo/redo buttons and
                // Ctrl+Z shortcut also drive this same manager.
                undoManager?.undo();
              } else if (viewRef.current) {
                undo(viewRef.current);
              }
            }}
          />
          <ToolbarButton
            icon={Redo}
            tooltip={t("toolbar.redo")}
            onAction={() => {
              if (yText) {
                undoManager?.redo();
              } else if (viewRef.current) {
                redo(viewRef.current);
              }
            }}
          />
        </div>
      )}

      <FieldGoneNotice field={lostField} />
      {/* CodeMirror mount point */}
      <div ref={containerRef} className="flex-1 min-h-0 [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto" />

      {/* Link popover — shown near cursor when Cmd+K or toolbar Link is triggered */}
      {linkAnchor && (
        <LinkPopover
          anchor={linkAnchor}
          selectedText={linkSelectedText}
          onInsert={handleLinkInsert}
          onCancel={closeLinkPopover}
          onDetach={detachLinkPopover}
        />
      )}

      {footnotes.popover}

      {saveFailed && saveErrorMessage && (
        <p role="alert" data-testid="editor-save-error" className="font-body text-xs mt-1 text-terracotta">
          {saveErrorMessage}
        </p>
      )}

      {keptDraft.shown && <KeptDraftNotice draft={keptDraft.shown.text} target={keptDraft.shown.target} onClose={keptDraft.close} />}

      {footer}

      {/* Word count — shown when focused, where the caller wants it */}
      {isFocused && showsWordCount(mode, showWordCount) && (
        <div className={`text-xs text-gray-400 px-4 py-1.5 text-right mt-3 border-t ${transparent ? "mx-0 mb-0 border-gray-200/30" : "-mx-6 -mb-6 border-gray-100"}`}>
          {t("word_count", { count: wordCount })}
        </div>
      )}

      {/* Save/Discard footer — always shown in save-discard mode */}
      {mode === "save-discard" && (
        <div className="flex items-center justify-between -mx-6 -mb-6 px-4 py-2 mt-3 border-t border-gray-200 bg-cream">
          <span className="text-xs font-body text-gray-400">
            {isDirty ? t("save_discard.unsaved") : t("save_discard.saved")}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDiscard}
              disabled={!isDirty}
              className="px-3 py-1 text-xs font-heading font-semibold text-charcoal hover:bg-gray-100 rounded disabled:opacity-40"
            >
              {t("save_discard.discard")}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!isDirty}
              className="px-3 py-1 text-xs font-heading font-semibold text-cream bg-terracotta hover:bg-terracotta/90 rounded-full disabled:opacity-40"
            >
              {t("save_discard.save")}
            </button>
          </div>
        </div>
      )}
    </div>

    {/* Image dialog — rendered outside the overflow-hidden wrapper so it isn't clipped */}
    <ImageInsertDialog
      open={imageDialogOpen}
      onClose={closeImageDialog}
      onInsert={handleImageInsert}
      objects={objects ?? []}
      siteBaseUrl={siteBaseUrl}
      frameworkVersion={frameworkVersion}
    />
    </FocusScopeContext.Provider>
  );
}

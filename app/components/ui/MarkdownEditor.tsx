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
 * @version v1.3.4-beta
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Bold,
  Italic,
  Link,
  Image,
  Heading,
  List,
  ListOrdered,
  Quote,
  Undo,
  Redo,
  ChevronDown,
  Indent,
  Outdent,
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
import {
  insertMarkdownWrap,
  insertLink,
  insertImage,
  toggleHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleBlockquote,
  indentLine,
  outdentLine,
} from "~/components/ui/markdown-editor/commands";
import { LinkPopover } from "~/components/ui/markdown-editor/LinkPopover";
import { ImageInsertDialog } from "~/components/ui/markdown-editor/ImageInsertDialog";
import { GlossaryLinkButton } from "~/components/ui/markdown-editor/GlossaryLinkButton";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { isPersistableLayerId } from "~/lib/yjs-helpers";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MarkdownEditorProps {
  initialValue: string;
  fieldName: string;
  projectId: number;
  intent?: string;
  actionUrl?: string;
  debounceMs?: number;
  className?: string;
  mode?: "autosave" | "save-discard";
  onSave?: (markdown: string) => void;
  onDiscard?: () => void;
  /** Called whenever the dirty state changes — used by LayerPanel for unsaved-changes guard */
  onDirtyChange?: (dirty: boolean) => void;
  /** Object list for the image picker dialog */
  objects?: Array<{ object_id: string; title: string | null; thumbnail: string | null; image_available?: boolean | null }>;
  /** Site base URL for constructing IIIF image URLs in the image picker */
  siteBaseUrl?: string | null;
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
}

// ---------------------------------------------------------------------------
// Toolbar button
// ---------------------------------------------------------------------------

function ToolbarButton({
  icon: Icon,
  tooltip,
  onAction,
}: {
  icon: React.ElementType;
  tooltip: string;
  onAction: () => void;
}) {
  return (
    <button
      type="button"
      title={tooltip}
      onMouseDown={(e) => {
        e.preventDefault(); // Prevent stealing focus from the editor
        onAction();
      }}
      className="p-1.5 text-gray-500 hover:text-charcoal hover:bg-cream-dark rounded transition-colors"
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Word count utility (pure — exported for tests via MarkdownEditor.test.tsx)
// ---------------------------------------------------------------------------

function computeWordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/**
 * Extract the `term_id` (group 1, trimmed) from an unresolved `[[term]]` /
 * `[[term|display]]` token's raw text content. Returns null when the text does
 * not match the locked glossary link shape. Mirrors the `LINK_RE` used by the
 * chip plugin so a clicked `cm-glossary-unresolved` range resolves to the same
 * slug the quick-create op will use.
 */
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
  onDiscard,
  onDirtyChange,
  objects,
  siteBaseUrl,
  transparent = false,
  darkTheme = false,
  yText = null,
  alwaysShowToolbar = false,
  enableGlossaryLinks = false,
  onChipClick,
  onUnresolvedChipClick,
  formFieldName = "projectId",
  placeholder,
}: MarkdownEditorProps) {
  const [mounted, setMounted] = useState(false);
  const { t } = useTranslation("editor");
  const fetcher = useFetcher();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compartment for toggling readOnly during publish lock
  const readOnlyCompartment = useRef(new Compartment());

  const [isFocused, setIsFocused] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [wordCount, setWordCount] = useState(computeWordCount(initialValue));
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [linkPopoverPos, setLinkPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const [linkSelectedText, setLinkSelectedText] = useState("");
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [headingMenuOpen, setHeadingMenuOpen] = useState(false);
  const headingMenuRef = useRef<HTMLDivElement>(null);

  // Collaboration context — provider.awareness for cursor sync; isPublishing for publish lock;
  // undoManager is the shared doc-level Y.UndoManager so that undo/redo spans text edits and
  // structural operations alike. In non-collaborative mode (no yText), CodeMirror's
  // built-in history() is used instead.
  const { ydoc, provider, isPublishing, undoManager } = useCollaborationContext();

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

  // Close heading menu on outside click
  useEffect(() => {
    if (!headingMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (headingMenuRef.current && !headingMenuRef.current.contains(e.target as Node)) {
        setHeadingMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [headingMenuOpen]);

  // Open link popover at cursor position
  function openLinkPopover() {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    setLinkSelectedText(selected);

    const coords = view.coordsAtPos(from);
    if (coords) {
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      if (wrapperRect) {
        setLinkPopoverPos({
          top: coords.bottom - wrapperRect.top + 4,
          left: coords.left - wrapperRect.left,
        });
      }
    }
    setLinkPopoverOpen(true);
  }

  function handleLinkInsert(url: string) {
    const view = viewRef.current;
    if (!view) return;
    insertLink(view, url, linkSelectedText || undefined);
    setLinkPopoverOpen(false);
    setLinkPopoverPos(null);
  }

  function handleImageInsert(url: string, alt: string) {
    const view = viewRef.current;
    if (!view) return;
    insertImage(view, url, alt);
    setImageDialogOpen(false);
  }

  // SSR guard — mark mounted on client so hooks run consistently
  useEffect(() => {
    setMounted(true);
  }, []);

  // Debounce timer cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // EditorView lifecycle — recreated when mounted or yText instance changes
  useEffect(() => {
    if (!mounted || !containerRef.current) return;

    // Glossary chip resolution: keep a term_id→title map in the view so the chip
    // plugin can resolve [[term]] tokens. installGlossaryResolution observes the
    // glossary Y.Array and pushes the map via setGlossaryMap (view-only — never a
    // doc edit). Its dispatch is DEFERRED out of the update cycle: editing a
    // glossary definition mutates the same array it observes, so a synchronous
    // dispatch there would crash yCollab's sync mid-update and drop typed text
    // (telar-compositor#26). No-op when there is no ydoc (SSR / pre-connection).
    function attachGlossaryResolution(view: EditorView): () => void {
      if (!ydoc) return () => {};
      return installGlossaryResolution(view, ydoc);
    }

    // Collaborative mode: build extensions with yCollab; remove history() and autosave.
    // The shared doc-level UndoManager from CollaborationContext is passed to yCollab so
    // that undo/redo for text edits in this editor is interleaved with structural ops on
    // the same history stack. Per-editor UndoManagers were removed earlier.
    if (yText) {
      const view = new EditorView({
        state: EditorState.create({
          doc: yText.toString(),
          extensions: [
            // history() and historyKeymap intentionally omitted — Y.UndoManager replaces them
            // (Anti-pattern: keeping historyKeymap without history() crashes on undo keypress)
            keymap.of([
              ...defaultKeymap,
              // historyKeymap intentionally omitted — Y.UndoManager replaces CodeMirror history
              indentWithTab,
              {
                key: "Mod-b",
                run: (v) => {
                  insertMarkdownWrap(v, "**");
                  return true;
                },
              },
              {
                key: "Mod-i",
                run: (v) => {
                  insertMarkdownWrap(v, "_");
                  return true;
                },
              },
              {
                key: "Mod-k",
                run: () => {
                  openLinkPopover();
                  return true;
                },
              },
            ]),
            markdown(),
            EditorView.lineWrapping,
            livePreviewPlugin,
            // Glossary `[[term]]` chips — only on the three link-bearing surfaces.
            // glossaryMapField carries the term_id→title map dispatched from the Y.Array observer.
            ...(enableGlossaryLinks ? [glossaryMapField, glossaryChipPlugin] : []),
            richPasteExtension,
            ...(placeholder ? [cmPlaceholder(placeholder)] : []),
            // Publish-lock compartment — reconfigured by isPublishing effect below
            readOnlyCompartment.current.of(EditorState.readOnly.of(false)),
            // yCollab binds Y.Text to CodeMirror; awareness enables cursor sync.
            // undoManager is the shared doc-level manager from CollaborationContext — yCollab
            // tracks the origin of changes so structural ops and text edits share one stack.
            // yCollab's option accepts UndoManager | false (pass false to disable yCollab's
            // internal undo wiring); use false as the pre-sync placeholder.
            yCollab(yText, provider?.awareness ?? null, { undoManager: undoManager ?? false }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                setWordCount(computeWordCount(update.state.doc.toString()));
              }
            }),
            EditorView.domEventHandlers({
              focus: () => {
                setIsFocused(true);
                return false;
              },
              blur: (event) => {
                const relatedTarget = event.relatedTarget as Node | null;
                if (!wrapperRef.current?.contains(relatedTarget)) {
                  setIsFocused(false);
                }
                return false;
              },
              click(event) {
                const target = event.target as HTMLElement;
                // Glossary chip click — open the term entry. Cmd/Ctrl-click falls
                // through so a future "open in new context" gesture stays available.
                const chip = target.closest(".cm-glossary-chip") as HTMLElement | null;
                if (chip && !event.metaKey && !event.ctrlKey) {
                  const termId = chip.dataset.termId;
                  if (termId && onChipClickRef.current) {
                    event.preventDefault();
                    onChipClickRef.current(termId);
                    return true;
                  }
                }
                // Unresolved `[[term]]` token click — quick-create the term.
                const unresolved = target.closest(
                  ".cm-glossary-unresolved",
                ) as HTMLElement | null;
                if (unresolved && !event.metaKey && !event.ctrlKey) {
                  const termId = extractUnresolvedTermId(unresolved.textContent);
                  if (termId && onUnresolvedChipClickRef.current) {
                    event.preventDefault();
                    onUnresolvedChipClickRef.current(termId);
                    return true;
                  }
                }
                if (target.tagName === "A" && (event.metaKey || event.ctrlKey)) {
                  return false;
                }
                if (target.tagName === "A") {
                  event.preventDefault();
                  return true;
                }
                return false;
              },
            }),
          ],
        }),
        parent: containerRef.current,
      });

      viewRef.current = view;
      // Push the initial glossary resolution map + subscribe for live updates.
      const detachGlossary = enableGlossaryLinks
        ? attachGlossaryResolution(view)
        : undefined;
      return () => {
        detachGlossary?.();
        view.destroy();
      };
    }

    // Non-collaborative fallback: autosave + history() unchanged
    function handleContentChange(doc: string) {
      setWordCount(computeWordCount(doc));
      if (mode === "autosave") {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          // For layer autosave (formFieldName === "layerId"), a Yjs-only layer
          // has projectId === 0 and would trip the action's 400 guard.
          // Other call sites post a real project id — leave them unguarded.
          if (
            formFieldName === "layerId" &&
            !isPersistableLayerId(projectId)
          ) {
            return;
          }
          fetcher
            .submit(
              {
                intent,
                field: fieldName,
                value: doc,
                [formFieldName]: String(projectId),
              },
              { method: "post", action: actionUrl }
            )
            .catch((err) => {
              console.error("MarkdownEditor autosave failed", err);
            });
        }, debounceMs);
      } else {
        // save-discard mode: track dirty state only, no autosave
        setIsDirty(doc !== initialValue);
      }
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          history(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
            {
              key: "Mod-b",
              run: (v) => {
                insertMarkdownWrap(v, "**");
                return true;
              },
            },
            {
              key: "Mod-i",
              run: (v) => {
                insertMarkdownWrap(v, "_");
                return true;
              },
            },
            {
              key: "Mod-k",
              run: () => {
                openLinkPopover();
                return true;
              },
            },
          ]),
          markdown(),
          EditorView.lineWrapping,
          livePreviewPlugin,
          // Glossary `[[term]]` chips — mirror the collaborative branch, same gate.
          ...(enableGlossaryLinks ? [glossaryMapField, glossaryChipPlugin] : []),
          richPasteExtension,
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              handleContentChange(update.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({
            focus: () => {
              setIsFocused(true);
              return false;
            },
            blur: (event) => {
              // Only blur if focus leaves the entire wrapper
              const relatedTarget = event.relatedTarget as Node | null;
              if (!wrapperRef.current?.contains(relatedTarget)) {
                setIsFocused(false);
              }
              return false;
            },
            click(event) {
              const target = event.target as HTMLElement;
              // Glossary chip click — open the term entry.
              const chip = target.closest(".cm-glossary-chip") as HTMLElement | null;
              if (chip && !event.metaKey && !event.ctrlKey) {
                const termId = chip.dataset.termId;
                if (termId && onChipClickRef.current) {
                  event.preventDefault();
                  onChipClickRef.current(termId);
                  return true;
                }
              }
              // Unresolved `[[term]]` token click — quick-create the term.
              const unresolved = target.closest(
                ".cm-glossary-unresolved",
              ) as HTMLElement | null;
              if (unresolved && !event.metaKey && !event.ctrlKey) {
                const termId = extractUnresolvedTermId(unresolved.textContent);
                if (termId && onUnresolvedChipClickRef.current) {
                  event.preventDefault();
                  onUnresolvedChipClickRef.current(termId);
                  return true;
                }
              }
              if (target.tagName === "A" && (event.metaKey || event.ctrlKey)) {
                // Cmd/Ctrl+click — let the <a> tag open naturally in a new tab
                return false;
              }
              if (target.tagName === "A") {
                // Regular click on a link — prevent navigation, keep cursor in editor
                event.preventDefault();
                return true;
              }
              return false;
            },
          }),
        ],
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;
    const detachGlossary = enableGlossaryLinks
      ? attachGlossaryResolution(view)
      : undefined;
    return () => {
      detachGlossary?.();
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, yText]);

  // Publish-lock: reconfigure the readOnly compartment when isPublishing changes
  // Only active in collaborative mode (yText provided) — non-collaborative editors are not locked
  useEffect(() => {
    if (!yText || !viewRef.current) return;
    viewRef.current.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(isPublishing)
      ),
    });
  }, [isPublishing, yText]);

  if (!mounted) {
    return (
      <div className={`relative ${className}`}>
        <div className="min-h-[3rem]" />
      </div>
    );
  }

  return (
    <>
    <div
      ref={wrapperRef}
      className={`relative ${transparent ? "cm-transparent" : ""} ${darkTheme ? "cm-dark-theme" : ""} ${isPublishing && yText ? "opacity-50" : ""} ${className}`}
    >
      {/* Toolbar — appears on focus (or always if alwaysShowToolbar) */}
      {(isFocused || alwaysShowToolbar) && (
        <div className={`flex items-center gap-0.5 px-4 py-1.5 mb-3 border-b bg-black/5 ${transparent ? "mx-0 mt-0 rounded-t-lg border-gray-200/30" : "-mx-6 -mt-6 border-gray-100/30"}`}>
          <ToolbarButton
            icon={Bold}
            tooltip={t("toolbar.bold")}
            onAction={() => viewRef.current && insertMarkdownWrap(viewRef.current, "**")}
          />
          <ToolbarButton
            icon={Italic}
            tooltip={t("toolbar.italic")}
            onAction={() => viewRef.current && insertMarkdownWrap(viewRef.current, "_")}
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
          <span className="w-px h-4 bg-gray-200 mx-1" />
          {/* Heading dropdown */}
          <div ref={headingMenuRef} className="relative">
            <button
              type="button"
              title={t("toolbar.heading")}
              onMouseDown={(e) => {
                e.preventDefault();
                setHeadingMenuOpen((v) => !v);
              }}
              className="flex items-center gap-0.5 p-1.5 text-gray-500 hover:text-charcoal hover:bg-cream-dark rounded transition-colors"
            >
              <Heading className="w-4 h-4" />
              <ChevronDown className="w-3 h-3" />
            </button>
            {headingMenuOpen && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-md shadow-md z-10 py-1 min-w-[7rem]">
                {([1, 2, 3, 4] as const).map((level) => (
                  <button
                    key={level}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (viewRef.current) toggleHeading(viewRef.current, level);
                      setHeadingMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-1.5 font-heading text-sm text-charcoal hover:bg-cream-dark transition-colors"
                  >
                    {t("toolbar.heading_level", { level })}
                  </button>
                ))}
              </div>
            )}
          </div>
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

      {/* CodeMirror mount point */}
      <div ref={containerRef} className="flex-1 min-h-0 [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto" />

      {/* Link popover — shown near cursor when Cmd+K or toolbar Link is triggered */}
      {linkPopoverOpen && linkPopoverPos && (
        <LinkPopover
          position={linkPopoverPos}
          selectedText={linkSelectedText}
          onInsert={handleLinkInsert}
          onCancel={() => {
            setLinkPopoverOpen(false);
            setLinkPopoverPos(null);
          }}
        />
      )}

      {/* Word count — shown when focused (autosave mode only) */}
      {isFocused && mode === "autosave" && (
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
      onClose={() => setImageDialogOpen(false)}
      onInsert={handleImageInsert}
      objects={objects ?? []}
      siteBaseUrl={siteBaseUrl}
    />
    </>
  );
}

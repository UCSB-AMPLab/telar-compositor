/**
 * MarkdownEditor — CodeMirror 6 markdown editor with Obsidian-style live preview.
 *
 * Replaces MilkdownField with a superset API. Features:
 * - Obsidian-style live preview: syntax markers hide on non-cursor lines
 * - Formatting toolbar (bold, italic, link, image, heading, lists, blockquote, undo, redo)
 * - Keyboard shortcuts: Cmd+B, Cmd+I, Cmd+K, Cmd+Z, Cmd+Shift+Z
 * - Rich paste: HTML from web pages converts to markdown via turndown
 * - Word count displayed when editor is focused (autosave mode)
 * - Debounced autosave via useFetcher (autosave mode)
 * - Save/Discard footer with dirty tracking (save-discard mode)
 * - Link popover: opens near cursor on Cmd+K or toolbar click; inserts markdown link
 * - Image dialog: URL tab and Objects tab for inserting markdown images
 * - Cmd/Ctrl+click on rendered links opens in new tab
 * - SSR guard: returns null during server-side render
 * - Placed in app/components/ui/ as a shared primitive for dashboard and story editor
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
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo, redo, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

import { livePreviewPlugin } from "~/components/ui/markdown-editor/livePreviewPlugin";
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
  /** Object list for the image picker dialog (Plan 02) */
  objects?: Array<{ object_id: string; title: string | null; thumbnail: string | null; image_available?: boolean | null }>;
  /** Make editor background transparent (for coloured panel backgrounds) */
  transparent?: boolean;
  /** Use light colours for toolbar/text on dark backgrounds */
  darkTheme?: boolean;
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
  transparent = false,
  darkTheme = false,
}: MarkdownEditorProps) {
  const [mounted, setMounted] = useState(false);
  const { t } = useTranslation("editor");
  const fetcher = useFetcher();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isFocused, setIsFocused] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [wordCount, setWordCount] = useState(computeWordCount(initialValue));
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [linkPopoverPos, setLinkPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const [linkSelectedText, setLinkSelectedText] = useState("");
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [headingMenuOpen, setHeadingMenuOpen] = useState(false);
  const headingMenuRef = useRef<HTMLDivElement>(null);

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

  // EditorView lifecycle — mount once client is ready
  useEffect(() => {
    if (!mounted || !containerRef.current) return;

    function handleContentChange(doc: string) {
      setWordCount(computeWordCount(doc));
      if (mode === "autosave") {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          fetcher.submit(
            {
              intent,
              field: fieldName,
              value: doc,
              projectId: String(projectId),
            },
            { method: "post", action: actionUrl }
          );
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
          richPasteExtension,
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
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

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
      className={`relative ${transparent ? "cm-transparent" : ""} ${darkTheme ? "cm-dark-theme" : ""} ${className}`}
    >
      {/* Toolbar — appears on focus */}
      {isFocused && (
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
            onAction={() => viewRef.current && undo(viewRef.current)}
          />
          <ToolbarButton
            icon={Redo}
            tooltip={t("toolbar.redo")}
            onAction={() => viewRef.current && redo(viewRef.current)}
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
    />
    </>
  );
}

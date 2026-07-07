/**
 * GlossaryLinkButton — toolbar button for inserting [[term_id]] glossary links
 * into the CodeMirror editor.
 *
 * Opens a term picker dialog backed by the Yjs glossary array. Inserts
 * [[term_id]] or [[term_id|custom text]] at the current cursor position.
 *
 * Only rendered when the MarkdownEditor receives enableGlossaryLinks={true}.
 */

import { useState, useMemo } from "react";
import { BookA } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";

import { useCollaborationContext } from "~/hooks/use-collaboration";
import { Dialog } from "~/components/ui/Dialog";

interface GlossaryLinkButtonProps {
  editorView: EditorView | null;
  className?: string;
}

interface GlossaryTerm {
  term_id: string;
  title: string;
}

export function GlossaryLinkButton({ editorView, className = "" }: GlossaryLinkButtonProps) {
  const { t } = useTranslation("glossary");
  const { ydoc } = useCollaborationContext();

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedTermId, setSelectedTermId] = useState<string | null>(null);
  const [useCustomText, setUseCustomText] = useState(false);
  const [customText, setCustomText] = useState("");

  // Read terms from Yjs glossary array
  const allTerms = useMemo((): GlossaryTerm[] => {
    if (!ydoc) return [];
    const glossaryArray = ydoc.getArray("glossary");
    const rawItems = glossaryArray.toArray() as Array<Record<string, unknown> | Y.Map<unknown>>;
    const terms: GlossaryTerm[] = rawItems.map((item) => {
      if (item instanceof Y.Map) {
        const termId = item.get("term_id");
        const title = item.get("title");
        return {
          term_id: termId instanceof Y.Text ? termId.toString() : String(termId ?? ""),
          title: title instanceof Y.Text ? title.toString() : String(title ?? ""),
        };
      }
      return {
        term_id: String(item["term_id"] ?? ""),
        title: String(item["title"] ?? ""),
      };
    });
    return terms
      .filter((t) => t.term_id)
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [ydoc, open]); // re-read when dialog opens

  const filteredTerms = useMemo(() => {
    if (!search.trim()) return allTerms;
    const q = search.toLowerCase();
    return allTerms.filter(
      (t) => t.title.toLowerCase().includes(q) || t.term_id.toLowerCase().includes(q),
    );
  }, [allTerms, search]);

  function handleOpen() {
    // Read selected text from the editor — assume user wants to replace it
    let selection = "";
    if (editorView) {
      const { from, to } = editorView.state.selection.main;
      if (from !== to) {
        selection = editorView.state.sliceDoc(from, to);
      }
    }
    setSearch("");
    setSelectedTermId(null);
    setUseCustomText(!!selection);
    setCustomText(selection);
    setOpen(true);
  }

  function handleInsert() {
    if (!selectedTermId || !editorView) return;

    const insertion =
      useCustomText && customText.trim()
        ? `[[${selectedTermId}|${customText.trim()}]]`
        : `[[${selectedTermId}]]`;

    const { from, to } = editorView.state.selection.main;
    editorView.dispatch({
      changes: { from, to, insert: insertion },
      selection: { anchor: from + insertion.length },
    });
    editorView.focus();
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        title={t("insert_link_button")}
        onMouseDown={(e) => {
          e.preventDefault(); // Prevent stealing focus from the editor
          handleOpen();
        }}
        className={`p-1.5 text-gray-500 hover:text-charcoal hover:bg-cream-dark rounded transition-colors ${className}`}
      >
        <BookA className="w-4 h-4" />
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-md p-6">
        <h2 className="font-heading font-semibold text-lg text-charcoal mb-4">
          {t("insert_link_button")}
        </h2>

        {/* Search input */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("search_terms_placeholder")}
          className="border border-gray-200 rounded-md px-3 py-1.5 text-sm w-full mb-2 font-body text-charcoal"
          autoFocus
        />

        {/* Term list */}
        <div className="max-h-[300px] overflow-y-auto border border-gray-100 rounded-md mb-3">
          {filteredTerms.length === 0 ? (
            <p className="font-body text-sm text-gray-400 text-center py-6">
              {search ? t("link_button.no_match") : t("link_button.no_terms")}
            </p>
          ) : (
            filteredTerms.map((term) => (
              <button
                key={term.term_id}
                type="button"
                onClick={() => setSelectedTermId(term.term_id)}
                className={`w-full text-left px-3 py-2 border-b border-gray-50 last:border-0 transition-colors ${
                  selectedTermId === term.term_id
                    ? "bg-anil/20"
                    : "hover:bg-cream-dark/50"
                }`}
              >
                <div className="font-body text-sm text-charcoal">{term.title || t("common:untitled")}</div>
                <div className="font-body text-xs text-gray-400">{term.term_id}</div>
              </button>
            ))
          )}
        </div>

        {/* Custom text toggle */}
        <label className="flex items-center gap-2 mb-3 cursor-pointer">
          <input
            type="checkbox"
            checked={useCustomText}
            onChange={(e) => setUseCustomText(e.target.checked)}
            className="rounded border-gray-300 text-anil"
          />
          <span className="font-body text-sm text-charcoal">{t("custom_text_toggle")}</span>
        </label>

        {useCustomText && (
          <input
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder={t("custom_display_placeholder")}
            className="border border-gray-200 rounded-md px-3 py-1.5 text-sm w-full mb-3 font-body text-charcoal"
          />
        )}

        {/* Preview */}
        {selectedTermId && (
          <p className="font-body text-xs text-gray-400 mb-3">
            {t("link_button.inserts")}
            <code className="text-charcoal bg-cream-dark px-1 rounded">
              {useCustomText && customText.trim()
                ? `[[${selectedTermId}|${customText.trim()}]]`
                : `[[${selectedTermId}]]`}
            </code>
          </p>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="font-heading font-semibold text-sm uppercase tracking-wider text-charcoal border border-gray-200 rounded-full px-4 py-2 hover:bg-gray-50 transition-colors"
          >
            {t("common:cancel")}
          </button>
          <button
            type="button"
            onClick={handleInsert}
            disabled={!selectedTermId}
            className="font-heading font-semibold text-sm uppercase tracking-wider text-charcoal bg-anil hover:bg-anil-hover rounded-full px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("insert_link_button")}
          </button>
        </div>
      </Dialog>
    </>
  );
}

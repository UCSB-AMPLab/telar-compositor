/**
 * GlossaryLinkButton — toolbar button for inserting [[term_id]] glossary links
 * into the CodeMirror editor.
 *
 * Opens a term picker dialog (GlossaryEntryPicker) backed by the Yjs glossary array. Inserts
 * [[term_id]] or [[term_id|custom text]] at the current cursor position.
 *
 * Only rendered when the MarkdownEditor receives enableGlossaryLinks={true}.
 *
 * The custom text is escaped as `escapeGlossaryDisplay` states. A selection
 * it opens on is shown with the entities that escaping writes decoded, so
 * text the Compositor wrote reads back as the author typed it.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { BookA } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EditorView } from "@codemirror/view";

import { Dialog } from "~/components/ui/Dialog";
import { toolbarPress } from "~/components/ui/markdown-editor/toolbar-press";
import { decodeWrittenEntities, glossaryReference } from "~/components/ui/markdown-editor/authorText";
import { GlossaryEntryPicker } from "~/components/ui/markdown-editor/GlossaryEntryPicker";

interface GlossaryLinkButtonProps {
  editorView: EditorView | null;
  className?: string;
}

export function GlossaryLinkButton({ editorView, className = "" }: GlossaryLinkButtonProps) {
  const { t } = useTranslation("glossary");

  const [open, setOpen] = useState(false);
  const [selectedTermId, setSelectedTermId] = useState<string | null>(null);
  const [useCustomText, setUseCustomText] = useState(false);
  const [customText, setCustomText] = useState("");

  function handleOpen() {
    // Read selected text from the editor — assume user wants to replace it
    let selection = "";
    if (editorView) {
      const { from, to } = editorView.state.selection.main;
      if (from !== to) {
        selection = editorView.state.sliceDoc(from, to);
      }
    }
    setSelectedTermId(null);
    setUseCustomText(!!selection);
    setCustomText(decodeWrittenEntities(selection));
    setOpen(true);
  }

  function handleInsert() {
    if (!selectedTermId || !editorView) return;

    const insertion = glossaryReference(selectedTermId, useCustomText ? customText : undefined);

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
        {...toolbarPress(handleOpen)}
        className={`p-1.5 text-gray-500 hover:text-charcoal hover:bg-cream-dark rounded transition-colors ${className}`}
      >
        <BookA className="w-4 h-4" />
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-md p-6">
        <h2 className="font-heading font-semibold text-lg text-charcoal mb-4">
          {t("insert_link_button")}
        </h2>

        <GlossaryEntryPicker selected={selectedTermId} onSelect={setSelectedTermId} />

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
              {glossaryReference(selectedTermId, useCustomText ? customText : undefined)}
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

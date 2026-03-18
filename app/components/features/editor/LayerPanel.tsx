/**
 * LayerPanel — slide-in overlay panel for editing a story layer.
 *
 * Renders as an absolute overlay within the ViewerColumn's `children` slot.
 * Uses autosave mode — title and content save automatically.
 * Layer 1 = lavender, Layer 2 = terracotta. Stacked card effect.
 * Navigation: "← BACK" pill on both layers and X close.
 * Editor background matches panel colour — no white box.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";
import { Trash2, X, ArrowLeft, ChevronRight, Pencil, Check } from "lucide-react";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { Dialog } from "~/components/ui/Dialog";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LayerPanelProps {
  layer: {
    id: number;
    layer_number: number;
    title: string | null;
    button_label: string | null;
    content: string | null;
  };
  open: boolean;
  onClose: () => void;
  onDelete: (layerId: number) => void;
  canDelete: boolean;
  hasLayer2: boolean;
  /** Layer 2 data — used to show its button label on the "Open" button */
  layer2ButtonLabel?: string | null;
  /** Layer 2 ID — for autosaving its button label */
  layer2Id?: number;
  onCreateLayer2?: () => void;
  onOpenLayer2?: () => void;
  objects: Array<{ object_id: string; title: string | null; thumbnail: string | null; image_available?: boolean | null }>;
  actionUrl: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LayerPanel({
  layer,
  open,
  onClose,
  onDelete,
  canDelete,
  hasLayer2,
  layer2ButtonLabel,
  layer2Id,
  onCreateLayer2,
  onOpenLayer2,
  objects,
  actionUrl,
}: LayerPanelProps) {
  const { t } = useTranslation("editor");
  const titleFetcher = useFetcher();
  const l2LabelFetcher = useFetcher();

  const defaultTitle =
    layer.layer_number === 1
      ? t("layer.default_title_1")
      : t("layer.default_title_2");

  const [panelTitle, setPanelTitle] = useState(
    layer.title ?? defaultTitle
  );
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Inline edit state for layer 2 button label
  const [editingL2Label, setEditingL2Label] = useState(false);
  const [l2Label, setL2Label] = useState(layer2ButtonLabel ?? t("layer.default_label_2"));
  const l2InputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingL2Label && l2InputRef.current) {
      l2InputRef.current.focus();
      l2InputRef.current.select();
    }
  }, [editingL2Label]);

  // Debounced autosave for panel title
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTitleChange = useCallback(
    (value: string) => {
      setPanelTitle(value);
      if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
      titleTimerRef.current = setTimeout(() => {
        titleFetcher.submit(
          {
            intent: "autosave-layer",
            field: "title",
            value,
            projectId: String(layer.id),
          },
          { method: "post", action: actionUrl }
        );
      }, 1500);
    },
    [layer.id, actionUrl, titleFetcher]
  );

  function handleSaveL2Label() {
    setEditingL2Label(false);
    const trimmed = l2Label.trim() || t("layer.default_label_2");
    setL2Label(trimmed);
    if (layer2Id) {
      l2LabelFetcher.submit(
        {
          intent: "autosave-layer",
          field: "button_label",
          value: trimmed,
          projectId: String(layer2Id),
        },
        { method: "post", action: actionUrl }
      );
    }
  }

  // Visual theme per layer number
  const isLayer1 = layer.layer_number === 1;
  const panelBg = isLayer1 ? "bg-lavender" : "bg-terracotta";
  const panelBorder = isLayer1 ? "border-lavender" : "border-terracotta";
  const labelColor = isLayer1 ? "text-charcoal/60" : "text-cream/70";
  const borderColor = isLayer1 ? "border-charcoal/10" : "border-cream/20";
  const inputBg = isLayer1
    ? "bg-lavender/50 border-charcoal/15 text-charcoal placeholder-charcoal/40"
    : "bg-terracotta/80 border-cream/20 text-cream placeholder-cream/50";
  const backBtnStyle = isLayer1
    ? "bg-charcoal/10 text-charcoal/70 hover:bg-charcoal/20"
    : "bg-cream/20 text-cream hover:bg-cream/30";
  // Layer 1 leaves a sliver of image visible on the left; layer 2 offset by same gap
  const panelInset = isLayer1
    ? "left-[3%] right-0 top-0 bottom-0"
    : "left-[6%] right-0 top-0 bottom-0";
  const panelZ = isLayer1 ? "z-20" : "z-30";

  function handleDeleteClick() {
    if (!canDelete) return;
    setShowDeleteDialog(true);
  }

  function handleConfirmDelete() {
    setShowDeleteDialog(false);
    onDelete(layer.id);
  }

  return (
    <>
      {/* Slide-in panel */}
      <div
        className={`absolute ${panelInset} ${panelZ} ${panelBg} flex flex-col transition-transform duration-300 ease-in-out shadow-[-4px_0_16px_rgba(0,0,0,0.12)] border-l-4 ${panelBorder} ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Navigation bar */}
        <div className="flex items-center justify-between px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 font-heading font-semibold text-xs uppercase tracking-wider rounded-full transition-colors ${backBtnStyle}`}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {t("layer.back")}
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={handleDeleteClick}
                className={`p-1.5 ${isLayer1 ? "text-charcoal/40 hover:text-red-600" : "text-cream/50 hover:text-red-300"} transition-colors rounded`}
                aria-label={t("layer.delete_title")}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`p-1.5 ${isLayer1 ? "text-charcoal/40 hover:text-charcoal" : "text-cream/50 hover:text-cream"} transition-colors rounded`}
            aria-label="Close panel"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Title input */}
        <div className="px-6 pb-4 shrink-0">
          <label className={`block font-heading text-xs font-semibold ${labelColor} uppercase tracking-wider mb-2`}>
            {t("layer.panel_title")}
          </label>
          <input
            type="text"
            value={panelTitle}
            onChange={(e) => handleTitleChange(e.target.value)}
            className={`w-full px-4 py-2 font-heading font-semibold text-lg border rounded-lg focus:outline-none focus:ring-2 focus:ring-white/30 ${inputBg}`}
            aria-label="Panel title"
          />
        </div>

        {/* Content editor — fills remaining height, blends into panel */}
        <div className="flex-1 min-h-0 flex flex-col px-6 pb-4">
          <label className={`block font-heading text-xs font-semibold ${labelColor} uppercase tracking-wider mb-2`}>
            {t("layer.content_label")}
          </label>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <MarkdownEditor
              key={layer.id}
              initialValue={layer.content ?? ""}
              fieldName="content"
              projectId={layer.id}
              intent="autosave-layer"
              actionUrl={actionUrl}
              mode="autosave"
              objects={objects}
              className="h-full flex flex-col"
              transparent
              darkTheme={!isLayer1}
            />
          </div>
        </div>

        {/* Footer — layer 2 creation/navigation (layer 1 only) */}
        {isLayer1 && (
          <div className={`px-6 py-4 border-t ${borderColor} shrink-0`}>
            {hasLayer2 ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onOpenLayer2}
                  className="inline-flex items-center gap-2 px-6 py-2.5 bg-terracotta text-cream font-heading font-semibold text-sm rounded-full hover:bg-terracotta/90 transition-colors"
                >
                  {l2Label}
                  <ChevronRight className="w-4 h-4" />
                </button>
                {editingL2Label ? (
                  <div className="inline-flex items-center gap-1">
                    <input
                      ref={l2InputRef}
                      type="text"
                      value={l2Label}
                      onChange={(e) => setL2Label(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveL2Label();
                        if (e.key === "Escape") { setL2Label(layer2ButtonLabel ?? t("layer.default_label_2")); setEditingL2Label(false); }
                      }}
                      className="px-3 py-1.5 font-heading font-semibold text-sm text-charcoal bg-white border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-periwinkle/50 min-w-[8rem]"
                    />
                    <button type="button" onClick={handleSaveL2Label} className="p-1 text-green-600 hover:text-green-700" aria-label="Save label">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={() => { setL2Label(layer2ButtonLabel ?? t("layer.default_label_2")); setEditingL2Label(false); }} className="p-1 text-gray-400 hover:text-charcoal" aria-label="Cancel">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingL2Label(true)}
                    className="group/pencil flex items-center gap-1 p-1.5 text-charcoal/30 hover:text-charcoal rounded hover:bg-charcoal/10 transition-all"
                    aria-label="Edit button label"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span className="font-body text-xs text-charcoal/40 opacity-0 group-hover/pencil:opacity-100 transition-opacity">
                      {t("layer.edit_button_label")}
                    </span>
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={onCreateLayer2}
                className="px-6 py-2.5 border-2 border-dashed border-charcoal/25 text-charcoal/60 font-heading font-semibold text-sm rounded-full hover:border-charcoal/50 hover:text-charcoal transition-colors"
              >
                {t("layer.add_further_panel")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <Dialog
        open={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
      >
        <h2 className="font-heading font-semibold text-charcoal text-lg mb-2">
          {t("layer.delete_title")}
        </h2>
        <p className="font-body text-sm text-gray-600 mb-5">
          {t("layer.delete_body")}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowDeleteDialog(false)}
            className="px-4 py-2 text-sm font-heading font-semibold text-charcoal hover:bg-gray-100 rounded transition-colors"
          >
            {t("layer.delete_cancel")}
          </button>
          <button
            type="button"
            onClick={handleConfirmDelete}
            className="px-4 py-2 text-sm font-heading font-semibold text-cream bg-terracotta hover:bg-terracotta/90 rounded-full transition-colors"
          >
            {t("layer.delete_confirm")}
          </button>
        </div>
      </Dialog>
    </>
  );
}

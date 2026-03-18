/**
 * ObjectsEmptyState — empty state for the Objects list view.
 *
 * Shows a Package icon in a periwinkle circle, a heading, a description,
 * and two CTA buttons: "Sync from repo" (outline) and "Add IIIF object"
 * (periwinkle pill).
 */

import { Package } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ObjectsEmptyStateProps {
  onSync: () => void;
  onAddIiif: () => void;
}

export function ObjectsEmptyState({ onSync, onAddIiif }: ObjectsEmptyStateProps) {
  const { t } = useTranslation("objects");

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-14 h-14 rounded-full bg-periwinkle flex items-center justify-center mb-4">
        <Package className="w-6 h-6 text-charcoal" />
      </div>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">
        {t("empty_title")}
      </h2>
      <p className="font-body text-sm text-gray-500 max-w-sm mb-6">
        {t("empty_description")}
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSync}
          className="inline-flex items-center justify-center border border-charcoal text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 hover:bg-gray-50 transition-colors"
        >
          {t("empty_sync_button")}
        </button>
        <button
          type="button"
          onClick={onAddIiif}
          className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors"
        >
          {t("empty_add_iiif_button")}
        </button>
      </div>
    </div>
  );
}

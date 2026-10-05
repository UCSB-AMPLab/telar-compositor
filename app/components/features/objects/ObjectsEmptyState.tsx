/**
 * ObjectsEmptyState — empty state for the Objects list view.
 *
 * Shows a Package icon in a anil circle, a heading, a description,
 * and two CTA buttons: "Sync from repo" (outline) and "Add IIIF object"
 * (anil pill).
 */

import { Package } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

interface ObjectsEmptyStateProps {
  onSync: () => void;
  onAddIiif: () => void;
  /**
   * The shared document has not synced yet, so an empty list means "not loaded",
   * not "no objects". The invitations to sync or add are withheld.
   */
  awaitingSync?: boolean;
}

/** Says why the loader's list is read-only until the shared document syncs. */
export function ObjectsLoadingNote({ awaiting }: { awaiting: boolean }) {
  const { t } = useTranslation("objects");
  if (!awaiting) return null;
  return (
    <p role="status" className="font-body text-sm text-gray-500 px-4 py-2 border-b border-gray-100">
      {t("loading_state")}
    </p>
  );
}

export function ObjectsEmptyState({ onSync, onAddIiif, awaitingSync = false }: ObjectsEmptyStateProps) {
  const { t } = useTranslation("objects");
  const { t: tCommon } = useTranslation("common");

  if (awaitingSync) {
    return (
      <div role="status" className="flex flex-col items-center justify-center py-20 text-center">
        <span className="inline-block w-2 h-2 rounded-full bg-gray-300 animate-pulse mb-3" aria-hidden="true" />
        <p className="font-body text-sm text-gray-500">{t("loading_state")}</p>
      </div>
    );
  }

  return (
    <>
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-14 h-14 rounded-full bg-anil flex items-center justify-center mb-4">
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
          className="inline-flex items-center justify-center bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors"
        >
          {t("empty_add_iiif_button")}
        </button>
      </div>
    </div>
    {/* Safety net: a low-key hint pointing a user who skipped onboarding back
        to Site settings (/config) to finish setup. The empty_body copy names
        Site settings inline; the trailing link is the navigable target. */}
    <p className="font-body text-xs text-fg-muted text-center max-w-sm mx-auto -mt-12 mb-12">
      {tCommon("objects.empty_body")}{" "}
      <Link
        to="/config"
        className="font-semibold text-anil-ink hover:underline whitespace-nowrap"
      >
        {tCommon("nav.config")} →
      </Link>
    </p>
    </>
  );
}

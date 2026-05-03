/**
 * DeleteConfirmationModal — shared confirmation modal for structural
 * delete operations across entity types (stories, steps, layers, pages,
 * objects, glossary terms).
 *
 * Shows:
 *   - Entity label ("Delete Step 3?") or undo variant ("Undo add?")
 *   - Optional content summary ("2 layers, 450 words")
 *   - Optional contributor warning ("Contains edits by María, Carlos")
 *     when other team members have edited the item — uses authorship
 *     data from member contributions
 *   - Red destructive confirm button, grey Cancel
 *
 * Closes on Escape or backdrop click. On open, focus is moved to the
 * Cancel button as the safer default.
 *
 * Exports: DeleteConfirmationModal
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export type DeletableEntityType =
  | "story"
  | "step"
  | "layer"
  | "page"
  | "object"
  | "glossary_term";

export interface DeleteConfirmationModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  entityType: DeletableEntityType;
  /** Human-readable label for the entity, e.g. "Step 3" or "The Battle of Boyacá". */
  entityLabel: string;
  /** Optional summary of content being deleted, e.g. "2 layers, 450 words". */
  contentSummary?: string;
  /** Names of other contributors whose edits will be lost. */
  contributors?: string[];
  /**
   * When true, the modal confirms undoing an add rather than deleting.
   * Title and body copy change accordingly.
   */
  isUndoConfirmation?: boolean;
}

export function DeleteConfirmationModal({
  open,
  onClose,
  onConfirm,
  entityType: _entityType,
  entityLabel,
  contentSummary,
  contributors,
  isUndoConfirmation = false,
}: DeleteConfirmationModalProps) {
  const { t } = useTranslation("structural");
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Focus Cancel when dialog opens (safer default than focusing Delete)
  useEffect(() => {
    if (open) {
      // Defer to next frame so the button exists and is layout-stable
      const raf = requestAnimationFrame(() => cancelRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  if (!open) return null;

  const hasContributors = (contributors?.length ?? 0) > 0;
  const title = isUndoConfirmation
    ? t("delete_confirm_undo_title")
    : t("delete_confirm_title", { label: entityLabel });
  const confirmLabel = isUndoConfirmation ? t("btn_undo_confirm") : t("btn_delete");

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <h3
          id="delete-confirm-title"
          className="font-heading text-lg font-semibold text-charcoal"
        >
          {title}
        </h3>

        {isUndoConfirmation && (
          <p className="font-body text-sm text-gray-600 mt-2">
            {t("delete_confirm_undo_body")}
          </p>
        )}

        {contentSummary && (
          <p className="font-body text-sm text-gray-600 mt-2">
            {t("content_summary", { summary: contentSummary })}
          </p>
        )}

        {hasContributors && (
          <p className="font-body text-sm text-amber-700 bg-amber-50 rounded px-3 py-2 mt-3">
            {t("contributor_warning", {
              names: (contributors ?? []).join(", "),
            })}
          </p>
        )}

        <div className="flex gap-3 justify-end mt-6">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-charcoal bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            {t("btn_cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-white bg-red-600 hover:bg-red-700 transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

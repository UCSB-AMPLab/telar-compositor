/**
 * RemoveCollaboratorModal — centred confirmation modal for removing a collaborator.
 *
 * Follows the DeleteConfirmationModal a11y pattern:
 *   - requestAnimationFrame → cancelRef.current.focus() on open (safer default)
 *   - Escape keydown closes modal
 *   - Backdrop click closes modal
 *   - role="dialog", aria-modal="true", aria-labelledby on title
 *   - z-index z-50 (sidebar is z-40 — modal must be above)
 *
 * Copy: "Remove @username? They'll lose access to this project.
 *              You can re-invite them anytime."
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export interface RemoveCollaboratorModalProps {
  open: boolean;
  username: string;
  userId: number;
  onConfirm: (userId: number) => void;
  onCancel: () => void;
}

export function RemoveCollaboratorModal({
  open,
  username,
  userId,
  onConfirm,
  onCancel,
}: RemoveCollaboratorModalProps) {
  const { t } = useTranslation("team");
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Focus Cancel on open (safer default — phase 27 pattern)
  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => cancelRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-collab-title"
    >
      <div className="bg-white rounded-control shadow-xl p-6 max-w-sm w-full mx-4">
        <h3
          id="remove-collab-title"
          className="font-heading text-lg font-semibold text-charcoal"
        >
          {t("remove_modal_title")}
        </h3>

        <p
          className="font-body text-sm text-charcoal mt-2"
          data-testid="remove-modal-body"
        >
          {t("remove_modal_body", { username })}
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="font-heading text-sm uppercase tracking-wider px-4 py-1.5 rounded-control text-charcoal bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            {t("remove_cancel")}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(userId)}
            className="font-heading text-sm uppercase tracking-wider px-4 py-1.5 rounded-control text-white bg-red-600 hover:bg-red-700 transition-colors"
          >
            {t("remove_confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

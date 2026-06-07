/**
 * FreezeModal — Full-screen overlay shown to collaborators during an
 * owner-initiated blocking operation (publish or upgrade).
 *
 * Used by PublishFreezeModal (publish flow) and UpgradeFreezeModal (upgrade
 * flow). Props-driven — no i18n lookups inside. Specific wrappers supply
 * localised strings from their namespace.
 *
 * Visibility rule: the modal is intended for collaborators who are NOT the
 * initiator — they need to know editing is paused. The owner already has a
 * dedicated action page (publish, upgrade) with inline progress/error UI,
 * so rendering the modal for them duplicates feedback and hides their page.
 * The modal therefore returns null when isOwner is true, regardless of
 * isActive / hasError. bodyOwner is retained in the props shape for
 * compatibility with existing wrappers but is unused.
 */

import { Loader2, AlertCircle } from "lucide-react";

export interface FreezeModalProps {
  /** True while the operation is running. Spinner shown. */
  isActive: boolean;
  /** True when the operation errored. Error state shown. */
  hasError: boolean;
  /** True when the current user initiated the operation. */
  isOwner: boolean;
  /** Spinner-state heading. */
  heading: string;
  /** Spinner-state body shown to the owner. */
  bodyOwner: string;
  /** Spinner-state body shown to collaborators. */
  bodyCollaborator: string;
  /** Error-state heading. */
  errorHeading: string;
  /** Error-state body. */
  errorBody: string;
  /** Error-state dismiss button label. */
  dismissLabel: string;
  /** Called when the user clicks dismiss in error state. */
  onDismiss: () => void;
  /** aria-labelledby id suffix (differentiates publish vs upgrade instances). */
  labelId?: string;
}

export function FreezeModal({
  isActive,
  hasError,
  isOwner,
  heading,
  bodyOwner,
  bodyCollaborator,
  errorHeading,
  errorBody,
  dismissLabel,
  onDismiss,
  labelId = "freeze-modal-heading",
}: FreezeModalProps) {
  // Owner-initiated flow: owner has their own inline page UI for progress
  // and errors. Showing the modal duplicates feedback and hides the page.
  if (isOwner) return null;
  if (!isActive && !hasError) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
    >
      <div className="bg-cream p-8 rounded-xl max-w-sm w-full flex flex-col items-center text-center gap-6">
        {hasError ? (
          <>
            <AlertCircle className="w-8 h-8 text-terracotta" aria-hidden="true" />
            <h2 id={labelId} className="font-heading font-semibold text-charcoal text-base">
              {errorHeading}
            </h2>
            <p className="font-body text-sm text-gray-500">{errorBody}</p>
            <button
              type="button"
              onClick={onDismiss}
              className="font-heading text-sm font-semibold text-charcoal hover:text-terracotta focus:outline-2 focus:outline-terracotta"
            >
              {dismissLabel}
            </button>
          </>
        ) : (
          <>
            <Loader2 className="w-8 h-8 text-charcoal animate-spin" aria-hidden="true" />
            <h2 id={labelId} className="font-heading font-semibold text-charcoal text-base">
              {heading}
            </h2>
            <p className="font-body text-sm text-gray-500">
              {isOwner ? bodyOwner : bodyCollaborator}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

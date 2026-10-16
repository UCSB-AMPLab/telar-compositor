/**
 * OutOfSyncPopover — the divergence body of the Site Status pill: someone
 * committed to the repository after the last publish. It says so and offers
 * one action, "Review changes", which opens the review dialog the app layout
 * mounts (`useSyncReview().openReview`) on the page the author is on.
 *
 * Only the convenor can apply a review (the /dashboard action's
 * `requireOwner`). Everyone else, collaborators and instructors alike, is
 * shown the state and the name of the person who chooses, with no button.
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";
import { coordinatorLine, useSyncReview } from "~/components/features/dashboard/SyncReviewProvider";

export interface OutOfSyncPopoverProps {
  /** Called after the review opens, so the pill can close its popover. */
  onReview?: () => void;
  className?: string;
}

export function OutOfSyncPopover({ onReview, className = "" }: OutOfSyncPopoverProps) {
  const { t } = useTranslation("popover");
  const { openReview, canReview, coordinatorName } = useSyncReview();
  const [collabKey, collabValues] = coordinatorLine("out_of_sync.collab_body", "out_of_sync.collab_body_unnamed", coordinatorName);

  function handleReview() {
    openReview();
    onReview?.();
  }

  return (
    <div className={className}>
      <div className={canReview ? "border-b border-border" : ""} style={{ padding: "14px 18px 12px" }}>
        <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
          {t("out_of_sync.title")}
        </h3>
        <p className="font-body text-fg-muted" style={{ fontSize: "12px", marginTop: "2px", lineHeight: 1.45 }}>
          {canReview ? t("out_of_sync.body") : t(collabKey, collabValues)}
        </p>
      </div>

      {canReview && (
        <div
          className="bg-cream flex items-center justify-end"
          style={{ padding: "11px 14px 12px", gap: "8px" }}
        >
          <button
            type="button"
            onClick={handleReview}
            className="font-heading font-semibold inline-flex items-center bg-anil text-charcoal hover:bg-anil-hover transition-colors"
            style={{ fontSize: "11px", letterSpacing: "0.04em", textTransform: "uppercase", padding: "6px 14px", borderRadius: "9999px" }}
          >
            {t("out_of_sync.review")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The upgrade page's way to the review of the changes on GitHub: a button
 * that opens the review dialog the app layout mounts, for the convenor, who
 * alone can apply it; for everyone else, the line naming the person who
 * coordinates the site and chooses, with no button.
 *
 * @version v1.5.5-beta
 */
import { useTranslation } from "react-i18next";
import { coordinatorLine, useSyncReview } from "~/components/features/dashboard/SyncReviewProvider";

export function UpgradeReviewAction({ actionKey, className = "" }: { actionKey: string; className?: string }) {
  const { t } = useTranslation("upgrade");
  const { openReview, canReview, coordinatorName } = useSyncReview();
  if (!canReview) {
    const [key, values] = coordinatorLine("reviewByCoordinator", "reviewByCoordinator_unnamed", coordinatorName);
    return <p className={`font-body text-sm text-amber-900 ${className}`}>{t(key, values)}</p>;
  }
  return (
    <button
      type="button"
      onClick={openReview}
      className={`font-heading font-semibold text-sm text-amber-900 underline underline-offset-2 hover:opacity-80 inline-block ${className}`}
    >
      {t(actionKey)}
    </button>
  );
}

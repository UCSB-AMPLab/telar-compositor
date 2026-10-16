/**
 * The done screen's line when the upgrade wrote a value the editor does not
 * hold and so did not record itself as synced: publishing is refused until a
 * review of the changes on GitHub offers those values to the editor. The
 * convenor, who can apply the review, gets a button that opens it here;
 * everyone else is told who chooses (`UpgradeReviewAction`).
 *
 * @version v1.5.5-beta
 */
import { useTranslation } from "react-i18next";
import { UpgradeReviewAction } from "./UpgradeReviewAction";

export function UpgradeSyncNeeded({ className = "" }: { className?: string }) {
  const { t } = useTranslation("upgrade");
  return (
    <div className={`bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 ${className}`}>
      <p className="font-body text-sm text-amber-900">{t("syncNeeded")}</p>
      <UpgradeReviewAction actionKey="syncNeededLink" className="mt-2" />
    </div>
  );
}

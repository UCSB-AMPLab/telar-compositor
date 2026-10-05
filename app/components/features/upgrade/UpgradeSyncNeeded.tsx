/**
 * The done screen's line when the upgrade wrote a value the editor does not
 * hold and so did not record itself as synced: publishing is
 * refused until a sync offers those values to the editor.
 *
 * @version v1.5.0-beta
 */
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

export function UpgradeSyncNeeded({ className = "" }: { className?: string }) {
  const { t } = useTranslation("upgrade");
  return (
    <div className={`bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 ${className}`}>
      <p className="font-body text-sm text-amber-900">{t("syncNeeded")}</p>
      <Link
        to="/objects?sync=1"
        className="font-heading font-semibold text-sm text-amber-900 underline underline-offset-2 hover:opacity-80 mt-2 inline-block"
      >
        {t("syncNeededLink")}
      </Link>
    </div>
  );
}

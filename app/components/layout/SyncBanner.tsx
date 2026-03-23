/**
 * SyncBanner — persistent HEAD divergence warning.
 *
 * Shown when the app loader detects that the repo's current HEAD SHA
 * differs from the stored head_sha in D1 (i.e., someone pushed changes
 * to the repo outside the compositor).
 *
 * Non-dismissible — disappears only after a re-sync updates head_sha.
 * Directs the user to the Dashboard where the sync infrastructure lives.
 */

import { AlertTriangle } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

export function SyncBanner() {
  const { t } = useTranslation("common");

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-6 py-3 flex items-center gap-3">
      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
      <p className="font-body text-sm text-amber-800 flex-1">
        {t("sync_banner.message")}
      </p>
      <Link
        to="/dashboard?sync=1"
        className="font-heading font-semibold text-sm text-amber-900 underline underline-offset-2 hover:text-amber-700 shrink-0"
      >
        {t("sync_banner.action")}
      </Link>
    </div>
  );
}

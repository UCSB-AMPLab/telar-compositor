/**
 * ConvenorOnlyNote — the read-only explanation that sits above a group of
 * config fields only the site's convenor may change.
 *
 * It is rendered once per read-only group rather than once per page, so the
 * reason reaches the fields it applies to: a member editing the site title
 * three sections up is not being told anything about their own standing.
 *
 * @version v1.5.0-beta
 */

import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ConvenorOnlyNote() {
  const { t } = useTranslation("config");

  return (
    <div className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 mb-4">
      <Lock className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div>
        <p className="font-heading font-semibold text-sm text-charcoal">
          {t("read_only.title")}
        </p>
        <p className="font-body text-xs text-gray-600 mt-1">{t("read_only.body")}</p>
      </div>
    </div>
  );
}

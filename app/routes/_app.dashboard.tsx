/**
 * Dashboard — authenticated landing page.
 *
 * Shows empty state directing users to connect a project.
 * Full dashboard UI with story cards implemented in Phase 2.
 */

import { useTranslation } from "react-i18next";
import { LayoutDashboard } from "lucide-react";

export const handle = { i18n: ["common", "dashboard"] };

export default function DashboardPage() {
  const { t } = useTranslation("dashboard");

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="font-heading font-bold text-2xl text-charcoal mb-6">
        {t("title")}
      </h1>

      {/* Empty state */}
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-14 h-14 rounded-full bg-periwinkle flex items-center justify-center mb-4">
          <LayoutDashboard className="w-6 h-6 text-charcoal" />
        </div>
        <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">
          {t("empty_state")}
        </h2>
        <p className="font-body text-sm text-gray-500 max-w-sm">
          {t("empty_state_description")}
        </p>
      </div>
    </div>
  );
}

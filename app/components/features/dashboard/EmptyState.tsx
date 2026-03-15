/**
 * EmptyState — shown on the dashboard when the user has no connected projects.
 *
 * Centers a CTA to connect a GitHub repository.
 */

import { GitBranch } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

export function EmptyState() {
  const { t } = useTranslation("dashboard");

  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-16 h-16 rounded-full bg-periwinkle flex items-center justify-center mb-6">
        <GitBranch className="w-7 h-7 text-charcoal" />
      </div>
      <h2 className="font-heading font-semibold text-xl text-charcoal mb-2">
        {t("empty_state")}
      </h2>
      <p className="font-body text-sm text-gray-500 max-w-sm mb-8">
        {t("empty_state_description")}
      </p>
      <Link
        to="/onboarding"
        className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-6 py-2.5 transition-colors"
      >
        {t("connect_repo")}
      </Link>
    </div>
  );
}

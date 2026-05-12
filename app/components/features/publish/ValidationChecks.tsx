/**
 * ValidationChecks — pre-publish blocker and warning display for the Checks step.
 *
 * Blockers shown with red AlertCircle icons, warnings with amber AlertTriangle.
 * Stale HEAD blocker includes re-sync messaging.
 * Empty state (no blockers, no warnings): green checkmark "All checks passed".
 */

import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ValidationResult } from "~/lib/publish.server";

interface ValidationChecksProps {
  validation: ValidationResult | null;
  className?: string;
}

export function ValidationChecks({ validation, className = "" }: ValidationChecksProps) {
  const { t } = useTranslation("publish");

  // Loading state — validation not yet returned from server
  if (validation === null) {
    return (
      <div className={`flex items-center gap-2 text-gray-500 py-4 ${className}`}>
        <div className="w-5 h-5 rounded-full border-2 border-gray-300 border-t-periwinkle animate-spin flex-shrink-0" />
        <span className="font-body text-sm">{t("checks.heading")}…</span>
      </div>
    );
  }

  const hasBlockers = validation.blockers.length > 0;
  const hasWarnings = validation.warnings.length > 0;
  const allPassed = !hasBlockers && !hasWarnings;

  return (
    <div className={className}>
      {allPassed && (
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-lg p-4">
          <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
          <div>
            <p className="font-heading font-semibold text-sm text-green-800">
              {t("checks.all_passed")}
            </p>
            <p className="font-body text-sm text-green-700 mt-0.5">
              {t("checks.all_passed_description")}
            </p>
          </div>
        </div>
      )}

      {hasBlockers && (
        <div className="mb-4">
          <h3 className="font-heading font-semibold text-sm text-red-700 mb-2">
            {t("checks.blockers_heading")}
          </h3>
          <div className="space-y-2">
            {validation.blockers.map((blocker, idx) => (
              <div
                key={`${blocker.code}-${blocker.entityId ?? idx}`}
                className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-3"
              >
                <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-body text-sm text-red-900">
                    {t(`checks.${blocker.code}`, blocker.params ?? {})}
                  </p>
                  {blocker.code === "stale_head" && (
                    <Link
                      to="/dashboard?sync=1"
                      className="font-body text-sm text-red-700 underline hover:text-red-900 mt-1 inline-block"
                    >
                      {t("checks.stale_head_action")}
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasWarnings && (
        <div>
          <h3 className="font-heading font-semibold text-sm text-amber-700 mb-2">
            {t("checks.warnings_heading")}
          </h3>
          <div className="space-y-2">
            {validation.warnings.map((warning, idx) => (
              <div
                key={`${warning.code}-${warning.entityId ?? idx}`}
                className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-3"
              >
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="font-body text-sm text-amber-900">
                  {t(`checks.${warning.code}`, warning.params ?? {})}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

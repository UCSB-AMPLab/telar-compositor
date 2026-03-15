/**
 * StepReview — import results summary step.
 *
 * Shows: site settings summary, objects count, stories count, glossary count,
 * Google Sheets warning (if auto-disabled), and CSV warnings in a collapsible
 * section. Two actions: "Go to Dashboard" and "Edit Config First".
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import { WarningBanner } from "~/components/ui/WarningBanner";
import { InlineConfig } from "./InlineConfig";
import type { ImportResult } from "~/lib/import.server";

interface StepReviewProps {
  importResult: ImportResult;
  onDone: () => void;
  onEditConfig: () => void;
  showInlineConfig: boolean;
  projectId: number;
  className?: string;
}

export function StepReview({
  importResult,
  onDone,
  onEditConfig,
  showInlineConfig,
  projectId,
  className = "",
}: StepReviewProps) {
  const { t } = useTranslation("onboarding");
  const [warningsOpen, setWarningsOpen] = useState(false);

  const allWarnings = [
    ...importResult.objects.warnings,
    ...importResult.stories.warnings,
  ];

  const configFields = importResult.configFields as Record<string, unknown>;

  return (
    <div className={className}>
      <h2 className="font-heading font-semibold text-xl text-charcoal mb-5">
        {t("step_review.heading")}
      </h2>

      {/* Google Sheets warning */}
      {importResult.sheetsDisabled && (
        <WarningBanner
          message={t("step_review.sheets_warning")}
          className="mb-5"
        />
      )}

      {/* Site settings summary */}
      <section className="bg-cream rounded-lg p-4 mb-4">
        <h3 className="font-heading font-semibold text-sm text-charcoal mb-3">
          {t("step_review.site_settings")}
        </h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {configFields.title && (
            <>
              <dt className="font-body text-gray-500">Title</dt>
              <dd className="font-body text-charcoal truncate">{String(configFields.title)}</dd>
            </>
          )}
          {configFields.lang && (
            <>
              <dt className="font-body text-gray-500">Language</dt>
              <dd className="font-body text-charcoal">{String(configFields.lang).toUpperCase()}</dd>
            </>
          )}
          {configFields.theme && (
            <>
              <dt className="font-body text-gray-500">Theme</dt>
              <dd className="font-body text-charcoal truncate">{String(configFields.theme)}</dd>
            </>
          )}
          {configFields.telar_version && (
            <>
              <dt className="font-body text-gray-500">Telar version</dt>
              <dd className="font-body text-charcoal">{String(configFields.telar_version)}</dd>
            </>
          )}
        </dl>
      </section>

      {/* Import counts */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {/* Objects */}
        <div className="bg-white border border-gray-100 rounded-lg p-3 text-center">
          <p className="font-heading font-semibold text-lg text-charcoal">
            {importResult.objects.imported}
          </p>
          <p className="font-body text-xs text-gray-500 mt-0.5">
            {t("step_review.objects_title")}
          </p>
          {importResult.objects.skipped > 0 && (
            <p className="font-body text-xs text-amber-600 mt-0.5">
              {t("step_review.objects_skipped", { count: importResult.objects.skipped })}
            </p>
          )}
        </div>

        {/* Stories */}
        <div className="bg-white border border-gray-100 rounded-lg p-3 text-center">
          <p className="font-heading font-semibold text-lg text-charcoal">
            {importResult.stories.imported}
          </p>
          <p className="font-body text-xs text-gray-500 mt-0.5">
            {t("step_review.stories_title")}
          </p>
        </div>

        {/* Glossary */}
        <div className="bg-white border border-gray-100 rounded-lg p-3 text-center">
          <p className="font-heading font-semibold text-lg text-charcoal">
            {importResult.glossary.imported}
          </p>
          <p className="font-body text-xs text-gray-500 mt-0.5">
            {t("step_review.glossary_title")}
          </p>
        </div>
      </div>

      {/* CSV warnings collapsible */}
      {allWarnings.length > 0 && (
        <details
          open={warningsOpen}
          onToggle={(e) => setWarningsOpen((e.target as HTMLDetailsElement).open)}
          className="mb-4 border border-amber-200 rounded-lg overflow-hidden"
        >
          <summary className="flex items-center justify-between px-4 py-3 bg-amber-50 cursor-pointer list-none">
            <span className="text-sm font-body font-medium text-amber-800">
              {allWarnings.length} warning{allWarnings.length !== 1 ? "s" : ""}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-amber-600 transition-transform ${warningsOpen ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </summary>
          <ul className="px-4 py-3 space-y-1">
            {allWarnings.map((w, i) => (
              <li key={i} className="text-xs font-body text-gray-600">
                {w}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Inline config editor */}
      {showInlineConfig && (
        <InlineConfig
          configFields={configFields}
          projectId={projectId}
          onSaved={onDone}
        />
      )}

      {/* Actions */}
      {!showInlineConfig && (
        <div className="flex items-center gap-3 justify-end mt-2">
          <Button variant="control" type="button" onClick={onEditConfig}>
            {t("step_review.edit_config_first")}
          </Button>
          <Link to="/dashboard">
            <Button variant="primary" type="button">
              {t("step_review.go_to_dashboard")}
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}

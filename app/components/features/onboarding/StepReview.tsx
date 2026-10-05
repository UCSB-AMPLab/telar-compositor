/**
 * StepReview — import results summary step.
 *
 * Shows: site settings summary, objects count, stories count, glossary count,
 * Google Sheets warning (if auto-disabled), the GitHub Pages branch a site
 * still publishes from after the Compositor moved it to `main`, and CSV
 * warnings in a collapsible section. Two actions: "Go to Dashboard" and
 * "Edit Config First".
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import { SheetWarnings } from "~/components/ui/SheetWarnings";
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

      {/* Site settings summary */}
      <section className="bg-cream rounded-lg p-4 mb-4">
        <h3 className="font-heading font-semibold text-sm text-charcoal mb-3">
          {t("step_review.site_settings")}
        </h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {typeof configFields.title === "string" && (
            <>
              <dt className="font-body text-gray-500">{t("create_site.form.title_label")}</dt>
              <dd className="font-body text-charcoal truncate">{configFields.title}</dd>
            </>
          )}
          {typeof configFields.lang === "string" && (
            <>
              <dt className="font-body text-gray-500">{t("create_site.form.language_label")}</dt>
              <dd className="font-body text-charcoal">{configFields.lang.toUpperCase()}</dd>
            </>
          )}
          {typeof configFields.theme === "string" && (
            <>
              <dt className="font-body text-gray-500">{t("create_site.form.theme_label")}</dt>
              <dd className="font-body text-charcoal truncate">{configFields.theme}</dd>
            </>
          )}
          {typeof configFields.telar_version === "string" && (
            <>
              <dt className="font-body text-gray-500">{t("step_review.telar_version")}</dt>
              <dd className="font-body text-charcoal">{configFields.telar_version}</dd>
            </>
          )}
        </dl>
      </section>

      {/* Import counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
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

        {/* Pages */}
        <div className="bg-white border border-gray-100 rounded-lg p-3 text-center">
          <p className="font-heading font-semibold text-lg text-charcoal">
            {importResult.pages.imported}
          </p>
          <p className="font-body text-xs text-gray-500 mt-0.5">
            {t("step_review.pages_title")}
          </p>
        </div>
      </div>

      {/* Pages still publishing from a branch after the move to main */}
      {importResult.pagesWarning && (
        <WarningBanner
          message={t("step_sync.warning_pages_old_branch", { branch: importResult.pagesWarning.branch })}
          className="mb-4"
        />
      )}

      {/* CSV warnings collapsible */}
      <SheetWarnings
        warnings={allWarnings}
        summary={t("step_review.warnings", { count: allWarnings.length })}
        className="mb-4"
      />

      {/* Inline config editor */}
      {showInlineConfig && (
        <InlineConfig
          configFields={configFields}
          projectId={projectId}
          themes={importResult.themes.list}
          onSaved={onDone}
        />
      )}

      {/* Actions */}
      {!showInlineConfig && (
        <div className="mt-4">
          <p className="font-body text-xs text-gray-500 mb-4">
            {t("step_review.config_explanation")}
          </p>
          <div className="flex items-center gap-3 justify-end">
            <button
              type="button"
              onClick={onEditConfig}
              className="inline-flex items-center justify-center border border-gray-200 hover:bg-gray-50 text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-6 py-2.5 transition-colors cursor-pointer"
            >
              {t("step_review.edit_config_first")}
            </button>
            <Button variant="primary" type="button" onClick={onDone}>
              {t("step_review.continue")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

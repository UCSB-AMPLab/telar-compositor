/**
 * ValidationChecks — "What we checked" section for the single-page Publish surface.
 *
 * Renders a chilca-pale numbered list of the pre-publish checks that PASSED,
 * followed by any blockers (red) and warnings (amber). `runPrePublishValidation`
 * only emits FAILURES, never a passed-check enumeration — so the passed list is
 * a STATIC canonical set minus the codes whose failures appear in the result.
 *
 * Passed-check ↔ failing-code mapping:
 *   - object_metadata  ← suppressed by an `object_no_title` warning
 *   - term_links       ← no validation code yet (always passes)
 *   - iiif_tiles        ← no validation code yet (always passes)
 *   - site_url          ← no validation code yet (always passes)
 *   - telar_version     ← no validation code yet (always passes)
 * The `stale_head` / `page_no_title` blockers and `step_no_position` warning
 * have no passed-check label; they only render in the failures lists.
 *
 * Tailwind token classes only (no hardcoded hex).
 *
 * @version v1.3.0-beta
 */

import { AlertCircle, AlertTriangle, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ValidationResult } from "~/lib/publish.server";

interface ValidationChecksProps {
  validation: ValidationResult | null;
  className?: string;
}

/**
 * Canonical passed-check labels, in display order. Each entry names the
 * validation code(s) whose presence (as a blocker OR warning) removes it from
 * the passed list. An empty `suppressedBy` means there is no validation code
 * for that check yet, so it always shows as passed.
 */
const CANONICAL_PASSED_CHECKS: { key: string; suppressedBy: string[] }[] = [
  { key: "object_metadata", suppressedBy: ["object_no_title"] },
  { key: "term_links", suppressedBy: [] },
  { key: "iiif_tiles", suppressedBy: [] },
  { key: "site_url", suppressedBy: [] },
  { key: "telar_version", suppressedBy: [] },
];

export function ValidationChecks({ validation, className = "" }: ValidationChecksProps) {
  const { t } = useTranslation("publish");

  // Loading state — validation not yet returned from server.
  if (validation === null) {
    return (
      <div className={`flex items-center gap-2 text-charcoal/60 py-4 ${className}`}>
        <div className="w-5 h-5 rounded-full border-2 border-cream-dark border-t-anil animate-spin flex-shrink-0" />
        <span className="font-body text-sm">{t("checks.heading")}…</span>
      </div>
    );
  }

  const hasBlockers = validation.blockers.length > 0;
  const hasWarnings = validation.warnings.length > 0;

  // Derive passed checks: the canonical set minus any check whose failing code
  // is present in blockers or warnings (validation reports failures only).
  const failingCodes = new Set<string>([
    ...validation.blockers.map((b) => b.code),
    ...validation.warnings.map((w) => w.code),
  ]);
  const passedChecks = CANONICAL_PASSED_CHECKS.filter(
    (check) => !check.suppressedBy.some((code) => failingCodes.has(code)),
  );

  return (
    <div className={className}>
      {passedChecks.length > 0 && (
        <ol className="rounded-lg bg-chilca-pale border border-chilca/20 px-5 py-4 space-y-2 list-none">
          {passedChecks.map((check, idx) => (
            <li key={check.key} className="flex items-start gap-3">
              <span className="font-heading text-xs text-chilca-deep/70 w-4 flex-shrink-0 mt-0.5 tabular-nums">
                {idx + 1}.
              </span>
              <Check className="w-4 h-4 text-chilca-deep flex-shrink-0 mt-0.5" />
              <span className="font-body text-sm text-chilca-deep">
                {t(`passed_checks.${check.key}`)}
              </span>
            </li>
          ))}
        </ol>
      )}

      {hasBlockers && (
        <div className="mt-4">
          <h3 className="font-heading font-semibold text-sm text-terracotta mb-2">
            {t("checks.blockers_heading")}
          </h3>
          <div className="space-y-2">
            {validation.blockers.map((blocker, idx) => (
              <div
                key={`${blocker.code}-${blocker.entityId ?? idx}`}
                className="flex items-start gap-3 bg-terracotta-pale border border-terracotta/20 rounded-lg p-3"
              >
                <AlertCircle className="w-4 h-4 text-terracotta flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-body text-sm text-terracotta-deep">
                    {t(`checks.${blocker.code}`, blocker.params ?? {})}
                  </p>
                  {blocker.code === "stale_head" && (
                    <Link
                      to="/dashboard?sync=1"
                      className="font-body text-sm text-terracotta underline hover:text-terracotta-deep mt-1 inline-block"
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
        <div className="mt-4">
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

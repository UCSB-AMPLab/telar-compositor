/**
 * SiteConfigConfirmation — pre-flight checklist during onboarding.
 *
 * Runs through configuration checks and shows results as a checklist:
 * - Google Sheets disabled
 * - GitHub Pages enabled
 * - Site URL configured correctly
 *
 * Each item shows its status (pass/needs fix) with a brief explanation.
 * A single "Fix and continue" button resolves all issues at once.
 */

import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  sheetsEnabled: boolean;
  pagesNotEnabled: boolean;
  urlMismatch: { pagesUrl: string; configUrl: string } | null;
  /** The refusal code alone, never carrying GitHub's text: the branches below select on it by equality. */
  error: string | null;
  /** GitHub's own words, shown as detail beneath whichever explanation the code selected. */
  errorMessage: string | null;
  /** Carries the visibility remedy's link to the repository's own settings; null drops the link, never the explanation. */
  repoFullName: string | null;
  installationId: number | null;
  onConfirmed: () => void;
  onSkip: () => void;
  isSubmitting: boolean;
}

/**
 * Refusal code to the pair of keys that explains it, one entry per code, in the
 * shape `_auth.invite.$token.tsx` already uses for its own refusals. A code with
 * no entry takes the generic pair, so an unmapped refusal reads as a refusal
 * rather than as a blank card — and adding a code means adding a row, never
 * lengthening a chain of conditions.
 */
const REFUSAL_COPY: Record<string, { title: string; body: string }> = {
  pages_private_repo: {
    title: "site_config.error_private_repo_title",
    body: "site_config.error_private_repo",
  },
  pages_permission_denied: {
    title: "site_config.error_pages_permission_title",
    body: "site_config.error_pages_permission",
  },
};

const GENERIC_REFUSAL = {
  title: "site_config.error_generic_title",
  body: "site_config.error_generic",
};

function CheckItem({
  passed,
  passedTitle,
  failedTitle,
  explanation,
  detail,
}: {
  passed: boolean;
  passedTitle: string;
  failedTitle: string;
  explanation: string;
  detail?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="mt-0.5 flex-shrink-0">
        {passed ? (
          <CheckCircle2 className="w-5 h-5 text-green-500" />
        ) : (
          <AlertTriangle className="w-5 h-5 text-amber-500" />
        )}
      </div>
      <div className="flex-1">
        <p className={`font-heading font-semibold text-sm ${passed ? "text-green-800" : "text-charcoal"}`}>
          {passed ? passedTitle : failedTitle}
        </p>
        <p className="font-body text-xs text-gray-500 mt-0.5">
          {explanation}
        </p>
        {detail && <div className="mt-2">{detail}</div>}
      </div>
    </div>
  );
}

export function SiteConfigConfirmation({
  sheetsEnabled,
  pagesNotEnabled,
  urlMismatch,
  error,
  errorMessage,
  repoFullName,
  installationId,
  onConfirmed,
  onSkip,
  isSubmitting,
}: Props) {
  const { t } = useTranslation("onboarding");

  const refusal = (error && REFUSAL_COPY[error]) || GENERIC_REFUSAL;
  const allPassed = !sheetsEnabled && !pagesNotEnabled && !urlMismatch;
  const hasIssues = sheetsEnabled || pagesNotEnabled || urlMismatch;

  return (
    <div>
      <h2 className="font-heading font-semibold text-xl text-charcoal mb-2">
        {t("site_config.heading")}
      </h2>
      <p className="font-body text-sm text-gray-600 mb-5">
        {t("site_config.intro")}
      </p>

      <div className="divide-y divide-gray-100">
        {/* Google Sheets check */}
        <CheckItem
          passed={!sheetsEnabled}
          passedTitle={t("site_config.sheets_passed")}
          failedTitle={t("site_config.sheets_failed")}
          explanation={t("site_config.sheets_why")}
          detail={
            !sheetsEnabled ? undefined : (
              <p className="font-body text-xs text-amber-600 border-l-2 border-amber-300 pl-3">
                {t("site_config.sheets_reversible")}
              </p>
            )
          }
        />

        {/* GitHub Pages check */}
        <CheckItem
          passed={!pagesNotEnabled}
          passedTitle={t("site_config.pages_passed")}
          failedTitle={t("site_config.pages_failed")}
          explanation={t("site_config.pages_why")}
        />

        {/* URL check — can't verify if Pages isn't enabled */}
        <CheckItem
          passed={!pagesNotEnabled && !urlMismatch}
          passedTitle={t("site_config.url_passed")}
          failedTitle={pagesNotEnabled ? t("site_config.url_pending") : t("site_config.url_failed")}
          explanation={pagesNotEnabled ? t("site_config.url_pending_why") : t("site_config.url_why")}
          detail={
            !urlMismatch ? undefined : (
              <div className="space-y-1">
                <p className="font-mono text-xs text-gray-500">
                  _config.yml: <strong className="text-charcoal">{urlMismatch.configUrl}</strong>
                </p>
                <p className="font-mono text-xs text-gray-500">
                  GitHub Pages: <strong className="text-charcoal">{urlMismatch.pagesUrl}</strong>
                </p>
              </div>
            )
          }
        />
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mt-4">
          <p className="font-heading font-semibold text-sm text-red-900 mb-1">
            {t(refusal.title)}
          </p>
          <p className="font-body text-sm text-red-800">
            {t(refusal.body)}
          </p>
          {errorMessage && (
            <p className="font-mono text-xs text-red-600 mt-2 break-all">{errorMessage}</p>
          )}
          {error === "pages_private_repo" && repoFullName && (
            <a
              href={`https://github.com/${repoFullName}/settings`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-2 font-body text-sm text-blue-600 hover:underline"
            >
              {t("site_config.error_private_repo_link")} →
            </a>
          )}
          {error === "pages_permission_denied" && installationId && (
            <a
              href={`https://github.com/settings/installations/${installationId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-2 font-body text-sm text-blue-600 hover:underline"
            >
              {t("site_config.error_pages_permission_link")} →
            </a>
          )}
        </div>
      )}

      <div className="flex items-center gap-4 mt-6">
        {allPassed ? (
          <button
            type="button"
            onClick={onConfirmed}
            className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-anil hover:bg-anil-hover text-charcoal uppercase tracking-wider rounded-full px-5 py-2.5 transition-colors"
          >
            {t("site_config.continue")}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onConfirmed}
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-terracotta hover:opacity-90 text-cream uppercase tracking-wider rounded-full px-5 py-2.5 transition-opacity disabled:bg-disabled disabled:text-fg-disabled"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {t("site_config.confirm")}
            </button>
            {error && (
              <button
                type="button"
                onClick={onSkip}
                className="font-heading font-semibold text-sm text-gray-500 hover:text-charcoal underline underline-offset-2 transition-colors"
              >
                {t("site_config.skip")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * ConfigRewriteDialog — the review of a `_config.yml` rewrite, opened from the
 * `config_needs_rewrite` blocker on the Publish page.
 *
 * The page mounts it only while it is open, and mounting it asks the publish
 * route for a preview (`preview-config-rewrite`),
 * which rebuilds the file and answers with what the rewrite does and the
 * fingerprint of the rebuilt text. Its steps follow the sync dialog's:
 * preparing while the preview runs, ready with the report and the choice to
 * accept, and failed, which says whether the template could not be read or
 * the rewrite could not keep every setting. Accepting hands the fingerprint to
 * the page, which sends it with the publish; nothing is written from here.
 *
 * @version v1.5.5-beta
 */

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { canWriteConfigField } from "~/lib/config-fields";
import { useSiteFetcher } from "~/lib/page-site";
import { stripVersionPrefix } from "~/lib/version";
import type { ConfigRewriteReport } from "~/lib/config-rewrite.server";
import type { ValidationItem, ValidationResult } from "~/lib/publish.server";

/** What the route answers a preview with. */
type PreviewData =
  | { ok: true; intent: "preview-config-rewrite"; report: ConfigRewriteReport; fingerprint: string }
  | { ok: false; intent?: string; error?: string; reason?: string }
  | null
  | undefined;

type Step = "preparing" | "ready" | "template_unavailable" | "failed";

/**
 * Whether `role` may accept a rewrite: anyone who can save Site settings.
 * `title` is a field every such role writes.
 */
export function canReviewConfigRewrite(role: string | null | undefined): boolean {
  return canWriteConfigField("title", role);
}

/**
 * The publish form field carrying the fingerprint of the rewrite the author
 * accepted, which the publish route reads back.
 */
export const ACKNOWLEDGED_CONFIG_REWRITE = "acknowledgedConfigRewrite";

/** The publish fields that carry an accepted rewrite: none when there is none. */
export function rewriteAcknowledgementFields(fingerprint: string | null): Record<string, string> {
  return fingerprint === null ? {} : { [ACKNOWLEDGED_CONFIG_REWRITE]: fingerprint };
}

/** Whether `blocker` is the rewrite's own, answered once the author accepted it. */
function isAcceptedRewrite(blocker: ValidationItem, accepted: boolean): boolean {
  return accepted && blocker.code === "config_needs_rewrite";
}

/** The blockers that still stop a publish, and whether an accepted rewrite answered its own. */
export function blockersBesideRewrite(
  blockers: readonly ValidationItem[],
  accepted: boolean,
): { blockers: ValidationItem[]; rewriteReady: boolean } {
  const left = blockers.filter((b) => !isAcceptedRewrite(b, accepted));
  return { blockers: left, rewriteReady: left.length < blockers.length };
}

/** The accepted fingerprint kept after a run of the checks: none once they no longer ask for a rewrite. */
export function fingerprintAfterChecks(validation: ValidationResult, fingerprint: string | null): string | null {
  return validation.blockers.some((b) => b.code === "config_needs_rewrite") ? fingerprint : null;
}

/** The accepted fingerprint kept after a refused publish: none once the publish found it stale. */
export function fingerprintAfterRefusal(error: string | undefined, fingerprint: string | null): string | null {
  return error === "config_rewrite_stale" ? null : fingerprint;
}

/** What opens the review for `role`, or nothing for a role that may not accept a rewrite. */
export function rewriteReviewOpener(role: string | null | undefined, open: () => void): (() => void) | undefined {
  return canReviewConfigRewrite(role) ? open : undefined;
}

/**
 * The step a preview's answer leads to. Only a rewrite that could not keep
 * every setting is `failed`, which asks for a bug report; every other refusal,
 * an unreachable answer among them, is one a later try can get past.
 */
function stepForPreviewAnswer(data: PreviewData): Step {
  if (data?.ok) return "ready";
  return data?.error === "failed" ? "failed" : "template_unavailable";
}

const buttonClass =
  "font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors";

function NameList({ heading, names }: { heading: string; names: readonly string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="font-body text-sm text-charcoal">{heading}</p>
      <ul className="mt-1 list-disc pl-5 space-y-0.5">
        {names.map((name, idx) => (
          <li key={`${name}-${idx}`} className="font-body text-sm text-charcoal">
            <code className="font-mono text-xs break-all">{name}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the rewrite keeps, replaces, takes from the template and removes. */
function RewriteReport({ report }: { report: ConfigRewriteReport }) {
  const { t } = useTranslation("publish");
  return (
    <div className="max-h-[55dvh] overflow-y-auto -mx-2 px-2">
      <p className="font-body text-sm text-charcoal">
        {t("config_rewrite.intro", { version: stripVersionPrefix(report.templateTag) })}
      </p>
      {report.kept.length > 0 && (
        <p className="mt-3 font-body text-sm text-charcoal">
          {t("config_rewrite.kept", { count: report.kept.length })}
        </p>
      )}
      <NameList heading={t("config_rewrite.from_settings")} names={report.fromSettings} />
      <NameList heading={t("config_rewrite.template_values")} names={report.templateValues} />
      <NameList heading={t("config_rewrite.removed")} names={report.removed} />
      {report.commentsDropped && (
        <p className="mt-3 font-body text-sm text-charcoal">{t("config_rewrite.comments_dropped")}</p>
      )}
      <p className="mt-3 font-body text-sm text-charcoal/70">{t("config_rewrite.history")}</p>
    </div>
  );
}

/**
 * The review while `open`, and nothing otherwise: the dialog asks for its
 * preview when it mounts, so each opening asks afresh.
 */
export function ConfigRewriteReview({
  open,
  ...dialog
}: {
  open: boolean;
  onClose: () => void;
  onAccept: (fingerprint: string) => void;
}) {
  return open ? <ConfigRewriteDialog {...dialog} /> : null;
}

export function ConfigRewriteDialog({
  onClose,
  onAccept,
}: {
  onClose: () => void;
  /** Called with the fingerprint of the rewrite the author accepted. */
  onAccept: (fingerprint: string) => void;
}) {
  const { t } = useTranslation("publish");
  const { t: tCommon } = useTranslation("common");
  const fetcher = useSiteFetcher();
  const [step, setStep] = useState<Step>("preparing");
  // Whether the preview has been asked for: until then the fetcher is idle
  // with no answer, which is not an answer to read.
  const askedRef = useRef(false);
  const data = fetcher.data as PreviewData;

  useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    fetcher.submit({ intent: "preview-config-rewrite" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (step !== "preparing" || fetcher.state !== "idle" || data === undefined) return;
    if (isSiteChanged(data)) {
      onClose();
      return;
    }
    setStep(stepForPreviewAnswer(data));
  }, [step, fetcher.state, data, onClose]);

  const ready = step === "ready" && data?.ok ? data : null;

  return (
    <Dialog open onClose={onClose} className="max-w-lg p-0">
      <div className="p-6">
        <h3 className="font-heading font-semibold text-lg text-charcoal mb-3">{t("config_rewrite.title")}</h3>

        {step === "preparing" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="w-8 h-8 text-terracotta animate-spin" />
            <p className="font-body text-sm text-gray-600">{t("config_rewrite.preparing")}</p>
          </div>
        )}

        {ready && <RewriteReport report={ready.report} />}

        {(step === "failed" || step === "template_unavailable") && (
          <div className="flex items-start gap-3 py-4">
            <AlertCircle className="w-5 h-5 text-terracotta flex-shrink-0 mt-0.5" />
            <p role="alert" className="font-body text-sm text-charcoal">
              {t(step === "failed" ? "config_rewrite.failed" : "config_rewrite.template_unavailable")}
            </p>
          </div>
        )}

        <div className="mt-6 flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            className={`${buttonClass} border border-gray-200 text-charcoal hover:bg-cream`}
          >
            {tCommon("cancel")}
          </button>
          {ready && (
            <button
              type="button"
              onClick={() => onAccept(ready.fingerprint)}
              className={`${buttonClass} bg-terracotta hover:bg-terracotta/90 text-cream`}
            >
              {t("config_rewrite.confirm")}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

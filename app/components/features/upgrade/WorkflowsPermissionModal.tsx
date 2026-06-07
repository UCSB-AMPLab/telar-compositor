/**
 * WorkflowsPermissionModal — login-time prompt shown to a convenor whose
 * GitHub App installation has not accepted the `workflows: write` grant. Such
 * installs can't be upgraded through the compositor (the upgrade commit touches
 * .github/workflows/), and because publishing is gated behind being up to date,
 * they're effectively blocked until they approve. This surfaces the fix up
 * front instead of letting them discover it via a failed upgrade.
 *
 * Pure renderer: open-state, session dismissal, and the org-aware approval URL
 * are owned by `_app.tsx`. Copy lives in the `upgrade` i18n namespace; the
 * "upgrade manually" link target is locale-specific (workflowsModalManualUrl).
 * Escape and overlay-click dismiss.
 *
 * @version v1.3.0-beta
 */
import { useEffect } from "react";
import { useTranslation, Trans } from "react-i18next";
import { KeyRound } from "lucide-react";

export interface WorkflowsPermissionModalProps {
  open: boolean;
  onDismiss: () => void;
  /** Installation settings page where the pending permission is approved
   *  (org-aware; built by the loader's deriveWorkflowsApproval). */
  approvalUrl: string;
}

export function WorkflowsPermissionModal({
  open,
  onDismiss,
  approvalUrl,
}: WorkflowsPermissionModalProps) {
  const { t } = useTranslation("upgrade");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  const manualUrl = t("workflowsModalManualUrl");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50 p-4"
      onClick={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflows-perm-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[440px] max-w-[90vw] flex-col gap-4 overflow-y-auto rounded-xl bg-cream p-6 shadow-lg"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-pill bg-lavender text-terracotta">
          <KeyRound className="h-5 w-5" aria-hidden="true" />
        </div>
        <h2
          id="workflows-perm-title"
          className="font-heading text-lg font-semibold text-charcoal"
        >
          {t("workflowsModalTitle")}
        </h2>
        <p className="font-body text-sm leading-relaxed text-charcoal/80">
          {t("workflowsModalBody")}
        </p>
        <p className="font-body text-sm leading-relaxed text-charcoal/80">
          <Trans
            t={t}
            i18nKey="workflowsModalConsequence"
            components={[
              // eslint-disable-next-line jsx-a11y/anchor-has-content
              <a
                key="manual"
                href={manualUrl}
                target="_blank"
                rel="noreferrer"
                className="text-terracotta hover:underline"
              />,
            ]}
          />
        </p>
        <div className="mt-1 flex items-center justify-end gap-4">
          <button
            type="button"
            onClick={onDismiss}
            className="font-heading text-sm text-charcoal/60 transition-colors hover:text-charcoal"
          >
            {t("workflowsModalDismiss")}
          </button>
          <a
            href={approvalUrl}
            target="_blank"
            rel="noreferrer"
            onClick={onDismiss}
            className="rounded-lg bg-terracotta px-4 py-1.5 font-heading text-sm font-semibold text-cream transition-colors hover:bg-terracotta-deep"
          >
            {t("workflowsModalCta")}
          </a>
        </div>
      </div>
    </div>
  );
}

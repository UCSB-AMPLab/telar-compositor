/**
 * CheckFailedPopover — the body of the Site Status pill's `check-failed`
 * state: the last check of GitHub did not conclude, so the Compositor cannot
 * say whether anyone has committed since the last publish. It says so, that
 * editing goes on and publishing waits, and offers Try again, which asks
 * GitHub now rather than at the next poll. The button is disabled while a
 * check is in flight.
 *
 * Mirrors RepoUnavailablePopover's head/footer geometry. `popover` namespace.
 * Light mode only; lucide-react only; `~/` imports.
 *
 * @version v1.5.5-beta
 */

import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface CheckFailedPopoverProps {
  onTryAgain: () => void;
  /** A check is in flight; the button waits for it. */
  busy?: boolean;
  className?: string;
}

export function CheckFailedPopover({ onTryAgain, busy = false, className = "" }: CheckFailedPopoverProps) {
  const { t } = useTranslation("popover");
  return (
    <div className={className}>
      <div style={{ padding: "14px 18px 14px" }}>
        <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
          {t("check_failed.title")}
        </h3>
        <p className="font-body text-fg-muted" style={{ fontSize: "12px", marginTop: "6px", lineHeight: 1.45 }}>
          {t("check_failed.body")}
        </p>
        <p className="font-body text-charcoal" style={{ fontSize: "12px", marginTop: "8px", lineHeight: 1.45 }}>
          {t("check_failed.publish_line")}
        </p>
      </div>
      <div
        className="border-t border-border bg-cream flex items-center justify-end"
        style={{ padding: "11px 14px 12px" }}
      >
        <button
          type="button"
          onClick={onTryAgain}
          disabled={busy}
          className="font-heading font-semibold inline-flex items-center gap-1.5 bg-surface border border-border text-charcoal hover:bg-cream transition-colors disabled:opacity-60"
          style={{ fontSize: "11px", letterSpacing: "0.04em", textTransform: "uppercase", padding: "6px 14px", borderRadius: "9999px" }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
          {t("check_failed.try_again")}
        </button>
      </div>
    </div>
  );
}

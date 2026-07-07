/**
 * This file renders the amber alert banner used for important user
 * notices — Google Sheets auto-disable in the onboarding wizard,
 * the dashboard's sync banner, and any future "the user needs to
 * see this" surface.
 *
 * Optional props:
 *   - `cta`: right-aligned action button after the message text
 *   - `dismissible`: shows an X button at the top-right
 *   - `dismissKey`: when provided, the dismissed state persists in
 *     `sessionStorage` under that key (so the banner does not
 *     reappear on every render in the same session). Per-session
 *     only — reappears on a new tab/session if the divergence
 *     persists.
 *
 * Back-compat: existing callers (`<WarningBanner message=... />`)
 * are unchanged. All four extra props are optional.
 *
 * @version v1.4.0-beta
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";

export interface WarningBannerProps {
  message: string;
  className?: string;
  cta?: { label: string; onClick: () => void };
  dismissible?: boolean;
  /** sessionStorage key, e.g. `dismissed-sync-banner-{projectId}`. */
  dismissKey?: string;
  dismissAriaLabel?: string;
}

export function WarningBanner({
  message,
  className = "",
  cta,
  dismissible = false,
  dismissKey,
  dismissAriaLabel,
}: WarningBannerProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const resolvedDismissAriaLabel = dismissAriaLabel ?? t("dismiss");

  // Hydrate dismissed state from sessionStorage on mount (SSR-safe).
  useEffect(() => {
    if (!dismissKey) return;
    if (typeof window === "undefined") return;
    try {
      if (window.sessionStorage.getItem(dismissKey) === "1") {
        setDismissed(true);
      }
    } catch {
      // sessionStorage may be unavailable (privacy mode, iframe). Treat
      // as not-dismissed and silently continue.
    }
  }, [dismissKey]);

  if (dismissed) return null;

  function handleDismiss() {
    if (dismissKey && typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(dismissKey, "1");
      } catch {
        // see hydration catch above
      }
    }
    setDismissed(true);
  }

  return (
    <div
      role="alert"
      className={`bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3 ${className}`}
    >
      <AlertTriangle
        className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5"
        aria-hidden="true"
      />
      <p className="text-amber-800 text-sm font-body flex-1">{message}</p>
      {cta && (
        <button
          type="button"
          onClick={cta.onClick}
          className="text-sm font-heading font-semibold uppercase tracking-wider text-amber-900 hover:underline whitespace-nowrap"
        >
          {cta.label}
        </button>
      )}
      {dismissible && (
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={resolvedDismissAriaLabel}
          className="ml-1 text-amber-700 hover:text-amber-900 transition-colors"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

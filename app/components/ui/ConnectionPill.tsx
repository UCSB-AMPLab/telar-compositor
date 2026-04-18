/**
 * ConnectionPill — three-state connection status indicator for the header.
 *
 * At rest: coloured dot only (compact, unobtrusive).
 * On hover / focus: floating tooltip below the dot shows label text.
 *
 * States:
 *   connected  — green dot, "Connected" tooltip
 *   connecting — amber animated dot, "Connecting…" tooltip
 *   offline    — red dot, "Offline" tooltip + reassuring sub-text
 *
 * Uses font-body (Roboto Condensed) for tooltip text per visual identity.
 * All colours from Tailwind utility classes — no hardcoded hex values.
 *
 * Placement: right of PresenceBar, left of Users icon.
 */

import { useTranslation } from "react-i18next";

export interface ConnectionPillProps {
  status: "connected" | "connecting" | "offline";
  className?: string;
}

const dotConfig = {
  connected: {
    dot: "bg-green-500",
    label: "connection_status_connected",
    tooltipBg: "bg-green-50 border-green-200",
    text: "text-green-700",
  },
  connecting: {
    dot: "bg-amber-500 animate-pulse",
    label: "connection_status_connecting",
    tooltipBg: "bg-amber-50 border-amber-200",
    text: "text-amber-700",
  },
  offline: {
    dot: "bg-red-500",
    label: "connection_status_offline",
    tooltipBg: "bg-red-50 border-red-200",
    text: "text-red-700",
  },
} as const;

export function ConnectionPill({ status, className = "" }: ConnectionPillProps) {
  const { t } = useTranslation("collaboration");
  const cfg = dotConfig[status];
  const label = t(cfg.label);
  const tooltip = status === "offline" ? t("connection_status_tooltip") : null;

  return (
    <div className={`group relative inline-flex items-center ${className}`}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex items-center p-1.5 rounded-full transition-colors hover:bg-white/10"
      >
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${cfg.dot}`}
          aria-hidden="true"
        />
      </button>
      {/* Tooltip — positioned below the dot, appears on hover/focus.
          Right-anchored so the longer "offline" sub-message wraps inside the viewport
          instead of overflowing the page (pill sits near the right edge of the header). */}
      <div
        role="status"
        aria-live="polite"
        className={`absolute top-full right-0 mt-2 hidden group-hover:block group-focus-within:block w-max max-w-[16rem] whitespace-normal rounded-md border px-2.5 py-1.5 shadow-sm ${cfg.tooltipBg}`}
      >
        <span className={`font-body text-xs font-medium ${cfg.text}`}>{label}</span>
        {tooltip && (
          <p className={`font-body text-xs mt-0.5 opacity-75 ${cfg.text}`}>{tooltip}</p>
        )}
      </div>
    </div>
  );
}

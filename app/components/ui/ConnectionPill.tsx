/**
 * ConnectionPill — three-state connection status indicator for the header.
 *
 * At rest: coloured dot only (compact, unobtrusive).
 * On hover / focus: floating tooltip below the dot shows label text.
 *
 * States (the three connectionStatus keys map to deliberately calm copy and
 * colour):
 *   connected  — chilca (green) dot, "Live" tooltip
 *   connecting — amber animated dot, "Reconnecting…" tooltip
 *   offline    — neutral/cream dot, "Working solo" tooltip. This must NOT read
 *                as an error: an offline editor can still work locally, so an
 *                alarming red "Offline" treatment would be misleading.
 *
 * Tooltip label uses font-heading 600 (uppercase chrome label). All colours
 * come from Tailwind utility classes — no hardcoded hex values.
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
    dot: "bg-chilca",
    label: "presence_live",
    tooltipBg: "bg-surface border-gray-200",
    text: "text-charcoal",
  },
  connecting: {
    dot: "bg-amber-500 animate-pulse",
    label: "presence_reconnecting",
    tooltipBg: "bg-surface border-gray-200",
    text: "text-charcoal",
  },
  offline: {
    dot: "bg-cream-dark border border-gray-300",
    label: "presence_working_solo",
    tooltipBg: "bg-surface border-gray-200",
    text: "text-charcoal",
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
        <span className={`font-heading text-xs font-semibold uppercase ${cfg.text}`}>{label}</span>
        {tooltip && (
          <p className={`font-body text-xs mt-0.5 opacity-75 ${cfg.text}`}>{tooltip}</p>
        )}
      </div>
    </div>
  );
}

/**
 * WarningBanner — amber alert box for important user notices.
 *
 * Used for Google Sheets auto-disable notice in the onboarding wizard.
 */

import { AlertTriangle } from "lucide-react";

interface WarningBannerProps {
  message: string;
  className?: string;
}

export function WarningBanner({ message, className = "" }: WarningBannerProps) {
  return (
    <div
      role="alert"
      className={`bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3 ${className}`}
    >
      <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <p className="text-amber-800 text-sm font-body">{message}</p>
    </div>
  );
}

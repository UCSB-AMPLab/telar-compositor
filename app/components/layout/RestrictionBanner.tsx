/**
 * RestrictionBanner — full-width info banner for collaborator-restricted tabs.
 *
 * Shown on sync, publish, and upgrade routes when the current user's role
 * is "collaborator". Explains why the action is unavailable without blocking
 * navigation to the page.
 */

import { Lock } from "lucide-react";

interface RestrictionBannerProps {
  message: string;
  className?: string;
}

export function RestrictionBanner({ message, className }: RestrictionBannerProps) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border border-lavender/40 bg-cream-dark px-4 py-3 font-body text-sm text-charcoal ${className ?? ""}`}
    >
      <Lock className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}

/**
 * RoleHint — inline role-explanation primitive.
 *
 * Renders a muted line of explanatory text prefixed by a small Info icon.
 * Used to explain why a role-gated affordance is hidden or unavailable
 * without heavier full-width banner styling. This is the explanation half of
 * the don't-render contract: rather than greying out an affordance the user
 * cannot use, the affordance is omitted and this hint tells them why.
 *
 * Tokens only: text-fg-muted + text-xs (the 12px floor).
 *
 * @version v1.3.0-beta
 */

import { Info } from "lucide-react";

interface RoleHintProps {
  children: React.ReactNode;
  className?: string;
}

export function RoleHint({ children, className = "" }: RoleHintProps) {
  return (
    <p
      className={`inline-flex items-center gap-1.5 font-body text-xs text-fg-muted ${className}`}
    >
      <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

/**
 * Button component — primary and control variants.
 *
 * Primary: periwinkle pill button for main CTAs.
 * Control: bordered control button for editor toolbar actions.
 */

import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "control";
  loading?: boolean;
  className?: string;
}

export function Button({
  variant = "primary",
  loading = false,
  disabled,
  children,
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 font-heading font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

  const variants: Record<string, string> = {
    primary:
      "bg-periwinkle hover:bg-periwinkle-hover text-charcoal uppercase tracking-wider rounded-full px-6 py-2.5 text-sm",
    control:
      "bg-white border border-gray-200 text-charcoal text-sm rounded-[0.375rem] px-3 py-1.5 hover:bg-cream",
  };

  return (
    <button
      disabled={disabled || loading}
      className={`${base} ${variants[variant]} ${className}`}
      {...props}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}

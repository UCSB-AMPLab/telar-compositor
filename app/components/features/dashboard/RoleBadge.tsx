/**
 * RoleBadge — inline role chip for project members.
 *
 * Variants: convenor (blue), collaborator (periwinkle/charcoal), pending (gray).
 */

import { useTranslation } from "react-i18next";

interface RoleBadgeProps {
  role: "convenor" | "collaborator" | "pending";
  className?: string;
}

const badgeStyles = {
  convenor: "bg-blue-100 text-blue-700",
  collaborator: "bg-periwinkle/30 text-charcoal",
  pending: "bg-gray-100 text-gray-500",
} as const;

const labelKeys = {
  convenor: "convenor_label",
  collaborator: "collaborator_label",
  pending: "pending_label",
} as const;

export function RoleBadge({ role, className }: RoleBadgeProps) {
  const { t } = useTranslation("team");
  return (
    <span
      className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 font-heading text-xs font-semibold uppercase tracking-wider ${badgeStyles[role]} ${className ?? ""}`}
    >
      {t(labelKeys[role])}
    </span>
  );
}

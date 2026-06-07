/**
 * MemberRow — single member or pending-invite row in the TeamPanel member list.
 *
 * Shows GitHub avatar, username, role badge, and (for convenors only) an
 * always-visible kebab menu (MoreVertical) that opens a Remove dropdown item.
 * The kebab is only rendered when isConvenor=true (defence-in-depth; the
 * server-side requireOwner guard is the primary control).
 *
 * The kebab is wired to the existing onRemove callback so the Remove action
 * is always accessible (including on touch devices).
 */

import { useState, useEffect, useRef } from "react";
import { MoreVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { RoleBadge } from "~/components/features/dashboard/RoleBadge";

export interface RemoveTarget {
  userId: number;
  username: string;
}

interface MemberRowProps {
  githubId: number;
  /** Database userId — required when onRemoveRequest is used. */
  userId?: number;
  username: string;
  role: "convenor" | "collaborator";
  isPending?: boolean;
  isCurrentUserOwner: boolean;
  /** True when the current user is the convenor — gates the kebab. */
  isConvenor?: boolean;
  /** Legacy: called when the Remove item is clicked (TeamPanel pattern). */
  onRemove?: () => void;
  /**
   * Preferred for sidebar usage: called with the member's identity
   * so the sidebar can open the centred RemoveCollaboratorModal.
   */
  onRemoveRequest?: (target: RemoveTarget) => void;
  className?: string;
}

/**
 * MemberRowKebab — always-visible three-dot menu for a collaborator row.
 *
 * Rendered only when isConvenor=true. Contains a single "Remove" menu item
 * that fires onRemoveRequest (sidebar modal) or falls back to
 * onRemove (legacy TeamPanel pattern).
 */
function MemberRowKebab({
  username,
  onRemove,
  onRemoveRequest,
  userId,
}: {
  username: string;
  userId?: number;
  onRemove?: () => void;
  onRemoveRequest?: (target: RemoveTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation("team");

  // Close on outside mousedown
  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-label={`Row menu for @${username}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="ml-1 p-1 rounded text-gray-400 hover:text-charcoal transition-colors"
      >
        <MoreVertical className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-[120px] bg-white border border-gray-100 shadow-md rounded-control py-1"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-1.5 text-sm font-body text-terracotta hover:bg-cream transition-colors"
            onClick={() => {
              setOpen(false);
              if (onRemoveRequest && userId !== undefined) {
                onRemoveRequest({ userId, username });
              } else {
                onRemove?.();
              }
            }}
          >
            {t("remove_confirm")}
          </button>
        </div>
      )}
    </div>
  );
}

export function MemberRow({
  githubId,
  userId,
  username,
  role,
  isPending = false,
  isCurrentUserOwner,
  isConvenor = false,
  onRemove,
  onRemoveRequest,
  className,
}: MemberRowProps) {
  const avatarUrl = `https://avatars.githubusercontent.com/u/${githubId}?s=64`;
  const canShowKebab = isConvenor && role === "collaborator" && !isPending;

  return (
    <div
      className={`relative flex items-center gap-3 px-3 py-2.5 bg-white hover:bg-cream-dark [&:not(:last-child)]:border-b border-gray-100 transition-colors ${isPending ? "opacity-60" : ""} ${className ?? ""}`}
    >
      {/* Avatar */}
      <img
        src={avatarUrl}
        alt={username}
        className="w-8 h-8 rounded-full shrink-0 bg-cream-dark"
      />

      {/* Username */}
      <span className="font-body text-sm text-charcoal flex-1 min-w-0 truncate">
        @{username}
      </span>

      {/* Role badge */}
      <RoleBadge role={isPending ? "pending" : role} />

      {/* Kebab menu — always visible when current user is convenor */}
      {canShowKebab && (
        <MemberRowKebab
          username={username}
          userId={userId}
          onRemove={onRemove}
          onRemoveRequest={onRemoveRequest}
        />
      )}
    </div>
  );
}

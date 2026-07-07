/**
 * CollaborationSidebar — right-hand slide-in overlay for collaboration info.
 *
 * Three sections:
 *   1. Online now — connected remote collaborators (presence-authenticated only)
 *   2. Contributions — DonutChart from contributionsByUser
 *   3. Team / Invite — MemberRow list + InviteForm for convenor
 *
 * Entry point: Users icon in Header.
 * State: local sidebarOpen, no URL or localStorage.
 * z-index: z-40 (modal inside is z-50).
 * a11y: focus-trap via close button focus on open; focus-return on close;
 *       Escape closes; aria-hidden when closed; role="complementary" when open.
 */

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { AlertTriangle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { DonutChart } from "~/components/features/collaboration/DonutChart";
import type { DonutMember } from "~/components/features/collaboration/DonutChart";
import { RemoveCollaboratorModal } from "~/components/features/collaboration/RemoveCollaboratorModal";
import { MemberRow } from "~/components/features/dashboard/MemberRow";
import { InviteForm } from "~/components/features/dashboard/InviteForm";

// AVATAR_FALLBACK_PALETTE — 8 colours, assigned by index, for the DonutChart
// contribution-avatar fallback when a member has no `presenceColor`.
// Deliberately distinct from membership.server.ts's own `PRESENCE_PALETTE`
// (a 6-entry palette assigning each project member's persistent presence
// colour) — accepted as a separate, intentional data-viz palette rather than
// unified, since the two serve different lifetimes (per-project persistent
// assignment vs. per-render chart fallback) and different sizes (6 vs 8).
// Defined inline here (rather than imported) to avoid a circular dep
// through PresenceBar.
const AVATAR_FALLBACK_PALETTE = [
  "#8B5E3C",
  "#4A7C9E",
  "#6B8E23",
  "#9B59B6",
  "#E67E22",
  "#1ABC9C",
  "#E74C3C",
  "#2C3E50",
];

interface Member {
  userId: number;
  githubId: number;
  username: string;
  role: "convenor" | "collaborator";
  contributions: {
    fields_edited: number;
    sessions: number;
    stories_edited: string[];
    objects_edited: string[];
    last_active: string | null;
  } | null;
  presenceColor?: string | null;
}

/**
 * PendingInvite — an outstanding token-based invitation that has not yet been
 * accepted. These are anonymous (no invitee identity is stored until the link
 * is used), so a row shows a generic "pending" label plus a cancel affordance.
 */
export interface PendingInvite {
  id: number;
  createdBy?: number;
}

export interface CollaborationSidebarProps {
  open: boolean;
  onClose: () => void;
  isConvenor: boolean;
  members: Member[];
  /** Outstanding, not-yet-accepted invitations (convenor-only surface). */
  pendingInvites?: PendingInvite[];
  seats: { used: number; limit: number };
  /** ref to the Users icon button — focus returns here on close (a11y) */
  triggerRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}

interface RemoveTarget {
  userId: number;
  username: string;
}

export function CollaborationSidebar({
  open,
  onClose,
  isConvenor,
  members,
  pendingInvites = [],
  seats,
  triggerRef,
  className,
}: CollaborationSidebarProps) {
  const { t } = useTranslation(["collaboration", "team", "common"]);
  const { remoteCollaborators, contributionsByUser, isPublishing, isUpgrading } = useCollaborationContext();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const removeFetcher = useFetcher();
  const cancelInviteFetcher = useFetcher();

  // Optimistic revocation: while a cancel-invite POST is in flight, hide the
  // targeted row immediately (the loader revalidation removes it for good on
  // completion). Mirrors the per-fetcher optimistic pattern used elsewhere.
  const cancellingInviteId =
    cancelInviteFetcher.state !== "idle"
      ? Number(cancelInviteFetcher.formData?.get("inviteId"))
      : null;
  const visibleInvites = pendingInvites.filter((inv) => inv.id !== cancellingInviteId);

  // Auto-close when a freeze starts so the sidebar doesn't sit behind the modal
  useEffect(() => {
    if ((isPublishing || isUpgrading) && open) onClose();
  }, [isPublishing, isUpgrading, open, onClose]);

  // Focus the close button when opening (a11y entry point)
  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => closeRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  // Return focus to trigger on close
  useEffect(() => {
    if (!open && triggerRef?.current) {
      const raf = requestAnimationFrame(() => triggerRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open, triggerRef]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Build online-now list: filter remoteCollaborators to only authenticated project members
  const memberUserIds = new Set(members.map((m) => m.githubId));
  const onlineList = remoteCollaborators.filter(
    (c) => memberUserIds.has(c.user.githubId)
  );

  // Build DonutChart data: join members + contributionsByUser + AVATAR_FALLBACK_PALETTE colour
  const donutData: DonutMember[] = members.map((m, i) => ({
    userId: m.userId,
    name: m.username,
    color: m.presenceColor ?? AVATAR_FALLBACK_PALETTE[i % AVATAR_FALLBACK_PALETTE.length],
    count: contributionsByUser.get(m.userId)?.fields_edited ?? 0,
    isConvenor: m.role === "convenor",
  }));

  // Find the convenor member for InviteForm projectId
  const convenorMember = members.find((m) => m.role === "convenor");
  // projectId not passed directly; derive from context or leave as 0 (InviteForm
  // submits to /dashboard which resolves project from session)
  const projectId = 0;

  function handleConfirmRemove(userId: number) {
    const fd = new FormData();
    fd.set("intent", "remove-member");
    fd.set("userId", String(userId));
    removeFetcher.submit(fd, { method: "post", action: "/dashboard" });
    setRemoveTarget(null);
  }

  function handleCancelInvite(inviteId: number) {
    const fd = new FormData();
    fd.set("intent", "cancel-invite");
    fd.set("inviteId", String(inviteId));
    cancelInviteFetcher.submit(fd, { method: "post", action: "/dashboard" });
  }

  return (
    <>
      {/* Backdrop — only rendered when open */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/10"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        ref={undefined}
        role={open ? "complementary" : undefined}
        aria-hidden={!open}
        aria-labelledby="collab-sidebar-title"
        className={[
          "fixed inset-y-0 right-0 w-80 max-w-full bg-white shadow-xl z-40",
          "transform transition-transform duration-300 ease-in-out",
          "flex flex-col overflow-hidden",
          open ? "translate-x-0" : "translate-x-full",
          className ?? "",
        ].join(" ")}
      >
        {/* Header */}
        <header className="px-4 py-3 flex items-center justify-between border-b border-gray-100 shrink-0">
          <h2
            id="collab-sidebar-title"
            className="font-heading text-base font-semibold text-charcoal"
          >
            {t("collaboration:sidebar_title")}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("common:close")}
            className="p-1 rounded text-gray-400 hover:text-charcoal transition-colors"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        {/* Open-beta notice — a permanent reminder that collaboration is in
            testing, with how to report bugs. Stays put above the scroll area. */}
        <div className="flex items-start gap-2 bg-qolle-pale px-4 py-2.5 text-xs leading-snug text-qolle-deep border-b border-qolle/30 shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{t("collaboration:beta_banner")}</span>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Section 1: Online now */}
          <section aria-labelledby="sb-online" className="px-4 pt-4 pb-3 border-b border-gray-100">
            <h3
              id="sb-online"
              className="font-heading text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2"
            >
              {t("collaboration:online_now")}
            </h3>
            {onlineList.length === 0 ? (
              <p className="font-body text-sm text-gray-400">—</p>
            ) : (
              <ul className="space-y-2">
                {onlineList.map((c) => (
                  <li key={c.clientId} className="flex items-center gap-2">
                    <img
                      src={`https://avatars.githubusercontent.com/u/${c.user.githubId}?s=48`}
                      alt={c.user.name}
                      className="w-6 h-6 rounded-full shrink-0"
                      style={{ outline: `2px solid ${c.user.color}`, outlineOffset: "1px" }}
                    />
                    <span className="font-body text-sm text-charcoal truncate">
                      @{c.user.name}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Section 2: Contributions */}
          <section aria-labelledby="sb-contrib" className="px-4 pt-4 pb-3 border-b border-gray-100">
            <h3
              id="sb-contrib"
              className="font-heading text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3"
            >
              {t("collaboration:contributions")}
            </h3>
            <DonutChart members={donutData} />
          </section>

          {/* Section 3: Team / Invite */}
          <section aria-labelledby="sb-team" className="px-4 pt-4 pb-4">
            <h3
              id="sb-team"
              className="font-heading text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2"
            >
              {t("team:team_heading")}
            </h3>
            <ul className="rounded-lg overflow-hidden border border-gray-100">
              {members.map((m) => (
                <MemberRow
                  key={m.userId}
                  githubId={m.githubId}
                  userId={m.userId}
                  username={m.username}
                  role={m.role}
                  isCurrentUserOwner={isConvenor}
                  isConvenor={isConvenor}
                  onRemoveRequest={(target) =>
                    setRemoveTarget({ userId: target.userId, username: target.username })
                  }
                />
              ))}
            </ul>

            {/* Pending invitations — convenor-only. Sits beside the invite
                controls so a sent-but-unaccepted invite can be revoked before
                it occupies a seat. Cancels dispatch intent "cancel-invite" to
                the shared /dashboard action (requireOwner-guarded). */}
            {isConvenor && (
              <div className="mt-4">
                <h4 className="font-heading text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  {t("team:pending_invites_heading")}
                </h4>
                {visibleInvites.length === 0 ? (
                  <p className="font-body text-sm text-gray-400">
                    {t("team:pending_invites_empty")}
                  </p>
                ) : (
                  <ul className="rounded-lg overflow-hidden border border-gray-100">
                    {visibleInvites.map((inv) => (
                      <li
                        key={inv.id}
                        className="flex items-center gap-3 px-3 py-2.5 bg-white opacity-70 [&:not(:last-child)]:border-b border-gray-100"
                      >
                        <div
                          className="w-8 h-8 rounded-full bg-gray-100 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="font-body text-sm text-gray-400 flex-1 min-w-0 truncate">
                          {t("team:pending_label")}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCancelInvite(inv.id)}
                          disabled={cancelInviteFetcher.state !== "idle"}
                          aria-label={t("team:cancel_invite_aria")}
                          title={t("team:cancel_invite")}
                          className="shrink-0 p-1 rounded text-gray-300 hover:text-terracotta transition-colors disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {isConvenor && (
              <InviteForm
                projectId={projectId}
                isOwner={isConvenor}
                className="mt-3"
              />
            )}
            <p className="font-body text-xs text-gray-400 mt-2">
              {seats.used} / {seats.limit}
            </p>
          </section>
        </div>

        {/* Remove collaborator modal — z-50, above sidebar z-40 */}
        {removeTarget && (
          <RemoveCollaboratorModal
            open={true}
            username={removeTarget.username}
            userId={removeTarget.userId}
            onConfirm={handleConfirmRemove}
            onCancel={() => setRemoveTarget(null)}
          />
        )}
      </aside>
    </>
  );
}

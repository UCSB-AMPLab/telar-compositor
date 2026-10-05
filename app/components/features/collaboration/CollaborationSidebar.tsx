/**
 * CollaborationSidebar — right-hand slide-in overlay for collaboration info.
 *
 * Four sections:
 *   1. Online now — connected remote collaborators (presence-authenticated only)
 *   2. Your own contributions, loaded on every open and while open
 *   3. Your time in the Compositor
 *   4. Team / Invite — MemberRow list + InviteForm for convenor
 *
 * Entry point: Users icon in Header.
 * State: local sidebarOpen, no URL or localStorage.
 * z-index: z-40 (modal inside is z-50).
 * a11y: focus-trap via close button focus on open; focus-return on close;
 *       Escape closes; aria-hidden when closed; role="complementary" when open.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { usePageSite, useSiteFetcher } from "~/lib/page-site";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { AlertTriangle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useAnswerKeptFor } from "~/hooks/use-answer-kept-for";
import { useToast } from "~/hooks/use-toast";
import { SidebarContributions } from "~/components/features/contributions/SidebarContributions";
import type { MemberContribution } from "~/lib/contributions";
import { RemoveCollaboratorModal } from "~/components/features/collaboration/RemoveCollaboratorModal";
import { MemberRow } from "~/components/features/dashboard/MemberRow";
import { InviteForm } from "~/components/features/dashboard/InviteForm";
import { useOverlayOpen } from "~/hooks/use-overlay-open";


interface Member {
  userId: number;
  githubId: number;
  username: string;
  role: "convenor" | "collaborator" | "instructor";
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
  /** Null once the issuer's account is deleted — a code outlives its creator. */
  createdBy?: number | null;
}

export interface CollaborationSidebarProps {
  open: boolean;
  onClose: () => void;
  isConvenor: boolean;
  members: Member[];
  /** Outstanding, not-yet-accepted invitations (convenor-only surface). */
  pendingInvites?: PendingInvite[];
  seats: { used: number; limit: number };
  /**
   * True when the project this sidebar is showing IS a course project
   * (kind === "course"), not a child site enrolled in one. Gates
   * MemberRow's kebab for instructor rows: course-management, including
   * removing staff, belongs to the course project's own member list —
   * never a child's, where instructor membership is tied to the course
   * and can only be ended by leaving it (design §5).
   */
  isCourseProject?: boolean;
  /** ref to the Users icon button — focus returns here on close (a11y) */
  triggerRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}

interface RemoveTarget {
  userId: number;
  username: string;
}

/** How often the open panel asks for the record again. */
const RECORD_POLL_MS = 30_000;
/** How long after the reader's last own change the panel asks early. */
const RECORD_OWN_EDIT_MS = 2_000;
/** The record, read as the panel's (the route's `clientLoader`). */
const RECORD_URL = "/contributions?panel=record";

interface PanelRecord {
  members: MemberContribution[];
  currentUserId: number;
  /** The project the record was read for. */
  projectId: number;
}

export function CollaborationSidebar({
  open,
  onClose,
  isConvenor,
  members,
  pendingInvites = [],
  seats,
  isCourseProject = false,
  triggerRef,
  className,
}: CollaborationSidebarProps) {
  const { t } = useTranslation(["collaboration", "team", "common"]);
  const { ydoc, remoteCollaborators, isPublishing, isUpgrading } = useCollaborationContext();
  const { showToast } = useToast();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useOverlayOpen(open);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const removeFetcher = useSiteFetcher<{ ok: boolean; intent: string; error?: string }>();
  const cancelInviteFetcher = useSiteFetcher();
  // The record is loaded while the panel is open rather than with every page:
  // it is a dozen aggregates, and no surface outside this panel and its own
  // page reads it. `/contributions` serves it as the page's own loader data, so
  // the panel and the record can never be built from different reads. Read as
  // the panel's, a failed read answers `{ unreachable: true }` instead of
  // reaching the error card, and the panel keeps the last record it showed
  // for the active project.
  const recordFetcher = useFetcher<PanelRecord | { unreachable: true }>();
  const recordProjectId = usePageSite().live;
  // The last record, for the project its read was sent under.
  const { kept: record, markSent } = useAnswerKeptFor<PanelRecord>(
    recordFetcher.data,
    (answer) => (answer && !("unreachable" in (answer as object)) ? (answer as PanelRecord) : null),
    recordProjectId,
    (kept) => kept.projectId,
  );
  const loadRecord = () => {
    markSent();
    recordFetcher.load(RECORD_URL);
  };

  // Every clock, bar, share line and percentage in the panel derives from the
  // one row this fetch brings back, so a refetch moves all of them together and
  // none of them can go stale against another. The seconds it carries are the
  // Durable Object's, which move as people work; the beat is what keeps the
  // panel from showing a figure taken when it opened.
  //
  // Thirty seconds because the booking rule credits a minute in advance of a
  // change: at that resolution a figure taken every thirty seconds and one
  // pushed on every keystroke are the same figure.
  useEffect(() => {
    if (!open) return;
    loadRecord();
    const beat = setInterval(loadRecord, RECORD_POLL_MS);
    return () => clearInterval(beat);
    // Keyed on `open` alone: the fetcher's identity changes with every state
    // transition it makes, and depending on it would restart the beat mid-cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The reader's own edits, which are the ones they will look down to see
  // counted, are worth a refetch sooner than the beat allows. Debounced,
  // because a burst of typing is one stretch of work and books one minute
  // however many transactions it arrives in; remote transactions are somebody
  // else's changes and the beat already carries them.
  useEffect(() => {
    if (!open || !ydoc) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    function onTransaction(tr: { local: boolean }) {
      if (!tr.local) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(loadRecord, RECORD_OWN_EDIT_MS);
    }
    ydoc.on("afterTransaction", onTransaction);
    return () => {
      ydoc.off("afterTransaction", onTransaction);
      if (pending) clearTimeout(pending);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ydoc]);

  // A refused removal leaves the row exactly where it was, so without this
  // the panel reports a refusal as though nothing had been asked.
  //
  // `instructor_on_child` has its own sentence: instructor membership on a
  // child is tied to the course in both directions (design §5), which is a
  // standing rule rather than a failure, and the kebab already hides the
  // path (MemberRow's isCourseProject gate). Every other refusal —
  // `cannot_remove_owner`, `no_project`, a missing id — is a state the
  // convenor cannot act on differently, and takes the generic sentence.
  useEffect(() => {
    if (removeFetcher.state !== "idle" || !removeFetcher.data || removeFetcher.data.ok) return;
    // The layout's notice speaks for a write refused because the site changed.
    if (isSiteChanged(removeFetcher.data)) return;
    showToast({
      message:
        removeFetcher.data.error === "instructor_on_child"
          ? t("team:remove_instructor_refused")
          : t("team:error_remove_failed"),
      type: "destructive",
    });
  }, [removeFetcher.state, removeFetcher.data, showToast, t]);

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

          {/* Section 2: your own contributions, and your time.
              The donut this replaced was drawn from `fields_edited`, which
              counts unique field paths touched and so reported a convenor who
              catalogued thirty objects as barely present. What it showed was
              never the question anyone was asking. */}
          <SidebarContributions
            members={record?.members}
            currentUserId={record?.currentUserId}
            recordHref="/contributions"
          />

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
                  isCourseProject={isCourseProject}
                  onRemoveRequest={(target) =>
                    setRemoveTarget({ userId: target.userId, username: target.username })
                  }
                />
              ))}
            </ul>
            <a
              href="/team"
              className="block mt-2 font-heading text-[13px] text-terracotta no-underline hover:text-terracotta-deep"
            >
              {t("team:team_page_link")}
            </a>

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

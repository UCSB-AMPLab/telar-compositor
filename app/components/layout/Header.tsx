/**
 * This file renders the authenticated app header bar — a single 56px charcoal
 * bar (#333333) carrying the persistent global chrome: the Telar wordmark
 * (links to /), the global project switcher pill, the site status pill,
 * presence avatars, the connection pill, the user menu, and a standalone
 * bug-report button to the right of the user menu.
 *
 * The user menu doubles as a secondary entry point for two things: it carries
 * the role chip (above the divider) and keeps a "Report a problem" item — that
 * item and the standalone button open the same bug-report panel. Undo/redo
 * deliberately do NOT live here; they belong with the TabNav tab bar so the
 * header stays purely a global-context strip.
 *
 * @version v1.3.7-beta
 */

import { useState, useRef, useEffect } from "react";
import { Form, Link, useRouteLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronDown, User, LogOut, Github, Users, Bug } from "lucide-react";
import type { AuthenticatedUser } from "~/middleware/auth.server";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useRole } from "~/hooks/use-role";
import { PresenceBar } from "~/components/ui/PresenceBar";
import { ConnectionPill } from "~/components/ui/ConnectionPill";
import { SiteStatusPill } from "~/components/features/site-status/SiteStatusPill";
import { ProjectSwitcher } from "~/components/features/header/ProjectSwitcher";
import { BugReportPanel } from "~/components/features/bug-report/BugReportPanel";
import { BugReportButton } from "~/components/features/bug-report/BugReportButton";

/** Shape of the routes/_app loader fields the header reads. */
interface AppLoaderData {
  allProjects?: Array<{
    id: number;
    github_repo_full_name: string;
    userRole: "convenor" | "collaborator";
    ownerLogin?: string;
    collaboratorCount?: number;
  }>;
  activeProjectId?: number | null;
  /** Active project's GitHub repo ("owner/name"), threaded into bug reports. */
  repoFullName?: string | null;
  /** True when the active project has at least one collaborator (members > 1).
   * The Convenor/Collaborator role distinction has no meaning on a solo project,
   * so the role chip is hidden until someone else joins. */
  activeProjectShared?: boolean;
}

/** User-menu role chip — caracol for convenor, cream-dark for collaborator.
 * Hidden on solo projects: the Convenor/Collaborator distinction has no meaning
 * until at least one other member exists (mirrors ConnectedSitesCard logic). */
function RoleChip() {
  const { t } = useTranslation("common");
  const role = useRole();
  const app = useRouteLoaderData("routes/_app") as AppLoaderData | null;
  const activeProjectShared = app?.activeProjectShared ?? false;
  if (!role || !activeProjectShared) return null;
  const cls =
    role === "convenor"
      ? "bg-caracol-pale text-caracol"
      : "bg-cream-dark text-charcoal";
  return (
    <span
      className={`inline-flex items-center font-heading font-semibold uppercase rounded ${cls}`}
      style={{ fontSize: "10px", letterSpacing: "0.05em", padding: "3px 9px" }}
    >
      {t(`role.${role}`)}
    </span>
  );
}

interface HeaderProps {
  user: Pick<AuthenticatedUser, "github_id" | "github_login" | "github_name" | "github_email">;
  environment?: string;
  presenceColor?: string | null;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  usersIconRef?: React.RefObject<HTMLButtonElement | null>;
  hasProject?: boolean;
  className?: string;
}

export function Header({ user, environment, presenceColor, sidebarOpen, onToggleSidebar, usersIconRef, hasProject = false, className = "" }: HeaderProps) {
  const { t: tCollab } = useTranslation("collaboration");
  const { t: tCommon } = useTranslation("common");
  const { t: tAccount } = useTranslation("account");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { connectionStatus, isPublishing, isUpgrading } = useCollaborationContext();
  const isFrozen = isPublishing || isUpgrading;

  // Project switcher data — read from the routes/_app loader. The switcher
  // tolerates allProjects being undefined.
  const app = useRouteLoaderData("routes/_app") as AppLoaderData | null;

  // Bug-report panel — also folded into the user menu as "Report a problem".
  // The panel itself is reused as-is; only the trigger relocates.
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const reportTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClick);
    }
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  const displayName = user.github_name || user.github_login;
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <header
      className={`h-14 landscape-compact:h-11 bg-charcoal flex items-center justify-between px-3 sm:px-6 sticky top-0 z-30 ${className}`}
    >
      {/* Left section: brand + project switcher */}
      <div className="flex items-center gap-2 sm:gap-4 min-w-0">
        {/* Brand — links to /. */}
        <Link
          to="/"
          className="flex items-center gap-2.5 shrink-0 hover:opacity-80 transition-opacity"
        >
          <img src="/logo-lila-amarillo.svg" alt="Telar" className="h-9 max-h-9 landscape-compact:h-7 landscape-compact:max-h-7 w-auto shrink-0" />
          <span className="font-heading font-normal text-anil hidden lg:inline" style={{ fontSize: "24px" }}>
            Compositor
          </span>
          {environment === "staging" && (
            <span className="ml-2 px-2 py-0.5 rounded-full bg-anil/20 border border-anil/40 font-heading text-xs text-anil font-semibold tracking-wide uppercase">
              Staging
            </span>
          )}
        </Link>

        {/* Global project switcher pill. Hidden during onboarding (no active
            project), mirroring the status/connection pills. */}
        {hasProject && (
          <ProjectSwitcher
            allProjects={app?.allProjects}
            activeProjectId={app?.activeProjectId ?? null}
          />
        )}
      </div>

      {/* Right section: site status + presence bar + connection status + user menu */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        {/* Site Status pill — the global five-state status indicator. Guarded by
            hasProject, mirroring the ConnectionPill: site status is meaningless
            during onboarding. */}
        {hasProject && <SiteStatusPill />}
        <PresenceBar />
        {/* Connection status pill — three states: connected / connecting / offline.
            Hidden when there is no active project: collaboration state is meaningless
            during onboarding and the alarming "Offline" copy reads as a session error. */}
        {hasProject && <ConnectionPill status={connectionStatus} />}

        {/* Collaboration sidebar toggle */}
        {onToggleSidebar && (
          <button
            ref={usersIconRef}
            type="button"
            onClick={onToggleSidebar}
            disabled={!hasProject || isFrozen}
            aria-expanded={sidebarOpen}
            aria-label={sidebarOpen ? tCollab("sidebar_close_aria") : tCollab("sidebar_open_aria")}
            className={`p-1.5 pointer-coarse:min-w-11 pointer-coarse:min-h-11 inline-flex items-center justify-center rounded-full transition-colors focus-visible:outline-offset-0 ${
              !hasProject || isFrozen
                ? "text-gray-500 cursor-not-allowed"
                : sidebarOpen
                  ? "bg-anil/20 text-anil"
                  : "text-white hover:bg-white/10"
            }`}
          >
            <Users className="w-4.5 h-4.5" />
          </button>
        )}

        {/* User menu */}
        <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setDropdownOpen((v) => !v)}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity rounded-full focus-visible:outline-offset-0"
          aria-haspopup="true"
          aria-expanded={dropdownOpen}
          aria-label={tCommon("user_menu_aria")}
        >
          {/* Avatar with presence colour ring */}
          <img
            src={`https://avatars.githubusercontent.com/u/${user.github_id}?s=56`}
            alt={displayName}
            className="w-7 h-7 rounded-full object-cover bg-anil"
            style={presenceColor ? { outline: `2px solid ${presenceColor}`, outlineOffset: "1px" } : undefined}
            onError={(e) => {
              const target = e.currentTarget;
              target.style.display = "none";
              const sibling = target.nextElementSibling as HTMLElement | null;
              if (sibling) sibling.style.display = "flex";
            }}
          />
          <span
            className="w-7 h-7 rounded-full bg-anil text-charcoal font-heading font-semibold text-xs items-center justify-center hidden"
            style={presenceColor ? { outline: `2px solid ${presenceColor}`, outlineOffset: "1px" } : undefined}
            aria-hidden="true"
          >
            {initials}
          </span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-white transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
          />
        </button>

        {/* Dropdown */}
        {dropdownOpen && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-10"
              onClick={() => setDropdownOpen(false)}
              aria-hidden="true"
            />
            <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-100 z-20 py-1">
              {/* User info — role chip sits above the divider. */}
              <div className="px-4 py-3 border-b border-gray-100">
                <div className="mb-2">
                  <RoleChip />
                </div>
                <p className="font-heading font-semibold text-sm text-charcoal truncate">
                  {displayName}
                </p>
                {user.github_email && (
                  <p className="font-body text-xs text-gray-500 truncate mt-0.5">
                    {user.github_email}
                  </p>
                )}
              </div>

              {/* GitHub profile */}
              <a
                href={`https://github.com/${user.github_login}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setDropdownOpen(false)}
                className="flex items-center gap-2 px-4 py-2.5 text-sm font-body text-charcoal hover:bg-cream transition-colors"
              >
                <Github className="w-4 h-4 text-gray-400" />
                GitHub
              </a>

              {/* Account */}
              <Link
                to="/account"
                onClick={() => setDropdownOpen(false)}
                className="flex items-center gap-2 px-4 py-2.5 text-sm font-body text-charcoal hover:bg-cream transition-colors"
              >
                <User className="w-4 h-4 text-gray-400" />
                {tAccount("user_menu_item")}
              </Link>

              {/* Report a problem — folds the bug-report trigger into the menu.
                  Opens the existing BugReportPanel as-is. */}
              <button
                ref={reportTriggerRef}
                type="button"
                aria-label={tCommon("user_menu.report_problem")}
                onClick={() => {
                  setDropdownOpen(false);
                  setBugReportOpen(true);
                }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-body text-charcoal hover:bg-cream transition-colors"
              >
                <Bug className="w-4 h-4 text-gray-400" />
                {tCommon("user_menu.report_problem")}
              </button>

              {/* Sign out */}
              <Form method="post" action="/signout">
                <button
                  type="submit"
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-body text-terracotta hover:bg-cream transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  {tCommon("sign_out")}
                </button>
              </Form>
            </div>
          </>
        )}
        </div>

        {/* Standalone bug-report button — rightmost, to the right of the user
            menu. Self-contained (its own panel + state); the user menu also
            keeps a "Report a problem" item that opens the same panel. */}
        {/* Standalone bug button — hidden below lg; it is also in the user
            dropdown ("Report a problem"), so narrow headers stay uncluttered. */}
        <span className="hidden lg:inline-flex">
          <BugReportButton userLogin={user.github_login} />
        </span>
      </div>

      {/* Bug-report panel — reused as-is; trigger lives in the user menu. */}
      <BugReportPanel
        open={bugReportOpen}
        onClose={() => setBugReportOpen(false)}
        mode="default"
        userLogin={user.github_login}
        repoFullName={app?.repoFullName ?? undefined}
        triggerRef={reportTriggerRef}
      />
    </header>
  );
}

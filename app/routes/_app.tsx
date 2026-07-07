/**
 * This file is the authenticated application layout — every signed-in
 * page renders inside its shell. Applies auth middleware (all child
 * routes are protected) and renders Header + TabNav + content area +
 * Footer. The Site Status pill (mounted in the Header) is the single
 * surface for sync-divergence and upgrade signals — the old SyncBanner
 * and UpgradeBanner ribbons were retired.
 *
 * On every authenticated page load, the loader reads GitHub-derived
 * status from D1 cache columns (`gh_repo_available`, `gh_remote_head_sha`,
 * `gh_diverged`, `gh_diverged_against_sha`, `gh_checked_at`) — it does
 * NOT call GitHub on the navigation request path. Those columns are
 * refreshed out-of-band by the Site Status pill polling
 * `/api/site-status?payload=gh-status` (see `github-status.server.ts`).
 *
 * One exception: the convenor upgrade gate may fetch the global latest
 * Telar tag synchronously when the in-isolate cache is cold AND the
 * current path is gated (`/publish`, `/objects`). On a cold cache +
 * non-gated route the fetch is skipped and `needsUpgrade` stays `false`
 * (provisional) until the pill's poll warms the cache. The gate is
 * fail-closed: a below-minimum convenor on a gated route cannot slip
 * through on a cold isolate.
 *
 * @version v1.3.7-beta
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { redirect, Outlet, useFetcher, useLocation, useNavigation, useSearchParams } from "react-router";
import { eq, and, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Route } from "./+types/_app";
import { authMiddleware, userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, project_config, project_members, project_invites, users, stories, objects, project_pages, glossary_terms } from "~/db/schema";
import { getUserRole, getPresenceColor, getUserProjects } from "~/lib/membership.server";
import { createSessionStorage } from "~/lib/session.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { decrypt } from "~/lib/crypto.server";
import { deriveHeadDiverged, getCachedLatestTagIfWarm, getCachedLatestTag, deriveWorkflowsApproval, type WorkflowsApproval } from "~/lib/github-status.server";
import { compareTelarVersion } from "~/lib/upgrade.server";
import { shouldShowReleaseNote, shouldShowWorkflowsModal } from "~/lib/release-notes";
import { Header } from "~/components/layout/Header";
import { CollaborationProvider, useCollaborationContext, useSetAwarenessLocation } from "~/hooks/use-collaboration";
import { ToastProvider } from "~/hooks/use-toast";
import { PublishFreezeModal } from "~/components/ui/PublishFreezeModal";
import { UpgradeFreezeModal } from "~/components/ui/UpgradeFreezeModal";
import { CollaborationSidebar } from "~/components/features/collaboration/CollaborationSidebar";
import { UndoFeedback } from "~/components/features/collaboration/UndoFeedback";
import { BugReportPanel } from "~/components/features/bug-report/BugReportPanel";
import { WhatsNewModal } from "~/components/features/release/WhatsNewModal";
import { WorkflowsPermissionModal } from "~/components/features/upgrade/WorkflowsPermissionModal";
import { TabNav } from "~/components/layout/TabNav";
import { DocsDrawer } from "~/components/features/start/DocsDrawer";
import { isDocId, type DocId } from "~/lib/docs-content";
import { Footer } from "~/components/layout/Footer";
import { ReloadOnUpgradeComplete } from "~/components/layout/ReloadOnUpgradeComplete";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Bug, Loader2, Users } from "lucide-react";

export const middleware = [authMiddleware];
export const handle = { i18n: ["common", "upgrade", "collaboration", "bug-report", "account", "release-notes"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) {
    // Should not happen — authMiddleware redirects if no user
    throw new Response("Unauthorized", { status: 401 });
  }

  const env = context.cloudflare.env as Env;
  let headDiverged = false;
  let activeProjectId: number | null = null;
  let needsUpgrade = false;
  let latestTelarTag: string | null = null;
  let isBelowMinimum = false;
  let userRole: "convenor" | "collaborator" | null = null;
  let presenceColor: string | null = null;
  let pagesUrl: string | null = null;
  let repoUnavailable = false;
  let repoFullName: string | null = null;
  let workflowsApproval: WorkflowsApproval = { needed: false, url: null };
  // Full project set for the header project switcher.
  // Enriched with ownerLogin exactly as _app.dashboard.tsx does so the switcher
  // can show "owner/repo" for shared projects. Returned on BOTH loader paths.
  let allProjects: Array<{
    id: number;
    github_repo_full_name: string;
    userRole: "convenor" | "collaborator";
    ownerLogin?: string;
    collaboratorCount: number;
  }> = [];
  // Full-spectrum count of entities changed since the last publish — drives the
  // Site Status pill's `unpublished` caption number. It MIRRORS ChangeSummary's
  // spectrum (all five content types: stories + objects + glossary + pages +
  // settings), NOT the dashboard's stories-only counter. It is
  // computed CHEAPLY via per-table COUNT(updated_at > last_published_at) — it
  // deliberately does NOT run buildEntityHashes / computeChangeSummary (too
  // heavy for every navigation); the exact manifest is fetched lazily on popover
  // open. Caption (cheap count) and manifest (lazy ChangeSummary) therefore
  // agree on the same spectrum without the per-navigation cost.
  let unpublishedCount = 0;
  let sidebarMembers: Array<{
    userId: number;
    githubId: number;
    username: string;
    role: "convenor" | "collaborator";
    contributions: { fields_edited: number; sessions: number; stories_edited: string[]; objects_edited: string[]; last_active: string | null } | null;
  }> = [];
  let sidebarSeats = { used: 0, limit: 5 };
  let sidebarPendingInvites: Array<{ id: number; createdBy: number }> = [];
  // "You've been added to a project" one-time welcome: true when the active
  // project's membership for THIS user is a collaborator with welcomed_at null.
  let needsWelcome = false;
  let welcomeProject = "";
  let welcomeConvenor = "";

  try {
    const db = getDb(env.DB);

    // Collaborator route-guard (defence-in-depth UX). This is a SEPARATE check
    // from GATED_PATHS below, and it runs FIRST so
    // a collaborator who direct-navs to a convenor-only destination is bounced
    // to /objects with a ?denied= reason the toast can read. It does NOT replace
    // the server-side action gates on /publish and /upgrade — those stay intact.
    {
      const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
      if (resolved) {
        const guardRole = await getUserRole(db, resolved.project.id, user.id);
        const guardUrl = new URL(request.url);
        if (
          guardRole === "collaborator" &&
          (guardUrl.pathname.startsWith("/publish") ||
            guardUrl.pathname.startsWith("/upgrade"))
        ) {
          const denied = guardUrl.pathname.startsWith("/upgrade") ? "upgrade" : "publish";
          throw redirect(`/objects?denied=${denied}`);
        }
      }
    }

    // Fetch the user's full project set ONCE. Reused below for the
    // no-session fallback and enriched with ownerLogin for the header switcher.
    const userProjects = await getUserProjects(db, user.id);
    if (userProjects.length > 0) {
      const ownerIds = [...new Set(userProjects.map((p) => p.user_id))];
      const ownerRows = await db
        .select({ id: users.id, github_login: users.github_login })
        .from(users)
        .where(inArray(users.id, ownerIds));
      const ownerLoginMap: Record<number, string> = {};
      for (const row of ownerRows) {
        ownerLoginMap[row.id] = row.github_login;
      }
      allProjects = userProjects.map((p) => ({
        id: p.id,
        github_repo_full_name: p.github_repo_full_name,
        userRole: p.userRole,
        ownerLogin: ownerLoginMap[p.user_id] ?? undefined,
        collaboratorCount: 0,
      }));

      // Attach a per-project collaboratorCount (members minus the owner) using
      // ONE grouped COUNT query over the user's project IDs — cheap and indexed.
      const projectIds = allProjects.map((p) => p.id);
      const memberCountRows = await db
        .select({ project_id: project_members.project_id, n: sql<number>`count(*)` })
        .from(project_members)
        .where(inArray(project_members.project_id, projectIds))
        .groupBy(project_members.project_id);
      const countByProject = new Map(memberCountRows.map((r) => [r.project_id, Number(r.n)]));
      allProjects = allProjects.map((p) => ({
        ...p,
        collaboratorCount: Math.max(0, (countByProject.get(p.id) ?? 1) - 1),
      }));
    }

    // Get the active project from session (same pattern as _app.objects.tsx)
    const sessionStorage = createSessionStorage(env.SESSION_SECRET);
    const session = await sessionStorage.getSession(request.headers.get("Cookie"));
    const sessionActiveId = session.get("activeProjectId") as number | undefined;

    if (sessionActiveId) {
      activeProjectId = Number(sessionActiveId);

      // Check the user's membership in this project
      const role = await getUserRole(db, activeProjectId, user.id);
      if (role === null) {
        // Session references a project the user no longer has access to — clear it
        activeProjectId = null;
      } else {
        userRole = role;
        // Fetch or lazily assign presence colour
        presenceColor = await getPresenceColor(db, activeProjectId!, user.id);
      }
    }

    // Fall back to the user's first accessible project if session has none.
    // Reuses the already-fetched userProjects (no second query).
    if (activeProjectId === null) {
      if (userProjects.length > 0) {
        activeProjectId = userProjects[0].id;
        userRole = userProjects[0].userRole;
        presenceColor = await getPresenceColor(db, activeProjectId, user.id);
      }
    }

    // Fetch members for the collaboration sidebar (lightweight — userId, role, contributions)
    if (activeProjectId !== null) {
      const memberRows = await db
        .select({
          userId: project_members.user_id,
          role: project_members.role,
          githubId: users.github_id,
          username: users.github_login,
          name: users.github_name,
          welcomedAt: project_members.welcomed_at,
          contributions: project_members.contributions,
        })
        .from(project_members)
        .innerJoin(users, eq(project_members.user_id, users.id))
        .where(eq(project_members.project_id, activeProjectId));

      sidebarMembers = memberRows.map((m) => ({
        userId: m.userId,
        githubId: m.githubId,
        username: m.username,
        role: m.role as "convenor" | "collaborator",
        contributions: m.contributions ? JSON.parse(m.contributions) : null,
      }));
      sidebarSeats = { used: memberRows.length, limit: 5 };

      // Pending invitations (unused invite rows) so the sidebar can offer
      // convenors the cancel affordance beside where invites are sent.
      const inviteRows = await db
        .select({ id: project_invites.id, createdBy: project_invites.created_by })
        .from(project_invites)
        .where(and(eq(project_invites.project_id, activeProjectId), isNull(project_invites.used_by)));
      sidebarPendingInvites = inviteRows;

      // One-time "you've been added" welcome: a collaborator whose membership
      // hasn't been acknowledged yet (welcomed_at null). Convenor name + repo
      // name feed the landing modal; ack stamps welcomed_at via /api/welcome-ack.
      const myRow = memberRows.find((m) => m.userId === user.id);
      if (userRole === "collaborator" && myRow && !myRow.welcomedAt) {
        const convenorRow = memberRows.find((m) => m.role === "convenor");
        needsWelcome = true;
        welcomeConvenor = convenorRow?.name || convenorRow?.username || "";
        welcomeProject =
          allProjects.find((p) => p.id === activeProjectId)?.github_repo_full_name ?? "";
      }

      // Cheap full-spectrum unpublished count. Counts entities
      // across ALL five content types whose updated_at is newer than the
      // project's last_published_at — the same spectrum computeChangeSummary
      // covers, without the cost of buildEntityHashes. Before the first publish
      // (last_published_at == null) there is no baseline, so the count is 0
      // (nothing has been "un-published" yet — same posture as the dashboard).
      const pubRows = await db
        .select({ last_published_at: projects.last_published_at })
        .from(projects)
        .where(eq(projects.id, activeProjectId))
        .limit(1);
      const lastPublishedAt = pubRows[0]?.last_published_at ?? null;

      if (lastPublishedAt) {
        const pid = activeProjectId;
        const n = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
        // One COUNT(*) per content type — cheap, mirrors the ChangeSummary
        // spectrum. Site settings: the project_config row counts as one changed
        // entity if touched since the last publish (mirrors ChangeSummary's
        // "Site settings" section being non-empty).
        const [storyRows, objectRows, pageRows, glossaryRows, settingsRows] = await Promise.all([
          db.select({ n: sql<number>`count(*)` }).from(stories)
            .where(and(eq(stories.project_id, pid), gt(stories.updated_at, lastPublishedAt))),
          db.select({ n: sql<number>`count(*)` }).from(objects)
            .where(and(eq(objects.project_id, pid), gt(objects.updated_at, lastPublishedAt))),
          db.select({ n: sql<number>`count(*)` }).from(project_pages)
            .where(and(eq(project_pages.project_id, pid), gt(project_pages.updated_at, lastPublishedAt))),
          db.select({ n: sql<number>`count(*)` }).from(glossary_terms)
            .where(and(eq(glossary_terms.project_id, pid), gt(glossary_terms.updated_at, lastPublishedAt))),
          db.select({ n: sql<number>`count(*)` }).from(project_config)
            .where(and(eq(project_config.project_id, pid), gt(project_config.updated_at, lastPublishedAt))),
        ]);

        unpublishedCount =
          n(storyRows) + n(objectRows) + n(pageRows) + n(glossaryRows) + n(settingsRows);
      }
    }

    if (activeProjectId === null) {
      // No projects at all — skip project-specific checks
      return {
        user: {
          github_id: user.github_id,
          github_login: user.github_login,
          github_name: user.github_name,
          github_email: user.github_email,
        },
        headDiverged: false,
        activeProjectId: null,
        needsUpgrade: false,
        latestTelarTag: null,
        isBelowMinimum: false,
        userRole: null,
        presenceColor: null,
        pagesUrl: null,
        unpublishedCount: 0,
        allProjects,
        environment: env.ENVIRONMENT,
        needsWelcome: false,
        needsReleaseNote: false,
        welcomeProject: "",
        welcomeConvenor: "",
        repoUnavailable: false,
        repoFullName: null,
        needsWorkflowsApproval: false,
        workflowsApprovalUrl: null,
        activeProjectShared: false,
      };
    }

    // Fetch the project's head_sha and repo name
    {
      const projectRows = await db
        .select({
          id: projects.id,
          head_sha: projects.head_sha,
          github_repo_full_name: projects.github_repo_full_name,
          github_pages_url: projects.github_pages_url,
          gh_repo_available: projects.gh_repo_available,
          gh_remote_head_sha: projects.gh_remote_head_sha,
          gh_diverged: projects.gh_diverged,
          gh_diverged_against_sha: projects.gh_diverged_against_sha,
          gh_checked_at: projects.gh_checked_at,
          installation_id: projects.installation_id,
          gh_workflows_write_missing: projects.gh_workflows_write_missing,
          gh_install_target_type: projects.gh_install_target_type,
        })
        .from(projects)
        .where(eq(projects.id, activeProjectId));

      const project = projectRows[0];
      pagesUrl = project?.github_pages_url ?? null;

      if (project && project.github_repo_full_name) {
        repoFullName = project.github_repo_full_name;
        // pagesUrl derive + lazy heal — pure D1, stays synchronous (feeds TabNav).
        const configRows = await db.select({
          telar_version: project_config.telar_version,
          url: project_config.url,
          baseurl: project_config.baseurl,
        }).from(project_config).where(eq(project_config.project_id, activeProjectId));
        const siteVersion = configRows[0]?.telar_version ?? null;
        const configUrl = configRows[0]?.url ?? null;
        const configBaseurl = configRows[0]?.baseurl ?? "";
        if (configUrl) {
          const derived = `${configUrl.replace(/\/+$/, "")}${configBaseurl}`.replace(/\/+$/, "");
          pagesUrl = derived;
          if (project.github_pages_url !== derived) {
            await db.update(projects).set({ github_pages_url: derived, updated_at: new Date().toISOString() })
              .where(eq(projects.id, project.id));
          }
        }

        // GitHub-derived status: read from the D1 cache — never call GitHub on the request path.
        repoUnavailable = project.gh_repo_available === 0;
        headDiverged = deriveHeadDiverged(project, project.head_sha);

        // Workflows-permission approval prompt — pure read off the cache the
        // gh-status poll fills. Convenor-only; cold cache → no prompt.
        workflowsApproval = deriveWorkflowsApproval({
          workflowsWriteMissing: project.gh_workflows_write_missing,
          targetType: project.gh_install_target_type,
          installationId: project.installation_id,
          repoFullName: project.github_repo_full_name,
          role: userRole,
        });

        // Upgrade: derive from the global tag cache vs telar_version.
        // Warm cache → no fetch. Cold cache → fetch ONLY on gated routes (fail-closed).
        const url = new URL(request.url);
        const GATED_PATHS = ["/publish", "/objects"];
        const onGated = GATED_PATHS.some((p) => url.pathname.startsWith(p));
        let tag = getCachedLatestTagIfWarm(Date.now());
        if (tag === undefined && onGated) {
          const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
          tag = await getCachedLatestTag(token, Date.now()); // one allowed fetch: gated route, cold cache
        }
        // cold cache + non-gated route: skip — leave needsUpgrade=false provisional until the pill poll warms the cache
        if (tag !== undefined) {
          const cmp = compareTelarVersion(siteVersion, tag ?? null);
          needsUpgrade = cmp.needsUpgrade;
          isBelowMinimum = cmp.isBelowMinimum;
          latestTelarTag = tag ?? null;
        }

        if (needsUpgrade && userRole === "convenor" && onGated) {
          throw redirect(`/upgrade?from=${encodeURIComponent(url.pathname)}`);
        }
      }
    }
  } catch (err) {
    // Re-throw redirects (they are Responses, not Errors)
    if (err instanceof Response) throw err;
    // Fail open — don't block the user on GitHub API errors
    headDiverged = false;
  }

  // Once-per-release "What's new" modal. Welcome modal wins this load (a
  // newly-added collaborator sees the welcome first; the release note shows
  // next login). user.last_seen_release comes from the authenticated user row.
  const needsReleaseNote = shouldShowReleaseNote(user.last_seen_release, needsWelcome);

  return {
    user: {
      github_id: user.github_id,
      github_login: user.github_login,
      github_name: user.github_name,
      github_email: user.github_email,
    },
    headDiverged,
    activeProjectId,
    needsUpgrade,
    latestTelarTag,
    isBelowMinimum,
    userRole,
    presenceColor,
    pagesUrl,
    unpublishedCount,
    allProjects,
    environment: env.ENVIRONMENT,
    sidebarMembers,
    sidebarPendingInvites,
    sidebarSeats,
    needsWelcome,
    needsReleaseNote,
    welcomeProject,
    welcomeConvenor,
    repoUnavailable,
    repoFullName,
    needsWorkflowsApproval: workflowsApproval.needed,
    workflowsApprovalUrl: workflowsApproval.url,
    activeProjectShared: sidebarSeats.used > 1,
  };
}

/**
 * CollaborationOverlay — renders the PublishFreezeModal inside CollaborationProvider.
 * Must be a child of CollaborationProvider so it can call useCollaborationContext.
 * The dismiss handler clears publishError via the awareness field on the local client.
 */
function CollaborationOverlay({ userRole }: { userRole: "convenor" | "collaborator" | null }) {
  const { isPublishing, publishError, isUpgrading, upgradeError, provider } = useCollaborationContext();
  const isOwner = userRole === "convenor";

  function handlePublishDismiss() {
    // Clear the publishError awareness field on this client
    provider?.awareness.setLocalStateField("publishError", false);
  }

  function handleUpgradeDismiss() {
    // Clear the upgradeError awareness field on this client
    provider?.awareness.setLocalStateField("upgradeError", false);
  }

  return (
    <>
      <PublishFreezeModal
        isPublishing={isPublishing}
        publishError={publishError}
        isOwner={isOwner}
        onDismiss={handlePublishDismiss}
      />
      <UpgradeFreezeModal
        isUpgrading={isUpgrading}
        upgradeError={upgradeError}
        isOwner={isOwner}
        onDismiss={handleUpgradeDismiss}
      />
      <ReloadOnUpgradeComplete isOwner={isOwner} />
    </>
  );
}

/**
 * NavigationOverlay — shows a centered "Checking for updates…" modal when a
 * slow navigation is in flight (threshold 1000 ms so snappy transitions don't
 * flash).
 *
 * The loader for /upgrade fans out several GitHub API calls and can take a
 * few seconds; without feedback users perceive the dashboard banner as
 * broken. Copy is route-specific for /upgrade and falls back to a generic
 * label for other slow routes.
 */
function NavigationOverlay() {
  const navigation = useNavigation();
  const { t } = useTranslation("upgrade");
  const { t: tCommon } = useTranslation("common");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (navigation.state === "idle") {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 1000);
    return () => clearTimeout(timer);
  }, [navigation.state, navigation.location?.pathname]);

  if (!visible) return null;

  const target = navigation.location?.pathname ?? "";
  const isUpgrade = target === "/upgrade" || target.startsWith("/upgrade");
  const label = isUpgrade ? t("checkingForUpdates") : tCommon("loading");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50 pointer-events-none">
      <div className="bg-cream px-5 py-4 rounded-xl shadow-lg flex items-center gap-3">
        <Loader2 className="w-5 h-5 text-terracotta animate-spin shrink-0" aria-hidden="true" />
        <p className="font-body text-sm text-charcoal">{label}</p>
      </div>
    </div>
  );
}

function LocationAwarenessSync() {
  const setAwarenessLocation = useSetAwarenessLocation();
  const location = useLocation();

  useEffect(() => {
    setAwarenessLocation({
      route: location.pathname,
      storyId: null,
      fieldKey: null,
    });
  }, [location.pathname]);

  return null;
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user, activeProjectId, userRole, presenceColor, pagesUrl, environment, sidebarMembers, sidebarPendingInvites, sidebarSeats, needsWelcome, needsReleaseNote, welcomeProject, welcomeConvenor, needsWorkflowsApproval, workflowsApprovalUrl } = loaderData;
  const { t: tCollab } = useTranslation("collaboration");
  const location = useLocation();
  // Story editor route (`/stories/:id`, not the `/stories` list). There the tab
  // nav is dead weight mid-edit, so it's hidden on a landscape phone to reclaim
  // vertical space — the editor breadcrumb's "Start" link remains the way out.
  const isStoryEditor = /^\/stories\/[^/]+/.test(location.pathname);
  const welcomeFetcher = useFetcher();
  const releaseFetcher = useFetcher();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [betaAck, setBetaAck] = useState(false);
  const [betaPromptOpen, setBetaPromptOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(needsWelcome);
  const [releaseNoteOpen, setReleaseNoteOpen] = useState(needsReleaseNote);
  const [workflowsModalOpen, setWorkflowsModalOpen] = useState(
    shouldShowWorkflowsModal(needsWorkflowsApproval, needsWelcome, needsReleaseNote),
  );
  const usersIconRef = useRef<HTMLButtonElement | null>(null);

  // Workflows-permission prompt — show once per session (don't nag on every
  // navigation). Dismissal remembered in sessionStorage; it reappears next
  // login until the gh-status poll sees the grant and clears needsWorkflowsApproval.
  useEffect(() => {
    if (typeof window !== "undefined" && sessionStorage.getItem("workflows_perm_ack") === "1") {
      setWorkflowsModalOpen(false);
    }
  }, []);
  const dismissWorkflowsModal = useCallback(() => {
    setWorkflowsModalOpen(false);
    if (typeof window !== "undefined") sessionStorage.setItem("workflows_perm_ack", "1");
  }, []);

  // Docs drawer — shell-level so any tab can open docs in place.
  // openDoc is exposed via Outlet context and passed to TabNav; the ?doc=
  // query param is consumed here (stripped after opening so refresh won't reopen).
  const [openDocId, setOpenDocId] = useState<DocId | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const openDoc = useCallback((id: string) => {
    if (isDocId(id)) setOpenDocId(id);
  }, []);
  useEffect(() => {
    const param = searchParams.get("doc");
    if (param && isDocId(param)) {
      setOpenDocId(param);
      const next = new URLSearchParams(searchParams);
      next.delete("doc");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Open beta: a one-time-per-session notice that collaboration is still in
  // testing (replaces the old closed-beta password gate). Remembered in
  // sessionStorage so it shows once, not on every sidebar open.
  useEffect(() => {
    if (typeof window !== "undefined" && sessionStorage.getItem("collab_beta_ack") === "1") {
      setBetaAck(true);
    }
  }, []);

  function handleSidebarToggle() {
    // First open of the session shows the beta notice; acknowledging it opens
    // the sidebar. Thereafter the toggle is direct.
    if (!betaAck) {
      setBetaPromptOpen(true);
      return;
    }
    setSidebarOpen((v) => !v);
  }

  function acknowledgeBeta() {
    if (typeof window !== "undefined") sessionStorage.setItem("collab_beta_ack", "1");
    setBetaAck(true);
    setBetaPromptOpen(false);
    setSidebarOpen(true);
  }

  return (
    <CollaborationProvider
      projectId={activeProjectId}
      userGithubId={user.github_id}
      userName={user.github_name || user.github_login}
      presenceColor={presenceColor ?? null}
    >
      <ToastProvider>
        <NavigationOverlay />
        <LocationAwarenessSync />
        <UndoFeedback />
        <div className="min-h-screen flex flex-col bg-cream">
          <Header
            user={user}
            environment={environment}
            presenceColor={presenceColor ?? null}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={handleSidebarToggle}
            usersIconRef={usersIconRef}
            hasProject={activeProjectId !== null}
          />
          <TabNav
            pagesUrl={pagesUrl ?? null}
            onOpenDoc={openDoc}
            className={isStoryEditor ? "landscape-compact:hidden" : ""}
          />
          <main className="flex-1 p-6">
            <Outlet context={{ openCollaborationSidebar: handleSidebarToggle, openDoc }} />
          </main>
          <Footer />
        </div>
        <CollaborationSidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          isConvenor={userRole === "convenor"}
          members={sidebarMembers ?? []}
          pendingInvites={sidebarPendingInvites ?? []}
          seats={sidebarSeats ?? { used: 0, limit: 5 }}
          triggerRef={usersIconRef}
        />
        <DocsDrawer
          open={openDocId !== null}
          docId={openDocId}
          onClose={() => setOpenDocId(null)}
          onOpenDoc={openDoc}
        />
        <CollaborationOverlay userRole={userRole} />
        {/* Open-beta collaboration notice — shown once per session before the
            sidebar opens (replaces the closed-beta password gate). */}
        {betaPromptOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50"
            onClick={() => setBetaPromptOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="collab-beta-title"
              onClick={(e) => e.stopPropagation()}
              className="bg-cream rounded-xl p-6 shadow-lg w-[360px] max-w-[90vw] flex flex-col gap-3"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-pill bg-caracol-pale text-caracol">
                <Users className="h-5 w-5" aria-hidden="true" />
              </div>
              <span className="inline-flex w-fit items-center gap-1.5 rounded-pill bg-qolle-pale px-2.5 py-1 font-heading text-[10px] font-bold uppercase tracking-wider text-qolle-deep">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {tCollab("beta_tag")}
              </span>
              <h2 id="collab-beta-title" className="font-heading text-lg font-semibold text-charcoal">
                {userRole === "convenor" ? tCollab("beta_title") : tCollab("beta_title_collaborator")}
              </h2>
              <p className="font-body text-sm leading-relaxed text-charcoal/70">
                {tCollab("beta_body")}
              </p>
              <div className="mt-1 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setBetaPromptOpen(false);
                    setBugReportOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-heading text-sm font-semibold text-anil-ink hover:bg-anil-pale transition-colors"
                >
                  <Bug className="h-3.5 w-3.5" aria-hidden="true" />
                  {tCollab("beta_report")}
                </button>
                <button
                  type="button"
                  onClick={acknowledgeBeta}
                  className="rounded-lg bg-terracotta px-4 py-1.5 font-heading text-sm font-semibold text-cream hover:bg-terracotta-deep transition-colors"
                >
                  {tCollab("beta_ack")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* "You've been added to a project" — one-time landing welcome for a
            newly-added collaborator. "Got it" stamps welcomed_at server-side
            (via /api/welcome-ack) so it shows only once. */}
        {welcomeOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50"
            onClick={() => setWelcomeOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="collab-welcome-title"
              onClick={(e) => e.stopPropagation()}
              className="bg-cream rounded-xl p-6 shadow-lg w-[360px] max-w-[90vw] flex flex-col gap-3"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-pill bg-caracol-pale text-caracol">
                <Users className="h-5 w-5" aria-hidden="true" />
              </div>
              <h2 id="collab-welcome-title" className="font-heading text-lg font-semibold text-charcoal">
                {tCollab("welcome_added_title", { project: welcomeProject })}
              </h2>
              <p className="font-body text-sm leading-relaxed text-charcoal/70">
                {tCollab("welcome_added_body", { convenor: welcomeConvenor })}
              </p>
              <div className="mt-1 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setWelcomeOpen(false);
                    setBugReportOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-heading text-sm font-semibold text-anil-ink hover:bg-anil-pale transition-colors"
                >
                  <Bug className="h-3.5 w-3.5" aria-hidden="true" />
                  {tCollab("beta_report")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    welcomeFetcher.submit({}, { method: "post", action: "/api/welcome-ack" });
                    setWelcomeOpen(false);
                  }}
                  className="rounded-lg bg-terracotta px-4 py-1.5 font-heading text-sm font-semibold text-cream hover:bg-terracotta-deep transition-colors"
                >
                  {tCollab("beta_ack")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Once-per-release "What's new" announcement. Dismiss stamps
            last_seen_release via /api/release-ack so it shows only once. */}
        <WhatsNewModal
          open={releaseNoteOpen}
          onDismiss={() => {
            releaseFetcher.submit({}, { method: "post", action: "/api/release-ack" });
            setReleaseNoteOpen(false);
          }}
        />

        {/* Convenor whose install hasn't accepted workflows:write — prompt to
            approve before they hit a failed upgrade. Dismissible per session. */}
        {workflowsApprovalUrl && (
          <WorkflowsPermissionModal
            open={workflowsModalOpen}
            onDismiss={dismissWorkflowsModal}
            approvalUrl={workflowsApprovalUrl}
          />
        )}

        {/* Bug-report panel openable from the beta notice. The header mounts
            its own instance; only one is ever open at a time. */}
        <BugReportPanel
          open={bugReportOpen}
          onClose={() => setBugReportOpen(false)}
          mode="default"
          userLogin={user.github_login}
        />
      </ToastProvider>
    </CollaborationProvider>
  );
}

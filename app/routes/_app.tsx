/**
 * Authenticated application layout.
 *
 * Applies auth middleware — all child routes are protected.
 * Renders: Header + TabNav + UpgradeBanner (when outdated) + SyncBanner (when HEAD diverged) + content area + Footer.
 *
 * On every authenticated page load, the loader:
 *   1. Checks whether the active project's stored head_sha matches the repo's
 *      current HEAD. If not, sets headDiverged: true so the SyncBanner can warn.
 *   2. Checks the site's telar_version against the latest release. If outdated,
 *      sets needsUpgrade: true and redirects gated routes (/publish, /objects)
 *      to /upgrade.
 *
 * Both checks fail open — if the GitHub API call fails, the user is not blocked.
 */

import { useEffect, useRef, useState } from "react";
import { redirect, Outlet, Link, useLocation, useNavigation } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/_app";
import { authMiddleware, userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, project_config, project_members, users } from "~/db/schema";
import { getUserRole, getPresenceColor } from "~/lib/membership.server";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { getRepoHead } from "~/lib/github.server";
import { computeFullSyncDiff } from "~/lib/sync.server";
import { checkTelarVersion } from "~/lib/upgrade.server";
import { Header } from "~/components/layout/Header";
import { CollaborationProvider, useCollaborationContext, useSetAwarenessLocation } from "~/hooks/use-collaboration";
import { ToastProvider } from "~/hooks/use-toast";
import { PublishFreezeModal } from "~/components/ui/PublishFreezeModal";
import { UpgradeFreezeModal } from "~/components/ui/UpgradeFreezeModal";
import { CollaborationSidebar } from "~/components/features/collaboration/CollaborationSidebar";
import { TabNav } from "~/components/layout/TabNav";
import { Footer } from "~/components/layout/Footer";
import { SyncBanner } from "~/components/layout/SyncBanner";
import { ReloadOnUpgradeComplete } from "~/components/layout/ReloadOnUpgradeComplete";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle, Loader2 } from "lucide-react";

export const middleware = [authMiddleware];
export const handle = { i18n: ["common", "upgrade", "collaboration"] };

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
  let sidebarMembers: Array<{
    userId: number;
    githubId: number;
    username: string;
    role: "convenor" | "collaborator";
    contributions: { fields_edited: number; sessions: number; stories_edited: string[]; objects_edited: string[]; last_active: string | null } | null;
  }> = [];
  let sidebarSeats = { used: 0, limit: 5 };

  try {
    const db = getDb(env.DB);

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

    // Fall back to the user's first accessible project if session has none
    if (activeProjectId === null) {
      const { getUserProjects } = await import("~/lib/membership.server");
      const allProjects = await getUserProjects(db, user.id);
      if (allProjects.length > 0) {
        activeProjectId = allProjects[0].id;
        userRole = allProjects[0].userRole;
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
        environment: env.ENVIRONMENT,
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
        })
        .from(projects)
        .where(eq(projects.id, activeProjectId));

      const project = projectRows[0];
      pagesUrl = project?.github_pages_url ?? null;

      if (project && project.github_repo_full_name) {
        // Decrypt the user's access token
        const token = await decrypt(
          user.encrypted_access_token,
          env.ENCRYPTION_KEY,
        );

        const [owner, repo] = project.github_repo_full_name.split("/");

        // Fetch current repo HEAD. Used by the sync-diff check below, and
        // also backfilled to projects.head_sha when missing (older imports
        // didn't write it).
        const repoHead = await getRepoHead(token, owner, repo);

        if (!project.head_sha && repoHead !== null) {
          // Backfill on first load — silently. Treat current HEAD as the
          // baseline; no diff banner.
          await db
            .update(projects)
            .set({ head_sha: repoHead, updated_at: new Date().toISOString() })
            .where(eq(projects.id, project.id));
        }

        const shasDiffer = project.head_sha !== null && repoHead !== null && repoHead !== project.head_sha;

        if (shasDiffer) {
          // SHAs differ — check whether compositor-relevant content actually changed.
          // If not, silently update head_sha and skip the banner.
          try {
            const diff = await computeFullSyncDiff(
              project.id, token, owner, repo, db, null,
            );
            const hasRealChanges =
              (diff.objects?.new?.length ?? 0) > 0 ||
              (diff.objects?.changed?.length ?? 0) > 0 ||
              (diff.objects?.removed?.length ?? 0) > 0 ||
              (diff.stories?.new?.length ?? 0) > 0 ||
              (diff.stories?.changed?.length ?? 0) > 0 ||
              (diff.stories?.removed?.length ?? 0) > 0 ||
              (diff.config?.changed?.length ?? 0) > 0;

            if (hasRealChanges) {
              headDiverged = true;
            } else {
              // No meaningful changes — update head_sha silently
              await db
                .update(projects)
                .set({ head_sha: repoHead, updated_at: new Date().toISOString() })
                .where(eq(projects.id, project.id));
            }
          } catch {
            // If diff fails, show the banner to be safe
            headDiverged = true;
          }
        }

        // Version check — gated routes redirect to /upgrade if outdated.
        // Also derives pagesUrl from project_config.url+baseurl and lazy-heals
        // projects.github_pages_url (schema column was historically left unset).
        try {
          const configRows = await db
            .select({
              telar_version: project_config.telar_version,
              url: project_config.url,
              baseurl: project_config.baseurl,
            })
            .from(project_config)
            .where(eq(project_config.project_id, activeProjectId));
          const siteVersion = configRows[0]?.telar_version ?? null;

          const configUrl = configRows[0]?.url ?? null;
          const configBaseurl = configRows[0]?.baseurl ?? "";
          if (configUrl) {
            const derived = `${configUrl.replace(/\/+$/, "")}${configBaseurl}`.replace(/\/+$/, "");
            pagesUrl = derived;
            if (project.github_pages_url !== derived) {
              await db
                .update(projects)
                .set({ github_pages_url: derived, updated_at: new Date().toISOString() })
                .where(eq(projects.id, project.id));
            }
          }

          if (siteVersion) {
            const versionCheck = await checkTelarVersion(token, siteVersion);
            needsUpgrade = versionCheck.needsUpgrade;
            latestTelarTag = versionCheck.latestTag;
            isBelowMinimum = versionCheck.isBelowMinimum;
          }
        } catch {
          // Fail open — don't block the user
          needsUpgrade = false;
        }

        // Redirect gated routes to /upgrade
        const url = new URL(request.url);
        // /onboarding is intentionally not gated: it is a top-level route, not under _app,
        // so this loader never runs for it. Onboarding must complete before upgrade is meaningful.
        const GATED_PATHS = ["/publish", "/objects"];
        if (needsUpgrade && userRole === "convenor" && GATED_PATHS.some((p) => url.pathname.startsWith(p))) {
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
    environment: env.ENVIRONMENT,
    collabGated: Boolean(env.COLLAB_GATE),
    sidebarMembers,
    sidebarSeats,
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

function UpgradeBanner() {
  const { t } = useTranslation("upgrade");
  const location = useLocation();
  const isOnUpgradePage = location.pathname === "/upgrade";

  if (isOnUpgradePage) return null;

  return (
    <div className="bg-terracotta/10 border-b border-terracotta/20 px-6 py-3 flex items-center gap-3">
      <ArrowUpCircle className="w-4 h-4 text-terracotta shrink-0" aria-hidden="true" />
      <p className="font-body text-sm text-terracotta flex-1">
        {t("subtitle")}
      </p>
      <Link
        to="/upgrade"
        className="font-heading font-semibold text-sm text-terracotta underline underline-offset-2 hover:opacity-80 shrink-0"
      >
        {t("goToUpgrade")}
      </Link>
    </div>
  );
}

/**
 * NavigationOverlay — shows a centered "Checking for updates…" modal when a
 * slow navigation is in flight (threshold 200 ms so snappy transitions don't
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
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, [navigation.state, navigation.location?.pathname]);

  if (!visible) return null;

  const target = navigation.location?.pathname ?? "";
  const isUpgrade = target === "/upgrade" || target.startsWith("/upgrade");
  const label = isUpgrade ? t("checkingForUpdates") : tCommon("loading");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50 backdrop-blur-sm pointer-events-none">
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
  const { user, headDiverged, needsUpgrade, activeProjectId, userRole, presenceColor, pagesUrl, environment, collabGated, sidebarMembers, sidebarSeats } = loaderData;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collabUnlocked, setCollabUnlocked] = useState(false);
  const [gatePromptOpen, setGatePromptOpen] = useState(false);
  const [gateError, setGateError] = useState(false);
  const usersIconRef = useRef<HTMLButtonElement | null>(null);
  const gateInputRef = useRef<HTMLInputElement | null>(null);

  // Check sessionStorage for prior unlock
  useEffect(() => {
    if (!collabGated) return;
    if (typeof window !== "undefined" && sessionStorage.getItem("collab_unlocked") === "1") {
      setCollabUnlocked(true);
    }
  }, [collabGated]);

  function handleSidebarToggle() {
    if (collabGated && !collabUnlocked) {
      setGatePromptOpen(true);
      setGateError(false);
      setTimeout(() => gateInputRef.current?.focus(), 50);
      return;
    }
    setSidebarOpen((v) => !v);
  }

  function handleGateSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = gateInputRef.current;
    if (input && input.value.trim().toLowerCase() === "potato") {
      sessionStorage.setItem("collab_unlocked", "1");
      setCollabUnlocked(true);
      setGatePromptOpen(false);
      setSidebarOpen(true);
    } else {
      setGateError(true);
    }
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
          <TabNav pagesUrl={pagesUrl ?? null} />
          {needsUpgrade && userRole === "convenor" && <UpgradeBanner />}
          {headDiverged && userRole === "convenor" && <SyncBanner />}
          <main className="flex-1 p-6">
            <Outlet />
          </main>
          <Footer />
        </div>
        <CollaborationSidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          isConvenor={userRole === "convenor"}
          members={sidebarMembers}
          seats={sidebarSeats}
          triggerRef={usersIconRef}
        />
        <CollaborationOverlay userRole={userRole} />
        {/* Collaboration gate prompt */}
        {gatePromptOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/60 backdrop-blur-sm"
            onClick={() => setGatePromptOpen(false)}
          >
            <form
              onSubmit={handleGateSubmit}
              onClick={(e) => e.stopPropagation()}
              className="bg-cream rounded-xl p-6 shadow-lg w-80 flex flex-col gap-4"
            >
              <h2 className="font-heading text-lg text-charcoal">Collaboration is in beta</h2>
              <p className="font-body text-sm text-charcoal/70">Enter the access password to enable team features.</p>
              <input
                ref={gateInputRef}
                type="password"
                autoComplete="off"
                className={`border rounded-lg px-3 py-2 font-body text-sm ${gateError ? "border-red-400" : "border-charcoal/20"}`}
                placeholder="Password"
              />
              {gateError && <p className="text-red-500 text-xs font-body">Incorrect password</p>}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setGatePromptOpen(false)} className="px-3 py-1.5 rounded-lg text-sm font-body text-charcoal/60 hover:bg-charcoal/5">Cancel</button>
                <button type="submit" className="px-4 py-1.5 rounded-lg text-sm font-heading font-semibold bg-charcoal text-white hover:bg-charcoal/90">Unlock</button>
              </div>
            </form>
          </div>
        )}
      </ToastProvider>
    </CollaborationProvider>
  );
}

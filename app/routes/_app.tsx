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
 * One exception: the upgrade-nag gate (any publishing role) may fetch
 * the global latest Telar tag synchronously when the in-isolate cache is
 * cold AND the current path is gated (`/publish`, `/objects`). On a cold
 * cache + non-gated route the fetch is skipped and `needsUpgrade` stays
 * `false` (provisional) until the pill's poll warms the cache. The gate is
 * fail-closed: a publishing role on a gated route cannot slip past a
 * behind-latest site on a cold isolate — except a collaborator whose
 * upgrade the installation's missing `workflows: write` permission would
 * refuse outright (`upgradeAwaitsConvenor`, `gh_workflows_write_missing`):
 * that collaborator keeps Objects (disabled upload/commit controls there
 * explain why) rather than looping on an upgrade only the convenor can
 * grant, and is sent from Publish back to Objects rather than to Upgrade,
 * since they have nothing to do on either. A release lookup that failed is
 * not a redirect: the loader reports `releaseUnknown` and Publish opens with
 * its button disabled (the publish action refuses on the same reading).
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { redirect, Outlet, useFetcher, useLocation, useNavigation, useSearchParams } from "react-router";
import { eq, and, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Route } from "./+types/_app";
import { authMiddleware, userContext } from "~/middleware/auth.server";
import { handoffRedirectMiddleware } from "~/middleware/handoff.server";
import { WelcomeModal } from "~/components/features/site-status/WelcomeModal";
import { readOwnRepoAccess } from "~/lib/own-repo-access.server";
import { SiteChangedWatcher } from "~/components/features/site-status/SiteChangedNotice";
import { PageSiteProvider } from "~/lib/page-site";
import { SiteStatusProvider } from "~/components/features/site-status/SiteStatusProvider";
import { getDb } from "~/lib/db.server";
import { projects, project_config, project_members, project_invites, users, stories, objects, project_pages, glossary_terms } from "~/db/schema";
import { getUserRole, getPresenceColor, getUserProjects, listableProjects, hasCourseStanding } from "~/lib/membership.server";
import { isPublishingRole } from "~/lib/publishing-roles";
import { isLegacyInviteToken } from "~/lib/join-codes.server";
import { createSessionStorage } from "~/lib/session.server";
import { isHandoffSite, resolveActiveProjectFromRequest, siteHint } from "~/lib/active-project.server";
import { decrypt } from "~/lib/crypto.server";
import { deriveHeadDiverged, readWarmLatestTag, readLatestTag, deriveWorkflowsApproval, type LatestTagRead, type WorkflowsApproval } from "~/lib/github-status.server";
import type { OwnRepoAccess } from "~/lib/repo-access";
import { compareTelarVersion } from "~/lib/telar-version";
import { deriveUpgradeAwaitsConvenor, standingFromLatest } from "~/lib/upgrade-gate.server";
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
import { mayUseCourses } from "~/lib/course-gate.server";
import { DocsDrawer } from "~/components/features/start/DocsDrawer";
import { isDocId, type DocId } from "~/lib/docs-content";
import { Footer } from "~/components/layout/Footer";
import { ReloadOnUpgradeComplete } from "~/components/layout/ReloadOnUpgradeComplete";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Bug, Loader2, Users } from "lucide-react";
import { readAnotherPage } from "~/lib/unreachable-write";
import { TabSiteGate } from "~/lib/use-reconcile-tab-site";
import type { ShouldRevalidateFunctionArgs } from "react-router";

export const middleware = [authMiddleware, handoffRedirectMiddleware];
export const handle = { i18n: ["common", "upgrade", "collaboration", "bug-report", "account", "release-notes"] };

/** The upgrade-nag gate: redirect a publishing role off a gated path when the
 *  framework is behind, unless their upgrade only the convenor can complete
 *  (see deriveUpgradeAwaitsConvenor in ~/lib/upgrade-gate.server). */
function shouldRedirectToUpgrade(
  needsUpgrade: boolean,
  userRole: string | null,
  onGated: boolean,
  upgradeAwaitsConvenor: boolean,
): boolean {
  return needsUpgrade && isPublishingRole(userRole) && onGated && !upgradeAwaitsConvenor;
}

/** A collaborator awaiting the convenor (see deriveUpgradeAwaitsConvenor)
 *  keeps Objects — disabled controls there explain why — but has nothing to
 *  do on Publish: send them back to Objects rather than looping them to
 *  /upgrade, an upgrade they cannot complete either. */
function shouldRedirectPublishToObjects(
  onPublish: boolean,
  upgradeAwaitsConvenor: boolean,
): boolean {
  return onPublish && upgradeAwaitsConvenor;
}

/**
 * The latest release as this load may read it: warm cache first, which holds
 * a recent failure as well as a success; on a cold cache, the one allowed
 * lookup, and only on a path that checks the version. undefined is a cold
 * cache on any other path, read as provisional.
 */
async function readLoaderRelease(
  onVersionChecked: boolean,
  encryptedToken: string,
  env: Env,
): Promise<LatestTagRead | undefined> {
  const warm = readWarmLatestTag(Date.now());
  if (warm || !onVersionChecked) return warm;
  const token = await decrypt(encryptedToken, env.ENCRYPTION_KEY);
  return readLatestTag(token, Date.now(), env.TELAR_RELEASE_TAG);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) {
    // Should not happen — authMiddleware redirects if no user
    throw new Response("Unauthorized", { status: 401 });
  }

  const env = context.cloudflare.env as Env;
  let headDiverged = false;
  let activeProjectId: number | null = null;
  // The site the hand-off cookie named, when the render used it.
  let handoffSite: number | undefined;
  let needsUpgrade = false;
  let latestTelarTag: string | null = null;
  let isBelowMinimum = false;
  let upgradeAwaitsConvenor = false;
  // The latest release could not be read for a site with a recorded version.
  // Publish opens with its button disabled rather than redirecting, and the
  // Objects writes refuse on the same reading in their actions.
  let releaseUnknown = false;
  let userRole: "convenor" | "collaborator" | "instructor" | null = null;
  let presenceColor: string | null = null;
  let pagesUrl: string | null = null;
  let repoUnavailable = false;
  let repoFullName: string | null = null;
  // The site's `telar_version` as D1 holds it, for bug reports.
  let siteTelarVersion: string | null = null;
  let workflowsApproval: WorkflowsApproval = { needed: false, url: null };
  // The header project switcher's list. Enriched with ownerLogin exactly as
  // _app.dashboard.tsx does so the switcher can show "owner/repo" for shared
  // projects. Returned on BOTH loader paths.
  //
  // Not the caller's full membership set: a child site the caller holds only
  // an instructor row on is left out (ruling 18). Nothing here decides
  // access — the active project is resolved from the full set below, so the
  // project on screen may well be one this list does not name.
  let allProjects: Array<{
    id: number;
    github_repo_full_name: string;
    userRole: "convenor" | "collaborator" | "instructor";
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
    role: "convenor" | "collaborator" | "instructor";
    contributions: { fields_edited: number; sessions: number; stories_edited: string[]; objects_edited: string[]; last_active: string | null } | null;
  }> = [];
  let sidebarSeats = { used: 0, limit: 5 };
  // True when the active project IS a course project (kind === "course") —
  // as opposed to an ordinary site, whether or not it's enrolled in one.
  // Drives MemberRow's kebab visibility for instructor rows (design §5:
  // course-management, including staff removal, belongs to the course
  // project's own member list, never a child's).
  let sidebarIsCourseProject = false;
  // Whether to offer the Course tab. The screen is reachable only from here,
  // so without it a course could be created and then never run.
  //
  // Two conditions, and the gate is one of them because `/course` answers a
  // locked session with a bare 403: a tab that led there would be a dead end,
  // and the password is answered on the create-site form, not on the wall it
  // would put up. The other is that there is a course to run — the active
  // project either IS one, or is a site enrolled in one, which is the same
  // pair of cases the screen itself resolves.
  let showCourseTab = false;
  let sidebarPendingInvites: Array<{ id: number; createdBy: number | null }> = [];
  // "You've been added to a project" one-time welcome: true when the active
  // project's membership for THIS user is a collaborator with welcomed_at null.
  let needsWelcome = false;
  let welcomeProject = "";
  let welcomeConvenor = "";
  let welcomeAccess: OwnRepoAccess | null = null;

  try {
    const db = getDb(env.DB);

    // Route-guard (defence-in-depth UX). This is a SEPARATE check from
    // GATED_PATHS below, and it runs FIRST so a caller who direct-navs to a
    // destination their role cannot use is bounced to /objects with a
    // ?denied= reason the toast can read. It does NOT replace the
    // server-side action gates on /publish and /upgrade — those stay intact.
    // A publishing role (isPublishingRole, shared with the server gate)
    // passes; a caller the role lookup answers nothing for is bounced.
    {
      const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
      if (resolved) {
        const guardRole = await getUserRole(db, resolved.project.id, user.id);
        const guardUrl = new URL(request.url);
        if (
          !isPublishingRole(guardRole) &&
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
      // Suppression is applied here and nowhere else in this loader: the
      // switcher is a list, and everything below still resolves the active
      // project from the full membership set (ruling 22).
      allProjects = listableProjects(userProjects).map((p) => ({
        id: p.id,
        github_repo_full_name: p.github_repo_full_name,
        userRole: p.userRole,
        ownerLogin: ownerLoginMap[p.user_id] ?? undefined,
        collaboratorCount: 0,
      }));

      // Attach a per-project collaboratorCount (members minus the owner,
      // minus any instructor rows — instructors are staff, not group size:
      // a teacher enrolled in five sites must not inflate all five badges)
      // using ONE grouped COUNT query over the user's project IDs — cheap
      // and indexed.
      const projectIds = allProjects.map((p) => p.id);
      const memberCountRows = await db
        .select({ project_id: project_members.project_id, n: sql<number>`count(*)` })
        .from(project_members)
        .where(
          and(
            inArray(project_members.project_id, projectIds),
            ne(project_members.role, "instructor"),
          ),
        )
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
    const hint = siteHint(request, session.get("activeProjectId"));
    handoffSite = hint.handoffSite;
    const sessionActiveId = hint.siteId as number | undefined;

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
        role: m.role as "convenor" | "collaborator" | "instructor",
        contributions: m.contributions ? JSON.parse(m.contributions) : null,
      }));
      // Seat figure: convenor + collaborators against the display-only
      // limit of five, instructor rows excluded (design §3 — "the seat
      // display keeps its current form ... with instructor rows excluded
      // from the count").
      sidebarSeats = {
        used: memberRows.filter((m) => m.role !== "instructor").length,
        limit: 5,
      };

      // Pending invitations (unused invite rows) so the sidebar can offer
      // convenors the cancel affordance beside where invites are sent.
      // Convenor-only: non-convenors never render the section, and the rows
      // must not ride down in their loader payload either — cancel is
      // convenor-gated server-side, so collaborators have no reason to see
      // pending-invite ids or their creators.
      if (userRole === "convenor") {
        // `used_at` is the consumed flag, not `used_by`: the latter is
        // ON DELETE SET NULL, so a redeemer's account deletion would put a
        // spent invite back in this panel with a live cancel button.
        const inviteRows = (
          await db
            .select({
              id: project_invites.id,
              createdBy: project_invites.created_by,
              token: project_invites.token,
            })
            .from(project_invites)
            .where(
              and(
                eq(project_invites.project_id, activeProjectId),
                isNull(project_invites.used_at),
                isNull(project_invites.revoked_at),
              ),
            )
        )
          // Only single-use invitation links are pending invitations. A
          // reusable course code is standing infrastructure — it would sit
          // here all term beside a destructive cancel affordance.
          .filter((row) => isLegacyInviteToken(row.token))
          .map((row) => ({ id: row.id, createdBy: row.createdBy }));
        sidebarPendingInvites = inviteRows;
      }

      // One-time "you've been added" welcome: a collaborator whose membership
      // hasn't been acknowledged yet (welcomed_at null). Convenor name + repo
      // name feed the landing modal; ack stamps welcomed_at via /api/welcome-ack.
      const myRow = memberRows.find((m) => m.userId === user.id);
      if (userRole === "collaborator" && myRow && !myRow.welcomedAt) {
        const convenorRow = memberRows.find((m) => m.role === "convenor");
        needsWelcome = true;
        welcomeConvenor = convenorRow?.name || convenorRow?.username || "";
        welcomeProject =
          userProjects.find((p) => p.id === activeProjectId)?.github_repo_full_name ?? "";
        welcomeAccess = await readOwnRepoAccess(db, activeProjectId, user.id);
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
          id: user.id,
          github_id: user.github_id,
          github_login: user.github_login,
          github_name: user.github_name,
          github_email: user.github_email,
        },
        headDiverged: false,
        activeProjectId: null,
        siteFromHandoff: false,
        needsUpgrade: false,
        latestTelarTag: null,
        isBelowMinimum: false,
        releaseUnknown: false,
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
        welcomeAccess: null,
        repoUnavailable: false,
        repoFullName: null,
        siteTelarVersion: null,
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
          kind: projects.kind,
          parent_project_id: projects.parent_project_id,
        })
        .from(projects)
        .where(eq(projects.id, activeProjectId));

      const project = projectRows[0];
      pagesUrl = project?.github_pages_url ?? null;
      sidebarIsCourseProject = project?.kind === "course";
      showCourseTab = mayUseCourses(user) && (await hasCourseStanding(db, project, user.id));

      if (project && project.github_repo_full_name) {
        repoFullName = project.github_repo_full_name;
        // pagesUrl derive + lazy heal — pure D1, stays synchronous (feeds TabNav).
        const configRows = await db.select({
          telar_version: project_config.telar_version,
          url: project_config.url,
          baseurl: project_config.baseurl,
        }).from(project_config).where(eq(project_config.project_id, activeProjectId));
        const siteVersion = configRows[0]?.telar_version ?? null;
        siteTelarVersion = siteVersion;
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
        // Two lists, because checking the version and refusing the page are
        // separate decisions. Objects reads the version so its Upload tab can
        // say a site is behind on the first load; only Publish is refused as
        // a page, because on Objects the one act that needs a current
        // framework is the upload, which its action refuses itself
        // (readUploadGate).
        const VERSION_CHECKED_PATHS = ["/publish", "/objects"];
        const GATED_PATHS = ["/publish"];
        const onVersionChecked = VERSION_CHECKED_PATHS.some((p) => url.pathname.startsWith(p));
        const onGated = GATED_PATHS.some((p) => url.pathname.startsWith(p));
        const onPublish = url.pathname.startsWith("/publish");
        const latest = await readLoaderRelease(onVersionChecked, user.encrypted_access_token, env);
        // A cold cache on a path that does not check the version leaves
        // needsUpgrade false, provisional until the pill's poll warms it.
        if (latest !== undefined) {
          const tag = latest.ok ? latest.tag : null;
          const cmp = compareTelarVersion(siteVersion, tag);
          needsUpgrade = cmp.needsUpgrade;
          isBelowMinimum = cmp.isBelowMinimum;
          latestTelarTag = tag;
        }
        releaseUnknown = standingFromLatest(siteVersion, latest) === "unknown";

        upgradeAwaitsConvenor = deriveUpgradeAwaitsConvenor(
          needsUpgrade,
          userRole,
          project.gh_workflows_write_missing,
        );

        if (shouldRedirectToUpgrade(needsUpgrade, userRole, onGated, upgradeAwaitsConvenor)) {
          throw redirect(`/upgrade?from=${encodeURIComponent(url.pathname)}`);
        }
        if (shouldRedirectPublishToObjects(onPublish, upgradeAwaitsConvenor)) {
          throw redirect("/objects");
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
      id: user.id,
      github_id: user.github_id,
      github_login: user.github_login,
      github_name: user.github_name,
      github_email: user.github_email,
    },
    headDiverged,
    activeProjectId,
    siteFromHandoff: isHandoffSite(handoffSite, activeProjectId),
    needsUpgrade,
    latestTelarTag,
    isBelowMinimum,
    upgradeAwaitsConvenor,
    releaseUnknown,
    userRole,
    presenceColor,
    pagesUrl,
    unpublishedCount,
    allProjects,
    environment: env.ENVIRONMENT,
    sidebarMembers,
    sidebarPendingInvites,
    sidebarSeats,
    sidebarIsCourseProject,
    showCourseTab,
    needsWelcome,
    needsReleaseNote,
    welcomeProject,
    welcomeConvenor,
    welcomeAccess,
    repoUnavailable,
    repoFullName,
    siteTelarVersion,
    needsWorkflowsApproval: workflowsApproval.needed,
    workflowsApprovalUrl: workflowsApproval.url,
    activeProjectShared: sidebarSeats.used > 1,
  };
}

/**
 * CollaborationOverlay — the freeze modals and the post-upgrade reload.
 * Must be a child of CollaborationProvider so it can call useCollaborationContext.
 * Each modal shows only for an operation another user holds; see
 * `~/lib/freeze-view`.
 */
function CollaborationOverlay() {
  const {
    publishHeldByOther,
    publishError,
    dismissPublishError,
    upgradeHeldByOther,
    upgradeError,
    dismissUpgradeError,
  } = useCollaborationContext();

  return (
    <>
      <PublishFreezeModal
        isPublishing={publishHeldByOther}
        publishError={publishError}
        onDismiss={dismissPublishError}
      />
      <UpgradeFreezeModal
        isUpgrading={upgradeHeldByOther}
        upgradeError={upgradeError}
        onDismiss={dismissUpgradeError}
      />
      <ReloadOnUpgradeComplete />
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

/** Another page is always read, whatever a story write's answer held back (`readAnotherPage`). */
export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  return readAnotherPage(args);
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user, activeProjectId, userRole, presenceColor, pagesUrl, environment, sidebarMembers, sidebarPendingInvites, sidebarSeats, sidebarIsCourseProject, showCourseTab, needsWelcome, needsReleaseNote, welcomeProject, welcomeConvenor, welcomeAccess, needsWorkflowsApproval, workflowsApprovalUrl } = loaderData;
  const { t: tCollab } = useTranslation("collaboration");
  const location = useLocation();
  // Story editor route (`/stories/:id`, not the `/stories` list). There the tab
  // nav is dead weight mid-edit, so it's hidden on a landscape phone to reclaim
  // vertical space — the editor breadcrumb's "Start" link remains the way out.
  const isStoryEditor = /^\/stories\/[^/]+/.test(location.pathname);
  const releaseFetcher = useFetcher();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [betaAck, setBetaAck] = useState(false);
  const [betaPromptOpen, setBetaPromptOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
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
    <TabSiteGate activeProjectId={activeProjectId} siteFromHandoff={loaderData.siteFromHandoff}>
    <CollaborationProvider
      projectId={activeProjectId}
      userId={user.id}
      userGithubId={user.github_id}
      userName={user.github_name || user.github_login}
      presenceColor={presenceColor ?? null}
    >
      <PageSiteProvider activeProjectId={activeProjectId}>
      <SiteStatusProvider>
      <ToastProvider>
        <NavigationOverlay />
        <LocationAwarenessSync />
        <UndoFeedback />
        <SiteChangedWatcher />
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
            showCourseTab={showCourseTab}
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
          isCourseProject={sidebarIsCourseProject ?? false}
          triggerRef={usersIconRef}
        />
        <DocsDrawer
          open={openDocId !== null}
          docId={openDocId}
          onClose={() => setOpenDocId(null)}
          onOpenDoc={openDoc}
        />
        <CollaborationOverlay />
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

        {/* One-time landing welcome for a newly-added collaborator; it
            acknowledges itself through /api/welcome-ack. */}
        <WelcomeModal
          needsWelcome={needsWelcome}
          siteId={activeProjectId}
          project={welcomeProject}
          convenor={welcomeConvenor}
          loaderAccess={welcomeAccess}
          onReport={() => setBugReportOpen(true)}
        />

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
          repoFullName={loaderData.repoFullName ?? undefined}
          telarVersion={loaderData.siteTelarVersion ?? undefined}
          headDiverged={loaderData.headDiverged}
          projectId={activeProjectId ?? undefined}
        />
      </ToastProvider>
      </SiteStatusProvider>
      </PageSiteProvider>
    </CollaborationProvider>
    </TabSiteGate>
  );
}

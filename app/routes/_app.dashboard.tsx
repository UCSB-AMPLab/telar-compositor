/**
 * Dashboard — project management hub with team management and shared project support.
 *
 * Loader: fetches owned + shared projects (via getUserProjects), active project's
 *   team members, pending invites, and project config. Preview sections are on the
 *   Homepage tab (_app.homepage.tsx).
 * Action: handles switch-project, reorder, autosave-config, sync intents, and
 *   team management intents (generate-invite, search-users, send-invite, remove-member).
 * Component: project status bar, workflow steps, team panel.
 */

import { asc, count, desc, eq, and, gt, inArray, isNull, sql } from "drizzle-orm";
import { Trans, useTranslation } from "react-i18next";
import { Link, redirect, useFetcher, useLoaderData, useNavigate, useRouteLoaderData, useSearchParams } from "react-router";
import React, { useState, useEffect } from "react";
import type { Route } from "./+types/_app.dashboard";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, stories, steps, project_config, project_members, project_invites, users } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { getRepoHead } from "~/lib/github.server";
import { getUserProjects, requireOwner } from "~/lib/membership.server";
import { computeFullSyncDiff, applyFullSyncChanges } from "~/lib/sync.server";
import type { FullSyncChanges } from "~/lib/sync.server";
import { ProjectStatusBar } from "~/components/features/dashboard/ProjectStatusBar";
import {
  SyncConfirmModal,
  SYNC_DIFF_FETCHER_KEY,
} from "~/components/features/dashboard/SyncConfirmModal";
import { RoleBadge } from "~/components/features/dashboard/RoleBadge";
import { useVersionChangeToast } from "~/hooks/use-version-change-toast";
import { RestrictionBanner } from "~/components/layout/RestrictionBanner";
import { EmptyState } from "~/components/features/dashboard/EmptyState";
import { Settings, Image, BookOpen, Sparkles, Upload } from "lucide-react";

export const handle = { i18n: ["common", "dashboard", "team", "upgrade"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Fetch all projects the user has access to (owned + shared)
  const allProjects = await getUserProjects(db, user.id);

  if (allProjects.length === 0) {
    throw redirect("/onboarding");
  }

  // If any owned project has incomplete onboarding, redirect
  const incompleteProject = allProjects.find(
    (p) => p.userRole === "convenor" && !p.onboarding_completed
  );
  if (incompleteProject) {
    throw redirect("/onboarding");
  }

  // Read activeProjectId from session
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  // Validate that the session project is in the accessible list; fall back to first
  const activeProject =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

  const userRole = activeProject.userRole;

  // Fetch project config
  const configRows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);
  const config = configRows[0] ?? null;

  // Fetch unpublished count for status bar
  const projectStories = await db
    .select({ id: stories.id, updated_at: stories.updated_at })
    .from(stories)
    .where(eq(stories.project_id, activeProject.id));

  let unpublishedCount = 0;
  if (activeProject.last_published_at) {
    unpublishedCount = projectStories.filter(
      (s) => s.updated_at && s.updated_at > activeProject.last_published_at!
    ).length;
  }

  // Fetch team members for the active project (joined with users table for profile data)
  const memberRows = await db
    .select({
      userId: project_members.user_id,
      role: project_members.role,
      githubId: users.github_id,
      username: users.github_login,
      contributions: project_members.contributions,
      presenceColor: project_members.presence_color,
    })
    .from(project_members)
    .innerJoin(users, eq(project_members.user_id, users.id))
    .where(eq(project_members.project_id, activeProject.id));

  const members = memberRows.map((m) => ({
    userId: m.userId,
    githubId: m.githubId,
    username: m.username,
    role: m.role as "convenor" | "collaborator",
    contributions: m.contributions ? JSON.parse(m.contributions) : null,
    presenceColor: m.presenceColor ?? null,
  }));

  // Fetch pending invites (not yet used and not expired)
  const now = new Date().toISOString();
  const pendingInviteRows = await db
    .select({
      id: project_invites.id,
      createdBy: project_invites.created_by,
      expiresAt: project_invites.expires_at,
    })
    .from(project_invites)
    .where(
      and(
        eq(project_invites.project_id, activeProject.id),
        isNull(project_invites.used_by),
        sql`${project_invites.expires_at} > ${now}`
      )
    );

  const pendingInvites = pendingInviteRows.map((inv) => ({
    id: inv.id,
    createdBy: inv.createdBy,
  }));

  // Fetch owner login for shared projects display
  const ownerIds = [...new Set(allProjects.map((p) => p.user_id))];
  const ownerRows = await db
    .select({ id: users.id, github_login: users.github_login })
    .from(users)
    .where(inArray(users.id, ownerIds));
  const ownerLoginMap: Record<number, string> = {};
  for (const row of ownerRows) {
    ownerLoginMap[row.id] = row.github_login;
  }

  // Fetch member counts per project
  const memberCountRows = await db
    .select({ project_id: project_members.project_id, count: count() })
    .from(project_members)
    .where(inArray(project_members.project_id, allProjects.map((p) => p.id)))
    .groupBy(project_members.project_id);
  const memberCountMap: Record<number, number> = {};
  for (const row of memberCountRows) {
    memberCountMap[row.project_id] = row.count;
  }

  const allProjectsEnriched = allProjects.map((p) => ({
    ...p,
    ownerLogin: ownerLoginMap[p.user_id] ?? null,
    memberCount: memberCountMap[p.id] ?? 1,
  }));

  return {
    hasProject: true as const,
    project: activeProject,
    allProjects: allProjectsEnriched,
    userRole,
    currentUserId: user.id,
    members,
    pendingInvites,
    config,
    unpublishedCount,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Helper to get active project from session
  const userId = user.id;
  async function getActiveProject() {
    const sessionStorage = createSessionStorage(env.SESSION_SECRET);
    const session = await sessionStorage.getSession(request.headers.get("Cookie"));
    const sessionActiveId = session.get("activeProjectId") as number | undefined;
    const allProjects = await getUserProjects(db, userId);
    if (allProjects.length === 0) return null;
    return allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];
  }

  switch (intent) {
    case "reorder": {
      const orderJson = formData.get("order") as string;
      const projectId = Number(formData.get("projectId"));
      const order: number[] = JSON.parse(orderJson);

      // Security: verify all story IDs belong to an accessible project
      const projectStories = await db
        .select({ id: stories.id })
        .from(stories)
        .where(
          and(
            eq(stories.project_id, projectId),
            inArray(stories.id, order)
          )
        );

      const ownedIds = new Set(projectStories.map((s) => s.id));
      const now = new Date().toISOString();

      await Promise.all(
        order
          .filter((id) => ownedIds.has(id))
          .map((id, idx) =>
            db
              .update(stories)
              .set({ order: idx, updated_at: now })
              .where(eq(stories.id, id))
          )
      );

      return { ok: true, intent: "reorder" };
    }

    case "switch-project": {
      const projectId = Number(formData.get("projectId"));

      // Verify the user has access to this project
      const allProjects = await getUserProjects(db, user.id);
      const accessible = allProjects.find((p) => p.id === projectId);
      if (!accessible) {
        throw new Response("Not found", { status: 404 });
      }

      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      session.set("activeProjectId", projectId);
      const cookie = await sessionStorage.commitSession(session);

      return redirect("/dashboard", {
        headers: { "Set-Cookie": cookie },
      });
    }

    case "autosave-config": {
      const field = formData.get("field") as string;
      const value = formData.get("value") as string;
      const projectId = Number(formData.get("entityId") ?? formData.get("projectId"));
      const allowedFields = ["title", "description"];
      if (!allowedFields.includes(field)) throw new Response("Bad request", { status: 400 });

      await db
        .update(project_config)
        .set({ [field]: value, updated_at: new Date().toISOString() })
        .where(eq(project_config.project_id, projectId));

      return { ok: true, intent: "autosave-config" };
    }

    case "generate-invite": {
      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "generate-invite", error: "no_project" };

      await requireOwner(db, activeProject.id, user.id);

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      await db.insert(project_invites).values({
        project_id: activeProject.id,
        token,
        created_by: user.id,
        expires_at: expiresAt,
      });

      const origin = new URL(request.url).origin;
      const inviteUrl = `${origin}/invite/${token}`;
      return { ok: true, intent: "generate-invite", inviteUrl };
    }

    case "search-users": {
      const query = (formData.get("query") as string) ?? "";
      if (!query || query.length < 2) {
        return { ok: true, intent: "search-users", users: [] };
      }

      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "search-users", error: "no_project" };

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const { searchGitHubUsers } = await import("~/lib/github.server");
        const results = await searchGitHubUsers(token, query);
        return { ok: true, intent: "search-users", users: results };
      } catch {
        return { ok: true, intent: "search-users", users: [] };
      }
    }

    case "send-invite": {
      const username = formData.get("username") as string;
      if (!username) return { ok: false, intent: "send-invite", error: "missing_username" };

      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "send-invite", error: "no_project" };

      await requireOwner(db, activeProject.id, user.id);

      // Look up user by github_login
      const targetUserRows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.github_login, username))
        .limit(1);

      if (targetUserRows.length > 0) {
        const targetUserId = targetUserRows[0].id;
        // Add as member directly (onConflictDoNothing handles already-a-member)
        await db
          .insert(project_members)
          .values({
            project_id: activeProject.id,
            user_id: targetUserId,
            role: "collaborator",
            joined_at: new Date().toISOString(),
          })
          .onConflictDoNothing();
        return { ok: true, intent: "send-invite", added: true };
      } else {
        // Create token-based invite
        const token = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        await db.insert(project_invites).values({
          project_id: activeProject.id,
          token,
          created_by: user.id,
          expires_at: expiresAt,
        });
        const origin = new URL(request.url).origin;
        const inviteUrl = `${origin}/invite/${token}`;
        return { ok: true, intent: "send-invite", added: false, inviteUrl };
      }
    }

    case "cancel-invite": {
      const inviteId = Number(formData.get("inviteId"));
      if (!inviteId) return { ok: false, intent: "cancel-invite", error: "missing_invite_id" };

      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "cancel-invite", error: "no_project" };

      await requireOwner(db, activeProject.id, user.id);

      // Verify invite belongs to this project
      await db
        .delete(project_invites)
        .where(
          and(
            eq(project_invites.id, inviteId),
            eq(project_invites.project_id, activeProject.id),
          )
        );

      return { ok: true, intent: "cancel-invite" };
    }

    case "remove-member": {
      const targetUserId = Number(formData.get("userId"));
      if (!targetUserId) return { ok: false, intent: "remove-member", error: "missing_user_id" };

      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "remove-member", error: "no_project" };

      await requireOwner(db, activeProject.id, user.id);

      // Cannot remove the owner
      const targetRole = await db
        .select({ role: project_members.role })
        .from(project_members)
        .where(
          and(
            eq(project_members.project_id, activeProject.id),
            eq(project_members.user_id, targetUserId)
          )
        )
        .limit(1);

      if (targetRole[0]?.role === "convenor") {
        return { ok: false, intent: "remove-member", error: "cannot_remove_owner" };
      }

      await db
        .delete(project_members)
        .where(
          and(
            eq(project_members.project_id, activeProject.id),
            eq(project_members.user_id, targetUserId)
          )
        );

      return { ok: true, intent: "remove-member" };
    }

    case "compute-full-sync-diff": {
      const activeProject = await getActiveProject();
      if (!activeProject) {
        return { ok: false, intent: "compute-full-sync-diff", error: "no_project" };
      }

      // Guard: only owners may sync
      await requireOwner(db, activeProject.id, user.id);

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const diff = await computeFullSyncDiff(
          activeProject.id,
          token,
          owner,
          repo,
          db,
          null,
        );

        const hasChanges =
          (diff.objects?.newObjects?.length ?? 0) > 0 ||
          (diff.objects?.changedObjects?.length ?? 0) > 0 ||
          (diff.objects?.missingObjects?.length ?? 0) > 0 ||
          (diff.stories?.newStories?.length ?? 0) > 0 ||
          (diff.stories?.changedStories?.length ?? 0) > 0 ||
          (diff.stories?.missingStories?.length ?? 0) > 0 ||
          (diff.config?.changedFields?.length ?? 0) > 0;

        if (!hasChanges) {
          const currentHead = await getRepoHead(token, owner, repo);
          if (currentHead) {
            await db
              .update(projects)
              .set({ head_sha: currentHead, updated_at: new Date().toISOString() })
              .where(eq(projects.id, activeProject.id));
          }
        }

        return { ok: true, intent: "compute-full-sync-diff", diff };
      } catch (err) {
        return {
          ok: false,
          intent: "compute-full-sync-diff",
          error: "sync_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "apply-full-sync": {
      const activeProject = await getActiveProject();
      if (!activeProject) {
        return { ok: false, intent: "apply-full-sync", error: "no_project" };
      }

      // Guard: only owners may apply sync
      await requireOwner(db, activeProject.id, user.id);

      const changesJson = formData.get("changes") as string;
      if (!changesJson) {
        return { ok: false, intent: "apply-full-sync", error: "missing_changes" };
      }

      let changes: FullSyncChanges;
      try {
        changes = JSON.parse(changesJson) as FullSyncChanges;
      } catch {
        return { ok: false, intent: "apply-full-sync", error: "invalid_changes" };
      }

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const result = await applyFullSyncChanges(
          activeProject.id,
          changes,
          token,
          owner,
          repo,
          db,
        );
        return { ok: true, intent: "apply-full-sync", newHeadSha: result.newHeadSha };
      } catch (err) {
        return {
          ok: false,
          intent: "apply-full-sync",
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

export default function DashboardPage({ loaderData }: Route.ComponentProps) {
  const { t, i18n } = useTranslation("dashboard");
  const { t: tTeam } = useTranslation("team");
  const docsUrl = i18n.language === "es" ? "https://telar.org/guia" : "https://telar.org/docs";
  const fetcher = useFetcher();

  // Surface external version drift as a toast. The
  // compute-full-sync-diff submission happens inside SyncConfirmModal via
  // useFetcher({ key: SYNC_DIFF_FETCHER_KEY }); we subscribe to the same
  // fetcher here so the toast fires once at the dashboard level and stays
  // visible after the modal closes. The hook calls showToast with "info"
  // for direction="ahead" (externalUpgradeToast — D1 was silently healed
  // by applyFullSyncChanges) and "warning" for
  // direction="behind" (externalDowngradeToast — user must verify per
  // When there is no versionChange the hook is a no-op.
  const syncDiffFetcher = useFetcher({ key: SYNC_DIFF_FETCHER_KEY });
  const syncDiffData = syncDiffFetcher.data as
    | { ok?: boolean; diff?: { config?: { versionChange?: unknown } } }
    | undefined;
  useVersionChangeToast(syncDiffData as Parameters<typeof useVersionChangeToast>[0]);

  // Get headDiverged from parent app layout loader
  const appLoaderData = useRouteLoaderData("routes/_app") as { headDiverged?: boolean } | undefined;
  const headDiverged = appLoaderData?.headDiverged ?? false;

  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // Auto-open sync modal when ?sync=1 is in URL (from SyncBanner click)
  useEffect(() => {
    if (searchParams.get("sync") === "1") {
      setSyncModalOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  if (!loaderData.hasProject) {
    return <EmptyState />;
  }

  const {
    project,
    allProjects,
    userRole,
    currentUserId,
    members,
    pendingInvites,
    config,
    unpublishedCount,
  } = loaderData;

  function handleSwitchProject(projectId: number) {
    fetcher.submit(
      {
        intent: "switch-project",
        projectId: String(projectId),
      },
      { method: "post" }
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* H1 */}
      <h1 className="font-heading font-bold text-2xl text-charcoal">
        {t("page_title")}
      </h1>

      {/* Project status bar — uses enriched allProjects with role/owner info */}
      <ProjectStatusBar
        repoName={project.github_repo_full_name}
        lastPublished={project.last_published_at ?? null}
        lastSynced={project.last_synced_at ?? null}
        unpublishedCount={unpublishedCount ?? 0}
        headDiverged={headDiverged}
        allProjects={allProjects}
        activeProjectId={project.id}
        onSwitchProject={handleSwitchProject}
        onSyncClick={() => setSyncModalOpen(true)}
        pagesUrl={project.github_pages_url ?? null}
      />

      {/* Sync confirmation modal */}
      <SyncConfirmModal
        open={syncModalOpen}
        unpublishedCount={unpublishedCount ?? 0}
        onClose={() => setSyncModalOpen(false)}
      />

      {/* Collaborator sync restriction banner */}
      {userRole === "collaborator" && (
        <RestrictionBanner message={tTeam("restriction_sync")} />
      )}

      {/* Repo explanation */}
      <p className="font-body text-sm text-gray-500">
        {t("repo_explanation")}
      </p>

      {/* Explanatory paragraphs */}
      <div className="space-y-3">
        <p className="font-body text-sm text-charcoal leading-relaxed">
          <Trans
            i18nKey="intro_paragraph_1"
            ns="dashboard"
            components={{
              strong: <strong />,
              iiifLink: (
                <a
                  href="https://iiif.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                />
              ),
            }}
          />
        </p>
        <p className="font-body text-sm text-charcoal leading-relaxed">
          <Trans
            i18nKey="intro_paragraph_2"
            ns="dashboard"
            components={{
              telarLink: (
                <a
                  href="https://telar.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                />
              ),
              docsLink: (
                <a
                  href={docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                />
              ),
            }}
          />
        </p>
      </div>

      {/* Workflow steps */}
      <div>
        <h2 className="font-heading font-semibold text-base text-charcoal mb-3">
          {t("workflow.title")}
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch gap-3">
          {([
            { n: 1, icon: Settings, to: "/config" },
            { n: 2, icon: Image, to: "/objects" },
            { n: 3, icon: BookOpen, to: "/stories" },
            { n: 4, icon: Sparkles, to: "/homepage" },
            { n: 5, icon: Upload, to: "/publish" },
          ] as const).map(({ n, icon: Icon, to }, i) => (
            <React.Fragment key={n}>
              <Link
                to={to}
                className="group bg-periwinkle rounded-lg p-4 hover:bg-periwinkle/80 hover:shadow-md transition-all flex flex-col items-center text-center"
              >
                <Icon className="w-5 h-5 text-charcoal/60 mb-2" />
                <p className="font-heading font-semibold text-sm text-charcoal">
                  {t(`workflow.step${n}_title`)}
                </p>
                <p className="font-body text-xs text-charcoal/70 mt-1">
                  {t(`workflow.step${n}_desc`)}
                </p>
              </Link>
              {i < 4 && (
                <span className="hidden lg:flex items-center text-charcoal text-lg font-bold select-none" aria-hidden="true">→</span>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Save/publish paragraph */}
      <p className="font-body text-sm text-gray-600 leading-relaxed">
        {t("save_publish")}
      </p>

    </div>
  );
}

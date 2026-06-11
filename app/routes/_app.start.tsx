/**
 * This file is the Start route — the Atelier front door.
 *
 * The front door orients the user and points the way: a welcome strip
 * (project name, summary, role chip, convened-by line, orientation
 * chips) and a 2×3 workflow-map spine (Configure · Objects · Stories ·
 * Glossary · Pages · Publish) with real per-step counts. `/` redirects
 * here; the route is always reachable (NOT gated on upgrade).
 *
 * The loader resolves the active project via membership, guards a
 * zero-project user to /onboarding (never /objects or /dashboard — that
 * looped), and computes per-step counts as
 * independent count(*) queries via Promise.all (objects total + a single
 * NOT EXISTS "unused" subquery, story drafts, glossary terms, pages).
 * The Publish "N to ship" count is the shell's unpublishedCount (the full
 * five-type spectrum) — NOT recomputed here. A `state` flag ("empty" when
 * the project has no objects, stories, or pages) drives the first-run
 * checklist + dimmed tiles.
 *
 * The visible Atelier page body (welcome strip + workflow map + right-rail
 * slot) is composed in the default export; the rail (activity / recovery)
 * and docs drawer mount into this shell.
 *
 * @version v1.3.6-beta
 */


import { and, eq, sql } from "drizzle-orm";
import { redirect, useOutletContext, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/_app.start";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import {
  objects,
  stories,
  glossary_terms,
  project_pages,
  project_config,
  project_members,
  users,
} from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import {
  resolveActiveProject,
  getUserProjectsWithStats,
} from "~/lib/membership.server";
import { getRecentActivity } from "~/lib/activity.server";
import { scanRepoOrphanStoryIds } from "~/lib/import.server";
import { decrypt } from "~/lib/crypto.server";
import { WelcomeStrip } from "~/components/features/start/WelcomeStrip";
import { WorkflowMap } from "~/components/features/start/WorkflowMap";
import { ActivityFeed } from "~/components/features/start/ActivityFeed";
import { OrphanRecoveryCard } from "~/components/features/start/OrphanRecoveryCard";
import { OtherProjectsRibbon } from "~/components/features/start/OtherProjectsRibbon";
import { FromTheDocs } from "~/components/features/start/FromTheDocs";

import { useTranslation } from "react-i18next";
import { useIsConvenor } from "~/hooks/use-role";
import { useGithubStatusPoll } from "~/hooks/use-github-status-poll";

export const handle = { i18n: ["common", "start", "dashboard", "config"] };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
  if (!resolved) {
    // Zero-project guard. MUST go to /onboarding,
    // never /objects or /dashboard (a no-project /objects/dashboard loader
    // bounces back here and loops).
    return redirect("/onboarding");
  }
  const { project: activeProject, userRole } = resolved;
  const pid = activeProject.id;

  // Per-step workflow-map counts. Each is an INDEPENDENT count(*) query run
  // in parallel — never a single 5-term compound SELECT (D1 caps compound
  // SELECT terms at 5). The objects-unused count is a single correlated
  // NOT EXISTS subquery: objects with no step in any of this project's
  // stories pointing at them.
  const n = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
  const [
    objRows,
    objUnusedRows,
    storyRows,
    storyDraftRows,
    termRows,
    pageRows,
    configRows,
  ] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(objects)
      .where(eq(objects.project_id, pid)),
    // Unused objects: NOT EXISTS a step (joined to a story in this project)
    // referencing the object by its slug. One SELECT — does not hit the cap.
    db
      .select({ n: sql<number>`count(*)` })
      .from(objects)
      .where(
        and(
          eq(objects.project_id, pid),
          sql`NOT EXISTS (SELECT 1 FROM steps s JOIN stories st ON s.story_id = st.id WHERE st.project_id = ${pid} AND s.object_id = ${objects.object_id})`,
        ),
      ),
    db
      .select({ n: sql<number>`count(*)` })
      .from(stories)
      .where(eq(stories.project_id, pid)),
    db
      .select({ n: sql<number>`count(*)` })
      .from(stories)
      .where(and(eq(stories.project_id, pid), eq(stories.draft, true))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(glossary_terms)
      .where(eq(glossary_terms.project_id, pid)),
    db
      .select({ n: sql<number>`count(*)` })
      .from(project_pages)
      .where(eq(project_pages.project_id, pid)),
    db
      .select({
        title: project_config.title,
        theme: project_config.theme,
        google_sheets_enabled: project_config.google_sheets_enabled,
      })
      .from(project_config)
      .where(eq(project_config.project_id, pid))
      .limit(1),
  ]);

  const objectCount = n(objRows);
  const objectsUnused = n(objUnusedRows);
  const storyCount = n(storyRows);
  const storyDrafts = n(storyDraftRows);
  const termCount = n(termRows);
  const pageCount = n(pageRows);

  // Configure status: "Done" when a project_config row exists with the key
  // fields populated (title + theme), otherwise "Not started".
  const config = configRows[0];
  const configured = Boolean(config?.title && config?.theme);

  // Convenor identity + collaborator count from member data. The convenor
  // row (role='convenor') joined to users.github_name gives the display
  // name; collaborator_count = members minus the single convenor.
  const memberRows = await db
    .select({
      role: project_members.role,
      githubName: users.github_name,
      githubLogin: users.github_login,
    })
    .from(project_members)
    .innerJoin(users, eq(project_members.user_id, users.id))
    .where(eq(project_members.project_id, pid));

  const convenorRow = memberRows.find((m) => m.role === "convenor");
  const convenorName = convenorRow?.githubName || convenorRow?.githubLogin || "";
  const collaboratorCount = Math.max(0, memberRows.length - 1);

  const createdYear = activeProject.created_at
    ? new Date(activeProject.created_at).getFullYear()
    : new Date().getFullYear();

  // First-run flag: a project with no objects, no stories, and no pages is
  // "empty" — the welcome strip swaps in the role-specific checklist and the
  // workflow tiles dim.
  const state: "populated" | "empty" =
    objectCount === 0 && storyCount === 0 && pageCount === 0 ? "empty" : "populated";

  // --- Right-rail + ribbon reads ----------------------------------------

  // Activity feed: last-5 rows for THIS project, newest first.
  // Project-scoped inside getRecentActivity (the security boundary); it fails
  // open to [] on its own — no error banner on this page.
  const activity = await getRecentActivity(db, pid, 5);

  // Orphan-story scan: only for a CONVENOR on a POPULATED, non-
  // Sheets-backed project (Sheets sites have no per-story CSVs to scan). The
  // scan is a recovery affordance, not a blocking signal — fail-open to [] on
  // any error (decrypt / GitHub / parse). NO client-supplied ids are ever
  // trusted: the /dashboard restore action recomputes the orphan set
  // server-side, so the card only needs to know that orphans exist.
  let orphanStoryIds: string[] = [];
  if (
    userRole === "convenor" &&
    state !== "empty" &&
    !config?.google_sheets_enabled
  ) {
    try {
      const token = await decrypt(
        user.encrypted_access_token,
        env.ENCRYPTION_KEY,
      );
      const [owner, repo] = activeProject.github_repo_full_name.split("/");
      const projectStoryIds = new Set(
        (
          await db
            .select({ story_id: stories.story_id })
            .from(stories)
            .where(eq(stories.project_id, pid))
        ).map((r) => r.story_id),
      );
      orphanStoryIds = await scanRepoOrphanStoryIds(
        token,
        owner,
        repo,
        projectStoryIds,
      );
    } catch {
      // Fail-open: recovery affordance, not a blocking signal — no error
      // banner on the front door.
      orphanStoryIds = [];
    }
  }

  // Other-projects ribbon: already user-scoped + pre-sorted. The
  // page renders it only when populated; the loader always returns the list.
  const otherProjects = await getUserProjectsWithStats(db, user.id);

  return {
    project: {
      id: activeProject.id,
      github_repo_full_name: activeProject.github_repo_full_name,
    },
    userRole,
    counts: {
      configured,
      objects: objectCount,
      objectsUnused,
      stories: storyCount,
      storyDrafts,
      terms: termCount,
      pages: pageCount,
    },
    convenorName,
    collaboratorCount,
    createdYear,
    summary: config?.title ?? activeProject.github_repo_full_name,
    state,
    activity,
    orphanStoryIds,
    otherProjects,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Shape of the slice of the _app shell loader this page consumes. */
type AppShellData = { unpublishedCount?: number } | null;

export default function StartPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("common");
  const {
    project,
    userRole,
    counts,
    convenorName,
    collaboratorCount,
    createdYear,
    summary,
    state,
    activity,
    orphanStoryIds,
    otherProjects,
  } = loaderData;

  // Publish "N to ship": prefer the live out-of-band count (the same source the
  // Site Status pill uses) over the shell loader's cheap updated_at proxy, so the
  // tile and the pill agree. The proxy over-counts rows touched by DO snapshots
  // without a content change; the live count is the real computeChangeSummary
  // diff. Falls back to the proxy until the first poll lands.
  const shell = useRouteLoaderData("routes/_app") as AppShellData;
  const live = useGithubStatusPoll();
  const unpublishedCount = live?.unpublishedCount ?? shell?.unpublishedCount ?? 0;

  // Role gate is the UX-layer don't-render contract (use-role reads the
  // _app loader's authoritative userRole). The recovery card + ribbon also
  // gate on populated state per the State Variants design.
  const isConvenor = useIsConvenor();

  // The collaboration sidebar's open/toggle and docs drawer live in the _app
  // shell; both are threaded down via Outlet context.
  const { openCollaborationSidebar, openDoc } =
    useOutletContext<{ openCollaborationSidebar?: () => void; openDoc?: (id: string) => void }>() ?? {};

  // Docs drawer is owned by the _app shell. Delegate to the shell's
  // openDoc; fall back to a no-op so consumers never need to null-check.
  const onOpenDoc = openDoc ?? (() => {});

  return (
    // Page container — max 1152px centred, cream background. Cards sit on
    // surface (radius 8) inside. Page vertical stack uses the 18px exception.
    <div className="mx-auto max-w-[1152px] bg-cream flex flex-col gap-[18px]">
      {/* 1. Welcome strip (full width) */}
      <WelcomeStrip
        projectName={project.github_repo_full_name}
        summary={summary}
        role={userRole}
        convenorName={convenorName}
        collaboratorCount={collaboratorCount}
        createdYear={createdYear}
        state={state}
        onOpenDoc={onOpenDoc}
        onAddCollaborators={openCollaborationSidebar}
      />

      {/* 2. Atelier two-column grid — minmax(0,1.65fr) minmax(0,1fr), gap 18px.
          Collapses to a single column below 1000px (the documented
          @media (max-width:1000px) rule, expressed as the min-[1000px] variant). */}
      <div className="grid grid-cols-1 gap-[18px] min-[1000px]:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        {/* Left: workflow map */}
        <WorkflowMap
          counts={counts}
          unpublishedCount={unpublishedCount}
          empty={state === "empty"}
          onOpenDoc={onOpenDoc}
        />

        {/* Right: rail — ActivityFeed always, then (convenor + populated +
            orphans-exist) the OrphanRecoveryCard. The rail stack uses the
            14px gap exception. */}
        <aside
          data-rail-slot="true"
          className="flex flex-col gap-[14px]"
          aria-label={t("common:a11y.activity_rail")}
        >
          <ActivityFeed rows={activity} />
          {isConvenor && state !== "empty" && orphanStoryIds.length > 0 && (
            <OrphanRecoveryCard orphanStoryIds={orphanStoryIds} />
          )}
        </aside>
      </div>

      {/* 3. "From the docs" strip — role/state-aware 4-up reading list.
          Clicking a tile opens the DocsDrawer (overlay, no navigation). */}
      <FromTheDocs role={userRole} state={state} onOpenDoc={onOpenDoc} />

      {/* 4. Other-projects ribbon — populated only (don't-render in empty state). */}
      {state !== "empty" && otherProjects.length > 0 && (
        <OtherProjectsRibbon projects={otherProjects} activeProjectId={project.id} />
      )}

    </div>
  );
}

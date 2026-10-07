/**
 * How many of these pages are still the template's, unedited. A new site keeps
 * them, so they are not content its author made.
 */
async function countUntouchedTemplatePages(
  pages: Array<{ slug: string; body: string | null }>,
): Promise<number> {
  const flags = await Promise.all(pages.map((p) => isTemplatePage(p)));
  return flags.filter(Boolean).length;
}

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
 * independent queries via Promise.all (objects total, story drafts,
 * glossary terms, pages as count(*); the objects and the steps' object
 * values for the unused count, which matches a step to its object as the
 * published site does and so cannot be a SQL equality).
 * The Publish "N to ship" count is the shell's unpublishedCount (the full
 * five-type spectrum) — NOT recomputed here. A `state` flag ("empty" when
 * the project has no objects, stories, or pages) drives the first-run
 * checklist + dimmed tiles.
 *
 * The visible Atelier page body (welcome strip + workflow map + right-rail
 * slot) is composed in the default export; the rail (activity / recovery)
 * and docs drawer mount into this shell.
 *
 * @version v1.5.2-beta
 */


import { and, eq, inArray, sql } from "drizzle-orm";
import { objectsSheetOrder } from "~/lib/objects.server";
import { redirect, useFetcher, useOutletContext, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/_app.start";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import {
  objects,
  steps,
  stories,
  glossary_terms,
  project_pages,
  project_config,
  project_members,
  users,
} from "~/db/schema";
import { getUserProjectsWithStats, listableProjects } from "~/lib/membership.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { getRecentActivity } from "~/lib/activity.server";
import { scanRepoOrphanStoryIds } from "~/lib/import.server";
import { decrypt } from "~/lib/crypto.server";
import { isTemplatePage, TEMPLATE_PAGE_SLUGS } from "~/lib/template-content.server";
import { configFrameworkVersion, stepUseCounts } from "~/lib/object-id";
import { WelcomeStrip } from "~/components/features/start/WelcomeStrip";
import { WorkflowMap } from "~/components/features/start/WorkflowMap";
import { ActivityFeed } from "~/components/features/start/ActivityFeed";
import { ContributionRecordCard, WorkTogetherCard } from "~/components/features/start/CollaborationCards";
import {
  ORPHAN_RECOVERY_FETCHER_KEY,
  OrphanRecoveryCard,
  OrphanRecoveryOutcome,
} from "~/components/features/start/OrphanRecoveryCard";
import type { OrphanRecoveryAnswer } from "~/components/features/start/OrphanRecoveryCard";
import { OtherProjectsRibbon } from "~/components/features/start/OtherProjectsRibbon";
import { FromTheDocs } from "~/components/features/start/FromTheDocs";

import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { useIsConvenor } from "~/hooks/use-role";
import { useSharedGithubStatus } from "~/components/features/site-status/SiteStatusProvider";

export const handle = { i18n: ["common", "start", "dashboard", "config"] };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    // Zero-project guard. MUST go to /onboarding,
    // never /objects or /dashboard (a no-project /objects/dashboard loader
    // bounces back here and loops).
    return redirect("/onboarding");
  }
  const { project: activeProject, userRole } = resolved;
  const pid = activeProject.id;

  // Per-step workflow-map counts. Each is an INDEPENDENT query run in
  // parallel — never a single 5-term compound SELECT (D1 caps compound
  // SELECT terms at 5). The objects-unused count is the objects no step of
  // this project's stories shows: a step names its object as the site reads
  // both (`stepUseCounts`), so `map` is a use of `map.jpg`, and the objects are
  // read in objects.csv order, which decides the row a step shows where two
  // share the site's id.
  const n = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
  const [
    objRows,
    objectIdRows,
    stepObjectRows,
    storyRows,
    storyDraftRows,
    termRows,
    pageRows,
    configRows,
    templatePageCandidates,
  ] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(objects)
      .where(eq(objects.project_id, pid)),
    db
      .select({ object_id: objects.object_id })
      .from(objects)
      .where(eq(objects.project_id, pid))
      .orderBy(objectsSheetOrder()),
    db
      .select({ object_id: steps.object_id })
      .from(steps)
      .innerJoin(stories, eq(steps.story_id, stories.id))
      .where(eq(stories.project_id, pid)),
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
        telar_version: project_config.telar_version,
      })
      .from(project_config)
      .where(eq(project_config.project_id, pid))
      .limit(1),
    db
      .select({ slug: project_pages.slug, body: project_pages.body })
      .from(project_pages)
      .where(
        and(
          eq(project_pages.project_id, pid),
          inArray(project_pages.slug, [...TEMPLATE_PAGE_SLUGS]),
        ),
      ),
  ]);

  const objectCount = n(objRows);
  const used = stepUseCounts(
    objectIdRows,
    stepObjectRows.map((r) => r.object_id),
    configFrameworkVersion(configRows[0]),
  );
  const objectsUnused = objectIdRows.filter((o) => !used.has(o.object_id)).length;
  const storyCount = n(storyRows);
  const storyDrafts = n(storyDraftRows);
  const termCount = n(termRows);
  const pageCount = n(pageRows);
  const authoredPageCount = pageCount - (await countUntouchedTemplatePages(templatePageCandidates));

  // Configure status: "Done" when a project_config row exists with the key
  // fields populated (title + theme), otherwise "Not started".
  const config = configRows[0];
  const configured = Boolean(config?.title && config?.theme);

  // Convenor identity + collaborator count from member data. The convenor
  // row (role='convenor') joined to users.github_name gives the display
  // name; collaborator_count = members minus the single convenor, minus
  // any instructor rows (staff, not group size — design §3).
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
  // Instructor rows are staff, not group size (design §3) — excluded from
  // the same count everywhere it appears.
  const collaboratorCount = Math.max(
    0,
    memberRows.filter((m) => m.role !== "instructor").length - 1,
  );

  const createdYear = activeProject.created_at
    ? new Date(activeProject.created_at).getFullYear()
    : new Date().getFullYear();

  // First-run flag: a project with no objects, no stories, and no pages of
  // its own (the template's unedited pages do not count) is "empty" — the welcome strip swaps in the role-specific checklist and the
  // workflow tiles dim.
  const state: "populated" | "empty" =
    objectCount === 0 && storyCount === 0 && authoredPageCount === 0 ? "empty" : "populated";
  // The orphan scan asks a different question: whether the site holds
  // anything at all, the template's pages included. A site with only those
  // pages can still have story CSVs in its repository that D1 has lost.
  const holdsAnything = [objectCount, storyCount, pageCount].some((count) => count > 0);

  // --- Right-rail + ribbon reads ----------------------------------------

  // Activity feed: last-5 rows for THIS project, newest first.
  // Project-scoped inside getRecentActivity (the security boundary); it fails
  // open to [] on its own — no error banner on this page.
  const activity = await getRecentActivity(db, pid, 5);

  // Orphan-story scan: only for a CONVENOR on a non-empty (holdsAnything), non-
  // Sheets-backed project (Sheets sites have no per-story CSVs to scan). The
  // scan is a recovery affordance, not a blocking signal — fail-open to [] on
  // any error (decrypt / GitHub / parse). NO client-supplied ids are ever
  // trusted: the /dashboard restore action recomputes the orphan set
  // server-side, so the card only needs to know that orphans exist.
  let orphanStoryCount = 0;
  if (
    userRole === "convenor" &&
    holdsAnything &&
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
      orphanStoryCount = (
        await scanRepoOrphanStoryIds(token, owner, repo, projectStoryIds)
      ).length;
    } catch {
      // Fail-open: recovery affordance, not a blocking signal — no error
      // banner on the front door.
      orphanStoryCount = 0;
    }
  }

  // Other-projects ribbon: already user-scoped + pre-sorted. The
  // page renders it only when populated; the loader always returns the list.
  //
  // Children an instructor holds only an instructor row on are left out
  // (ruling 18). The active project above is resolved separately and is not
  // filtered, so a suppressed child reached by direct URL still opens here.
  const otherProjects = listableProjects(await getUserProjectsWithStats(db, user.id));

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
    orphanStoryCount,
    otherProjects,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Shape of the slice of the _app shell loader this page consumes. */
type AppShellData = { unpublishedCount?: number; showCourseTab?: boolean } | null;

/** Whether the _app shell offers the Course tab to this session. */
function shellOffersCourseTab(shell: AppShellData): boolean {
  return shell?.showCourseTab === true;
}

/** The right rail: the collaboration cards, the activity feed and the orphan recovery card and its outcome. */
function StartRail({
  isConvenor,
  collaboratorCount,
  onInvite,
  activity,
  recoveryAnswer,
  orphanStoryCount,
}: {
  isConvenor: boolean;
  collaboratorCount: number;
  onInvite: (() => void) | undefined;
  activity: ComponentProps<typeof ActivityFeed>["rows"];
  recoveryAnswer: OrphanRecoveryAnswer | undefined;
  orphanStoryCount: number;
}) {
  const { t } = useTranslation("common");
  return (
    // Right: rail — ActivityFeed always, then (convenor + populated +
    // orphans-exist) the OrphanRecoveryCard. The rail stack uses the
    // 14px gap exception.
    <aside data-rail-slot="true" className="flex flex-col gap-[14px]" aria-label={t("common:a11y.activity_rail")}>
      {isConvenor && onInvite && <WorkTogetherCard collaboratorCount={collaboratorCount} onInvite={onInvite} />}
      {collaboratorCount > 0 && <ContributionRecordCard />}
      <ActivityFeed rows={activity} />
      <OrphanRecoveryOutcome answer={recoveryAnswer} />
      {isConvenor && orphanStoryCount > 0 && <OrphanRecoveryCard orphanStoryCount={orphanStoryCount} />}
    </aside>
  );
}

export default function StartPage({ loaderData }: Route.ComponentProps) {
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
    orphanStoryCount,
    otherProjects,
  } = loaderData;

  // Publish "N to ship": the live out-of-band count (the same source the Site
  // Status pill uses), so the tile and the pill agree. The shell loader's
  // updated_at proxy over-counts rows touched by DO snapshots without a content
  // change, so it is never shown; the tile has no number until the poll lands.
  const shell = useRouteLoaderData("routes/_app") as AppShellData;
  const live = useSharedGithubStatus();
  const unpublishedCount = live?.unpublishedCount ?? null;

  // Role gate is the UX-layer don't-render contract (use-role reads the
  // _app loader's authoritative userRole). The recovery card + ribbon also
  // gate on populated state per the State Variants design.
  const isConvenor = useIsConvenor();

  // The recovery card's answer, read here rather than in the card: a restore
  // that recovers every orphan unmounts the card with its outcome still to show.
  // Shown only while the fetcher is idle, since it keeps the last answer
  // through a new Restore or Ignore until that one returns.
  const recoveryFetcher = useFetcher<OrphanRecoveryAnswer>({ key: ORPHAN_RECOVERY_FETCHER_KEY });
  const recoveryAnswer = recoveryFetcher.state === "idle" ? recoveryFetcher.data : undefined;

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
        courseTab={shellOffersCourseTab(shell)}
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

        <StartRail
          isConvenor={isConvenor}
          collaboratorCount={collaboratorCount}
          onInvite={openCollaborationSidebar}
          activity={activity}
          recoveryAnswer={recoveryAnswer}
          orphanStoryCount={orphanStoryCount}
        />
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

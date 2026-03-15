/**
 * Dashboard — authenticated landing page.
 *
 * Shows story cards and project status bar when a project exists.
 * Shows empty state with CTA when no project is connected.
 */

import { asc, count, eq } from "drizzle-orm";
import { Plus, GitBranch } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { Route } from "./+types/_app.dashboard";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, stories, steps, project_config } from "~/db/schema";
import { ProjectStatusBar } from "~/components/features/dashboard/ProjectStatusBar";
import { StoryCard } from "~/components/features/dashboard/StoryCard";
import { EmptyState } from "~/components/features/dashboard/EmptyState";

export const handle = { i18n: ["common", "dashboard"] };

export async function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const userProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.user_id, user.id));

  if (userProjects.length === 0) {
    return { hasProject: false as const, project: null, stories: [], storyStepCounts: {}, config: null };
  }

  const project = userProjects[0];

  const projectStories = await db
    .select()
    .from(stories)
    .where(eq(stories.project_id, project.id))
    .orderBy(asc(stories.order));

  // Get step counts per story
  const stepCountRows = await db
    .select({ story_id: steps.story_id, count: count() })
    .from(steps)
    .groupBy(steps.story_id);

  const storyStepCounts: Record<number, number> = {};
  for (const row of stepCountRows) {
    storyStepCounts[row.story_id] = row.count;
  }

  const configRows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, project.id))
    .limit(1);
  const config = configRows[0] ?? null;

  // Count unpublished changes: stories updated after last publish
  let unpublishedCount = 0;
  if (project.last_published_at) {
    unpublishedCount = projectStories.filter(
      (s) => s.updated_at && s.updated_at > project.last_published_at!
    ).length;
  }

  return {
    hasProject: true as const,
    project,
    stories: projectStories,
    storyStepCounts,
    config,
    unpublishedCount,
  };
}

export default function DashboardPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("dashboard");

  if (!loaderData.hasProject) {
    return <EmptyState />;
  }

  const { project, stories: projectStories, storyStepCounts, unpublishedCount } = loaderData;

  return (
    <div className="max-w-6xl mx-auto">
      {/* Project status bar */}
      <ProjectStatusBar
        repoName={project.github_repo_full_name}
        lastPublished={project.last_published_at ?? null}
        lastSynced={project.last_synced_at ?? null}
        unpublishedCount={unpublishedCount ?? 0}
        className="mb-6"
      />

      {/* Action buttons */}
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 gap-2 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t("new_story")}
        </button>
        <Link
          to="/onboarding?force=true"
          className="inline-flex items-center justify-center bg-white border border-gray-200 text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 gap-2 hover:bg-cream transition-colors"
        >
          <GitBranch className="w-4 h-4" />
          {t("connect_repo")}
        </Link>
      </div>

      {/* Story grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projectStories.map((story) => (
          <StoryCard
            key={story.id}
            story={story}
            stepCount={storyStepCounts[story.id] ?? 0}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Dashboard — pedagogical landing page with site preview sections and inline editing.
 *
 * Loader: fetches active project's stories, config, landing data, and objects.
 * Action: handles reorder, switch-project, autosave-landing, autosave-config.
 * Component: explanatory content, workflow steps, four inline-editable site preview
 *   sections (Site Description, Welcome Message, Stories, Objects).
 */

import { asc, count, desc, eq, and, gt, inArray } from "drizzle-orm";
import { Trans, useTranslation } from "react-i18next";
import { Link, redirect, useFetcher, useLoaderData, useNavigate, useRouteLoaderData } from "react-router";
import React, { useState, useEffect } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import type { Route } from "./+types/_app.dashboard";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, stories, steps, project_config, objects, project_landing } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { computeFullSyncDiff, applyFullSyncChanges } from "~/lib/sync.server";
import type { FullSyncChanges } from "~/lib/sync.server";
import { ProjectStatusBar } from "~/components/features/dashboard/ProjectStatusBar";
import { StoryCard } from "~/components/features/dashboard/StoryCard";
import { SortableStoryCard } from "~/components/features/dashboard/SortableStoryCard";
import { ConnectRepoDropdown } from "~/components/features/dashboard/ConnectRepoDropdown";
import { EmptyState } from "~/components/features/dashboard/EmptyState";
import { DashboardPreviewSection } from "~/components/features/dashboard/DashboardPreviewSection";
import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { useIiifThumbnail } from "~/lib/use-iiif-thumbnail";
import { RefreshCw, Settings, Image, BookOpen, Upload } from "lucide-react";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";

export const handle = { i18n: ["common", "dashboard", "editor"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Fetch all user projects
  const allProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.user_id, user.id));

  if (allProjects.length === 0) {
    throw redirect("/onboarding");
  }

  // If any project has incomplete onboarding, redirect to finish it
  const incompleteProject = allProjects.find((p) => !p.onboarding_completed);
  if (incompleteProject) {
    throw redirect("/onboarding");
  }

  // Read activeProjectId from session
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  // Validate that the session project belongs to the user; fall back to first
  const activeProject =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

  const projectStories = await db
    .select()
    .from(stories)
    .where(eq(stories.project_id, activeProject.id))
    .orderBy(asc(stories.order));

  // Step counts per story
  // Count only content steps (step_number > 0), excluding title card rows
  const stepCountRows = await db
    .select({ story_id: steps.story_id, count: count() })
    .from(steps)
    .where(gt(steps.step_number, 0))
    .groupBy(steps.story_id);

  const storyStepCounts: Record<number, number> = {};
  for (const row of stepCountRows) {
    storyStepCounts[row.story_id] = row.count;
  }

  const configRows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);
  const config = configRows[0] ?? null;

  // Fetch landing page data from project_landing
  const landingRows = await db
    .select()
    .from(project_landing)
    .where(eq(project_landing.project_id, activeProject.id))
    .limit(1);
  const landing = landingRows[0] ?? null;

  // Fetch objects for the Objects preview section
  const projectObjects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, activeProject.id));

  let unpublishedCount = 0;
  if (activeProject.last_published_at) {
    unpublishedCount = projectStories.filter(
      (s) => s.updated_at && s.updated_at > activeProject.last_published_at!
    ).length;
  }

  // Build siteBaseUrl for IIIF thumbnail resolution (same pattern as objects page)
  const siteBaseUrl = config?.url
    ? `${config.url}${config.baseurl ?? ""}`
    : null;

  // Resolve cover thumbnails for stories from their lowest content step's object
  const storyIds = projectStories.map((s) => s.id);
  // Get the first content step (lowest step_number > 0) per story via subquery
  const allContentSteps = storyIds.length > 0
    ? await db
        .select({ story_id: steps.story_id, step_number: steps.step_number, object_id: steps.object_id })
        .from(steps)
        .where(and(inArray(steps.story_id, storyIds), gt(steps.step_number, 0)))
        .orderBy(asc(steps.step_number))
    : [];
  // Keep only the first step per story
  const coverSteps: { story_id: number; object_id: string | null }[] = [];
  const seenStories = new Set<number>();
  for (const row of allContentSteps) {
    if (!seenStories.has(row.story_id)) {
      seenStories.add(row.story_id);
      coverSteps.push({ story_id: row.story_id, object_id: row.object_id });
    }
  }

  // Map story_id -> object_id from step 1
  const storyCoverObjectIds: Record<number, string> = {};
  for (const row of coverSteps) {
    if (row.object_id) storyCoverObjectIds[row.story_id] = row.object_id;
  }

  // Look up thumbnail + image_available for those objects
  const coverObjectIdValues = Object.values(storyCoverObjectIds);
  const coverObjects = coverObjectIdValues.length > 0
    ? await db
        .select({ object_id: objects.object_id, thumbnail: objects.thumbnail, image_available: objects.image_available })
        .from(objects)
        .where(and(eq(objects.project_id, activeProject.id), inArray(objects.object_id, coverObjectIdValues)))
    : [];

  const objectThumbnailMap: Record<string, { thumbnail: string | null; image_available: boolean | null }> = {};
  for (const obj of coverObjects) {
    objectThumbnailMap[obj.object_id] = { thumbnail: obj.thumbnail, image_available: obj.image_available };
  }

  // Build story -> cover info map
  const storyCoverMap: Record<number, { thumbnail: string | null; objectId: string; imageAvailable: boolean | null }> = {};
  for (const [storyIdStr, objectId] of Object.entries(storyCoverObjectIds)) {
    const storyId = Number(storyIdStr);
    const objInfo = objectThumbnailMap[objectId];
    if (objInfo) {
      storyCoverMap[storyId] = { thumbnail: objInfo.thumbnail, objectId, imageAvailable: objInfo.image_available };
    }
  }

  return {
    hasProject: true as const,
    project: activeProject,
    allProjects,
    stories: projectStories,
    storyStepCounts,
    storyCoverMap,
    config,
    landing,
    objects: projectObjects,
    unpublishedCount,
    siteBaseUrl,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "reorder": {
      const orderJson = formData.get("order") as string;
      const projectId = Number(formData.get("projectId"));
      const order: number[] = JSON.parse(orderJson);

      // Security: verify all story IDs belong to the user's project
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

      // Verify ownership
      const projectRows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.user_id, user.id)))
        .limit(1);

      if (projectRows.length === 0) {
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

    case "autosave-landing": {
      const field = formData.get("field") as string;
      const value = formData.get("value") as string;
      const projectId = Number(formData.get("entityId"));
      const allowedFields = ["stories_heading", "stories_intro", "objects_heading", "objects_intro", "welcome_body"];
      if (!allowedFields.includes(field)) throw new Response("Bad request", { status: 400 });

      // Upsert: update if row exists, insert if not
      const existing = await db
        .select({ id: project_landing.id })
        .from(project_landing)
        .where(eq(project_landing.project_id, projectId))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(project_landing)
          .set({ [field]: value, updated_at: new Date().toISOString() })
          .where(eq(project_landing.project_id, projectId));
      } else {
        await db
          .insert(project_landing)
          .values({ project_id: projectId, [field]: value });
      }

      return { ok: true, intent: "autosave-landing" };
    }

    case "autosave-config": {
      const field = formData.get("field") as string;
      const value = formData.get("value") as string;
      const projectId = Number(formData.get("entityId"));
      const allowedFields = ["title", "description"];
      if (!allowedFields.includes(field)) throw new Response("Bad request", { status: 400 });

      await db
        .update(project_config)
        .set({ [field]: value, updated_at: new Date().toISOString() })
        .where(eq(project_config.project_id, projectId));

      return { ok: true, intent: "autosave-config" };
    }

    case "compute-full-sync-diff": {
      // Get active project
      const sessionStorage2 = createSessionStorage(env.SESSION_SECRET);
      const session2 = await sessionStorage2.getSession(request.headers.get("Cookie"));
      const sessionActiveId2 = session2.get("activeProjectId") as number | undefined;

      const allProjects2 = await db
        .select()
        .from(projects)
        .where(eq(projects.user_id, user.id));

      if (allProjects2.length === 0) {
        return { ok: false, intent: "compute-full-sync-diff", error: "no_project" };
      }

      const activeProject2 =
        allProjects2.find((p) => p.id === Number(sessionActiveId2)) ?? allProjects2[0];

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject2.github_repo_full_name.split("/");
        const diff = await computeFullSyncDiff(
          activeProject2.id,
          token,
          owner,
          repo,
          db,
          null,
        );
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
      // Get active project
      const sessionStorage3 = createSessionStorage(env.SESSION_SECRET);
      const session3 = await sessionStorage3.getSession(request.headers.get("Cookie"));
      const sessionActiveId3 = session3.get("activeProjectId") as number | undefined;

      const allProjects3 = await db
        .select()
        .from(projects)
        .where(eq(projects.user_id, user.id));

      if (allProjects3.length === 0) {
        return { ok: false, intent: "apply-full-sync", error: "no_project" };
      }

      const activeProject3 =
        allProjects3.find((p) => p.id === Number(sessionActiveId3)) ?? allProjects3[0];

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
        const [owner, repo] = activeProject3.github_repo_full_name.split("/");
        const result = await applyFullSyncChanges(
          activeProject3.id,
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

interface StoryItem {
  id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  private: boolean | null;
  draft: boolean | null;
  updated_at: string | null;
}

interface ObjectItem {
  id: number;
  object_id: string;
  title: string | null;
  creator: string | null;
  description: string | null;
  source: string | null;
  thumbnail: string | null;
  image_available: boolean | null;
  featured: boolean | null;
}

/** Per-object card that resolves IIIF thumbnails (same pattern as ObjectPickerDialog). */
function DashboardObjectCard({ obj, siteBaseUrl }: { obj: ObjectItem; siteBaseUrl: string | null }) {
  // For self-hosted objects without a stored thumbnail, resolve from info.json
  const needsResolve = !obj.thumbnail && obj.image_available && siteBaseUrl;
  const infoJsonUrl = needsResolve
    ? `${siteBaseUrl}/iiif/objects/${obj.object_id}/info.json`
    : null;
  const resolvedUrl = useIiifThumbnail(infoJsonUrl, 300);

  // Upscale stored IIIF thumbnails that are too small
  const storedThumb = obj.thumbnail
    ? obj.thumbnail.replace(/\/full\/[^/]+\//, "/full/!400,400/")
    : null;
  const thumbSrc = storedThumb || resolvedUrl;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow">
      <div className="aspect-square bg-cream-dark">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={obj.title ?? obj.object_id}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs font-body">
            No image
          </div>
        )}
      </div>
      <div className="p-2">
        <p className="font-body text-xs text-charcoal leading-snug">
          {obj.title ?? obj.object_id}
        </p>
        {obj.creator && (
          <p className="font-body text-[10px] text-gray-500 mt-0.5">{obj.creator}</p>
        )}
      </div>
    </div>
  );
}

/** Strip HTML tags from a string for plain-text display. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

export default function DashboardPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const fetcher = useFetcher();

  // Get headDiverged from parent app layout loader
  const appLoaderData = useRouteLoaderData("routes/_app") as { headDiverged?: boolean } | undefined;
  const headDiverged = appLoaderData?.headDiverged ?? false;

  const [syncModalOpen, setSyncModalOpen] = useState(false);

  if (!loaderData.hasProject) {
    return <EmptyState />;
  }

  const {
    project,
    allProjects,
    stories: loaderStories,
    storyStepCounts,
    storyCoverMap,
    unpublishedCount,
    config,
    landing,
    objects: projectObjects,
    siteBaseUrl,
  } = loaderData;

  // DnD order state (optimistic)
  const [items, setItems] = useState<number[]>(
    (loaderStories as StoryItem[]).map((s: StoryItem) => s.id)
  );
  const [activeId, setActiveId] = useState<number | null>(null);

  // Reset order when loader data changes (handles reorder failure rollback)
  useEffect(() => {
    setItems((loaderStories as StoryItem[]).map((s: StoryItem) => s.id));
  }, [loaderStories]);

  // Build a map for quick story lookup by id
  const storyMap: Record<number, StoryItem> = {};
  for (const s of loaderStories) {
    storyMap[s.id] = s;
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as number);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);

    if (!over || active.id === over.id) return;

    const oldIndex = items.indexOf(active.id as number);
    const newIndex = items.indexOf(over.id as number);
    const newOrder = arrayMove(items, oldIndex, newIndex);

    // Optimistic update
    setItems(newOrder);

    // Persist to server
    fetcher.submit(
      {
        intent: "reorder",
        order: JSON.stringify(newOrder),
        projectId: String(project.id),
      },
      { method: "post" }
    );
  }

  function handleSwitchProject(projectId: number) {
    fetcher.submit(
      {
        intent: "switch-project",
        projectId: String(projectId),
      },
      { method: "post" }
    );
  }

  const activeStory = activeId ? storyMap[activeId] : null;

  // Render stories in sorted order
  const sortedStories = items
    .map((id) => storyMap[id])
    .filter(Boolean) as StoryItem[];

  // Objects: featured first, then up to featured_count total
  const featuredCount = config?.featured_count ?? 4;
  const featuredObjects = (projectObjects as ObjectItem[]).filter((o) => o.featured);
  const nonFeaturedObjects = (projectObjects as ObjectItem[]).filter((o) => !o.featured);
  const displayObjects = [
    ...featuredObjects,
    ...nonFeaturedObjects,
  ].slice(0, featuredCount);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* H1 */}
      <h1 className="font-heading font-bold text-2xl text-charcoal">
        {t("page_title")}
      </h1>

      {/* Project status bar + Connect Repo */}
      <div className="flex items-start justify-between gap-4">
        <ProjectStatusBar
          repoName={project.github_repo_full_name}
          lastPublished={project.last_published_at ?? null}
          lastSynced={project.last_synced_at ?? null}
          unpublishedCount={unpublishedCount ?? 0}
          className="flex-1"
        />
        <div className="flex items-center gap-2">
          {headDiverged && (
            <button
              type="button"
              onClick={() => setSyncModalOpen(true)}
              className="inline-flex items-center gap-2 font-heading font-semibold text-sm uppercase tracking-wider bg-amber-500 hover:bg-amber-600 text-white rounded-full px-4 py-2 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              {t("sync_modal.sync_now")}
            </button>
          )}
          <ConnectRepoDropdown
            allProjects={allProjects}
            activeProjectId={project.id}
            onSwitch={handleSwitchProject}
          />
        </div>
      </div>

      {/* Sync confirmation modal */}
      <SyncConfirmModal
        open={syncModalOpen}
        unpublishedCount={unpublishedCount ?? 0}
        onClose={() => setSyncModalOpen(false)}
      />

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
                  href="https://telar.ucsb.edu"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                />
              ),
              docsLink: (
                <a
                  href="https://telar.ucsb.edu/docs"
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
        <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch gap-x-3">
          {([
            { n: 1, icon: Settings, to: "/config" },
            { n: 2, icon: Image, to: "/objects" },
            { n: 3, icon: BookOpen, to: "/stories" },
            { n: 4, icon: Upload, to: "/publish" },
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
              {i < 3 && (
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

      {/* Preview introduction */}
      <p className="font-body text-sm text-charcoal leading-relaxed">
        {t("preview_intro")}
      </p>

      {/* --- Site preview sections --- */}

      {/* 1. Site Description */}
      <DashboardPreviewSection
        heading={t("preview.site_description_heading")}
        explanation={t("preview.site_description_explanation")}
      >
        <div className="space-y-3">
          <div>
            <label className="block font-heading font-semibold text-xs text-gray-400 uppercase tracking-wider mb-1">
              Title
            </label>
            <InlineTextField
              initialValue={config?.title ?? ""}
              fieldName="title"
              entityId={project.id}
              intent="autosave-config"
              placeholder="Your site title"
              className="font-bold text-xl"
            />
          </div>
          <div>
            <label className="block font-heading font-semibold text-xs text-gray-400 uppercase tracking-wider mb-1">
              Description
            </label>
            <InlineTextArea
              initialValue={stripHtml(config?.description ?? "")}
              fieldName="description"
              entityId={project.id}
              intent="autosave-config"
              placeholder="A brief description of your site"
              className="text-sm text-gray-600"
            />
          </div>
        </div>
      </DashboardPreviewSection>

      {/* 2. Welcome Message */}
      <DashboardPreviewSection
        heading={t("preview.welcome_heading")}
        explanation={t("preview.welcome_explanation")}
      >
        <MarkdownEditor
          key={`welcome-${project.id}`}
          initialValue={landing?.welcome_body ?? ""}
          fieldName="welcome_body"
          projectId={project.id}
          intent="autosave-landing"
          objects={(projectObjects as ObjectItem[]).map((o) => ({
            object_id: o.object_id,
            title: o.title,
            thumbnail: o.thumbnail,
          }))}
        />
      </DashboardPreviewSection>

      {/* 3. Stories */}
      <DashboardPreviewSection
        heading={t("preview.stories_heading")}
        explanation={t("preview.stories_explanation")}
      >
        <div className="space-y-4">
          {/* Editable stories section heading */}
          <div>
            <InlineTextField
              initialValue={landing?.stories_heading ?? ""}
              fieldName="stories_heading"
              entityId={project.id}
              intent="autosave-landing"
              placeholder="Stories"
              className="font-heading font-bold text-xl"
            />
          </div>

          {/* Story grid with drag-to-reorder */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={items} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {sortedStories.map((story) => (
                  <SortableStoryCard
                    key={story.id}
                    story={story}
                    stepCount={storyStepCounts[story.id] ?? 0}
                    lastSynced={project.last_synced_at ?? null}
                    coverInfo={storyCoverMap[story.id]}
                    siteBaseUrl={siteBaseUrl}
                  />
                ))}
              </div>
            </SortableContext>

            <DragOverlay>
              {activeStory && (
                <StoryCard
                  story={activeStory}
                  stepCount={storyStepCounts[activeStory.id] ?? 0}
                  lastSynced={project.last_synced_at ?? null}
                  isDragOverlay
                  coverInfo={storyCoverMap[activeStory.id]}
                  siteBaseUrl={siteBaseUrl}
                />
              )}
            </DragOverlay>
          </DndContext>

          {/* Manage + New Story actions */}
          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <Link
              to="/stories"
              className="font-body text-sm text-periwinkle hover:text-periwinkle-hover transition-colors"
            >
              {t("preview.stories_manage")}
            </Link>
            <button
              type="button"
              onClick={() => navigate("/stories?new=true")}
              className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors"
            >
              {t("new_story_button")}
            </button>
          </div>
        </div>
      </DashboardPreviewSection>

      {/* 4. Objects */}
      <DashboardPreviewSection
        heading={t("preview.objects_heading")}
        explanation={t("preview.objects_explanation")}
      >
        <div className="space-y-3">
          {/* Editable objects section heading */}
          <InlineTextField
            initialValue={landing?.objects_heading ?? ""}
            fieldName="objects_heading"
            entityId={project.id}
            intent="autosave-landing"
            placeholder="Objects"
            className="font-heading font-bold text-xl"
          />
          {/* Editable objects intro */}
          <InlineTextArea
            initialValue={landing?.objects_intro ?? ""}
            fieldName="objects_intro"
            entityId={project.id}
            intent="autosave-landing"
            placeholder="Browse the objects in this collection"
            className="text-sm text-gray-600"
          />

          {/* Object cards grid — mirrors Telar landing page layout */}
          {displayObjects.length > 0 ? (
            <div className="grid grid-cols-3 md:grid-cols-5 gap-3 pt-2">
              {displayObjects.map((obj) => (
                <DashboardObjectCard key={obj.id} obj={obj} siteBaseUrl={siteBaseUrl} />
              ))}
            </div>
          ) : (
            <p className="font-body text-sm text-gray-400 italic pt-2">
              No objects yet — use the Objects tab to add images to your collection.
            </p>
          )}
        </div>
      </DashboardPreviewSection>
    </div>
  );
}

/**
 * Homepage tab — editable site preview for the active project.
 *
 * Relocated from _app.dashboard.tsx: all four DashboardPreviewSection blocks
 * (Site Description, Welcome Message, Stories showcase, Objects showcase).
 *
 * Loader: fetches project_config, project_landing, stories, objects, siteBaseUrl.
 * Action: handles autosave-landing, autosave-config, reorder intents.
 *
 * NOTE: The preview sections remain on _app.dashboard.tsx until a future cleanup
 * up the dashboard. This route duplicates them for now.
 */

import { asc, desc, eq, and, gt, inArray } from "drizzle-orm";
import { useTranslation } from "react-i18next";
import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { useState, useEffect } from "react";
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
import type { Route } from "./+types/_app.homepage";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { stories, steps, project_config, objects, project_landing } from "~/db/schema";
import { resolveActiveProject } from "~/lib/membership.server";
import { createSessionStorage } from "~/lib/session.server";
import { DashboardPreviewSection } from "~/components/features/dashboard/DashboardPreviewSection";
import { StoryCard } from "~/components/features/dashboard/StoryCard";
import { SortableStoryCard } from "~/components/features/dashboard/SortableStoryCard";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";
import { useIiifThumbnail } from "~/lib/use-iiif-thumbnail";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { getYText } from "~/lib/yjs-helpers";
import * as Y from "yjs";

export const handle = { i18n: ["common", "homepage", "dashboard", "editor"] };

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
    throw redirect("/onboarding");
  }
  const { project: activeProject } = resolved;

  const configRows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);
  const config = configRows[0] ?? null;

  const landingRows = await db
    .select()
    .from(project_landing)
    .where(eq(project_landing.project_id, activeProject.id))
    .limit(1);
  const landing = landingRows[0] ?? null;

  const projectStories = await db
    .select()
    .from(stories)
    .where(eq(stories.project_id, activeProject.id))
    .orderBy(asc(stories.order));

  const projectObjects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, activeProject.id));

  const siteBaseUrl = config?.url
    ? `${config.url}${config.baseurl ?? ""}`
    : null;

  // Resolve cover thumbnails for stories from their lowest content step's object
  const storyIds = projectStories.map((s) => s.id);
  const allContentSteps = storyIds.length > 0
    ? await db
        .select({ story_id: steps.story_id, step_number: steps.step_number, object_id: steps.object_id })
        .from(steps)
        .where(and(inArray(steps.story_id, storyIds), gt(steps.step_number, 0)))
        .orderBy(asc(steps.step_number))
    : [];

  const coverSteps: { story_id: number; object_id: string | null }[] = [];
  const seenStories = new Set<number>();
  for (const row of allContentSteps) {
    if (!seenStories.has(row.story_id)) {
      seenStories.add(row.story_id);
      coverSteps.push({ story_id: row.story_id, object_id: row.object_id });
    }
  }

  const storyCoverObjectIds: Record<number, string> = {};
  for (const row of coverSteps) {
    if (row.object_id) storyCoverObjectIds[row.story_id] = row.object_id;
  }

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

  const storyCoverMap: Record<number, { thumbnail: string | null; objectId: string; imageAvailable: boolean | null }> = {};
  for (const [storyIdStr, objectId] of Object.entries(storyCoverObjectIds)) {
    const storyId = Number(storyIdStr);
    const objInfo = objectThumbnailMap[objectId];
    if (objInfo) {
      storyCoverMap[storyId] = { thumbnail: objInfo.thumbnail, objectId, imageAvailable: objInfo.image_available };
    }
  }

  // Step counts per story (for StoryCard display)
  const stepCountRows = storyIds.length > 0
    ? await db
        .select({ story_id: steps.story_id, count: steps.id })
        .from(steps)
        .where(and(inArray(steps.story_id, storyIds), gt(steps.step_number, 0)))
    : [];

  const storyStepCounts: Record<number, number> = {};
  for (const row of stepCountRows) {
    storyStepCounts[row.story_id] = (storyStepCounts[row.story_id] ?? 0) + 1;
  }

  return {
    project: activeProject,
    config,
    landing,
    stories: projectStories,
    storyStepCounts,
    storyCoverMap,
    objects: projectObjects,
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
    case "autosave-landing": {
      const field = formData.get("field") as string;
      const value = formData.get("value") as string;
      const projectId = Number(formData.get("entityId") ?? formData.get("projectId"));
      const allowedFields = ["stories_heading", "stories_intro", "objects_heading", "objects_intro", "welcome_body"];
      if (!allowedFields.includes(field)) throw new Response("Bad request", { status: 400 });

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
      const projectId = Number(formData.get("entityId") ?? formData.get("projectId"));
      const allowedFields = ["title", "description"];
      if (!allowedFields.includes(field)) throw new Response("Bad request", { status: 400 });

      await db
        .update(project_config)
        .set({ [field]: value, updated_at: new Date().toISOString() })
        .where(eq(project_config.project_id, projectId));

      return { ok: true, intent: "autosave-config" };
    }

    case "reorder": {
      const orderJson = formData.get("order") as string;
      const projectId = Number(formData.get("projectId"));
      const order: number[] = JSON.parse(orderJson);

      const projectStories = await db
        .select({ id: stories.id })
        .from(stories)
        .where(and(eq(stories.project_id, projectId), inArray(stories.id, order)));

      const ownedIds = new Set(projectStories.map((s) => s.id));
      const now = new Date().toISOString();

      await Promise.all(
        order
          .filter((id) => ownedIds.has(id))
          .map((id, idx) =>
            db.update(stories)
              .set({ order: idx, updated_at: now })
              .where(eq(stories.id, id))
          )
      );

      return { ok: true, intent: "reorder" };
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

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

/** Per-object card that resolves IIIF thumbnails. */
function HomepageObjectCard({ obj, siteBaseUrl }: { obj: ObjectItem; siteBaseUrl: string | null }) {
  const needsResolve = !obj.thumbnail && obj.image_available && siteBaseUrl;
  const infoJsonUrl = needsResolve
    ? `${siteBaseUrl}/iiif/objects/${obj.object_id}/info.json`
    : null;
  const resolvedUrl = useIiifThumbnail(infoJsonUrl, 300);

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HomepagePage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const { ydoc } = useCollaborationContext();

  // Resolve Y.Text for config fields (title, description) and landing fields
  const configYMap = ydoc?.getMap<unknown>("config") ?? null;
  const landingYMap = configYMap?.get("landing") instanceof Y.Map
    ? (configYMap.get("landing") as Y.Map<unknown>)
    : null;
  const configTitleYText = getYText(configYMap as Y.Map<unknown> | null, "title");
  const configDescriptionYText = getYText(configYMap as Y.Map<unknown> | null, "description");
  const storiesHeadingYText = getYText(landingYMap, "stories_heading");
  const objectsHeadingYText = getYText(landingYMap, "objects_heading");
  const objectsIntroYText = getYText(landingYMap, "objects_intro");

  const {
    project,
    config,
    landing,
    stories: loaderStories,
    storyStepCounts,
    storyCoverMap,
    objects: projectObjects,
    siteBaseUrl,
  } = loaderData;

  // DnD order state (optimistic)
  const [items, setItems] = useState<number[]>(
    (loaderStories as StoryItem[]).map((s: StoryItem) => s.id)
  );
  const [activeId, setActiveId] = useState<number | null>(null);

  useEffect(() => {
    setItems((loaderStories as StoryItem[]).map((s: StoryItem) => s.id));
  }, [loaderStories]);

  const storyMap: Record<number, StoryItem> = {};
  for (const s of loaderStories) {
    storyMap[s.id] = s;
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
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

    setItems(newOrder);
    fetcher.submit(
      { intent: "reorder", order: JSON.stringify(newOrder), projectId: String(project.id) },
      { method: "post" }
    );
  }

  const activeStory = activeId ? storyMap[activeId] : null;
  const sortedStories = items.map((id) => storyMap[id]).filter(Boolean) as StoryItem[];

  const featuredCount = config?.featured_count ?? 4;
  const featuredObjects = (projectObjects as ObjectItem[]).filter((o) => o.featured);
  const nonFeaturedObjects = (projectObjects as ObjectItem[]).filter((o) => !o.featured);
  const displayObjects = [...featuredObjects, ...nonFeaturedObjects].slice(0, featuredCount);

  return (
    <div className="max-w-6xl mx-auto space-y-6">

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
              yText={configTitleYText}
              placeholder="Your site title"
              className="font-bold text-xl"
              fieldKey="homepage-config-title"
            />
          </div>
          <div>
            <label className="block font-heading font-semibold text-xs text-gray-400 uppercase tracking-wider mb-1">
              Description
            </label>
            <InlineTextArea
              initialValue={stripHtml(config?.description ?? "")}
              yText={configDescriptionYText}
              placeholder="A brief description of your site"
              className="text-sm text-gray-600"
              fieldKey="homepage-config-description"
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
          <div>
            <InlineTextField
              initialValue={landing?.stories_heading ?? ""}
              yText={storiesHeadingYText}
              placeholder="Stories"
              className="font-heading font-bold text-xl"
              fieldKey="homepage-stories-heading"
            />
          </div>

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

          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <a
              href="/stories"
              className="font-body text-sm text-periwinkle hover:text-periwinkle-hover transition-colors"
            >
              {t("preview.stories_manage")}
            </a>
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
          <InlineTextField
            initialValue={landing?.objects_heading ?? ""}
            yText={objectsHeadingYText}
            placeholder="Objects"
            className="font-heading font-bold text-xl"
            fieldKey="homepage-objects-heading"
          />
          <InlineTextArea
            initialValue={landing?.objects_intro ?? ""}
            yText={objectsIntroYText}
            placeholder="Browse the objects in this collection"
            className="text-sm text-gray-600"
            fieldKey="homepage-objects-intro"
          />

          {displayObjects.length > 0 ? (
            <div className="grid grid-cols-3 md:grid-cols-5 gap-3 pt-2">
              {displayObjects.map((obj) => (
                <HomepageObjectCard key={obj.id} obj={obj} siteBaseUrl={siteBaseUrl} />
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

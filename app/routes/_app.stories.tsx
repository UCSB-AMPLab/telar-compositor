/**
 * Stories — full story management list view.
 *
 * Loader: fetches the active project's stories ordered by `order` ASC,
 *         plus step counts per story. Passes `showNewForm` if ?new=true.
 * Action: handles five intents — reorder, create-story, delete-story,
 *         toggle-draft, toggle-private.
 * Component: vertical dnd-kit list with drag handles, inline creation form,
 *            delete confirmation dialog, and draft/private Switch toggles.
 */

import { asc, count, desc, eq, and, gt, inArray } from "drizzle-orm";
import { useTranslation } from "react-i18next";
import { redirect, useFetcher, useLoaderData } from "react-router";
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
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import type { Route } from "./+types/_app.stories";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, stories, steps, layers } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { slugify, generateUniqueSlug } from "~/lib/slugify";
import { StoryRow } from "~/components/features/stories/StoryRow";
import { SortableStoryRow } from "~/components/features/stories/SortableStoryRow";
import { NewStoryForm } from "~/components/features/stories/NewStoryForm";
import { StoriesEmptyState } from "~/components/features/stories/StoriesEmptyState";

export const handle = { i18n: ["common", "stories"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Read activeProjectId from session (same pattern as dashboard)
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  // Fetch all user projects to find the active one
  const allProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.user_id, user.id));

  if (allProjects.length === 0) {
    return redirect("/dashboard");
  }

  const activeProject =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

  // Fetch stories ordered by `order` ASC
  const projectStories = await db
    .select()
    .from(stories)
    .where(eq(stories.project_id, activeProject.id))
    .orderBy(asc(stories.order));

  // Step counts per story
  // Count only content steps (step_number > 0), excluding the title card row
  const stepCountRows = await db
    .select({ story_id: steps.story_id, count: count() })
    .from(steps)
    .where(gt(steps.step_number, 0))
    .groupBy(steps.story_id);

  const storyStepCounts: Record<number, number> = {};
  for (const row of stepCountRows) {
    storyStepCounts[row.story_id] = row.count;
  }

  // Check URL search params for ?new=true
  const url = new URL(request.url);
  const showNewForm = url.searchParams.get("new") === "true";

  return {
    project: activeProject,
    stories: projectStories,
    storyStepCounts,
    showNewForm,
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

    case "create-story": {
      const title = (formData.get("title") as string).trim();
      const subtitle = (formData.get("subtitle") as string | null)?.trim() || undefined;
      const byline = (formData.get("byline") as string | null)?.trim() || undefined;
      const projectId = Number(formData.get("projectId"));

      const baseSlug = slugify(title) || `story-${Date.now()}`;
      const storyId = await generateUniqueSlug(baseSlug, projectId, db);

      // Compute next order
      const existing = await db
        .select({ order: stories.order })
        .from(stories)
        .where(eq(stories.project_id, projectId))
        .orderBy(desc(stories.order))
        .limit(1);

      const nextOrder = (existing[0]?.order ?? -1) + 1;

      const inserted = await db
        .insert(stories)
        .values({
          project_id: projectId,
          story_id: storyId,
          title,
          subtitle,
          byline,
          order: nextOrder,
        })
        .returning();

      const newStory = inserted[0];

      // Auto-create Step 0
      await db.insert(steps).values({
        story_id: newStory.id,
        step_number: 0,
      });

      return { ok: true, intent: "create-story", storyId };
    }

    case "delete-story": {
      const storyDbId = Number(formData.get("storyDbId"));

      // Find all steps for this story
      const storySteps = await db
        .select({ id: steps.id })
        .from(steps)
        .where(eq(steps.story_id, storyDbId));

      if (storySteps.length > 0) {
        const stepIds = storySteps.map((s) => s.id);
        // Delete layers first (cascade)
        await db.delete(layers).where(inArray(layers.step_id, stepIds));
        // Delete steps
        await db.delete(steps).where(eq(steps.story_id, storyDbId));
      }

      // Delete the story itself
      await db.delete(stories).where(eq(stories.id, storyDbId));

      return { ok: true, intent: "delete-story" };
    }

    case "toggle-draft": {
      const storyDbId = Number(formData.get("storyDbId"));
      const currentValue = formData.get("currentValue") === "true";
      await db
        .update(stories)
        .set({ draft: !currentValue, updated_at: new Date().toISOString() })
        .where(eq(stories.id, storyDbId));
      return { ok: true, intent: "toggle-draft" };
    }

    case "toggle-private": {
      const storyDbId = Number(formData.get("storyDbId"));
      const currentValue = formData.get("currentValue") === "true";
      await db
        .update(stories)
        .set({ private: !currentValue, updated_at: new Date().toISOString() })
        .where(eq(stories.id, storyDbId));
      return { ok: true, intent: "toggle-private" };
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

export default function StoriesPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("stories");
  const fetcher = useFetcher();

  const { project, stories: loaderStories, storyStepCounts, showNewForm } = loaderData;

  // DnD order state (optimistic)
  const [items, setItems] = useState<number[]>(
    (loaderStories as StoryItem[]).map((s: StoryItem) => s.id)
  );
  const [activeId, setActiveId] = useState<number | null>(null);
  const [showNewCard, setShowNewCard] = useState(showNewForm);

  // Reset order when loader data changes (handles reorder failure rollback)
  useEffect(() => {
    setItems((loaderStories as StoryItem[]).map((s: StoryItem) => s.id));
  }, [loaderStories]);

  // Auto-open new story form if ?new=true was in the URL
  useEffect(() => {
    if (showNewForm) setShowNewCard(true);
  }, [showNewForm]);

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

  function handleCreateStory(title: string, subtitle: string, byline: string) {
    setShowNewCard(false);
    fetcher.submit(
      {
        intent: "create-story",
        title,
        subtitle,
        byline,
        projectId: String(project.id),
      },
      { method: "post" }
    );
  }

  function handleDeleteStory(story: StoryItem) {
    fetcher.submit(
      {
        intent: "delete-story",
        storyDbId: String(story.id),
      },
      { method: "post" }
    );
  }

  function handleToggleDraft(story: StoryItem) {
    fetcher.submit(
      {
        intent: "toggle-draft",
        storyDbId: String(story.id),
        currentValue: String(story.draft ?? false),
      },
      { method: "post" }
    );
  }

  function handleTogglePrivate(story: StoryItem) {
    fetcher.submit(
      {
        intent: "toggle-private",
        storyDbId: String(story.id),
        currentValue: String(story.private ?? false),
      },
      { method: "post" }
    );
  }

  const activeStory = activeId ? storyMap[activeId] : null;

  // Render stories in sorted order
  const sortedStories = items
    .map((id) => storyMap[id])
    .filter(Boolean) as StoryItem[];

  const hasStories = sortedStories.length > 0;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-2">
        <h1 className="font-heading font-bold text-2xl text-charcoal">
          {t("title")}
        </h1>
        <button
          type="button"
          onClick={() => setShowNewCard(true)}
          className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors"
        >
          {t("new_story_button")}
        </button>
      </div>

      {/* Drag hint */}
      <p className="font-body text-sm text-gray-500 mb-6">{t("hint")}</p>

      {/* Inline new story form */}
      {showNewCard && (
        <NewStoryForm
          onSave={handleCreateStory}
          onCancel={() => setShowNewCard(false)}
        />
      )}

      {/* Stories list or empty state */}
      {!hasStories && !showNewCard ? (
        <StoriesEmptyState onCreateNew={() => setShowNewCard(true)} />
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={items} strategy={verticalListSortingStrategy}>
              {sortedStories.map((story, index) => (
                <SortableStoryRow
                  key={story.id}
                  story={story}
                  index={index}
                  stepCount={storyStepCounts[story.id] ?? 0}
                  onDelete={handleDeleteStory}
                  onToggleDraft={handleToggleDraft}
                  onTogglePrivate={handleTogglePrivate}
                />
              ))}
            </SortableContext>

            <DragOverlay>
              {activeStory && (
                <StoryRow
                  story={activeStory}
                  index={sortedStories.findIndex((s) => s.id === activeStory.id)}
                  stepCount={storyStepCounts[activeStory.id] ?? 0}
                  onDelete={() => {}}
                  onToggleDraft={() => {}}
                  onTogglePrivate={() => {}}
                  isDragOverlay
                />
              )}
            </DragOverlay>
          </DndContext>
        </div>
      )}
    </div>
  );
}

/**
 * This file is the Stories route — the full story management list
 * view, where the user browses every story in their project and
 * launches the per-story editor by clicking a row.
 *
 * Loader fetches the active project's stories ordered by `order` ASC,
 * plus step counts per story, team members (for delete-confirmation
 * contributor warnings), and the viewer's role. Action handles
 * `toggle-draft`, `toggle-private`, and `flush-yjs-snapshot` (an eager
 * Durable Object to D1 snapshot before navigating to a freshly-created
 * story). Structural ops (`create-story`, `delete-story`, `reorder`) are
 * migrated to Yjs via `useStructuralOps` — see `workers/collaboration.ts`
 * `snapshotToD1`.
 *
 * Renders a vertical dnd-kit list with drag handles, an inline
 * creation form, a delete-confirmation modal, and draft/private
 * Switch toggles. When a Y.Doc is available, the page reads stories
 * from the Y.Array so remote collaborators' changes appear in real
 * time; it falls back to loader data during SSR or pre-connection.
 *
 * @version v1.4.2-beta
 */

import { and, asc, count, eq, gt } from "drizzle-orm";
import { useTranslation } from "react-i18next";
import { redirect, useFetcher, useNavigate, useOutletContext } from "react-router";
import { useState, useEffect, useRef, useMemo } from "react";
import * as Y from "yjs";
import { DndContext, closestCenter, DragOverlay } from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useSortableSensors } from "~/hooks/use-sortable-sensors";
import type { Route } from "./+types/_app.stories";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { keyFor } from "~/lib/item-key";
import { stories, steps, project_members, users } from "~/db/schema";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { slugify } from "~/lib/slugify";
import { StoryRow } from "~/components/features/stories/StoryRow";
import { SortableStoryRow } from "~/components/features/stories/SortableStoryRow";
import { NewStoryForm } from "~/components/features/stories/NewStoryForm";
import { StoriesEmptyState } from "~/components/features/stories/StoriesEmptyState";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { DocsLink } from "~/components/ui/DocsLink";
import { useCollaborationContext, FALLBACK_HIGHLIGHT_COLOR } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { makeUniqueSlug } from "~/lib/slug";
import { useYjsArraySync } from "~/hooks/use-yjs-array-sync";
import { useRemoteDeleteToast } from "~/hooks/use-remote-delete-toast";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";

export const handle = { i18n: ["common", "stories", "structural"] };

/**
 * Parse a stored `project_members.contributions` JSON blob, tolerating a
 * malformed value. A raw SyntaxError here would escape the loader and break
 * the whole stories-page render, so a bad blob degrades to null (no
 * contributor warning) rather than a 500.
 */
function parseContributions(raw: string | null): Member["contributions"] {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    return redirect("/dashboard");
  }
  const { project: activeProject, userRole } = resolved;

  // Fetch stories ordered by `order` ASC
  const projectStories = await db
    .select()
    .from(stories)
    .where(eq(stories.project_id, activeProject.id))
    .orderBy(asc(stories.order));

  // Fetch team members (for delete-confirmation contributor warning)
  const memberRows = await db
    .select({
      userId: project_members.user_id,
      name: users.github_name,
      login: users.github_login,
      contributions: project_members.contributions,
    })
    .from(project_members)
    .innerJoin(users, eq(project_members.user_id, users.id))
    .where(eq(project_members.project_id, activeProject.id));

  const members = memberRows.map((m) => ({
    userId: m.userId,
    name: m.name || m.login,
    // Guard the stored-JSON parse: a malformed `contributions` value (partial
    // write, manual edit) must not throw a raw SyntaxError out of the loader
    // and 500 the whole page. Fall back to null, as the publish loader does.
    contributions: parseContributions(m.contributions),
  }));

  // Step counts per story
  // Count only content steps (step_number > 0), excluding the title card row.
  // `steps` carries no project_id, so scope to the active project by joining
  // through `stories` — otherwise this aggregates every project's steps.
  const stepCountRows = await db
    .select({ story_id: steps.story_id, count: count() })
    .from(steps)
    .innerJoin(stories, eq(steps.story_id, stories.id))
    .where(and(eq(stories.project_id, activeProject.id), gt(steps.step_number, 0)))
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
    members,
    currentUserId: user.id,
    userRole,
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
    // Structural ops (create-story, delete-story, reorder) migrated to Yjs —
    // see app/hooks/use-structural-ops.ts and workers/collaboration.ts
    // snapshotToD1. Legacy intents are no longer handled here.

    case "toggle-draft": {
      const storyDbId = Number(formData.get("storyDbId"));
      const currentValue = formData.get("currentValue") === "true";
      const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolved) return { ok: false, intent: "toggle-draft", error: "no_project" };
      await db
        .update(stories)
        .set({ draft: !currentValue, updated_at: new Date().toISOString() })
        .where(and(eq(stories.id, storyDbId), eq(stories.project_id, resolved.project.id)));
      return { ok: true, intent: "toggle-draft" };
    }

    case "toggle-private": {
      const storyDbId = Number(formData.get("storyDbId"));
      const currentValue = formData.get("currentValue") === "true";
      const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolved) return { ok: false, intent: "toggle-private", error: "no_project" };
      await db
        .update(stories)
        .set({ private: !currentValue, updated_at: new Date().toISOString() })
        .where(and(eq(stories.id, storyDbId), eq(stories.project_id, resolved.project.id)));
      return { ok: true, intent: "toggle-private" };
    }

    case "flush-yjs-snapshot": {
      // Eager DO -> D1 snapshot before the client navigates to a
      // freshly-created story. Closes the race where the editor loader reads
      // D1 before the debounced `snapshotToD1` has flushed and 404s.
      //
      // Soft-error posture: on failure return ok:false but
      // do NOT throw. The client still navigates — the story exists in
      // Yjs, and the 30s alarm-driven snapshot is the eventual safety net.
      try {
        const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
        if (!resolved) {
          return { ok: false, intent: "flush-yjs-snapshot", error: "snapshot_failed" };
        }
        const { project: activeProject } = resolved;

        const doId = env.COLLABORATION.idFromName(String(activeProject.id));
        const doStub = env.COLLABORATION.get(doId);
        const headers = await makeInternalMarkerHeaders(
          activeProject.id,
          env.SESSION_SECRET,
          "snapshot",
        );
        const snapshotReq = new Request(`https://internal/snapshot`, {
          method: "POST",
          headers,
        });
        const snapshotRes = await doStub.fetch(snapshotReq);
        if (!snapshotRes.ok) {
          return { ok: false, intent: "flush-yjs-snapshot", error: "snapshot_failed" };
        }
        return { ok: true, intent: "flush-yjs-snapshot" };
      } catch {
        return { ok: false, intent: "flush-yjs-snapshot", error: "snapshot_failed" };
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
  /** Y.Map sentinel: null when the item has not yet been backfilled to D1. */
  _tempId?: string | null;
  /** Y.Map sentinel: the user id that created this item (used for delete permissions). */
  _createdBy?: number | null;
  /** Index in the Y.Array (used for reorder). */
  _yIndex?: number;
  /** Reference to the backing Y.Map — used for canDelete and deleteStory. */
  _yMap?: Y.Map<unknown> | null;
  /** Step count read from the Y.Map's nested steps Y.Array (Yjs mode only). */
  _yStepCount?: number;
}

interface Member {
  userId: number;
  name: string;
  contributions: {
    stories_edited?: number[];
    objects_edited?: number[];
    fields_edited?: number;
    sessions?: number;
  } | null;
}

/**
 * Read a scalar field from a Y.Map, unwrapping Y.Text if necessary.
 * Returns null for missing keys and empty-string Y.Text values.
 */
function readScalar(yMap: Y.Map<unknown>, key: string): string | null {
  const val = yMap.get(key);
  if (val === null || val === undefined) return null;
  if (val instanceof Y.Text) {
    const s = val.toString();
    return s.length === 0 ? null : s;
  }
  return typeof val === "string" ? (val.length === 0 ? null : val) : null;
}

/**
 * Convert a Y.Map for a story into a StoryItem suitable for the UI.
 * Handles the _id: null / _temp_id sentinel for newly-created stories.
 */
function yMapToStoryItem(yMap: Y.Map<unknown>, yIndex: number): StoryItem {
  const id = (yMap.get("_id") as number | null) ?? 0;
  const tempId = (yMap.get("_temp_id") as string | null) ?? null;
  const createdBy = (yMap.get("created_by") as number | null) ?? null;
  const stepsArr = yMap.get("steps");
  const stepCount =
    stepsArr instanceof Y.Array ? (stepsArr as Y.Array<unknown>).length : 0;

  return {
    id,
    story_id: (yMap.get("story_id") as string) ?? "",
    title: readScalar(yMap, "title"),
    subtitle: readScalar(yMap, "subtitle"),
    byline: readScalar(yMap, "byline"),
    private: Boolean(yMap.get("private") ?? false),
    draft: Boolean(yMap.get("draft") ?? false),
    updated_at: null,
    _tempId: tempId,
    _createdBy: createdBy,
    _yIndex: yIndex,
    _yMap: yMap,
    _yStepCount: stepCount,
  };
}

/**
 * Compute the list of contributor names for a story's delete confirmation
 * modal. Uses contribution data (stories_edited per member).
 *
 * For freshly-added stories (no D1 id yet), only the creator is shown.
 * The creator themselves is always excluded from the contributor list
 * (the warning is about "other" team members).
 */
function computeContributors(
  storyDbId: number,
  creatorId: number | null,
  currentUserId: number,
  members: Member[]
): string[] {
  const names = new Set<string>();
  if (storyDbId > 0) {
    for (const m of members) {
      if (m.userId === currentUserId) continue;
      const edited = m.contributions?.stories_edited ?? [];
      if (edited.includes(storyDbId)) names.add(m.name);
    }
  }
  // Include the creator if they are not the current user and not already listed
  if (creatorId && creatorId !== currentUserId) {
    const creator = members.find((m) => m.userId === creatorId);
    if (creator) names.add(creator.name);
  }
  return Array.from(names);
}

export default function StoriesPage({ loaderData }: Route.ComponentProps) {
  const { openDoc } = useOutletContext<{ openDoc?: (id: string) => void }>() ?? {};
  const { t } = useTranslation("stories");
  const { t: tStructural } = useTranslation("structural");
  const fetcher = useFetcher();
  // Dedicated fetcher for the eager DO->D1 snapshot flush after
  // a new story is added to Yjs. Kept separate from `fetcher` so the
  // existing intents (toggle-draft, toggle-private) are not affected by
  // the flush state-machine.
  const flushFetcher = useFetcher<{ ok: boolean; intent: string; error?: string }>();
  const navigate = useNavigate();
  // Story id we are waiting to navigate to once the flush completes.
  // Cleared as soon as the navigate fires.
  const [pendingNavigate, setPendingNavigate] = useState<string | null>(null);

  const {
    project,
    stories: loaderStories,
    storyStepCounts,
    showNewForm,
    members,
    currentUserId,
    userRole,
  } = loaderData;

  const { ydoc, remoteCollaborators } = useCollaborationContext();
  const ops = useStructuralOps(currentUserId, userRole);

  // ------------------------------------------------------------------
  // Source of truth: Yjs when available, loader data otherwise
  // ------------------------------------------------------------------
  const yjsStories = useYjsArraySync(
    ydoc ? ydoc.getArray<Y.Map<unknown>>("stories") : null,
    yMapToStoryItem,
  );

  const useYjs = ydoc !== null && ops !== null && yjsStories !== null;
  const displayStories: StoryItem[] = useYjs
    ? yjsStories!
    : (loaderStories as StoryItem[]);

  // Stable dnd-kit identifier for each row — see `app/lib/item-key.ts` for
  // why `_tempId` must win over numeric `id`. Previously inlined here with the
  // `id`-first ordering, which produced a key flip when snapshotToD1
  // backfilled the row id and tripped the remote-delete detection observer,
  // firing a false "story was deleted" toast on new-story creation. Closed
  // alongside the same fix for pages.

  const [activeId, setActiveId] = useState<string | number | null>(null);
  const [showNewCard, setShowNewCard] = useState(showNewForm);

  useEffect(() => {
    if (showNewForm) setShowNewCard(true);
  }, [showNewForm]);

  const sensors = useSortableSensors();

  // ------------------------------------------------------------------
  // Delete confirmation modal state
  // ------------------------------------------------------------------
  const [deleteTarget, setDeleteTarget] = useState<{
    story: StoryItem;
    contentSummary: string;
    contributors: string[];
  } | null>(null);

  function openDeleteModalFor(story: StoryItem) {
    const stepCount = useYjs
      ? story._yStepCount ?? 0
      : storyStepCounts[story.id] ?? 0;
    const summary = tStructural(
      stepCount === 1 ? "summary_steps_one" : "summary_steps",
      { count: stepCount }
    );
    const contributors = computeContributors(
      story.id,
      story._createdBy ?? null,
      currentUserId,
      members as Member[]
    );
    setDeleteTarget({ story, contentSummary: summary, contributors });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const { story } = deleteTarget;
    if (useYjs) {
      ops!.deleteStory(story.id > 0 ? story.id : null, story._tempId ?? null);
    } else {
      // D1 fallback is no longer wired — structural ops migrated to Yjs.
      // This path is reached only when the collaboration socket is not yet
      // available; log and fall through without destroying any data.
      // eslint-disable-next-line no-console
      console.warn("[stories] delete requested without active ydoc; ignored");
    }
    setDeleteTarget(null);
  }

  // ------------------------------------------------------------------
  // Animations (highlight, fade) — Yjs mode only
  // ------------------------------------------------------------------
  const seenKeysRef = useRef<Set<string>>(new Set());
  const [highlightedKeys, setHighlightedKeys] = useState<Record<string, string>>(
    {}
  );

  useEffect(() => {
    if (!useYjs) return;
    const next = new Set<string>();
    const newly: string[] = [];
    for (const s of displayStories) {
      const k = String(keyFor(s));
      next.add(k);
      if (!seenKeysRef.current.has(k)) newly.push(k);
    }
    // Do not highlight on initial mount — populate the seen set silently.
    if (seenKeysRef.current.size === 0) {
      seenKeysRef.current = next;
      return;
    }
    seenKeysRef.current = next;
    if (newly.length === 0) return;

    // Pick a colour from the first remote collaborator present, fallback to
    // the shared lavender highlight token.
    const colour =
      remoteCollaborators[0]?.user.color ?? FALLBACK_HIGHLIGHT_COLOR;
    setHighlightedKeys((prev) => {
      const merged = { ...prev };
      for (const k of newly) merged[k] = colour;
      return merged;
    });
    const timer = setTimeout(() => {
      setHighlightedKeys((prev) => {
        const next = { ...prev };
        for (const k of newly) delete next[k];
        return next;
      });
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayStories, useYjs]);

  // Belt-and-braces guard for the remote-delete toast during a reorder. The
  // reorder replaces the moved item with a fresh Y.Map (cloneYMap in
  // use-structural-ops), but that clone copies every entry — including
  // `_temp_id` and `_id` — so keyFor still resolves to the same key and the
  // swap reads as a move, never a deletion. This flag predates the shared
  // tempId-first keying, back when the reorder DID churn the key and fire a
  // false toast; it is retained as a cheap safety net, not because the
  // detection would misfire under the current keying.
  const reorderingRef = useRef(false);

  // Remote-delete toast — fires when a story disappears from the Y.Array
  // because a peer removed it. Shared logic in useRemoteDeleteToast. The
  // stories-list page is the parent list, so no redirect is needed; the story
  // editor handles the nested redirect case.
  useRemoteDeleteToast({
    items: displayStories,
    enabled: useYjs,
    getLabel: (s) => s.title ?? s.story_id,
    suppressRef: reorderingRef,
  });

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------
  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string | number);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;

    const keys = displayStories.map((s) => keyFor(s));
    const oldIndex = keys.findIndex((k) => k === active.id);
    const newIndex = keys.findIndex((k) => k === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    if (useYjs) {
      reorderingRef.current = true;
      ops!.reorderStories(oldIndex, newIndex);
      // Clear after a tick so the effect sees the flag
      setTimeout(() => { reorderingRef.current = false; }, 100);
      return;
    }
    // Reorder is a Yjs-only operation; before the collaboration socket
    // connects there is no canonical order to mutate, so the drag is a no-op.
  }

  function handleCreateStory(title: string, subtitle: string, byline: string) {
    setShowNewCard(false);
    if (useYjs) {
      // Prefer a clean, suffix-free story_id (e.g. "the-river") so the story's
      // editor and published URLs stay readable for the story's whole life. A
      // numeric -2/-3 suffix is appended only on an actual collision with an
      // existing story_id, matching how pages, objects, and glossary terms
      // dedupe. `displayStories` is the authoritative Y.Array-backed list in
      // this branch and carries every story's story_id, so it is the live
      // collision set; makeUniqueSlug probes `${base}-2`, `-3`, … against that
      // same set, so the fallback can't itself collide.
      //
      // Accepted race: two clients creating the same title simultaneously —
      // before Yjs has synced the first one's row into the other's Y.Array —
      // can both land on the same clean story_id, because each probe only sees
      // its own local view and snapshotToD1 enforces no uniqueness on write.
      // This rare collision was deliberately accepted in exchange for clean
      // URLs; the previous scheme spent a permanent 4-char suffix on every URL
      // to guard against a case that essentially never happens.
      const existingIds = new Set(
        displayStories.map((s) => s.story_id).filter(Boolean),
      );
      const baseSlug = slugify(title) || "story";
      const { slug: storyId } = makeUniqueSlug(baseSlug, existingIds);
      // Seed the subtitle and byline the user typed in the creation form; both
      // stay editable inline on the story editor afterwards.
      ops!.addStory(title, storyId, subtitle, byline);

      // Trigger an eager DO->D1 snapshot flush, then navigate to
      // the new story's editor. The post-flush navigate fires from the
      // useEffect below, which observes `flushFetcher.state === "idle"` and
      // a non-null `pendingNavigate`. Closes the race where the editor
      // loader queries D1 before the debounced snapshotToD1 has flushed.
      setPendingNavigate(storyId);
      flushFetcher.submit(
        { intent: "flush-yjs-snapshot" },
        { method: "post" },
      );
      return;
    }
    // Not used — D1 create path removed. Log for visibility.
    // eslint-disable-next-line no-console
    console.warn("[stories] create requested without active ydoc; ignored");
  }

  // Post-flush navigate. Fires once the flushFetcher reaches
  // idle with the matching intent in its data. Navigation proceeds even
  // when `data.ok === false` — soft-error (the story is
  // in Yjs; the 30s alarm-driven snapshot is the eventual safety net).
  useEffect(() => {
    if (!pendingNavigate) return;
    if (flushFetcher.state !== "idle") return;
    if (flushFetcher.data?.intent !== "flush-yjs-snapshot") return;
    const target = pendingNavigate;
    setPendingNavigate(null);
    navigate(`/stories/${target}`);
  }, [flushFetcher.state, flushFetcher.data, pendingNavigate, navigate]);

  function handleDeleteStory(story: StoryItem) {
    // canDelete short-circuits before this runs, but belt-and-braces:
    if (useYjs && story._yMap && !ops!.canDelete(story._yMap)) return;
    openDeleteModalFor(story);
  }

  function handleToggleDraft(story: StoryItem) {
    // Y.Doc is the source of truth in collaborative mode; snapshotToD1
    // reconciles. The D1-only fetcher would be clobbered.
    if (useYjs && ydoc && story._yMap) {
      const storyYMap = story._yMap;
      ydoc.transact(() => {
        storyYMap.set("draft", !(story.draft ?? false));
      });
      return;
    }
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
    if (useYjs && ydoc && story._yMap) {
      const storyYMap = story._yMap;
      ydoc.transact(() => {
        storyYMap.set("private", !(story.private ?? false));
      });
      return;
    }
    fetcher.submit(
      {
        intent: "toggle-private",
        storyDbId: String(story.id),
        currentValue: String(story.private ?? false),
      },
      { method: "post" }
    );
  }

  const storyByKey = useMemo(() => {
    const map = new Map<string, StoryItem>();
    for (const s of displayStories) map.set(String(keyFor(s)), s);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayStories]);

  const activeStory =
    activeId !== null ? storyByKey.get(String(activeId)) ?? null : null;

  const sortableIds: (string | number)[] = displayStories.map((s) => keyFor(s));

  const hasStories = displayStories.length > 0;

  return (
    <div className="max-w-7xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-4">
          <h1 className="font-heading font-bold text-2xl text-charcoal">
            {t("title")}
          </h1>
          {openDoc && <DocsLink docId="stories" onOpenDoc={openDoc} />}
        </div>
        <button
          type="button"
          onClick={() => setShowNewCard(true)}
          className="inline-flex items-center justify-center bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors"
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
            <SortableContext
              items={sortableIds}
              strategy={verticalListSortingStrategy}
            >
              {displayStories.map((story, index) => {
                const key = String(keyFor(story));
                const highlightColor = highlightedKeys[key];
                const stepCount = useYjs
                  ? story._yStepCount ?? 0
                  : storyStepCounts[story.id] ?? 0;
                const canDelete = useYjs
                  ? story._yMap
                    ? ops!.canDelete(story._yMap)
                    : userRole === "convenor"
                  : true;
                return (
                  <SortableStoryRow
                    key={key}
                    sortableId={keyFor(story)}
                    story={story}
                    index={index}
                    stepCount={stepCount}
                    onDelete={handleDeleteStory}
                    onToggleDraft={handleToggleDraft}
                    onTogglePrivate={handleTogglePrivate}
                    canDelete={canDelete}
                    deleteTooltip={tStructural("tooltip_cannot_delete")}
                    skipInternalConfirm={useYjs}
                    rowClassName={
                      highlightColor ? "structural-highlight" : undefined
                    }
                    rowStyle={
                      highlightColor
                        ? ({
                            ["--structural-highlight-color" as never]: highlightColor,
                          } as React.CSSProperties)
                        : undefined
                    }
                  />
                );
              })}
            </SortableContext>

            <DragOverlay>
              {activeStory && (
                <StoryRow
                  story={activeStory}
                  index={displayStories.findIndex(
                    (s) => keyFor(s) === keyFor(activeStory)
                  )}
                  stepCount={
                    useYjs
                      ? activeStory._yStepCount ?? 0
                      : storyStepCounts[activeStory.id] ?? 0
                  }
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

      {/* Centralised delete confirmation (Yjs mode) */}
      <DeleteConfirmationModal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        entityType="story"
        entityLabel={
          deleteTarget?.story.title ??
          deleteTarget?.story.story_id ??
          ""
        }
        contentSummary={deleteTarget?.contentSummary}
        contributors={deleteTarget?.contributors}
      />
    </div>
  );
}
